import { App as AntApp } from "antd";
import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router";
import { api } from "../lib/tauri";
import { useAppStore } from "../store/useAppStore";
import { useUiStore } from "../store/useUiStore";

/**
 * 插件加载失败弹框：dsh web 前端在插件 bundle 加载/注册失败时会渲染
 * "Failed to load plugins" 失败界面（不推送事件），由注入到 preview 子 webview
 * 的 PLUGIN_FAILURE_BRIDGE 脚本监听该 DOM 并经 preview_bridge_report 命令上报
 * （Rust 侧转发 dsh://preview-plugin-failed 事件）；Preview 页收到后写入
 * store.pluginLoadError，本组件弹框提示用户：
 * 确认 → 从 .dsh\profiles\web\package.json 移除插件并重启服务。
 * 弹框是 DOM 浮层、无法显示在原生子 webview 之上——当前在预览页时先离开再弹。
 */
export default function PluginFailureModal() {
  const { modal, message } = AntApp.useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const pluginLoadError = useAppStore((s) => s.pluginLoadError);
  const clearPluginLoadError = useAppStore((s) => s.clearPluginLoadError);
  const stop = useAppStore((s) => s.stop);
  const startFlow = useAppStore((s) => s.startFlow);
  const prepareLogSessionTitle = useAppStore((s) => s.prepareLogSessionTitle);
  const bumpReload = useUiStore((s) => s.bumpReload);
  const shownFor = useRef<string | null>(null);

  useEffect(() => {
    const err = pluginLoadError;
    if (!err || shownFor.current === err.name) return;
    shownFor.current = err.name;
    // 预览页的原生子 webview 会盖住 antd 弹框：先回启动页再弹（shownFor 防重复弹）
    if (location.pathname === "/preview") navigate("/", { replace: true });
    modal.confirm({
      title: "插件加载失败",
      content: (
        <div className="plugin-fail-content">
          <p className="plugin-fail-ask">
            <b>{err.name}</b> 插件报错，是否移除并重新启动？
          </p>
          <pre className="plugin-fail-msg">{err.message}</pre>
        </div>
      ),
      okText: "移除并重启",
      okButtonProps: { danger: true },
      cancelText: "暂不处理",
      width: 520,
      onOk: async () => {
        try {
          await api.removePlugin(err.name);
          message.success(`已移除插件 ${err.name}，正在重启服务…`);
          await stop();
          bumpReload();
          prepareLogSessionTitle("重启服务");
          void startFlow();
        } catch (e) {
          message.error(`移除插件失败：${e instanceof Error ? e.message : String(e)}`);
        } finally {
          shownFor.current = null;
          clearPluginLoadError();
        }
      },
      onCancel: () => {
        shownFor.current = null;
        clearPluginLoadError();
      },
      afterClose: () => {
        shownFor.current = null;
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pluginLoadError, location.pathname]);

  return null;
}
