# 断连提示改为标题栏指示灯 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 移除预览页「本地服务已断开连接」覆盖层；服务断连仅将标题栏指示灯变红（连续 2 次探测失败才判定，防误报），恢复后自动变绿。

**架构：** 健康轮询从 Preview 页上移到 useAppStore——新增 `serviceAlive` 状态，模块级定时器仅在 `url && phase === "running"` 时运行，经 zustand subscribe 监听 url/phase 变化启停；TitleBar 按 `serviceAlive + phase` 渲染三色指示灯；Preview 删除全部断连 UI。

**技术栈：** React 19 + zustand v5（subscribe）+ antd；Rust 无改动。

**规格：** `docs/superpowers/specs/2026-08-25-disconnect-indicator-design.md`

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/store/useAppStore.ts` | 修改 | `serviceAlive` 状态、全局健康轮询（6s 间隔 + 连续 2 次失败防抖）、订阅 url/phase 启停 |
| `src/components/TitleBar.tsx` | 修改 | 地址条指示灯三态（灰/绿/红） |
| `src/pages/Preview.tsx` | 修改 | 删除覆盖层、页面内轮询、recheck 及相关状态 |
| `src/styles/global.css` | 修改 | 新增 `.dot.off`/`.dot.down`；删除 `.preview-overlay` 两段 |
| `README.md` / `README.en.md` | 修改 | 预览页功能描述同步 |

---

### 任务 1：useAppStore 全局健康轮询

**文件：**
- 修改：`src/store/useAppStore.ts`

- [ ] **步骤 1.1：接口与初始值**

接口（`profileReady` 后）追加：

```ts
  serviceAlive: boolean;
```

初始值（`profileReady: false,` 后）追加：

```ts
  serviceAlive: true,
```

- [ ] **步骤 1.2：模块级轮询实现（`RESTART_SEPARATOR` 常量之后）**

```ts
/** 服务健康轮询：仅运行中探测；连续 2 次失败才判定断连，任一次成功即恢复 */
let healthTimer: ReturnType<typeof setInterval> | null = null;
let healthFailCount = 0;
const HEALTH_INTERVAL_MS = 6000;

function healthTick() {
  const s = useAppStore.getState();
  if (!s.url || s.phase !== "running") return;
  void api
    .probeService(s.url)
    .then((ok) => {
      if (ok) {
        healthFailCount = 0;
        if (!useAppStore.getState().serviceAlive) useAppStore.setState({ serviceAlive: true });
      } else {
        healthFailCount += 1;
        if (healthFailCount >= 2 && useAppStore.getState().serviceAlive) {
          useAppStore.setState({ serviceAlive: false });
        }
      }
    })
    .catch(() => {
      healthFailCount += 1;
      if (healthFailCount >= 2 && useAppStore.getState().serviceAlive) {
        useAppStore.setState({ serviceAlive: false });
      }
    });
}

/** 按 url/phase 启停健康轮询定时器（由 store subscribe 驱动） */
function syncHealthPolling() {
  const s = useAppStore.getState();
  const shouldPoll = Boolean(s.url) && s.phase === "running";
  if (shouldPoll && healthTimer === null) {
    healthFailCount = 0;
    healthTimer = setInterval(healthTick, HEALTH_INTERVAL_MS);
  } else if (!shouldPoll && healthTimer !== null) {
    clearInterval(healthTimer);
    healthTimer = null;
    // 离开运行态：恢复默认存活，灯色交由 phase 表达（已停止 → 红）
    if (!useAppStore.getState().serviceAlive) useAppStore.setState({ serviceAlive: true });
  }
}
```

- [ ] **步骤 1.3：create 之后接订阅（文件末尾、export 之后）**

```ts
// url/phase 变化时启停健康轮询
useAppStore.subscribe((s, prev) => {
  if (s.url !== prev.url || s.phase !== prev.phase) syncHealthPolling();
});
syncHealthPolling(); // HMR/热启动兜底
```

注意：`create` 调用需改为 `export const useAppStore = create<AppStore>(...)` 已是如此，subscribe 直接挂 store 对象。

- [ ] **步骤 1.4：服务就绪时重置存活状态**

`wireEvents` 的 `EVENTS.url` 处理器 set 中追加 `serviceAlive: true`：

```ts
      set({ url: p.url, serviceRunning: true, childRunning: true, serviceAlive: true });
```

`init` 与 `refreshStatus` 中 phase 为 running 的分支无需显式设置（默认 true 且离开 running 会复位），但 refreshStatus 在外部检测到服务运行时也应重置——在两处 set 中追加：

```ts
          serviceAlive: s.service_running,
```

- [ ] **步骤 1.5：验证 + Commit**

运行：`pnpm build`
预期：成功。

```bash
git add src/store/useAppStore.ts
git commit -m "feat(store): 全局服务健康轮询与防抖断连判定"
```

---

### 任务 2：标题栏指示灯三态

**文件：**
- 修改：`src/components/TitleBar.tsx`
- 修改：`src/styles/global.css`

- [ ] **步骤 2.1：TitleBar 取状态并渲染**

新增 selector：

```ts
const serviceAlive = useAppStore((s) => s.serviceAlive);
```

url-pill 的 dot 改为：

```tsx
<div className="url-pill">
  <span className={`dot${!url ? " off" : serviceAlive && phase === "running" ? "" : " down"}`} />
  <span className="url-value">{url ?? "未检测到服务"}</span>
</div>
```

- [ ] **步骤 2.2：CSS 三态**

`.url-pill .dot { ... }` 规则之后追加：

```css
/* 无服务地址 */
.url-pill .dot.off {
  background: var(--text-3);
  box-shadow: none;
}

/* 运行中但断连（或已停止）：红色呼吸提醒 */
.url-pill .dot.down {
  background: var(--danger);
  box-shadow: 0 0 8px rgba(248, 113, 113, 0.8);
  animation: pulseDot 1.6s ease-in-out infinite;
}
```

- [ ] **步骤 2.3：验证 + Commit**

`pnpm build` exit=0 后：

```bash
git add src/components/TitleBar.tsx src/styles/global.css
git commit -m "feat(titlebar): 服务指示灯三态，断连变红"
```

---

### 任务 3：Preview 移除断连拦截

**文件：**
- 修改：`src/pages/Preview.tsx`
- 修改：`src/styles/global.css`

- [ ] **步骤 3.1：删除以下代码块**

1. 状态：`const [alive, setAlive] = useState(true);` 与 `const [rechecking, setRechecking] = useState(false);`
2. 「服务健康轮询」整个 useEffect（含 probeService/setInterval）
3. `recheck` 整个 useCallback（message.success("服务连接正常") 随之删除）
4. `{!alive ? (<div className="preview-overlay">…</div>) : null}` 整段 JSX
5. import 中不再使用的 `useCallback`

保留：空态分支、iframe 渲染、postMessage 外链桥接（message.error("打开链接失败") 继续使用 message）。

- [ ] **步骤 3.2：删除 CSS 两段**

`global.css` 中 `.preview-overlay { … }` 区块与 `html[data-theme="light"] .preview-overlay { … }` 区块整体删除（grep 确认 `.preview-overlay` 仅剩零引用）。

- [ ] **步骤 3.3：验证 + Commit**

`pnpm build` exit=0；grep `preview-overlay|本地服务已断开` 零命中。

```bash
git add src/pages/Preview.tsx src/styles/global.css
git commit -m "fix(preview): 移除断连覆盖层，不再拦截预览内容"
```

---

### 任务 4：README 同步与回归验证

**文件：**
- 修改：`README.md:125`、`README.en.md:121`

- [ ] **步骤 4.1：更新预览页功能描述**

中文：「…支持刷新 / 复制地址 / 浏览器打开；服务断连时标题栏指示灯变红。」
英文：「…with refresh / copy URL / open in browser; the titlebar indicator turns red when the service disconnects.」

- [ ] **步骤 4.2：全量编译**

`cargo check --manifest-path src-tauri/Cargo.toml` 与 `pnpm build` 均 exit=0。

- [ ] **步骤 4.3：手动清单（tauri:dev）**

1. 服务正常运行：指示灯绿色常亮，预览区无论何时都不再出现覆盖层；
2. 模拟断连（直接杀掉 dsh 进程）：约 12 秒内（2×6s）指示灯变红并呼吸闪烁，预览内容不被遮挡；
3. 重新启动服务（标题栏重启或启动页）：指示灯自动恢复绿色；
4. 停止服务：指示灯变红/灰，无任何弹层；
5. 回归：刷新/复制/外链/主题切换/窗口控制正常。

- [ ] **步骤 4.4：收尾提交（如有微调）**

---

## 自检记录

- 规格三部分均有对应任务（轮询→任务 1、指示灯→任务 2、移除拦截→任务 3、文档+验证→任务 4）。
- 无占位符；`serviceAlive` 在接口/初始值/事件处理器/订阅中命名一致；`pulseDot` 关键帧已存在于 global.css 可复用。
- zustand v5 subscribe 支持 (state, prevState) 签名。
