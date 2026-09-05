import { create } from "zustand";
import { api, type VoiceConfig } from "../lib/tauri";

/** 系统推送开关：关闭时 Rust 侧仍订阅并解析事件，只是不投递通知 */
export type NotifyMode = "on" | "off";

/** 系统推送样式：可点击（带「打开对话」按钮，点击直达对应会话）/ 不可点击（原样式仅展示） */
export type NotifyStyle = "clickable" | "plain";

const STORAGE_KEY = "hl.notify";
const STYLE_KEY = "hl.notify.style";
const VOICE_KEY = "hl.notify.voice";

/** 合成参数默认值：与 Rust `tts::VoiceConfig::default` 一致（即 tts_worker.py
 * 原硬编码值，默认行为不变）；配置面板「恢复默认」按钮复用 */
export const VOICE_SYNTH_DEFAULTS = {
  temperature: 0.8,
  topP: 0.95,
  topK: 50,
  seed: 42,
  maxNewTokens: 512,
  greedy: false,
} as const;

/** 语音播报默认配置：与 Rust `tts::VoiceConfig::default` 一致。
 *  voiceId 空值由 Rust 解析为默认内置音色（tts_builtin_voices 中 isDefault 项，
 *  当前为 "wanwan"），老版本存储缺该字段时经合并补齐后行为一致 */
const VOICE_DEFAULT: VoiceConfig = {
  enabled: false,
  speakContent: "summary",
  pythonCmd: "python",
  repoDir: "",
  modelDir: "",
  voiceId: "",
  refAudio: "",
  refText: "",
  ...VOICE_SYNTH_DEFAULTS,
};

function loadVoice(): VoiceConfig {
  try {
    const raw = localStorage.getItem(VOICE_KEY);
    if (!raw) return { ...VOICE_DEFAULT };
    // 局部容错合并：老版本/手改的存储缺字段时用默认值补齐
    const parsed = JSON.parse(raw) as Partial<VoiceConfig>;
    return { ...VOICE_DEFAULT, ...parsed };
  } catch {
    return { ...VOICE_DEFAULT };
  }
}

function loadMode(): NotifyMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "on" || v === "off") return v;
  } catch {
    /* ignore */
  }
  // 默认开启，与 Rust 侧 `AppState::notify_enabled` 的初值一致；
  // 需要静默的用户点一下铃铛即可，下次启动由本存储接回
  return "on";
}

function loadStyle(): NotifyStyle {
  try {
    const v = localStorage.getItem(STYLE_KEY);
    if (v === "clickable" || v === "plain") return v;
  } catch {
    /* ignore */
  }
  // 默认可点击，与 Rust 侧 `AppState::notify_style` 的初值一致
  return "clickable";
}

/** 把开关状态同步给 Rust（浏览器预览模式下 requireTauri 直接 reject，忽略即可） */
function sync(mode: NotifyMode) {
  void api.setNotifyEnabled(mode === "on").catch(() => undefined);
}

/** 把样式状态同步给 Rust */
function syncStyle(style: NotifyStyle) {
  void api.setNotifyStyle(style === "clickable" ? 1 : 0).catch(() => undefined);
}

/** 把语音播报配置同步给 Rust（python/仓库/模型变化会在下次合成时重建 worker） */
function syncVoice(config: VoiceConfig) {
  void api.setVoiceConfig(config).catch(() => undefined);
}

interface NotifyState {
  mode: NotifyMode;
  toggle: () => void;
  style: NotifyStyle;
  setStyle: (style: NotifyStyle) => void;
  voice: VoiceConfig;
  /** 局部更新语音配置：合并、持久化并同步 Rust（校验失败只回显，不回滚本地） */
  setVoice: (patch: Partial<VoiceConfig>) => void;
}

export const useNotifyStore = create<NotifyState>((set, get) => {
  // 创建时同步一次：Rust 侧默认开启，本机存的是 "off" 时必须一开始就压住推送
  const initial = loadMode();
  sync(initial);
  // 样式同理：本机存的值与 Rust 侧初值（clickable）不一致时需回写
  const initialStyle = loadStyle();
  syncStyle(initialStyle);
  // 语音配置：Rust 侧默认全关，本地存的路径/开关必须一开始就灌回去
  const initialVoice = loadVoice();
  syncVoice(initialVoice);
  return {
    mode: initial,
    toggle: () => {
      const next: NotifyMode = get().mode === "on" ? "off" : "on";
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* ignore */
      }
      set({ mode: next });
      sync(next);
    },
    style: initialStyle,
    setStyle: (next: NotifyStyle) => {
      try {
        localStorage.setItem(STYLE_KEY, next);
      } catch {
        /* ignore */
      }
      set({ style: next });
      syncStyle(next);
    },
    voice: initialVoice,
    setVoice: (patch) => {
      const next = { ...get().voice, ...patch };
      try {
        localStorage.setItem(VOICE_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      set({ voice: next });
      syncVoice(next);
    },
  };
});

// 跨窗口同步：语音合成工具是独立窗口，与主窗口共用同一 origin 的 localStorage。
// storage 事件只在「其他」窗口触发——任一窗口改了语音配置，另一个窗口即时跟上
// （写入方自身走 setVoice 更新；Rust 侧由写入方 syncVoice，无需重复回灌）
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== VOICE_KEY) return;
    try {
      const parsed = e.newValue ? (JSON.parse(e.newValue) as Partial<VoiceConfig>) : null;
      if (parsed) useNotifyStore.setState({ voice: { ...VOICE_DEFAULT, ...parsed } });
    } catch {
      /* ignore */
    }
  });
}

/**
 * 应用启动时显式回灌全部推送相关配置（幂等）。
 *
 * 必须由 App 挂载时调用，不能依赖 store 创建时的同步副作用：本模块历史上只被
 * 「设置→通知管理」与语音工具窗口引用——应用重启后用户不打开设置页的话，
 * Rust 侧语音配置停留在默认值（enabled=false），所有通知的语音都被静默跳过
 * （「通知弹了但没有声音」的实测根因）。App.tsx 引入本函数后，配置在启动即回灌。
 */
export function initNotifySync(): void {
  const s = useNotifyStore.getState();
  sync(s.mode);
  syncStyle(s.style);
  syncVoice(s.voice);
}
