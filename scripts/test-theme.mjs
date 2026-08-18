// 交替切换：深色 -> 浅色 -> 深色 -> 浅色，验证第二次切换是否失效
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("C:/Users/Chris/AppData/Local/pnpm/global/5/.pnpm/playwright@1.59.1/node_modules/playwright");

const MOCK = `
window.__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: 'main' } },
  transformCallback: (cb, once) => {
    const id = 'cb_' + Math.random().toString(36).slice(2);
    window.__tauriCbs = window.__tauriCbs || {};
    window.__tauriCbs[id] = cb;
    return id;
  },
  unregisterCallback: () => {},
  invoke: async (cmd, args) => {
    if (cmd === 'app_status') {
      return { dsh_installed: true, service_running: false, child_running: false, url: null, pnpm_path: null, dsh_path: null };
    }
    if (cmd === 'plugin:event|listen') return 1;
    if (cmd === 'plugin:event|unlisten') return null;
    if (cmd === 'plugin:window|is_maximized') return false;
    return null;
  },
};
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  unregisterListener: () => {},
  registerListener: () => {},
};
`;

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", (err) => console.log("[pageerror]", err.message));
page.on("console", (msg) => {
  if (msg.type() === "error") console.log("[console.error]", msg.text());
});

await page.addInitScript(MOCK);
await page.goto("http://localhost:6089", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);

const state = async () =>
  page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    ls: localStorage.getItem("hl.theme"),
  }));

const clickItem = async (text) => {
  const btn = page.locator(".theme-switch").first();
  await btn.click();
  await page.waitForTimeout(600);
  const item = page.locator(".ant-dropdown-menu-item", { hasText: text }).first();
  let r = "no-item";
  if (await item.count()) {
    try {
      const box = await item.boundingBox();
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        r = "clicked";
      }
    } catch (e) {
      r = "FAIL: " + e.message.split("\n")[0];
    }
  }
  await page.waitForTimeout(500);
  return r;
};

console.log("initial:", JSON.stringify(await state()));
for (const label of ["深色", "浅色", "深色", "浅色", "跟随系统", "深色"]) {
  const r = await clickItem(label);
  console.log(`click ${label}: ${r}`, JSON.stringify(await state()));
}

await browser.close();

