/* 最终端到端验证：启动页 → 终端流程 → 预览 webview 内容 → 停止清理 */
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
      return { phase: s.phase, url: s.url, hash: location.hash };
    });

  // 1) 启动页 DOM
  await page.reload();
  await page.waitForTimeout(2500);
  const launch = await page.evaluate(() => ({
    title: document.title,
    heading: document.querySelector(".launch-title")?.textContent,
    logoImg: !!document.querySelector(".launch-logo img"),
    logoVisible: (() => { const i = document.querySelector(".launch-logo img"); if (!i) return false; const r = i.getBoundingClientRect(); return r.width > 0 && r.height > 0; })(),
    buttonText: document.querySelector(".btn-primary")?.textContent?.trim(),
    status: document.querySelector(".launch-status")?.textContent?.trim(),
  }));
  console.log("== 启动页 ==");
  console.log(JSON.stringify(launch, null, 2));

  // 2) 终端流程（强制 idle 模拟首次启动）
  await page.evaluate(() => {
    window.__store.setState({ phase: "idle", logs: [], url: null, serviceRunning: false, childRunning: false });
    location.hash = "#/terminal";
  });
  let phase = "";
  for (let i = 0; i < 90; i++) {
    const s = await snap();
    phase = s.phase;
    if (phase === "running" || phase === "error") break;
    await sleep(2000);
  }
  console.log("== 终端流程 ==");
  console.log("phase:", phase, JSON.stringify(await snap()));
  if (phase !== "running") process.exit(1);

  // 3) 等待自动跳转预览 + webview 内容
  await sleep(2500);
  const preview = await page.evaluate(() => ({
    hash: location.hash,
    webviews: [...document.querySelectorAll("webview")].map((w) => w.getAttribute("src")),
  }));
  console.log("== 预览页 ==");
  console.log(JSON.stringify(preview, null, 2));
  const wv = await page.evaluate(async () => {
    const w = document.querySelector("webview");
    if (!w) return { error: "no webview" };
    let title = null;
    try {
      title = await w.executeJavaScript("document.title + ' | ' + (document.querySelector('body') ? 'body-ok' : 'no-body')");
    } catch (e) {
      title = "eval-error: " + String(e);
    }
    return { title };
  });
  console.log("WEBVIEW CONTENT:", JSON.stringify(wv, null, 2));

  // 4) 停止 + Node 侧端口验证（不经过页面，避免误报）
  await page.evaluate(() => window.__store.getState().stop());
  await sleep(4000);
  const after = await snap();
  console.log("== 停止后 ==", JSON.stringify(after));
  let portState = "UNKNOWN";
  try {
    await fetch("http://127.0.0.1:3080", { signal: AbortSignal.timeout(2000) });
    portState = "ALIVE";
  } catch {
    portState = "CLOSED";
  }
  console.log("PORT 3080 (node-side):", portState);
  console.log("CONSOLE_ERRORS:", JSON.stringify(errors));

  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
