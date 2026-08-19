import { App as AntApp } from "antd";
import { useState } from "react";
import { useNavigate } from "react-router";
import logo from "../assets/logo.svg";
import { ArrowLeftIcon, CopyIcon, ExternalIcon, RefreshIcon, RestartIcon } from "./icons";
import ThemeSwitch from "./ThemeSwitch";
import WindowControls from "./WindowControls";
import { api } from "../lib/tauri";
import { useAppStore } from "../store/useAppStore";
import { useUiStore } from "../store/useUiStore";

export default function TitleBar() {
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const url = useAppStore((s) => s.url);
  const phase = useAppStore((s) => s.phase);
  const stop = useAppStore((s) => s.stop);
  const startFlow = useAppStore((s) => s.startFlow);
  const bumpReload = useUiStore((s) => s.bumpReload);
  const [restarting, setRestarting] = useState(false);

  const copyUrl = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      message.success("地址已复制到剪贴板");
    } catch {
      message.error("复制失败");
    }
  };

  // 重启：停止当前服务 → 重新启动 → 自动刷新已加载的页面
  const handleRestart = async () => {
    if (restarting) return;
    setRestarting(true);
    message.open({ type: "loading", content: "正在重启服务…", key: "restart", duration: 0 });
    try {
      await stop();
      await startFlow();
      bumpReload();
      message.success({ content: "服务已重新启动", key: "restart" });
    } catch (e) {
      message.error({ content: `重启失败：${String(e)}`, key: "restart" });
    } finally {
      setRestarting(false);
    }
  };

  // 安装/启动过程中禁用重启按钮，避免重复触发
  const busy = phase === "installing" || phase === "starting";

  return (
    <header className="titlebar">
      <div className="titlebar-left">
        <img src={logo} alt="Harness" draggable={false} className="titlebar-logo" />
        <span className="titlebar-name">DeepSeek Harness Desktop</span>
      </div>

      <div className="titlebar-center">
        <button
          className={`icon-btn restart-btn${restarting ? " restarting" : ""}`}
          type="button"
          title="重启服务"
          aria-label="重启服务"
          disabled={restarting || busy}
          onClick={() => void handleRestart()}
        >
          {/* 重启中：显示小号加载环，不旋转方向性箭头图标（避免怪异动效） */}
          {restarting ? <span className="btn-spinner" aria-hidden="true" /> : <RestartIcon />}
        </button>
        <button className="icon-btn" type="button" title="返回启动页" aria-label="返回启动页" onClick={() => navigate("/")}>
          <ArrowLeftIcon />
        </button>
        <div className="url-pill">
          <span className="dot" />
          <span className="url-value">{url ?? "未检测到服务"}</span>
        </div>
        <button className="icon-btn" type="button" title="刷新" aria-label="刷新" onClick={bumpReload}>
          <RefreshIcon />
        </button>
        <button className="icon-btn" type="button" title="复制地址" aria-label="复制地址" onClick={() => void copyUrl()}>
          <CopyIcon />
        </button>
        <button
          className="icon-btn"
          type="button"
          title="在浏览器中打开"
          aria-label="在浏览器中打开"
          onClick={() => {
            if (url)
              void api.openInBrowser(url).catch((e) =>
                message.error(String(e instanceof Error ? e.message : e)),
              );
          }}
        >
          <ExternalIcon />
        </button>
      </div>

      <div className="titlebar-right">
        <ThemeSwitch />
        <WindowControls />
      </div>
    </header>
  );
}
