import { create } from "zustand";

export type ThemeMode = "system" | "light" | "dark";
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
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* ignore */
  }
  return "system";
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
  return {
    mode: initial,
    effective: initial === "system" ? systemPref() : initial,
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
    },
    setMode: (m) => {
      if (m !== "system" && m !== "light" && m !== "dark") return;
      try {
        localStorage.setItem(STORAGE_KEY, m);
      } catch {
        /* ignore */
      }
      set({ mode: m, effective: m === "system" ? systemPref() : m });
    },
  };
});
