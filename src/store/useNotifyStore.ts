import { create } from "zustand";
import { api } from "../lib/tauri";

/** 系统推送开关：关闭时 Rust 侧仍订阅并解析事件，只是不投递通知 */
export type NotifyMode = "on" | "off";

/** 系统推送样式：可点击（带「打开对话」按钮，点击直达对应会话）/ 不可点击（原样式仅展示） */
export type NotifyStyle = "clickable" | "plain";

const STORAGE_KEY = "hl.notify";
const STYLE_KEY = "hl.notify.style";

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

interface NotifyState {
  mode: NotifyMode;
  toggle: () => void;
  style: NotifyStyle;
  setStyle: (style: NotifyStyle) => void;
}

export const useNotifyStore = create<NotifyState>((set, get) => {
  // 创建时同步一次：Rust 侧默认开启，本机存的是 "off" 时必须一开始就压住推送
  const initial = loadMode();
  sync(initial);
  // 样式同理：本机存的值与 Rust 侧初值（clickable）不一致时需回写
  const initialStyle = loadStyle();
  syncStyle(initialStyle);
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
  };
});
