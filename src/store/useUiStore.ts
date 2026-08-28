import { create } from "zustand";

/** 系统通知点击后待打开的会话（等预览 iframe 就绪再下发给 SESSION_OPEN_BRIDGE） */
export interface PendingOpenSession {
  sessionId: string;
}

interface UiState {
  reloadKey: number;
  bumpReload: () => void;
  /** 待打开的会话；Preview 页在 iframe 就绪后消费并清空 */
  pendingOpenSession: PendingOpenSession | null;
  requestOpenSession: (session: PendingOpenSession) => void;
  clearPendingOpenSession: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  reloadKey: 0,
  bumpReload: () => set((s) => ({ reloadKey: s.reloadKey + 1 })),
  pendingOpenSession: null,
  requestOpenSession: (session) => set({ pendingOpenSession: session }),
  clearPendingOpenSession: () => set({ pendingOpenSession: null }),
}));
