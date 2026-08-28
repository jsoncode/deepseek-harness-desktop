mod credentials;
mod dsh;
mod logs;
mod notify;
mod session_events;

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

/// 注入到 webview 所有 frame 的插件加载失败监听脚本：
/// dsh web 前端在插件 bundle 加载/注册失败时会在页面渲染
/// `Failed to load plugins` 失败界面（failedTitle 标题 + failedItem 错误项），
/// 且不会向宿主推送任何事件（调研结论：boot 失败仅 console.error + 渲染 DOM）。
/// 本脚本在 iframe 内用 MutationObserver 监听该界面，检测到后把错误项
/// postMessage 给主框架，由前端弹框提示"移除插件并重启"。
///
/// 为什么用注入脚本而非前端直读 iframe DOM：预览 iframe 是跨源页面
/// （http://127.0.0.1:3080 vs 桌面壳 tauri://localhost），前端受同源策略
/// 限制无法访问 iframe 内部 DOM；WebView2 的
/// AddScriptToExecuteOnDocumentCreated 对所有子 frame 生效，注入脚本在
/// iframe 内部执行，不受跨源限制。
const PLUGIN_FAILURE_BRIDGE: &str = r##"
(() => {
  if (window.top === window) return; // 只处理预览 iframe（子框架）
  if (window.__dshPluginFailureBridgeInstalled) return;
  try {
    Object.defineProperty(window, "__dshPluginFailureBridgeInstalled", { value: true });
  } catch { /* 忽略 */ }
  let reported = false; // 同一次页面生命周期内只上报一次，避免反复弹框
  const post = (items) => {
    try {
      window.parent.postMessage({ "dsh-desktop:plugin-failed": true, items }, "*");
    } catch { /* 跨源 postMessage 失败的概率极低，忽略 */ }
  };
  const check = () => {
    if (reported) return;
    const title = document.querySelector('[class*="failedTitle"]');
    if (!title) return;
    const text = (title.textContent || "").trim();
    if (!text.includes("Failed to load plugins")) return;
    const items = Array.from(document.querySelectorAll('[class*="failedItem"]'))
      .map((el) => (el.textContent || "").trim())
      .filter(Boolean);
    if (items.length === 0) return;
    reported = true;
    post(items);
  };
  const watch = () => {
    check();
    const mo = new MutationObserver(check);
    mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", watch, { once: true });
  } else {
    watch();
  }
})();
"##;

/// 注入到 webview 所有 frame 的主题同步监听脚本：
/// dsh web 前端切换主题时不推送任何事件（调研结论：仅 Cordis 内部
/// `theme/change` + presenter 写 DOM），但会反映在 iframe 的 DOM 上：
/// ui-layout 的 ThemePresenter 在暗色时给 `body` 设置
/// `data-ds-dark-theme` 属性、亮色时移除，并更新 `html` 的 color-scheme。
/// 本脚本在 iframe 内用 MutationObserver 监听该属性变化，把当前主题
/// postMessage 给主框架，由前端跟随宿主主题（壳主题设为"跟随宿主"时）。
///
/// 与 EXTERNAL_LINK_BRIDGE / PLUGIN_FAILURE_BRIDGE 同理：预览 iframe 是
/// 跨源页面，前端受同源策略无法直读其 DOM，必须由注入脚本在 iframe
/// 内部观察并经 postMessage 上报。
const THEME_SYNC_BRIDGE: &str = r##"
(() => {
  // 只处理预览 iframe（子框架）；主框架与 iframe 内的更深层子 frame 跳过
  if (window.top === window) return;
  if (window.parent !== window.top) return;
  if (window.__dshThemeBridgeInstalled) return;
  try {
    Object.defineProperty(window, "__dshThemeBridgeInstalled", { value: true });
  } catch { /* 忽略 */ }
  const post = (dark) => {
    try {
      window.parent.postMessage({ "dsh-desktop:theme-change": true, dark }, "*");
    } catch { /* 跨源 postMessage 失败的概率极低，忽略 */ }
  };
  const report = () => {
    const dark = document.body ? document.body.hasAttribute("data-ds-dark-theme") : false;
    post(dark);
  };
  const watch = () => {
    report();
    if (!document.body) return;
    const mo = new MutationObserver(report);
    mo.observe(document.body, { attributes: true, attributeFilter: ["data-ds-dark-theme"] });
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", watch, { once: true });
  } else {
    watch();
  }
})();
"##;

/// 注入到 webview 所有 frame 的「打开会话」监听脚本：
/// 用户点击系统通知后，桌面壳把会话 id postMessage 给预览 iframe，本脚本在
/// iframe 内定位该会话的行并模拟点击，触发 dsh web 前端的 `sessions.open(id)`
/// ——工作区即切到该会话的对话框。
///
/// 为什么必须注入脚本：预览 iframe 是跨源页面（http://127.0.0.1:3080 vs
/// tauri://localhost），前端受同源策略无法访问 iframe 内部 DOM；且调研结论是
/// dsh web 前端不暴露任何外部入口（无 URL 深链、无 window 控制钩子、会话行 DOM
/// 不含会话 id，见 docs/superpowers/specs/2026-08-28-notify-click-open-design.md），
/// 只能在 iframe 内部读 React fiber 拿行对应的 sessionId 再模拟点击。
///
/// 2026-08-29 实测修复（多工作区场景）：目标会话所在工作区分组**折叠**时，
/// 该会话行不在 DOM 里（`deriveGroups` 对折叠组输出空 sessions），直接轮询找不到
/// 行、点击无果，窗口恢复后停留在最后会话。修复：从任意行沿 fiber 链上溯到
/// SessionTree 取 `workspaces`（会话 → 工作区映射），找到目标会话所在工作区，
/// 点击其组头展开，再继续轮询定位行；已展开但目标在「展开其余 N 个会话」折叠
/// 行之后时，点击该组的溢出展开按钮。另：超时提升到 20s（覆盖托盘隐藏期间
/// WebView2 可能丢弃页面、恢复时 dsh 冷启动的耗时），成功后向壳回传 ACK。
const SESSION_OPEN_BRIDGE: &str = r##"
(() => {
  if (window.top === window) return;         // 只处理预览 iframe（子框架）
  if (window.parent !== window.top) return;  // 只要直接子框架
  if (window.__dshSessionOpenBridgeInstalled) return;
  try {
    Object.defineProperty(window, "__dshSessionOpenBridgeInstalled", { value: true });
  } catch { /* 忽略 */ }
  const MSG = "dsh-desktop:open-session";
  const ACK = "dsh-desktop:session-open-acked";
  const MAX_WAIT_MS = 20000; // 行渲染异步（会话列表就绪 + React 提交，可能含冷启动）
  const TICK_MS = 200;
  const MAX_FIBER_DEPTH = 12;
  const MAX_PARENT_DEPTH = 40;
  let revealed = false; // 组展开/溢出按钮只尝试一次（幂等）

  const fiberOf = (el) => {
    const key = Object.keys(el).find((k) => k.startsWith("__reactFiber"));
    return key ? el[key] : undefined;
  };

  // 从行元素沿 React fiber 向上找携带 sessionId 的 props：dsh 会话行
  // （SessionNodeItem）的 props.node.id 即会话 id，但 DOM 上并未暴露它。
  // 工作区行 / 搜索结果行的 props 里没有 node.id，会自然跳过。
  const sessionIdOf = (el) => {
    let fiber = fiberOf(el);
    for (let depth = 0; fiber !== null && depth < MAX_FIBER_DEPTH; depth++, fiber = fiber.return) {
      const node = fiber.memoizedProps && fiber.memoizedProps.node;
      if (node !== null && node !== undefined && typeof node.id === "string") return node.id;
    }
    return undefined;
  };

  // 行元素 → 所在工作区分组（ProjectRowItem 的 props.group；未分组桶无 workspaceId，返回 undefined）
  const groupOf = (el) => {
    let fiber = fiberOf(el);
    for (let depth = 0; fiber !== null && depth < MAX_FIBER_DEPTH; depth++, fiber = fiber.return) {
      const g = fiber.memoizedProps && fiber.memoizedProps.group;
      if (g !== null && g !== undefined && g.workspaceId && typeof g.label === "string") return g;
    }
    return undefined;
  };

  // 从任意行/组头沿 fiber 链上溯，取 SessionTree 的 workspaces（会话 → 工作区映射）
  const workspacesOf = (el) => {
    let fiber = fiberOf(el);
    for (let depth = 0; fiber !== null && depth < MAX_PARENT_DEPTH; depth++, fiber = fiber.return) {
      const p = fiber.memoizedProps;
      if (p !== null && p !== undefined && Array.isArray(p.workspaces) && p.workspaces.length > 0) {
        return p.workspaces;
      }
    }
    return undefined;
  };

  // 标题兜底：fiber 结构随 React 升级可能变化，读不到 id 时按标题文本匹配。
  const rowTitle = (el) => {
    const t = el.querySelector && el.querySelector('[class*="title"]');
    return t ? (t.textContent || "").trim() : (el.textContent || "").trim();
  };

  const rows = () => Array.from(document.querySelectorAll('[role="treeitem"]'));

  // 目标会话行不在 DOM（其工作区分组折叠，或组已展开但目标在
  // 「展开其余 N 个会话」折叠行之后）：先把它所在的组展开/溢出按钮点开。
  const attemptReveal = (sessionId) => {
    if (revealed) return;
    revealed = true;
    const any = rows()[0];
    if (!any) return;
    const workspaces = workspacesOf(any);
    if (!workspaces) return;
    const ws = workspaces.find((w) => w.sessionIds.includes(sessionId));
    if (!ws) return;
    const header = rows().find((el) => {
      const g = groupOf(el);
      return g !== undefined && g.workspaceId === ws.workspaceId;
    });
    if (!header) return;
    const g = groupOf(header);
    if (g && !g.expanded) {
      header.click(); // 折叠 → 点组头展开（onToggle → setGroupExpanded）
      return;
    }
    // 组已展开但目标仍不可见：点该组的「展开其余 N 个会话」按钮
    // （section 的直接 button 子元素；组头自己的图标按钮在其内部、无文本）
    let section = header.parentElement;
    while (section !== null && section !== document.body) {
      const overflow = Array.from(section.querySelectorAll(':scope > button'))
        .find((b) => /展开|更多|show|more|expand/i.test((b.textContent || "").trim()));
      if (overflow !== undefined) { overflow.click(); return; }
      section = section.parentElement;
    }
  };

  const openSession = (sessionId, sessionTitle) => {
    const started = Date.now();
    const tick = () => {
      let target = null;
      for (const el of rows()) {
        if (sessionIdOf(el) === sessionId) { target = el; break; }
      }
      if (target === null && sessionTitle) {
        for (const el of rows()) {
          if (rowTitle(el) === sessionTitle) { target = el; break; }
        }
      }
      if (target !== null) {
        target.click(); // 命中行 → 触发 onOpen(id) → sessions.open → 打开该会话对话框
        try { window.parent.postMessage({ [ACK]: true }, "*"); } catch { /* 忽略 */ }
        return;
      }
      if (!revealed && Date.now() - started < 2000) attemptReveal(sessionId);
      if (Date.now() - started < MAX_WAIT_MS) setTimeout(tick, TICK_MS);
      // 超时未找到（rail 图标态等极端场景）：优雅降级，只保留窗口聚焦，不打扰用户
    };
    tick();
  };

  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || typeof d !== "object") return;
    if (d[MSG] !== true || typeof d.sessionId !== "string" || d.sessionId === "") return;
    openSession(d.sessionId, typeof d.sessionTitle === "string" ? d.sessionTitle : "");
  });
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
            dsh::install_env_tool,
            dsh::refresh_search_path,
            dsh::start_dsh_web,
            dsh::stop_dsh_web,
            dsh::open_in_browser,
            dsh::remove_plugin,
            dsh::install_plugins,
            dsh::run_plugin_op,
            dsh::cancel_plugin_op,
            dsh::check_plugin_updates,
            dsh::set_notify_enabled,
            dsh::set_notify_style,
            dsh::http_get_json,
            credentials::check_credentials_compat,
            credentials::fix_credentials,
            logs::log_start_session,
            logs::log_append,
            logs::log_set_status,
            logs::log_sessions,
            logs::log_content,
            logs::log_clear,
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
                .initialization_script_for_all_frames(PLUGIN_FAILURE_BRIDGE)
                .initialization_script_for_all_frames(THEME_SYNC_BRIDGE)
                .initialization_script_for_all_frames(SESSION_OPEN_BRIDGE)
                .build()?;

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
                    // 退出路径用同步版：async 命令无法在 RunEvent 钩子中 await
                    dsh::stop_dsh_web_sync(&state);
                }
                // 结束当前日志会话（补写 ended_at）
                logs::finalize_active(app_handle);
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
