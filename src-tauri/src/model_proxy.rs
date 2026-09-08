//! 模型代理（按提供方域名分流）：桌面壳内的 loopback 路由代理。
//!
//! # 为什么需要它
//!
//! 宿主的模型请求由 `@deepseek-ai/dsh-http-proxy` 在启动时从环境变量解析出的
//! 一份「每进程一个答案」的策略统一路由（装成 undici 全局 dispatcher），
//! 没有按域名 / 按提供方的配置入口。所以「一条一条按提供方启用代理」只能在
//! 上游做分流：壳在 spawn `dsh web` 时把 `HTTP(S)_PROXY` 指向本模块的
//! loopback 代理，宿主的所有出站请求就都经过这里，再由本模块逐条决定去向：
//!
//! - 命中「启用代理」的域名 → 走设置页「安装代理」里配置的代理；
//! - 其余域名 → 走壳进程原本就有的代理环境变量（启动时捕获），没有则直连
//!   —— 保证用户既有代理行为完全不变；
//! - loopback 永远直连。
//!
//! 只做 CONNECT / HTTP 隧道（不解密 TLS），因此只看得到域名与流量去向，
//! 看不到请求内容 —— 这也正是「监听宿主内模型请求」能给出的全部信息。
//!
//! # 生效时机
//!
//! 环境变量只在 spawn 时注入一次，因此**开 / 关整个功能需要重启服务**；
//! 单条规则的开关是实时的（规则表在 Arc<RwLock> 里，代理线程每次连接都重读）。

use std::collections::VecDeque;
use std::fs;
use std::io::{self, Read, Write};
use std::net::{IpAddr, Ipv4Addr, Shutdown, SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// 请求日志上限（设置页只展示最近若干条，内存即可，不落盘）
pub const MAX_LOG_ENTRIES: usize = 200;
/// 握手阶段的读超时：慢客户端不能占住线程
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
/// 连接上游的超时
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// 请求头上限（正常 CONNECT 头不到 1KB；超限即视为非法）
const MAX_HEAD_BYTES: usize = 16 * 1024;

// ---------------------------------------------------------------------------
// 配置（持久化）
// ---------------------------------------------------------------------------

/// 一条提供方规则：域名 + 是否走代理
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelProxyRule {
    /// 提供方域名，如 `api.openai.com`；写 `example.com` 同时匹配其子域名
    pub host: String,
    /// 是否让该域名的流量走「安装代理」
    pub enabled: bool,
}

/// 模型代理配置（`<应用数据目录>/model_proxy.json`）
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelProxyConfig {
    #[serde(default)]
    pub rules: Vec<ModelProxyRule>,
}

impl ModelProxyConfig {
    /// 规范化：域名去空白 / 去端口 / 小写、去重（保留首个），空域名丢弃
    fn normalized(&self) -> Self {
        let mut seen: Vec<String> = Vec::new();
        let mut rules: Vec<ModelProxyRule> = Vec::new();
        for rule in &self.rules {
            let host = normalize_host(&rule.host);
            if host.is_empty() || seen.iter().any(|h| h == &host) {
                continue;
            }
            seen.push(host.clone());
            rules.push(ModelProxyRule {
                host,
                enabled: rule.enabled,
            });
        }
        Self { rules }
    }

    /// 是否存在至少一条启用规则
    fn has_enabled(&self) -> bool {
        self.rules.iter().any(|r| r.enabled)
    }
}

/// 规范化域名：小写、去首尾空白与尾点、去掉 `*.` / `.` 前缀、去掉单冒号端口
fn normalize_host(raw: &str) -> String {
    let host = raw.trim().trim_end_matches('.');
    let host = host.strip_prefix("*.").unwrap_or(host);
    let host = host.strip_prefix('.').unwrap_or(host);
    // 单冒号视为 host:port；IPv6 字面量（多冒号）保持原样
    let host = match host.find(':') {
        Some(idx) if host[idx + 1..].find(':').is_none() => &host[..idx],
        _ => host,
    };
    host.trim().trim_end_matches('.').to_ascii_lowercase()
}

/// 规则是否命中某域名：等于，或为其子域名（`example.com` 命中 `api.example.com`）
fn rule_matches(rule: &str, host: &str) -> bool {
    let rule = normalize_host(rule);
    if rule.is_empty() {
        return false;
    }
    let host = normalize_host(host);
    host == rule || host.ends_with(&format!(".{rule}"))
}

/// loopback / 未指定地址：代理对它没有意义，永远直连
fn is_loopback(host: &str) -> bool {
    let host = host.trim().trim_start_matches('[').trim_end_matches(']');
    if host.eq_ignore_ascii_case("localhost") || host.ends_with(".localhost") {
        return true;
    }
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(v4)) => v4.is_loopback() || v4.is_unspecified(),
        Ok(IpAddr::V6(v6)) => v6.is_loopback() || v6.is_unspecified(),
        Err(_) => false,
    }
}

// ---------------------------------------------------------------------------
// 对外状态
// ---------------------------------------------------------------------------

/// 一次被路由的请求（设置页「最近请求」的数据源）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelProxyRequest {
    /// Unix 毫秒
    pub ts: i64,
    pub host: String,
    pub port: u16,
    /// "proxy" = 走了代理；"direct" = 直连
    pub via: &'static str,
    /// 实际使用的上游（直连时为 None）
    pub upstream: Option<String>,
    /// 隧道是否建立成功
    pub ok: bool,
    /// 失败原因（成功为 None）
    pub error: Option<String>,
}

/// 模型代理运行时状态（前端设置页的数据源）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelProxyStatus {
    /// 代理线程是否在监听
    pub running: bool,
    /// 监听端口（未运行时为 None）
    pub port: Option<u16>,
    /// 当前运行的宿主进程是否已经注入了代理环境变量
    pub injected: bool,
    /// 规则命中时使用的上游（来自「安装代理」配置）
    pub upstream: Option<String>,
    /// 未命中规则的流量使用的上游（来自壳进程自身的代理环境变量）
    pub fallback: Option<String>,
    /// 规则表
    pub rules: Vec<ModelProxyRule>,
    /// 最近请求（新→旧）
    pub requests: Vec<ModelProxyRequest>,
    /// 未生效 / 不可用的原因，供设置页直接展示
    pub reason: Option<String>,
    /// 改动是否要重启服务才生效
    pub restart_required: bool,
}

/// 上游取值方案
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoutePlan {
    /// 命中启用规则时使用的上游
    pub upstream: String,
    /// 其余流量使用的上游（None = 直连）
    pub fallback: Option<String>,
}

/// 运行时句柄（放在 AppState 里）
pub struct ModelProxyRuntime {
    port: u16,
    stop: Arc<AtomicBool>,
    rules: Arc<RwLock<Vec<ModelProxyRule>>>,
    upstream: Arc<RwLock<Option<String>>>,
    fallback: Arc<RwLock<Option<String>>>,
    log: Arc<Mutex<VecDeque<ModelProxyRequest>>>,
}

impl ModelProxyRuntime {
    pub fn port(&self) -> u16 {
        self.port
    }

    /// 热更新规则与上游（不重启代理线程）。`upstream = None` 表示当前配置给不出
    /// 可用上游（改成直连 / SOCKS / 字段不完整），命中规则的流量随后落到兜底上游。
    fn update(&self, rules: Vec<ModelProxyRule>, upstream: Option<String>, fallback: Option<String>) {
        if let Ok(mut w) = self.rules.write() {
            *w = rules;
        }
        if let Ok(mut w) = self.upstream.write() {
            *w = upstream;
        }
        if let Ok(mut w) = self.fallback.write() {
            *w = fallback;
        }
    }

    /// 停掉代理线程（监听 socket 由线程退出时释放）
    fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
        // 连接一下自己，唤醒阻塞在 accept 上的线程
        let _ = TcpStream::connect_timeout(
            &SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), self.port),
            Duration::from_millis(300),
        );
    }

    /// 最近请求快照（新→旧）
    fn snapshot(&self) -> Vec<ModelProxyRequest> {
        self.log
            .lock()
            .map(|l| l.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// 清空请求日志
    fn clear_log(&self) {
        if let Ok(mut l) = self.log.lock() {
            l.clear();
        }
    }
}

// ---------------------------------------------------------------------------
// 配置读写
// ---------------------------------------------------------------------------

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录: {e}"))?;
    Ok(dir.join("model_proxy.json"))
}

/// 读取配置；文件缺失 / 损坏一律按「无规则」处理，绝不阻塞启动
pub fn load_config(app: &AppHandle) -> ModelProxyConfig {
    let Ok(path) = config_path(app) else {
        return ModelProxyConfig::default();
    };
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<ModelProxyConfig>(&text).ok())
        .unwrap_or_default()
        .normalized()
}

/// 保存配置（规范化后落盘）
pub fn save_config(app: &AppHandle, config: &ModelProxyConfig) -> Result<ModelProxyConfig, String> {
    let path = config_path(app)?;
    let normalized = config.normalized();
    let text =
        serde_json::to_string_pretty(&normalized).map_err(|e| format!("序列化模型代理配置失败: {e}"))?;
    fs::write(&path, text).map_err(|e| format!("保存模型代理配置失败: {e}"))?;
    Ok(normalized)
}

// ---------------------------------------------------------------------------
// 上游解析
// ---------------------------------------------------------------------------

/// 从壳进程环境捕获「原本就在用的」代理：命中规则之外的流量沿用它们。
///
/// 宿主在启动时会读同一批变量；壳把 `HTTP(S)_PROXY` 指向本代理后，若不为
/// 非命中域名保留原值，用户为 web 搜索 / MCP 配的代理就会被悄悄降级成直连。
///
/// 取值顺序与 `@deepseek-ai/dsh-http-proxy` 一致：先看进程环境，再看
/// `$DSH_HOME/.env`（宿主启动器就是这么兜底的）。
fn fallback_from_env() -> Option<String> {
    // 用户写 NO_PROXY=* 表示「全部直连」：非命中流量按直连处理，别偷偷塞回代理
    if inherited_no_proxy()
        .as_deref()
        .map(|list| list.trim() == "*")
        .unwrap_or(false)
    {
        return None;
    }
    for name in PROXY_ENV_NAMES {
        if let Ok(value) = std::env::var(name) {
            if let Some(url) = accept_http_proxy(&value) {
                return Some(url);
            }
        }
    }
    let text = dsh_home()
        .map(|home| home.join(".env"))
        .and_then(|path| fs::read_to_string(path).ok())?;
    proxy_from_env_text(&text)
}

/// 代理变量名，顺序即优先级（scheme 专属在前，ALL_PROXY 兜底）
const PROXY_ENV_NAMES: [&str; 6] = [
    "https_proxy",
    "HTTPS_PROXY",
    "http_proxy",
    "HTTP_PROXY",
    "all_proxy",
    "ALL_PROXY",
];

/// 只接受 http(s)：SOCKS 无法在这里承载，交给宿主自己按原样处理
fn accept_http_proxy(value: &str) -> Option<String> {
    let value = value.trim();
    let lower = value.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        Some(value.to_string())
    } else {
        None
    }
}

/// 从 `.env` 文本里取某个变量的值（KEY=VALUE，忽略注释与引号）
fn env_value(text: &str, name: &str) -> Option<String> {
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if !key.trim().eq_ignore_ascii_case(name) {
            continue;
        }
        let value = value.trim().trim_matches('"').trim_matches('\'');
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

/// 从 `.env` 文本里取第一个可用的代理值
fn proxy_from_env_text(text: &str) -> Option<String> {
    for name in PROXY_ENV_NAMES {
        if let Some(value) = env_value(text, name) {
            if let Some(url) = accept_http_proxy(&value) {
                return Some(url);
            }
        }
    }
    None
}

/// 用户自己写的 NO_PROXY 条目（进程环境优先，其次 `$DSH_HOME/.env`）
fn inherited_no_proxy() -> Option<String> {
    for name in ["no_proxy", "NO_PROXY"] {
        if let Ok(value) = std::env::var(name) {
            let value = value.trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    let text = dsh_home()
        .map(|home| home.join(".env"))
        .and_then(|path| fs::read_to_string(path).ok())?;
    env_value(&text, "no_proxy").or_else(|| env_value(&text, "NO_PROXY"))
}

/// 注入给宿主的 NO_PROXY：loopback 必加，用户自己的条目原样保留。
///
/// 直接写死 loopback 会丢掉用户为企业内网 / 本地 registry 写的放行条目 ——
/// 那些主机随后会落到本代理的兜底上游（用户原本的代理）而不是直连，
/// 等于替用户改了绕过规则。
pub fn no_proxy_env() -> String {
    merge_no_proxy(inherited_no_proxy().as_deref())
}

/// 合并逻辑（纯函数，便于测试）：loopback 在前，用户条目按原顺序追加、大小写不敏感去重。
///
/// 用户写的 `*` 被刻意丢掉：它表示「全部直连」，而本功能的前提正是让命中规则的域名
/// 走到本代理；直接照抄会让开关变成哑的。对应的语义由 {@link fallback_from_env}
/// 承接 —— 那时非命中流量按直连处理。
fn merge_no_proxy(user: Option<&str>) -> String {
    let mut entries: Vec<String> = vec![
        "localhost".into(),
        "127.0.0.1".into(),
        "::1".into(),
    ];
    if let Some(user) = user {
        for entry in user.split([',', ' ']).map(str::trim).filter(|e| !e.is_empty()) {
            if entry == "*" {
                continue;
            }
            if !entries.iter().any(|e| e.eq_ignore_ascii_case(entry)) {
                entries.push(entry.to_string());
            }
        }
    }
    entries.join(",")
}

/// 判断配置是否可用：`(上游 URL, 不可用原因)`
fn upstream_of(config: &crate::proxy_config::ProxyConfig) -> (Option<String>, Option<String>) {
    match config.kind.as_str() {
        "direct" => (None, Some("「安装代理」当前为直接连接，模型代理没有可用的代理地址".into())),
        "socks4" | "socks5" => (
            None,
            Some("模型代理暂不支持 SOCKS 上游，请在「安装代理」里改用 http / https 代理地址".into()),
        ),
        "http" | "https" => {
            let host = config.host.trim();
            match config.port {
                Some(port) if port > 0 && !host.is_empty() => {
                    (Some(format!("http://{host}:{port}")), None)
                }
                _ => (None, Some("「安装代理」缺少服务器地址或端口".into())),
            }
        }
        other => (None, Some(format!("未知的代理类型：{other}"))),
    }
}

/// 计算当前应有的路由方案：`Ok(None)` = 不必启用（返回原因）
fn plan_for(app: &AppHandle) -> (Option<RoutePlan>, Option<String>) {
    let config = load_config(app);
    if !config.has_enabled() {
        return (None, Some("尚未启用任何提供方".into()));
    }
    let (upstream, reason) = upstream_of(&crate::proxy_config::get_proxy_config(app.clone()));
    let Some(upstream) = upstream else {
        return (None, reason);
    };
    (
        Some(RoutePlan {
            upstream,
            fallback: fallback_from_env(),
        }),
        None,
    )
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

/// 确保代理线程按当前配置运行：
///
/// - 需要启用且尚未运行 → 启动并返回监听端口；
/// - 已运行 → 热更新规则 / 上游，返回既有端口；
/// - 不需要启用 → 返回 None（调用方据此不注入环境变量）。
pub fn ensure_running(
    app: &AppHandle,
    state: &crate::dsh::AppState,
) -> Result<Option<(u16, RoutePlan)>, String> {
    let (plan, reason) = plan_for(app);
    let mut guard = state
        .model_proxy
        .lock()
        .map_err(|_| "模型代理状态锁已损坏".to_string())?;
    let Some(plan) = plan else {
        if let Some(runtime) = guard.take() {
            runtime.stop();
        }
        if let Some(reason) = reason {
            crate::dsh::emit_log(app, crate::dsh::WEB_LOG_EVENT, "system", &format!("模型代理未启用：{reason}"));
        }
        return Ok(None);
    };
    let rules = load_config(app).rules;
    if let Some(runtime) = guard.as_ref() {
        runtime.update(
            rules,
            Some(plan.upstream.clone()),
            plan.fallback.clone(),
        );
        return Ok(Some((runtime.port(), plan)));
    }
    let runtime = start(rules, plan.clone())?;
    let port = runtime.port();
    *guard = Some(runtime);
    Ok(Some((port, plan)))
}

/// 停止代理线程（服务停止 / 应用退出时调用）
pub fn stop(app: &AppHandle, state: &crate::dsh::AppState) {
    let Ok(mut guard) = state.model_proxy.lock() else {
        return;
    };
    if let Some(runtime) = guard.take() {
        runtime.stop();
        state.model_proxy_injected.store(false, Ordering::SeqCst);
        crate::dsh::emit_log(
            app,
            crate::dsh::WEB_LOG_EVENT,
            "system",
            &format!("模型代理已停止（端口 {}）", runtime.port()),
        );
    }
}

/// 应用退出路径使用：没有 AppHandle 可发日志，只回收线程
pub fn stop_quiet(state: &crate::dsh::AppState) {
    let Ok(mut guard) = state.model_proxy.lock() else {
        return;
    };
    if let Some(runtime) = guard.take() {
        runtime.stop();
    }
    state.model_proxy_injected.store(false, Ordering::SeqCst);
}

/// 启动监听线程，返回运行时句柄
fn start(rules: Vec<ModelProxyRule>, plan: RoutePlan) -> Result<ModelProxyRuntime, String> {
    let listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .map_err(|e| format!("模型代理无法监听 loopback 端口: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("模型代理无法读取监听端口: {e}"))?
        .port();
    let stop = Arc::new(AtomicBool::new(false));
    let shared = Shared {
        rules: Arc::new(RwLock::new(rules)),
        upstream: Arc::new(RwLock::new(Some(plan.upstream.clone()))),
        fallback: Arc::new(RwLock::new(plan.fallback.clone())),
        log: Arc::new(Mutex::new(VecDeque::new())),
    };
    let accept_shared = shared.clone();
    let accept_stop = stop.clone();
    thread::Builder::new()
        .name("model-proxy-accept".into())
        .spawn(move || {
            for incoming in listener.incoming() {
                if accept_stop.load(Ordering::SeqCst) {
                    break;
                }
                match incoming {
                    Ok(stream) => {
                        let conn_shared = accept_shared.clone();
                        // 每条连接一个线程：模型请求是长连接流式响应，
                        // 桌面端并发量很小（几个会话），线程模型足够且无额外依赖。
                        let _ = thread::Builder::new()
                            .name("model-proxy-conn".into())
                            .spawn(move || handle_conn(stream, &conn_shared));
                    }
                    Err(_) => break,
                }
            }
        })
        .map_err(|e| format!("模型代理线程启动失败: {e}"))?;
    Ok(ModelProxyRuntime {
        port,
        stop,
        rules: shared.rules,
        upstream: shared.upstream,
        fallback: shared.fallback,
        log: shared.log,
    })
}

// ---------------------------------------------------------------------------
// 连接处理
// ---------------------------------------------------------------------------

/// 代理线程与运行时句柄共享的可变部分
#[derive(Clone)]
struct Shared {
    rules: Arc<RwLock<Vec<ModelProxyRule>>>,
    upstream: Arc<RwLock<Option<String>>>,
    fallback: Arc<RwLock<Option<String>>>,
    log: Arc<Mutex<VecDeque<ModelProxyRequest>>>,
}

impl Shared {
    fn upstream(&self) -> Option<String> {
        self.upstream.read().ok().and_then(|u| u.clone())
    }

    fn fallback(&self) -> Option<String> {
        self.fallback.read().ok().and_then(|u| u.clone())
    }

    /// 某域名是否命中「启用代理」的规则
    fn matched(&self, host: &str) -> bool {
        self.rules
            .read()
            .map(|rules| rules.iter().any(|r| r.enabled && rule_matches(&r.host, host)))
            .unwrap_or(false)
    }

    fn record(&self, entry: ModelProxyRequest) {
        if let Ok(mut log) = self.log.lock() {
            log.push_front(entry);
            while log.len() > MAX_LOG_ENTRIES {
                log.pop_back();
            }
        }
    }
}

/// 一次连接的最终去向
#[derive(Debug, PartialEq, Eq)]
enum Route {
    /// 经上游代理
    Proxy(String),
    /// 直连
    Direct,
}

/// 建隧道的结果：成功时把已连上的服务端流与待回写的握手响应交出来
/// （记录日志后才开始双向透传）
enum Opened {
    Ready {
        server: TcpStream,
        /// 上游代理返回的响应头（直连为 None，由客户端侧合成 200）
        handshake: Option<String>,
    },
    Failed(String),
}

/// 逐条判定去向：命中规则 → 规则上游；否则 → 壳环境里的代理；都没有 → 直连
fn route_for(shared: &Shared, host: &str) -> Route {
    if is_loopback(host) {
        return Route::Direct;
    }
    if shared.matched(host) {
        if let Some(upstream) = shared.upstream() {
            return Route::Proxy(upstream);
        }
    }
    match shared.fallback() {
        Some(fallback) => Route::Proxy(fallback),
        None => Route::Direct,
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn handle_conn(mut client: TcpStream, shared: &Shared) {
    let _ = client.set_read_timeout(Some(HANDSHAKE_TIMEOUT));
    let head = match read_head(&mut client) {
        Ok(head) => head,
        Err(_) => return,
    };
    let Some((method, target)) = parse_request_line(&head) else {
        let _ = client.write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n");
        return;
    };
    let Some((host, port)) = target_host_port(&method, &target) else {
        let _ = client.write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n");
        return;
    };
    let route = route_for(shared, &host);
    let (via, upstream) = match &route {
        Route::Proxy(url) => ("proxy", Some(url.clone())),
        Route::Direct => ("direct", None),
    };
    let opened = match &route {
        Route::Proxy(url) => open_via_proxy(url, &host, port, &method, &head),
        Route::Direct => open_direct(&host, port, &method, &head),
    };
    match opened {
        Opened::Ready { server, handshake } => {
            // 先把握手结果交给客户端：CONNECT 隧道建立前客户端在等这一行
            if let Err(error) = relay_handshake(&mut client, &method, handshake.as_deref()) {
                shared.record(ModelProxyRequest {
                    ts: now_ms(),
                    host,
                    port,
                    via,
                    upstream,
                    ok: false,
                    error: Some(error),
                });
                return;
            }
            // 再记日志：模型响应是长连接流式，若等隧道结束才记录，
            // 设置页的「最近请求」在整个会话期间都是空的。
            shared.record(ModelProxyRequest {
                ts: now_ms(),
                host,
                port,
                via,
                upstream,
                ok: true,
                error: None,
            });
            // 隧道已建立：清掉握手超时，长连接流式响应可以一直挂着
            let _ = client.set_read_timeout(None);
            let _ = client.set_write_timeout(None);
            tunnel(&client, server);
        }
        Opened::Failed(error) => {
            shared.record(ModelProxyRequest {
                ts: now_ms(),
                host,
                port,
                via,
                upstream,
                ok: false,
                error: Some(error),
            });
        }
    }
}

/// 读取请求头（到空行为止），超限或对端关闭即失败
fn read_head(client: &mut TcpStream) -> io::Result<String> {
    let mut buf: Vec<u8> = Vec::with_capacity(1024);
    let mut byte = [0u8; 1];
    while buf.len() < MAX_HEAD_BYTES {
        let n = client.read(&mut byte)?;
        if n == 0 {
            break;
        }
        buf.push(byte[0]);
        if buf.ends_with(b"\r\n\r\n") {
            break;
        }
    }
    if buf.is_empty() {
        return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "空请求"));
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// 解析请求行，返回 (方法, 目标)
fn parse_request_line(head: &str) -> Option<(String, String)> {
    let line = head.lines().next()?.trim_end_matches('\r');
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_ascii_uppercase();
    let target = parts.next()?.to_string();
    if method.is_empty() || target.is_empty() {
        return None;
    }
    Some((method, target))
}

/// 从请求行推出目标 (host, port)
fn target_host_port(method: &str, target: &str) -> Option<(String, u16)> {
    if method == "CONNECT" {
        let (host, port) = split_host_port(target, 443)?;
        return Some((host, port));
    }
    // 代理形式的绝对 URI：GET http://host:port/path HTTP/1.1
    let rest = target
        .strip_prefix("http://")
        .or_else(|| target.strip_prefix("https://"))?;
    let authority = rest.split(['/', '?', '#']).next()?;
    let (host, port) = split_host_port(authority, if target.starts_with("https://") { 443 } else { 80 })?;
    Some((host, port))
}

/// 拆 `host:port`，兼容 `[::1]:443` 与缺省端口
fn split_host_port(authority: &str, default_port: u16) -> Option<(String, u16)> {
    let authority = authority.trim();
    if authority.is_empty() {
        return None;
    }
    if let Some(rest) = authority.strip_prefix('[') {
        let (host, tail) = rest.split_once(']')?;
        let port = tail
            .strip_prefix(':')
            .and_then(|p| p.parse::<u16>().ok())
            .unwrap_or(default_port);
        return Some((host.to_string(), port));
    }
    match authority.rsplit_once(':') {
        Some((host, port)) if !host.is_empty() && !port.contains(':') => match port.parse::<u16>() {
            Ok(port) => Some((host.to_string(), port)),
            Err(_) => None,
        },
        _ => Some((authority.to_string(), default_port)),
    }
}

/// 经上游代理建隧道：向上游发同样的 CONNECT / 请求行，透传响应。
/// 返回已连上的上游连接；双向透传由调用方在记完日志后发起。
fn open_via_proxy(
    upstream: &str,
    host: &str,
    port: u16,
    method: &str,
    head: &str,
) -> Opened {
    let (proxy_host, proxy_port) = match upstream_host_port(upstream) {
        Ok(pair) => pair,
        Err(e) => return Opened::Failed(e),
    };
    let addr = match to_socket_addr(&proxy_host, proxy_port) {
        Ok(addr) => addr,
        Err(e) => return Opened::Failed(e),
    };
    let mut server = match TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT) {
        Ok(server) => server,
        Err(e) => {
            return Opened::Failed(format!(
                "连接上游代理 {proxy_host}:{proxy_port} 失败: {e}"
            ))
        }
    };
    let request = if method == "CONNECT" {
        format!("CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n\r\n")
    } else {
        head.to_string()
    };
    if let Err(e) = server.write_all(request.as_bytes()) {
        return Opened::Failed(format!("向上游代理写请求失败: {e}"));
    }
    let _ = server.set_read_timeout(Some(CONNECT_TIMEOUT));
    let response = match read_head(&mut server) {
        Ok(response) => response,
        Err(e) => return Opened::Failed(format!("读取上游代理响应失败: {e}")),
    };
    let _ = server.set_read_timeout(None);
    Opened::Ready {
        server,
        handshake: Some(response),
    }
}

/// 直连目标并建隧道：CONNECT 回 200，其余请求把已读走的头转给目标
fn open_direct(host: &str, port: u16, method: &str, head: &str) -> Opened {
    let addr = match to_socket_addr(host, port) {
        Ok(addr) => addr,
        Err(e) => return Opened::Failed(e),
    };
    let mut server = match TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT) {
        Ok(server) => server,
        Err(e) => return Opened::Failed(format!("直连 {host}:{port} 失败: {e}")),
    };
    if method != "CONNECT" {
        if let Err(e) = server.write_all(head.as_bytes()) {
            return Opened::Failed(format!("转发请求失败: {e}"));
        }
    }
    Opened::Ready {
        server,
        handshake: None,
    }
}

/// 把上游代理的响应（状态行 + 头）与直连的 200 回写给客户端。
///
/// CONNECT 隧道建立前必须先把握手结果交给客户端，因此这一步在 `Opened` 之后、
/// 双向透传之前单独执行 —— 它需要客户端写句柄，而 `open_*` 只碰服务端。
fn relay_handshake(
    client: &mut TcpStream,
    method: &str,
    response: Option<&str>,
) -> Result<(), String> {
    match response {
        Some(response) => {
            let status = response.lines().next().unwrap_or_default().to_string();
            client
                .write_all(response.as_bytes())
                .map_err(|e| format!("回写上游响应失败: {e}"))?;
            if !status.contains(" 200") {
                return Err(format!("上游代理拒绝（{status}）"));
            }
        }
        None => {
            if method == "CONNECT" {
                client
                    .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                    .map_err(|e| format!("回写 200 失败: {e}"))?;
            }
        }
    }
    Ok(())
}

/// 双向透传直到任一端关闭
fn tunnel(client: &TcpStream, mut server: TcpStream) {
    let (Ok(mut client_reader), Ok(mut client_writer), Ok(mut server_writer)) =
        (client.try_clone(), client.try_clone(), server.try_clone())
    else {
        return;
    };
    let up = thread::Builder::new()
        .name("model-proxy-up".into())
        .spawn(move || {
            let _ = io::copy(&mut client_reader, &mut server_writer);
            let _ = server_writer.shutdown(Shutdown::Write);
        });
    let _ = io::copy(&mut server, &mut client_writer);
    let _ = client_writer.shutdown(Shutdown::Write);
    if let Ok(handle) = up {
        let _ = handle.join();
    }
}

/// 解析上游代理 URL 的 host / port
fn upstream_host_port(url: &str) -> Result<(String, u16), String> {
    let rest = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))
        .ok_or_else(|| format!("不支持的上游代理地址：{url}"))?;
    // 去掉可能存在的 user:password@
    let authority = rest.split(['/', '?']).next().unwrap_or("");
    let authority = match authority.rsplit_once('@') {
        Some((_, host)) => host,
        None => authority,
    };
    split_host_port(authority, 80).ok_or_else(|| format!("无法解析上游代理地址：{url}"))
}

/// 域名 + 端口 → SocketAddr（走系统 DNS）
fn to_socket_addr(host: &str, port: u16) -> Result<SocketAddr, String> {
    use std::net::ToSocketAddrs;
    (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("解析 {host} 失败: {e}"))?
        .next()
        .ok_or_else(|| format!("{host} 无可用地址"))
}

// ---------------------------------------------------------------------------
// Tauri 命令
// ---------------------------------------------------------------------------

/// 读取模型代理配置与状态（设置页首屏）
#[tauri::command]
pub fn get_model_proxy_status(
    app: AppHandle,
    state: tauri::State<'_, crate::dsh::AppState>,
) -> Result<ModelProxyStatus, String> {
    Ok(status_of(&app, &state))
}

/// 上游（「安装代理」配置）变化后热更新运行中的路由代理。
///
/// 代理地址是运行时读取的，因此改「安装代理」不需要重启服务；规则表不变、
/// 只换上游。设置页保存安装代理后由 `proxy_config::set_proxy_config` 调用。
pub fn reload_upstream(app: &AppHandle) {
    let Some(state) = app.try_state::<crate::dsh::AppState>() else {
        return;
    };
    let Ok(guard) = state.model_proxy.lock() else {
        return;
    };
    let Some(runtime) = guard.as_ref() else {
        return;
    };
    let (upstream, _) = upstream_of(&crate::proxy_config::get_proxy_config(app.clone()));
    runtime.update(load_config(app).rules, upstream, fallback_from_env());
}

/// 保存模型代理配置。规则即时生效；启用 / 停用需要重启服务（返回 restartRequired）
#[tauri::command]
pub fn set_model_proxy_config(
    app: AppHandle,
    state: tauri::State<'_, crate::dsh::AppState>,
    config: ModelProxyConfig,
) -> Result<ModelProxyStatus, String> {
    let saved = save_config(&app, &config)?;
    // 代理已在运行时热更新规则，无需等服务重启
    if let Ok(guard) = state.model_proxy.lock() {
        if let Some(runtime) = guard.as_ref() {
            let (upstream, _) = upstream_of(&crate::proxy_config::get_proxy_config(app.clone()));
            runtime.update(saved.rules.clone(), upstream, fallback_from_env());
        }
    }
    Ok(status_of(&app, &state))
}

/// 清空「最近请求」日志
#[tauri::command]
pub fn clear_model_proxy_log(state: tauri::State<'_, crate::dsh::AppState>) -> Result<(), String> {
    if let Ok(guard) = state.model_proxy.lock() {
        if let Some(runtime) = guard.as_ref() {
            runtime.clear_log();
        }
    }
    Ok(())
}

/// 一个被发现 / 已观测到的提供方域名
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredHost {
    pub host: String,
    /// "settings"（来自 $DSH_HOME/settings.yaml 的提供方配置）| "observed"（代理实际见过）
    pub source: &'static str,
    /// 提供方路由名（settings 来源时）
    pub provider: Option<String>,
    /// 最近一次请求时间（observed 来源时）
    pub last_seen: Option<i64>,
    /// 命中次数（observed 来源时）
    pub hits: u32,
}

/// 发现提供方域名：settings.yaml 里已配置的 + 路由代理实际见过的
#[tauri::command]
pub fn discover_model_proxy_hosts(
    state: tauri::State<'_, crate::dsh::AppState>,
) -> Result<Vec<DiscoveredHost>, String> {
    let mut out: Vec<DiscoveredHost> = Vec::new();
    for (provider, host) in hosts_from_settings() {
        if out.iter().any(|h| h.host == host) {
            continue;
        }
        out.push(DiscoveredHost {
            host,
            source: "settings",
            provider,
            last_seen: None,
            hits: 0,
        });
    }
    // 实测来源：按出现顺序（新→旧）累计
    if let Ok(guard) = state.model_proxy.lock() {
        if let Some(runtime) = guard.as_ref() {
            for entry in runtime.snapshot() {
                if let Some(existing) = out.iter_mut().find(|h| h.host == entry.host) {
                    existing.hits += 1;
                    if existing.last_seen.is_none() {
                        existing.last_seen = Some(entry.ts);
                    }
                    continue;
                }
                out.push(DiscoveredHost {
                    host: entry.host.clone(),
                    source: "observed",
                    provider: None,
                    last_seen: Some(entry.ts),
                    hits: 1,
                });
            }
        }
    }
    Ok(out)
}

/// `$DSH_HOME`（缺省 `~/.dsh`）
fn dsh_home() -> Option<PathBuf> {
    if let Ok(h) = std::env::var("DSH_HOME") {
        let h = h.trim();
        if !h.is_empty() {
            return Some(PathBuf::from(h));
        }
    }
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    Some(PathBuf::from(home).join(".dsh"))
}

/// 从 URL 取主机名（去 scheme / user:pass / 端口 / 路径，小写）
fn url_host(url: &str) -> Option<String> {
    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let authority = rest.split(['/', '?', '#']).next()?;
    let authority = authority.rsplit_once('@').map(|(_, h)| h).unwrap_or(authority);
    let host = normalize_host(authority);
    if host.is_empty() {
        None
    } else {
        Some(host)
    }
}

/// 读取 `$DSH_HOME/settings.yaml` 里配置的提供方端点：`(路由名, 域名)`
///
/// 只认两处：`llm-pi-ai.providers.<route>.baseURL` 与 `llm-deepseek.baseURL`
/// （后者缺省 `https://api.deepseek.com`，与 dsh-llm-deepseek 的默认一致）。
fn hosts_from_settings() -> Vec<(Option<String>, String)> {
    let Some(path) = dsh_home().map(|h| h.join("settings.yaml")) else {
        return Vec::new();
    };
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(doc) = serde_yaml::from_str::<serde_yaml::Value>(&text) else {
        return Vec::new();
    };
    let mut out: Vec<(Option<String>, String)> = Vec::new();
    if let Some(providers) = doc
        .get("llm-pi-ai")
        .and_then(|v| v.get("providers"))
        .and_then(|v| v.as_mapping())
    {
        for (key, value) in providers {
            let route = key.as_str().map(str::to_string);
            if let Some(base) = value.get("baseURL").and_then(|v| v.as_str()) {
                if let Some(host) = url_host(base) {
                    out.push((route, host));
                }
            }
        }
    }
    if let Some(deepseek) = doc.get("llm-deepseek") {
        let base = deepseek
            .get("baseURL")
            .and_then(|v| v.as_str())
            .unwrap_or("https://api.deepseek.com");
        if let Some(host) = url_host(base) {
            out.push((Some("deepseek-official".into()), host));
        }
    }
    out
}

/// 组装状态：配置 + 运行态 + 未生效原因
fn status_of(app: &AppHandle, state: &crate::dsh::AppState) -> ModelProxyStatus {
    let config = load_config(app);
    let (upstream, reason) = upstream_of(&crate::proxy_config::get_proxy_config(app.clone()));
    let guard = state.model_proxy.lock().ok();
    let runtime = guard.as_ref().and_then(|g| g.as_ref());
    let injected = state.model_proxy_injected.load(Ordering::SeqCst);
    let running = runtime.is_some();
    let service_running = state
        .child_pid
        .lock()
        .map(|pid| pid.is_some())
        .unwrap_or(false);
    let plan_reason = if config.has_enabled() {
        reason
    } else {
        Some("尚未启用任何提供方".into())
    };
    // 环境变量只在 spawn 时注入一次，所以「启用状态」与「已注入状态」不一致
    // 且服务正在跑时，必须提示重启才生效
    let restart_required = service_running && config.has_enabled() != injected;
    let status_reason = if !running {
        plan_reason
    } else if restart_required {
        Some("已保存，重启服务后生效".into())
    } else {
        None
    };
    ModelProxyStatus {
        running,
        port: runtime.map(|r| r.port()),
        injected,
        upstream,
        fallback: fallback_from_env(),
        rules: config.rules,
        requests: runtime.map(|r| r.snapshot()).unwrap_or_default(),
        reason: status_reason,
        restart_required,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn normalizes_and_dedupes_hosts() {
        let config = ModelProxyConfig {
            rules: vec![
                ModelProxyRule {
                    host: "  API.OpenAI.com.  ".into(),
                    enabled: true,
                },
                ModelProxyRule {
                    host: "*.api.deepseek.com".into(),
                    enabled: false,
                },
                ModelProxyRule {
                    host: "api.openai.com:443".into(),
                    enabled: false,
                },
                ModelProxyRule {
                    host: "   ".into(),
                    enabled: true,
                },
            ],
        }
        .normalized();
        assert_eq!(
            config.rules,
            vec![
                ModelProxyRule {
                    host: "api.openai.com".into(),
                    enabled: true
                },
                ModelProxyRule {
                    host: "api.deepseek.com".into(),
                    enabled: false
                },
            ]
        );
    }

    #[test]
    fn matches_exact_and_subdomains() {
        assert!(rule_matches("example.com", "example.com"));
        assert!(rule_matches("example.com", "api.example.com"));
        assert!(rule_matches(".example.com", "a.b.example.com"));
        assert!(!rule_matches("example.com", "notexample.com"));
        assert!(!rule_matches("", "example.com"));
    }

    #[test]
    fn detects_loopback() {
        assert!(is_loopback("localhost"));
        assert!(is_loopback("127.0.0.1"));
        assert!(is_loopback("127.5.5.5"));
        assert!(is_loopback("[::1]"));
        assert!(!is_loopback("api.openai.com"));
    }

    #[test]
    fn parses_request_lines() {
        assert_eq!(
            parse_request_line("CONNECT api.openai.com:443 HTTP/1.1\r\nHost: x\r\n\r\n"),
            Some(("CONNECT".into(), "api.openai.com:443".into()))
        );
        assert_eq!(
            parse_request_line("GET http://api.deepseek.com/v1/models HTTP/1.1\r\n\r\n"),
            Some(("GET".into(), "http://api.deepseek.com/v1/models".into()))
        );
        assert_eq!(parse_request_line(""), None);
    }

    #[test]
    fn derives_target_host_port() {
        assert_eq!(
            target_host_port("CONNECT", "api.openai.com:443"),
            Some(("api.openai.com".into(), 443))
        );
        assert_eq!(
            target_host_port("CONNECT", "[::1]:8443"),
            Some(("::1".into(), 8443))
        );
        assert_eq!(
            target_host_port("GET", "http://api.deepseek.com/v1/models"),
            Some(("api.deepseek.com".into(), 80))
        );
        assert_eq!(
            target_host_port("GET", "https://api.deepseek.com"),
            Some(("api.deepseek.com".into(), 443))
        );
    }

    #[test]
    fn routes_by_rule_then_fallback() {
        let shared = Shared {
            rules: Arc::new(RwLock::new(vec![ModelProxyRule {
                host: "api.openai.com".into(),
                enabled: true,
            }])),
            upstream: Arc::new(RwLock::new(Some("http://127.0.0.1:7890".into()))),
            fallback: Arc::new(RwLock::new(Some("http://127.0.0.1:1080".into()))),
            log: Arc::new(Mutex::new(VecDeque::new())),
        };
        assert_eq!(
            route_for(&shared, "api.openai.com"),
            Route::Proxy("http://127.0.0.1:7890".into())
        );
        // 未命中规则 → 沿用壳进程原有的代理
        assert_eq!(
            route_for(&shared, "example.com"),
            Route::Proxy("http://127.0.0.1:1080".into())
        );
        // loopback 永远直连
        assert_eq!(route_for(&shared, "127.0.0.1"), Route::Direct);

        // 没有 fallback 时未命中的域名直连
        let no_fallback = Shared {
            fallback: Arc::new(RwLock::new(None)),
            ..shared
        };
        assert_eq!(route_for(&no_fallback, "example.com"), Route::Direct);
    }

    #[test]
    fn parses_upstream_urls() {
        assert_eq!(
            upstream_host_port("http://127.0.0.1:7890"),
            Ok(("127.0.0.1".into(), 7890))
        );
        assert_eq!(
            upstream_host_port("http://user:pass@proxy.local:8080"),
            Ok(("proxy.local".into(), 8080))
        );
        assert!(upstream_host_port("socks5://127.0.0.1:1080").is_err());
    }

    #[test]
    fn extracts_host_from_endpoints() {        assert_eq!(url_host("https://api.openai.com/v1"), Some("api.openai.com".into()));
        assert_eq!(
            url_host("https://generativelanguage.googleapis.com"),
            Some("generativelanguage.googleapis.com".into())
        );
        assert_eq!(
            url_host("http://user:pass@proxy.local:8080/path"),
            Some("proxy.local".into())
        );
        assert_eq!(url_host(""), None);
    }

    #[test]
    fn reads_fallback_proxy_from_env_text() {
        let text = "# 注释\nOPENAI_API_KEY=sk-x\nHTTPS_PROXY=\"http://127.0.0.1:7890\"\nHTTP_PROXY=http://127.0.0.1:1080\n";
        assert_eq!(
            proxy_from_env_text(text),
            Some("http://127.0.0.1:7890".into())
        );
        // 只有 ALL_PROXY 时兜底可用；SOCKS 一律忽略
        assert_eq!(
            proxy_from_env_text("ALL_PROXY=http://p:1"),
            Some("http://p:1".into())
        );
        assert_eq!(proxy_from_env_text("HTTPS_PROXY=socks5://127.0.0.1:1080"), None);
        assert_eq!(proxy_from_env_text(""), None);
    }

    #[test]
    fn merges_user_no_proxy_entries() {
        // 无用户条目时只保留 loopback
        assert_eq!(merge_no_proxy(None), "localhost,127.0.0.1,::1");
        // 用户条目原样保留、loopback 去重（大小写不敏感）
        assert_eq!(
            merge_no_proxy(Some("internal.corp, registry.local ,LOCALHOST")),
            "localhost,127.0.0.1,::1,internal.corp,registry.local"
        );
        // 用户写 *（全部直连）时丢掉该条目：否则开关会变成哑的
        assert_eq!(
            merge_no_proxy(Some("*, internal.corp")),
            "localhost,127.0.0.1,::1,internal.corp"
        );
    }

    /// 端到端：命中规则的域名经上游代理建隧道，并留下一条 proxy 记录
    #[test]
    fn tunnels_matching_host_through_upstream() {
        // 假上游代理：接受 CONNECT 后回 200，然后原样回显
        let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
        let upstream_port = upstream.local_addr().unwrap().port();
        let (tx, rx) = mpsc::channel::<String>();
        thread::spawn(move || {
            let (mut sock, _) = upstream.accept().unwrap();
            let head = read_head(&mut sock).unwrap();
            tx.send(head).unwrap();
            sock.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                .unwrap();
            let mut buf = [0u8; 4];
            sock.read_exact(&mut buf).unwrap();
            sock.write_all(&buf).unwrap();
        });

        let runtime = start(
            vec![ModelProxyRule {
                host: "api.openai.com".into(),
                enabled: true,
            }],
            RoutePlan {
                upstream: format!("http://127.0.0.1:{upstream_port}"),
                fallback: None,
            },
        )
        .unwrap();

        let mut client = TcpStream::connect(("127.0.0.1", runtime.port())).unwrap();
        client
            .write_all(b"CONNECT api.openai.com:443 HTTP/1.1\r\nHost: api.openai.com:443\r\n\r\n")
            .unwrap();
        let response = read_head(&mut client).unwrap();
        assert!(response.contains("200"), "代理应回 200：{response}");
        client.write_all(b"ping").unwrap();
        let mut echo = [0u8; 4];
        client.read_exact(&mut echo).unwrap();
        assert_eq!(&echo, b"ping");

        let seen = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(seen.starts_with("CONNECT api.openai.com:443"));

        let entries = runtime.snapshot();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].host, "api.openai.com");
        assert_eq!(entries[0].via, "proxy");
        assert!(entries[0].ok);
        runtime.stop();
    }

    /// 端到端：未命中规则的域名直连目标
    #[test]
    fn connects_direct_when_no_rule_matches() {
        let origin = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin_port = origin.local_addr().unwrap().port();
        thread::spawn(move || {
            let (mut sock, _) = origin.accept().unwrap();
            let mut buf = [0u8; 4];
            sock.read_exact(&mut buf).unwrap();
            sock.write_all(&buf).unwrap();
        });

        // 规则命中别的域名，目标用 loopback → 永远直连（同时也是直连路径的回归）
        let runtime = start(
            vec![ModelProxyRule {
                host: "api.openai.com".into(),
                enabled: true,
            }],
            RoutePlan {
                upstream: "http://127.0.0.1:1".into(),
                fallback: None,
            },
        )
        .unwrap();
        let mut client = TcpStream::connect(("127.0.0.1", runtime.port())).unwrap();
        client
            .write_all(
                format!("CONNECT 127.0.0.1:{origin_port} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
                    .as_bytes(),
            )
            .unwrap();
        let response = read_head(&mut client).unwrap();
        assert!(response.contains("200"));
        client.write_all(b"pong").unwrap();
        let mut echo = [0u8; 4];
        client.read_exact(&mut echo).unwrap();
        assert_eq!(&echo, b"pong");
        assert_eq!(runtime.snapshot()[0].via, "direct");
        runtime.stop();
    }

    /// 端到端回归：真实 Node（宿主同款运行时）在 `HTTP(S)_PROXY` + `NODE_USE_ENV_PROXY`
    /// 下会经本代理发出 CONNECT，且命中规则的域名被路由到上游。
    ///
    /// 不需要联网：假上游接住 CONNECT 后回 200 就关，Node 的 TLS 握手随即失败，
    /// 我们只断言「请求确实到了代理且走了规则上游」。
    #[test]
    fn node_fetch_is_routed_by_rule_through_env_proxy() {
        let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
        let upstream_port = upstream.local_addr().unwrap().port();
        let (tx, rx) = mpsc::channel::<String>();
        thread::spawn(move || {
            let (mut sock, _) = upstream.accept().unwrap();
            let head = read_head(&mut sock).unwrap();
            tx.send(head).unwrap();
            let _ = sock.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n");
        });

        let runtime = start(
            vec![ModelProxyRule {
                host: "api.openai.com".into(),
                enabled: true,
            }],
            RoutePlan {
                upstream: format!("http://127.0.0.1:{upstream_port}"),
                fallback: None,
            },
        )
        .unwrap();
        let proxy = format!("http://127.0.0.1:{}", runtime.port());
        let status = std::process::Command::new("node")
            .args([
                "-e",
                "fetch('https://api.openai.com/v1/models').then(() => process.exit(0), () => process.exit(0))",
            ])
            .env("HTTP_PROXY", &proxy)
            .env("HTTPS_PROXY", &proxy)
            .env("NO_PROXY", "localhost,127.0.0.1,::1")
            .env("NODE_USE_ENV_PROXY", "1")
            .status();
        assert!(status.is_ok(), "需要 node 在 PATH 上才能跑本回归");
        let seen = rx
            .recv_timeout(Duration::from_secs(20))
            .expect("Node 未把请求发到路由代理");
        assert!(seen.starts_with("CONNECT api.openai.com:443"), "{seen}");
        let entries = runtime.snapshot();
        assert!(
            entries
                .iter()
                .any(|e| e.host == "api.openai.com" && e.via == "proxy" && e.ok),
            "{entries:?}"
        );
        runtime.stop();
    }
}
