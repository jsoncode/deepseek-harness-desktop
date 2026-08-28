import { Popconfirm, Tooltip } from "antd";
import { CodeOutlined, LogoutOutlined, ReloadOutlined } from "@ant-design/icons";
import { useState } from "react";
import { useNavigate } from "react-router";
import PluginManager from "./PluginManager";
import NotifyToggle from "./NotifyToggle";
import ThemeSwitch from "./ThemeSwitch";
import { tauri } from "../lib/tauri";
import { useAppStore } from "../store/useAppStore";

/**
 * 底部导航条：作为 .app-shell（flex 纵向布局）的最后一个元素，
 * 占用页面布局空间并固定在窗口最底部。
 * 左侧集中服务级操作：停止服务 / 重启服务 / 查看日志 / 插件 / 系统推送开关 / 主题切换。
 */
export default function BottomBar() {
  const navigate = useNavigate();
  const phase = useAppStore((s) => s.phase);
  const serviceRunning = useAppStore((s) => s.serviceRunning);
  const stop = useAppStore((s) => s.stop);
  const startFlow = useAppStore((s) => s.startFlow);
  const [restarting, setRestarting] = useState(false);

  // 重启：立即切入重启过渡页（全屏 loading + 阶段文案），
  // 先 stop()（杀正在启动的进程树并释放端口，防止新旧进程端口重叠）再重新启动；
  // 就绪跳转预览 / 失败展示重试，均由重启页监听 phase 完成。
  const handleRestart = () => {
    if (restarting) return;
    setRestarting(true);
    navigate("/restarting");
    void (async () => {
      try {
        await stop();
        await startFlow();
      } finally {
        // 触发链路已交给 store 事件驱动；忙碌态由 phase 继续约束按钮
        setRestarting(false);
      }
    })();
  };

  // 停止：确认后停止服务并回到启动页
  const handleStop = () => {
    void stop();
    navigate("/");
  };

  // 「安装中」禁用重启（避免打断安装链路）；「启动中」保留重启/停止能力——
  // 重启会先 stop()（杀正在启动的进程树 + 释放端口）再重新拉起，防止端口重叠
  const installing = phase === "installing";
  const starting = phase === "starting";

  return (
    <footer className="bottombar">
      <div className="bottombar-left">
        {/* 危险操作改用 Popconfirm 轻确认（topLeft：气泡在按钮上方、左对齐）；
            置灰时不弹气泡，由内层 Tooltip 提示原因 */}
        <Popconfirm
          title="停止服务"
          description="确定要停止当前服务吗？停止后需重新启动才能继续访问。"
          okText="停止"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          placement="topLeft"
          disabled={(!serviceRunning && !starting) || restarting}
          onConfirm={handleStop}
        >
          <Tooltip title={starting ? "启动中，点击可中断并停止" : !serviceRunning ? "服务未运行" : "停止服务"}>
            {/* 停止键外包 span：保证 disabled 时外层气泡仍能触发 */}
            <span className="tip-wrap">
              <button
                className="icon-btn stop-btn"
                type="button"
                aria-label="停止服务"
                disabled={(!serviceRunning && !starting) || restarting}
              >
                <LogoutOutlined />
              </button>
            </span>
          </Tooltip>
        </Popconfirm>

        <Popconfirm
          title="重启服务"
          description="确定要重启服务吗？正在浏览的页面会短暂中断。"
          okText="重启"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          placement="topLeft"
          disabled={restarting || installing || !tauri}
          onConfirm={handleRestart}
        >
          <Tooltip
            title={
              !tauri
                ? "浏览器预览模式不可用"
                : installing
                  ? "安装进行中，请稍候"
                  : starting
                    ? "启动中，点击将中断当前启动并重新启动"
                    : restarting
                      ? "正在重启…"
                      : "重启服务"
            }
          >
            <button
              className="icon-btn"
              type="button"
              aria-label="重启服务"
              disabled={restarting || installing || !tauri}
            >
              {/* 重启中不旋转方向性图标（避免怪异动效），进度由重启过渡页展示 */}
              <ReloadOutlined />
            </button>
          </Tooltip>
        </Popconfirm>

        <Tooltip title="查看日志">
          <button className="icon-btn" type="button" aria-label="查看日志" onClick={() => navigate("/terminal")}>
            <CodeOutlined />
          </button>
        </Tooltip>
        <PluginManager />
        <NotifyToggle />
        <ThemeSwitch />
      </div>
    </footer>
  );
}