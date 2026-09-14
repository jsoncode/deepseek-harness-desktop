// 安装临时代理：设置页配置，仅注入到「装 node / 装 pnpm / 装 dsh / 插件操作」
// 等安装类子进程的环境变量里。不写 .npmrc、不动系统代理、不改本应用自身进程
// 环境（Command::env 只作用于即将 spawn 的这一个子进程）。
//
// 配置只有两项：**开关** + **代理地址**。是否走代理只看开关（关掉即直连，与地址
// 是否填写无关）；代理类型不再单列，由地址的协议前缀决定。

use std::fs;
use std::path::PathBuf;
use std::process::Command;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// 支持的代理协议：地址前缀即代理类型
pub const PROXY_SCHEMES: [&str; 4] = ["http", "https", "socks4", "socks5"];

/// 默认代理地址（本机代理软件最常见的 http 端口）
pub const DEFAULT_PROXY_URL: &str = "http://127.0.0.1:7890";

/// 解析后的代理端点。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProxyEndpoint {
    /// http | https | socks4 | socks5
    pub scheme: String,
    /// 主机（IPv6 字面量已去掉方括号，输出时自动补回）
    pub host: String,
    /// 端口 1-65535
    pub port: u16,
    /// 可选的 `user:password` 凭据（原样透传给安装进程的环境变量）
    pub userinfo: Option<String>,
}

impl ProxyEndpoint {
    /// scheme://host:port；IPv6 字面量主机自动加方括号，有凭据时保留 `user:pass@`
    pub fn url(&self) -> String {
        let host = if self.host.contains(':') && !self.host.starts_with('[') {
            format!("[{}]", self.host)
        } else {
            self.host.clone()
        };
        let authority = match &self.userinfo {
            Some(userinfo) => format!("{userinfo}@{host}"),
            None => host,
        };
        format!("{}://{}:{}", self.scheme, authority, self.port)
    }

    /// npm/pnpm 只认 http(s) 代理；socks 是 curl/git 等工具的 ALL_PROXY 约定
    pub fn is_http_like(&self) -> bool {
        matches!(self.scheme.as_str(), "http" | "https")
    }
}

/// 解析代理地址：`协议://主机:端口`，省略协议时按 http 处理
/// （用户常直接粘贴 `127.0.0.1:7890`）。
pub fn parse_endpoint(raw: &str) -> Result<ProxyEndpoint, String> {
    let text = raw.trim();
    if text.is_empty() {
        return Err(format!("请填写代理地址，如 {DEFAULT_PROXY_URL}"));
    }
    let (scheme, rest) = match text.split_once("://") {
        Some((scheme, rest)) => (scheme.trim().to_ascii_lowercase(), rest),
        None => ("http".to_string(), text),
    };
    if !PROXY_SCHEMES.contains(&scheme.as_str()) {
        return Err(format!(
            "代理地址协议仅支持 {}，如 {DEFAULT_PROXY_URL}",
            PROXY_SCHEMES.join(" / ")
        ));
    }
    // 允许结尾多写一个 `/`，其余路径一律拒绝（env 变量里带路径只会让请求 404）
    let authority = rest.trim().trim_end_matches('/');
    if authority.contains('/') || authority.contains('?') {
        return Err(format!("代理地址只填到端口即可，如 {DEFAULT_PROXY_URL}"));
    }
    let (userinfo, hostport) = match authority.rsplit_once('@') {
        Some((userinfo, hostport)) => (Some(userinfo.to_string()), hostport),
        None => (None, authority),
    };
    let (host, port_text) = split_host_port(hostport)?;
    let host = host.trim().to_string();
    if host.is_empty() {
        return Err(format!("请填写代理主机地址，如 {DEFAULT_PROXY_URL}"));
    }
    let port_text = port_text
        .filter(|p| !p.is_empty())
        .ok_or_else(|| format!("请填写代理端口，如 {DEFAULT_PROXY_URL}"))?;
    let port: u16 = port_text
        .parse()
        .map_err(|_| "代理端口必须是 1-65535 之间的数字".to_string())?;
    if port == 0 {
        return Err("代理端口必须在 1-65535 之间".into());
    }
    Ok(ProxyEndpoint {
        scheme,
        host,
        port,
        userinfo: userinfo.filter(|u| !u.is_empty()),
    })
}

/// `主机:端口` 拆分（IPv6 字面量要求写成 `[::1]:7890`）。返回的端口片段为 None
/// 表示地址里没写端口。
fn split_host_port(authority: &str) -> Result<(String, Option<&str>), String> {
    if let Some(inner) = authority.strip_prefix('[') {
        let (host, tail) = inner
            .split_once(']')
            .ok_or_else(|| "IPv6 地址缺少右方括号，如 http://[::1]:7890".to_string())?;
        return Ok((host.to_string(), tail.strip_prefix(':')));
    }
    Ok(match authority.rsplit_once(':') {
        Some((host, port)) => (host.to_string(), Some(port)),
        None => (authority.to_string(), None),
    })
}

/// 安装代理配置。
///
/// 是否启用**只看 `enabled` 开关**：关掉即直连，即使地址还留着也不注入任何变量。
/// 代理类型由 `url` 的协议前缀决定（http / https / socks4 / socks5）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProxyConfig {
    /// 代理开关
    pub enabled: bool,
    /// 代理地址，形如 http://127.0.0.1:7890
    pub url: String,
}

impl Default for ProxyConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            url: DEFAULT_PROXY_URL.into(),
        }
    }
}

/// 反序列化兼容旧格式 `{kind, host, port}`（设置页把「代理类型」并进地址之前写下的
/// proxy.json）：kind != direct 且地址完整时迁移成「开关 + 地址」，否则回落到默认直连。
impl<'de> Deserialize<'de> for ProxyConfig {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Raw {
            Current {
                enabled: bool,
                url: String,
            },
            Legacy {
                kind: String,
                host: String,
                port: Option<u16>,
            },
        }
        Ok(match Raw::deserialize(deserializer)? {
            Raw::Current { enabled, url } => ProxyConfig { enabled, url },
            Raw::Legacy { kind, host, port } => match (kind.as_str(), host.trim(), port) {
                ("direct", _, _) => ProxyConfig::default(),
                (_, host, Some(port)) if !host.is_empty() && port > 0 => ProxyConfig {
                    enabled: true,
                    url: format!("{kind}://{host}:{port}"),
                },
                _ => ProxyConfig::default(),
            },
        })
    }
}

impl ProxyConfig {
    /// 当前生效的代理端点。
    ///
    /// - `Ok(None)`：开关关闭 → 直连（**判断是否走代理只看开关，与地址无关**）；
    /// - `Err(原因)`：开关开着但地址不可用（多为手改配置文件写坏）→ 调用方按直连兜底，
    ///   绝不阻塞安装链。
    pub fn endpoint(&self) -> Result<Option<ProxyEndpoint>, String> {
        if !self.enabled {
            return Ok(None);
        }
        parse_endpoint(&self.url).map(Some)
    }
}

fn validate(config: &ProxyConfig) -> Result<(), String> {
    // 开关关闭时不校验地址：可以留空或留着上次的地址，保存的语义就是「直连」
    config.endpoint().map(|_| ())
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录: {e}"))?;
    Ok(dir.join("proxy.json"))
}

fn load(app: &AppHandle) -> ProxyConfig {
    let Ok(path) = config_path(app) else {
        return ProxyConfig::default();
    };
    let mut config: ProxyConfig = fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    // 地址缺失（旧配置迁移失败 / 手改成空串）时补回默认值，设置页里始终有可编辑的内容
    if config.url.trim().is_empty() {
        config.url = DEFAULT_PROXY_URL.to_string();
    }
    config
}

/// 把代理配置注入子进程环境变量。返回 Some(提示文案) 时由调用方写入安装日志，
/// 让用户能在启动/插件日志里看到本次安装走了哪个代理。
pub fn apply_proxy_env(app: &AppHandle, event: &str, cmd: &mut Command) -> Option<String> {
    let config = load(app);
    let endpoint = match config.endpoint() {
        Ok(Some(endpoint)) => endpoint,
        // 开关关闭：直连，什么都不注入
        Ok(None) => return None,
        // 开关开着但地址坏了：按直连兜底，并在安装日志里说明原因
        Err(err) => {
            let tip = format!("「安装代理」已开启但代理地址不可用（{err}），本次安装按直连处理");
            crate::dsh::emit_log(app, event, "system", &tip);
            return Some(tip);
        }
    };
    let url = endpoint.url();
    if endpoint.is_http_like() {
        for key in [
            "HTTP_PROXY",
            "http_proxy",
            "HTTPS_PROXY",
            "https_proxy",
            "ALL_PROXY",
            "all_proxy",
            "npm_config_proxy",
            "npm_config_https_proxy",
        ] {
            cmd.env(key, &url);
        }
    } else {
        for key in ["ALL_PROXY", "all_proxy"] {
            cmd.env(key, &url);
        }
    }
    // 本机服务（dsh web 等）绝不走代理
    for key in ["NO_PROXY", "no_proxy"] {
        cmd.env(key, "localhost,127.0.0.1,::1");
    }
    let tip = format!("已为本次安装启用临时代理 {url}（仅作用于安装进程，不影响系统与 npm 配置）");
    crate::dsh::emit_log(app, event, "system", &tip);
    Some(tip)
}

#[tauri::command]
pub fn get_proxy_config(app: AppHandle) -> ProxyConfig {
    load(&app)
}

#[tauri::command]
pub fn set_proxy_config(app: AppHandle, config: ProxyConfig) -> Result<(), String> {
    validate(&config)?;
    let path = config_path(&app)?;
    // 关掉开关时地址允许留空：写入默认地址，免得配置文件里留一个空串
    let url = config.url.trim();
    let normalized = ProxyConfig {
        enabled: config.enabled,
        url: if url.is_empty() {
            DEFAULT_PROXY_URL.to_string()
        } else {
            url.to_string()
        },
    };
    let text = serde_json::to_string_pretty(&normalized).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| format!("保存代理配置失败: {e}"))?;
    // 模型代理的上游就取自这份配置：运行中的路由代理就地换上游，不必重启服务
    crate::model_proxy::reload_upstream(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(enabled: bool, url: &str) -> ProxyConfig {
        ProxyConfig {
            enabled,
            url: url.into(),
        }
    }

    #[test]
    fn default_is_direct_with_local_http_address() {
        let d = ProxyConfig::default();
        assert!(!d.enabled);
        assert_eq!(d.url, DEFAULT_PROXY_URL);
        assert_eq!(d.endpoint(), Ok(None));
    }

    #[test]
    fn validates_only_when_enabled() {
        // 关掉开关：地址随便写都不校验，语义就是直连
        assert!(validate(&cfg(false, "")).is_ok());
        assert!(validate(&cfg(false, "随便写的")).is_ok());
        assert!(validate(&cfg(true, DEFAULT_PROXY_URL)).is_ok());
        assert!(validate(&cfg(true, "http://127.0.0.1")).is_err());
        assert!(validate(&cfg(true, "ftp://127.0.0.1:21")).is_err());
        assert!(validate(&cfg(true, "http://127.0.0.1:0")).is_err());
        assert!(validate(&cfg(true, "http://127.0.0.1:70000")).is_err());
        assert!(validate(&cfg(true, "")).is_err());
    }

    #[test]
    fn parses_scheme_host_port() {
        let e = parse_endpoint("http://127.0.0.1:7890").unwrap();
        assert_eq!(e.scheme, "http");
        assert_eq!(e.host, "127.0.0.1");
        assert_eq!(e.port, 7890);
        assert_eq!(e.url(), "http://127.0.0.1:7890");
        assert!(e.is_http_like());
    }

    #[test]
    fn scheme_defaults_to_http_and_ignores_case_and_trailing_slash() {
        assert_eq!(
            parse_endpoint("127.0.0.1:7890").unwrap().url(),
            "http://127.0.0.1:7890"
        );
        assert_eq!(
            parse_endpoint("  SOCKS5://Proxy.LOCAL:1080/ ")
                .unwrap()
                .url(),
            "socks5://Proxy.LOCAL:1080"
        );
        assert!(!parse_endpoint("socks5://Proxy.LOCAL:1080")
            .unwrap()
            .is_http_like());
    }

    #[test]
    fn builds_ipv6_and_credential_urls() {
        let v6 = parse_endpoint("http://[::1]:8080").unwrap();
        assert_eq!(v6.host, "::1");
        assert_eq!(v6.url(), "http://[::1]:8080");

        let auth = parse_endpoint("http://user:pass@proxy.local:8080").unwrap();
        assert_eq!(auth.userinfo.as_deref(), Some("user:pass"));
        assert_eq!(auth.host, "proxy.local");
        assert_eq!(auth.url(), "http://user:pass@proxy.local:8080");
    }

    #[test]
    fn rejects_unusable_addresses() {
        for raw in [
            "",
            "   ",
            "http://",
            "http://:7890",
            "http://127.0.0.1",
            "http://127.0.0.1:",
            "http://127.0.0.1:abc",
            "http://127.0.0.1:7890/path",
            "ftp://127.0.0.1:7890",
            "http://[::1:7890",
        ] {
            assert!(parse_endpoint(raw).is_err(), "{raw} 应被拒绝");
        }
    }

    #[test]
    fn enabled_flag_alone_decides_whether_proxy_is_used() {
        // 开关关闭：地址填得再全也按直连
        assert_eq!(cfg(false, "http://127.0.0.1:7890").endpoint(), Ok(None));
        // 开关开启：地址可用即生效
        assert!(cfg(true, "http://127.0.0.1:7890")
            .endpoint()
            .unwrap()
            .is_some());
        // 开关开启但地址坏了：报错，调用方兜底直连（不阻塞安装）
        assert!(cfg(true, "写坏的地址").endpoint().is_err());
    }

    #[test]
    fn reads_legacy_kind_host_port_config() {
        let legacy: ProxyConfig =
            serde_json::from_str(r#"{"kind":"http","host":"127.0.0.1","port":7890}"#).unwrap();
        assert_eq!(legacy, cfg(true, "http://127.0.0.1:7890"));

        let direct: ProxyConfig =
            serde_json::from_str(r#"{"kind":"direct","host":"127.0.0.1","port":7890}"#).unwrap();
        assert!(!direct.enabled);

        let broken: ProxyConfig =
            serde_json::from_str(r#"{"kind":"http","host":"","port":null}"#).unwrap();
        assert!(!broken.enabled);
    }

    #[test]
    fn round_trips_current_format() {
        let text = serde_json::to_string(&cfg(true, "socks5://127.0.0.1:1080")).unwrap();
        assert_eq!(
            serde_json::from_str::<ProxyConfig>(&text).unwrap(),
            cfg(true, "socks5://127.0.0.1:1080")
        );
    }
}
