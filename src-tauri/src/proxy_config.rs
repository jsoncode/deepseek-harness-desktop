// 安装临时代理：设置页配置，仅注入到「装 node / 装 pnpm / 装 dsh / 插件操作」
// 等安装类子进程的环境变量里。不写 .npmrc、不动系统代理、不改本应用自身进程
// 环境（Command::env 只作用于即将 spawn 的这一个子进程）。

use std::fs;
use std::path::PathBuf;
use std::process::Command;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

pub const PROXY_KINDS: [&str; 5] = ["direct", "http", "https", "socks4", "socks5"];

/// 安装代理配置。kind = "direct" 表示直连（不注入任何代理变量）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProxyConfig {
    /// "direct" | "http" | "https" | "socks4" | "socks5"
    pub kind: String,
    /// 代理服务器 IP / 域名（direct 时忽略）
    pub host: String,
    /// 代理端口 1-65535（direct 时忽略）
    pub port: Option<u16>,
}

impl Default for ProxyConfig {
    fn default() -> Self {
        Self {
            kind: "direct".into(),
            host: String::new(),
            port: None,
        }
    }
}

impl ProxyConfig {
    /// 直连，或字段缺失不完整（配置损坏时按直连处理，绝不阻塞安装）
    fn is_direct(&self) -> bool {
        self.kind == "direct" || self.host.trim().is_empty() || self.port.is_none_or(|p| p == 0)
    }

    /// scheme://host:port；IPv6 字面量主机自动加方括号
    fn proxy_url(&self) -> String {
        let host = self.host.trim();
        let host = if host.contains(':') && !host.starts_with('[') {
            format!("[{host}]")
        } else {
            host.to_string()
        };
        format!("{}://{}:{}", self.kind, host, self.port.unwrap_or(0))
    }
}

fn validate(config: &ProxyConfig) -> Result<(), String> {
    if !PROXY_KINDS.contains(&config.kind.as_str()) {
        return Err(format!(
            "代理类型必须是 {} 之一",
            PROXY_KINDS
                .iter()
                .map(|k| match *k {
                    "direct" => "直接连接",
                    other => other,
                })
                .collect::<Vec<_>>()
                .join(" / ")
        ));
    }
    if config.kind != "direct" {
        if config.host.trim().is_empty() {
            return Err("请填写代理服务器地址（IP 或域名）".into());
        }
        match config.port {
            None => return Err("请填写代理端口".into()),
            Some(0) => return Err("代理端口必须在 1-65535 之间".into()),
            Some(_) => {}
        }
    }
    Ok(())
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
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// 把代理配置注入子进程环境变量。返回 Some(提示文案) 时由调用方写入安装日志，
/// 让用户能在启动/插件日志里看到本次安装走了哪个代理。
pub fn apply_proxy_env(app: &AppHandle, event: &str, cmd: &mut Command) -> Option<String> {
    let config = load(app);
    if config.is_direct() {
        return None;
    }
    let url = config.proxy_url();
    match config.kind.as_str() {
        // npm/pnpm 只认 http(s) 代理；socks 是 curl/git 等工具的 ALL_PROXY 约定
        "http" | "https" => {
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
        }
        _ => {
            for key in ["ALL_PROXY", "all_proxy"] {
                cmd.env(key, &url);
            }
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
    let normalized = ProxyConfig {
        kind: config.kind,
        host: config.host.trim().to_string(),
        port: config.port,
    };
    let text = serde_json::to_string_pretty(&normalized).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| format!("保存代理配置失败: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_kind_and_fields() {
        assert!(validate(&ProxyConfig::default()).is_ok());
        assert!(validate(&ProxyConfig {
            kind: "http".into(),
            host: "127.0.0.1".into(),
            port: Some(7890),
        })
        .is_ok());
        assert!(validate(&ProxyConfig {
            kind: "ftp".into(),
            host: "h".into(),
            port: Some(1),
        })
        .is_err());
        assert!(validate(&ProxyConfig {
            kind: "socks5".into(),
            host: "".into(),
            port: Some(1),
        })
        .is_err());
        assert!(validate(&ProxyConfig {
            kind: "http".into(),
            host: "h".into(),
            port: Some(0),
        })
        .is_err());
    }

    #[test]
    fn builds_proxy_url() {
        let cfg = ProxyConfig {
            kind: "socks5".into(),
            host: "proxy.local".into(),
            port: Some(1080),
        };
        assert_eq!(cfg.proxy_url(), "socks5://proxy.local:1080");
        let v6 = ProxyConfig {
            kind: "http".into(),
            host: "::1".into(),
            port: Some(8080),
        };
        assert_eq!(v6.proxy_url(), "http://[::1]:8080");
    }

    #[test]
    fn incomplete_config_falls_back_to_direct() {
        // 字段损坏（host/port 缺失）时按直连处理，绝不阻塞安装链
        assert!(ProxyConfig {
            kind: "http".into(),
            host: "".into(),
            port: Some(7890),
        }
        .is_direct());
        assert!(ProxyConfig {
            kind: "http".into(),
            host: "h".into(),
            port: None,
        }
        .is_direct());
    }
}
