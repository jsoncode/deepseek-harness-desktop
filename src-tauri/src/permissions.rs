//! 内嵌服务的 Web 权限申请（麦克风 / 摄像头 / 剪贴板 / 系统通知 / 地理位置 等）。
//!
//! 背景：wry 的 WebView2 后端只自动放行「剪贴板读取」一种权限（见 wry
//! `webview2/mod.rs` 的 `if attributes.clipboard` 分支），其余权限请求走 WebView2
//! 默认行为——**静默拒绝**，内嵌网页永远申请不到麦克风等高级授权。
//!
//! 本模块给主窗口的 WebView2 补挂 `PermissionRequested` 处理器：任何权限申请都
//! 弹原生「允许 / 拒绝」对话框，由用户现场决定。申请能到达这里的前提由另外两半
//! 保证：Preview.tsx 的 iframe `allow` 属性（跨源权限委托）与 proxy.rs 剥掉上游
//! `Permissions-Policy` 响应头（避免文档层策略把申请拦死）。
//!
//! 平台范围：仅 Windows 需要——macOS 上 wry 的 WKUIDelegate 已自动 Grant 媒体
//! 采集权限（见 wry `wry_web_view_ui_delegate.rs`），Linux 非本应用目标平台。
//! 只注册主窗口：内嵌服务只经 Preview 的 iframe 渲染在主窗口里；tts-studio 等
//! 纯 UI 窗口不承载服务内容，无需处理。

/// 给主窗口 WebView2 注册权限申请处理器。在 setup（主窗口构建完成）后调用一次。
#[cfg(windows)]
pub fn register(app: &tauri::AppHandle) {
    use tauri::Manager;

    let Some(win) = app.get_webview_window("main") else {
        eprintln!("[permissions] 未找到主窗口，跳过权限处理器注册");
        return;
    };
    // with_webview 把闭包派发到主线程执行；注册在页面导航前完成，不会漏申请
    if let Err(e) = win.with_webview(|webview| {
        if let Err(e) = attach_permission_handler(&webview) {
            eprintln!("[permissions] 权限处理器注册失败: {e}");
        }
    }) {
        eprintln!("[permissions] with_webview 派发失败: {e}");
    }
}

/// 非 Windows：无需处理（macOS 由 wry 自动 Grant 媒体权限；Linux 非目标平台）。
#[cfg(not(windows))]
pub fn register(_app: &tauri::AppHandle) {}

/// 挂 `PermissionRequested` 事件：整 webview 生效（含 Preview 的跨源 iframe）。
/// 事件在 UI 线程触发，对话框在处理器内同步弹出（MessageBox 自带模态消息泵，
/// 与浏览器原生权限气泡同形态：页面在此期间等待用户决定）。
#[cfg(windows)]
fn attach_permission_handler(webview: &tauri::webview::PlatformWebview) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2, ICoreWebView2Controller};
    use webview2_com::PermissionRequestedEventHandler;
    use windows::Win32::Foundation::HWND;

    let controller: ICoreWebView2Controller = webview.controller();
    // 同一 windows 0.61 类型域（webview2-com 0.38 与本 crate 的 windows 依赖一致），
    // 宿主窗口的 HWND 可直接传给本模块的 MessageBoxW。
    let core: ICoreWebView2 = unsafe { controller.CoreWebView2() }
        .map_err(|e| format!("CoreWebView2: {e}"))?;
    let mut hwnd = HWND::default();
    unsafe { controller.ParentWindow(&mut hwnd) }.map_err(|e| format!("ParentWindow: {e}"))?;

    let mut token = Default::default();
    unsafe {
        core.add_PermissionRequested(
            &PermissionRequestedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                if let Some(state) = decide_permission(&args, hwnd) {
                    args.SetState(state)?;
                }
                Ok(())
            })),
            &mut token,
        )
        .map_err(|e| format!("add_PermissionRequested: {e}"))?;
    }
    Ok(())
}

/// 单条权限申请的决策。已知/未知权限一律弹「允许 / 拒绝」对话框（需求：所有
/// 申请都要能被用户看到并决定）。若 wry 自带处理器已放行（剪贴板读取），state
/// 已是 ALLOW——直接放行不再弹窗，避免同一条申请打扰两次。
#[cfg(windows)]
fn decide_permission(
    args: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2PermissionRequestedEventArgs,
    hwnd: windows::Win32::Foundation::HWND,
) -> Option<webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PERMISSION_STATE> {
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
        return Some(COREWEBVIEW2_PERMISSION_STATE_DENY);
    }
    let allow = ask_permission(hwnd, &permission_label(kind));
    Some(if allow {
        COREWEBVIEW2_PERMISSION_STATE_ALLOW
    } else {
        COREWEBVIEW2_PERMISSION_STATE_DENY
    })
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

/// 原生「允许 / 拒绝」对话框。父窗口 = WebView2 宿主窗口（模态于本应用）。
#[cfg(windows)]
fn ask_permission(hwnd: windows::Win32::Foundation::HWND, label: &str) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, IDYES, MB_ICONQUESTION, MB_SETFOREGROUND, MB_TOPMOST, MB_YESNO,
    };
    use windows::core::HSTRING;

    let text = HSTRING::from(format!("内嵌网页申请使用「{label}」权限。\n\n是否允许？"));
    let title = HSTRING::from("Web 权限申请");
    let answer = unsafe {
        MessageBoxW(
            Some(hwnd),
            &text,
            &title,
            MB_YESNO | MB_ICONQUESTION | MB_SETFOREGROUND | MB_TOPMOST,
        )
    };
    answer == IDYES
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
