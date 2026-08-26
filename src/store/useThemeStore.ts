import { create } from "zustand";

/** host = 跟随宿主（dsh web 预览页）主题；其余为手动/系统 */
export type ThemeMode = "host" | "system" | "light" | "dark";
export type EffectiveTheme = "light" | "dark";

const STORAGE_KEY = "hl.theme";

function systemPref(): EffectiveTheme {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function loadMode(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "host" || v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* ignore */
  }
  // 默认跟随宿主主题
  return "host";
}

interface ThemeState {
  mode: ThemeMode;
  effective: EffectiveTheme;
  init: () => void;
  setMode: (m: ThemeMode) => void;
  /** 宿主（dsh web iframe）主题变化时调用；仅 host 模式下生效 */
  setHostTheme: (t: EffectiveTheme) => void;
}

let inited = false;

export const useThemeStore = create<ThemeState>((set, get) => {
  const initial = loadMode();
  return {
    mode: initial,
    // host 模式：宿主主题到达前先用系统偏好兜底，避免首帧误判
    effective: initial === "host" ? systemPref() : initial === "system" ? systemPref() : initial,
    init: () => {
      if (inited) return;
      inited = true;
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const onChange = () => {
        const m = get().mode;
        if (m === "system" || m === "host") {
          set({ effective: mq.matches ? "dark" : "light" });
        }
      };
      mq.addEventListener("change", onChange);
    },
    setMode: (m) => {
      if (m !== "host" && m !== "system" && m !== "light" && m !== "dark") return;
      try {
        localStorage.setItem(STORAGE_KEY, m);
      } catch {
        /* ignore */
      }
      set({
        mode: m,
        effective:
          m === "host" || m === "system"
            ? systemPref()
            : m,
      });
    },
    setHostTheme: (t) => {
      // 仅"跟随宿主"模式被宿主主题驱动；用户手动选过主题后不再覆盖
      if (get().mode === "host") set({ effective: t });
    },
  };
});
