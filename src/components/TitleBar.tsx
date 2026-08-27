import { Tooltip } from "antd";
import { App as AntApp } from "antd";
import { CopyOutlined, ExportOutlined, HomeOutlined, SyncOutlined } from "@ant-design/icons";
import { useNavigate } from "react-router";
import logo from "../assets/logo.svg";
import WindowControls from "./WindowControls";
import { api } from "../lib/tauri";
import { useAppStore } from "../store/useAppStore";
import { useUiStore } from "../store/useUiStore";

/**
 * 顶部标题栏：品牌区 + 服务地址/刷新/浏览器打开 + 窗口控制。
 * 停止/重启服务、查看日志、插件、主题切换已迁移到底部导航条（BottomBar）。
 */
export default function TitleBar() {
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
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
        <span className="titlebar-version">{__APP_VERSION__}</span>
      </div>

      <div className="titlebar-center">
        <Tooltip title="返回启动页">
          <button className="icon-btn" type="button" aria-label="返回启动页" onClick={() => navigate("/")}>
            <HomeOutlined />
          </button>
        </Tooltip>
        <div className="url-pill">
          <span className={`dot${!url ? " off" : serviceAlive && phase === "running" ? "" : " down"}`} />
          <span className="url-value">{url ?? "未检测到服务"}</span>
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
