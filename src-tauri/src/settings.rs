use tauri::Manager;

/// 打开设置独立窗口（已开则聚焦）：主窗口各设置入口与托盘菜单共用。
/// 复用同一前端 bundle 经 hash 路由到 /settings；无边框 + 自绘标题栏与主窗口
/// 观感一致（WindowControls 按 getCurrentWindow 对本窗口操作）。
/// section：None → 仅聚焦；Some("logs") 等 → 原地切到目标分区（hash 由前端 HashRouter 消费）。
pub fn open_settings_window(app: &tauri::AppHandle, section: Option<&str>) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        if let Some(s) = section {
            let _ = w.eval(&format!("window.location.hash = '#/settings?section={s}';"));
        }
        return Ok(());
    }
    let url = match section {
        Some(s) => format!("index.html#/settings?section={s}"),
        None => "index.html#/settings".to_string(),
    };
    tauri::WebviewWindowBuilder::new(app, "settings", tauri::WebviewUrl::App(url.into()))
        .title("设置")
        .inner_size(1040.0, 760.0)
        .min_inner_size(880.0, 640.0)
        .decorations(false)
        .center()
        .build()
        .map_err(|e| format!("创建设置窗口失败: {e}"))?;
    Ok(())
}

/// 打开设置独立窗口（已开则聚焦并切到目标分区）：主窗口设置入口统一走此命令
#[tauri::command]
pub async fn open_settings(app: tauri::AppHandle, section: Option<String>) -> Result<(), String> {
    open_settings_window(&app, section.as_deref())
}
