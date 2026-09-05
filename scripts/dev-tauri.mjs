// dev 构建入口：以独立的调试 app id（com.deepseek.harness.desktop.dev）运行 tauri dev，
// 避免与已安装的正式版（com.deepseek.harness.desktop）发生单实例冲突或共享 WebView2 数据。
// 正式打包（tauri build）不设置该环境变量，仍使用 tauri.conf.json 中的正式 id。
//
// 用法：node scripts/dev-tauri.mjs [--debug]
//   --debug：更深层调试 —— RUST_BACKTRACE=1（panic 回溯）、RUST_LOG=debug（预留，
//             Rust 侧接入 logger 后生效）、WebView2 --enable-logging=stderr
//             （Chromium/WebView2 日志输出到终端，排查 webview 层问题）
const debugMode = process.argv.includes("--debug");
process.env.TAURI_CONFIG = JSON.stringify({ identifier: "com.deepseek.harness.desktop.dev" });
if (debugMode) {
  process.env.RUST_BACKTRACE = "1";
  process.env.RUST_LOG = "debug";
  process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = [
    process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS,
    "--enable-logging=stderr",
  ]
    .filter(Boolean)
    .join(" ");
  console.log("[dev-tauri] debug 模式：RUST_BACKTRACE=1 / RUST_LOG=debug / WebView2 --enable-logging=stderr");
}

import { spawn } from "node:child_process";

const isWin = process.platform === "win32";
// TTS 语音合成已集成到默认构建中，无需 --features tts
const child = spawn(isWin ? "pnpm.cmd" : "pnpm", ["tauri", "dev"], {
  stdio: "inherit",
  shell: isWin,
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => child.kill(sig));
}
child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (err) => {
  console.error("[dev-tauri] 启动 tauri dev 失败:", err.message);
  process.exit(1);
});
