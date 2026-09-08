import { LogoutOutlined, ReloadOutlined, SettingOutlined } from "@ant-design/icons";
import { useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { nativeConfirm, tauri } from "../lib/tauri";
import { useAppStore } from "../store/useAppStore";

/**
 * 底部导航条：作为 .app-shell（flex 纵向布局）的最后一个元素，
 * 占用页面布局空间并固定在窗口最底部。
 * 左侧为服务级操作：停止服务 / 重启服务；右侧为设置入口
 * （插件管理、通知管理、主题设置、日志管理、系统环境等已迁入设置页）。
 * 提示一律用原生 title 属性、确认用原生对话框——预览页存在原生子 webview，
 * 之上的 DOM 浮层（antd Tooltip/Popconfirm）无法显示。
 */
export default function BottomBar() {
  const navigate = useNavigate();
  const location = useLocation();
  const phase = useAppStore((s) => s.phase);
  const serviceRunning = useAppStore((s) => s.serviceRunning);
  const stop = useAppStore((s) => s.stop);
  const startFlow = useAppStore((s) => s.startFlow);
  const prepareLogSessionTitle = useAppStore((s) => s.prepareLogSessionTitle);
  const [restarting, setRestarting] = useState(false);

  // 设置入口激活态：当前已在设置页
  const inSettings = location.pathname === "/settings";

  // 重启：原生确认后立即切入服务状态页（全屏 loading + 阶段文案，与启动共用，
  // 故文案不含「重启」），先 stop()（杀正在启动的进程树并释放端口，防止新旧进程
  // 端口重叠）再重新启动；就绪跳转预览 / 失败展示重试，均由状态页监听 phase 完成。
  // 日志：stop 结束旧会话后，预置「重启服务」标题，startFlow 会开一条独立日志会话
  const handleRestart = async () => {
    if (restarting) return;
    const ok = await nativeConfirm(
      "确定要重启服务吗？正在浏览的页面会短暂中断。",
      "重启服务",
      "重启",
    );
    if (!ok) return;
    setRestarting(true);
    // 携带 restart 标记：状态页据此把 stopped 阶段文案显示为「正在停止当前服务实例」
    navigate("/loading", { state: { restart: true } });
    void (async () => {
      try {
        await stop();
        prepareLogSessionTitle("重启服务");
        await startFlow();
      } finally {
        // 触发链路已交给 store 事件驱动；忙碌态由 phase 继续约束按钮
        setRestarting(false);
      }
    })();
  };

  // 停止：原生确认后停止服务并回到服务状态页（展示停止态 + 启动入口）
  const handleStop = async () => {
    const ok = await nativeConfirm(
      "确定要停止当前服务吗？停止后需重新启动才能继续访问。",
      "停止服务",
      "停止",
    );
    if (!ok) return;
    void stop();
    navigate("/loading");
  };

  // 「安装中」禁用重启（避免打断安装链路）；「启动中」保留重启/停止能力——
  // 重启会先 stop()（杀正在启动的进程树 + 释放端口）再重新拉起，防止端口重叠
  const installing = phase === "installing";
  const starting = phase === "starting";

  return (
    <footer className="bottombar">
      <div className="bottombar-left">
        <button
          className="icon-btn stop-btn"
          type="button"
          title={
            starting
              ? "启动中，点击可中断并停止"
              : !serviceRunning
                ? "服务未运行"
                : "停止服务"
          }
          aria-label="停止服务"
          disabled={(!serviceRunning && !starting) || restarting}
          onClick={() => void handleStop()}
        >
          <LogoutOutlined />
        </button>

        <button
          className="icon-btn"
          type="button"
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
          aria-label="重启服务"
          disabled={restarting || installing || !tauri}
          onClick={() => void handleRestart()}
        >
          {/* 重启中不旋转方向性图标（避免怪异动效），进度由服务状态页展示 */}
          <ReloadOutlined />
        </button>
      </div>

      <div className="bottombar-right">
        {/* 设置入口：进入设置页（再点一次返回上一页） */}
        <button
          type="button"
          className={"icon-btn" + (inSettings ? " active" : "")}
          title={inSettings ? "返回" : "设置"}
          aria-label="设置"
          aria-pressed={inSettings}
          onClick={() => {
            if (inSettings) navigate(-1);
            else navigate("/settings");
          }}
        >
          <SettingOutlined />
        </button>
      </div>
    </footer>
  );
}
