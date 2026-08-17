import { App as AntApp } from "antd";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { ArrowLeftIcon, CopyIcon, ExternalIcon, RefreshIcon } from "../components/icons";
import { api } from "../lib/tauri";
import { useAppStore } from "../store/useAppStore";

export default function Preview() {
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const url = useAppStore((s) => s.url);
  const phase = useAppStore((s) => s.phase);

  const [reloadKey, setReloadKey] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [alive, setAlive] = useState(true);
  const [rechecking, setRechecking] = useState(false);

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

  const reload = useCallback(() => {
    setLoaded(false);
    setReloadKey((k) => k + 1);
  }, []);

  const copyUrl = useCallback(async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      message.success("地址已复制到剪贴板");
    } catch {
      message.error("复制失败");
    }
  }, [url]);

  const recheck = useCallback(async () => {
    if (!url) return;
    setRechecking(true);
    try {
      const ok = await api.probeService(url);
      setAlive(ok);
      if (ok) message.success("服务连接正常");
    } finally {
      setRechecking(false);
    }
  }, [url]);

  // 无 URL → 空态
  if (!url) {
    return (
      <div className="page preview">
        <div className="empty-box">
          <div className="big">🛰</div>
          <div>未检测到本地服务地址</div>
          <button className="btn-secondary" onClick={() => navigate("/")}>
            <ArrowLeftIcon size={14} /> 返回启动页
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="page preview">
      <div className="preview-toolbar">
        <button className="icon-btn" title="返回启动页" onClick={() => navigate("/")}>
          <ArrowLeftIcon />
        </button>
        <div className="url-pill">
          <span className="dot" />
          <span className="url-value">{url}</span>
        </div>
        <button className="icon-btn" title="刷新" onClick={reload}>
          <RefreshIcon />
        </button>
        <button className="icon-btn" title="复制地址" onClick={copyUrl}>
          <CopyIcon />
        </button>
        <button
          className="icon-btn"
          title="在浏览器中打开"
          onClick={() => void api.openInBrowser(url)}
        >
          <ExternalIcon />
        </button>
      </div>

      <div className="preview-frame">
        <iframe
          key={reloadKey}
          src={url}
          title="Harness Preview"
          onLoad={() => setLoaded(true)}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            border: "none",
            background: "#fff",
          }}
          allow="clipboard-read; clipboard-write; fullscreen"
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
                <button className="btn-secondary" onClick={() => void recheck()} disabled={rechecking}>
                  {rechecking ? "检测中…" : "重新连接"}
                </button>
                <button className="btn-secondary" onClick={() => navigate("/")}>
                  返回启动页
                </button>
              </div>
            </div>
          </div>
        ) : !loaded ? (
          <div className="preview-overlay">
            <div className="preview-loading">
              <div className="spinner-ring" />
              <div>正在加载 {url} …</div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
