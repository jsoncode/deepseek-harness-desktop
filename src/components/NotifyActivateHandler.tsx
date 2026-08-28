import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router";
import { EVENTS, onEvent, type NotifyActivatePayload } from "../lib/tauri";
import { useAppStore } from "../store/useAppStore";
import { useUiStore } from "../store/useUiStore";

/**
 * 系统通知点击处理器（挂在 HashRouter 内、任何路由下都保持挂载）：
 * 用户点击 toast 的「打开对话」后，Rust 侧 emit `dsh://notify-activate`
 * （窗口已由 Rust 恢复到前台）。这里把会话 id 暂存进 useUiStore 并切到预览页；
 * Preview 负责在 iframe 就绪后把它 postMessage 给预览 iframe
 * （SESSION_OPEN_BRIDGE），由其在 dsh web 内打开对应会话的对话框。
 *
 * 点到 toast 正文（sessionId 为 null）只回预览页，不指定会话。
 */
export default function NotifyActivateHandler() {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void onEvent<NotifyActivatePayload>(EVENTS.notifyActivate, (payload) => {
      const { url, phase } = useAppStore.getState();
      // 服务不在预览态（如刚停止）时忽略：窗口已被恢复，仅此而已
      if (!url || phase !== "running") return;
      // HashRouter 下 window.location.pathname 不是 hash 路由，用 useLocation
      if (location.pathname !== "/preview") navigate("/preview");
      if (!payload.sessionId) return; // 点到 toast 正文：只回预览页
      useUiStore.getState().requestOpenSession(payload.sessionId);
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [navigate, location.pathname]);

  return null;
}
