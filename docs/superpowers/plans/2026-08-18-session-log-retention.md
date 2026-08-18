# 启动服务不清空终端日志（会话内保留）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 服务启动/重启/重试时不再清空终端日志，历史日志保留到应用窗口关闭（会话内保留），多次运行的日志用分隔线区分，并对日志总量做上限保护。

**架构：** 改动集中在 `src/store/useAppStore.ts`（zustand store，日志存于内存）与 `src/pages/Terminal.tsx`（自动滚动依赖修正）。`startFlow()` 与 `reset()` 移除对 `logs` 的清空；`startFlow()` 在已有日志时先追加一条分隔线；`appendLog()` 增加 3000 条上限（保留最新、顶部固定一条截断提示）；Terminal 自动滚动依赖改为最后一条日志 id（上限后 length 恒定不再触发）。无 Rust 改动。

**技术栈：** React 19 + zustand 5 + TypeScript（strict）+ Vite 8（Tauri v2 桌面壳）。

**规格：** `docs/superpowers/specs/2026-08-18-session-log-retention-design.md`

**约定：** 仓库当前无测试框架（沿用上一计划的既有模式，不做测试基建）。每个任务以 `pnpm exec tsc --noEmit` 类型检查通过 + 提交作为验证门槛；最终任务含 `pnpm build` 完整构建与手动验证清单。前端命令在仓库根目录运行。注意 tsconfig 开启 `noUnusedLocals`：每个任务新增的常量必须在同一次提交内被使用。

---

### 任务 1：appendLog 上限保护与截断提示

**文件：**
- 修改：`src/store/useAppStore.ts`（模块级常量区第 41-42 行附近；`appendLog` 第 114-122 行）

- [ ] **步骤 1：新增模块级常量**

在 `src/store/useAppStore.ts` 的 `let logSeq = 0;` / `let wired = false;`（第 41-42 行）之后追加：

```ts
/** 会话内日志上限：超出后丢弃最旧日志 */
const MAX_LOGS = 3000;
/** 日志截断提示（截断期间固定在保留日志顶部，不重复插入） */
const TRUNCATED_NOTE = "（历史日志过长，已截断早期内容）";
```

（注意：本任务不添加 `RESTART_SEPARATOR`——它将在任务 2 用到时再引入，避免 `noUnusedLocals` 报错。）

- [ ] **步骤 2：改造 appendLog 实现上限与截断提示**

将 `appendLog`（当前第 114-122 行）整体替换为：

```ts
    appendLog: (stream, text) => {
      const entry: LogEntry = {
        id: ++logSeq,
        time: now(),
        stream,
        text,
      };
      set((s) => {
        const all = [...s.logs, entry];
        if (all.length <= MAX_LOGS) return { logs: all };
        // 超过上限：顶部放一条截断提示，保留最近 MAX_LOGS-1 条真实日志（丢弃最旧）
        const note: LogEntry = {
          id: ++logSeq,
          time: now(),
          stream: "system",
          text: TRUNCATED_NOTE,
        };
        return { logs: [note, ...all.slice(all.length - (MAX_LOGS - 1))] };
      });
    },
```

说明：追加后若不超过 `MAX_LOGS` 直接返回；超过时，顶部放一条截断提示（截断期间始终恰好一条，重建式固定），并保留**最近** `MAX_LOGS - 1` 条真实日志（丢弃最旧），总量恒为 `MAX_LOGS`。
**注意：** 取"最近 N-1 条"必须用尾部 slice `all.slice(all.length - (MAX_LOGS - 1))`，不能写成 `slice(0, MAX_LOGS - 1)`——那会保留窗口头部、丢掉刚追加的最新一条（初版计划曾犯此错，被代码审查发现）。

- [ ] **步骤 3：类型检查**

运行：`pnpm exec tsc --noEmit`
预期：无错误输出，退出码 0

- [ ] **步骤 4：Commit**

```bash
git add src/store/useAppStore.ts
git commit -m "feat: 终端日志增加 3000 条上限与截断提示"
```

---

### 任务 2：startFlow 不再清空日志并插入重启分隔线

**文件：**
- 修改：`src/store/useAppStore.ts`（`startFlow` 第 178-203 行；常量区第 41-42 行附近）

- [ ] **步骤 1：新增 RESTART_SEPARATOR 常量**

在任务 1 已追加的 `TRUNCATED_NOTE` 常量之后追加：

```ts
/** 重新启动服务时的日志分隔线 */
const RESTART_SEPARATOR = "────── 重新启动服务 ──────";
```

- [ ] **步骤 2：改造 startFlow 开头**

将 `startFlow` 中当前第 181 行的 `set({ logs: [], error: null });` 替换为：

```ts
      if (get().logs.length > 0) {
        get().appendLog("system", RESTART_SEPARATOR);
      }
      set({ error: null });
```

即 `startFlow` 开头变为：

```ts
    startFlow: async () => {
      const { phase, dshInstalled } = get();
      if (phase === "installing" || phase === "starting" || phase === "running") return;
      if (get().logs.length > 0) {
        get().appendLog("system", RESTART_SEPARATOR);
      }
      set({ error: null });
```

其余逻辑（安装/启动分支、错误处理）保持不变。

- [ ] **步骤 3：类型检查**

运行：`pnpm exec tsc --noEmit`
预期：无错误输出，退出码 0

- [ ] **步骤 4：Commit**

```bash
git add src/store/useAppStore.ts
git commit -m "feat: 启动服务时保留历史日志并插入分隔线"
```

---

### 任务 3：reset 不再清空日志

**文件：**
- 修改：`src/store/useAppStore.ts`（`reset` 第 216-225 行）

- [ ] **步骤 1：移除 reset 中的 logs 清空**

将 `reset`（当前第 216-225 行）整体替换为：

```ts
    reset: () => {
      set({
        phase: "idle",
        url: null,
        error: null,
        serviceRunning: false,
        childRunning: false,
      });
    },
```

即去掉 `logs: [],`，该函数只负责把状态机复位到可重新启动的状态，不负责清空日志。

- [ ] **步骤 2：类型检查**

运行：`pnpm exec tsc --noEmit`
预期：无错误输出，退出码 0

- [ ] **步骤 3：Commit**

```bash
git add src/store/useAppStore.ts
git commit -m "feat: 重试/重启前 reset 不再清空日志"
```

---

### 任务 4：Terminal 页自动滚动在日志达到上限后仍生效

**文件：**
- 修改：`src/pages/Terminal.tsx`（自动滚动 effect，第 59-63 行）

背景：日志达到 `MAX_LOGS` 上限后 `logs.length` 恒定不变，原 effect 依赖 `[logs.length]` 不再触发，新日志在底部出现却看不到。改为依赖最后一条日志的 `id`，每次追加仍会滚动到底部。

- [ ] **步骤 1：修改自动滚动依赖**

将 `src/pages/Terminal.tsx` 的自动滚动 effect（当前第 59-63 行）：

```ts
  // 自动滚动到底部
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs.length]);
```

替换为：

```ts
  // 自动滚动到底部（依赖最后一条日志 id：日志达到上限后 length 恒定，length 不再触发）
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs.at(-1)?.id]);
```

（`Array.prototype.at` 属 ES2022，tsconfig `lib` 已含 `ES2022`。）

- [ ] **步骤 2：类型检查**

运行：`pnpm exec tsc --noEmit`
预期：无错误输出，退出码 0

- [ ] **步骤 3：Commit**

```bash
git add src/pages/Terminal.tsx
git commit -m "fix: 日志达到上限后自动滚动仍生效"
```

---

### 任务 5：完整构建与手动验证

**文件：** 无改动（纯验证）

- [ ] **步骤 1：完整构建**

运行：`pnpm build`
预期：`tsc --noEmit` 无错误，`vite build` 成功产出 `dist/`，退出码 0

- [ ] **步骤 2：手动验证——重启保留历史**

运行：`pnpm tauri:dev`，在应用内按顺序操作：

1. 启动页点「启动应用」→ 等待状态变为「运行中」
2. 进「查看日志」页（Terminal）→ 点「停止服务」→ 点「重新启动」
3. 注意：`starting → running` 后约 1.2s 会自动跳转预览页，需再点「查看日志」返回
4. 预期：Terminal 页顶部保留上一轮日志（含「🛑 已停止 dsh web 服务」），分隔线 `────── 重新启动服务 ──────` 之后是新一轮日志
5. 重复「停止 → 重新启动」2-3 次：每次新增一条分隔线，历史逐轮累积不丢失

- [ ] **步骤 3：手动验证——失败后重试保留历史**

1. 在 Terminal 页点「停止服务」后再「重新启动」，在启动过程中快速再点「停止服务」（或等待启动失败场景出现 error 态）
2. 若出现「启动失败」/ error 态：点「重试」按钮
3. 预期：失败日志保留在分隔线之前，重试从新分隔线后开始

- [ ] **步骤 4：手动验证——运行中反复进出不丢日志**

1. 服务运行中，在「启动页」⇄「查看日志」页反复切换 3-5 次
2. 预期：每次进入 Terminal 页日志都完整保留、持续累积，不出现清空

- [ ] **步骤 5：手动验证——上限截断（dev 控制台）**

1. 在 `tauri:dev` 的 WebView 开发者工具 console 执行：

```js
for (let i = 0; i < 3001; i++) window.__store.getState().appendLog("stdout", "line " + i);
```

2. 执行 `window.__store.getState().logs.length`，预期：`3000`
3. 执行 `window.__store.getState().logs[0].text`，预期：`（历史日志过长，已截断早期内容）`
4. 执行 `window.__store.getState().logs[logs.length - 1].text`，预期：`line 3000`（**最新一条必须保留**——截断正确性的关键断言，防止"丢最新"回归）
5. 再追加一条：`window.__store.getState().appendLog("stdout", "extra")`，预期：`logs.length` 仍为 `3000`，`logs[logs.length - 1].text` 为 `extra`，且截断提示始终只有一条（过滤统计 `logs.filter(l => l.text === "（历史日志过长，已截断早期内容）").length === 1`）

- [ ] **步骤 6：收尾提交**

若验证过程中无代码改动则无需提交；若发现并修复了问题，补充 commit 并重新跑 `pnpm build`。
