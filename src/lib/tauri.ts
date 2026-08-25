import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// ---------------------------------------------------------------------------
// 与 Rust 后端通信的桥接层
// ---------------------------------------------------------------------------

/** 是否运行在 Tauri 桌面运行时内（浏览器直接访问 vite dev server 预览时为 false） */
export const tauri = isTauri();

export interface LogLine {
  stream: string; // "system" | "stdout" | "stderr"
  line: string;
}

export interface ExitPayload {
  code: number;
}

export interface UrlPayload {
  url: string;
}

export interface StatusPayload {
  dsh_installed: boolean;
  service_running: boolean;
  child_running: boolean;
  url: string | null;
  pnpm_path: string | null;
  dsh_path: string | null;
  node_path: string | null;
  node_version: string | null;
  pnpm_version: string | null;
  plugins: string[];
  profile_ready: boolean;
}

export const EVENTS = {
  installLog: "dsh://install-log",
  installExit: "dsh://install-exit",
  pluginInstallLog: "dsh://plugin-install-log",
  pluginInstallExit: "dsh://plugin-install-exit",
  pluginOpLog: "dsh://plugin-op-log",
  pluginOpExit: "dsh://plugin-op-exit",
  webLog: "dsh://web-log",
  webExit: "dsh://web-exit",
  url: "dsh://url",
} as const;

/** 浏览器预览模式下的统一提示 */
const NOT_TAURI_MSG = "浏览器预览模式：该操作需在桌面应用内执行";

/** 非 Tauri 环境（浏览器预览）时拒绝调用，避免 invoke 访问 undefined 抛原生 TypeError */
function requireTauri<T>(fn: () => Promise<T>): Promise<T> {
  if (!tauri) return Promise.reject(new Error(NOT_TAURI_MSG));
  return fn();
}

export const api = {
  appStatus: () => requireTauri(() => invoke<StatusPayload>("app_status")),
  probeService: (url: string) => requireTauri(() => invoke<boolean>("probe_service", { url })),
  installDsh: () => requireTauri(() => invoke<void>("install_dsh")),
  startDshWeb: () => requireTauri(() => invoke<void>("start_dsh_web")),
  stopDshWeb: () => requireTauri(() => invoke<void>("stop_dsh_web")),
  openInBrowser: (url: string) => requireTauri(() => invoke<void>("open_in_browser", { url })),
  removePlugin: (name: string) => requireTauri(() => invoke<void>("remove_plugin", { name })),
  installPlugins: () => requireTauri(() => invoke<void>("install_plugins")),
  runPluginOp: (op: string, name: string) =>
    requireTauri(() => invoke<void>("run_plugin_op", { op, name })),
  cancelPluginOp: () => requireTauri(() => invoke<boolean>("cancel_plugin_op")),
};

export async function onEvent<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  if (!tauri) return () => undefined; // 浏览器预览：无事件源，静默跳过
  return listen<T>(event, (e) => handler(e.payload));
}
