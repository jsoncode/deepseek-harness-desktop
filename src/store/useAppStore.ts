import { create } from "zustand";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, EVENTS, onEvent, tauri, withTimeout, type CredentialsCheck, type ExitPayload, type LogLine, type PluginVersionInfo, type StatusPayload, type ToolCheck, type UrlPayload } from "../lib/tauri";
import { meetsNodeRequirement, pnpmMajorOf } from "../lib/envReq";

// ---------------------------------------------------------------------------
// 应用状态机：checking → idle | installing → starting → running
//                                    ↘ error / stopped
// ---------------------------------------------------------------------------

export type Phase = "checking" | "idle" | "installing" | "starting" | "running" | "error" | "stopped";

/** 环境逐项检测的工具（启动页每个检查行一个 loading 态） */
export type EnvTool = "node" | "pnpm" | "dsh";

export type StreamKind = "system" | "stdout" | "stderr" | "success" | "error";

export interface LogEntry {
  id: number;
  time: string;
  stream: StreamKind;
  text: string;
}

export type PluginOpKind = "add" | "update" | "remove";

/** 插件加载失败信息（从 dsh web 启动日志中识别）：name=插件名, message=原始错误行 */
export interface PluginLoadError {
  name: string;
  message: string;
}

export interface PluginOpState {
  kind: PluginOpKind;
  name: string;
  running: boolean;
  exitCode?: number;
}

interface AppStore {
  phase: Phase;
  logs: LogEntry[];
  url: string | null;
  dshInstalled: boolean;
  dshVersion: string | null;
  serviceRunning: boolean;
  childRunning: boolean;
  pnpmPath: string | null;
  dshPath: string | null;
  nodePath: string | null;
  nodeVersion: string | null;
  pnpmVersion: string | null;
  plugins: string[];
  profileReady: boolean;
  serviceAlive: boolean;
  pluginOp: PluginOpState | null;
  pluginOpLogs: LogEntry[];
  /** 插件版本信息：current 来自后端本地读取，latest 来自前端并行直查 registry */
  pluginVers: Record<string, { current?: string | null; latest?: string | null }>;
  /** 从启动日志中识别到的插件加载失败（非空时前端弹框提示移除并重启） */
  pluginLoadError: PluginLoadError | null;
  error: string | null;
  initialized: boolean;
  /** 逐项环境检测完成标记：false = 该项仍在检测中（启动页对应行显示 loading）；
   *  true = 已有该项结果（值可信）。app_status 收尾时统一落定为 true */
  envCheckDone: Record<EnvTool, boolean>;
  /** 新一轮启动流程的序号：每次进入 installing/starting 时递增，
   *  供 web-exit 事件区分「当前流程退出」与「复核期间用户重新发起的陈旧退出」 */
  startSeq: number;
  /** 凭据配置文件格式兼容问题（非空时由 CredentialsFixModal 弹框展示） */
  credentialsIssue: CredentialsCheck | null;
  /** 当前活动日志会话 id（每次启动/重启流程开始时创建；null = 无会话） */
  logSessionId: string | null;

  init: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  /** 单项环境检测结果写回：把启动页对应检查行从「检测中」点亮为结果 */
  applyEnvToolCheck: (tool: EnvTool, result: ToolCheck) => void;
  /** 启动 dsh web 服务（starting → 事件驱动 running/error）。
   *  启动链不再执行插件依赖安装（dsh 启动时按 bundles 自动加载已安装插件，
   *  卸载残留由后端 start_dsh_web 启动前清理，见 dsh.rs prune_pending_plugin_deps） */
  startService: () => Promise<void>;
  startFlow: () => Promise<void>;
  /** 一键安装缺失的环境依赖（node → pnpm → dsh）并自动启动服务。
   *  dsh 仅在缺失或安装损坏（读不出版本）时安装；已正常安装的 dsh 绝不在
   *  启动链中自动重装/更新，避免 @latest 覆盖现有版本 */
  installEnvAndStart: () => Promise<void>;
  /** 开始新的日志会话（finalize 旧会话），成功后将 id 存入 logSessionId */
  beginLogSession: (title: string) => Promise<void>;
  /** 预置下一次启动流程的日志会话标题（如「重启服务」），由 startFlow/installEnvAndStart 消费 */
  prepareLogSessionTitle: (title: string) => void;
  /** pnpm ≥11（dsh 不支持）时降级到 pnpm 10；返回是否执行了降级 */
  ensurePnpm10: () => Promise<boolean>;
  /** 正在通过自动链路安装的环境依赖（驱动启动页按钮/状态文案） */
  envInstallTool: "node" | "pnpm" | null;
  /** dsh web 因凭据配置文件格式问题启动失败时，弹框展示打码内容与最新格式模板，
   *  等待用户确认；确认后（弹框内已调用 fixCredentials）返回 true 并自动重启服务，
   *  取消返回 false（停留在错误页，可手动重试） */
  promptCredentialsFix: (fallbackReason: string) => Promise<boolean>;
  /** 凭据修复弹框的决策回调：true = 已修复并继续，false = 暂不处理 */
  resolveCredentialsConfirm: (ok: boolean) => void;
  stop: () => Promise<void>;
  reset: () => void;
  appendLog: (stream: StreamKind, text: string) => void;
  appendPluginOpLog: (stream: StreamKind, text: string) => void;
  startPluginOp: (kind: PluginOpKind, name: string) => Promise<void>;
  refreshPluginVersions: () => Promise<void>;
  setPhase: (phase: Phase) => void;
  /** 上报插件加载失败（由 Preview 页收到的子 webview 桥接事件调用） */
  reportPluginLoadError: (name: string, message: string) => void;
  clearPluginLoadError: () => void;
}

let logSeq = 0;
let wired = false;

/** 当前是否主窗口：启动链、服务日志镜像、健康轮询等全局职责只在主窗口承担；
 *  独立设置窗口（label "settings"）仅接插件操作事件、仅拉一次状态——
 *  Rust 事件是全窗口广播（app.emit），接多了会重复消费、日志重复落盘，
 *  多窗口并发全量环境探测会争抢 CPU 导致版本读取超时误报（见 wireEvents/init 注释）。
 *  浏览器预览模式（非 Tauri）视作主窗口，保持既有行为 */
const isMain = !tauri || getCurrentWindow().label === "main";

/** 日志会话写入串行队列：保证 invoke 到达 Rust 的顺序与 store 日志顺序一致
 *  （并发 IPC 可能乱序，会破坏会话文件的日志顺序） */
let logFlush: Promise<void> = Promise.resolve();
/** 待创建日志会话的标题（由重启等调用方预置，启动流程消费后清空） */
let pendingSessionTitle: string | null = null;

/** 会话内日志上限：超出后丢弃最旧日志 */
const MAX_LOGS = 3000;
/** 日志截断提示（截断期间顶部恒有一条：每次截断重建，旧提示随最旧日志一起被丢弃） */
const TRUNCATED_NOTE = "（历史日志过长，已截断早期内容）";
/** 重新启动服务时的日志分隔线 */
const RESTART_SEPARATOR = "重新启动服务";
/** 插件操作日志上限 */
const MAX_PLUGIN_OP_LOGS = 1000;
/** 环境依赖单步安装的等待上限：winget/brew 下载安装可能耗时数分钟 */
const ENV_INSTALL_TIMEOUT_MS = 15 * 60 * 1000;

// 环境依赖安装为事件驱动（后端流式转发、退出码异步通知）。
// 链路严格按 node → pnpm → dsh 顺序执行，同一时刻只有一步在等待，
// 因此用单槽 resolver 即可：waitEnvExit 挂槽，env-install-exit 事件触发。
let envExitResolve: ((code: number) => void) | null = null;
let envExitTimer: ReturnType<typeof setTimeout> | null = null;

// 凭据修复弹框的决策槽：promptCredentialsFix 挂槽，弹框按钮触发
let credentialsConfirmResolve: ((ok: boolean) => void) | null = null;
// 「dsh web 启动失败且日志含凭据格式错误」的监听标志：
// web-log 事件命中错误签名时置位，web-exit 事件据此进入修复流程
let credsFailPending = false;
let credsFailLine: string | null = null;
// 每次应用会话只自动弹一次修复框（修复后仍失败时避免弹框循环轰炸）
let credsPromptShown = false;

function waitEnvExit(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      envExitResolve = null;
      envExitTimer = null;
      reject(new Error(`安装超时（超过 ${Math.round(ENV_INSTALL_TIMEOUT_MS / 60000)} 分钟），请查看日志或重试`));
    }, ENV_INSTALL_TIMEOUT_MS);
    envExitTimer = timer;
    envExitResolve = (code) => {
      clearTimeout(timer);
      envExitTimer = null;
      resolve(code);
    };
  });
}

/** invoke 同步失败时不会有 exit 事件，必须摘除挂着的 resolver 防止链路悬挂 */
function dropEnvExitWait() {
  if (envExitTimer) {
    clearTimeout(envExitTimer);
    envExitTimer = null;
  }
  envExitResolve = null;
}

/** 服务健康轮询：仅运行中探测；连续 2 次失败才判定断连，任一次成功即恢复 */
let healthTimer: ReturnType<typeof setInterval> | null = null;
let healthFailCount = 0;
const HEALTH_INTERVAL_MS = 6000;

/** 环境状态刷新在跑标记：刷新会并发拉起十几个探测子进程（3×check_tool +
 *  app_status，各含 where 解析与版本读取），叠加执行会互相争抢 CPU 导致
 *  版本读取超时、界面闪出「已损坏」误报——同一时刻只允许一轮在跑 */
let statusRefreshInFlight = false;

function healthTick() {
  const s = useAppStore.getState();
  if (!s.url || s.phase !== "running") return;
  const markDead = () => {
    healthFailCount += 1;
    if (healthFailCount >= 2 && useAppStore.getState().serviceAlive) {
      useAppStore.setState({ serviceAlive: false });
    }
  };
  void api
    .probeService(s.url)
    .then((ok) => {
      if (ok) {
        healthFailCount = 0;
        if (!useAppStore.getState().serviceAlive) useAppStore.setState({ serviceAlive: true });
      } else {
        markDead();
      }
    })
    .catch(markDead);
}

/** 按 url/phase 启停健康轮询定时器（由 store subscribe 驱动）；
 *  仅主窗口轮询——设置窗口的服务状态来自 app_status 快照，无需重复探测 */
function syncHealthPolling() {
  if (!isMain) return;
  const s = useAppStore.getState();
  const shouldPoll = Boolean(s.url) && s.phase === "running";
  if (shouldPoll && healthTimer === null) {
    healthFailCount = 0;
    healthTimer = setInterval(healthTick, HEALTH_INTERVAL_MS);
  } else if (!shouldPoll && healthTimer !== null) {
    clearInterval(healthTimer);
    healthTimer = null;
    // 离开运行态：恢复默认存活，灯色交由 phase 表达（已停止 → 红）
    if (!useAppStore.getState().serviceAlive) useAppStore.setState({ serviceAlive: true });
  }
}

function now(): string {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

/**
 * 直查 npm registry 某包的 latest 版本号。
 * 桌面端经 Rust 代理（打包版 CSP 拦截前端直连外网）；浏览器预览模式用原生 fetch。
 */
async function fetchNpmLatest(name: string): Promise<string | null> {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`;
  let j: { version?: unknown };
  if (tauri) {
    const text = await api.httpGetJson(url);
    j = JSON.parse(text) as { version?: unknown };
  } else {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      j = (await res.json()) as { version?: unknown };
    } finally {
      clearTimeout(timer);
    }
  }
  return typeof j.version === "string" ? j.version : null;
}

export const useAppStore = create<AppStore>((set, get) => {
  // -------------------------------------------------------------------------
  // 事件接线（全局只接一次）
  // -------------------------------------------------------------------------
  function wireEvents() {
    if (wired) return;
    wired = true;

    // 独立设置窗口：只接插件操作事件（插件管理面板在本窗口发起操作，
    // pluginOpExit handler 自带 op.running 守卫，与主窗口并发消费无竞态）。
    // 启动链/服务日志事件不接：那些职责在主窗口，接了会把同一份日志再次
    // invoke log_append 镜像进会话文件（重复落盘）
    if (!isMain) {
      onEvent<LogLine>(EVENTS.pluginOpLog, (p) => {
        const stream: StreamKind =
          p.stream === "stderr" ? "stderr" : p.stream === "system" ? "system" : "stdout";
        get().appendPluginOpLog(stream, p.line);
      });
      onEvent<ExitPayload>(EVENTS.pluginOpExit, (p) => {
        const op = get().pluginOp;
        if (!op || !op.running) return;
        set({ pluginOp: { ...op, running: false, exitCode: p.code } });
      });
      return;
    }

    onEvent<LogLine>(EVENTS.installLog, (p) => {
      const stream: StreamKind =
        p.stream === "stderr" ? "stderr" : p.stream === "system" ? "system" : "stdout";
      get().appendLog(stream, p.line);
    });

    onEvent<ExitPayload>(EVENTS.installExit, (p) => {
      if (p.code === 0) {
        get().appendLog("success", "@deepseek-ai/dsh 全局安装完成");
        set({ dshInstalled: true });
        void get().startService();
      } else {
        get().appendLog("error", `安装失败（退出码 ${p.code}），请检查网络或 pnpm 配置`);
        set({ phase: "error", error: `安装失败，退出码 ${p.code}` });
      }
    });

    // 环境依赖安装（node/pnpm）：日志进主终端流；退出码交给链路中的 waiter 续接
    onEvent<LogLine>(EVENTS.envInstallLog, (p) => {
      const stream: StreamKind =
        p.stream === "stderr" ? "stderr" : p.stream === "system" ? "system" : "stdout";
      get().appendLog(stream, p.line);
    });

    onEvent<ExitPayload>(EVENTS.envInstallExit, (p) => {
      const r = envExitResolve;
      envExitResolve = null;
      r?.(p.code);
    });

    onEvent<LogLine>(EVENTS.pluginOpLog, (p) => {
      const stream: StreamKind =
        p.stream === "stderr" ? "stderr" : p.stream === "system" ? "system" : "stdout";
      get().appendPluginOpLog(stream, p.line);
    });

    onEvent<ExitPayload>(EVENTS.pluginOpExit, (p) => {
      const op = get().pluginOp;
      if (!op || !op.running) return;
      set({ pluginOp: { ...op, running: false, exitCode: p.code } });
    });

    onEvent<LogLine>(EVENTS.webLog, (p) => {
      const stream: StreamKind =
        p.stream === "stderr" ? "stderr" : p.stream === "system" ? "system" : "stdout";
      get().appendLog(stream, p.line);
      // 凭据配置文件格式错误签名（dsh-credentials-local 的报错前缀）：
      // 命中即标记，web-exit 时若确认启动失败，进入「弹框 → 修复 → 重启」流程
      if (p.line.includes("credentials-local:")) {
        credsFailPending = true;
        credsFailLine = p.line;
      }
    });

    onEvent<ExitPayload>(EVENTS.webExit, (p) => {
      // 记录事件到达时的启动序号：复核期间若用户停止/重新发起启动，序号会变化，
      // 据此把「当前流程的退出」与「复核期间新流程的陈旧退出」区分开——
      // 旧实现按 phase 判断（installing/starting 一律吞掉），会把当前启动流程
      // 的失败也吞掉，导致服务意外停止后永远卡在「启动中」且重启/停止都不可操作。
      const seqAtExit = get().startSeq;
      set({ childRunning: false });
      if (get().phase === "stopped") return;
      // 双保险复核：dsh web 的服务进程可能独立于壳进程存活（派生脱离父链），
      // 后端已在可用时接管并不发本事件；此处再按实际可达性裁决一次，
      // 绝不因进程退出码而误杀仍在正常服务的实例。
      void (async () => {
        try {
          const st: StatusPayload = await withTimeout(api.appStatus(), 8000, "服务状态复核");
          if (st.service_running && st.url) {
            get().appendLog(
              "system",
              `dsh web 进程已退出（退出码 ${p.code}），但服务仍可访问（${st.url}），已自动接管，无需重启`,
            );
            set({
              url: st.url,
              serviceRunning: true,
              serviceAlive: true,
              childRunning: st.child_running,
              phase: "running",
            });
            return;
          }
        } catch {
          /* 复核失败：按服务不可用处理 */
        }
        const cur = get();
        if (cur.phase === "stopped") return;
        // 复核期间用户已停止/重新发起启动：启动序号变化即陈旧事件，直接忽略
        if (cur.startSeq !== seqAtExit) return;
        if (cur.phase === "running") {
          get().appendLog("error", `dsh web 进程已退出（退出码 ${p.code}）`);
          set({ phase: "stopped", serviceRunning: false });
          return;
        }
        // 当前启动流程（installing/starting）的退出：如实上报失败，
        // 由启动页/重启页给出重试入口，而不是永远停留在「启动中」
        const credsDetected =
          credsFailPending || cur.logs.some((l) => l.text.includes("credentials-local:"));
        if (credsDetected && !credsPromptShown) {
          credsPromptShown = true;
          credsFailPending = false;
          const reasonLine = credsFailLine ?? `dsh web 启动失败，退出码 ${p.code}`;
          get().appendLog(
            "error",
            `dsh web 启动失败（退出码 ${p.code}）：凭据配置文件格式不兼容`,
          );
          set({ phase: "error", error: "dsh web 启动失败：凭据配置文件格式不兼容" });
          // 弹框展示打码内容与最新格式模板；确认修复后自动重启服务
          const ok = await get().promptCredentialsFix(reasonLine);
          if (ok) {
            get().appendLog("system", "凭据配置文件已更新为最新格式，正在重新启动服务…");
            void get().startFlow();
          }
          return;
        }
        get().appendLog("error", `dsh web 启动失败（退出码 ${p.code}）`);
        set({ phase: "error", error: `dsh web 启动失败，退出码 ${p.code}` });
      })();
    });

    onEvent<UrlPayload>(EVENTS.url, (p) => {
      set({ url: p.url, serviceRunning: true, childRunning: true, serviceAlive: true });
      get().appendLog("success", `服务已就绪：${p.url}`);
      set({ phase: "running" });
    });
  }

  /** 无条件拉取最新环境状态并合并进 store（phase 由调用方链路控制，不在此改动）；
   *  安装链每步之后调用，用于确认上一步安装是否真正生效 */
  async function pullStatusFields(): Promise<void> {
    // 超时 20s：后端并行解析 + 版本读取（5s×2 重试）+ 服务探测，负载高峰接近 14s
    const s: StatusPayload = await withTimeout(api.appStatus(), 20000, "环境检测");
    set({
      dshInstalled: s.dsh_installed,
      dshVersion: s.dsh_version,
      serviceRunning: s.service_running,
      childRunning: s.child_running,
      url: s.url,
      pnpmPath: s.pnpm_path,
      dshPath: s.dsh_path,
      nodePath: s.node_path,
      nodeVersion: s.node_version,
      pnpmVersion: s.pnpm_version,
      plugins: s.plugins ?? [],
      profileReady: s.profile_ready,
      serviceAlive: s.service_running,
      initialized: true,
    });
  }

  /** 单项环境检测：逐项点亮环境检查行；失败静默（app_status 收尾兜底）。
   *  超时 16s：后端单项检测 = where 解析（3s）+ 版本读取（5s×2 次重试），
   *  负载高峰接近上限，给足余量避免前端先于后端超时。 */
  async function runToolCheck(tool: EnvTool): Promise<void> {
    try {
      const r = await withTimeout(api.checkTool(tool), 16000, "环境检测");
      get().applyEnvToolCheck(tool, r);
    } catch {
      /* 单项失败（旧后端无此命令/超时）：由 app_status 收尾统一落值 */
    }
  }

  /** 收尾检测：app_status 聚合权威值（服务/插件/phase）并最终落定全部检查行。
   *  failToIdle = true（init 首检）：失败回就绪态让用户可手动重试；
   *  false（refreshStatus 刷新）：失败静默忽略，保留现有展示 */
  async function settleStatus(prevPhase: Phase, failToIdle: boolean): Promise<void> {
    try {
      // 超时 20s：后端并行解析 + 版本读取（5s×2 重试）+ 服务探测，负载高峰接近 14s
      const s: StatusPayload = await withTimeout(api.appStatus(), 20000, "环境检测");
      set({
        dshInstalled: s.dsh_installed,
        dshVersion: s.dsh_version,
        serviceRunning: s.service_running,
        childRunning: s.child_running,
        url: s.url,
        pnpmPath: s.pnpm_path,
        dshPath: s.dsh_path,
        nodePath: s.node_path,
        nodeVersion: s.node_version,
        pnpmVersion: s.pnpm_version,
        plugins: s.plugins ?? [],
        profileReady: s.profile_ready,
        serviceAlive: s.service_running,
        envCheckDone: { node: true, pnpm: true, dsh: true },
        phase: s.service_running
          ? "running"
          : s.child_running
            ? "starting"
            : prevPhase === "stopped" || prevPhase === "error"
              ? prevPhase
              : "idle",
        initialized: true,
      });
    } catch {
      if (failToIdle) {
        // 超时/失败：不误报"启动失败"，回到就绪态让用户可手动重试；
        // 检查行以单项检测结果为准（单项也失败时显示未检测到）
        set({
          phase: "idle",
          error: null,
          initialized: true,
          envCheckDone: { node: true, pnpm: true, dsh: true },
        });
      }
    }
  }

  return {
    phase: "checking",
    logs: [],
    url: null,
    dshInstalled: false,
    dshVersion: null,
    serviceRunning: false,
    childRunning: false,
    pnpmPath: null,
    dshPath: null,
    nodePath: null,
    nodeVersion: null,
    pnpmVersion: null,
    plugins: [],
    profileReady: false,
    serviceAlive: true,
    pluginOp: null,
    pluginOpLogs: [],
    pluginVers: {},
    pluginLoadError: null,
    error: null,
    initialized: false,
    envCheckDone: { node: false, pnpm: false, dsh: false },
    envInstallTool: null,
    startSeq: 0,
    credentialsIssue: null,
    logSessionId: null,

    appendLog: (stream, text) => {
      const entry: LogEntry = {
        id: ++logSeq,
        time: now(),
        stream,
        text,
      };
      set((s) => {
        const all = [...s.logs, entry];
        if (all.length <= MAX_LOGS) return { logs: all };
        // 超过上限：顶部放一条截断提示，保留最近 MAX_LOGS-1 条真实日志（丢弃最旧）
        const note: LogEntry = {
          id: ++logSeq,
          time: now(),
          stream: "system",
          text: TRUNCATED_NOTE,
        };
        return { logs: [note, ...all.slice(all.length - (MAX_LOGS - 1))] };
      });
      // 串行镜像到当前日志会话文件（跳过截断提示；预览模式 invoke 失败静默吞掉）
      if (text !== TRUNCATED_NOTE) {
        const { time, stream: st, text: tx } = entry;
        logFlush = logFlush
          .then(() => api.logAppend({ time, stream: st, text: tx }))
          .catch(() => undefined);
      }
    },

    appendPluginOpLog: (stream, text) => {
      set((s) => {
        const entry: LogEntry = { id: ++logSeq, time: now(), stream, text };
        const all = [...s.pluginOpLogs, entry];
        // 超限直接丢弃最旧（操作日志无需截断提示）
        return { pluginOpLogs: all.length <= MAX_PLUGIN_OP_LOGS ? all : all.slice(all.length - MAX_PLUGIN_OP_LOGS) };
      });
    },

    startPluginOp: async (kind, name) => {
      set({ pluginOp: { kind, name, running: true }, pluginOpLogs: [] });
      try {
        await api.runPluginOp(kind, name);
      } catch (e) {
        get().appendPluginOpLog("error", String(e instanceof Error ? e.message : e));
        set((s) => ({ pluginOp: s.pluginOp ? { ...s.pluginOp, running: false, exitCode: -1 } : null }));
      }
    },

    refreshPluginVersions: async () => {
      let base: PluginVersionInfo[];
      try {
        base = await api.checkPluginUpdates();
      } catch {
        return; // 浏览器预览或后端异常：保持现状
      }
      const vers: AppStore["pluginVers"] = {};
      for (const i of base) {
        vers[i.name] = { current: i.current, latest: null };
      }
      set({ pluginVers: vers });
      // 并行直查 registry latest（每个仅几 KB）；失败置 null 静默隐藏更新按钮
      await Promise.allSettled(
        base
          .filter((i) => i.updatable)
          .map(async (i) => {
            try {
              const latest = await fetchNpmLatest(i.name);
              set((s) => ({
                pluginVers: { ...s.pluginVers, [i.name]: { ...s.pluginVers[i.name], latest } },
              }));
            } catch {
              set((s) => ({
                pluginVers: { ...s.pluginVers, [i.name]: { ...s.pluginVers[i.name], latest: null } },
              }));
            }
          }),
      );
    },

    setPhase: (phase) => set({ phase }),

    applyEnvToolCheck: (tool, result) => {
      const done = { ...get().envCheckDone, [tool]: true };
      if (tool === "node") {
        set({ envCheckDone: done, nodePath: result.path, nodeVersion: result.version });
      } else if (tool === "pnpm") {
        set({ envCheckDone: done, pnpmPath: result.path, pnpmVersion: result.version });
      } else {
        set({
          envCheckDone: done,
          dshPath: result.path,
          dshInstalled: result.path !== null,
          dshVersion: result.version,
        });
      }
    },

    beginLogSession: async (title) => {
      if (!tauri) return;
      try {
        const r = await withTimeout(api.logStartSession(title), 8000, "创建日志会话");
        set({ logSessionId: r.id });
        // 会话建立前到达的服务日志（乐观启动）：后端已写入会话文件，这里补进
        // 内存日志流，让实时日志视图从命令回显开始完整
        if (r.pending?.length) {
          const pending: LogEntry[] = r.pending.map((l) => ({
            id: ++logSeq,
            time: l.time,
            stream: l.stream as StreamKind,
            text: l.text,
          }));
          set((s) => ({ logs: [...s.logs, ...pending] }));
        }
      } catch {
        /* 会话创建失败不阻塞启动流程（日志仅保留在内存态） */
      }
    },

    prepareLogSessionTitle: (title) => {
      pendingSessionTitle = title;
    },

    clearPluginLoadError: () => set({ pluginLoadError: null }),

    reportPluginLoadError: (name, message) =>
      set((s) =>
        // 已有未处理的弹框时不覆盖（避免连续多个插件失败时弹框打架）
        s.pluginLoadError ? s : { pluginLoadError: { name, message } },
      ),

    init: async () => {
      wireEvents();
      if (get().initialized) return;
      set({
        phase: "checking",
        initialized: false,
        envCheckDone: { node: false, pnpm: false, dsh: false },
      });
      if (!tauri) {
        // 浏览器预览模式：无 Rust 后端，保持空闲态，避免误报"启动失败"
        set({ phase: "idle", initialized: true });
        return;
      }
      // 独立设置窗口：不跑全量环境探测（主窗口已做/在做，多窗口并发探测会
      // 争抢 CPU 导致版本读取超时误报），只做一次 app_status 收尾取插件清单
      // 与服务状态；failToIdle=true，失败也落 idle + 检查行完成，防 About 页
      // 卡在「检测中」
      if (!isMain) {
        await settleStatus("idle", true);
        return;
      }
      // 主窗口启动检测只跑一次 app_status（内部已是并行解析 + 版本读取，一次返回
      // node/pnpm/dsh 路径与版本 + 服务/插件状态）。
      // 历史上有「先并发 3× check_tool 逐项点亮检查行，再 app_status 收尾」两段串行，
      // 那是为已移除的启动检查页服务的；两段各自都要做全量探测（where 解析 + 版本
      // 读取），串行叠加等于把检测耗时翻倍——这里去掉逐项段，检测耗时直接减半。
      // check_tool 命令仍保留：设置页/关于页的刷新与安装链的复检还要用（见 refreshStatus、
      // installEnvAndStart）。
      await settleStatus(get().phase, true);
    },

    refreshStatus: async () => {
      // 启动中不打断
      const cur = get().phase;
      if (cur === "installing" || cur === "starting") return;
      // 并发去重：关于页自动检测/手动重检/标题栏刷新可能叠加，只跑一轮
      if (statusRefreshInFlight) return;
      statusRefreshInFlight = true;
      try {
        // 与 init 同理：单次 app_status 即可拿到全部权威值，不再前置逐项探测
        await settleStatus(cur, false);
      } finally {
        statusRefreshInFlight = false;
      }
    },

    promptCredentialsFix: async (fallbackReason: string) => {
      let issue: CredentialsCheck;
      try {
        issue = await withTimeout(api.checkCredentialsCompat(), 8000, "凭据配置检查");
      } catch {
        // 检查本身失败（环境异常等）：也要能弹框，用启动日志中的原始错误行兜底
        issue = {
          compatible: false,
          reason: fallbackReason,
          path: null,
          masked_content: null,
          template: null,
        };
      }
      // 弹框原因以 dsh 启动日志中的真实错误行为准（最贴近用户看到的失败事实）；
      // 后端 schema 检查仅用于取打码内容与最新格式模板
      issue = { ...issue, compatible: false, reason: fallbackReason };
      get().appendLog(
        "system",
        "dsh web 启动失败：凭据配置文件格式不兼容，等待用户确认是否更新为最新格式…",
      );
      return new Promise<boolean>((resolve) => {
        credentialsConfirmResolve = resolve;
        set({ credentialsIssue: issue });
      });
    },

    resolveCredentialsConfirm: (ok) => {
      const r = credentialsConfirmResolve;
      credentialsConfirmResolve = null;
      set({ credentialsIssue: null });
      r?.(ok);
    },

    startService: async () => {
      set({ phase: "starting", error: null });
      get().appendLog("system", "开始启动本地服务：dsh web …");
      try {
        await api.startDshWeb();
      } catch (e) {
        get().appendLog("error", `启动失败：${String(e)}`);
        set({ phase: "error", error: String(e) });
      }
    },

    /** pnpm ≥11 时降级到 pnpm 10（dsh 与 pnpm 11 的全局虚拟仓库布局不兼容）。
     *  复用后端 installEnvTool("pnpm") = npm install -g pnpm@10；返回是否发生了降级。 */
    ensurePnpm10: async () => {
      const major = pnpmMajorOf(get().pnpmVersion);
      if (major < 11) return false;
      get().appendLog("system", "检测到 pnpm 11：dsh 不支持 pnpm 11，开始降级到 pnpm 10…");
      set({ phase: "installing", envInstallTool: "pnpm" });
      const waiter = waitEnvExit();
      try {
        await api.installEnvTool("pnpm");
      } catch (e) {
        dropEnvExitWait();
        throw e;
      }
      const code = await waiter;
      if (code !== 0) {
        throw new Error(`pnpm 降级失败（退出码 ${code}），请查看下方日志`);
      }
      get().appendLog("success", "已降级到 pnpm 10");
      await api.refreshSearchPath();
      await pullStatusFields();
      if (pnpmMajorOf(get().pnpmVersion) >= 11) {
        throw new Error("pnpm 降级后仍未生效，请重启本应用后重试");
      }
      return true;
    },

    startFlow: async () => {
      const { phase, dshInstalled } = get();
      if (phase === "installing" || phase === "starting" || phase === "running") return;
      // 每次启动/重启/重试都是一条独立日志记录：先开新会话（重启链路预置标题）
      const title = pendingSessionTitle ?? "启动服务";
      pendingSessionTitle = null;
      await get().beginLogSession(title);
      if (get().logs.length > 0) {
        get().appendLog("system", RESTART_SEPARATOR);
      }
      set({ error: null });

      if (!tauri) {
        get().appendLog("system", "浏览器预览模式：启动/停止服务需在桌面应用内操作");
        return;
      }

      // pnpm ≥11：先降级；失败则中止本次启动
      let downgraded = false;
      try {
        downgraded = await get().ensurePnpm10();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        get().appendLog("error", msg);
        set({ phase: "error", error: msg });
        return;
      }

      // dsh 已全局安装：启动链一律保留现有版本——绝不自动重装/更新（@latest 会
      // 覆盖现有 dsh 版本，历史上曾因 dsh 升级引发兼容性问题）。pnpm 刚从 11 降级
      // 时也不再重装；若旧 dsh 确因布局损坏无法启动，start_dsh_web 的完整性校验
      // 会给出明确错误，由用户在启动页点击「安装」手动重装。
      if (dshInstalled) {
        if (downgraded) {
          get().appendLog(
            "system",
            "检测到 pnpm 刚从 11 降级到 10：保留现有 dsh 版本继续启动（不再自动重装 @latest，避免覆盖现有版本）",
          );
        }
        get().appendLog("system", "检测到 dsh 已全局安装，跳过安装步骤");
        void get().startService();
      } else {
        get().appendLog("system", "开始全局安装 @deepseek-ai/dsh@latest …");
        set({ phase: "installing" });
        try {
          await api.installDsh();
        } catch (e) {
          get().appendLog("error", `安装失败：${String(e)}`);
          set({ phase: "error", error: String(e) });
        }
      }
    },

    /** 一键安装缺失的环境依赖并自动启动：node → pnpm → dsh →（既有链）插件依赖 → dsh web。
     *  每步安装后刷新 PATH 并重测环境，确认生效才进入下一步；
   *  dsh 仅在缺失或安装损坏（读不出版本）时安装——正常安装的 dsh 保留现有版本，
   *  绝不因 pnpm 降级等原因自动重装/更新 @latest。安装沿用 install-exit 事件链，装完自动续接启动。 */
    installEnvAndStart: async () => {
      if (!tauri) return;
      const st = get();
      if (st.phase === "installing" || st.phase === "starting" || st.phase === "running") return;
      // 独立日志记录：先开新会话（标题可被重启链路预置覆盖）
      const title = pendingSessionTitle ?? "安装并启动";
      pendingSessionTitle = null;
      await get().beginLogSession(title);
      set({ error: null });
      if (get().logs.length > 0) {
        get().appendLog("system", RESTART_SEPARATOR);
      }
      get().appendLog("system", "开始检查并自动安装缺失的运行环境依赖…");

      // 单步安装：invoke 触发 → 等待 exit 事件 → 校验退出码；invoke 同步失败时摘除 waiter 防悬挂
      const runStep = async (tool: "node" | "pnpm", label: string) => {
        set({ phase: "installing", envInstallTool: tool });
        const waiter = waitEnvExit();
        try {
          await api.installEnvTool(tool);
        } catch (e) {
          dropEnvExitWait();
          throw e;
        }
        const code = await waiter;
        if (code !== 0) {
          throw new Error(`${label}安装失败（退出码 ${code}），请查看下方日志`);
        }
        get().appendLog("success", `${label}安装完成`);
      };

      try {
        // ① Node.js（Windows: winget / macOS: brew；中文系统 npm 类安装自动走国内镜像）。
        // 安装判定按「路径未找到」而非「版本读不出」：版本读取在负载下偶发超时，
        // 据此重装会把好端端的 node（如 nvm 管理的）用 winget 再装一份并抢占 PATH。
        // 路径在、版本读不出 → 复检一次，仍读不出就按未知版本继续链路；
        // 版本可读且低于 22.19 → 确实需要 LTS，才走安装。
        if (!get().nodePath) {
          // 动手前复检一次：where 解析偶发超时不等于未安装
          await runToolCheck("node");
        }
        if (!get().nodePath) {
          get().appendLog(
            "system",
            "未检测到 Node.js：Windows 使用 winget、macOS 使用 Homebrew 自动安装 LTS 版本…",
          );
          await runStep("node", "Node.js");
          await api.refreshSearchPath();
          await pullStatusFields();
          if (!get().nodePath) {
            throw new Error("Node.js 已执行安装但当前会话仍未探测到，请重启本应用后重试");
          }
        } else if (get().nodeVersion && !meetsNodeRequirement(get().nodeVersion)) {
          get().appendLog(
            "system",
            `检测到 Node.js ${get().nodeVersion} 低于要求的 22.19：自动安装 LTS 版本…`,
          );
          await runStep("node", "Node.js");
          await api.refreshSearchPath();
          await pullStatusFields();
          if (!meetsNodeRequirement(get().nodeVersion)) {
            throw new Error("Node.js 已执行安装但当前会话仍未探测到，请重启本应用后重试");
          }
        } else if (!get().nodeVersion) {
          get().appendLog(
            "system",
            `已找到 Node.js（${get().nodePath}）但版本读取超时，按未知版本继续启动链…`,
          );
        }

        // ② pnpm（npm 全局安装，锁定 10.x——dsh 不支持 pnpm 11）
        if (!get().pnpmPath) {
          get().appendLog("system", "未检测到 pnpm，开始通过 npm 全局安装 pnpm@10（锁定版本，dsh 不支持 pnpm 11）…");
          await runStep("pnpm", "pnpm");
          await api.refreshSearchPath();
          await pullStatusFields();
          if (!get().pnpmPath) {
            throw new Error("pnpm 已执行安装但当前会话仍未探测到，请重启本应用后重试");
          }
        }
        // pnpm ≥11：一键降级到 10（dsh 不支持 pnpm 11）
        const downgraded = await get().ensurePnpm10();

        set({ phase: "installing", envInstallTool: null });
        // ③ dsh：仅在「缺失」或「已安装但无法读取版本（安装损坏，用户已通过
        //    「安装」/「重试」按钮明确要求修复）」时全局安装；正常安装的 dsh 一律
        //    保留现有版本——启动链绝不自动重装/更新 @latest 覆盖现有版本。
        //    沿用既有事件链——install-exit 成功后自动续接插件依赖安装与服务启动
        const dshBroken = Boolean(get().dshInstalled) && !get().dshVersion;
        if (!get().dshInstalled || dshBroken) {
          get().appendLog(
            "system",
            dshBroken
              ? "检测到 dsh 已安装但无法读取版本（安装可能已损坏），开始重新全局安装 @deepseek-ai/dsh@latest …"
              : "未检测到 dsh，开始全局安装 @deepseek-ai/dsh@latest …",
          );
          await api.installDsh();
          return; // 后续流程由既有事件链驱动，本函数到此结束
        }
        if (downgraded) {
          get().appendLog(
            "system",
            "检测到 pnpm 刚从 11 降级到 10：保留现有 dsh 版本继续启动（不再自动重装 @latest，避免覆盖现有版本）",
          );
        }

        // 环境全部就绪 → 直接进入现有启动链（含 dsh web 启动、自动打开）
        get().appendLog("success", "运行环境就绪");
        set({ envInstallTool: null });
        void get().startService();
      } catch (e) {
        dropEnvExitWait();
        const msg = e instanceof Error ? e.message : String(e);
        get().appendLog("error", msg);
        set({ phase: "error", error: msg, envInstallTool: null });
      }
    },
    stop: async () => {
      // 先置 stopped，避免 kill 触发 web-exit 事件时被误判为 error
      set({ phase: "stopped", childRunning: false, serviceRunning: false, url: null });
      try {
        await api.stopDshWeb();
      } catch {
        /* 忽略停止失败 */
      }
      get().appendLog("system", "已停止 dsh web 服务");
      // 结束当前日志会话：服务停止即会话结束（下次启动/重启会开新会话）
      const sid = get().logSessionId;
      if (sid) {
        void api.logSetStatus(sid, "closed").catch(() => undefined);
        set({ logSessionId: null });
      }
    },

    reset: () => {
      set({
        phase: "idle",
        url: null,
        error: null,
        serviceRunning: false,
        childRunning: false,
      });
    },
  };
});

// url/phase 变化时启停健康轮询；进入 installing/starting 时递增启动序号；
// 日志会话随 phase 上报终态（running → success / error → error）
// （模块加载完成后再挂订阅，避免 TDZ）
useAppStore.subscribe((s, prev) => {
  if (s.url !== prev.url || s.phase !== prev.phase) syncHealthPolling();
  if (s.phase !== prev.phase && (s.phase === "installing" || s.phase === "starting")) {
    useAppStore.setState({ startSeq: prev.startSeq + 1 });
  }
  if (s.phase !== prev.phase && s.logSessionId) {
    if (s.phase === "running") {
      void api.logSetStatus(s.logSessionId, "success").catch(() => undefined);
    } else if (s.phase === "error") {
      void api.logSetStatus(s.logSessionId, "error").catch(() => undefined);
    }
  }
});
syncHealthPolling(); // HMR/热启动兜底
