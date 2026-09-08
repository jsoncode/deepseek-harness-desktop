import { SyncOutlined } from "@ant-design/icons";
import { useNavigate } from "react-router";
import logo from "../assets/logo.svg";
import WindowControls from "./WindowControls";
import { api } from "../lib/tauri";
import { useAppStore } from "../store/useAppStore";
import { useUiStore } from "../store/useUiStore";
import { maskServiceUrl } from "../lib/urlMask";

/**
 * 顶部标题栏：品牌区（版本号可点击进设置-关于本应用）+ Home 入口 +
 * 服务地址/刷新 + 窗口控制。
 * 停止/重启服务在底部导航条（BottomBar）；插件管理、通知管理、主题设置、
 * 日志管理、系统环境等已迁移到设置页（BottomBar 右侧入口进入）。
 * Home 入口：服务已启动跳服务内（预览页），未启动跳服务状态页（启动过渡页）。
 * 地址栏只读展示（带 token 时打码）；「复制地址」「在浏览器中打开」两个按钮已移除，
 * 需要打开服务地址时走系统托盘菜单的「浏览器中打开」。
 */
export default function TitleBar() {
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

  return (
    <header className="titlebar">
      <div className="titlebar-left">
        <img src={logo} alt="Harness" draggable={false} className="titlebar-logo" />
        <span className="titlebar-name">DeepSeek Harness Desktop</span>
        <button
            type="button"
            className="titlebar-version"
            title="关于本应用"
            aria-label="关于本应用"
            onClick={() =>
              api.openSettings("about").catch(() => navigate("/settings?section=about"))
            }
          >
            {__APP_VERSION__}
        </button>
      </div>

      <div className="titlebar-center">
        {/* Home 入口：服务已启动 → 服务内（预览页）；未启动 → 服务状态页（启动过渡页） */}
        <button
          type="button"
          className="icon-btn"
          title={phase === "running" ? "进入应用" : "服务状态"}
          aria-label="首页"
          onClick={() => navigate(phase === "running" ? "/preview" : "/loading")}
        >
          <img src={logo} alt="" draggable={false} className="titlebar-home-logo" />
        </button>
        <div className="url-pill">
          <span className={`dot${!url ? " off" : serviceAlive && phase === "running" ? "" : " down"}`} />
          {/* 地址栏只读展示：带 token 的完整地址对 token 打码，避免截屏/录屏泄露 */}
          <span className="url-value" title={url ? maskServiceUrl(url) : undefined}>
            {url ? maskServiceUrl(url) : "未检测到服务"}
          </span>
        </div>
        <button className="icon-btn" type="button" title="刷新（当前页面与环境状态）" aria-label="刷新" onClick={handleRefresh}>
          <SyncOutlined />
        </button>
      </div>

      <div className="titlebar-right">
        <WindowControls />
      </div>
    </header>
  );
}
