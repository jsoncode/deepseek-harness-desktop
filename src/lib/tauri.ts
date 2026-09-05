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

/** 单项环境检测结果（tool = "node" | "pnpm" | "dsh"） */
export interface ToolCheck {
  path: string | null;
  version: string | null;
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
  /** 最新格式模板（全部为占位值）；文件可读时始终提供 */
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
  /** 语音播报状态（Rust tts.rs：generating / playing / done / error），
   *  设置页「语音播报」卡片监听展示 */
  notifyVoice: "dsh://notify-voice",
  /** 语音依赖一键安装的 pip 逐行输出（Rust tts.rs，装 torch/transformers 等） */
  voiceInstallLog: "dsh://voice-install-log",
  /** 长文本分段合成的逐段进度（Rust tts.rs：第 current/total 段完成） */
  ttsSynthProgress: "dsh://tts-synth-progress",
} as const;

/** 系统通知点击（toast 激活）负载：与 Rust `notify::ActivatePayload` 同形（serde camelCase） */
export interface NotifyActivatePayload {
  /** 被点击「打开对话」按钮携带的会话 id；点到 toast 正文时为 null */
  sessionId: string | null;
}

/** 语音播报状态事件负载：与 Rust `tts.rs` emit 的 json 同形 */
export interface NotifyVoicePayload {
  state: "generating" | "playing" | "done" | "error";
  text: string | null;
  error: string | null;
  /** 事件发出时 worker 是否驻留内存（命中缓存直接播放时为 false：不走合成、不起 worker） */
  running: boolean;
}

/** 语音播报配置：与 Rust `tts::VoiceConfig` 同形（serde camelCase） */
export interface VoiceConfig {
  enabled: boolean;
  /** 播报内容："summary"（标题+描述）| "title" | "desc" */
  speakContent: "summary" | "title" | "desc";
  /** Python 解释器（命令名或绝对路径，需已装 torch/transformers） */
  pythonCmd: string;
  /** Audio8_TTS 仓库克隆目录（含 audio8_tts_data.py） */
  repoDir: string;
  /** 完整模型 checkpoint 目录（config.json + tokenizer + codec.pth） */
  modelDir: string;
  /** 采样温度（>0）：越高越随机，越低越平稳 */
  temperature: number;
  /** nucleus 采样概率阈值（0 < topP ≤ 1） */
  topP: number;
  /** top-k 采样候选数（0 = 不启用） */
  topK: number;
  /** 随机种子：同文本+同参数+同 seed 结果可复现；换种子即换一种读法 */
  seed: number;
  /** 单段生成 token 上限（不够时长会被截断） */
  maxNewTokens: number;
  /** 贪心解码：忽略采样参数，输出最稳定 */
  greedy: boolean;
}

/** 环境自检报告：与 Rust `tts::VoiceEnvReport` 同形（serde camelCase） */
export interface VoiceEnvReport {
  pythonVersion: string | null;
  pythonError: string | null;
  repoOk: boolean;
  repoHint: string;
  modelOk: boolean;
  modelHint: string;
  codecOk: boolean;
  codecHint: string;
  torchOk: boolean;
  torchInfo: string | null;
  torchError: string | null;
  /** torch 检测失败且 Python 可用时的完整一键安装命令；正常/Python 不可用时为 null */
  torchInstallCmd: string | null;
}

/** 长文本分段合成进度负载（Rust tts.rs TTS_SYNTH_PROGRESS_EVENT） */
export interface TtsSynthProgress {
  current: number;
  total: number;
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
  /** 单项环境检测：tool = "node" | "pnpm" | "dsh"（启动页逐项 loading，每项独立返回） */
  checkTool: (tool: "node" | "pnpm" | "dsh") =>
    requireTauri(() => invoke<ToolCheck>("check_tool", { tool })),
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
  /** 语音播报配置（enabled/播报内容/python/仓库目录/模型目录，见 tts.rs）；
   *  python/仓库/模型变化会使常驻 worker 在下次合成时重建 */
  setVoiceConfig: (config: VoiceConfig) =>
    requireTauri(() => invoke<void>("set_voice_config", { config })),
  /** 语音环境自检（python / 仓库 / 模型 / codec / torch，cheap 不加载模型） */
  ttsEnvCheck: () => requireTauri(() => invoke<VoiceEnvReport>("tts_env_check")),
  /** 一键安装语音依赖（torch/transformers/soundfile/numpy）：按 N 卡选 CUDA/CPU 版，
   *  pip 输出经 EVENTS.voiceInstallLog 逐行推送；命令在全部步骤结束后才 resolve */
  ttsInstallVoiceDeps: () => requireTauri(() => invoke<void>("tts_install_voice_deps")),
  /** 语音试听：走通知同一条队列与缓存；总开关未开也能试 */
  ttsSpeakTest: (text?: string) =>
    requireTauri(() => invoke<void>("tts_speak_test", { text: text ?? null })),
  /** 手动停止语音服务：清空排队播报 + 杀常驻 worker，模型内存立即释放；
   *  返回是否真的停掉了一个运行中的 worker。下次播报会自动重新拉起（冷启动重载模型） */
  ttsStopVoiceService: () =>
    requireTauri(() => invoke<boolean>("tts_stop_voice_service")),
  /** 语音 worker 是否驻留运行（true = 模型已加载、占着内存） */
  ttsVoiceStatus: () => requireTauri(() => invoke<boolean>("tts_voice_status")),
  /** 打开语音合成工具独立窗口（已开则聚焦）：长文本合成 + 导出 + 完整配置 */
  ttsOpenStudio: () => requireTauri(() => invoke<void>("tts_open_studio")),
  /** 长文本分段合成 → 拼接导出（app_data/tts/exports/tts-<ts>.wav）；
   *  进度经 EVENTS.ttsSynthProgress 逐段推送；命令在全部完成后返回导出文件绝对路径。
   *  每段独立复用文本缓存；首次调用会拉起 worker 加载模型（30~90s） */
  ttsSynthesize: (text: string) => requireTauri(() => invoke<string>("tts_synthesize", { text })),
  /** 播放本地 WAV 文件（合成结果预览；rodio 直连系统音频，窗口失焦照常出声） */
  ttsPlayFile: (path: string) => requireTauri(() => invoke<void>("tts_play_file", { path })),
  /** 把合成结果复制另存为 dest（用户经系统另存为对话框选定） */
  ttsExportWav: (src: string, dest: string) =>
    requireTauri(() => invoke<void>("tts_export_wav", { src, dest })),
  /** 在文件管理器中打开目录 */
  ttsOpenPath: (path: string) => requireTauri(() => invoke<void>("tts_open_path", { path })),
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
  /** 预览 iframe 的本地反向代理地址（origin 形态，如 `http://127.0.0.1:3090`）：
   *  代理做认证终结（Rust 侧持有 dsh-auth Cookie 并注入转发请求），浏览器
   *  无需 Cookie，打包正式版壳顶层 tauri://localhost 也能以普通 DOM iframe
   *  同源内嵌宿主页。未启动成功返回 null（预览回退/提示，见 Preview.tsx） */
  proxyBaseUrl: () => requireTauri(() => invoke<string | null>("proxy_base_url")),
};

export async function onEvent<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  if (!tauri) return () => undefined; // 浏览器预览：无事件源，静默跳过
  return listen<T>(event, (e) => handler(e.payload));
}
