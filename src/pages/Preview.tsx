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
  const initialized = useAppStore((s) => s.initialized);
  const init = useAppStore((s) => s.init);
  const reloadKey = useUiStore((s) => s.reloadKey);
  const bumpReload = useUiStore((s) => s.bumpReload);

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
          key={`${url}|${reloadKey}`}
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
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals"
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
