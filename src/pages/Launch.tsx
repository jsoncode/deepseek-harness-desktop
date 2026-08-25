import { useEffect, type ReactNode } from "react";
import { useNavigate } from "react-router";
import logo from "../assets/logo.svg";
import { tauri } from "../lib/tauri";
import { useAppStore } from "../store/useAppStore";

/** 环境要求：Node.js ≥ 22.19 */
const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 19;

function parseNodeVersion(v: string | null): { major: number; minor: number } | null {
  if (!v) return null;
  const m = /^(\d+)\.(\d+)/.exec(v);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]) };
}

function meetsNodeRequirement(version: string | null): boolean {
  const parsed = parseNodeVersion(version);
  if (!parsed) return false;
  return (
    parsed.major > MIN_NODE_MAJOR ||
    (parsed.major === MIN_NODE_MAJOR && parsed.minor >= MIN_NODE_MINOR)
  );
}

interface EnvRow {
  name: string;
  state: "ok" | "bad" | "warn";
  detail: ReactNode;
}

export default function Launch() {
  const navigate = useNavigate();
  const { phase, url, dshInstalled, pnpmPath, dshPath, initialized, init, refreshStatus } =
    useAppStore();
  const nodePath = useAppStore((s) => s.nodePath);
  const nodeVersion = useAppStore((s) => s.nodeVersion);
  const pnpmVersion = useAppStore((s) => s.pnpmVersion);

  useEffect(() => {
    if (!initialized) {
      void init();
    } else {
      void refreshStatus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const busy = phase === "checking" || phase === "installing" || phase === "starting";

  // ---- 环境判定 ----
  const nodeOk = meetsNodeRequirement(nodeVersion);
  const pnpmOk = Boolean(pnpmPath);
  const envAllOk = nodeOk && pnpmOk; // dsh 未安装不阻断（会自动安装）
  // 仅主按钮会触发启动流程的状态才阻断；运行中"打开应用"、浏览器预览模式不受影响
  const startGated =
    tauri && !envAllOk && (phase === "idle" || phase === "stopped" || phase === "error");
  // 阻断时红框；服务运行中发现环境变化仅黄框提醒，不阻断
  const cardState = startGated ? "bad" : envAllOk ? "" : "warn";

  // ---- 环境检查行 ----
  const envRows: EnvRow[] = [];
  if (!tauri) {
    envRows.push({
      name: "运行环境",
      state: "warn",
      detail: "浏览器预览模式：环境检查需在桌面应用内进行",
    });
  } else {
    if (nodeOk) {
      envRows.push({ name: "Node.js", state: "ok", detail: <>已安装 v{nodeVersion}</> });
    } else if (!nodePath) {
      envRows.push({
        name: "Node.js",
        state: "bad",
        detail: <>未检测到 Node.js，请安装 LTS 版本（≥ 22.19）：https://nodejs.org/</>,
      });
    } else if (!nodeVersion) {
      envRows.push({
        name: "Node.js",
        state: "bad",
        detail: <>已找到 Node 但无法读取版本，建议重新安装 LTS 版本</>,
      });
    } else {
      envRows.push({
        name: "Node.js",
        state: "bad",
        detail: <>当前 v{nodeVersion}，低于要求的 22.19，请升级后重启本应用</>,
      });
    }

    envRows.push(
      pnpmOk
        ? {
            name: "pnpm",
            state: "ok",
            detail: pnpmVersion ? <span>已安装 v{pnpmVersion}</span> : <span>已安装</span>,
          }
        : {
            name: "pnpm",
            state: "bad",
            detail: (
              <span>未检测到 pnpm，请执行 npm install -g pnpm（https://pnpm.io/zh-CN/installation）</span>
            ),
          },
    );

    envRows.push(
      dshInstalled
        ? { name: "dsh CLI", state: "ok", detail: <span>已安装</span> }
        : {
            name: "dsh CLI",
            state: "warn",
            detail: <span>未安装 · 首次启动时自动安装 @deepseek-ai/dsh</span>,
          },
    );
  }

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

      {initialized ? (
        <div className={`env-card ${cardState}`.trimEnd()}>
          {envRows.map((r) => (
            <div key={r.name} className="env-row">
              <span className={`env-mark ${r.state}`}>
                {r.state === "ok" ? "✓" : r.state === "warn" ? "○" : "✗"}
              </span>
              <span className="env-name">{r.name}</span>
              <span className="env-detail">{r.detail}</span>
            </div>
          ))}
          {startGated ? (
            <div className="env-hint">请先修复以上环境问题，修复后重启本应用再启动服务</div>
          ) : null}
        </div>
      ) : null}

      {!tauri ? (
        <div className="launch-preview-note">
          🖥 浏览器预览模式：仅界面预览，启动/停止等服务操作需在桌面应用内使用
        </div>
      ) : null}

      <div className="launch-actions">
        <button
          className="btn-primary"
          disabled={busy || startGated}
          onClick={handlePrimary}
          style={{ minWidth: 220 }}
        >
          <span className="btn-shine" />
          {btnText}
        </button>
      </div>

      {initialized ? (
        <div className="launch-footer">
          {nodeVersion ? (
            <span className="env-chip">
              node <b>v{nodeVersion}</b>
            </span>
          ) : null}
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
