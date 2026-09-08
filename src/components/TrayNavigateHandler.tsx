import { useEffect } from "react";
import { useNavigate } from "react-router";
import { EVENTS, onEvent } from "../lib/tauri";

/**
 * 托盘「设置/分区」菜单处理器（挂在 HashRouter 内、任何路由下都保持挂载）：
 * 用户点击托盘菜单项后，Rust 侧先恢复主窗口，再 emit `dsh://tray-navigate`
 * 携带目标 hash 路由（如 /settings?section=logs），这里直接跳转。
 * 设置页已挂载时由其 `?section=` 同步逻辑切换选中菜单。
 */
export default function TrayNavigateHandler() {
  const navigate = useNavigate();

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onEvent<{ path: string }>(EVENTS.trayNavigate, (p) => {
      if (p?.path) navigate(p.path);
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [navigate]);

  return null;
}
