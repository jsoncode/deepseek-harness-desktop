import { create } from "zustand";
import { api, EVENTS, onEvent, tauri, withTimeout, type ExitPayload, type LogLine, type PluginVersionInfo, type StatusPayload, type UrlPayload } from "../lib/tauri";
import { meetsNodeRequirement, pnpmMajorOf } from "../lib/envReq";

// ---------------------------------------------------------------------------
// 应用状态机：checking → idle | installing → starting → running
//                                    ↘ error / stopped
// ---------------------------------------------------------------------------

export type Phase = "checking" | "idle" | "installing" | "starting" | "running" | "error" | "stopped";

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

  init: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  ensurePluginsThenStart: () => Promise<void>;
  startFlow: () => Promise<void>;
  /** 一键安装缺失的环境依赖（node → pnpm → dsh）并自动启动服务 */
  installEnvAndStart: () => Promise<void>;
  /** pnpm ≥11（dsh 不支持）时降级到 pnpm 10；返回是否执行了降级 */
  ensurePnpm10: () => Promise<boolean>;
  /** 正在通过自动链路安装的环境依赖（驱动启动页按钮/状态文案） */
  envInstallTool: "node" | "pnpm" | null;
  stop: () => Promise<void>;
  reset: () => void;
  appendLog: (stream: StreamKind, text: string) => void;
  appendPluginOpLog: (stream: StreamKind, text: string) => void;
  startPluginOp: (kind: PluginOpKind, name: string) => Promise<void>;
  refreshPluginVersions: () => Promise<void>;
  setPhase: (phase: Phase) => void;
  /** 上报插件加载失败（由 Preview 页收到的 iframe postMessage 调用） */
  reportPluginLoadError: (name: string, message: string) => void;
  clearPluginLoadError: () => void;
}

let logSeq = 0;
let wired = false;

/** 会话内日志上限：超出后丢弃最旧日志 */
const MAX_LOGS = 3000;
/** 日志截断提示（截断期间顶部恒有一条：每次截断重建，旧提示随最旧日志一起被丢弃） */
const TRUNCATED_NOTE = "（历史日志过长，已截断早期内容）";
/** 重新启动服务时的日志分隔线 */
const RESTART_SEPARATOR = "────── 重新启动服务 ──────";
/** 插件操作日志上限 */
const MAX_PLUGIN_OP_LOGS = 1000;
/** 环境依赖单步安装的等待上限：winget/brew 下载安装可能耗时数分钟 */
const ENV_INSTALL_TIMEOUT_MS = 15 * 60 * 1000;

// 环境依赖安装为事件驱动（后端流式转发、退出码异步通知）。
// 链路严格按 node → pnpm → dsh 顺序执行，同一时刻只有一步在等待，
// 因此用单槽 resolver 即可：waitEnvExit 挂槽，env-install-exit 事件触发。
let envExitResolve: ((code: number) => void) | null = null;
let envExitTimer: ReturnType<typeof setTimeout> | null = null;

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

/** 按 url/phase 启停健康轮询定时器（由 store subscribe 驱动） */
function syncHealthPolling() {
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

    onEvent<LogLine>(EVENTS.installLog, (p) => {
      const stream: StreamKind =
        p.stream === "stderr" ? "stderr" : p.stream === "system" ? "system" : "stdout";
      get().appendLog(stream, p.line);
    });

    onEvent<ExitPayload>(EVENTS.installExit, (p) => {
      if (p.code === 0) {
        get().appendLog("success", "✅ @deepseek-ai/dsh 全局安装完成");
        set({ dshInstalled: true });
        void get().ensurePluginsThenStart();
      } else {
        get().appendLog("error", `❌ 安装失败（退出码 ${p.code}），请检查网络或 pnpm 配置`);
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

    onEvent<LogLine>(EVENTS.pluginInstallLog, (p) => {
      get().appendLog("system", p.line);
    });

    onEvent<ExitPayload>(EVENTS.pluginInstallExit, (p) => {
      if (get().phase !== "installing") return; // 仅插件安装阶段生效
      if (p.code === 0) {
        get().appendLog("success", "✅ 插件依赖安装完成");
        set({ phase: "starting" });
        get().appendLog("system", "开始启动本地服务：dsh web …");
        void api.startDshWeb().catch((e) => {
          get().appendLog("error", `启动失败：${String(e)}`);
          set({ phase: "error", error: String(e) });
        });
      } else {
        get().appendLog("error", `❌ 插件依赖安装失败（退出码 ${p.code}）`);
        set({ phase: "error", error: `插件依赖安装失败，退出码 ${p.code}` });
      }
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
    });

    onEvent<ExitPayload>(EVENTS.webExit, (p) => {
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
        // 复核等待期间用户可能已停止/重新发起启动：陈旧事件直接忽略
        const cur = get();
        if (cur.phase === "stopped" || cur.phase === "installing" || cur.phase === "starting")
          return;
        if (cur.phase === "running") {
          get().appendLog("error", `dsh web 进程已退出（退出码 ${p.code}）`);
          set({ phase: "stopped", serviceRunning: false });
          return;
        }
        get().appendLog("error", `❌ dsh web 启动失败（退出码 ${p.code}）`);
        set({ phase: "error", error: `dsh web 启动失败，退出码 ${p.code}` });
      })();
    });

    onEvent<UrlPayload>(EVENTS.url, (p) => {
      set({ url: p.url, serviceRunning: true, childRunning: true, serviceAlive: true });
      get().appendLog("success", `🚀 服务已就绪：${p.url}`);
      set({ phase: "running" });
    });
  }

  /** 无条件拉取最新环境状态并合并进 store（phase 由调用方链路控制，不在此改动）；
   *  安装链每步之后调用，用于确认上一步安装是否真正生效 */
  async function pullStatusFields(): Promise<void> {
    const s: StatusPayload = await withTimeout(api.appStatus(), 10000, "环境检测");
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
    envInstallTool: null,

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

    clearPluginLoadError: () => set({ pluginLoadError: null }),

    reportPluginLoadError: (name, message) =>
      set((s) =>
        // 已有未处理的弹框时不覆盖（避免连续多个插件失败时弹框打架）
        s.pluginLoadError ? s : { pluginLoadError: { name, message } },
      ),

    init: async () => {
      wireEvents();
      if (get().initialized) return;
      set({ phase: "checking" });
      if (!tauri) {
        // 浏览器预览模式：无 Rust 后端，保持空闲态，避免误报"启动失败"
        set({ phase: "idle", initialized: true });
        return;
      }
      try {
        // 环境检测有超时兜底：后端探测（where/--version/PowerShell）均已限时，
        // 前端再加一层保护，避免任何意外挂起让启动页永远卡在"检测中"
        const s: StatusPayload = await withTimeout(api.appStatus(), 10000, "环境检测");
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
          phase: s.service_running
            ? "running"
            : s.child_running
              ? "starting"
              : "idle",
          initialized: true,
        });
      } catch (e) {
        // 超时/失败：不误报"启动失败"，回到就绪态让用户可手动重试
        set({ phase: "idle", error: null, initialized: true });
      }
    },

    refreshStatus: async () => {
      // 启动中不打断
      const cur = get().phase;
      if (cur === "installing" || cur === "starting") return;
      try {
        const s: StatusPayload = await withTimeout(api.appStatus(), 10000, "环境检测");
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
          phase: s.service_running
            ? "running"
            : s.child_running
              ? "starting"
              : cur === "stopped" || cur === "error"
                ? cur
                : "idle",
          initialized: true,
        });
      } catch {
        /* 忽略刷新失败 */
      }
    },

    ensurePluginsThenStart: async () => {
      const s = get();
      // 浏览器预览或 profile 未生成（首次运行）：跳过插件安装直接启动
      if (!tauri || !s.profileReady) {
        set({ phase: "starting", error: null });
        get().appendLog("system", "开始启动本地服务：dsh web …");
        try {
          await api.startDshWeb();
        } catch (e) {
          get().appendLog("error", `启动失败：${String(e)}`);
          set({ phase: "error", error: String(e) });
        }
        return;
      }
      get().appendLog("system", "安装插件依赖：pnpm install …");
      set({ phase: "installing", error: null });
      try {
        await api.installPlugins(); // 结果由 plugin-install-exit 事件驱动续接
      } catch (e) {
        get().appendLog("error", `插件依赖安装失败：${String(e)}`);
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
      get().appendLog("success", "✅ 已降级到 pnpm 10");
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
        get().appendLog("error", `❌ ${msg}`);
        set({ phase: "error", error: msg });
        return;
      }

      if (dshInstalled && downgraded) {
        get().appendLog(
          "system",
          "检测到 dsh 由 pnpm 11 安装（布局不兼容），重新全局安装 @deepseek-ai/dsh@latest …",
        );
        set({ phase: "installing" });
        try {
          await api.installDsh(); // install-exit 事件链自动续接启动
        } catch (e) {
          get().appendLog("error", `安装失败：${String(e)}`);
          set({ phase: "error", error: String(e) });
        }
        return;
      }

      if (dshInstalled) {
        get().appendLog("system", "✔ 检测到 dsh 已全局安装，跳过安装步骤");
        void get().ensurePluginsThenStart();
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
   *  dsh 安装沿用 install-exit 事件链，装完自动续接启动。 */
    installEnvAndStart: async () => {
      if (!tauri) return;
      const st = get();
      if (st.phase === "installing" || st.phase === "starting" || st.phase === "running") return;
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
        get().appendLog("success", `✅ ${label}安装完成`);
      };

      try {
        // ① Node.js（Windows: winget / macOS: brew；中文系统 npm 类安装自动走国内镜像）
        if (!meetsNodeRequirement(get().nodeVersion)) {
          get().appendLog(
            "system",
            "未检测到可用的 Node.js（≥22.19）：Windows 使用 winget、macOS 使用 Homebrew 自动安装 LTS 版本…",
          );
          await runStep("node", "Node.js");
          await api.refreshSearchPath();
          await pullStatusFields();
          if (!meetsNodeRequirement(get().nodeVersion)) {
            throw new Error("Node.js 已执行安装但当前会话仍未探测到，请重启本应用后重试");
          }
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
        // ③ dsh：缺失，或刚从 pnpm 11 降级（旧 dsh 为坏布局）→ 重新全局安装。
        //    沿用既有事件链——install-exit 成功后自动续接插件依赖安装与服务启动
        if (!get().dshInstalled || downgraded) {
          get().appendLog(
            "system",
            downgraded
              ? "检测到 dsh 由 pnpm 11 安装（布局不兼容），重新全局安装 @deepseek-ai/dsh@latest …"
              : "开始全局安装 @deepseek-ai/dsh@latest …",
          );
          await api.installDsh();
          return; // 后续流程由既有事件链驱动，本函数到此结束
        }

        // 环境全部就绪 → 直接进入现有启动链（含插件依赖与 dsh web 启动、自动打开）
        get().appendLog("success", "✅ 运行环境就绪");
        set({ envInstallTool: null });
        void get().ensurePluginsThenStart();
      } catch (e) {
        dropEnvExitWait();
        const msg = e instanceof Error ? e.message : String(e);
        get().appendLog("error", `❌ ${msg}`);
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
      get().appendLog("system", "🛑 已停止 dsh web 服务");
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

// url/phase 变化时启停健康轮询（模块加载完成后再挂订阅，避免 TDZ）
useAppStore.subscribe((s, prev) => {
  if (s.url !== prev.url || s.phase !== prev.phase) syncHealthPolling();
});
syncHealthPolling(); // HMR/热启动兜底
