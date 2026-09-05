//! dsh 会话事件 → 系统推送：订阅、过滤、渲染、去重。
//!
//! # 新版核心（带浏览器认证）下的接入方式（2026-01 实测）
//!
//! dsh web 更新后，旧的 `/api/events.mux` 纯推通道已移除，会话事件改为
//! Typert Remote 协议：
//! - 认证：GET `/?token=<launch token>` 会 303 并下发 `dsh-auth-*` 会话 Cookie
//!   （`SameSite=Strict`、HttpOnly），此后所有 `/api` HTTP/WS 都要带它；
//! - 会话列表：`POST /api/session/list`（RPC 信封 method=`session/list`，
//!   payload={args:{_request:{}}}），返回 items（sessionId / running /
//!   projections.values.title 等）；
//! - 事件流：WebSocket `/api/remote.mux`，先发 `{"type":"open",...}` 打开
//!   `session/follow`（payload={args:{request:{address:{kind:"session",
//!   sessionId}}}}}），服务端先回 **snapshot**（历史回放，不参与提醒），随后
//!   推送实时 **event** 帧（`{type:"item",streamId,value:{type:"event",event:{...}}}`
//!   / end / error）。
//!
//! 本模块是纯 Rust 订阅端（不依赖前端/WebView）：窗口关掉后应用驻留托盘也能
//! 收到提醒。投递通道收在 [`notify`](crate::notify)，这里不碰任何 UI/平台 API。
//!
//! # 2026-09-03 修复：WS 升级请求缺少必需握手头
//!
//! v0.1.20 适配 Cookie 认证时把连接改成了手建 `Request`（只有 uri + Cookie），
//! 而 tungstenite 对用户 `Request` 原样透传、不注入 `Sec-WebSocket-Key` 等
//! RFC 6455 必需头 → 握手恒定失败且被静默吞掉，推送自该版本起完全失效
//! （0.1.1-rc.2 时代传 URL 字符串由库补头，无此问题）。现改为
//! `build_ws_request`：URL 走 `IntoClientRequest` 生成全部必需头，再附加 Cookie。
//!
//! # 只提醒两类
//!
//! `todo/write`（任务清单更新）与 `turn/end`（一轮对话结束），其余事件过滤。

use crate::dsh;
use crate::notify;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io;
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tungstenite::client::IntoClientRequest;
use tungstenite::http::header::COOKIE;
use tungstenite::Message;

/// 需求文案里的两个标题
pub const TITLE_TODO: &str = "更新任务清单";
pub const TITLE_TURN_END: &str = "对话结束";
/// 标题还没生成（或压根没这个会话）时的兜底
const UNTITLED: &str = "未命名对话";

/// 消息种类，与前端 `src/lib/notify.ts` 的 `NotifyMessage["kind"]` 一致
const KIND_TODO: &str = "todo";
const KIND_TURN_END: &str = "turnEnd";

/// 新版核心的会话事件下行通道
const MUX_PATH: &str = "/api/remote.mux";
/// 会话列表 RPC 端点（HTTP）
const SESSION_LIST_RPC: &str = "/api/session/list";
/// 会话列表 RPC 方法名
const SESSION_LIST_METHOD: &str = "session/list";
/// 会话列表 RPC 参数名（实测 descriptor 要求 `_request`）
const SESSION_LIST_PARAM: &str = "_request";

/// 读循环节拍：每 500ms 醒一次，用于检查服务是否还在
const READ_TICK: Duration = Duration::from_millis(500);
/// 服务探活间隔（不必每拍都发 HTTP 请求，免得污染服务日志）
const ALIVE_INTERVAL: Duration = Duration::from_secs(10);
/// 断线后重连前的等待
const RECONNECT_DELAY: Duration = Duration::from_secs(2);
/// 会话发现重扫间隔：轮询 session.list，发现新起的会话就 open follow
const DISCOVER_INTERVAL: Duration = Duration::from_secs(15);
/// follow 一个会话时要求回放的最大消息条数（snapshot 只做回放基线，用于压住
/// 超大历史会话的连接成本；实时帧不受此限制）
const FOLLOW_MAX_MESSAGES: u64 = 256;
/// follow 的目标：running 中，或 15 分钟内仍在更新的会话
const FOLLOW_UPDATED_WINDOW_MS: i64 = 15 * 60 * 1000;

/// 一条推送的多通道负载：`emit` 给前端与系统通知共用同一份渲染结果，
/// 后续语音通道只需消费这个结构，不必重新解析事件。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NotifyMessage {
    /// "todo" | "turnEnd"
    pub kind: &'static str,
    pub session_id: String,
    /// 会话标题，未知为「未命名对话」
    pub session_title: String,
    /// 标题（"更新任务清单" / "对话结束"）
    pub title: &'static str,
    /// 描述：todo 为「N项已完成 · N项进行中 · N项待处理」，turnEnd 为会话名
    /// （「对话已结束」语义由 title 承担，不再重复拼接）
    pub desc: String,
    /// 需求的 `{标题}：{描述}`
    pub summary: String,
    /// toast 第二行（描述行）：todo = 会话标题 · HH:MM:SS（多会话并发时用于区分），
    /// turnEnd = HH:MM:SS（原「原因：…」已按需求移除）。时刻只进这一行：
    /// 标题行（summary）与语音字段（title/desc/summary）都不含，
    /// 语音通道不消费 body，时间因此不会被念出来。
    pub body: String,
    pub ts: i64,
}

/// 已渲染待投递的会话状态表（进程存活期内有效，无需落盘）
type Notes = HashMap<String, SessionNote>;

/// 单个会话的推送状态
#[derive(Default)]
struct SessionNote {
    /// 会话标题（来源：session.list 基线 / session/title 事件）
    title: Option<String>,
    /// 上次已推送的清单计数，用于「无净变化不重复推」
    last: Option<TodoCounts>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
struct TodoCounts {
    done: u32,
    active: u32,
    pending: u32,
}

// ---------------------------------------------------------------------------
// 后台线程：连接生命周期
// ---------------------------------------------------------------------------

/// 启动订阅线程。服务未就绪时线程挂起在探活循环里，因此无需与
/// `start_dsh_web` / `stop_dsh_web` 耦合，应用启动时调一次即可。
pub fn spawn(app: AppHandle) {
    let _ = std::thread::Builder::new()
        .name("dsh-session-events".to_string())
        .spawn(move || {
            let mut notes: Notes = HashMap::new();
            loop {
                wait_service_up(&app);
                run_once(&app, &mut notes);
                std::thread::sleep(RECONNECT_DELAY);
            }
        });
}

fn wait_service_up(app: &AppHandle) {
    loop {
        if Endpoint::of(app).alive() {
            return;
        }
        std::thread::sleep(Duration::from_secs(1));
    }
}

/// 建立一次连接并消费事件，直到断开或检测到服务停止。
/// 任何失败都只是返回，交给外层 supervisor 重来 —— 提醒是旁路能力，不打日志、不报错。
fn run_once(app: &AppHandle, notes: &mut Notes) {
    let ep = Endpoint::of(app);
    let Some(token) = ep.token() else {
        return; // 旧版宿主无 launch token：事件通道已随新版核心迁移，无从订阅
    };
    let Some(cookie) = fetch_session_cookie(&ep, &token) else {
        return;
    };
    let Some(tcp) = ep.connect_tcp() else {
        return;
    };
    let uri = ep.ws_url(MUX_PATH);
    let Some(req) = build_ws_request(&uri, &cookie) else {
        return;
    };
    let Ok((mut ws, _resp)) = tungstenite::client(req, tcp) else {
        return;
    };
    let _ = ws.get_mut().set_read_timeout(Some(READ_TICK));

    let mut live = Live::new();
    discover_and_follow(&ep, &cookie, notes, &mut live, &mut ws);
    let _ = ws.flush(); // 立刻刷出 discover 排队的 open 帧，不等服务端心跳触发隐式 flush

    let mut last_alive = Instant::now();
    let mut last_discover = Instant::now();
    loop {
        match ws.read() {
            Ok(Message::Text(text)) => {
                if let Some(msg) = extract_mux(text.as_str(), &mut live, notes) {
                    // 关掉开关时依然走完解析（维护标题与去重基线），只是不投递，
                    // 免得「关→开」瞬间把积压的历史事件一次性刷屏
                    if notify_enabled(app) {
                        notify::dispatch(app, &msg);
                    }
                }
            }
            // 服务端主动收尾：断开重连
            Ok(Message::Close(_)) => break,
            Ok(_) => {}
            Err(tungstenite::Error::Io(ref e))
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) =>
            {
                if last_alive.elapsed() >= ALIVE_INTERVAL {
                    last_alive = Instant::now();
                    if !ep.alive() {
                        break;
                    }
                }
                if last_discover.elapsed() >= DISCOVER_INTERVAL {
                    last_discover = Instant::now();
                    discover_and_follow(&ep, &cookie, notes, &mut live, &mut ws);
                }
            }
            Err(_) => break,
        }
    }
}

fn notify_enabled(app: &AppHandle) -> bool {
    app.state::<dsh::AppState>()
        .notify_enabled
        .load(Ordering::SeqCst)
}

/// 构造 `/api/remote.mux` 的 WS 升级请求：从 URL 生成（补齐 RFC 6455 必需的
/// `Sec-WebSocket-Key` / `Connection` / `Upgrade` / `Sec-WebSocket-Version` / `Host`），
/// 再附加认证 Cookie。
///
/// 为什么必须从 URL 生成而不是手建 Request：tungstenite 的
/// `IntoClientRequest for Request` 会【原样透传】用户请求，不注入任何必需头；
/// 直接 `Request::builder()` 出来的裸请求（只有 uri + Cookie）会在
/// `create_request` 处因缺少 `Sec-WebSocket-Key` 恒定握手失败
/// （`InvalidHeader("sec-websocket-key")`）——v0.1.20 为 dsh 0.1.2-alpha.4/5
/// 加 Cookie 认证时改成了手建 Request，推送功能自那时起完全失效，本函数即修复点。
fn build_ws_request(uri: &str, cookie: &str) -> Option<tungstenite::handshake::client::Request> {
    let mut req = uri.into_client_request().ok()?;
    let value = tungstenite::http::HeaderValue::from_str(cookie).ok()?;
    req.headers_mut().insert(COOKIE, value);
    Some(req)
}

// ---------------------------------------------------------------------------
// 服务端点
// ---------------------------------------------------------------------------

/// dsh web 服务的 host + port（+ 启动日志里的 launch token）。
/// pub(crate)：供 proxy.rs 复用同样的端点解析/认证交换逻辑。
pub(crate) struct Endpoint {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) token: Option<String>,
}

impl Endpoint {
    /// 读取当前探测到的服务端点；无探测结果时回退到“默认本地端口 + 无 token”。
    pub(crate) fn of(app: &AppHandle) -> Self {
        let detected = app
            .state::<dsh::AppState>()
            .detected_url
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        detected
            .as_deref()
            .and_then(Self::parse)
            .unwrap_or_else(|| Self {
                host: "127.0.0.1".to_string(),
                port: dsh::service_port(),
                token: None,
            })
    }

    /// 与 `of` 相同，但只有确实探测到 URL 时才返回 Some（无服务时不臆造默认端点）。
    pub(crate) fn detected(app: &AppHandle) -> Option<Self> {
        let detected = app
            .state::<dsh::AppState>()
            .detected_url
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        detected.as_deref().and_then(Self::parse)
    }

    /// 从 `http://host:port[/?token=...]` 取 host、port 与查询串里的 token。
    pub(crate) fn parse(url: &str) -> Option<Self> {
        let rest = url
            .strip_prefix("http://")
            .or_else(|| url.strip_prefix("https://"))?;
        let (authority, query) = match rest.split_once('/') {
            Some((a, after)) => {
                let q = after.split_once('?').map(|(_, q)| q);
                (a, q)
            }
            None => (rest, None),
        };
        let (host, port) = authority.rsplit_once(':')?;
        if host.is_empty() {
            return None;
        }
        let token = query.and_then(|q| {
            q.split('&')
                .find_map(|kv| kv.strip_prefix("token="))
                .map(|v| v.to_string())
        });
        Some(Self {
            host: host.to_ascii_lowercase(),
            port: port.parse().ok()?,
            token,
        })
    }

    pub(crate) fn token(&self) -> Option<String> {
        self.token.clone()
    }

    pub(crate) fn http_base(&self) -> String {
        format!("http://{}:{}", self.host, self.port)
    }

    pub(crate) fn ws_url(&self, path: &str) -> String {
        format!("ws://{}:{}{path}", self.host, self.port)
    }

    pub(crate) fn connect_tcp(&self) -> Option<TcpStream> {
        let addrs = (self.host.as_str(), self.port).to_socket_addrs().ok()?;
        addrs
            .filter_map(|a| TcpStream::connect_timeout(&a, Duration::from_secs(2)).ok())
            .next()
    }

    /// 服务是否在（复用 dsh 的纯 std 探活）
    fn alive(&self) -> bool {
        dsh::probe_url(&self.http_base(), 500)
    }
}

// ---------------------------------------------------------------------------
// 认证 Cookie：拿 launch token 换 dsh-auth-* 会话 Cookie
// ---------------------------------------------------------------------------

/// 对 `/?token=...` 发一次 GET（不跟随 303），从响应头取 `Set-Cookie` 的首段。
/// 该 Cookie 以 Host authority 绑定（实测 cookie 名为 `dsh-auth-<hash>`），
/// 同一 authority 的 `/api` HTTP 与 WS 升级都带上它即可通过认证。
/// pub(crate)：供 proxy.rs 做“认证终结”时复用。
pub(crate) fn fetch_session_cookie(ep: &Endpoint, token: &str) -> Option<String> {
    let mut stream = ep.connect_tcp()?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let req = format!(
        "GET /?token={token} HTTP/1.1\r\nHost: {}:{}\r\nConnection: close\r\nUser-Agent: deepseek-harness-desktop\r\n\r\n",
        ep.host, ep.port
    );
    use std::io::Write;
    let _ = stream.write_all(req.as_bytes());
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        use std::io::Read;
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if String::from_utf8_lossy(&buf).contains("\r\n\r\n") {
                    break;
                }
            }
        }
    }
    let head = String::from_utf8_lossy(&buf);
    for line in head.lines() {
        if line.to_ascii_lowercase().starts_with("set-cookie:") {
            let v = line["set-cookie:".len()..].trim();
            let first = v.split(';').next().unwrap_or(v).trim();
            if !first.is_empty() {
                return Some(first.to_string());
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// 会话发现 + follow 流管理（单个 mux 连接上按 streamId 多路复用）
// ---------------------------------------------------------------------------

/// 一次 mux 连接上的活跃状态。
#[derive(Default)]
struct Live {
    /// streamId → (sessionId, snapshot 基线是否已消费)
    streams: HashMap<String, (String, bool)>,
    seq: u64,
}

impl Live {
    fn new() -> Self {
        Self::default()
    }

    fn next_stream(&mut self) -> String {
        self.seq += 1;
        format!("dsh-s{}", self.seq)
    }

    fn is_following(&self, sid: &str) -> bool {
        self.streams.values().any(|(s, _)| s == sid)
    }
}

/// session.list 返回的会话行
struct SessionRow {
    id: String,
    title: Option<String>,
    running: bool,
    updated_at_ms: i64,
}

/// 轮询 session.list：灌标题基线，并对「可能正在产生事件」的会话 open follow。
fn discover_and_follow(
    ep: &Endpoint,
    cookie: &str,
    notes: &mut Notes,
    live: &mut Live,
    ws: &mut tungstenite::WebSocket<TcpStream>,
) {
    let Some(rows) = fetch_session_list(ep, cookie) else {
        return;
    };
    for row in &rows {
        merge_title(notes, &row.id, row.title.clone(), true);
    }
    let now_ms = notify::now_ms();
    for row in rows {
        let fresh = now_ms.saturating_sub(row.updated_at_ms) <= FOLLOW_UPDATED_WINDOW_MS;
        if !row.running && !fresh {
            continue;
        }
        if live.is_following(&row.id) {
            continue;
        }
        let stream = live.next_stream();
        let msg = follow_open(&stream, &row.id);
        if ws.send(Message::Text(msg.into())).is_ok() {
            live.streams.insert(stream, (row.id, false));
        }
    }
}

/// `POST /api/session/list`：返回（id, title, running, updatedAt）行。
fn fetch_session_list(ep: &Endpoint, cookie: &str) -> Option<Vec<SessionRow>> {
    let body = rpc_envelope(
        SESSION_LIST_METHOD,
        serde_json::json!({ SESSION_LIST_PARAM: {} }),
    )
    .to_string();
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(8))
        .user_agent("deepseek-harness-desktop")
        .build();
    let mut req = agent.post(&format!("{}{SESSION_LIST_RPC}", ep.http_base()));
    req = req
        .set("content-type", "application/json")
        .set("cookie", cookie);
    let Ok(resp) = req.send_string(&body) else {
        return None;
    };
    let Ok(text) = resp.into_string() else {
        return None;
    };
    let Ok(v) = serde_json::from_str::<Value>(&text) else {
        return None;
    };
    if v.pointer("/result/ok").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let Some(items) = v.pointer("/result/value/items").and_then(Value::as_array) else {
        return None;
    };
    let mut out = Vec::new();
    for item in items {
        let Some(id) = item.get("sessionId").and_then(Value::as_str) else {
            continue;
        };
        if item.get("blank").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let title = item
            .pointer("/projections/values/title")
            .and_then(Value::as_str)
            .and_then(non_empty)
            .map(str::to_string);
        out.push(SessionRow {
            id: id.to_string(),
            title,
            running: item
                .get("running")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            updated_at_ms: item.get("updatedAt").and_then(Value::as_i64).unwrap_or(0),
        });
    }
    Some(out)
}

/// dsh 的 RPC 信封（新版 payload 必须是 `{args: ...}` 单字段形态）
fn rpc_envelope(method: &str, args: Value) -> Value {
    serde_json::json!({
        "type": "client-request",
        "rpcId": rpc_id(),
        "method": method,
        "payload": { "args": args },
    })
}

/// open 一 session/follow 流的文本帧（实测：args 必须包 request，且不带
/// request 会返回 `gateway/arguments-invalid`）
fn follow_open(stream: &str, sid: &str) -> String {
    serde_json::json!({
        "type": "open",
        "streamId": stream,
        "endpoint": "session/follow",
        "payload": {
            "args": {
                "request": {
                    "address": { "kind": "session", "sessionId": sid },
                    "maxMessages": FOLLOW_MAX_MESSAGES
                }
            }
        }
    })
    .to_string()
}

/// rpcId 只用于服务端关联请求，本侧不等响应，「时间戳 + 递增序号」足够唯一
fn rpc_id() -> String {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    format!(
        "dsh-desktop-{}-{}",
        notify::now_ms(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    )
}

// ---------------------------------------------------------------------------
// 帧解析 + 白名单过滤 + 渲染（纯逻辑，可单测）
// ---------------------------------------------------------------------------

/// 解析一条 mux 下行文本帧，返回需要投递的消息。
///
/// 帧形态（实测）：
/// - `{"type":"item","streamId":...,"value":{...}}`，value 为 follow 帧：
///   - snapshot：历史回放基线 → 只把流标记为就绪，不参与提醒；
///   - event：实时事件（type=todo/write / turn/end 等）→ 渲染；
/// - `{"type":"end"|"error",...}`：服务端关闭该流 → 摘除 follow。
fn extract_mux(raw: &str, live: &mut Live, notes: &mut Notes) -> Option<NotifyMessage> {
    let frame: Value = serde_json::from_str(raw).ok()?;
    let msg_type = frame.get("type").and_then(Value::as_str)?;
    match msg_type {
        "item" => {
            let stream = frame.get("streamId").and_then(Value::as_str)?;
            let (sid, ready) = live.streams.get(stream)?.clone();
            let value = frame.get("value")?;
            match value.get("type").and_then(Value::as_str) {
                Some("snapshot") => {
                    if let Some(e) = live.streams.get_mut(stream) {
                        e.1 = true;
                    }
                    // 快照里也带 header.id / records；但那是连接前就发生的事，
                    // 不提醒（避免重连后把历史 turn/end 一次性刷屏）
                    None
                }
                Some("event") => {
                    let event = value.get("event")?;
                    if !ready {
                        return None; // 未消费快照前的事件理论不存在，双保险
                    }
                    handle_event(&sid, event, notes)
                }
                _ => None,
            }
        }
        "end" | "error" => {
            if let Some(stream) = frame.get("streamId").and_then(Value::as_str) {
                live.streams.remove(stream);
            }
            None
        }
        _ => None,
    }
}

/// 处理一条已确认归属会话的实时事件（sessionId 与 event 分离是实测协议形态）。
fn handle_event(sid: &str, event: &Value, notes: &mut Notes) -> Option<NotifyMessage> {
    // ignorable 事件（服务端标记的可忽略帧）不参与提醒
    if event.get("ignorable").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    match event.get("type").and_then(Value::as_str)? {
        "session/title" => {
            let title = event
                .pointer("/data/title")
                .and_then(Value::as_str)
                .and_then(non_empty);
            merge_title(notes, sid, title.map(str::to_string), false);
            None
        }
        "todo/write" => {
            // todo/write 是整表快照（last-write-wins），只需数三个状态
            let todos = event.pointer("/data/todos").and_then(Value::as_array)?;
            // 空清单不算「进展」，推一条 0/0/0 只是扰民
            if todos.is_empty() {
                return None;
            }
            let counts = count_todos(todos);
            let note = notes.entry(sid.to_string()).or_default();
            if note.last == Some(counts) {
                return None; // 去重：三个数字全等即视为无净变化
            }
            note.last = Some(counts);
            Some(todo_message(sid, note.title.as_deref(), counts))
        }
        "turn/end" => {
            let title = notes.get(sid).and_then(|n| n.title.as_deref());
            Some(turn_end_message(sid, title))
        }
        // assistant/chunk、tool/call、approval/* … 一律不推，这就是需求的「过滤」
        _ => None,
    }
}

/// 标题合并。`only_if_empty` 用于会话列表基线：晚到的基线不覆盖实时事件学到的标题。
fn merge_title(notes: &mut Notes, sid: &str, title: Option<String>, only_if_empty: bool) {
    let note = notes.entry(sid.to_string()).or_default();
    if only_if_empty && note.title.is_some() {
        return;
    }
    note.title = title;
}

/// 空白标题按「无标题」处理（供 `Option::and_then` 直接接在 `as_str` 后面）
fn non_empty(s: &str) -> Option<&str> {
    let t = s.trim();
    (!t.is_empty()).then_some(t)
}

/// 与 dsh 客户端一致：只认三种状态，未知状态并入待处理，保证三段之和等于清单长度
fn count_todos(todos: &[Value]) -> TodoCounts {
    let mut c = TodoCounts::default();
    for t in todos {
        match t.get("status").and_then(Value::as_str) {
            Some("completed") => c.done += 1,
            Some("in_progress") => c.active += 1,
            _ => c.pending += 1,
        }
    }
    c
}

/// `{num}项已完成 · {num}项进行中 · {num}项待处理`，零值段省略、以间隔号连接
fn todo_desc(done: u32, active: u32, pending: u32) -> String {
    let mut parts: Vec<String> = Vec::new();
    if done > 0 {
        parts.push(format!("{done}项已完成"));
    }
    if active > 0 {
        parts.push(format!("{active}项进行中"));
    }
    if pending > 0 {
        parts.push(format!("{pending}项待处理"));
    }
    parts.join(" · ")
}

fn todo_message(sid: &str, title: Option<&str>, c: TodoCounts) -> NotifyMessage {
    let desc = todo_desc(c.done, c.active, c.pending);
    NotifyMessage {
        kind: KIND_TODO,
        session_id: sid.to_string(),
        session_title: title.unwrap_or(UNTITLED).to_string(),
        title: TITLE_TODO,
        // 描述行 = 会话标题 + 到达时刻的时分秒（语音不读本行，见 NotifyMessage::body 文档）
        body: format!("{} · {}", title.unwrap_or(UNTITLED), notify::now_hms()),
        summary: format!("{TITLE_TODO}：{desc}"),
        desc,
        ts: notify::now_ms(),
    }
}

fn turn_end_message(sid: &str, title: Option<&str>) -> NotifyMessage {
    let session_title = title.unwrap_or(UNTITLED);
    NotifyMessage {
        kind: KIND_TURN_END,
        session_id: sid.to_string(),
        session_title: session_title.to_string(),
        title: TITLE_TURN_END,
        // 描述行只带到达时刻：结束原因不再上 toast（「原因：…」按需求移除）
        body: notify::now_hms(),
        summary: format!("{TITLE_TURN_END}：{session_title}"),
        // desc 不再拼「对话已结束」：title（对话结束）已表达该语义，避免重复
        desc: session_title.to_string(),
        ts: notify::now_ms(),
    }
}

// ---------------------------------------------------------------------------
// 单测（按实测帧形态编写）
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn stream_item(stream: &str, value: Value) -> String {
        serde_json::json!({ "type": "item", "streamId": stream, "value": value }).to_string()
    }

    fn follow_event(sid: &str, event: Value) -> String {
        stream_item(
            &format!("t-{sid}"),
            serde_json::json!({ "type": "event", "event": event }),
        )
    }

    fn open_live() -> Live {
        let mut live = Live::new();
        live.streams.insert("t-s1".into(), ("s1".into(), true));
        live
    }

    fn todos(items: &[(&str, &str)]) -> Value {
        Value::Array(
            items
                .iter()
                .map(
                    |(content, status)| serde_json::json!({ "content": content, "status": status }),
                )
                .collect(),
        )
    }

    /// 校验 `HH:MM:SS` 形态（描述行时间尾缀的测试断言用）
    fn is_hms(s: &str) -> bool {
        let p: Vec<&str> = s.split(':').collect();
        p.len() == 3
            && p.iter()
                .all(|x| x.len() == 2 && x.bytes().all(|b| b.is_ascii_digit()))
    }

    #[test]
    fn todo_desc_省略零值段并用间隔号连接() {
        assert_eq!(todo_desc(3, 1, 2), "3项已完成 · 1项进行中 · 2项待处理");
        assert_eq!(todo_desc(0, 1, 0), "1项进行中");
        assert_eq!(todo_desc(2, 0, 0), "2项已完成");
        assert_eq!(todo_desc(0, 0, 4), "4项待处理");
        assert_eq!(todo_desc(0, 0, 0), "");
    }

    /// follow_open 帧形态与实测一致（args 包 request.address）
    #[test]
    fn follow_open_帧形态() {
        let raw = follow_open("s-1", "session-x");
        let v: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["type"], "open");
        assert_eq!(v["endpoint"], "session/follow");
        assert_eq!(
            v["payload"]["args"]["request"]["address"]["kind"],
            "session"
        );
        assert_eq!(
            v["payload"]["args"]["request"]["address"]["sessionId"],
            "session-x"
        );
        assert_eq!(v["streamId"], "s-1");
    }

    /// snapshot 只置就绪、不产生推送；其后的实时 event 正常渲染
    #[test]
    fn 快照不推_后续实时事件推送() {
        let mut notes = Notes::new();
        let mut live = Live::new();
        live.streams
            .insert("t-x".into(), ("session-x".into(), false));
        // snapshot 基线：即使里面带着 turn/end 也不提醒
        let snap = stream_item(
            "t-x",
            serde_json::json!({
                "type": "snapshot",
                "header": { "id": "session-x" },
                "cursor": 10,
                "records": [{
                    "type": "event",
                    "event": { "type": "turn/end", "seq": 5, "time": 0, "data": { "reason": { "kind": "completed" } } }
                }]
            }),
        );
        assert!(extract_mux(&snap, &mut live, &mut notes).is_none());
        assert_eq!(live.streams.get("t-x").map(|(_, r)| *r), Some(true));
        // 实时 todo/write → 推送（stream 与上面快照一致：t-x）
        let frame = stream_item(
            "t-x",
            serde_json::json!({
                "type": "event",
                "event": { "type": "todo/write", "seq": 11, "time": 0, "data": { "todos": todos(&[("a", "completed"), ("b", "in_progress"), ("c", "pending")]) } }
            }),
        );
        let msg = extract_mux(&frame, &mut live, &mut notes).expect("应产生一条推送");
        assert_eq!(msg.kind, "todo");
        assert_eq!(msg.session_id, "session-x");
        assert_eq!(msg.summary, "更新任务清单：1项已完成 · 1项进行中 · 1项待处理");
        // 描述行 = 会话标题 + 「· HH:MM:SS」时间尾缀
        let (base, hms) = msg.body.rsplit_once(" · ").expect("body 应带时间尾缀");
        assert_eq!(base, "未命名对话");
        assert!(is_hms(hms), "尾缀应为 HH:MM:SS: {hms}");
    }

    /// 计数未变化时不重复推送；计数变了才推
    #[test]
    fn 计数未变化时不重复推送() {
        let mut notes = Notes::new();
        let mut live = open_live();
        let f1 = follow_event(
            "s1",
            serde_json::json!({ "type": "todo/write", "seq": 1, "time": 0, "data": { "todos": todos(&[("a", "completed"), ("b", "in_progress")]) } }),
        );
        assert!(extract_mux(&f1, &mut live, &mut notes).is_some());
        let f2 = follow_event(
            "s1",
            serde_json::json!({ "type": "todo/write", "seq": 2, "time": 0, "data": { "todos": todos(&[("a", "in_progress"), ("b", "completed")]) } }),
        );
        assert!(
            extract_mux(&f2, &mut live, &mut notes).is_none(),
            "计数全等应被去重"
        );
        let f3 = follow_event(
            "s1",
            serde_json::json!({ "type": "todo/write", "seq": 3, "time": 0, "data": { "todos": todos(&[("a", "completed"), ("b", "completed")]) } }),
        );
        let msg = extract_mux(&f3, &mut live, &mut notes).expect("计数变化应推送");
        assert_eq!(msg.summary, "更新任务清单：2项已完成");
    }

    #[test]
    fn 空清单不推送() {
        let mut notes = Notes::new();
        let mut live = open_live();
        let frame = follow_event(
            "s1",
            serde_json::json!({ "type": "todo/write", "seq": 1, "time": 0, "data": { "todos": [] } }),
        );
        assert!(extract_mux(&frame, &mut live, &mut notes).is_none());
    }

    #[test]
    fn turn_end_描述行只带时刻() {
        let mut notes = Notes::new();
        let mut live = open_live();
        merge_title(&mut notes, "s1", Some("修 Bug".into()), true);
        // 帧里仍携带 reason：渲染端不再消费（「原因：…」已按需求从文案移除）
        let frame = follow_event(
            "s1",
            serde_json::json!({ "type": "turn/end", "seq": 1, "time": 0, "data": { "turn": 3, "reason": { "kind": "completed" } } }),
        );
        let msg = extract_mux(&frame, &mut live, &mut notes).expect("应推送 turn/end");
        assert_eq!(msg.kind, "turnEnd");
        assert_eq!(msg.session_title, "修 Bug");
        // desc 不再拼「对话已结束」（title 已表达该语义）
        assert_eq!(msg.desc, "修 Bug");
        assert_eq!(msg.summary, "对话结束：修 Bug");
        // body 只剩到达时刻的时分秒
        assert!(is_hms(&msg.body), "body 应只剩 HH:MM:SS: {}", msg.body);
    }

    /// 时分秒只出现在描述行（body）：标题行（summary）、标题与描述字段
    /// （title/desc）——也就是语音通道可能朗读的全部内容——都不得出现时间。
    /// 锁死「时间只进文字版、不被语音念出来」这条需求边界。
    #[test]
    fn 时分秒只进描述行body() {
        let msgs = [
            todo_message(
                "s1",
                Some("会话A"),
                TodoCounts {
                    done: 2,
                    active: 1,
                    pending: 1,
                },
            ),
            turn_end_message("s1", Some("会话A")),
        ];
        for msg in &msgs {
            // todo 的 body = 会话名 · HH:MM:SS；turnEnd 的 body = 纯 HH:MM:SS
            let hms = match msg.body.rsplit_once(" · ") {
                Some((_, hms)) => hms,
                None => msg.body.as_str(),
            };
            assert!(is_hms(hms), "描述行应含 HH:MM:SS: {}", msg.body);
            assert!(!msg.title.contains(hms), "title 不得出现时间: {}", msg.title);
            assert!(!msg.desc.contains(hms), "desc 不得出现时间: {}", msg.desc);
            assert!(
                !msg.summary.contains(hms),
                "summary（toast 标题行/语音 summary 模式）不得出现时间: {}",
                msg.summary
            );
        }
    }

    #[test]
    fn ignorable_事件被丢弃() {
        let mut notes = Notes::new();
        let mut live = open_live();
        let frame = follow_event(
            "s1",
            serde_json::json!({ "type": "turn/end", "seq": 1, "time": 0, "ignorable": true, "data": { "turn": 1, "reason": { "kind": "completed" } } }),
        );
        assert!(extract_mux(&frame, &mut live, &mut notes).is_none());
    }

    #[test]
    fn end_帧摘除follow流() {
        let mut live = Live::new();
        live.streams.insert("t-x".into(), ("s1".into(), true));
        let raw = r#"{"type":"end","streamId":"t-x"}"#;
        assert!(extract_mux(raw, &mut live, &mut Notes::new()).is_none());
        assert!(!live.streams.contains_key("t-x"));
    }

    #[test]
    fn endpoint_解析token() {
        let ep = Endpoint::parse("http://127.0.0.1:6088/?token=abc-123").unwrap();
        assert_eq!((ep.host.as_str(), ep.port), ("127.0.0.1", 6088));
        assert_eq!(ep.token.as_deref(), Some("abc-123"));
        let bare = Endpoint::parse("http://localhost:3080").unwrap();
        assert_eq!(bare.token, None);
        assert!(Endpoint::parse("http://localhost:abc").is_none());
    }

    #[test]
    fn rpc信封带args() {
        let v = rpc_envelope("session/list", serde_json::json!({ "_request": {} }));
        assert_eq!(v["type"], "client-request");
        assert_eq!(v["method"], "session/list");
        assert_eq!(
            v["payload"]["args"]["_request"],
            Value::Object(Default::default())
        );
    }

    /// 确保每个 live 会话只 follow 一次（同 id 不会重复开流）
    #[test]
    fn follow流同会话不重复() {
        let mut live = Live::new();
        let s1 = live.next_stream();
        live.streams.insert(s1.clone(), ("session-x".into(), false));
        assert!(live.is_following("session-x"));
        let before = live.streams.len();
        let _ = live.next_stream();
        // is_following 判定足以让 discover 跳过
        assert_eq!(live.streams.len(), before);
    }

    /// 回归（v0.1.20 推送失效根因）：WS 升级请求必须携带 RFC 6455 全部必需头。
    /// 手建 Request 会被 tungstenite 原样透传（不注入 Sec-WebSocket-Key 等），
    /// 握手恒定失败且错误被静默吞掉——这里锁死 build_ws_request 的输出形态。
    #[test]
    fn ws升级请求带全部必需头与cookie() {
        let req = build_ws_request(
            "ws://127.0.0.1:6199/api/remote.mux",
            "dsh-auth-abc=v1.body.sig",
        )
        .expect("request should build");
        let h = req.headers();
        for name in [
            "host",
            "connection",
            "upgrade",
            "sec-websocket-version",
            "sec-websocket-key",
        ] {
            assert!(h.get(name).is_some(), "missing required header {name}");
        }
        // Sec-WebSocket-Key：库生成的 16 字节随机数的 base64（24 字符）
        let key = h.get("sec-websocket-key").unwrap();
        assert_eq!(key.len(), 24, "generated key should be 24-char base64");
        assert_eq!(h.get("connection").unwrap(), "Upgrade");
        assert_eq!(h.get("upgrade").unwrap(), "websocket");
        assert_eq!(h.get("sec-websocket-version").unwrap(), "13");
        // Cookie 附加在必需头之外
        assert_eq!(
            h.get("cookie").unwrap(),
            "dsh-auth-abc=v1.body.sig",
            "auth cookie must be attached"
        );
        assert_eq!(
            req.uri().path_and_query().unwrap().as_str(),
            "/api/remote.mux"
        );
        assert_eq!(req.uri().host(), Some("127.0.0.1"));
        assert_eq!(req.uri().port_u16(), Some(6199));
    }

    #[test]
    fn ws升级请求拒绝非法cookie值() {
        // 非可见 ASCII 的 HeaderValue 会被拒绝 → 返回 None（由 supervisor 重试）
        assert!(build_ws_request("ws://127.0.0.1:1/x", "bad\u{0}value").is_none());
    }
}
