/* 最终验证：安装流式输出 → 自动启动 → webview 内容加载 → 停止清理 */
const { chromium } = require("C:/Users/Chris/AppData/Local/pnpm/global/5/node_modules/playwright");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("5173"));
  if (!page) {
    console.log("main page not found");
    process.exit(1);
  }
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(`[${new Date().toISOString()}] ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`[${new Date().toISOString()}] ${String(e)}`));

  const snap = () =>
    page.evaluate(() => {
      const s = window.__store.getState();
      return { phase: s.phase, url: s.url, logs: s.logs.slice(-6).map((l) => `${l.stream}:${l.text}`), hash: location.hash };
    });

  // 1) 直接调用安装命令（测试流式输出 + 完成后自动启动）
  console.log("== 调用 install_dsh（pnpm add -g）==");
  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("install_dsh"));
  await sleep(8000);
  const s1 = await snap();
  console.log("install 后状态:", JSON.stringify(s1, null, 2));

  // 2) 等待 running（install-exit 会自动 start_dsh_web）
  let phase = "";
  for (let i = 0; i < 90; i++) {
    const s = await snap();
    phase = s.phase;
    if (phase === "running" || phase === "error") {
      console.log(`[t+${i * 2}s] phase=${phase} url=${s.url} hash=${s.hash}`);
      break;
    }
    await sleep(2000);
  }
  if (phase !== "running") {
    console.log("NOT RUNNING. last:", JSON.stringify(await snap(), null, 2));
    process.exit(1);
  }
  await sleep(3000);

  // 3) webview 内容验证：dom-ready + 页面标题
  const wv = await page.evaluate(async () => {
    const w = document.querySelector("webview");
    if (!w) return { error: "no webview element" };
    const ready = await new Promise((resolve) => {
      const to = setTimeout(() => resolve("timeout"), 8000);
      w.addEventListener("dom-ready", () => { clearTimeout(to); resolve("dom-ready"); });
      if (w.getAttribute("src")) resolve("already-present");
    });
    let title = null;
    try {
      // @ts-ignore
      title = await w.executeJavaScript("document.title");
    } catch (e) {
      title = "eval-error: " + String(e);
    }
    return { ready, title, src: w.getAttribute("src") };
  });
  console.log("WEBVIEW:", JSON.stringify(wv, null, 2));

  // 4) 停止清理
  await page.evaluate(() => window.__store.getState().stop());
  await sleep(4000);
  console.log("== 停止后 ==");
  console.log(JSON.stringify(await snap(), null, 2));
  const probe = await page.evaluate(() =>
    fetch("http://127.0.0.1:3080", { cache: "no-store" }).then(() => "ALIVE").catch(() => "CLOSED"),
  );
  console.log("PORT 3080:", probe);
  console.log("CONSOLE_ERRORS:", JSON.stringify(errors, null, 2));

  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
