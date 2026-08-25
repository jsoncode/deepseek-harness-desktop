# 插件管理弹框 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 标题栏新增插件管理入口（ClusterOutlined），弹框内对插件执行 新增/更新/删除（CLI：`dsh plugin --profile web …`），操作前确认、完成后提示刷新，安装过程在终端样式大弹框中流式展示且可终止/后台化。

**架构：** Rust 通用可终止操作执行器（单并发状态机 + 泵线程 + 事件对）→ store 缓冲日志与 op 状态 → 常驻 PluginManager 组件双视图 Modal。

**技术栈：** Tauri 2 / React 19 / antd 6 / zustand v5。

**规格：** `docs/superpowers/specs/2026-08-25-plugin-manager-modal-design.md`

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `src-tauri/src/dsh.rs` | 修改 | PluginOpState、run_plugin_op、cancel_plugin_op、事件常量 |
| `src-tauri/src/lib.rs` | 修改 | 注册两条命令 |
| `src/lib/tauri.ts` | 修改 | 事件、api、类型 |
| `src/store/useAppStore.ts` | 修改 | pluginOp/pluginOpLogs/startPluginOp/事件接线 |
| `src/pages/Terminal.tsx` | 修改 | 导出 MARK 符号表复用 |
| `src/components/PluginManager.tsx` | 创建 | 双视图弹框组件 |
| `src/components/TitleBar.tsx` | 修改 | 插件入口按钮 |
| `src/styles/global.css` | 修改 | 弹框列表/终端尺寸样式 |

---

### 任务 1：Rust 可终止操作执行器

**文件：** `src-tauri/src/dsh.rs`、`src-tauri/src/lib.rs`

- [ ] **步骤 1.1：事件常量与状态**

事件常量区追加：

```rust
pub const PLUGIN_OP_LOG_EVENT: &str = "dsh://plugin-op-log";
pub const PLUGIN_OP_EXIT_EVENT: &str = "dsh://plugin-op-exit";
```

AppState 结构体追加字段并在 Default 中初始化：

```rust
pub struct PluginOpState {
    pub pid: u32,
    pub kind: String,
    pub name: String,
}

pub struct AppState {
    ...
    /// 进行中的插件 CLI 操作（单并发）
    pub plugin_op: Mutex<Option<PluginOpState>>,
}
```

Default 追加：`plugin_op: Mutex::new(None),`

- [ ] **步骤 1.2：两条命令（放在 install_plugins 之后）**

```rust
/// 校验插件 CLI 操作类型
fn validate_plugin_op(op: &str) -> Result<(), String> {
    match op {
        "add" | "update" | "remove" => Ok(()),
        _ => Err(format!("不支持的插件操作: {op}")),
    }
}

/// 执行 `dsh plugin --profile web {op} {name}`（流式输出、可终止、单并发）。
/// 进程退出由泵线程发 exit 事件并清理状态。
#[tauri::command]
pub fn run_plugin_op(
    app: AppHandle,
    state: State<'_, AppState>,
    op: String,
    name: String,
) -> Result<(), String> {
    validate_plugin_op(&op)?;
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("插件名称不能为空".into());
    }
    {
        let guard = state.plugin_op.lock().unwrap();
        if guard.is_some() {
            return Err("已有插件操作正在进行中，请稍后再试".into());
        }
    }
    let dsh = resolve_dsh().ok_or("未找到 dsh，请先全局安装 @deepseek-ai/dsh")?;
    *state.plugin_op.lock().unwrap() = Some(PluginOpState {
        pid: 0,
        kind: op.clone(),
        name: name.clone(),
    });

    emit_log(
        &app,
        PLUGIN_OP_LOG_EVENT,
        "system",
        &format!("$ dsh plugin --profile web {op} {name}"),
    );

    let mut cmd = Command::new(&dsh.program);
    cmd.args(&dsh.args)
        .arg("plugin")
        .arg("--profile")
        .arg("web")
        .arg(&op)
        .arg(&name)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

    match hide_window(&mut cmd).spawn() {
        Ok(child) => {
            let pid = child.id();
            if let Some(st) = state.plugin_op.lock().unwrap().as_mut() {
                st.pid = pid;
            }
            emit_log(&app, PLUGIN_OP_LOG_EVENT, "system", &format!("进程已启动（PID {pid}），输出如下"));
            let app2 = app.clone();
            std::thread::spawn(move || {
                pump_process(&app2, child, PLUGIN_OP_LOG_EVENT, PLUGIN_OP_EXIT_EVENT);
                if let Some(s) = app2.try_state::<AppState>() {
                    *s.plugin_op.lock().unwrap() = None;
                }
            });
            Ok(())
        }
        Err(e) => {
            *state.plugin_op.lock().unwrap() = None;
            emit_log(&app, PLUGIN_OP_LOG_EVENT, "error", &format!("启动失败: {e}"));
            Err(format!("启动插件操作失败: {e}"))
        }
    }
}

/// 终止当前插件 CLI 操作（整树杀灭）；返回是否存在被终止的操作
#[tauri::command]
pub fn cancel_plugin_op(state: State<'_, AppState>) -> Result<bool, String> {
    let pid = state.plugin_op.lock().unwrap().take().map(|s| s.pid);
    match pid {
        Some(pid) if pid != 0 => {
            kill_tree(pid);
            Ok(true)
        }
        _ => Ok(false),
    }
}
```

- [ ] **步骤 1.3：lib.rs 注册**

```rust
            dsh::run_plugin_op,
            dsh::cancel_plugin_op,
```

- [ ] **步骤 1.4：验证 + Commit**

`cargo check --manifest-path src-tauri/Cargo.toml` exit=0 →
`git commit -m "feat(backend): 可终止的插件 CLI 操作执行器"`

### 任务 2：前端桥接与 store

**文件：** `src/lib/tauri.ts`、`src/store/useAppStore.ts`

- [ ] **步骤 2.1：tauri.ts**

EVENTS 追加：

```ts
  pluginOpLog: "dsh://plugin-op-log",
  pluginOpExit: "dsh://plugin-op-exit",
```

api 追加：

```ts
  runPluginOp: (op: string, name: string) =>
    requireTauri(() => invoke<void>("run_plugin_op", { op, name })),
  cancelPluginOp: () => requireTauri(() => invoke<boolean>("cancel_plugin_op")),
```

- [ ] **步骤 2.2：useAppStore 类型/初始值/action**

导出类型：

```ts
export type PluginOpKind = "add" | "update" | "remove";

export interface PluginOpState {
  kind: PluginOpKind;
  name: string;
  running: boolean;
  exitCode?: number;
}
```

接口追加：`pluginOp: PluginOpState | null;` `pluginOpLogs: LogEntry[];` `appendPluginOpLog: (stream: StreamKind, text: string) => void;` `startPluginOp: (kind: PluginOpKind, name: string) => Promise<void>;`

初始值：`pluginOp: null,` `pluginOpLogs: [],`

模块级常量：`const MAX_PLUGIN_OP_LOGS = 1000;`

action 实现：

```ts
    appendPluginOpLog: (stream, text) => {
      set((s) => {
        const entry: LogEntry = { id: ++logSeq, time: now(), stream, text };
        const all = [...s.pluginOpLogs, entry];
        return { pluginOpLogs: all.length <= MAX_PLUGIN_OP_LOGS ? all : all.slice(all.length - MAX_PLUGIN_OP_LOGS) };
      });
    },

    startPluginOp: async (kind, name) => {
      set({ pluginOp: { kind, name, running: true }, pluginOpLogs: [] });
      try {
        await api.runPluginOp(kind, name);
      } catch (e) {
        get().appendPluginOpLog("error", String(e instanceof Error ? e.message : e));
        set((s) => ({ pluginOp: s.pluginOp ? { ...s.pluginOp, running: false, exitCode: -1 } : null }));
      }
    },
```

wireEvents 接线（pluginInstallExit 之后）：

```ts
    onEvent<LogLine>(EVENTS.pluginOpLog, (p) => {
      const stream: StreamKind =
        p.stream === "stderr" ? "stderr" : p.stream === "system" ? "system" : "stdout";
      get().appendPluginOpLog(stream, p.line);
    });

    onEvent<ExitPayload>(EVENTS.pluginOpExit, (p) => {
      const op = get().pluginOp;
      if (!op || !op.running) return;
      set({ pluginOp: { ...op, running: false, exitCode: p.code } });
    });
```

- [ ] **步骤 2.3：验证 + Commit**

`pnpm build` exit=0 → commit

### 任务 3：PluginManager 组件 + TitleBar 入口 + CSS

**文件：** `src/pages/Terminal.tsx`（导出 MARK）、`src/components/PluginManager.tsx`（新建）、`src/components/TitleBar.tsx`、`src/styles/global.css`

- [ ] **步骤 3.1：Terminal.tsx 导出符号表**

`const MARK` 改为 `export const MARK`。

- [ ] **步骤 3.2：新建 PluginManager.tsx（完整实现见下）**

要点：双视图 Modal；完成提示 effect 监听 running 转变；自动滚动；确认/输入子弹框。组件骨架：

```tsx
import { useEffect, useRef, useState } from "react";
import { App as AntApp, Button, Input, Modal } from "antd";
import { ClusterOutlined } from "@ant-design/icons";
import { api } from "../lib/tauri";
import { useAppStore } from "../store/useAppStore";
import { tauri } from "../lib/tauri";
import { MARK } from "../pages/Terminal";
```

核心逻辑（完整代码在实现时展开）：
- selectors: plugins/pluginOp/pluginOpLogs/serviceRunning/initialized/init/refreshStatus/startPluginOp
- 状态：open/view("list"|"terminal")/addOpen/name/bodyRef/prevRunning
- openManager()：open=true；view = pluginOp?.running ? "terminal" : "list"
- confirmOp(kind, name)：modal.confirm（服务运行中加前缀「服务正在运行中，」）
- submitAdd()：校验非空 → 关输入框 → terminal 视图 → startPluginOp("add", n)
- cancelOpConfirm()：二次确认后 `void api.cancelPluginOp()`
- 完成监听 effect：prevRunning.current===true 且现在 false → message.info("插件已变更，请稍后刷新页面或重启服务") + void refreshStatus()
- 自动滚动 effect 依赖 logs.at(-1)?.id

- [ ] **步骤 3.3：TitleBar 集成**

ThemeSwitch 左侧插入：

```tsx
{tauri ? (
  <Tooltip title="插件管理">
    <button className="icon-btn" type="button" aria-label="插件管理" onClick={() => pluginMgrRef...}>
```

实现方式：TitleBar 直接渲染 `<PluginManager />` 于 titlebar-right 内 ThemeSwitch 前；入口按钮由 PluginManager 自身渲染（含 Badge 红点），保持状态内聚。

- [ ] **步骤 3.4：CSS 追加**

```css
/* 插件管理弹框 */
.plugin-op-banner {
  margin-bottom: 12px;
  padding: 8px 12px;
  border-radius: 10px;
  background: var(--panel-strong);
  border: 1px dashed var(--border-strong);
  color: var(--accent-2, #22d3ee);
  font-size: 13px;
  cursor: pointer;
}

.plugin-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 4px;
  border-bottom: 1px solid var(--border);
}

.plugin-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--mono);
  font-size: 13px;
  color: var(--text-1);
}

.plugin-term .term-body {
  height: 420px;
}
```

- [ ] **步骤 3.5：验证 + Commit**

`pnpm build` exit=0 → commit

### 任务 4：回归验证

- [ ] cargo check + pnpm build 全过；
- [ ] 手动清单（tauri:dev）：
  1. 入口按钮在主题左侧、悬停「插件管理」，弹框列出全部用户插件；
  2. 新增测试插件（如 `dsh1024@latest` 或本地 link 目录名）：输入框 placeholder 正确；终端视图流式日志；完成后出现「插件已变更…」提示且列表刷新、package.json bundles 同步登记；
  3. 更新该插件：确认语含「服务正在运行中，」（运行时）；日志正常；
  4. 删除该插件：确认后 CLI 卸载，文件两处同步移除；
  5. 终止：新增一个大体积插件安装中点「终止安装」→ 进程整树退出、exit 日志可见；
  6. 后台：安装中点「后台运行」→ 弹框关闭、标题栏图标红点；重开弹框默认进终端视图可看实时日志；
  7. 回归：启动页移除按钮、健康指示灯、主题切换不受影响。

---

## 自检记录

命令语义已由宿主源码佐证（plugin.ts 对账逻辑）；三条命令均走同一执行器无重复；取消经 kill_tree 整树处理 Windows shell 链；完成提示挂在常驻组件 effect 上保证后台态也能弹出；MARK 复用避免符号表重复定义。
