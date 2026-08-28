import { create } from "zustand";

/** 系统通知点击后待打开的会话（等预览 iframe 就绪后下发给 SESSION_OPEN_BRIDGE） */
export interface PendingOpenSession {
  sessionId: string;
  /** 发起时间：桥 ACK 前不清除；超过有效期（Preview 内 60s）视为陈旧丢弃 */
  sentAt: number;
}

interface UiState {
  reloadKey: number;
  bumpReload: () => void;
  /** 待打开的会话；Preview 页在 iframe 就绪后下发，收到桥 ACK 或过期后清空 */
  pendingOpenSession: PendingOpenSession | null;
  requestOpenSession: (sessionId: string) => void;
  clearPendingOpenSession: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  reloadKey: 0,
  bumpReload: () => set((s) => ({ reloadKey: s.reloadKey + 1 })),
  pendingOpenSession: null,
  requestOpenSession: (sessionId) =>
    set({ pendingOpenSession: { sessionId, sentAt: Date.now() } }),
  clearPendingOpenSession: () => set({ pendingOpenSession: null }),
}));
