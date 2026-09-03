import { App as AntApp } from "antd";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { api, tauri } from "../lib/tauri";
import { sameSiteEmbedUrl } from "../lib/urlMask";
import { useAppStore } from "../store/useAppStore";
import { useThemeStore } from "../store/useThemeStore";
import { useUiStore } from "../store/useUiStore";

/** 桥接脚本发来的外链打开请求标记（与 src-tauri/src/lib.rs 的 EXTERNAL_LINK_BRIDGE 对应） */
const OPEN_URL_MSG = "dsh-desktop:open-url";
/** iframe 内插件加载失败上报标记（与 src-tauri/src/lib.rs 的 PLUGIN_FAILURE_BRIDGE 对应） */
const PLUGIN_FAILED_MSG = "dsh-desktop:plugin-failed";
/** iframe 内主题变化上报标记（与 src-tauri/src/lib.rs 的 THEME_SYNC_BRIDGE 对应） */
const THEME_CHANGE_MSG = "dsh-desktop:theme-change";
/** 打开指定会话对话框的下发标记（与 src-tauri/src/lib.rs 的 SESSION_OPEN_BRIDGE 对应） */
const OPEN_SESSION_MSG = "dsh-desktop:open-session";
/** 桥已在 iframe 内点开目标会话的回执标记（SESSION_OPEN_BRIDGE 回传，用于清空待打开状态） */
const SESSION_OPEN_ACK_MSG = "dsh-desktop:session-open-acked";
/** 待打开会话的有效期：超过则视为陈旧丢弃（桥找不到目标或页面未恢复的兜底） */
const PENDING_OPEN_TTL_MS = 60_000;
/** 代理地址查询失败后的重试间隔/次数（代理线程在 setup 里启动，理论上立即可用） */
const PROXY_RETRY_MS = 300;
const PROXY_MAX_RETRY = 5;

/**
 * 从插件加载失败的错误项中提取插件名：
 * 优先匹配 /plugins/<name>/（dsh-jenkins 等），
 * 兜底匹配 (name) / "name" via __ModuleLoader__ 等形态。
 */
function extractPluginName(items: string[]): string | null {
  for (const item of items) {
    const m = /\/plugins\/([^/]+)\//.exec(item);
    if (m) return m[1];
  }
  for (const item of items) {
    const m = /\(([^)]+)\)/.exec(item);
    if (m && !m[1].includes(" ")) return m[1];
    const n = /"([^"]+)"/.exec(item);
    if (n) return n[1];
  }
  return null;
}

/**
 * 预览承载方式：宿主页一律用普通 DOM iframe 内嵌（同文档内 Tooltip/Popconfirm
 * 等浮层天然浮在 iframe 之上，无需任何让位协调）。
 *
 * 跨站认证问题由 Rust 本地反向代理（src-tauri/src/proxy.rs）在服务端解决——
 * 代理监听 127.0.0.1 并把上游 dsh web 暴露成另一个本地 origin，浏览器（无论
 * 顶层是打包正式版的 tauri://localhost 还是开发模式的 http://localhost）访问的
 * 都是代理 origin；认证 Cookie 由 Rust 持有并注入，浏览器永不接触，因此不存在
 * SameSite=Strict 发不回的问题：
 *
 * - Tauri 桌面运行时：iframe src = 代理地址（api.proxyBaseUrl()，无 token，
 *   代理按请求实时从 AppState.detected_url 解析上游并注入 Cookie）；
 * - 浏览器预览（非 Tauri，仅在开发模式 http://localhost 顶层下可用）：Rust
 *   代理不在场，退回首版方案——sameSiteEmbedUrl 把宿主改写为 localhost 保持
 *   同站，浏览器自己走 root 换 Cookie 认证。
 */
export default function Preview() {
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const url = useAppStore((s) => s.url);
  const initialized = useAppStore((s) => s.initialized);
  const init = useAppStore((s) => s.init);
  const reportPluginLoadError = useAppStore((s) => s.reportPluginLoadError);
  const setHostTheme = useThemeStore((s) => s.setHostTheme);
  const reloadKey = useUiStore((s) => s.reloadKey);
  const pendingOpenSession = useUiStore((s) => s.pendingOpenSession);
  const clearPendingOpenSession = useUiStore((s) => s.clearPendingOpenSession);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  /** iframe 当前文档是否已加载（onLoad 置 true；url/reloadKey 变化时渲染期复位） */
  const [iframeLoaded, setIframeLoaded] = useState(false);

  // ---- Tauri 下取代理地址（null = 查询中 / 失败重试中）----
  const [proxyBase, setProxyBase] = useState<string | null>(null);
  const proxyReady = !tauri || proxyBase !== null;

  useEffect(() => {
    if (!tauri || !url) return;
    let alive = true;
    let attempts = 0;
    const probe = () => {
      api
        .proxyBaseUrl()
        .then((base) => {
          if (!alive) return;
          if (base) {
            setProxyBase(base);
            return;
          }
          if (attempts++ < PROXY_MAX_RETRY) {
            window.setTimeout(probe, PROXY_RETRY_MS);
          } else {
            message.error("本地预览代理不可用，请重启应用后重试");
          }
        })
        .catch(() => {
          if (!alive) return;
          if (attempts++ < PROXY_MAX_RETRY) {
            window.setTimeout(probe, PROXY_RETRY_MS);
          }
        });
    };
    probe();
    return () => {
      alive = false;
    };
  }, [tauri, url, message]);

  // 内嵌地址：
  // - Tauri：代理 origin（不带 token；浏览器无 Cookie，代理负责认证）
  // - 浏览器预览：sameSiteEmbedUrl（开发模式顶层 http://localhost，改写 host
  //   为 localhost 保持同站让浏览器自己完成 Cookie 认证）
  const iframeUrl = tauri ? proxyBase : url ? sameSiteEmbedUrl(url) : null;
  // iframe 以 `iframeUrl|reloadKey` 为键重挂载：键变化时在渲染期同步复位就绪位。
  // 不能放在 effect 里复位——onLoad 可能在 effect 之前触发，复位会覆盖已触发的
  // onLoad，导致新文档加载完成后就绪位仍是 false、待打开会话永不发送。
  const iframeSession = `${iframeUrl ?? ""}|${reloadKey}`;
  const [loadedSession, setLoadedSession] = useState(iframeSession);
  if (loadedSession !== iframeSession) {
    setLoadedSession(iframeSession);
    setIframeLoaded(false);
  }

  // 刷新/直接进入本页时同步应用状态
  useEffect(() => {
    if (!initialized) void init();
  }, [initialized, init]);

  // 系统通知点击待打开的会话：iframe 就绪后 postMessage 给 SESSION_OPEN_BRIDGE，
  // 由其在 dsh web 内定位该会话行并模拟点击（打开对应会话对话框）。
  // 发送后**不立即清空**：等桥的 ACK（SESSION_OPEN_ACK_MSG）确认已点开，或超过
  // 有效期丢弃。iframe 重载（onLoad 再次触发，如托盘隐藏期间 WebView2 丢弃页面）
  // 时会重新下发同一会话——桥对重复消息幂等，多余点击无害。
  useEffect(() => {
    if (!iframeLoaded) return;
    const pending = useUiStore.getState().pendingOpenSession;
    if (!pending) return;
    if (Date.now() - pending.sentAt > PENDING_OPEN_TTL_MS) {
      clearPendingOpenSession();
      return;
    }
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage({ [OPEN_SESSION_MSG]: true, sessionId: pending.sessionId }, "*");
  }, [iframeLoaded, pendingOpenSession, url, reloadKey, clearPendingOpenSession]);

  // 无 URL（未检测到服务）时不再展示空态页，直接回启动页处理启动/重试
  useEffect(() => {
    if (!url && initialized) navigate("/", { replace: true });
  }, [url, initialized, navigate]);

  // 服务健康监测已上移至全局 store（useAppStore），断连只反映在标题栏指示灯，
  // 本页不再做任何拦截，避免服务繁忙时的单次探测超时误报遮挡内容。

  // 接收桥接脚本（EXTERNAL_LINK_BRIDGE / PLUGIN_FAILURE_BRIDGE）从预览 iframe 内
  // postMessage 过来的消息：外链打开请求转交系统浏览器；插件加载失败上报弹框。
  // Windows 上 wry 的 on_new_window 不会为 iframe 内 target=_blank 触发，所以外链
  // 必须由注入脚本拦截后经此通道转发。
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const data = e.data;
      if (!data || typeof data !== "object") return;
      // 只信任预览 iframe 发来的消息，避免页面内其他来源伪造
      if (e.source !== iframeRef.current?.contentWindow) return;

      // 桥已点开目标会话 → 清空待打开状态（此后 iframe 再重载也不会重复下发）
      if (data[SESSION_OPEN_ACK_MSG] === true) {
        clearPendingOpenSession();
        return;
      }

      // 宿主主题变化（iframe 内 body[data-ds-dark-theme] 变化）→ 壳主题跟随
      if (data[THEME_CHANGE_MSG] === true && typeof data.dark === "boolean") {
        setHostTheme(data.dark ? "dark" : "light");
        return;
      }

      // 插件加载失败（iframe 内渲染 "Failed to load plugins" 界面）
      if (data[PLUGIN_FAILED_MSG] === true && Array.isArray(data.items)) {
        const items: string[] = data.items.filter((x: unknown): x is string => typeof x === "string");
        if (items.length === 0) return;
        const name = extractPluginName(items);
        if (!name) return;
        reportPluginLoadError(name, items.join("\n"));
        return;
      }

      // 外链打开请求
      if (data[OPEN_URL_MSG] !== true || typeof data.url !== "string") return;
      let parsed: URL;
      try {
        parsed = new URL(data.url);
      } catch {
        return;
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
      void api.openInBrowser(parsed.href).catch(() => {
        message.error("打开链接失败");
      });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [message, reportPluginLoadError, setHostTheme, clearPendingOpenSession]);

  // 无 URL（状态同步中或跳转前的一瞬）时不渲染任何内容，由上方 effect 负责回启动页
  if (!url) return null;
  // 代理地址就绪前不渲染 iframe（避免闪现一次代理未就绪页面）
  if (!proxyReady) return null;

  return (
    <div className="page preview">
      <div className="preview-frame">
        {iframeUrl ? (
          <iframe
            key={`${iframeUrl}|${reloadKey}`}
            ref={iframeRef}
            src={iframeUrl}
            title="Harness Preview"
            onLoad={() => setIframeLoaded(true)}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              border: "none",
              background: "#fff",
            }}
            allow="clipboard-read; clipboard-write; fullscreen"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals"
          />
        ) : null}
      </div>
    </div>
  );
}
