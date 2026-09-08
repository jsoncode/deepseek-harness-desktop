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
    // 窗口宽度按「插件管理」表格的最小宽度反推：antd Table 的 scroll.x = 820
    // （列宽 48 + 440 + 110 + 98 + 124），而表格容器可用宽度 =
    //   窗口内宽 − 设置页内边距(16×2) − 左侧菜单(190 + 边框 2) − 间距 14
    //            − 内容区边框 2 − 内容区 padding(18×2)
    //   = 窗口内宽 − 274（纵向滚动条出现时再 −10）
    // 故窗口内宽需 ≥ 1104 才不出现横向滚动条；取 1140 留出余量（字号/滚动条差异）。
    // 高度沿用 760：列表本身在面板内滚动，加宽即可消除横向滚动条。
    tauri::WebviewWindowBuilder::new(app, "settings", tauri::WebviewUrl::App(url.into()))
        .title("设置")
        .inner_size(1140.0, 760.0)
        .min_inner_size(1024.0, 640.0)
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
