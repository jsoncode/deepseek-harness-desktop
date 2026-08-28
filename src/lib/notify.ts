import { EVENTS, onEvent, tauri } from "./tauri";

// ---------------------------------------------------------------------------
// 前端侧的通知消费：与 Rust `src-tauri/src/notify.rs` 的通道设计一一对应。
// Rust 投完系统 toast 后会把同一条消息 emit 过来（EVENTS.notifyMessage），
// 这里按通道分发。语音播放接入 = 往 channels 里再加一个 NotifyChannel。
// ---------------------------------------------------------------------------

/** 与 Rust `session_events::NotifyMessage` 同形（serde camelCase） */
export interface NotifyMessage {
  /** "todo" | "turnEnd" */
  kind: "todo" | "turnEnd";
  sessionId: string;
  /** 会话标题，未知为「未命名对话」 */
  sessionTitle: string;
  /** 标题：更新任务清单 / 对话结束 */
  title: string;
  /** 描述 */
  desc: string;
  /** 需求的 `{标题}：{描述}`，与系统通知同源 */
  summary: string;
  body: string;
  ts: number;
}

export type NotifyChannel = (m: NotifyMessage) => void;

/**
 * 语音播放通道：本期留桩。接通时在此朗读，例如
 * `speechSynthesis.speak(new SpeechSynthesisUtterance(`${m.title}，${m.desc}`))`。
 * 注意：窗口隐藏后 WebView2 可能节流定时器/音频，若实测不可靠，改为在 Rust
 * `notify.rs` 里加一个 VoiceChannel（Windows SAPI），上游同样零改动。
 */
const voiceChannel: NotifyChannel = () => {
  /* TODO(voice) */
};

/** 当前启用的前端通道。Rust 侧的 toast 通道不在此列（已直发系统通知）。 */
export const channels: NotifyChannel[] = [voiceChannel];

let started = false;

/** 幂等：App 挂载时调一次即可（浏览器预览模式无事件源，直接跳过） */
export function startNotifyListener(): void {
  if (started || !tauri) return;
  started = true;
  void onEvent<NotifyMessage>(EVENTS.notifyMessage, (m) => {
    for (const channel of channels) channel(m);
  });
}
