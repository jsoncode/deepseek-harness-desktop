import { Tooltip } from "antd";
import { App as AntApp } from "antd";
import { CopyOutlined, ExportOutlined, HomeOutlined, SyncOutlined } from "@ant-design/icons";
import { useNavigate } from "react-router";
import logo from "../assets/logo.svg";
import WindowControls from "./WindowControls";
import { api } from "../lib/tauri";
import { useAppStore } from "../store/useAppStore";
import { useUiStore } from "../store/useUiStore";
import { maskServiceUrl } from "../lib/urlMask";

/**
 * 顶部标题栏：品牌区（版本号可点击进设置-关于本应用）+ Home 入口 +
 * 服务地址/刷新/复制/浏览器打开 + 窗口控制。
 * 停止/重启服务在底部导航条（BottomBar）；插件管理、通知管理、主题设置、
 * 日志管理等已迁移到设置页（BottomBar 右侧入口进入）。
 * Home 入口：服务已启动跳服务内（预览页），未启动跳预检页（启动页）。
 */
export default function TitleBar() {
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const url = useAppStore((s) => s.url);
  const phase = useAppStore((s) => s.phase);
  const serviceAlive = useAppStore((s) => s.serviceAlive);
  const refreshStatus = useAppStore((s) => s.refreshStatus);
  const bumpReload = useUiStore((s) => s.bumpReload);

  // 刷新：重挂载当前页面（key 纪元 +1）+ 重测环境状态；启动/安装进行中时后端会自动跳过重测
  const handleRefresh = () => {
    bumpReload();
    void refreshStatus();
  };

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
        <span className="titlebar-name">DeepSeek Harness Desktop</span>
        <Tooltip title="关于本应用">
          <button
            type="button"
            className="titlebar-version"
            aria-label="关于本应用"
            onClick={() => navigate("/settings?section=about")}
          >
            {__APP_VERSION__}
          </button>
        </Tooltip>
      </div>

      <div className="titlebar-center">
        {/* Home 入口：服务已启动 → 服务内（预览页）；未启动 → 预检页（启动页） */}
        <Tooltip title={phase === "running" ? "进入应用" : "返回启动页"}>
          <button
            type="button"
            className="icon-btn"
            aria-label="首页"
            onClick={() => navigate(phase === "running" ? "/preview" : "/")}
          >
            <HomeOutlined />
          </button>
        </Tooltip>
        <div className="url-pill">
          <span className={`dot${!url ? " off" : serviceAlive && phase === "running" ? "" : " down"}`} />
          {/* 地址栏展示带 token 的完整地址时对 token 打码；复制/浏览器打开仍用真实地址 */}
          <span className="url-value" title={url ? maskServiceUrl(url) : undefined}>
            {url ? maskServiceUrl(url) : "未检测到服务"}
          </span>
        </div>
        <Tooltip title="刷新（当前页面与环境状态）">
          <button className="icon-btn" type="button" aria-label="刷新" onClick={handleRefresh}>
            <SyncOutlined />
          </button>
        </Tooltip>
        <Tooltip title="复制地址">
          <button className="icon-btn" type="button" aria-label="复制地址" onClick={() => void copyUrl()}>
            <CopyOutlined />
          </button>
        </Tooltip>
        <Tooltip title="在浏览器中打开">
          <button
            className="icon-btn"
            type="button"
            aria-label="在浏览器中打开"
            onClick={() => {
              if (url)
                void api.openInBrowser(url).catch((e) =>
                  message.error(String(e instanceof Error ? e.message : e)),
                );
            }}
          >
            <ExportOutlined />
          </button>
        </Tooltip>
      </div>

      <div className="titlebar-right">
        <WindowControls />
      </div>
    </header>
  );
}
