# 启动页优化：环境预检 + 标题栏服务控制按钮 — 设计文档

日期：2026-08-25
状态：已批准

## 背景与目标

当前 DeepSeek Harness Desktop 存在以下问题：

1. 启动前不检测 Node.js 是否安装、版本是否 ≥ 22.19、pnpm 是否安装；环境缺失时用户点击启动必然失败，只能去终端日志里找原因。
2. 标题栏"重启服务"按钮使用电源符号图标（圆圈+竖线），视觉上更像"关机"，且点击后立即执行、无确认。
3. 标题栏没有"停止服务"入口（只有终端页有文字按钮）。
4. 标题栏没有"查看日志"快捷入口。

本次改动覆盖以上四点，涉及启动页（`src/pages/Launch.tsx`）、标题栏（`src/components/TitleBar.tsx`）、状态层（`src/store/useAppStore.ts`）与 Rust 后端（`src-tauri/src/dsh.rs`）。

## 方案选择：环境预检的实现层

| 方案 | 说明 | 结论 |
|------|------|------|
| **A. 扩展现有 `app_status` 命令（采用）** | Rust 端新增 node 探测（`where node` → `node --version`）与 pnpm 版本采集，随现有 StatusPayload 返回 | 改动最小；`init` / `refreshStatus` 自动获得最新环境状态；每次刷新增量开销约 100ms，可忽略 |
| B. 新增独立 `check_env` 命令 | 单独命令只做环境检测 | 多一套命令与状态同步，无实际收益 |
| C. 前端经 shell 插件直接测 | `@tauri-apps/plugin-shell` 执行命令 | 需引入新插件与权限配置，违背项目"全部走自定义 Rust command"的既有模式 |

## 详细设计

### 1. 后端：环境探测扩展（`src-tauri/src/dsh.rs`）

- 复用现有 `run_where("node")` 查找 node，取第一个可执行文件（复用 `is_exec_shim` 过滤规则）。
- 对找到的 node 执行 `--version`（隐藏窗口），解析形如 `v22.21.1` 的输出；进程失败或 2 秒超时视为未正确安装（`node_path`/`node_version` 均为 None）。
- 对 pnpm 同样执行 `--version` 采集版本号；失败不影响 `pnpm_path` 的既有语义。
- `StatusPayload` 新增字段：
  - `node_path: Option<String>`
  - `node_version: Option<String>`（原始字符串，如 `"22.21.1"`，不含前导 v）
  - `pnpm_version: Option<String>`
- 版本是否满足要求**由前端判断**，后端只报原始数据，便于提示"当前 vX.X 低于要求的 22.19"。

### 2. 前端状态层（`src/store/useAppStore.ts`、`src/lib/tauri.ts`）

- `StatusPayload` 接口同步新增三个可选字段。
- store 新增状态：`nodePath: string | null`、`nodeVersion: string | null`、`pnpmVersion: string | null`，在 `init()` 与 `refreshStatus()` 中写入。
- 环境判定为 Launch 页组件内的派生值：

```
envOk = node 已安装 && 版本 ≥ 22.19 && pnpm 已安装
版本比较：major > 22，或 major == 22 且 minor ≥ 19
```

### 3. 启动页 UI（`src/pages/Launch.tsx` + `global.css`）

- 状态条下方新增**环境检查卡片**，逐项展示 ✓ / ✗：
  - **Node.js**：✓ 显示版本号；✗ 未安装（附 https://nodejs.org 下载指引）；✗ 版本低于要求（显示当前版本并提示升级到 ≥ 22.19）；✗ 无法读取版本。
  - **pnpm**：✓ 显示版本号；✗ 未安装（附 `npm install -g pnpm` 指引）。
  - **dsh CLI**：✓ 已安装；○ 未安装 · 启动时自动安装（不阻断）。
- 有不通过项时卡片红色边框强调；全部通过时各项绿色 ✓。
- **阻断式交互**：在主按钮会触发启动流程的状态（`idle` 首次就绪、`stopped` 已停止、`error` 启动失败）且 `!envOk` 时主按钮禁用，按钮文案不变，卡片即原因说明；此时仍可通过标题栏日志按钮查看日志排查。dsh 未安装不阻断（现有流程自动安装）；浏览器预览模式（非 Tauri）不阻断。
- 服务运行中（`running`）环境变化不阻断"打开应用"，仅卡片标黄提示。
- 底部 footer 徽章追加 Node 版本徽章。

### 4. 标题栏（`src/components/TitleBar.tsx` + `icons.tsx` + `global.css`）

按钮排布（titlebar-center 从左到右）：

```
[🛑 停止服务] [🔄 重启服务] [📄 查看日志] [← 返回启动页] [URL pill] [刷新] [复制地址] [浏览器打开]
```

- **停止服务（新增）**：位于重启左侧；复用现有 `StopIcon`；红色危险色系。仅 `serviceRunning` 为 true 时可点击，否则置灰禁用（保持布局稳定）。点击弹 `modal.confirm`："确定停止当前服务？停止后需要重新启动才能访问。"确认后调用 `stop()` 并导航回启动页 `/`（与终端页现有行为一致）。
- **重启服务（改造）**：图标从电源符号 `RestartIcon` 换成单箭头循环旋转图标（新增 `RotateCwIcon`，顺时针单箭头，与现有双箭头 RefreshIcon"刷新"明确区分）。点击弹 `modal.confirm`："确定重启服务？正在使用的页面会短暂中断。"确认后走现有 `handleRestart()` 流程。原电源符号 `RestartIcon` 若无其他引用则删除。
- **查看日志（新增）**：新增终端样式图标（方括号+提示符造型），任何页面点击跳转 `/terminal` 日志输出页。
- 确认弹框统一使用 `AntApp.useApp()` 提供的 `modal`（项目已在 App 外层包裹 `<AntApp>`，零新增依赖）；确认按钮文案分别为"停止"/"重启"，危险操作用 `okButtonProps: { danger: true }`。

### 5. 错误处理与边界

- `node --version` 失败或超时（2s）：按未安装处理，卡片显示"无法读取版本，请重新安装 Node.js"。
- 非 Tauri 浏览器预览模式：环境卡片显示占位说明"桌面应用内检测"，不阻断按钮。
- `refreshStatus` 刷新期间保持既有"不打断 installing/starting"的守卫逻辑，新增字段落位后自然反映在卡片上。
- 重启/停止确认框弹出期间按钮不禁用（antd modal 自带遮罩防重复点击）；既有 `restarting`/`busy` 守卫保留。

### 6. 测试与验证

项目无前端测试框架，验证方式：

1. `cargo check`（src-tauri 编译通过）。
2. `pnpm build`（tsc --noEmit + vite build 通过）。
3. `pnpm tauri:dev` 手动验证：
   - 正常环境：三行全绿，可正常启动；
   - 模拟缺失（临时将 node.exe 改名）：Node 行标红、附指引、启动按钮禁用；
   - 重启按钮：新图标生效，弹确认框，确认后服务重启；
   - 停止按钮：运行中可点、弹确认框，确认后服务停止回到启动页；未运行时置灰；
   - 日志按钮：任意页面点击跳转日志页。

## 不做的事（YAGNI）

- 不做环境一键修复/自动安装 Node 或 pnpm（用户已选择阻断式而非引导式）。
- 不改终端页与预览页的既有按钮逻辑。
- 不引入 antd 之外的弹窗组件或图标库。
