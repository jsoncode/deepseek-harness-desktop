# 插件管理 + 启动页文案精简 + 启动链路插件安装 — 设计文档

日期：2026-08-25
状态：已批准

## 背景与目标

在上一轮（环境预检 + 标题栏服务控制）基础上继续优化：

1. 启动页去掉副标题「DeepSeek Harness · 本地服务启动器」、去掉 stopped 态文案「服务已停止，点击重新启动」中的多余指引、去掉底部徽章条。
2. 新增插件检测与管理：读取 `%USERPROFILE%\.dsh\profiles\web\package.json`，展示用户插件列表并支持移除（同时删除 `dsh.profile.bundles` 与 `dependencies` 中的对应项）。
3. 启动链路增强：启动 dsh web 前先对插件目录执行 `pnpm install`，避免用户手动往 package.json 添加插件（含 `link:` 本地目录依赖）后未安装导致启动失败。

已确认的决策：仅列出 dependencies 中存在的插件（核心包不展示、全部可移除）；移除需确认弹框；每次启动都执行 pnpm install（幂等，目录不存在则跳过）；移除后不同步 node_modules（下次启动自动清理）。

## 方案选择：启动链路如何插入插件安装

| 方案 | 说明 | 结论 |
|------|------|------|
| **A. 前端编排 + 独立事件对（采用）** | 新增 `install_plugins` 命令与 `dsh://plugin-install-log/exit` 事件；前端 startFlow 三段式：装 dsh → 装插件 → 启动 | 与现有 install_dsh 流式日志/退出链同构；状态机无新增 phase（复用 installing）；失败原因清晰 |
| B. 后端 start_dsh_web 内部串联 | Rust 内先 pnpm install 再拉起 dsh | web-exit 退出码语义混杂，前端无法区分阶段 |

## 详细设计

### 1. 启动页文案精简（`src/pages/Launch.tsx` + `global.css`）

- 删除 `<p className="launch-subtitle">` 元素与 `.launch-subtitle` 样式。
- `stopped` 状态文案改为「服务已停止」（主按钮本身即"重新启动"，去掉文字指引）。
- 删除整个 `launch-footer` 区块（node/pnpm/dsh/版本徽章）与 `.launch-footer` / `.env-chip` 样式。

### 2. 后端：插件读取与移除

- `src-tauri/Cargo.toml`：`serde_json = { version = "1", features = ["preserve_order"] }` —— 重写文件时保持键序，不打乱用户 dependencies 排列；写回 pretty 两空格缩进 + 末尾换行。
- 新增 `profile_dir() -> Option<PathBuf>`：`USERPROFILE`（回退 `HOME`）+ `.dsh/profiles/web`。
- `StatusPayload` 新增字段：
  - `plugins: Vec<String>`：按 `dsh.profile.bundles` 数组顺序遍历，过滤出存在于 `dependencies` 对象中的名字；文件不存在或解析失败时为空。
  - `profile_ready: bool`：package.json 存在且可解析。
- `app_status` 填充上述两个字段。
- 新命令 `remove_plugin(name: String) -> Result<(), String>`：
  - 读 package.json → 解析为 `serde_json::Value`；
  - 从 `dsh.profile.bundles` 数组移除该名字；从 `dependencies` 对象移除该名字；
  - 两处都不包含该名字时返回错误「插件 X 不在 package.json 中」；
  - 文件缺失/解析失败返回相应中文错误；
  - 写回文件（pretty 两空格 + 尾换行）。
- `lib.rs` 的 `generate_handler!` 注册新命令。

### 3. 后端：启动前插件安装

- 新命令 `install_plugins(app: AppHandle) -> Result<(), String>`：
  - `profile_dir()` 不存在或无 package.json → 直接 `Ok(())`（首次运行目录尚未生成，前端直接继续启动）；
  - 否则 spawn `pnpm install`（cwd = profile 目录，隐藏窗口，stdin null），stdout/stderr 逐行泵到新事件 `dsh://plugin-install-log`，进程退出后发 `dsh://plugin-install-exit`（payload `{ code }`）。
- 事件常量：`PLUGIN_INSTALL_LOG_EVENT` / `PLUGIN_INSTALL_EXIT_EVENT`。

### 4. 前端状态与启动编排（`tauri.ts` / `useAppStore.ts`）

- `StatusPayload` 接口新增 `plugins: string[]`、`profile_ready: boolean`。
- `EVENTS` 新增 `pluginInstallLog` / `pluginInstallExit`；`api` 新增 `removePlugin(name)`、`installPlugins()`。
- store 新增 `plugins: string[]`、`profileReady: boolean`，init/refreshStatus 写入。
- 抽取 `ensurePluginsThenStart()`：
  - `profileReady && tauri` → `phase:"installing"`，日志「安装插件依赖：pnpm install …」→ `api.installPlugins()`；
  - 否则直接进入现有 starting/startDshWeb 分支。
- 接线 `pluginInstallLog`（追加终端日志）与 `pluginInstallExit`：
  - code 0 → 日志「✅ 插件依赖安装完成」→ phase starting → `startDshWeb()`；
  - code ≠ 0 → 日志错误 + `phase:"error"`「插件依赖安装失败（退出码 N）」。
- `startFlow` 与全局 dsh 安装完成回调（installExit handler）统一改走 `ensurePluginsThenStart()`（目录不存在时自动跳过，行为一致）。
- 复用现有 `installing` phase：终端页文案「安装依赖」，按钮「安装中…」，无需新增状态值。

### 5. 前端 UI：插件列表（`Launch.tsx` + `global.css`）

- 环境检查卡片内、三行环境项之后新增 **Plugins 小节**（仅 Tauri 桌面模式渲染）：

```
Plugins
  ◆ dshmarket            [移除]
  ◆ dsh-better-sidebar   [移除]
  …
```

- 小节标题行 `.env-section-title`；每行复用 `.env-row`：菱形标记 + 插件名 + 右侧小号危险色「移除」按钮（`.plugin-remove-btn`）。
- 点击移除 → `modal.confirm`：「确定移除插件 X？将同时从 bundles 与 dependencies 中删除。」okText「移除」danger；确认后调 `removePlugin` → 成功后 `refreshStatus()` 更新列表 + success 气泡「已移除 X」；失败 error 气泡。
- `plugins` 为空时显示「暂无用户插件」占位（`.env-detail` 样式）。
- 浏览器预览模式不渲染该小节。

### 6. 边界处理

- package.json 存在但解析失败：列表空、`profile_ready=false`、不阻断启动（pnpm 自身报错会流入日志页）；remove_plugin 返回「package.json 解析失败」。
- 移除的名字不在文件中：返回错误提示而非静默成功。
- 插件安装失败（网络断/link 目标不存在）：完整 pnpm 输出进日志页，终止于 error 态，可从启动页重试。
- 移除后不跑 pnpm：下次启动的 pnpm install 自动清理 node_modules 多余包。

### 7. 验证方式

1. `cargo check --manifest-path src-tauri/Cargo.toml`
2. `pnpm build`
3. `pnpm tauri:dev` 手动清单：
   - 卡片 Plugins 小节列出 dependencies 中的全部插件（当前机器应为 5 个），核心包不出现；
   - 移除某插件 → 确认框 → 文件中 bundles 与 dependencies 同步删除、其余键顺序不变；
   - 手动向 package.json 添加一个 link 插件 → 启动时终端页出现 pnpm install 流水并成功进入 running；
   - 三处文案变更生效（无副标题、无 footer、stopped 只显示「服务已停止」）。

## 不做的事（YAGNI）

- 不做插件添加/编辑 UI（用户手动改 package.json 是既定用法）。
- 不做 node_modules 即时同步。
- 不解析 cordis.yml / 其他 profile 文件。
- 不为插件安装新增独立 phase 值。
