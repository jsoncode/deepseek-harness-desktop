# 设计：设置页日志管理（会话化日志记录与查看）

- 日期：2026-08-28
- 状态：待用户审查
- 目标版本：0.1.18（下一 patch）

## 背景与动机

用户需求：

1. 应用左上角版本号可点击，点击后跳转到设置页面的【关于本应用】菜单
2. 去掉底部导航的「查看日志」按钮；删除日志页面；将日志内容迁移到设置页新增的【日志管理】菜单；启动页/加载失败页的「查看日志」按钮改为进入设置-【日志管理】
3. 日志列表：每一次的启动/重启都作为一条独立日志记录
4. 日志详情：点击记录后弹框查看完整日志输出，方便排查和定位问题

现状：

- 日志全部保存在前端内存（`useAppStore.logs`，上限 3000 条，会话内保留），应用退出即丢失
- `/terminal` 页实时展示日志；底部导航条、启动页（busy 时）、加载失败页共 3 处「查看日志」入口均跳 `/terminal`
- 设置页左侧 Menu 用本地 `useState` 切换区块，不支持从外部定位到指定菜单
- 标题栏版本号（`__APP_VERSION__`）纯展示，不可点击

用户已确认的决策：

- **会话边界**：仅服务启动/重启创建日志记录（启动服务 / 安装并启动 / 重启服务）；应用打开但未启动服务不产生记录。列表中的当前会话标记「进行中」并支持实时查看
- **清空日志**：日志管理页提供「清空日志」按钮（二次确认后删除全部历史）

## 方案

### 1. 版本号点击 → 关于本应用

- `TitleBar` 的 `.titlebar-version` 改为可点击按钮：hover 高亮、`cursor: pointer`、Tooltip「关于本应用」，点击 `navigate("/settings?section=about")`
- 设置页支持 URL 查询参数定位菜单：`/settings?section=about|logs|plugins|notify|theme`
  - 挂载时读取 `section` 初始化 `active`（非法值回退 `plugins`）
  - 菜单点击时用 `setSearchParams(..., { replace: true })` 同步 URL（不产生历史记录）

### 2. 移除底部导航「查看日志」按钮

- `BottomBar` 删除「查看日志」Tooltip/按钮（`CodeOutlined`）及其 import，更新组件头注释
- 底部导航左侧仅保留：停止服务、重启服务

### 3. 删除日志页（/terminal）

- 删除 `src/pages/Terminal.tsx` 与 `App.tsx` 中的 `/terminal` 路由及 import
- 日志行符号表 `MARK` 迁移到 `src/lib/logFormat.ts`（`PluginManagerPanel` 改为从新位置 import）
- `term-*` CSS 样式保留：日志详情弹框与插件操作终端继续复用

### 4. 设置页新增「日志管理」菜单

- `Settings.tsx` 菜单项增加 `{ key: "logs", icon: <FileTextOutlined />, label: "日志管理" }`，置于「关于本应用」之前；`SectionKey` 增加 `"logs"`
- 新增组件 `src/components/settings/LogManagerSettings.tsx`：
  - `settings-nav`：标题「日志管理」+ 右侧操作（刷新、清空日志）
  - `settings-body`：会话列表（状态点 + 标题 + 开始时间 + 结束时间/时长 + 行数 + 「进行中」徽标），点击行打开详情
  - 详情弹框：复用 `AppModal`，`term-window` 样式逐行渲染（时间 + MARK + 文本），自动滚动到底部，footer 提供「复制日志」与「关闭」
  - 空态：「暂无日志记录」
  - 浏览器预览模式（非 Tauri）：列表仅显示一条「当前会话（浏览器预览）」伪记录，详情直接读 `useAppStore.logs`

### 5. 会话化日志落盘（Rust 新模块 `logs.rs`）

存储位置：应用数据目录下 `logs/` 目录，每个会话一个 `{sessionId}.jsonl` 文件：

```json
// 首行 header
{"id":"...","title":"启动服务","started_at":"2026-08-28 10:00:00","ended_at":null,"status":"active"}
// 后续每行一条日志
{"time":"10:00:01","stream":"system","text":"$ dsh web …"}
```

- `AppState` 增加 `active_log: Mutex<Option<LogSession>>`（当前会话 id 与 started_at）
- 命令：
  - `log_start_session(title)` → finalize 旧会话（补 `ended_at`；status 若仍为 active 置 `closed`）→ 创建新会话文件 → 返回会话 id
  - `log_append(entry)` → 追加一行 JSON 到当前会话文件（无当前会话时静默忽略）
  - `log_set_status(id, status)` → 重写 header 的 status（`success` / `error`）
  - `log_sessions()` → 扫描 `logs/` 目录解析各文件 header，按 `started_at` 倒序返回（含行数）
  - `log_content(id)` → 读取指定会话文件全部日志行（跳过 header）
  - `log_clear()` → 删除全部会话文件并清空 active
- `setup` 时：finalize 遗留的「进行中」会话（异常退出/崩溃恢复）
- `RunEvent::Exit` 时：finalize 当前会话（status `closed`）

### 6. 前端会话生命周期（`useAppStore`）

- 新增状态 `logSessionId: string | null`（当前活动会话 id）
- 新增 action `beginLogSession(title)`：`await api.logStartSession(title)` 后存入 `logSessionId`
- 创建时机（均在流程第一条日志前完成，保证日志不丢失）：
  - `startFlow()` 首次启动 → 「启动服务」
  - `installEnvAndStart()` → 「安装并启动」
  - `BottomBar.handleRestart` → 「重启服务」（先 `await beginLogSession` 再 `stop()` + `startFlow()`；`startFlow` 检测到 `logSessionId` 已存在则不重复创建）
- `appendLog()` 将每条日志**串行镜像**到会话文件：模块级 promise 链（`logFlush = logFlush.then(() => api.logAppend(...))`），保证 invoke 到达 Rust 的顺序与 store 顺序一致（避免并发 IPC 乱序）；`TRUNCATED_NOTE` 与浏览器预览模式（invoke 必然失败）跳过镜像，失败静默吞掉
- 状态上报：`useAppStore.subscribe` 中 phase 变化时，若 `logSessionId` 非空：`running` → `log_set_status(success)`，`error` → `log_set_status(error)`（fire-and-forget）
- 日志管理详情数据源：当前会话（id 匹配 `logSessionId`）读 `store.logs` 实时渲染；历史会话调 `log_content(id)` 一次性读取

### 7. 启动页 / 加载页「查看日志」跳转改造

- `Launch.tsx` busy 时的「查看日志」→ `navigate("/settings?section=logs")`
- `Launch.tsx` 浏览器预览模式的 fallback（原 `navigate("/terminal")`）→ `navigate("/settings?section=logs")`
- `Loading.tsx` 失败页「查看日志」→ `navigate("/settings?section=logs")`

### 8. 标题栏地址栏左侧新增 Home 入口

- `TitleBar` 的 `titlebar-center` 中，在 `url-pill` 左侧新增 Home 图标按钮（`HomeOutlined`）：
  - 服务已启动（`phase === "running"`）：点击跳转服务内（`navigate("/preview")`），Tooltip「进入应用」
  - 服务未启动（其余 phase）：点击跳转预检页（`navigate("/")`），Tooltip「返回启动页」
- 复用现有 `icon-btn` 样式，与刷新/复制/浏览器打开按钮并列

## 数据流

```
Rust 子进程输出 ──emit 事件──▶ useAppStore.appendLog（store.logs 实时态）
                                        │ 串行 promise 链镜像
                                        ▼
                              api.logAppend ──▶ logs/{id}.jsonl（持久化）
前端生成的摘要行（🚀 服务已就绪 / 🛑 已停止 …）──同一条 appendLog 路径──▶ 同样落盘
```

- 实时查看：当前会话详情 ← `store.logs`（内存，含截断上限 3000）
- 历史查看：`log_content(id)` ← 会话文件（完整，无截断）

## 错误处理

- 非 Tauri（浏览器预览）：`log_*` invoke 全部失败 → 前端 fire-and-forget 处 catch 吞掉；日志管理页降级为「当前会话（浏览器预览）」伪记录
- 文件读写失败：命令返回 `Err` → 日志管理列表显示错误态与「重试」按钮
- 清空日志：`Popconfirm` 二次确认；失败 `message.error`
- 会话文件写入失败不阻塞主流程（镜像为 fire-and-forget）

## 验证

1. `pnpm exec tsc --noEmit` 无错误
2. `pnpm build` 成功
3. 手动验证（`pnpm tauri:dev`）：
   - 启动 → 停止 → 重启：设置-日志管理出现 3 条记录（「启动服务」「启动服务」「重启服务」），详情内容正确
   - 制造启动失败（error）：该会话列表状态显示「失败」；详情含错误输出
   - 当前会话「进行中」徽标 + 详情实时滚动
   - 重启应用：历史记录仍在，最后一条被 finalize（不再「进行中」）
   - 版本号点击 → 设置-关于本应用选中
   - 标题栏 Home 按钮：服务运行中点按进入预览页；停止后点按回到启动页
   - 底部导航无「查看日志」；启动页/加载失败页「查看日志」→ 设置-日志管理
   - 清空日志 → 列表清空、目录文件删除
   - 浏览器预览模式：日志管理显示当前会话伪记录
