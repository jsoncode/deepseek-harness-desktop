import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// ---------------------------------------------------------------------------
// 与 Rust 后端通信的桥接层
// ---------------------------------------------------------------------------

export interface LogLine {
  stream: string; // "system" | "stdout" | "stderr"
  line: string;
}

export interface ExitPayload {
  code: number;
}

export interface UrlPayload {
  url: string;
}

export interface StatusPayload {
  dsh_installed: boolean;
  service_running: boolean;
  child_running: boolean;
  url: string | null;
  pnpm_path: string | null;
  dsh_path: string | null;
}

export const EVENTS = {
  installLog: "dsh://install-log",
  installExit: "dsh://install-exit",
  webLog: "dsh://web-log",
  webExit: "dsh://web-exit",
  url: "dsh://url",
} as const;

export const api = {
  appStatus: () => invoke<StatusPayload>("app_status"),
  probeService: (url: string) => invoke<boolean>("probe_service", { url }),
  installDsh: () => invoke<void>("install_dsh"),
  startDshWeb: () => invoke<void>("start_dsh_web"),
  stopDshWeb: () => invoke<void>("stop_dsh_web"),
  openInBrowser: (url: string) => invoke<void>("open_in_browser", { url }),
};

export async function onEvent<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  return listen<T>(event, (e) => handler(e.payload));
}
