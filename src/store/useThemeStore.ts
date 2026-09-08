import { create } from "zustand";

/** host = 跟随宿主（dsh web 预览页）主题；其余为手动/系统 */
export type ThemeMode = "host" | "system" | "light" | "dark";
export type EffectiveTheme = "light" | "dark";

const STORAGE_KEY = "hl.theme";
/** 跨窗口「生效主题」键（light/dark）：由 App 根组件在 effective 变化时写入。
 *  host 模式的宿主主题只到达主窗口（preview.rs emit_to("main")），设置/语音合成
 *  等窗口经此键跟随真实生效主题 */
export const EFFECTIVE_STORAGE_KEY = "hl.theme.effective";

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
  /** 宿主（dsh web iframe）主题变化时调用；仅 host 模式下生效 */
  setHostTheme: (t: EffectiveTheme) => void;
}

let inited = false;

export const useThemeStore = create<ThemeState>((set, get) => {
  const initial = loadMode();
  // 跨窗口首帧兜底：storage 事件不回送写入方，「知道宿主主题的主窗口」写入的
  // effective 键是其他窗口能拿到的最真实生效值，缺失时按原规则回退
  const storedEffective = loadEffective();
  return {
    mode: initial,
    effective: storedEffective
      ? storedEffective
      : initial === "host" || initial === "system"
        ? systemPref()
        : initial,
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
      // 跨窗口同步：storage 事件只在「其他窗口」触发（写入方收不到，无回环）。
      // mode 变化 → 同步模式并按原规则重算（host 模式优先用 effective 键兜底）；
      // effective 变化 → 直接采用，覆盖各模式下的窗口间差异
      window.addEventListener("storage", (e) => {
        if (e.key === EFFECTIVE_STORAGE_KEY) {
          if (e.newValue === "light" || e.newValue === "dark") {
            set({ effective: e.newValue });
          }
          return;
        }
        if (
          e.key === STORAGE_KEY &&
          (e.newValue === "host" ||
            e.newValue === "system" ||
            e.newValue === "light" ||
            e.newValue === "dark")
        ) {
          const m = e.newValue as ThemeMode;
          set({
            mode: m,
            effective:
              m === "host"
                ? (loadEffective() ?? systemPref())
                : m === "system"
                  ? systemPref()
                  : m,
          });
        }
      });
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
