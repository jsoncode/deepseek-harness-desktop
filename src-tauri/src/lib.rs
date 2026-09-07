mod credentials;
mod dsh;
mod logs;
mod notify;
mod permissions;
mod preview;
mod session_events;
mod tts;

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
        // Windows 11 无边框窗口的 Snap Layouts：在自绘标题栏"最大化"按钮上放一个
        // 原生 HTMAXBUTTON 命中区，悬停触发系统磁吸布局预览、点击走原生最大化/还原。
        // 非 Windows / Win10 下为 no-op，其余平台不受影响。
        .plugin(
            tauri_plugin_snap_layout::init()
                .button_id("win-maximize")
                .build(),
        )
        // 语音合成工具窗口的「另存为」系统对话框（tts.rs tts_export_wav 前置）
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            dsh::app_status,
            dsh::check_tool,
            dsh::probe_service,
            dsh::install_dsh,
            dsh::install_env_tool,
            dsh::refresh_search_path,
            dsh::start_dsh_web,
            dsh::stop_dsh_web,
            dsh::open_in_browser,
            dsh::remove_plugin,
            dsh::run_plugin_op,
            dsh::cancel_plugin_op,
            dsh::check_plugin_updates,
            dsh::set_notify_enabled,
            dsh::set_notify_style,
            dsh::http_get_json,
            tts::set_voice_config,
            tts::tts_builtin_voices,
            tts::tts_env_check,
            tts::tts_install_voice_deps,
            tts::tts_speak_test,
            tts::tts_stop_voice_service,
            tts::tts_voice_status,
            tts::tts_open_studio,
            tts::tts_auto_setup,
            tts::tts_clone_repo,
            tts::tts_download_model,
            tts::tts_synthesize,
            tts::tts_play_file,
            tts::tts_export_wav,
            tts::tts_open_path,
            tts::tts_history_list,
            tts::tts_history_delete,
            credentials::check_credentials_compat,
            credentials::fix_credentials,
            logs::log_start_session,
            logs::log_append,
            logs::log_set_status,
            logs::log_sessions,
            logs::log_content,
            logs::log_clear,
            preview::preview_native_supported,
            preview::preview_show,
            preview::preview_resize,
            preview::preview_hide,
            preview::preview_bridge_report,
            preview::preview_open_session,
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
                .build()?;

            // 内嵌服务的 Web 权限申请（麦克风/摄像头/剪贴板等）：wry 只自动放行
            // 剪贴板读取，其余走 WebView2 默认行为（静默拒绝），页面永远申请不到。
            // 补挂 PermissionRequested 处理器，任何申请都弹「允许/拒绝」对话框。
            // 必须在主窗口构建后调用（with_webview 需要已创建的 webview）。
            permissions::register(app.handle());

            // 托盘悬浮提示应用名：优先 tauri.conf.json 的 productName，
            // 回退包名。运行期不变，取一次即可。
            let app_name = app
                .config()
                .product_name
                .clone()
                .unwrap_or_else(|| app.package_info().name.clone());

            let open = MenuItem::with_id(app, "open", "打开", true, None::<&str>)?;
            let browser = MenuItem::with_id(app, "browser", "浏览器中打开", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", quit_label(), true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &browser, &quit])?;

            let mut tray_builder = TrayIconBuilder::with_id("main-tray")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip(tray_tooltip_text(&app_name))
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

            // 收养上次会话遗留的孤儿服务：如安装新版本时安装器强杀了旧应用，
            // dsh web 进程树未被清理、仍占用服务端口，新实例若不接管会导致
            // "停止/重启"静默无效。后台线程执行（netstat 枚举约几十毫秒），
            // 即使此处未完成，start_dsh_web 内也会再做一次同样的收养。
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Some(state) = handle.try_state::<AppState>() {
                    if dsh::adopt_orphan_service(&state) {
                        eprintln!("[setup] 已接管上次遗留的服务实例");
                    }
                }
            });
            // 会话事件 → 系统推送：后台线程订阅服务的下行 WebSocket。
            // 服务未起时线程挂在探活循环里，故不依赖 start/stop 命令的时机。
            session_events::spawn(app.handle().clone());
            // 恢复上次异常退出遗留的活动日志会话（崩溃/强杀）：补写结束时间，
            // 避免历史记录永远显示「进行中」
            logs::finalize_active(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // 主窗口关闭 → 隐藏到托盘，服务继续运行（托盘"退出"才真正退出）；
                // 其他窗口（语音合成工具等独立工具窗口）正常关闭
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<AppState>() {
                    // 退出路径用同步版：async 命令无法在 RunEvent 钩子中 await
                    dsh::stop_dsh_web_sync(&state);
                }
                // 结束当前日志会话（补写 ended_at）
                logs::finalize_active(app_handle);
                // 回收常驻 TTS worker（否则退出后 python 进程继续占用 ~1-2GB 内存）
                tts::shutdown_worker();
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

/// 托盘悬浮提示文案：应用名称；调试构建追加「（调试）」，与托盘菜单
/// 「退出调试」同理——调试/正式实例经 6088/3080 端口隔离可能同时驻留托盘，
/// 见 quit_label。
fn tray_tooltip_text(app_name: &str) -> String {
    if cfg!(debug_assertions) {
        format!("{app_name}（调试）")
    } else {
        app_name.to_string()
    }
}

#[cfg(test)]
mod tray_tooltip_tests {
    use super::tray_tooltip_text;

    const NAME: &str = "DeepSeek Harness Desktop";

    // cargo test 默认 debug 构建，cfg!(debug_assertions) 恒真，故断言带「（调试）」。
    #[test]
    fn 调试构建返回名称加后缀() {
        assert_eq!(tray_tooltip_text(NAME), format!("{NAME}（调试）"));
    }
}
