import { App as AntApp } from "antd";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { ArrowLeftIcon } from "../components/icons";
import { api } from "../lib/tauri";
import { useAppStore } from "../store/useAppStore";
import { useUiStore } from "../store/useUiStore";

export default function Preview() {
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const url = useAppStore((s) => s.url);
  const phase = useAppStore((s) => s.phase);
  const reloadKey = useUiStore((s) => s.reloadKey);

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

  // 标题栏"刷新"→ reloadKey 变化 → 重置加载态并重挂 iframe
  useEffect(() => {
    setLoaded(false);
  }, [reloadKey]);

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
  }, [url, message]);

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
