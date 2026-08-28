//! 系统推送的投递层：把渲染好的通知消息分发给各通道。
//!
//! 本期只有 Windows toast 通道（notify-rust → WinRT）。**语音播放接入位**就在这里：
//! 新增一个实现 [`NotifyChannel`] 的结构体并加进 [`channels`]，上游
//! （`session_events` 的订阅 / 过滤 / 渲染）零改动。前端那半边的同名扩展点在
//! `src/lib/notify.ts`，两边通过 `dispatch` 里的一次 `emit` 对齐。

use crate::dsh;
use crate::session_events::NotifyMessage;
use std::path::PathBuf;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager};

/// Windows toast 的品牌标识（AUMID）。必须与 tauri `identifier` 一致：
/// notify-rust 不设 app_id 时会回退到 PowerShell 的 AUMID，通知会被显示成
/// 「Windows PowerShell」，既丢品牌也点不进本应用。
pub const APP_ID: &str = "com.deepseek.harness.desktop";

/// 一条通知消息的多通道投递抽象。
/// `Sync` 超类型是因为通道表是 `static`，而投递发生在后台线程。
pub trait NotifyChannel: Sync {
    /// 通道名（调试用；语音通道即 "voice"）
    fn name(&self) -> &'static str;
    fn deliver(&self, app: &AppHandle, msg: &NotifyMessage);
}

/// Windows 系统 toast。非 Windows 平台本期不弹系统通知（只走 `dispatch` 的 emit）。
pub struct ToastChannel;

impl NotifyChannel for ToastChannel {
    fn name(&self) -> &'static str {
        "toast"
    }

    fn deliver(&self, app: &AppHandle, msg: &NotifyMessage) {
        #[cfg(windows)]
        {
            use notify_rust::Notification;
            let mut n = Notification::new();
            // notify-rust 在 Windows 上的映射：summary → toast 标题、body → 第二行文本、
            // image_path → toast 图片。`.icon()` 只在 XDG 后端生效、Windows 下被忽略，
            // 所以 logo 必须走 image_path。
            n.app_id(APP_ID).summary(&msg.summary).body(&msg.body);
            if let Some(p) = logo_path(app) {
                n.image_path(&p.to_string_lossy());
            }
            // 投递不能干扰主流程，但也不能静默失败到无法定位
            // （toast 不出现的常见原因是 AUMID 未注册，见计划的风险清单）
            if let Err(e) = n.show() {
                eprintln!("[notify] {} 通道投递失败: {e}", self.name());
            }
        }
        #[cfg(not(windows))]
        {
            let _ = (app, msg);
        }
    }
}

/// 当前启用的投递通道。语音通道后续追加到这里。
static CHANNELS: &[&dyn NotifyChannel] = &[&ToastChannel];

fn channels() -> &'static [&'static dyn NotifyChannel] {
    CHANNELS
}

/// toast 里显示的本应用 logo。
/// 打包态从 bundle resources 解析（见 tauri.conf.json 的 `bundle.resources`）；
/// dev 态资源目录里没这个文件（resolve 会成功但路径不存在），回退到 crate 源码下的
/// 同名文件。两条路径都拿不到则返回 None（通知照弹，只是没图）。
fn logo_path(app: &AppHandle) -> Option<PathBuf> {
    let from_bundle = app
        .path()
        .resolve("icons/icon.png", BaseDirectory::Resource)
        .ok();
    let from_source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("icons/icon.png");
    [from_bundle, Some(from_source)]
        .into_iter()
        .flatten()
        .find(|p| p.is_file())
}

/// 统一投递入口：先送系统通知，再把同一条消息 emit 给前端
/// （界面展示与未来的语音通道都从这里取）。
pub fn dispatch(app: &AppHandle, msg: &NotifyMessage) {
    for ch in channels() {
        ch.deliver(app, msg);
    }
    let _ = app.emit(dsh::NOTIFY_MESSAGE_EVENT, msg);
}

/// 开关从「关」切到「开」时的自检通知，让用户立刻看到提醒长什么样。
/// 只走系统通知通道、不 emit：它不是会话事件，没必要让语音通道跟着念一遍。
pub fn push_sample(app: &AppHandle) {
    let msg = NotifyMessage {
        kind: "sample",
        session_id: String::new(),
        session_title: String::new(),
        title: "系统推送",
        desc: "已开启，任务进展会在这里提醒你".into(),
        summary: "系统推送：已开启，任务进展会在这里提醒你".into(),
        body: "dsh 会话更新任务清单或结束对话时会弹出这样的通知".into(),
        ts: now_ms(),
    };
    for ch in channels() {
        ch.deliver(app, &msg);
    }
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// logo 回退路径在开发机上必须可解析（打包态由资源目录命中，测试态走 crate 目录）
    #[test]
    fn logo_文件真实存在() {
        let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("icons/icon.png");
        assert!(p.is_file(), "推送 logo 应随仓库存在: {p:?}");
    }

    /// 静态通道表不允许出现同名通道（避免重复投递同一提醒）
    #[test]
    fn 通道名不重复() {
        let mut names: Vec<&str> = Vec::new();
        for ch in channels() {
            let n = ch.name();
            assert!(!names.contains(&n), "通道名重复: {n}");
            names.push(n);
        }
        assert!(!names.is_empty());
    }
}
