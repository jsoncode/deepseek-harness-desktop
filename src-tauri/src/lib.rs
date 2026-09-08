mod credentials;
mod dsh;
mod logs;
mod notify;
mod permissions;
mod preview;
mod proxy_config;
mod session_events;
mod settings;
mod tts;

use dsh::AppState;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
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
            settings::open_settings,
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
            tts::tts_open_kokoro_studio,
            tts::tts_auto_setup,
            tts::tts_clone_repo,
            tts::tts_download_model,
            tts::tts_download_kokoro_model,
            tts::tts_clone_kokoro_repo,
            tts::tts_install_kokoro_deps,
            tts::tts_kokoro_voices,
            tts::tts_kokoro_autodetect,
            tts::tts_synthesize,
            tts::tts_play_file,
            tts::tts_export_wav,
            tts::tts_open_path,
            tts::tts_history_list,
            tts::tts_history_delete,
            credentials::check_credentials_compat,
            credentials::fix_credentials,
            proxy_config::get_proxy_config,
            proxy_config::set_proxy_config,
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
            // 启动预热：必须赶在【构建窗口之前】发起。窗口构建（WebView2 环境初始化）
            // 本身要 ~0.8s，前端还要再花 ~1s 加载 bundle 才会调 app_status；把预热
            // 线程提前到这里，等于白得一段并行窗口——实测这样前端首个 app_status
            // 才真正命中快照（放在窗口构建之后发起时，预热还没算完，前端就得等）。
            //
            // 线程内串行做四件事（后一件都依赖前一件，且刻意不并发：三个 where/版本
            // 子进程与 PowerShell/pnpm 同时跑会互相争抢，反而拖慢前端的首个探测）：
            // ①注册表 PATH 刷新（PowerShell 冷启动约 0.4s）→ ②环境快照（where 解析 +
            //   node/pnpm/dsh 版本读取；有磁盘缓存时毫秒级命中，无缓存约 1.5s）→
            // ③乐观启动 dsh web（端口空闲且环境就绪时抢跑，见 dsh::optimistic_start_service）
            //   → ④pnpm 全局 bin 目录（`pnpm bin -g` 约 0.6s，start_dsh_web 注入子进程
            //   PATH 时要用；通常已由缓存播种）。
            // 失败静默：与各步骤原有语义一致，探测不到就退回调用点自己再算一遍。
            // 环境缓存的落盘目录（见 dsh::env_cache）：必须在预热线程之前设置，
            // 否则预热只能退回每次真读（pnpm --version 单次可达 1.9s）
            if let Ok(dir) = app.path().app_data_dir() {
                dsh::init_env_cache_dir(dir);
            }
            let prewarm_handle = app.handle().clone();
            std::thread::spawn(move || {
                // ①毫秒级：磁盘缓存装出环境快照（无缓存时这一步自己真读）
                let needs_refresh = dsh::prewarm_env_snapshot();
                // ②乐观启动：环境快照已就绪且端口空闲时立刻拉起 dsh web，
                // 与前端加载 bundle / 环境检测并行（dsh web 自身要 4~6s 才就绪，
                // 这是「点开应用到能用」的主要成本）。条件不满足则安静退出，
                // 由前端原有启动链接管。
                dsh::optimistic_start_service(&prewarm_handle);
                // ③后台真读校正版本/路径漂移（不阻塞任何调用点）。
                // 刻意延后 10 秒：这一步要跑 where + 三个版本子进程（1~3s，pnpm 的
                // 垫片尤其重），与 dsh web 自身的启动（4~6s，同样吃 CPU）重叠时会
                // 明显拖慢服务就绪（实测重叠时启动多花 1s 以上）。它的产物只用于
                // 「下次启动的缓存」与本次会话的后续刷新，晚几秒没有任何影响。
                if needs_refresh {
                    std::thread::sleep(std::time::Duration::from_secs(10));
                    dsh::refresh_env_snapshot_background();
                }
                // ④pnpm 全局 bin 目录（start_dsh_web 注入子进程 PATH 要用）
                dsh::prewarm_pnpm_global_dirs();
            });

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
            let window = tauri::WebviewWindowBuilder::from_config(app.handle(), &window_cfg)?
                .visible(false)
                .on_new_window(|url, _features| {
                    let _ = dsh::open_url(url.as_str());
                    tauri::webview::NewWindowResponse::Deny
                })
                .build()?;

            // 窗口原生底色：WebView2 首帧（bundle 解析 + React 首次渲染）之前显示的是
            // 窗口背景色，默认纯白——深色用户观感就是「点开先白屏卡一下」。窗口以
            // visible(false) 创建，这里按系统主题（theme() 创建后即可用）设成与应用
            // 底色一致的深浅色，再 show()，配合 index.html 的内联启动画面，打开瞬间
            // 就是品牌底色而非白板。底色设置失败只影响观感，不影响功能。
            if let Ok(theme) = window.theme() {
                let bg = match theme {
                    tauri::Theme::Light => tauri::window::Color(246, 247, 251, 255), // #f6f7fb
                    _ => tauri::window::Color(7, 9, 13, 255),                        // #07090d
                };
                let _ = window.set_background_color(Some(bg));
            }
            // 必须 show()：窗口是按 visible(false) 建的（先定底色再显示），
            // 漏掉这一步应用就没有可见窗口。
            window.show()?;

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
            // 设置直达：主项 + 设置窗口各分区（与设置页左侧菜单一致），点击打开/聚焦独立设置窗口
            let settings = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
            let sec_plugins =
                MenuItem::with_id(app, "sec-plugins", "插件管理", true, None::<&str>)?;
            let sec_notify = MenuItem::with_id(app, "sec-notify", "通知管理", true, None::<&str>)?;
            let sec_theme = MenuItem::with_id(app, "sec-theme", "主题设置", true, None::<&str>)?;
            let sec_proxy = MenuItem::with_id(app, "sec-proxy", "代理设置", true, None::<&str>)?;
            let sec_logs = MenuItem::with_id(app, "sec-logs", "日志管理", true, None::<&str>)?;
            let sec_about = MenuItem::with_id(app, "sec-about", "关于本应用", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", quit_label(), true, None::<&str>)?;
            let sep1 = PredefinedMenuItem::separator(app)?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(
                app,
                &[
                    &open,
                    &browser,
                    &sep1,
                    &settings,
                    &sec_plugins,
                    &sec_notify,
                    &sec_theme,
                    &sec_proxy,
                    &sec_logs,
                    &sec_about,
                    &sep2,
                    &quit,
                ],
            )?;

            let mut tray_builder = TrayIconBuilder::with_id("main-tray")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip(tray_tooltip_text(&app_name))
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main_window(app),
                    "browser" => open_service_in_browser(app),
                    "quit" => app.exit(0),
                    id => {
                        if let Some(section) = tray_settings_section(id) {
                            if let Err(e) = settings::open_settings_window(app, section) {
                                eprintln!("[tray] 打开设置窗口失败: {e}");
                            }
                        }
                    }
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
            // 启动预热已在上方（窗口构建之前）发起，见那段注释
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

/// 恢复主窗口到前台（托盘"打开"、左键单击、单实例回调共用）。
///
/// 顺序必须是 show → unminimize → set_focus：窗口被 hide() 收起时若仍带最小化
/// 状态，先 unminimize 在隐藏窗口上是空操作，随后 show() 会把它按最小化态显示出来
/// （表现为"点了托盘只闪一下任务栏，窗口不出现"）。
///
/// 仅靠这三步在 Windows 上仍可能不置顶：前台锁（foreground lock）规定只有"当前
/// 前台进程"才能抢焦点，托盘点击的输入落在 explorer.exe 上，`SetForegroundWindow`
/// 会被静默忽略——窗口其实已显示，却仍被别的窗口盖住，用户观感就是"点托盘没反应"。
/// [`raise_to_front`] 用不依赖前台权限的 z 序手段兜底。
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        raise_to_front(&window);
    }
}

/// Windows：把已显示的窗口抬到 z 序最前。
/// 置顶→取消置顶两次 `SetWindowPos` 不需要前台权限就能改变 z 序（TOPMOST 窗口必然
/// 位于所有非 TOPMOST 窗口之上，取消置顶后停在同层最前），因此比单独调用
/// `SetForegroundWindow` 可靠；最小化时先 `SW_RESTORE` 真正还原。
#[cfg(windows)]
fn raise_to_front(window: &tauri::WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, IsIconic, SetForegroundWindow, SetWindowPos, ShowWindow, HWND_NOTOPMOST,
        HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SW_RESTORE,
    };

    let Ok(hwnd) = window.hwnd() else { return };
    unsafe {
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        let flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE;
        let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, flags);
        let _ = SetWindowPos(hwnd, Some(HWND_NOTOPMOST), 0, 0, 0, 0, flags);
        let _ = BringWindowToTop(hwnd);
        let _ = SetForegroundWindow(hwnd);
    }
}

/// 非 Windows：`show` + `unminimize` + `set_focus` 已足够（无前台锁机制）。
#[cfg(not(windows))]
fn raise_to_front(_window: &tauri::WebviewWindow) {}

/// 托盘菜单 id → 设置窗口分区（外层 None = 非设置类菜单；内层 None = 设置主分区，
/// 不指定具体页签——仅聚焦，不重置用户当前所在分区）
fn tray_settings_section(id: &str) -> Option<Option<&'static str>> {
    match id {
        "settings" => Some(None),
        "sec-plugins" => Some(Some("plugins")),
        "sec-notify" => Some(Some("notify")),
        "sec-theme" => Some(Some("theme")),
        "sec-proxy" => Some(Some("proxy")),
        "sec-logs" => Some(Some("logs")),
        "sec-about" => Some(Some("about")),
        _ => None,
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
    use super::{tray_settings_section, tray_tooltip_text};

    const NAME: &str = "DeepSeek Harness Desktop";

    // cargo test 默认 debug 构建，cfg!(debug_assertions) 恒真，故断言带「（调试）」。
    #[test]
    fn 调试构建返回名称加后缀() {
        assert_eq!(tray_tooltip_text(NAME), format!("{NAME}（调试）"));
    }

    #[test]
    fn 托盘设置分区映射到设置窗口分区() {
        assert_eq!(tray_settings_section("settings"), Some(None));
        assert_eq!(tray_settings_section("sec-plugins"), Some(Some("plugins")));
        assert_eq!(tray_settings_section("sec-about"), Some(Some("about")));
        assert_eq!(tray_settings_section("quit"), None);
        assert_eq!(tray_settings_section("open"), None);
    }
}
