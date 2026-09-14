import { create } from "zustand";

/** 系统通知点击后待打开的会话（等预览 iframe 就绪后下发给 SESSION_OPEN_BRIDGE） */
export interface PendingOpenSession {
  sessionId: string;
  /** 发起时间：桥 ACK 前不清除；超过有效期（Preview 内 60s）视为陈旧丢弃 */
  sentAt: number;
}

/** 请求打开设置页的意图（设置窗口已存在时经 storage 事件送达） */
export interface SettingsIntentDetail {
  /** 目标分区，如 "about" */
  section: string;
  /** 分区内的动作，如 "dsh-update"（打开 dsh CLI 更新弹框） */
  action?: string;
  /** 一次性动作序号：消费方按值去重，避免同一意图重复触发 */
  seq: number;
}

interface UiState {
  reloadKey: number;
  bumpReload: () => void;
  /** 待打开的会话；Preview 页在 iframe 就绪后下发，收到桥 ACK 或过期后清空 */
  pendingOpenSession: PendingOpenSession | null;
  requestOpenSession: (sessionId: string) => void;
  clearPendingOpenSession: () => void;

  /**
   * 请求设置窗口打开某分区并执行某动作（当前意图 + 单调序号）。
   *
   * 场景：插件管理里搜到本应用自身（dsh CLI / deepseek-harness）时，不就地安装，
   * 而是切到「关于本应用」并弹出 dsh CLI 更新弹框。设置页与插件管理同在设置窗口，
   * 因此多数情况下只是本窗口内的状态流转；但若设置页从主窗口深链打开（窗口已存在
   * 时 Rust 只是聚焦并改 hash），意图仍需跨窗口送达——调用方负责经 storage 广播，
   * 本 store 只承载状态与序号（见 requestSettingsIntent 调用点）。
   */
  settingsIntent: SettingsIntentDetail | null;
  requestSettingsIntent: (section: string, action?: string) => void;
  clearSettingsIntent: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  reloadKey: 0,
  bumpReload: () => set((s) => ({ reloadKey: s.reloadKey + 1 })),
  pendingOpenSession: null,
  requestOpenSession: (sessionId) =>
    set({ pendingOpenSession: { sessionId, sentAt: Date.now() } }),
  clearPendingOpenSession: () => set({ pendingOpenSession: null }),

  settingsIntent: null,
  requestSettingsIntent: (section, action) =>
    set((s) => ({
      settingsIntent: {
        section,
        action,
        seq: (s.settingsIntent?.seq ?? 0) + 1,
      },
    })),
  clearSettingsIntent: () => set({ settingsIntent: null }),
}));
