import { create } from "zustand";

/**
 * 主题模式：
 * - system：跟随操作系统外观
 * - light / dark：手动固定
 *
 * （历史上还有 "host" —— 跟随内嵌 dsh 预览页的主题。该模式已整体移除：
 * 预览页主题需要子 webview 注入脚本 + Rust 事件回传，链路长且实际使用中
 * 会让用户在两处分别切主题时互相打架，故只保留系统跟随与手动固定。）
 */
export type ThemeMode = "system" | "light" | "dark";
export type EffectiveTheme = "light" | "dark";

const STORAGE_KEY = "hl.theme";
/** 跨窗口「生效主题」键（light/dark）：由 App 根组件在 effective 变化时写入。
 *  设置、语音合成等窗口经此键跟随主窗口的真实生效主题 */
export const EFFECTIVE_STORAGE_KEY = "hl.theme.effective";

function systemPref(): EffectiveTheme {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/** 读取已保存的模式；历史上的 "host" 视作已废弃 → 回落到 system */
function loadMode(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* ignore */
  }
  // 默认跟随系统
  return "system";
}

function loadEffective(): EffectiveTheme | null {
  try {
    const v = localStorage.getItem(EFFECTIVE_STORAGE_KEY);
    if (v === "light" || v === "dark") return v;
  } catch {
    /* ignore */
  }
  return null;
}

interface ThemeState {
  mode: ThemeMode;
  effective: EffectiveTheme;
  init: () => void;
  setMode: (m: ThemeMode) => void;
}

let inited = false;

export const useThemeStore = create<ThemeState>((set, get) => {
  const initial = loadMode();
  // 跨窗口首帧兜底：storage 事件不回送写入方，主窗口写入的 effective 键
  // 是其他窗口能拿到的最真实生效值，缺失时按原规则回退
  const storedEffective = loadEffective();
  return {
    mode: initial,
    effective: storedEffective
      ? storedEffective
      : initial === "system"
        ? systemPref()
        : initial,
    init: () => {
      if (inited) return;
      inited = true;
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const onChange = () => {
        if (get().mode === "system") {
          set({ effective: mq.matches ? "dark" : "light" });
        }
      };
      mq.addEventListener("change", onChange);
      // 跨窗口同步：storage 事件只在「其他窗口」触发（写入方收不到，无回环）。
      // mode 变化 → 同步模式并按原规则重算；effective 变化 → 直接采用
      window.addEventListener("storage", (e) => {
        if (e.key === EFFECTIVE_STORAGE_KEY) {
          if (e.newValue === "light" || e.newValue === "dark") {
            set({ effective: e.newValue });
          }
          return;
        }
        if (
          e.key === STORAGE_KEY &&
          (e.newValue === "system" || e.newValue === "light" || e.newValue === "dark")
        ) {
          const m = e.newValue as ThemeMode;
          set({
            mode: m,
            effective: m === "system" ? systemPref() : m,
          });
        }
      });
    },
    setMode: (m) => {
      if (m !== "system" && m !== "light" && m !== "dark") return;
      try {
        localStorage.setItem(STORAGE_KEY, m);
      } catch {
        /* ignore */
      }
      set({
        mode: m,
        effective: m === "system" ? systemPref() : m,
      });
    },
  };
});
