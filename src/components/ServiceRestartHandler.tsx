import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { EVENTS, onEvent, tauri } from "../lib/tauri";
import { useAppStore } from "../store/useAppStore";

/**
 * 服务重启请求处理（仅主窗口渲染，见 App.tsx）。
 *
 * 设置窗口里的弹框——模型代理启用后、插件安装/更新/卸载后——只发
 * `dsh://restart-request`（Rust 命令 `request_service_restart`），真正的重启在
 * 主窗口执行：重启涉及主窗口的状态机（phase）、日志会话切分与「跳服务状态页」，
 * 两个窗口各跑一套会打架。
 *
 * 流程与底部导航条的「重启服务」完全一致：切到服务状态页（带 restart 标记）→
 * stop()（杀进程树 + 释放端口）→ 预置「重启服务」日志标题 → startFlow()。
 */
export default function ServiceRestartHandler() {
  const navigate = useNavigate();
  const stop = useAppStore((s) => s.stop);
  const startFlow = useAppStore((s) => s.startFlow);
  const prepareLogSessionTitle = useAppStore((s) => s.prepareLogSessionTitle);
  /** 重启进行中：重复请求（连续两次弹框确认）只执行一次 */
  const busy = useRef(false);

  useEffect(() => {
    if (!tauri) return;
    let dispose: (() => void) | undefined;
    let alive = true;
    void onEvent(EVENTS.restartRequest, () => {
      if (busy.current) return;
      busy.current = true;
      navigate("/loading", { state: { restart: true } });
      void (async () => {
        try {
          await stop();
          prepareLogSessionTitle("重启服务");
          await startFlow();
        } finally {
          busy.current = false;
        }
      })();
    }).then((off) => {
      if (alive) dispose = off;
      else off();
    });
    return () => {
      alive = false;
      dispose?.();
    };
  }, [navigate, prepareLogSessionTitle, startFlow, stop]);

  return null;
}
