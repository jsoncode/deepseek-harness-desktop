import { create } from "zustand";

interface UiState {
  reloadKey: number;
  bumpReload: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  reloadKey: 0,
  bumpReload: () => set((s) => ({ reloadKey: s.reloadKey + 1 })),
}));
