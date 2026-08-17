/* 通过 WebView2 CDP 验证 Harness Launcher 页面状态（开发用临时脚本） */
const { chromium } = require("C:/Users/Chris/AppData/Local/pnpm/global/5/node_modules/playwright");

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const contexts = browser.contexts();
  const pages = contexts.flatMap((c) => c.pages());
  console.log("TARGETS:", pages.map((p) => p.url()).join(" | "));

  const page = pages.find((p) => p.url().includes("5173"));
  if (!page) {
    console.log("main page not found");
    await browser.close();
    process.exit(1);
  }

  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(String(err)));

  await page.reload();
  await page.waitForTimeout(2500);

  const info = await page.evaluate(() => {
    const btn = document.querySelector(".btn-primary");
    const status = document.querySelector(".launch-status");
    const chips = [...document.querySelectorAll(".env-chip")].map((c) => c.textContent);
    return {
      title: document.title,
      heading: document.querySelector(".launch-title")?.textContent,
      buttonText: btn?.textContent?.trim(),
      buttonDisabled: btn?.hasAttribute("disabled") ?? null,
      statusText: status?.textContent?.trim(),
      chips,
      rootChildren: document.getElementById("root")?.children.length ?? 0,
    };
  });
  console.log("STATE:", JSON.stringify(info, null, 2));
  console.log("CONSOLE_ERRORS:", JSON.stringify(errors, null, 2));

  await browser.close();
})().catch((e) => {
  console.error("VERIFY FAILED:", e);
  process.exit(1);
});
