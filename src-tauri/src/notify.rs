//! 系统推送的投递层：把渲染好的通知消息分发给各通道。
//!
//! Windows toast 有两种实现、由 [`ToastStyle`] 切换（设置页「两种提示切换开关」
//! 后续接入，见 `dsh::AppState::notify_style`）：
//!
//! - `Legacy`：notify-rust 原实现，保留不删。其 4.17 的 Windows 后端不注册 toast
//!   激活回调（actions/激活均为 XDG/Linux 专属），因此**无点击感知**。
//! - `Clickable`（默认）：直连 `tauri-winrt-notification`，toast 上挂「打开对话」
//!   按钮（激活参数 = 会话 id），点击后 `emit NOTIFY_ACTIVATE_EVENT` 给前端，
//!   并把窗口恢复到前台。
//!
//! 两种实现都使用 Windows Reminder 场景（`scenario="reminder"`）：toast 预展开
//! 并保持显示在屏幕右下角，直到用户点击/关闭，不会几秒后自动消失（见
//! `legacy_toast` 的 `Urgency::Critical` 与 `clickable_toast` 的
//! `Scenario::Reminder`）。Reminder 常驻意味着通知会在屏幕/通知中心累积，
//! 因此投递新 toast 前统一走 [`clear_stale_toasts`] 按本应用 AUMID 清掉旧
//! 驻留——**同一时刻至多只有最新一条本应用通知**（不影响其他应用的通知）。
//!
//! **语音播放**已接入：`tts::VoiceChannel` 实现了 [`NotifyChannel`] 并在 [`CHANNELS`]
//! 表中——deliver 只入队立即返回，由常驻 Python worker（Audio8 TTS，见 `tts.rs`）
//! 合成后用 rodio 播放；上游（`session_events` 的订阅 / 过滤 / 渲染）零改动。前端那半边
//! 的同名扩展点在 `src/lib/notify.ts`，两边通过 `dispatch` 里的一次 `emit` 对齐。
//!
//! **游戏模式静音**：前台运行全屏应用（游戏/放映）时弹框推送自动暂停（见
//! [`fullscreen_app_running`]），语音通道与前端 emit 不受影响——dispatch 照常
//! 走全部通道，只有 ToastChannel 静默跳过，退出全屏后自动恢复。

use crate::dsh;
use crate::session_events::NotifyMessage;
use crate::tts;
use std::path::PathBuf;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager};

/// Windows toast 的品牌标识（AUMID）。必须与 tauri `identifier` 一致：
/// winrt-notification 不设 app_id 时会回退到 PowerShell 的 AUMID，通知会被显示成
/// 「Windows PowerShell」，既丢品牌也点不进本应用。
pub const APP_ID: &str = "com.deepseek.harness.desktop";

/// 自检通知的 kind。独立成常量：tts.rs 的测试锁定它，防止有人改名后
/// 「自检通知不朗读」的判断静默失效。
pub const SAMPLE_KIND: &str = "sample";

// ---------------------------------------------------------------------------
// toast 投递方式（Windows-only）：两种实现并存，按 `AppState::notify_style` 切换。
// 设置页「两种提示切换开关」后续接入：只需写 `notify_style` 并重新投递。
// ---------------------------------------------------------------------------

/// toast 投递方式
#[cfg(windows)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ToastStyle {
    /// notify-rust 原实现：无点击感知（保留给切换开关）
    Legacy,
    /// winrt 直连：带「打开对话」按钮与激活回调（点击 → 打开对应会话对话框）
    Clickable,
}

/// 当前 toast 投递方式（读 `AppState::notify_style`；默认 Clickable）
#[cfg(windows)]
fn toast_style(app: &AppHandle) -> ToastStyle {
    use std::sync::atomic::Ordering;
    match app.state::<dsh::AppState>().notify_style.load(Ordering::SeqCst) {
        1 => ToastStyle::Clickable,
        _ => ToastStyle::Legacy,
    }
}

/// toast 激活事件的负载（与前端 `tauri.ts` 的 `NotifyActivatePayload` 同形，
/// serde camelCase）
#[cfg(windows)]
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ActivatePayload {
    /// 被点击按钮携带的会话 id；点到 toast 正文（无 launch 参数）时为 None
    pub session_id: Option<String>,
}

/// 「打开对话」按钮的 `(文案, 激活参数)`：激活参数直接就是会话 id，这样
/// `on_activated` 拿到参数即知要点开哪个会话。空会话（自检通知）不挂按钮，
/// 点到正文只恢复窗口。独立成纯函数便于单测。
#[cfg(windows)]
fn open_button(session_id: &str) -> Option<(&'static str, &str)> {
    (!session_id.is_empty()).then_some(("打开对话", session_id))
}

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
            // 游戏模式（前台全屏应用）静音弹框：连旧驻留清理一起跳过，通知中心
            // 保持原样；dispatch 照常走语音通道与前端 emit——「只保留语音播放」。
            if fullscreen_app_running() {
                return;
            }
            // 只保留一条驻留：Reminder 场景的 toast 会一直留在屏幕/通知中心，
            // 连续事件（多会话 todo/turn-end）会堆出一摞。弹新 toast 前先清掉
            // 本应用旧驻留，屏幕与通知中心永远只有最新一条
            clear_stale_toasts();
            match toast_style(app) {
                ToastStyle::Legacy => legacy_toast(app, msg, self.name()),
                ToastStyle::Clickable => clickable_toast(app, msg, self.name()),
            }
        }
        #[cfg(not(windows))]
        {
            let _ = (app, msg);
        }
    }
}

/// 前台是否运行着全屏应用（游戏 / 放映）：视为「游戏模式」，弹框推送静音、
/// 只保留语音播报。判定：前台窗口的矩形恰好覆盖其所在显示器的完整矩形
/// （rcMonitor）——独占全屏与无边框全屏都命中；最大化窗口的矩形是工作区
/// （不含任务栏），不会误判；桌面态（前台是 Progman）经 GetShellWindow 排除。
/// 任何 API 失败都按「不在游戏模式」处理：宁可多弹一条，不能因此漏报。
#[cfg(windows)]
fn fullscreen_app_running() -> bool {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetShellWindow, GetWindowRect,
    };

    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_invalid() || hwnd == GetShellWindow() {
            return false;
        }
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        if monitor.is_invalid() {
            return false;
        }
        let mut mi = MONITORINFO::default();
        mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if !GetMonitorInfoW(monitor, &mut mi).as_bool() {
            return false;
        }
        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return false;
        }
        rect == mi.rcMonitor
    }
}

/// 按本应用 AUMID 清空此前驻留的系统通知（ToastNotificationHistory.ClearWithId，
/// Windows 10+；仅影响 APP_ID 对应的通知，不碰其他应用）。fork 未暴露历史接口，
/// 直接走 windows crate。任何失败只打日志：清不掉就退回旧行为（允许累积），
/// 不能因此阻断本次投递。
#[cfg(windows)]
fn clear_stale_toasts() {
    use windows::core::HSTRING;
    use windows::UI::Notifications::ToastNotificationManager;
    let history = match ToastNotificationManager::History() {
        Ok(h) => h,
        Err(e) => {
            eprintln!("[notify] 获取通知历史接口失败（跳过旧驻留清理）: {e}");
            return;
        }
    };
    if let Err(e) = history.ClearWithId(&HSTRING::from(APP_ID)) {
        eprintln!("[notify] 清理旧驻留通知失败（忽略，不影响本次投递）: {e}");
    }
}

/// 原实现：notify-rust → WinRT。summary → toast 标题、body → 第二行文本、
/// image_path → toast 图片（`.icon()` 只在 XDG 后端生效，logo 必须走 image_path）。
/// Critical 紧急度映射为 Windows Reminder 场景（见 notify-rust windows.rs 的
/// urgency → scenario 映射）：toast 预展开并保持显示，直到用户点击/关闭，不自动消失。
#[cfg(windows)]
fn legacy_toast(app: &AppHandle, msg: &NotifyMessage, name: &'static str) {
    use notify_rust::{Notification, Urgency};
    let mut n = Notification::new();
    n.app_id(APP_ID)
        .summary(&msg.summary)
        .body(&msg.body)
        .urgency(Urgency::Critical);
    if let Some(p) = logo_path(app) {
        n.image_path(&p.to_string_lossy());
    }
    if let Err(e) = n.show() {
        eprintln!("[notify] {name} 通道投递失败: {e}");
    }
}

/// 可点击实现：直连 tauri-winrt-notification。为什么不用 notify-rust：其 Windows
/// 后端（windows.rs::show_notification）不渲染 actions、不注册 Activated 处理器，
/// `action()`/`wait_for_action` 均属 XDG/Linux 专属——点击感知必须用 fork 的
/// `add_button` + `on_activated`。
#[cfg(windows)]
fn clickable_toast(app: &AppHandle, msg: &NotifyMessage, name: &'static str) {
    use tauri_winrt_notification::{Scenario, Toast};
    let mut toast = Toast::new(APP_ID)
        .title(&msg.summary)
        .text2(&msg.body)
        // Reminder 场景：toast 预展开并保持显示，直到用户点击/关闭，不自动消失
        // （与 Legacy 样式的 urgency=Critical 映射一致，见 legacy_toast）
        .scenario(Scenario::Reminder);
    if let Some(p) = logo_path(app) {
        toast = toast.image(&p, "");
    }
    if let Some((label, session_id)) = open_button(&msg.session_id) {
        toast = toast.add_button(label, session_id);
    }
    // 注册激活回调（点击「打开对话」→ 恢复窗口 + emit 会话 id 给前端）。
    // `#[cfg(not(test))]`：`on_activated` 的 TypedEventHandler 会把 tauri/tao 的
    // 窗口实现链进测试二进制，本机 Windows 上测试进程在加载期报 0xc0000139
    // （STATUS_ENTRYPOINT_NOT_FOUND，无法启动；与代码正确性无关，桌面应用本体
    // 始终链接全套窗口代码、不受影响）。点击感知需要真实 toast 激活，单测本就
    // 无法覆盖，排除后测试可正常运行。
    #[cfg(not(test))]
    {
        let handle = app.clone();
        toast = toast.on_activated(move |action| {
            // 按钮激活参数 = 会话 id（空串按无会话处理）；正文点击为 None
            let session_id = action.filter(|s| !s.is_empty());
            let _ = handle.emit(dsh::NOTIFY_ACTIVATE_EVENT, ActivatePayload { session_id });
            // 托盘驻留期窗口可能隐藏：点击通知即恢复前台。WinRT 激活事件跑在
            // 非主线程，窗口操作必须转回主线程。回调是 FnMut（可能多次触发），
            // 接收者借用外层 handle、闭包移入独立克隆，避免 move 冲突。
            let main_handle = handle.clone();
            let _ = handle.run_on_main_thread(move || {
                if let Some(window) = main_handle.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            });
            Ok(())
        });
    }
    // 投递不能干扰主流程，但也不能静默失败到无法定位
    // （toast 不出现的常见原因是 AUMID 未注册，见计划的风险清单）
    if let Err(e) = toast.show() {
        eprintln!("[notify] {name} 通道投递失败: {e}");
    }
}

/// 当前启用的投递通道。语音通道（tts.rs）：deliver 只入队不阻塞，
/// toast 照常先弹，语音异步跟上。
static CHANNELS: &[&dyn NotifyChannel] = &[&ToastChannel, &tts::VoiceChannel];

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

/// 自检通知：总开关「关→开」或样式切到「可点击」时补发，让用户立刻看到提醒长什么样。
/// 只走系统通知通道、不 emit：它不是会话事件，没必要让语音通道跟着念一遍。
/// `session_id` 故意给非空占位：可点击样式下「打开对话」按钮会真实渲染出来
/// （两种样式的视觉差异就是按钮）；点它只会恢复窗口——桥在 dsh web 里找不到
/// 「sample」会话，按设计静默降级。legacy 样式（notify-rust）不渲染 actions，不受影响。
pub fn push_sample(app: &AppHandle) {
    let msg = NotifyMessage {
        kind: SAMPLE_KIND,
        session_id: "sample".to_string(),
        session_title: String::new(),
        title: "系统推送",
        desc: "已开启，任务进展会在这里提醒你".into(),
        summary: "系统推送：已开启，任务进展会在这里提醒你".into(),
        body: format!("dsh 会话更新任务清单或结束对话时会弹出这样的通知 · {}", now_hms()),
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

/// 当前本地时间的 `HH:MM:SS`。只拼进 toast 的描述行（`NotifyMessage::body`）：
/// 标题行（summary）与语音字段（title/desc/summary，见 tts.rs 的 `speak_text`）
/// 都不含它——时间只进文字版，不被语音念出来。用 chrono 的 Local 取本机时区。
pub(crate) fn now_hms() -> String {
    chrono::Local::now().format("%H:%M:%S").to_string()
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

    /// 「打开对话」按钮只在有真实会话时挂载，且激活参数就是会话 id
    #[cfg(windows)]
    #[test]
    fn 打开按钮只在有会话时出现() {
        assert_eq!(open_button("session-1"), Some(("打开对话", "session-1")));
        assert_eq!(open_button(""), None);
    }

    /// 旧驻留清理冒烟：WinRT 历史接口在本机可调用（Ok 或可忽略错误均可，
    /// 唯一不许发生的是 panic）；顺带验证 AUMID 与 fork 展示 toast 用的 id 一致
    #[cfg(windows)]
    #[test]
    fn 清理旧驻留通知_不panic() {
        clear_stale_toasts();
        clear_stale_toasts(); // 幂等：重复调用同样安全
    }

    /// 游戏模式判定冒烟：前台窗口 / 显示器枚举在本机可调用（true/false 均合法，
    /// 唯一不许发生的是 panic）。开发机前台多半是编辑器/终端（非全屏），期望
    /// false，但不硬断言——万一测试跑在全屏终端里也不该失败。
    #[cfg(windows)]
    #[test]
    fn 游戏模式判定_不panic() {
        let _ = fullscreen_app_running();
    }
}
