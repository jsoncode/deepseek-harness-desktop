//! 内嵌服务的 Web 权限申请（麦克风 / 摄像头 / 剪贴板 / 系统通知 / 地理位置 / 文件读写 等）。
//!
//! 背景：wry 的 WebView2 后端只自动放行「剪贴板读取」一种权限（见 wry
//! `webview2/mod.rs` 的 `if attributes.clipboard` 分支），其余权限请求走 WebView2
//! 默认行为——**静默拒绝**，内嵌网页永远申请不到麦克风等高级授权。
//!
//! 本模块给承载宿主页的 WebView2 补挂 `PermissionRequested` 处理器：任何权限申请
//! 都弹原生「允许 / 拒绝」对话框，由用户现场决定。申请能到达 WebView2 的前提由
//! Preview.tsx 的 iframe `allow` 属性（浏览器回退路径的跨源权限委托）保证；原生子
//! webview 路径（preview.rs）下宿主页是顶层文档，不存在文档层权限委托的问题。
//!
//! # 本回调里绝不能同步等待用户
//!
//! `PermissionRequested` 在**主线程**（WebView2 控制器所属的 UI 线程）派发。曾经在此
//! 同步弹 `MessageBoxW`，后果是把主线程钉死在一个嵌套模态消息泵里：
//!
//! - WebView2 的合成与浏览器进程 IPC 一并饿死 → 子 webview 停止呈现（画面发黑）、
//!   窗口不再响应，即「点宿主页里的文件/链接把电脑搞到黑屏卡死」；
//! - 托盘图标事件同样在主线程派发 → 点托盘毫无反应，只能重启应用；
//! - 申请发生在主窗口隐藏/非前台时（例如从托盘恢复期间页面重跑），Windows 前台锁会让
//!   `MB_SETFOREGROUND` 失效，对话框根本不出现，主线程就永久挂在一个用户看不见的
//!   模态框上——这是最恶劣的一种，症状与「应用彻底死掉」无法区分。
//!
//! 现在的做法：回调内只取 `GetDeferral()` 把申请挂起（不阻塞，WebView2 就是为此提供
//! deferral 的），弹窗交给异步原生对话框（plugin-dialog，与前端 `nativeConfirm` 同一套），
//! 用户决定后经 `run_on_main_thread` 回主线程写 `SetState` + `Complete`。主线程全程不阻塞。
//!
//! COM 句柄（args / deferral）内部是裸指针、**非 `Send`**，无法移进对话框回调线程；
//! 而 WebView2 回调与 `run_on_main_thread` 闭包都在主线程执行，故待决申请存在
//! `thread_local` 槽位表里，跨线程只传 `usize` 索引。
//!
//! 平台范围：仅 Windows 需要——macOS 上 wry 的 WKUIDelegate 已自动 Grant 媒体
//! 采集权限（见 wry `wry_web_view_ui_delegate.rs`），Linux 非本应用目标平台。
//! 注册点：主窗口（setup 后 `register`，覆盖浏览器回退 iframe）与 preview 子
//! webview（preview.rs 创建后 `attach_platform`）。tts-studio / settings 等纯 UI
//! 窗口不承载服务内容，无需处理。

/// 给主窗口 WebView2 注册权限申请处理器。在 setup（主窗口构建完成）后调用一次。
#[cfg(windows)]
pub fn register(app: &tauri::AppHandle) {
    use tauri::Manager;

    let Some(win) = app.get_webview_window("main") else {
        eprintln!("[permissions] 未找到主窗口，跳过权限处理器注册");
        return;
    };
    // with_webview 把闭包派发到主线程执行；注册在页面导航前完成，不会漏申请
    let handle = app.clone();
    if let Err(e) = win.with_webview(move |webview| {
        if let Err(e) = attach_permission_handler(&handle, &webview) {
            eprintln!("[permissions] 权限处理器注册失败: {e}");
        }
    }) {
        eprintln!("[permissions] with_webview 派发失败: {e}");
    }
}

/// 非 Windows：无需处理（macOS 由 wry 自动 Grant 媒体权限；Linux 非目标平台）。
#[cfg(not(windows))]
pub fn register(_app: &tauri::AppHandle) {}

/// 给任意已创建的 webview（主窗口或 preview 子 webview）挂权限申请处理器。
/// 仅 Windows 有实现；其他平台为 no-op（调用方无需再判平台）。
#[cfg(windows)]
pub fn attach_platform(
    app: &tauri::AppHandle,
    webview: &tauri::webview::PlatformWebview,
) -> Result<(), String> {
    attach_permission_handler(app, webview)
}

#[cfg(windows)]
type PermissionArgs =
    webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2PermissionRequestedEventArgs;

#[cfg(windows)]
type PermissionDeferral = webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Deferral;

/// 一条已挂起、等待用户决定的权限申请。仅主线程读写（理由见模块注释）。
#[cfg(windows)]
struct PendingRequest {
    args: PermissionArgs,
    deferral: PermissionDeferral,
}

#[cfg(windows)]
thread_local! {
    /// 待决申请槽位表：索引即跨线程传递的凭据，决定落地后槽位置空供复用
    static PENDING: std::cell::RefCell<Vec<Option<PendingRequest>>> =
        const { std::cell::RefCell::new(Vec::new()) };
}

/// 挂 `PermissionRequested` 事件：整 webview 生效（含 Preview 的跨源 iframe）。
#[cfg(windows)]
fn attach_permission_handler(
    app: &tauri::AppHandle,
    webview: &tauri::webview::PlatformWebview,
) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2;
    use webview2_com::PermissionRequestedEventHandler;

    let controller = webview.controller();
    let core: ICoreWebView2 =
        unsafe { controller.CoreWebView2() }.map_err(|e| format!("CoreWebView2: {e}"))?;

    let handle = app.clone();
    let mut token = Default::default();
    unsafe {
        core.add_PermissionRequested(
            &PermissionRequestedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let Some(label) = permission_to_ask(&args) else {
                    return Ok(());
                };
                defer_and_ask(&handle, args, &label)
            })),
            &mut token,
        )
        .map_err(|e| format!("add_PermissionRequested: {e}"))?;
    }
    Ok(())
}

/// 单条权限申请的预处理：返回需要询问用户的权限标签。
/// 已知/未知权限一律要问（需求：所有申请都要能被用户看到并决定）。
/// `None` = 不必弹窗——wry 自带处理器已放行（剪贴板读取，state 已是 ALLOW，
/// 再问一次等于同一条申请打扰两遍），或读不出权限类型（已就地拒绝）。
#[cfg(windows)]
fn permission_to_ask(args: &PermissionArgs) -> Option<String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_STATE,
        COREWEBVIEW2_PERMISSION_STATE_ALLOW, COREWEBVIEW2_PERMISSION_STATE_DENY,
    };

    let mut state = COREWEBVIEW2_PERMISSION_STATE::default();
    if unsafe { args.State(&mut state) }.is_ok() && state == COREWEBVIEW2_PERMISSION_STATE_ALLOW {
        return None;
    }

    let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
    if let Err(e) = unsafe { args.PermissionKind(&mut kind) } {
        eprintln!("[permissions] 读取权限类型失败: {e}");
        let _ = unsafe { args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY) };
        return None;
    }
    Some(permission_label(kind))
}

/// 挂起申请（deferral）并弹异步对话框。本函数在主线程上执行且**立即返回**——
/// 用户的决定稍后由 [`resolve_pending`] 在主线程落地。
#[cfg(windows)]
fn defer_and_ask(
    app: &tauri::AppHandle,
    args: PermissionArgs,
    label: &str,
) -> windows::core::Result<()> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PERMISSION_STATE_DENY;

    let Ok(deferral) = (unsafe { args.GetDeferral() }) else {
        // 拿不到 deferral 就无法把决定推迟到弹窗之后：就地拒绝，绝不退回同步弹窗
        eprintln!("[permissions] GetDeferral 失败，直接拒绝本次权限申请");
        let _ = unsafe { args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY) };
        return Ok(());
    };

    let index = PENDING.with(|slots| {
        let mut slots = slots.borrow_mut();
        let req = PendingRequest { args, deferral };
        match slots.iter_mut().position(|slot| slot.is_none()) {
            Some(i) => {
                slots[i] = Some(req);
                i
            }
            None => {
                slots.push(Some(req));
                slots.len() - 1
            }
        }
    });

    // 不设 parent：模态父窗口会被禁用，而申请可能来自主窗口隐藏期间（见模块注释），
    // 那会变成「看不见的原因把整个窗口锁住」。无主对话框只挂起这一条权限申请。
    let owner = app.clone();
    app.dialog()
        .message(format!("内嵌网页申请使用「{label}」权限。\n\n是否允许？"))
        .title("Web 权限申请")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::YesNo)
        .show(move |allow| {
            // 回调在 rfd 的对话框线程上，SetState/Complete 必须回主线程执行
            let _ = owner.run_on_main_thread(move || resolve_pending(index, allow));
        });
    Ok(())
}

/// 主线程执行：把用户决定写回 WebView2 并完成 deferral，释放挂起的申请。
#[cfg(windows)]
fn resolve_pending(index: usize, allow: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PERMISSION_STATE_ALLOW, COREWEBVIEW2_PERMISSION_STATE_DENY,
    };

    let taken = PENDING.with(|slots| slots.borrow_mut().get_mut(index).and_then(Option::take));
    let Some(req) = taken else { return };
    let state = if allow {
        COREWEBVIEW2_PERMISSION_STATE_ALLOW
    } else {
        COREWEBVIEW2_PERMISSION_STATE_DENY
    };
    if let Err(e) = unsafe { req.args.SetState(state) } {
        eprintln!("[permissions] 写回权限决定失败: {e}");
    }
    if let Err(e) = unsafe { req.deferral.Complete() } {
        eprintln!("[permissions] 完成 deferral 失败: {e}");
    }
}

/// WebView2 权限类型 → 中文标签（未知类型给通用文案，同样弹窗）。
#[cfg(windows)]
fn permission_label(
    kind: webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PERMISSION_KIND,
) -> String {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    match kind {
        COREWEBVIEW2_PERMISSION_KIND_MICROPHONE => "麦克风",
        COREWEBVIEW2_PERMISSION_KIND_CAMERA => "摄像头",
        COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ => "剪贴板（读取）",
        // 注意：webview2-com-sys 0.38 的枚举没有 CLIPBOARD_WRITE 常量——match 里
        // 写不存在的常量名会被当成「绑定」吞掉后面所有分支（编译只给 warning），
        // 剪贴板写入落到兜底「未识别的权限」即可。
        COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION => "地理位置",
        COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS => "系统通知",
        COREWEBVIEW2_PERMISSION_KIND_MIDI_SYSTEM_EXCLUSIVE_MESSAGES => "MIDI 设备（SysEx）",
        COREWEBVIEW2_PERMISSION_KIND_MULTIPLE_AUTOMATIC_DOWNLOADS => "自动下载多个文件",
        COREWEBVIEW2_PERMISSION_KIND_LOCAL_FONTS => "本机字体",
        COREWEBVIEW2_PERMISSION_KIND_OTHER_SENSORS => "运动等传感器",
        COREWEBVIEW2_PERMISSION_KIND_WINDOW_MANAGEMENT => "窗口管理",
        COREWEBVIEW2_PERMISSION_KIND_FILE_READ_WRITE => "文件读写",
        COREWEBVIEW2_PERMISSION_KIND_AUTOPLAY => "自动播放",
        _ => "未识别的权限",
    }
    .to_string()
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    /// 标签映射：已知类型给中文、未知类型有兜底文案（弹窗内容不落空）。
    #[test]
    fn 权限类型中文标签() {
        use webview2_com::Microsoft::Web::WebView2::Win32::*;
        assert_eq!(
            permission_label(COREWEBVIEW2_PERMISSION_KIND_MICROPHONE),
            "麦克风"
        );
        assert_eq!(
            permission_label(COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ),
            "剪贴板（读取）"
        );
        assert_eq!(
            permission_label(COREWEBVIEW2_PERMISSION_KIND_UNKNOWN_PERMISSION),
            "未识别的权限"
        );
    }
}
