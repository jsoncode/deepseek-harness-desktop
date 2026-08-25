import { ArrowLeftOutlined } from "@ant-design/icons";
import { App as AntApp } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../lib/tauri";
import { useAppStore } from "../store/useAppStore";
import { useUiStore } from "../store/useUiStore";

/** 桥接脚本发来的外链打开请求标记（与 src-tauri/src/lib.rs 的 EXTERNAL_LINK_BRIDGE 对应） */
const OPEN_URL_MSG = "dsh-desktop:open-url";

export default function Preview() {
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const url = useAppStore((s) => s.url);
  const phase = useAppStore((s) => s.phase);
  const initialized = useAppStore((s) => s.initialized);
  const init = useAppStore((s) => s.init);
  const reloadKey = useUiStore((s) => s.reloadKey);
  const bumpReload = useUiStore((s) => s.bumpReload);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const [alive, setAlive] = useState(true);
  const [rechecking, setRechecking] = useState(false);

  // 刷新/直接进入本页时同步应用状态（否则 url 一直为空，误报"未检测到服务"）
  useEffect(() => {
    if (!initialized) void init();
  }, [initialized, init]);

  // 服务健康轮询
  useEffect(() => {
    if (!url) return;
    let disposed = false;
    const tick = async () => {
      try {
        const ok = await api.probeService(url);
        if (!disposed) setAlive(ok);
      } catch {
        if (!disposed) setAlive(false);
      }
    };
    void tick();
    const timer = setInterval(tick, 6000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [url]);

  // 标题栏"刷新"→ reloadKey / url 变化 → iframe 的 key 变化，自动重挂载
  // （服务自身带有加载效果，不再叠加外层 loading 遮罩）

  // 接收桥接脚本（EXTERNAL_LINK_BRIDGE）从预览 iframe 内 postMessage 过来的外链，
  // 转交系统默认浏览器打开。Windows 上 wry 的 on_new_window 不会为 iframe 内
  // target=_blank 触发，所以外链必须由注入脚本拦截后经此通道转发。
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const data = e.data;
      if (!data || typeof data !== "object") return;
      if (data[OPEN_URL_MSG] !== true || typeof data.url !== "string") return;
      // 只信任预览 iframe 发来的消息，避免页面内其他来源伪造
      if (e.source !== iframeRef.current?.contentWindow) return;
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
  }, [message]);

  const recheck = useCallback(async () => {
    if (!url) return;
    setRechecking(true);
    try {
      const ok = await api.probeService(url);
      setAlive(ok);
      if (ok) {
        message.success("服务连接正常");
        bumpReload(); // 重挂 iframe，让"重新连接"真正恢复内容
      }
    } finally {
      setRechecking(false);
    }
  }, [url, message, bumpReload]);

  // 无 URL → 空态（状态同步中显示"正在检测"，避免刷新后误报未检测到服务）
  if (!url) {
    const syncing = !initialized || phase === "checking";
    return (
      <div className="page preview">
        <div className="empty-box">
          <div className="big">{syncing ? <span className="spinner-ring" /> : "🛰"}</div>
          <div>{syncing ? "正在检测本地服务…" : "未检测到本地服务地址"}</div>
          <button className="btn-secondary" onClick={() => navigate("/")}>
            <ArrowLeftOutlined style={{ fontSize: 14 }} /> 返回启动页
          </button>
        </div>
      </div>
    );
  }

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

        {!alive ? (
          <div className="preview-overlay">
            <div className="empty-box">
              <div className="big">📡</div>
              <div>本地服务已断开连接</div>
              <div style={{ color: "var(--text-3)", fontSize: 12.5 }}>
                {phase === "stopped" ? "服务已被停止" : "服务无响应，可尝试重新连接"}
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <button
                  className="btn-secondary"
                  onClick={() => void recheck()}
                  disabled={rechecking}
                >
                  {rechecking ? "检测中…" : "重新连接"}
                </button>
                <button className="btn-secondary" onClick={() => navigate("/")}>
                  返回启动页
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
