/* E2E 验证 v2：终端流程 + 自动进入预览 + 停止清理（通过 WebView2 CDP） */
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

  await page.reload();
  await page.waitForTimeout(2500);

  const snap = () =>
    page.evaluate(() => {
      const s = window.__store.getState();
      return {
        phase: s.phase,
        url: s.url,
        childRunning: s.childRunning,
        serviceRunning: s.serviceRunning,
        logs: s.logs.slice(-3).map((l) => `${l.stream}:${l.text}`),
        hash: location.hash,
      };
    });

  console.log("== 初始状态 ==");
  console.log(JSON.stringify(await snap(), null, 2));

  // 驱动进入终端流程（模拟首次启动：强制 idle）
  await page.evaluate(() => {
    window.__store.setState({ phase: "idle", logs: [], url: null, serviceRunning: false, childRunning: false });
    location.hash = "#/terminal";
  });
  await page.waitForTimeout(1500);
  console.log("== 进入终端页 ==");
  console.log(JSON.stringify(await snap(), null, 2));

  let phase = "";
  for (let i = 0; i < 240; i++) {
    const s = await snap();
    phase = s.phase;
    if (i % 8 === 0 || phase === "running" || phase === "error") {
      console.log(`[t+${i * 2}s] phase=${phase} url=${s.url} child=${s.childRunning} hash=${s.hash}`);
    }
    if (phase === "running" || phase === "error") break;
    await sleep(2000);
  }

  if (phase !== "running") {
    console.log("E2E FAILED at terminal phase. Console errors:", JSON.stringify(errors, null, 2));
    process.exit(1);
  }

  // 确认自动跳转预览 + webview 元素
  await sleep(3000);
  console.log("== 预览页 ==");
  console.log(JSON.stringify(await snap(), null, 2));
  const webviews = await page.evaluate(() =>
    [...document.querySelectorAll("webview")].map((w) => w.getAttribute("src")),
  );
  console.log("WEBVIEW ELEMENTS:", JSON.stringify(webviews));
  const targets = await page.evaluate(() =>
    fetch("http://127.0.0.1:9222/json").then((r) => r.json()).then((ts) =>
      ts.map((t) => `${t.type}:${t.url}`),
    ),
  );
  console.log("CDP TARGETS:", JSON.stringify(targets));

  // 停止服务（应清理子进程树 + 端口监听）
  await page.evaluate(() => window.__store.getState().stop());
  await sleep(4000);
  console.log("== 停止后 ==");
  console.log(JSON.stringify(await snap(), null, 2));

  // 通过 CDP 检查 3080 是否关闭
  const probeResult = await page.evaluate(() =>
    fetch("http://127.0.0.1:3080", { method: "GET", cache: "no-store" })
      .then(() => "ALIVE")
      .catch(() => "CLOSED"),
  );
  console.log("PORT 3080 AFTER STOP:", probeResult);

  console.log("CONSOLE_ERRORS:", JSON.stringify(errors, null, 2));
  await browser.close();
})().catch((e) => {
  console.error("E2E FAILED:", e);
  process.exit(1);
});
