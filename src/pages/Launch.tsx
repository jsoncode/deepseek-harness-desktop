import { useEffect, useRef, type ReactNode } from "react";
import { useNavigate } from "react-router";
import logo from "../assets/logo.svg";
import { meetsNodeRequirement } from "../lib/envReq";
import { tauri } from "../lib/tauri";
import { useAppStore } from "../store/useAppStore";

interface EnvRow {
  name: string;
  state: "ok" | "bad" | "warn";
  detail: ReactNode;
}

export default function Launch() {
  const navigate = useNavigate();
  const {
    phase,
    url,
    dshInstalled,
    dshVersion,
    pnpmPath,
    plugins,
    initialized,
    init,
    refreshStatus,
    envInstallTool,
    installEnvAndStart,
  } = useAppStore();
  const nodePath = useAppStore((s) => s.nodePath);
  const nodeVersion = useAppStore((s) => s.nodeVersion);
  const pnpmVersion = useAppStore((s) => s.pnpmVersion);
  const startFlow = useAppStore((s) => s.startFlow);

  useEffect(() => {
    if (!initialized) {
      void init();
    } else {
      void refreshStatus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 用户点击启动/安装后（starting → running）自动进入预览页；
  // 进入页面时服务已在运行/已在启动（非本次点击触发）则不跳转，避免打断查看启动页信息
  const prevPhase = useRef(phase);
  const startedHere = useRef(false);
  useEffect(() => {
    const prev = prevPhase.current;
    prevPhase.current = phase;
    if (startedHere.current && phase === "running" && prev === "starting") {
      const t = setTimeout(() => navigate("/preview"), 1200);
      return () => clearTimeout(t);
    }
  }, [phase, navigate]);

  const busy = phase === "checking" || phase === "installing" || phase === "starting";

  // ---- 环境判定 ----
  const nodeOk = meetsNodeRequirement(nodeVersion);
  const pnpmOk = Boolean(pnpmPath);
  // 任一依赖缺失（node / pnpm / dsh）→ 主按钮变为「安装」：全自动依次安装后自动启动并打开
  const needsInstall = Boolean(tauri) && !(nodeOk && pnpmOk && dshInstalled);
  // 缺依赖时环境卡片黄框提醒（不再阻断按钮）；全部就绪为默认样式
  const cardState = !tauri ? "" : needsInstall ? "warn" : "";

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
        detail: <>未检测到 · 点击「安装」将自动安装 LTS 版本（≥ 22.19：Windows 走 winget / macOS 走 Homebrew）</>,
      });
    } else if (!nodeVersion) {
      envRows.push({
        name: "Node.js",
        state: "bad",
        detail: <>已找到 Node 但无法读取版本，点击「安装」尝试修复</>,
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
            detail: <span>未检测到 · 点击「安装」将通过 npm 自动全局安装</span>,
          },
    );

    envRows.push(
      dshInstalled
        ? {
            name: "dsh CLI",
            state: "ok",
            detail: dshVersion ? <span>已安装 v{dshVersion}</span> : <span>已安装</span>,
          }
        : {
            name: "dsh CLI",
            state: "warn",
            detail: <span>未安装 · 点击「安装」将自动全局安装 @deepseek-ai/dsh</span>,
          },
    );
  }

  let statusText: ReactNode;
  let statusClass = "launch-status";
  if (phase === "checking") {
    statusText = "正在检测运行环境…";
    statusClass += " busy";
  } else if (phase === "installing") {
    statusText =
      envInstallTool === "node"
        ? "正在安装 Node.js LTS…"
        : envInstallTool === "pnpm"
          ? "正在安装 pnpm…"
          : "正在安装 @deepseek-ai/dsh…";
    statusClass += " busy";
  } else if (phase === "starting") {
    statusText = "正在启动本地服务…";
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
    statusText = "操作失败，请检查终端日志";
    statusClass += " error";
  } else if (phase === "stopped") {
    statusText = "服务已停止";
  } else {
    statusText = needsInstall
      ? "检测到缺失依赖 · 点击「安装」自动配置并启动"
      : "环境就绪 · 点击启动本地服务";
  }

  const handlePrimary = () => {
    if (phase === "running") {
      navigate("/preview");
      return;
    }
    if (!tauri) {
      // 浏览器预览模式：无后端，跳转终端页展示说明
      navigate("/terminal");
      return;
    }
    startedHere.current = true;
    if (needsInstall) {
      void installEnvAndStart();
    } else {
      void startFlow();
    }
  };

  let btnText = needsInstall ? "安装" : "启动应用";
  if (phase === "checking") btnText = "检测中…";
  else if (phase === "running") btnText = "打开应用";
  else if (phase === "installing")
    btnText =
      envInstallTool === "node"
        ? "安装 Node.js…"
        : envInstallTool === "pnpm"
          ? "安装 pnpm…"
          : "安装中…";
  else if (phase === "starting") btnText = "启动中…";
  else if (phase === "error" || phase === "stopped") btnText = needsInstall ? "安装" : "重新启动";

  return (
    <div className="page launch">
      <div className="launch-logo-wrap">
        <div className="launch-logo">
          <img src={logo} alt="Harness Logo" draggable={false} />
        </div>
      </div>

      <h1 className="launch-title">DeepSeek Harness Desktop</h1>

      <div className={statusClass}>
        <span className="dot" />
        <span>{statusText}</span>
      </div>

      {initialized ? (
        <div className={"env-card" + (cardState ? " " + cardState : "")}>
          {envRows.map((r) => (
            <div key={r.name} className="env-row">
              <span className={"env-mark " + r.state}>
                {r.state === "ok" ? "✓" : r.state === "warn" ? "○" : "✗"}
              </span>
              <span className="env-name">{r.name}</span>
              <span className="env-detail">{r.detail}</span>
            </div>
          ))}
          {tauri ? (
            <>
              <div className="env-section-title">Plugins</div>
              <div className="plugin-tags">
                {plugins.map((p) => (
                  <span key={p} className="plugin-tag">
                    {p}
                  </span>
                ))}
              </div>
              {plugins.length === 0 ? <div className="plugin-empty">暂无用户插件</div> : null}
            </>
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
          disabled={busy}
          onClick={handlePrimary}
          style={{ minWidth: 220 }}
        >
          <span className="btn-shine" />
          {btnText}
        </button>
      </div>
    </div>
  );
}