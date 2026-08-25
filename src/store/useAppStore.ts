import { create } from "zustand";
import { api, EVENTS, onEvent, tauri, type ExitPayload, type LogLine, type PluginVersionInfo, type StatusPayload, type UrlPayload } from "../lib/tauri";

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
      if (get().phase === "running") {
        get().appendLog("error", `dsh web 进程已退出（退出码 ${p.code}）`);
        set({ phase: "stopped", serviceRunning: false });
        return;
      }
      get().appendLog("error", `❌ dsh web 启动失败（退出码 ${p.code}）`);
      set({ phase: "error", error: `dsh web 启动失败，退出码 ${p.code}` });
    });

    onEvent<UrlPayload>(EVENTS.url, (p) => {
      set({ url: p.url, serviceRunning: true, childRunning: true, serviceAlive: true });
      get().appendLog("success", `🚀 服务已就绪：${p.url}`);
      set({ phase: "running" });
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
        const s: StatusPayload = await api.appStatus();
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
        set({ phase: "error", error: String(e), initialized: true });
      }
    },

    refreshStatus: async () => {
      // 启动中不打断
      const cur = get().phase;
      if (cur === "installing" || cur === "starting") return;
      try {
        const s: StatusPayload = await api.appStatus();
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
