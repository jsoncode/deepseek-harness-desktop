mod dsh;

use dsh::AppState;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, RunEvent, WindowEvent,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            dsh::app_status,
            dsh::probe_service,
            dsh::install_dsh,
            dsh::start_dsh_web,
            dsh::stop_dsh_web,
            dsh::open_in_browser,
        ])
        .setup(|app| {
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
