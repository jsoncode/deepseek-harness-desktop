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

/** 插件版本基础信息（latest 由前端直查 npm registry） */
export interface PluginVersionInfo {
  name: string;
  spec: string | null;
  current: string | null;
  updatable: boolean;
}

export interface UrlPayload {
  url: string;
}

export interface StatusPayload {
  dsh_installed: boolean;
  dsh_version: string | null;
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

/** 凭据配置文件（$DSH_HOME/.credentials.yaml）格式兼容性检查结果 */
export interface CredentialsCheck {
  /** 是否与当前 dsh 兼容（兼容则无需任何处理） */
  compatible: boolean;
  /** 不兼容原因（面向用户的中文描述）；兼容时为 null */
  reason: string | null;
  /** 凭据文件绝对路径；定位失败时为 null */
  path: string | null;
  /** 当前文件内容（值已打码）；文件缺失/无法读取时为 null */
  masked_content: string | null;
  /** 最新格式模板（全部为占位值）；仅不兼容时提供 */
  template: string | null;
}

/** 日志会话元信息（设置页日志管理列表） */
export interface LogSessionMeta {
  id: string;
  title: string;
  /** unix 秒 */
  started_at: number;
  /** unix 秒；null = 尚未结束 */
  ended_at: number | null;
  /** "active" | "success" | "error" | "closed" */
  status: string;
  lines: number;
}

/** 会话内单条日志（与 useAppStore 的 LogEntry 同构，无内存 id） */
export interface SessionLogEntry {
  time: string;
  stream: string;
  text: string;
}

export const EVENTS = {
  installLog: "dsh://install-log",
  installExit: "dsh://install-exit",
  envInstallLog: "dsh://env-install-log",
  envInstallExit: "dsh://env-install-exit",
  pluginInstallLog: "dsh://plugin-install-log",
  pluginInstallExit: "dsh://plugin-install-exit",
  pluginOpLog: "dsh://plugin-op-log",
  pluginOpExit: "dsh://plugin-op-exit",
  webLog: "dsh://web-log",
  webExit: "dsh://web-exit",
  url: "dsh://url",
  /** 会话事件推送的渲染结果（Rust 侧投递系统通知后，同一条再 emit 给前端，见 lib/notify.ts） */
  notifyMessage: "dsh://notify-message",
  /** 用户点击了系统通知（toast 激活，见 notify.rs 的 ActivatePayload）：
   *  sessionId 为「打开对话」按钮携带的会话 id，null 表示点到 toast 正文 */
  notifyActivate: "dsh://notify-activate",
} as const;

/** 系统通知点击（toast 激活）负载：与 Rust `notify::ActivatePayload` 同形（serde camelCase） */
export interface NotifyActivatePayload {
  /** 被点击「打开对话」按钮携带的会话 id；点到 toast 正文时为 null */
  sessionId: string | null;
}

/** 浏览器预览模式下的统一提示 */
const NOT_TAURI_MSG = "浏览器预览模式：该操作需在桌面应用内执行";

/** 给 Promise 加超时：超时后按失败处理（避免后端命令异常挂起时前端永远等待） */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** 非 Tauri 环境（浏览器预览）时拒绝调用，避免 invoke 访问 undefined 抛原生 TypeError */
function requireTauri<T>(fn: () => Promise<T>): Promise<T> {
  if (!tauri) return Promise.reject(new Error(NOT_TAURI_MSG));
  return fn();
}

export const api = {
  appStatus: () => requireTauri(() => invoke<StatusPayload>("app_status")),
  probeService: (url: string) => requireTauri(() => invoke<boolean>("probe_service", { url })),
  installDsh: () => requireTauri(() => invoke<void>("install_dsh")),
  /** 安装缺失的环境依赖：tool = "node" | "pnpm"（按平台自动选择 winget/brew/npm 指令） */
  installEnvTool: (tool: "node" | "pnpm") =>
    requireTauri(() => invoke<void>("install_env_tool", { tool })),
  /** 刷新本进程 PATH：Windows 读注册表 Machine/User，macOS 合并登录 shell PATH；
      使刚安装的工具在当前会话立即可被探测，无需重启应用 */
  refreshSearchPath: () => requireTauri(() => invoke<void>("refresh_search_path")),
  startDshWeb: () => requireTauri(() => invoke<void>("start_dsh_web")),
  stopDshWeb: () => requireTauri(() => invoke<void>("stop_dsh_web")),
  openInBrowser: (url: string) => requireTauri(() => invoke<void>("open_in_browser", { url })),
  removePlugin: (name: string) => requireTauri(() => invoke<void>("remove_plugin", { name })),
  installPlugins: () => requireTauri(() => invoke<void>("install_plugins")),
  runPluginOp: (op: string, name: string) =>
    requireTauri(() => invoke<void>("run_plugin_op", { op, name })),
  cancelPluginOp: () => requireTauri(() => invoke<boolean>("cancel_plugin_op")),
  checkPluginUpdates: () =>
    requireTauri(() => invoke<PluginVersionInfo[]>("check_plugin_updates")),
  /** 系统推送总开关：Rust 侧后台订阅线程按此决定是否投递通知 */
  setNotifyEnabled: (enabled: boolean) =>
    requireTauri(() => invoke<void>("set_notify_enabled", { enabled })),
  /** 系统推送样式：1 = 可点击（带「打开对话」按钮，点击直达对应会话），
   *  0 = 不可点击（原 notify-rust 样式，仅展示） */
  setNotifyStyle: (style: 0 | 1) =>
    requireTauri(() => invoke<void>("set_notify_style", { style })),
  /** GitHub / npm 市场请求代理：打包版 CSP 拦截前端直连外网，统一走后端 */
  httpGetJson: (url: string) => requireTauri(() => invoke<string>("http_get_json", { url })),
  /** 启动 dsh 前的凭据配置文件格式兼容性检查（不兼容时返回打码内容与最新格式模板） */
  checkCredentialsCompat: () =>
    requireTauri(() => invoke<CredentialsCheck>("check_credentials_compat")),
  /** 把凭据文件重写为最新规范格式（凭据值全部保留），返回修复摘要 */
  fixCredentials: () => requireTauri(() => invoke<string>("fix_credentials")),
  /** 开始新日志会话（finalize 旧会话），返回会话 id */
  logStartSession: (title: string) =>
    requireTauri(() => invoke<string>("log_start_session", { title })),
  /** 追加一条日志到当前活动会话（无活动会话时静默忽略） */
  logAppend: (entry: SessionLogEntry) =>
    requireTauri(() => invoke<void>("log_append", { entry })),
  /** 更新会话状态（success / error / closed） */
  logSetStatus: (id: string, status: string) =>
    requireTauri(() => invoke<void>("log_set_status", { id, status })),
  /** 日志会话列表（按开始时间倒序） */
  logSessions: () => requireTauri(() => invoke<LogSessionMeta[]>("log_sessions")),
  /** 读取指定会话的完整日志输出 */
  logContent: (id: string) =>
    requireTauri(() => invoke<SessionLogEntry[]>("log_content", { id })),
  /** 清空全部日志会话 */
  logClear: () => requireTauri(() => invoke<void>("log_clear")),
};

export async function onEvent<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  if (!tauri) return () => undefined; // 浏览器预览：无事件源，静默跳过
  return listen<T>(event, (e) => handler(e.payload));
}
