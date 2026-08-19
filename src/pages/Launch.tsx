import { useEffect, type ReactNode } from "react";
import { useNavigate } from "react-router";
import logo from "../assets/logo.svg";
import { tauri } from "../lib/tauri";
import { useAppStore } from "../store/useAppStore";

export default function Launch() {
  const navigate = useNavigate();
  const { phase, url, dshInstalled, pnpmPath, dshPath, initialized, init, refreshStatus } =
    useAppStore();

  useEffect(() => {
    if (!initialized) {
      void init();
    } else {
      void refreshStatus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const busy = phase === "checking" || phase === "installing" || phase === "starting";

  let statusText: ReactNode;
  let statusClass = "launch-status";
  if (phase === "checking") {
    statusText = "正在检测运行环境…";
    statusClass += " busy";
  } else if (phase === "running") {
    statusText = (
      <>
        服务运行中
        {url ? <span className="url-text">{url}</span> : null}
      </>
    );
    statusClass += " running";
  } else if (phase === "error") {
    statusText = "启动失败，请检查终端日志";
    statusClass += " error";
  } else if (phase === "stopped") {
    statusText = "服务已停止，点击重新启动";
  } else {
    statusText = dshInstalled ? "环境就绪 · 点击启动本地服务" : "首次使用 · 将自动安装 @deepseek-ai/dsh";
  }

  const handlePrimary = () => {
    if (phase === "running") {
      navigate("/preview");
      return;
    }
    navigate("/terminal");
  };

  let btnText = "启动应用";
  if (phase === "checking") btnText = "检测中…";
  else if (phase === "running") btnText = "打开应用";
  else if (phase === "installing") btnText = "安装中…";
  else if (phase === "starting") btnText = "启动中…";
  else if (phase === "error" || phase === "stopped") btnText = "重新启动";

  return (
    <div className="page launch">
      <div className="launch-logo-wrap">
        <div className="launch-logo">
          <img src={logo} alt="Harness Logo" draggable={false} />
        </div>
      </div>

      <h1 className="launch-title">DeepSeek Harness Desktop</h1>
      <p className="launch-subtitle">DeepSeek Harness · 本地服务启动器</p>

      <div className={statusClass}>
        <span className="dot" />
        <span>{statusText}</span>
      </div>

      {!tauri ? (
        <div className="launch-preview-note">
          🖥 浏览器预览模式：仅界面预览，启动/停止等服务操作需在桌面应用内使用
        </div>
      ) : null}

      <div className="launch-actions">
        <button
          className="btn-primary"
          disabled={busy}
          onClick={handlePrimary}
          style={{ minWidth: 220 }}
        >
          <span className="btn-shine" />
          {btnText}
        </button>
        {phase === "running" ? (
          <button
            className="btn-secondary"
            onClick={() => navigate("/terminal")}
            title="查看服务日志"
          >
            查看日志
          </button>
        ) : null}
      </div>

      {initialized ? (
        <div className="launch-footer">
          {pnpmPath ? (
            <span className="env-chip">
              pnpm <b>{pnpmPath.split(/[\\/]/).slice(-2).join("/")}</b>
            </span>
          ) : null}
          {dshPath ? (
            <span className="env-chip">
              dsh <b>{dshPath.split(/[\\/]/).slice(-2).join("/")}</b>
            </span>
          ) : null}
          <span className="env-chip">v0.1.0</span>
        </div>
      ) : null}
    </div>
  );
}
