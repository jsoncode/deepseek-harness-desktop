import { Tooltip } from "antd";
import { App as AntApp } from "antd";
import {
  ArrowLeftOutlined,
  CodeOutlined,
  CopyOutlined,
  ExportOutlined,
  ReloadOutlined,
  StopOutlined,
  SyncOutlined,
} from "@ant-design/icons";
import { useState } from "react";
import { useNavigate } from "react-router";
import logo from "../assets/logo.svg";
import ThemeSwitch from "./ThemeSwitch";
import WindowControls from "./WindowControls";
import { api } from "../lib/tauri";
import { useAppStore } from "../store/useAppStore";
import { useUiStore } from "../store/useUiStore";

export default function TitleBar() {
  const navigate = useNavigate();
  const { message, modal } = AntApp.useApp();
  const url = useAppStore((s) => s.url);
  const phase = useAppStore((s) => s.phase);
  const serviceRunning = useAppStore((s) => s.serviceRunning);
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

  // 危险操作统一弹框确认后再执行
  const confirmRestart = () => {
    modal.confirm({
      title: "重启服务",
      content: "确定要重启服务吗？正在浏览的页面会短暂中断。",
      okText: "重启",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: () => void handleRestart(),
    });
  };

  const confirmStop = () => {
    modal.confirm({
      title: "停止服务",
      content: "确定要停止当前服务吗？停止后需重新启动才能继续访问。",
      okText: "停止",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: () => {
        void stop();
        navigate("/");
      },
    });
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
        {/* 停止键外包 span：antd 对 disabled 按钮不弹气泡，包裹层保证置灰时也能提示原因 */}
        <Tooltip title={!serviceRunning ? "服务未运行" : "停止服务"}>
          <span className="tip-wrap">
            <button
              className="icon-btn stop-btn"
              type="button"
              aria-label="停止服务"
              disabled={!serviceRunning || restarting}
              onClick={confirmStop}
            >
              <StopOutlined />
            </button>
          </span>
        </Tooltip>
        <Tooltip title="重启服务">
          <button
            className="icon-btn"
            type="button"
            aria-label="重启服务"
            disabled={restarting || busy}
            onClick={confirmRestart}
          >
            {/* 重启中不旋转方向性图标（避免怪异动效），loading 状态由消息气泡提示 */}
            <ReloadOutlined />
          </button>
        </Tooltip>
        <Tooltip title="查看日志">
          <button
            className="icon-btn"
            type="button"
            aria-label="查看日志"
            onClick={() => navigate("/terminal")}
          >
            <CodeOutlined />
          </button>
        </Tooltip>
        <Tooltip title="返回启动页">
          <button className="icon-btn" type="button" aria-label="返回启动页" onClick={() => navigate("/")}>
            <ArrowLeftOutlined />
          </button>
        </Tooltip>
        <div className="url-pill">
          <span className="dot" />
          <span className="url-value">{url ?? "未检测到服务"}</span>
        </div>
        <Tooltip title="刷新">
          <button className="icon-btn" type="button" aria-label="刷新" onClick={bumpReload}>
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
        <ThemeSwitch />
        <WindowControls />
      </div>
    </header>
  );
}
