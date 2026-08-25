import { create } from "zustand";
import { api, EVENTS, onEvent, tauri, type ExitPayload, type LogLine, type StatusPayload, type UrlPayload } from "../lib/tauri";

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

interface AppStore {
  phase: Phase;
  logs: LogEntry[];
  url: string | null;
  dshInstalled: boolean;
  serviceRunning: boolean;
  childRunning: boolean;
  pnpmPath: string | null;
  dshPath: string | null;
  nodePath: string | null;
  nodeVersion: string | null;
  pnpmVersion: string | null;
  plugins: string[];
  profileReady: boolean;
  error: string | null;
  initialized: boolean;

  init: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  ensurePluginsThenStart: () => Promise<void>;
  startFlow: () => Promise<void>;
  stop: () => Promise<void>;
  reset: () => void;
  appendLog: (stream: StreamKind, text: string) => void;
  setPhase: (phase: Phase) => void;
}

let logSeq = 0;
let wired = false;

/** 会话内日志上限：超出后丢弃最旧日志 */
const MAX_LOGS = 3000;
/** 日志截断提示（截断期间顶部恒有一条：每次截断重建，旧提示随最旧日志一起被丢弃） */
const TRUNCATED_NOTE = "（历史日志过长，已截断早期内容）";
/** 重新启动服务时的日志分隔线 */
const RESTART_SEPARATOR = "────── 重新启动服务 ──────";

function now(): string {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
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
      set({ url: p.url, serviceRunning: true, childRunning: true });
      get().appendLog("success", `🚀 服务已就绪：${p.url}`);
      set({ phase: "running" });
    });
  }

  return {
    phase: "checking",
    logs: [],
    url: null,
    dshInstalled: false,
    serviceRunning: false,
    childRunning: false,
    pnpmPath: null,
    dshPath: null,
    nodePath: null,
    nodeVersion: null,
    pnpmVersion: null,
    plugins: [],
    profileReady: false,
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

    setPhase: (phase) => set({ phase }),

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
