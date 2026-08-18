import { App as AntApp } from "antd";
import { useNavigate } from "react-router";
import logo from "../assets/logo.svg";
import { ArrowLeftIcon, CopyIcon, ExternalIcon, RefreshIcon } from "./icons";
import ThemeSwitch from "./ThemeSwitch";
import WindowControls from "./WindowControls";
import { api } from "../lib/tauri";
import { useAppStore } from "../store/useAppStore";
import { useUiStore } from "../store/useUiStore";

export default function TitleBar() {
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const url = useAppStore((s) => s.url);
  const bumpReload = useUiStore((s) => s.bumpReload);

  const copyUrl = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      message.success("地址已复制到剪贴板");
    } catch {
      message.error("复制失败");
    }
  };

  return (
    <header className="titlebar">
      <div className="titlebar-left">
        <img src={logo} alt="Harness" draggable={false} className="titlebar-logo" />
        <span className="titlebar-name">Harness Launcher</span>
      </div>

      <div className="titlebar-center">
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
            if (url) void api.openInBrowser(url).catch(() => message.error("打开失败"));
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
