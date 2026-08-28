import { App as AntApp } from "antd";
import { useEffect, useRef } from "react";
import { api } from "../lib/tauri";
import { useAppStore } from "../store/useAppStore";
import { useUiStore } from "../store/useUiStore";

/**
 * 插件加载失败弹框：dsh web 前端在插件 bundle 加载/注册失败时会渲染
 * "Failed to load plugins" 失败界面（不推送事件），由注入到 iframe 内的
 * PLUGIN_FAILURE_BRIDGE 脚本监听该 DOM 并经 postMessage 上报；
 * Preview 页收到后写入 store.pluginLoadError，本组件弹框提示用户：
 * 确认 → 从 .dsh\profiles\web\package.json 移除插件并重启服务。
 */
export default function PluginFailureModal() {
  const { modal, message } = AntApp.useApp();
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
  }, [pluginLoadError]);

  return null;
}
