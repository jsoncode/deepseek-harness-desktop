//! 原生预览子 webview：把宿主（dsh web）页面作为「顶层文档」放进与桌面壳同窗口的
//! 子 webview，位置精确对齐内容区（顶栏之下、底栏之上），桌面壳的顶栏/底栏等
//! DOM 界面保持原样可见可操作。
//!
//! # 为什么必须是「顶层」
//!
//! 打包正式版里壳顶层页面来自自定义协议（tauri://localhost），宿主新版认证通过
//! 「root 请求换 SameSite=Strict 会话 Cookie」完成，而 Strict Cookie 只随
//! 【同站 / 顶层】请求携带：DOM iframe 相对 tauri://localhost 是跨站，换来的
//! Cookie 永远发不回 → 页面停在 `dsh web authentication required`。子 webview 的
//! 顶层文档就是宿主地址本身（http://127.0.0.1:<port>），认证链路与系统浏览器一致，
//! 第三方请求也不再被任何代理/CSP 拦截。
//!
//! # 桥接（iframe 时代的 postMessage → invoke 事件）
//!
//! 子 webview 没有父窗口，postMessage 通道不复存在。三个桥接脚本改经
//! `__TAURI_INTERNALS__.invoke("preview_bridge_report")` 上报，由本模块转发成
//! 事件给主窗口（dsh://preview-theme / preview-plugin-failed / preview-session-acked）。
//! 远程源默认禁止调用自定义命令，靠 capabilities/preview.json（remote.urls 白名单
//! + preview-bridge:default 权限）放行，其余命令一概不可达。
//!
//! 「打开会话」反向通道：本模块 preview_open_session 命令对子 webview eval 一句
//! JS，调用注入脚本暴露的 window.__dshDesktopOpenSession——子 webview 顶层文档
//! 与宿主同源，脚本内可直接读 React fiber 定位会话行并模拟点击。
//!
//! # 平台
//!
//! 子 webview 用 Tauri unstable 多 webview API（`Window::add_child` +
//! `tauri::webview::WebviewBuilder`，需 Cargo 的 tauri "unstable" feature）。
//! Windows 与 macOS 启用；Web 权限申请弹窗仅 Windows 需要（macOS 上 wry 的
//! WKUIDelegate 自动放行媒体采集，见 permissions.rs）。

use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

type PreviewWebview = tauri::webview::Webview<tauri::Wry>;

/// 当前预览子 webview（None = 未创建）
static PREVIEW: Mutex<Option<PreviewWebview>> = Mutex::new(None);

/// 是否支持原生子 webview 预览
#[tauri::command]
pub fn preview_native_supported() -> bool {
    cfg!(any(target_os = "windows", target_os = "macos"))
}

/// 在内容区显示/更新宿主页（幂等：已存在则导航 + 重定位，不存在则创建）。
/// 前端在 url/进入预览/刷新时调用。
#[tauri::command]
pub async fn preview_show(
    app: AppHandle,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        imp::show(&app, &url, x, y, width, height)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = (app, url, x, y, width, height);
        Ok(())
    }
}

/// 内容区位置/尺寸变化时（窗口缩放、最大化/还原等）同步子 webview 边界
#[tauri::command]
pub async fn preview_resize(x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        imp::resize(x, y, width, height)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = (x, y, width, height);
        Ok(())
    }
}

/// 离开预览页 / 停止服务时销毁子 webview
#[tauri::command]
pub async fn preview_hide() -> Result<(), String> {
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        imp::hide()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Ok(())
    }
}

/// 子 webview 桥接上报入口（远程源经 ACL 白名单调用，见 capabilities/preview.json）：
/// - theme：宿主主题变化（body[data-ds-dark-theme]）→ 转发 dsh://preview-theme
/// - plugin-failed：dsh web 渲染 "Failed to load plugins" 界面 → 转发错误项列表
/// - session-acked：会话桥已点开目标会话 → 转发回执（前端清空待打开状态）
#[tauri::command]
pub fn preview_bridge_report(
    app: AppHandle,
    kind: String,
    dark: Option<bool>,
    items: Option<Vec<String>>,
) -> Result<(), String> {
    match kind.as_str() {
        "theme" => {
            let _ = app.emit_to(
                "main",
                "dsh://preview-theme",
                serde_json::json!({ "dark": dark }),
            );
        }
        "plugin-failed" => {
            let _ = app.emit_to(
                "main",
                "dsh://preview-plugin-failed",
                serde_json::json!({ "items": items.unwrap_or_default() }),
            );
        }
        "session-acked" => {
            let _ = app.emit_to("main", "dsh://preview-session-acked", serde_json::json!({}));
        }
        _ => {}
    }
    Ok(())
}

/// 通知点击「打开对话」：向预览子 webview 下发会话打开指令（eval 调用注入脚本
/// 暴露的 window.__dshDesktopOpenSession，sessionId 经 JSON 转义防注入）。
/// 本命令是**同步**命令（跑在主线程）：取句柄后立即放锁，绝不持锁调用 webview，
/// 否则与持锁阻塞等主线程的 preview_show 互相等待即硬死锁（见 show 内注释）。
#[tauri::command]
pub fn preview_open_session(session_id: String) -> Result<(), String> {
    let wv = PREVIEW.lock().unwrap().clone();
    let Some(wv) = wv else {
        return Err("预览子 webview 未创建".into());
    };
    let arg = serde_json::to_string(&session_id).unwrap_or_else(|_| "\"\"".into());
    wv.eval(&format!(
        "window.__dshDesktopOpenSession && window.__dshDesktopOpenSession({arg})"
    ))
    .map_err(|e| format!("下发会话打开指令失败: {e}"))
}

/// 注入到预览子 webview 的主题同步脚本：
/// dsh web 前端切换主题时不推送任何事件（调研结论：仅 Cordis 内部
/// `theme/change` + presenter 写 DOM），但会反映在 DOM 上：ui-layout 的
/// ThemePresenter 在暗色时给 `body` 设置 `data-ds-dark-theme` 属性、亮色时移除。
/// MutationObserver 监听该属性变化后经 preview_bridge_report 上报，壳跟随宿主主题。
const THEME_SYNC_BRIDGE: &str = r##"
(() => {
  if (window.top !== window) return; // 只处理顶层文档（宿主页自身）
  if (window.__dshThemeBridgeInstalled) return;
  try {
    Object.defineProperty(window, "__dshThemeBridgeInstalled", { value: true });
  } catch { /* 忽略 */ }
  let last = null;
  const report = () => {
    const dark = document.body ? document.body.hasAttribute("data-ds-dark-theme") : false;
    if (dark === last) return;
    last = dark;
    try {
      window.__TAURI_INTERNALS__.invoke("preview_bridge_report", { kind: "theme", dark });
    } catch { /* IPC 不可用时静默：仅影响壳主题跟随 */ }
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

/// 注入到预览子 webview 的插件加载失败监听脚本：
/// dsh web 前端在插件 bundle 加载/注册失败时会在页面渲染
/// `Failed to load plugins` 失败界面（failedTitle 标题 + failedItem 错误项），
/// 且不会向宿主推送任何事件（调研结论：boot 失败仅 console.error + 渲染 DOM）。
/// 本脚本用 MutationObserver 监听该界面，检测到后把错误项经
/// preview_bridge_report 上报，前端弹框提示「移除插件并重启」。
const PLUGIN_FAILURE_BRIDGE: &str = r##"
(() => {
  if (window.top !== window) return; // 只处理顶层文档（宿主页自身）
  if (window.__dshPluginFailureBridgeInstalled) return;
  try {
    Object.defineProperty(window, "__dshPluginFailureBridgeInstalled", { value: true });
  } catch { /* 忽略 */ }
  let reported = false; // 同一次页面生命周期内只上报一次，避免反复弹框
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
    try {
      window.__TAURI_INTERNALS__.invoke("preview_bridge_report", { kind: "plugin-failed", items });
    } catch { /* IPC 不可用时静默 */ }
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

/// 注入到预览子 webview 的「打开会话」桥：
/// 通知点击后壳经 preview_open_session → eval 调用 window.__dshDesktopOpenSession，
/// 脚本在宿主页内定位该会话的行并模拟点击，触发 dsh web 前端的 `sessions.open(id)`
/// ——工作区即切到该会话的对话框；成功后经 preview_bridge_report 回执 ACK。
///
/// 调研结论：dsh web 前端不暴露任何外部入口（无 URL 深链、无 window 控制钩子、
/// 会话行 DOM 不含会话 id，见 docs/superpowers/specs/2026-08-28-notify-click-open-design.md），
/// 只能在页面内部读 React fiber 拿行对应的 sessionId 再模拟点击。
///
/// 2026-08-29 实测修复（多工作区场景）：目标会话所在工作区分组**折叠**时，
/// 该会话行不在 DOM 里（`deriveGroups` 对折叠组输出空 sessions），直接轮询找不到
/// 行、点击无果。修复：从任意行沿 fiber 链上溯到 SessionTree 取 `workspaces`
/// （会话 → 工作区映射），找到目标会话所在工作区，点击其组头展开，再继续轮询
/// 定位行；已展开但目标在「展开其余 N 个会话」折叠行之后时，点击该组的溢出
/// 展开按钮。另：超时 20s（覆盖托盘隐藏期间 WebView2 可能丢弃页面、恢复时
/// dsh 冷启动的耗时）。
const SESSION_OPEN_BRIDGE: &str = r##"
(() => {
  if (window.top !== window) return; // 只处理顶层文档（宿主页自身）
  if (window.__dshSessionOpenBridgeInstalled) return;
  try {
    Object.defineProperty(window, "__dshSessionOpenBridgeInstalled", { value: true });
  } catch { /* 忽略 */ }
  const MAX_WAIT_MS = 20000; // 行渲染异步（会话列表就绪 + React 提交，可能含冷启动）
  const TICK_MS = 200;
  const MAX_FIBER_DEPTH = 12;
  const MAX_PARENT_DEPTH = 40;
  let revealed = false; // 组展开/溢出按钮只尝试一次（幂等）

  const ack = () => {
    try {
      window.__TAURI_INTERNALS__.invoke("preview_bridge_report", { kind: "session-acked" });
    } catch { /* IPC 不可用时静默：前端按有效期自行过期 */ }
  };

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
        ack();
        return;
      }
      if (!revealed && Date.now() - started < 2000) attemptReveal(sessionId);
      if (Date.now() - started < MAX_WAIT_MS) setTimeout(tick, TICK_MS);
      // 超时未找到（rail 图标态等极端场景）：优雅降级，只保留窗口聚焦，不打扰用户
    };
    tick();
  };

  window.__dshDesktopOpenSession = (sessionId, sessionTitle) => {
    if (typeof sessionId !== "string" || sessionId === "") return;
    openSession(sessionId, typeof sessionTitle === "string" ? sessionTitle : "");
  };
})();
"##;

#[cfg(any(target_os = "windows", target_os = "macos"))]
mod imp {
    use super::*;
    use tauri::{LogicalPosition, LogicalSize, WebviewUrl};

    fn apply_bounds(wv: &PreviewWebview, x: f64, y: f64, width: f64, height: f64) {
        // CSS px 即逻辑像素：前端直接汇报 getBoundingClientRect 结果
        let _ = wv.set_position(LogicalPosition::new(x, y));
        let _ = wv.set_size(LogicalSize::new(width, height));
    }

    /// 站内导航放行：宿主只服务 loopback（http/https + 127.0.0.1 / localhost / ::1）。
    /// 其余地址（外链的普通跳转）拦截并转交系统浏览器，避免子 webview 被导航走
    /// 丢掉服务页面；target=_blank 的新窗口请求由 on_new_window 兜住。
    fn is_loopback_http(url: &tauri::Url) -> bool {
        if url.scheme() != "http" && url.scheme() != "https" {
            return false;
        }
        matches!(
            url.host_str(),
            Some("127.0.0.1") | Some("localhost") | Some("[::1]") | Some("::1")
        )
    }

    pub fn show(
        app: &AppHandle,
        url: &str,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    ) -> Result<(), String> {
        let parsed = tauri::Url::parse(url).map_err(|e| format!("无效的服务地址: {e}"))?;
        // 已存在 → 导航 + 重定位。Webview 是廉价的 Clone 句柄，取出后立即放锁：
        // 下面的创建路径【全程不得持锁】，见 add_child 处注释。
        if let Some(wv) = PREVIEW.lock().unwrap().clone() {
            let _ = wv.navigate(parsed);
            apply_bounds(&wv, x, y, width, height);
            return Ok(());
        }
        let window = app.get_window("main").ok_or("未找到主窗口")?;
        let builder = tauri::webview::WebviewBuilder::new("preview", WebviewUrl::External(parsed))
            .on_navigation(|url| {
                if is_loopback_http(&url) {
                    return true;
                }
                let _ = crate::dsh::open_url(url.as_str());
                false
            })
            .on_new_window(|url, _features| {
                let _ = crate::dsh::open_url(url.as_str());
                tauri::webview::NewWindowResponse::Deny
            })
            .initialization_script(THEME_SYNC_BRIDGE)
            .initialization_script(PLUGIN_FAILURE_BRIDGE)
            .initialization_script(SESSION_OPEN_BRIDGE);
        // add_child 内部会切回主线程执行，必须在非主线程调用（async 命令满足），
        // 且调用方会【阻塞等待】主线程完成。因此这段期间绝不能持有 PREVIEW 锁：
        // 主线程上的同步命令 preview_open_session 也要取这把锁，一旦并发就是
        // 「工作线程持锁等主线程、主线程等锁」的硬死锁——整个应用冻结、托盘失效，
        // 只能重启（与 permissions.rs 里同步弹框钉死主线程是同一类故障）。
        let wv = window
            .add_child(
                builder,
                LogicalPosition::new(x, y),
                LogicalSize::new(width, height),
            )
            .map_err(|e| format!("创建预览子 webview 失败: {e}"))?;
        // 再次应用边界：规避 WebView2 首帧把子 webview 卡在离屏 1×1 的问题
        // （其他平台重复应用一次无副作用）
        apply_bounds(&wv, x, y, width, height);
        // Web 权限申请（麦克风/摄像头等）也要能在子 webview 上弹窗询问用户
        // （仅 Windows 需要，见 permissions.rs 模块注释）
        #[cfg(target_os = "windows")]
        {
            let handle = app.clone();
            if let Err(e) = wv.with_webview(move |pw| {
                if let Err(e) = crate::permissions::attach_platform(&handle, &pw) {
                    eprintln!("[preview] 权限处理器挂载失败: {e}");
                }
            }) {
                eprintln!("[preview] with_webview 派发失败: {e}");
            }
        }
        // 短锁写回。仅当槽位仍为空：label "preview" 唯一，并发创建时后者会在
        // add_child 就失败，这里再兜一层避免覆盖掉已生效的句柄
        let mut slot = PREVIEW.lock().unwrap();
        if slot.is_none() {
            *slot = Some(wv);
        }
        Ok(())
    }

    pub fn resize(x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
        // 与 show 同理：取出 Clone 句柄后立即放锁，锁不跨越任何 webview 调用
        if let Some(wv) = PREVIEW.lock().unwrap().clone() {
            apply_bounds(&wv, x, y, width, height);
        }
        Ok(())
    }

    pub fn hide() -> Result<(), String> {
        // 先 take 到局部变量再放锁：写成 `if let Some(wv) = PREVIEW.lock().unwrap().take()`
        // 时临时 MutexGuard 会活到 if-let 块结束，close() 全程持锁。close() 内部经
        // manager 摘除 webview，属"可能阻塞的调用"，与主线程同步命令
        // preview_open_session 争锁即同类死锁（见 show 内注释）。
        let taken = PREVIEW.lock().unwrap().take();
        if let Some(wv) = taken {
            let _ = wv.close();
        }
        Ok(())
    }
}
