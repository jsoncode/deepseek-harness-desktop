import { Tooltip } from "antd";
import { App as AntApp } from "antd";
import { CodeOutlined, LogoutOutlined, ReloadOutlined } from "@ant-design/icons";
import { useState } from "react";
import { useNavigate } from "react-router";
import PluginManager from "./PluginManager";
import ThemeSwitch from "./ThemeSwitch";
import { useAppStore } from "../store/useAppStore";
import { useUiStore } from "../store/useUiStore";

/**
 * 底部导航条：作为 .app-shell（flex 纵向布局）的最后一个元素，
 * 占用页面布局空间并固定在窗口最底部。
 * 左侧集中服务级操作：停止服务 / 重启服务 / 查看日志 / 插件 / 主题切换。
 */
export default function BottomBar() {
  const navigate = useNavigate();
  const { message, modal } = AntApp.useApp();
  const phase = useAppStore((s) => s.phase);
  const serviceRunning = useAppStore((s) => s.serviceRunning);
  const stop = useAppStore((s) => s.stop);
  const startFlow = useAppStore((s) => s.startFlow);
  const bumpReload = useUiStore((s) => s.bumpReload);
  const [restarting, setRestarting] = useState(false);

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
    <footer className="bottombar">
      <div className="bottombar-left">
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
              <LogoutOutlined />
            </button>
          </span>
        </Tooltip>
        <Tooltip title={busy ? "安装/启动进行中" : restarting ? "正在重启…" : "重启服务"}>
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
          <button className="icon-btn" type="button" aria-label="查看日志" onClick={() => navigate("/terminal")}>
            <CodeOutlined />
          </button>
        </Tooltip>
        <PluginManager />
        <ThemeSwitch />
      </div>
    </footer>
  );
}
