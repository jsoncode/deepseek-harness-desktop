# 插件管理弹框（新增/更新/删除 + 可终止终端）— 设计文档

日期：2026-08-25
状态：已批准

## 背景与命令事实（源自宿主项目 deepseek-harness/apps/cli/src/plugin.ts）

`dsh plugin --profile web <pnpm args…>` 的语义：必要时初始化 profile → 在 profile 目录执行 `pnpm <args…>` → 按**安装结果**对账 `dsh.profile.bundles`（依赖声明 `dsh.bundle` 则加入层栈；被移除则剔除；模板包不动）。因此：

| 操作 | 命令 | 效果 |
|------|------|------|
| 新增 | `dsh plugin --profile web add {name}` | 安装依赖 + 自动登记 bundles |
| 更新 | `dsh plugin --profile web update {name}` | pnpm 更新 + 对账（新版本获得声明自动激活） |
| 删除 | `dsh plugin --profile web remove {name}` | 清 node_modules + package.json + bundles |

## 方案选择

| 方案 | 结论 |
|------|------|
| **A. 通用可终止操作执行器（采用）**：一条命令统一 spawn `dsh plugin …`，状态存 AppState，复用 kill_tree | 与现有 pump/事件模式同构、零重复 |
| B. 三条独立命令复制 spawn/pump/cancel | 违反 DRY |
| C. 前端 shell 直跑 | 引入插件权限，违背项目模式 |

## 详细设计

### 1. 后端（`src-tauri/src/dsh.rs`）

- `AppState` 增加 `plugin_op: Mutex<Option<PluginOpState>>`（`{ pid, kind, name }`），同一时刻仅一个操作。
- 新事件对：`dsh://plugin-op-log` / `dsh://plugin-op-exit`（payload 复用 LogLine / ExitPayload）。
- `run_plugin_op(op, name)`：
  - 校验 op ∈ {"add","update","remove"}、name 非空、无并发操作；
  - 先占位状态（pid=0），spawn `dsh plugin --profile web {op} {name}`（隐藏窗口、piped 输出），成功后回填 pid 并泵日志；失败回滚占位；
  - 进程退出由泵线程发 exit 事件并清理状态。
- `cancel_plugin_op()`：取走状态 → `kill_tree(pid)` 整树终止（Windows 下 dsh 经 shell 拉 pnpm，树杀避免孤儿）；exit 事件照常发出。

### 2. 前端状态层（`tauri.ts` / `useAppStore.ts`）

- EVENTS 增加 `pluginOpLog` / `pluginOpExit`；api 增加 `runPluginOp(op, name)`、`cancelPluginOp()`。
- store 新增：`pluginOp: { kind, name, running, exitCode? } | null`、`pluginOpLogs: LogEntry[]`（上限 1000 条）、`appendPluginOpLog(stream, text)`、`startPluginOp(kind, name)`（清空缓冲→置 op→调后端，异常时置失败态）。
- wireEvents 接线两条事件：log 追加缓冲；exit 置 `running=false, exitCode=code`。日志累积与弹框开关无关（后台运行仍持续记录）。

### 3. UI（新组件 `src/components/PluginManager.tsx`，常驻挂载于 TitleBar）

- **入口按钮**：主题按钮左侧 `<ClusterOutlined />`，Tooltip「插件管理」；有进行中操作时 Badge 红点提示；浏览器预览模式隐藏。
- 单个 Modal 双视图切换（宽 560 列表 / 860 终端）：
  - **列表视图**：「＋ 新增插件」次按钮（操作进行中禁用）；插件行 = 名称 + 「更新」「删除」小按钮（进行中全部禁用）；顶部横幅入口「查看安装进度/上次日志」（存在 pluginOp 时显示，满足后台后重新点开）；空态「暂无用户插件」。
  - **终端视图**：复用终端页样式类 `.term-window/.term-body/.term-line/.term-progress`（MARK 符号表从 Terminal.tsx 导出复用），自动滚动到底部；底部键：运行中＝[终止安装(红)] [后台运行]；结束＝[关闭]。
- 操作链路：
  - 删除/更新 → `modal.confirm`：内容为「{服务正在运行中，}确认要{删除|更新}插件 X 吗？」（服务未运行时省略前缀），危险色确认键；确认后切换到终端视图并执行。
  - 新增 → 小号输入弹框：标题「新增插件」、placeholder「请输入插件名称」、确认键「保存并安装」；名称按 pnpm 规格透传（支持 `name`、`name@version` 等）；确认后进终端视图执行 add。
  - **完成提示**：组件 effect 监听 `running → false` 转变，无论弹框开关与否弹出「插件已变更，请稍后刷新页面或重启服务」，并自动 `refreshStatus()`。
- 终止安装需二次确认后调用 `cancel_plugin_op`；退出码经 exit 事件在终端内可见。

### 4. 不改动

- Launch 卡片「移除」保持文件编辑快速路径；插件管理弹框的删除走 CLI 全量卸载，两者并存。
- 不做多操作并行排队（单并发，进行中禁用其它按钮）。

## 验证

`cargo check` + `pnpm build`；tauri:dev 手动：新增测试插件观察流式日志与终止/后台行为；更新与删除各一遍；核对 package.json 两处同步变化；完成提示语与列表刷新正确。
