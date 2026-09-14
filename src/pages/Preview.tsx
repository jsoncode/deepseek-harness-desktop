import { Button, Space } from "antd";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { api, EVENTS, onEvent, tauri, type PlatformInfo } from "../lib/tauri";
import { sameSiteEmbedUrl } from "../lib/urlMask";
import { useAppStore } from "../store/useAppStore";
import { useUiStore } from "../store/useUiStore";

/** 待打开会话的有效期：超过则视为陈旧丢弃（桥找不到目标或页面未恢复的兜底） */
const PENDING_OPEN_TTL_MS = 60_000;

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
 * 预览承载方式（由 Rust `platform_info` 给出，前端不做 UA 嗅探）：
 * - 原生内嵌（Windows/macOS，preview.rs）：宿主页由与桌面壳同窗口的【原生子
 *   webview】作为其顶层文档直接加载——子 webview 的顶层即宿主地址本身，
 *   SameSite=Strict 认证链与系统浏览器一致，第三方请求不再被本地代理拦截。
 *   顶栏/底栏仍是壳 DOM 照常显示；子 webview 只覆盖内容区（preview-frame），
 *   位置/尺寸由本页实时同步。原生子 webview 之上的 DOM 层无法显示，宿主的
 *   主题切换/插件失败/会话回执经 invoke→事件桥（preview.rs 注入的三个
 *   initialization_script）上报，待打开会话经 previewOpenSession 下发。
 * - 独立预览窗口（Linux）：tauri-runtime-wry 在 Linux 上把子 webview pack 进窗口的
 *   GtkBox，wry 的 set_bounds 只在 GtkFixed 父容器里生效，无法按内容区坐标悬浮。
 *   因此 Linux 由 Rust 侧开一个独立窗口加载宿主页（顶层文档 ⇒ 认证链路同上），
 *   本页只显示一张说明卡片；顶栏刷新会重新导航那个窗口。
 * - iframe（仅浏览器预览模式，非 Tauri）：开发模式下 sameSiteEmbedUrl 把宿主
 *   改写为 localhost 保持同站，浏览器自走 root 换 Cookie 认证；外链/弹层由
 *   真实浏览器原生处理，无需任何桥接脚本。
 */
export default function Preview() {
  const navigate = useNavigate();
  const url = useAppStore((s) => s.url);
  const initialized = useAppStore((s) => s.initialized);
  const init = useAppStore((s) => s.init);
  const reportPluginLoadError = useAppStore((s) => s.reportPluginLoadError);
  const reloadKey = useUiStore((s) => s.reloadKey);
  const pendingOpenSession = useUiStore((s) => s.pendingOpenSession);
  const clearPendingOpenSession = useUiStore((s) => s.clearPendingOpenSession);
  const frameRef = useRef<HTMLDivElement>(null);

  // ---- 预览承载探测（null = 探测中）----
  const [mode, setMode] = useState<PlatformInfo["previewMode"] | null>(null);
  useEffect(() => {
    if (!tauri) {
      setMode(null);
      return;
    }
    let alive = true;
    api
      .platformInfo()
      .then((info) => {
        if (alive) setMode(info.previewMode);
      })
      .catch(() => {
        // 探测失败按独立窗口处理：Linux 是当前唯一非内嵌平台，且该路径不会
        // 在壳 DOM 里留白（内嵌探测失败会渲染空内容区，风险更大）。
        if (alive) setMode("window");
      });
    return () => {
      alive = false;
    };
  }, []);

  // iframe 内嵌地址（仅浏览器预览模式用到）
  const iframeUrl = url ? sameSiteEmbedUrl(url) : null;

  // 刷新/直接进入本页时同步应用状态
  useEffect(() => {
    if (!initialized) void init();
  }, [initialized, init]);

  // 原生预览激活态：有地址且在原生支持环境
  const nativeActive = mode === "embedded" && Boolean(url);
  // 独立窗口预览激活态（Linux）：由 Rust 侧开窗，本页只留说明卡片
  const windowActive = mode === "window" && Boolean(url);

  // ---- 原生：进入/地址变化时创建或更新子 webview；离开时隐藏（保留登录态）----
  useEffect(() => {
    if (!nativeActive || !url) return;
    const el = frameRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    void api.previewShow(url, r.x, r.y, r.width, r.height).catch(() => undefined);
    return () => {
      void api.previewHide().catch(() => undefined);
    };
  }, [nativeActive, url]);

  // ---- 独立窗口（Linux）：进入预览 / 地址变化时开窗或重导航；离开时关闭窗口 ----
  // 坐标不参与：窗口自带原生边框与尺寸，Rust 侧忽略 x/y/width/height。
  useEffect(() => {
    if (!windowActive || !url) return;
    void api.previewShow(url, 0, 0, 0, 0).catch(() => undefined);
    return () => {
      void api.previewHide().catch(() => undefined);
    };
  }, [windowActive, url]);

  // ---- 标题栏「刷新」（reloadKey）→ 重导航到同一地址重新走认证 ----
  // 两种承载共用：内嵌走坐标同步的 previewShow，独立窗口只报 URL（坐标被忽略）。
  const prevReloadRef = useRef<number | null>(null);
  useEffect(() => {
    const active = nativeActive || windowActive;
    if (!active || !url) {
      prevReloadRef.current = null;
      return;
    }
    const prev = prevReloadRef.current;
    prevReloadRef.current = reloadKey;
    if (prev === null || prev === reloadKey) return; // 首次创建由 attach effect 完成
    if (windowActive) {
      void api.previewShow(url, 0, 0, 0, 0).catch(() => undefined);
      return;
    }
    const el = frameRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    void api.previewShow(url, r.x, r.y, r.width, r.height).catch(() => undefined);
  }, [reloadKey, nativeActive, windowActive, url]);

  // ---- 原生：内容区布局/窗口尺寸变化时同步子 webview 边界 ----
  useEffect(() => {
    if (!nativeActive) return;
    const el = frameRef.current;
    if (!el) return;
    const sync = () => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      void api.previewResize(r.x, r.y, r.width, r.height).catch(() => undefined);
    };
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    window.addEventListener("resize", sync);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", sync);
    };
  }, [nativeActive]);

  // ---- 接收预览承载的桥接上报（invoke → preview_bridge_report → emit）----
  // 内嵌子 webview 与独立预览窗口注入的是同一套桥接脚本、webview label 同名
  // （capabilities/preview.json 认 label），因此事件处理对两者一致。
  useEffect(() => {
    if (!nativeActive && !windowActive) return;
    const offs = [
      onEvent<{ items?: string[] }>(EVENTS.previewPluginFailed, (p) => {
        const items = (p.items ?? []).filter((x): x is string => typeof x === "string");
        if (items.length === 0) return;
        const name = extractPluginName(items);
        if (!name) return;
        reportPluginLoadError(name, items.join("\n"));
      }),
      onEvent(EVENTS.previewSessionAcked, () => {
        clearPendingOpenSession();
      }),
    ];
    return () => {
      for (const off of offs) void off;
    };
  }, [nativeActive, windowActive, reportPluginLoadError, clearPendingOpenSession]);

  // 系统通知点击待打开的会话：预览承载执行 __dshDesktopOpenSession
  // （SESSION_OPEN_BRIDGE 定位会话行并模拟点击），回执经 previewSessionAcked 事件
  // 清空待打开状态；超过有效期视为陈旧丢弃。
  useEffect(() => {
    if (!pendingOpenSession) return;
    if (Date.now() - pendingOpenSession.sentAt > PENDING_OPEN_TTL_MS) {
      clearPendingOpenSession();
      return;
    }
    if (!nativeActive && !windowActive) return; // 浏览器预览无桥，不做下发
    void api.previewOpenSession(pendingOpenSession.sessionId).catch(() => undefined);
  }, [pendingOpenSession, nativeActive, windowActive, clearPendingOpenSession]);

  // 无 URL（未检测到服务）时不再展示空态页，直接回服务状态页处理启动/重试
  useEffect(() => {
    if (!url && initialized) navigate("/loading", { replace: true });
  }, [url, initialized, navigate]);

  // 服务健康监测已上移至全局 store（useAppStore），断连只反映在标题栏指示灯，
  // 本页不再做任何拦截，避免服务繁忙时的单次探测超时误报遮挡内容。

  // 无 URL（状态同步中或跳转前的一瞬）时不渲染任何内容，由上方 effect 负责回服务状态页
  if (!url) return null;

  // 原生路径：子 webview 由 Rust 创建并悬浮于本 div 区域，DOM 里只留占位。
  // 探测完成前也不渲染 iframe，避免正式版闪现一次 401 页面。
  const renderIframe = !tauri;

  return (
    <div className="page preview">
      <div className="preview-frame" ref={frameRef}>
        {renderIframe ? (
          <iframe
            key={`${iframeUrl ?? ""}|${reloadKey}`}
            src={iframeUrl ?? undefined}
            title="Harness Preview"
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
        {/* 独立窗口承载（Linux）：宿主界面在另一个窗口里，这里只放说明与入口。
            窗口是 Rust 侧开的（见 effect），关掉后可从「重新打开」再拉起。 */}
        {windowActive ? (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 24,
            }}
          >
            <div style={{ maxWidth: 460, textAlign: "center" }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
                预览已在独立窗口中打开
              </div>
              <p style={{ fontSize: 12.5, lineHeight: 1.8, color: "var(--text-3)", margin: "0 0 14px" }}>
                当前平台（Linux）用独立窗口承载宿主界面：WebKitGTK 的子 webview
                无法按内容区坐标悬浮在壳界面之上。关掉那个窗口后，可从这里重新打开。
              </p>
              <Space>
                <Button
                  type="primary"
                  onClick={() =>
                    void api.previewShow(url, 0, 0, 0, 0).catch(() => undefined)
                  }
                >
                  重新打开预览窗口
                </Button>
                <Button onClick={() => void api.openInBrowser(url).catch(() => undefined)}>
                  在浏览器中打开
                </Button>
              </Space>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
