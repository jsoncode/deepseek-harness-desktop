import { useEffect, type ReactNode } from "react";
import { useNavigate } from "react-router";
import logo from "../assets/logo.svg";
import { meetsNodeRequirement, pnpmMajorOf } from "../lib/envReq";
import { tauri } from "../lib/tauri";
import { maskServiceUrl } from "../lib/urlMask";
import { useAppStore } from "../store/useAppStore";

interface EnvRow {
  name: string;
  state: "ok" | "bad" | "warn" | "loading";
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
  // 逐项检测完成标记：false = 该项仍在检测中（行内显示 loading）
  const envCheckDone = useAppStore((s) => s.envCheckDone);

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
  // pnpm ≥11 使用隔离的全局虚拟仓库布局，dsh 与其不兼容（点击按钮可一键降级到 pnpm 10）
  const pnpm11 = pnpmMajorOf(pnpmVersion) >= 11;
  // 任一依赖缺失（node / pnpm / dsh）或 pnpm ≥11 → 主按钮变为「安装/降级」：全自动处理后启动
  const needsInstall = Boolean(tauri) && !(nodeOk && pnpmOk && dshInstalled && !pnpm11);
  // 缺依赖时环境卡片黄框提醒（不再阻断按钮）；全部就绪为默认样式；
  // 检测中不套黄框（此时值尚未落定，避免误报缺失）
  const cardState = !tauri ? "" : phase === "checking" ? "" : needsInstall ? "warn" : "";

  // ---- 环境检查行（逐项检测：未完成的行显示 loading，完成后点亮结果）----
  const envRows: EnvRow[] = [];
  if (!tauri) {
    envRows.push({
      name: "运行环境",
      state: "warn",
      detail: "浏览器预览模式：环境检查需在桌面应用内进行",
    });
  } else {
    if (!envCheckDone.node) {
      envRows.push({ name: "Node.js", state: "loading", detail: <span>检测中…</span> });
    } else if (nodeOk) {
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
      !envCheckDone.pnpm
        ? { name: "pnpm", state: "loading", detail: <span>检测中…</span> }
        : pnpmOk
          ? {
              name: "pnpm",
              state: pnpm11 ? "warn" : "ok",
              detail: pnpmVersion ? (
                <span>
                  已安装 v{pnpmVersion}
                  {pnpm11 ? <span className="env-warn-text">（dsh不支持pnpm11）</span> : null}
                </span>
              ) : (
                <span>已安装</span>
              ),
            }
          : {
              name: "pnpm",
              state: "bad",
              detail: <span>未检测到 · 点击「安装」将自动全局安装 pnpm@10（dsh 不支持 pnpm 11）</span>,
            },
    );

    envRows.push(
      !envCheckDone.dsh
        ? { name: "dsh CLI", state: "loading", detail: <span>检测中…</span> }
        : dshInstalled
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
        {/* 地址展示对 token 打码；点击「打开应用」进入预览页时使用真实地址 */}
        {url ? <span className="url-text">{maskServiceUrl(url)}</span> : null}
      </>
    );
    statusClass += " running";
  } else if (phase === "error") {
    statusText = "操作失败，请检查终端日志";
    statusClass += " error";
  } else if (phase === "stopped") {
    statusText = "服务已停止";
  } else {
    statusText = pnpm11
      ? "检测到 pnpm 11 · 点击「降级 pnpm 10」自动降级并启动（dsh 不支持 pnpm 11）"
      : needsInstall
        ? "检测到缺失依赖 · 点击「安装」自动配置并启动"
        : "环境就绪 · 点击启动本地服务";
  }

  const handlePrimary = () => {
    if (phase === "running") {
      navigate("/preview");
      return;
    }
    if (!tauri) {
      // 浏览器预览模式：无后端，跳转设置页日志管理查看当前会话日志
      navigate("/settings?section=logs");
      return;
    }
    // 统一切入启动过渡页：所有启动操作（含安装/降级）都在 loading 页等待，
    // 不再停留在检查页，避免启动页与服务状态两处渲染造成的状态不同步
    navigate("/loading");
    if (needsInstall) {
      void installEnvAndStart();
    } else {
      void startFlow();
    }
  };

  // 启动/安装进行中不允许停留在检查页（如重开应用时服务仍在启动、
  // 插件失败弹框触发的重启）：统一切到启动过渡页，由它监听 phase 完成跳转，
  // 保证「启动中」的展示只有 loading 页一处来源
  useEffect(() => {
    if (phase === "installing" || phase === "starting") {
      navigate("/loading", { replace: true });
    }
  }, [phase, navigate]);

  let btnText = pnpm11 ? "降级 pnpm 10" : needsInstall ? "安装" : "启动应用";
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

      {/* 检测中即渲染环境卡片：逐行 loading 展示进度，结果逐项点亮；
          app_status 收尾（initialized）后再展示插件列表 */}
      {initialized || phase === "checking" ? (
        <div className={"env-card" + (cardState ? " " + cardState : "")}>
          {envRows.map((r) => (
            <div key={r.name} className="env-row">
              <span className={"env-mark " + r.state}>
                {r.state === "ok" ? "✓" : r.state === "warn" ? "○" : r.state === "bad" ? "✗" : <span className="env-spinner" />}
              </span>
              <span className="env-name">{r.name}</span>
              <span className={"env-detail" + (r.state === "loading" ? " loading" : "")}>{r.detail}</span>
            </div>
          ))}
          {tauri && initialized ? (
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
        {busy && phase !== "checking" ? (
          <button className="btn-secondary" type="button" onClick={() => navigate("/settings?section=logs")}>
            查看日志
          </button>
        ) : null}
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