import { App as AntApp } from "antd";
import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { api } from "../lib/tauri";
import { useAppStore } from "../store/useAppStore";
import { useThemeStore } from "../store/useThemeStore";
import { useUiStore } from "../store/useUiStore";

/** 桥接脚本发来的外链打开请求标记（与 src-tauri/src/lib.rs 的 EXTERNAL_LINK_BRIDGE 对应） */
const OPEN_URL_MSG = "dsh-desktop:open-url";
/** iframe 内插件加载失败上报标记（与 src-tauri/src/lib.rs 的 PLUGIN_FAILURE_BRIDGE 对应） */
const PLUGIN_FAILED_MSG = "dsh-desktop:plugin-failed";
/** iframe 内主题变化上报标记（与 src-tauri/src/lib.rs 的 THEME_SYNC_BRIDGE 对应） */
const THEME_CHANGE_MSG = "dsh-desktop:theme-change";

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

export default function Preview() {
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const url = useAppStore((s) => s.url);
  const initialized = useAppStore((s) => s.initialized);
  const init = useAppStore((s) => s.init);
  const reportPluginLoadError = useAppStore((s) => s.reportPluginLoadError);
  const setHostTheme = useThemeStore((s) => s.setHostTheme);
  const reloadKey = useUiStore((s) => s.reloadKey);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // 刷新/直接进入本页时同步应用状态
  useEffect(() => {
    if (!initialized) void init();
  }, [initialized, init]);

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
  }, [message, reportPluginLoadError, setHostTheme]);

  // 无 URL（状态同步中或跳转前的一瞬）时不渲染任何内容，由上方 effect 负责回启动页
  if (!url) return null;

  return (
    <div className="page preview">
      <div className="preview-frame">
        <iframe
          key={`${url}|${reloadKey}`}
          ref={iframeRef}
          src={url}
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
      </div>
    </div>
  );
}
