mod dsh;

use dsh::AppState;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, RunEvent, WindowEvent,
};

/// 注入到 webview 所有 frame（含预览 iframe）的桥接脚本：
/// 拦截 iframe 内 target=_blank / 跨源外链的点击，preventDefault 后 postMessage
/// 给主框架，由前端调用 open_in_browser 用系统默认浏览器打开。
///
/// 为什么需要它：Windows 上 wry 的 new-window 处理（NewWindowRequested）不会为
/// iframe 内发起的 target=_blank 请求触发（tauri-apps/wry#1593），on_new_window
/// 只能兜住主框架自身的外链；iframe 里的外链必须由注入脚本主动拦截。
/// WebView2 的 AddScriptToExecuteOnDocumentCreated 对所有子 frame 生效，
/// 且注入脚本早于页面脚本执行，用捕获阶段监听可先于应用自身的点击处理。
const EXTERNAL_LINK_BRIDGE: &str = r##"
(() => {
  // 只处理子框架（主框架自身的外链由 on_new_window 兜底，跳过避免重复处理）
  if (window.top === window) return;
  if (window.__dshLinkBridgeInstalled) return;
  try {
    Object.defineProperty(window, "__dshLinkBridgeInstalled", { value: true });
  } catch { /* 忽略 */ }
  const post = (url) => {
    try {
      window.parent.postMessage({ "dsh-desktop:open-url": true, url }, "*");
    } catch { /* 跨源 postMessage 失败的概率极低，忽略 */ }
  };
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const el = e.target;
    const a = el && el.closest ? el.closest("a[href]") : null;
    if (!a) return;
    if (a.hasAttribute("download")) return; // 下载链接放行
    const href = a.getAttribute("href") || "";
    if (!href || href.startsWith("#") || href.startsWith("javascript:")) return;
    let url;
    try { url = new URL(href, window.location.href); } catch { return; }
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    const target = (a.target || "").toLowerCase();
    const isBlank = target.includes("_blank");
    const isCrossOrigin = url.origin !== window.location.origin;
    if (!isBlank && !isCrossOrigin) return; // 站内普通链接：留在 iframe 内正常导航
    e.preventDefault();
    e.stopPropagation();
    post(url.href);
  }, true);
})();
"##;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        // Windows 11 无边框窗口的 Snap Layouts：在自绘标题栏"最大化"按钮上放一个
        // 原生 HTMAXBUTTON 命中区，悬停触发系统磁吸布局预览、点击走原生最大化/还原。
        // 非 Windows / Win10 下为 no-op，其余平台不受影响。
        .plugin(
            tauri_plugin_snap_layout::init()
                .button_id("win-maximize")
                .build(),
        )
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            dsh::app_status,
            dsh::probe_service,
            dsh::install_dsh,
            dsh::start_dsh_web,
            dsh::stop_dsh_web,
            dsh::open_in_browser,
            dsh::remove_plugin,
            dsh::install_plugins,
        ])
        .setup(|app| {
            // 主窗口改为 setup 内手动构建（tauri.conf.json 中 create:false）：
            // 注册 on_new_window，把页面内 target=_blank / window.open 的外链请求
            // 转交系统默认浏览器打开（wry 默认会静默吞掉新窗口请求，外链点击无反应）。
            let window_cfg = app
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == "main")
                .cloned()
                .expect("tauri.conf.json must declare the main window");
            tauri::WebviewWindowBuilder::from_config(app.handle(), &window_cfg)?
                .on_new_window(|url, _features| {
                    let _ = dsh::open_url(url.as_str());
                    tauri::webview::NewWindowResponse::Deny
                })
                // 注入到 webview 的所有 frame（含预览 iframe）。Windows 上 wry 的
                // on_new_window 不会为 iframe 内 target=_blank 的请求触发（见 tauri-apps/wry#1593），
                // 因此必须由注入脚本在 iframe 内拦截外链点击，postMessage 交给主框架
                // 走 open_in_browser 命令用系统浏览器打开。
                .initialization_script_for_all_frames(EXTERNAL_LINK_BRIDGE)
                .build()?;

            let open = MenuItem::with_id(app, "open", "打开", true, None::<&str>)?;
            let browser = MenuItem::with_id(app, "browser", "浏览器中打开", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", quit_label(), true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &browser, &quit])?;

            let mut tray_builder = TrayIconBuilder::with_id("main-tray")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main_window(app),
                    "browser" => open_service_in_browser(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray_builder = tray_builder.icon(icon.clone());
            }
            tray_builder.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // 关闭窗口 → 隐藏到托盘，服务继续运行（托盘"退出"才真正退出）
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<AppState>() {
                    dsh::stop_dsh_web(state);
                }
            }
        });
}

/// 托盘"退出"菜单文案：调试构建（tauri dev / debug）显示"退出调试"，
/// 与正式版"退出"区分——两者通过 6088/3080 端口完全隔离（见 dsh::service_port），
/// 避免调试时误以为退出的是正式版服务。
fn quit_label() -> &'static str {
    if cfg!(debug_assertions) {
        "退出调试"
    } else {
        "退出"
    }
}

/// 恢复主窗口到前台（托盘"打开"、左键单击、单实例回调共用）
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// 托盘"浏览器中打开"：读取已探测到的服务 URL 并在默认浏览器打开
fn open_service_in_browser(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        let url = state.detected_url.lock().unwrap().clone();
        if let Some(url) = url {
            // 打开前探活：服务崩溃/停止时不打开死链
            if !dsh::probe_url(&url, 400) {
                return;
            }
            if let Err(e) = dsh::open_url(&url) {
                eprintln!("[tray] 打开浏览器失败: {e}");
            }
        }
    }
}
