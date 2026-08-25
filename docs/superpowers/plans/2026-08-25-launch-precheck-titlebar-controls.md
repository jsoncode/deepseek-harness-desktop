# 启动页优化：环境预检 + 标题栏服务控制按钮 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 启动页增加 Node.js ≥ 22.19 / pnpm 环境预检（阻断式），标题栏更换重启图标并增加确认弹框，新增停止服务与查看日志按钮。

**架构：** Rust 端扩展现有 `app_status` 命令采集 node/pnpm 版本随状态一并下发；前端 store 透传新字段；启动页渲染环境检查卡片并在环境不满足时禁用启动按钮；标题栏新增三个图标按钮（停止/重启/日志），危险操作经 antd `modal.confirm` 二次确认。

**技术栈：** Tauri 2（Rust 后端）、React 19 + zustand + react-router、antd 6（`AntApp.useApp()` 的 `modal`/`message`）、Vite。

**测试说明：** 项目无前端/后端测试框架（规格已确认）。每个任务的验证步骤为 `cargo check` 与 `pnpm build`（tsc --noEmit + vite build），最终任务含 `pnpm tauri:dev` 手动验证清单。

**规格：** `docs/superpowers/specs/2026-08-25-launch-precheck-titlebar-controls-design.md`

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `src-tauri/src/dsh.rs` | 修改 | 新增 `resolve_node()` / `read_tool_version()`；`StatusPayload` 增加 node/pnpm 版本字段并在 `app_status` 填充 |
| `src/lib/tauri.ts` | 修改 | `StatusPayload` 接口同步新增三个可选字段 |
| `src/store/useAppStore.ts` | 修改 | store 新增 `nodePath/nodeVersion/pnpmVersion`，`init()` / `refreshStatus()` 写入 |
| `src/components/icons.tsx` | 修改 | 新增 `RotateCwIcon`（重启）、`TerminalIcon`（日志）；删除电源符号 `RestartIcon` |
| `src/components/TitleBar.tsx` | 修改 | 按钮排布改为 [停止][重启][日志][返回][URL][刷新][复制][外链]；重启/停止弹确认框 |
| `src/pages/Launch.tsx` | 修改 | 环境检查卡片、阻断逻辑、footer 徽章；移除旧的文字版"查看日志"按钮 |
| `src/styles/global.css` | 修改 | `.stop-btn` 替换 `.restart-btn` 红色样式；新增 `.env-card` 系列样式 |

工作目录约定：所有命令在仓库根 `D:\workspace\custom\deepseek-harness-desktop` 下执行。

---

### 任务 1：Rust 后端环境探测扩展

**文件：**
- 修改：`src-tauri/src/dsh.rs`（`StatusPayload` 结构体约 61 行；工具解析区约 132-157 行；`app_status` 约 488-536 行）

- [ ] **步骤 1.1：在 `resolve_pnpm` 函数之后（`is_ps1` 与 `pnpm_global_bin` 之间的工具解析区域）新增两个函数**

在 `resolve_pnpm()` 函数结束后插入：

```rust
/// 通过 PATH 查找 node 可执行文件
fn resolve_node() -> Option<PathBuf> {
    run_where("node").into_iter().find(|p| is_exec_shim(p))
}

/// 执行 `<program> --version` 并解析首行输出版本号（去前导 v，如 `22.21.1`）。
///
/// 带 2 秒超时：子进程挂起时不阻塞 app_status；失败/超时/输出不合预期一律 None。
/// 输出首行必须形如 `major.minor[.patch]` 才视为有效版本。
fn read_tool_version(program: &PathBuf) -> Option<String> {
    let program = program.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let out = hide_window(Command::new(&program).arg("--version")).output();
        let _ = tx.send(out);
    });
    let output = rx.recv_timeout(Duration::from_secs(2)).ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().next()?.trim();
    let ver = line.strip_prefix('v').unwrap_or(line);
    let mut parts = ver.split('.');
    parts.next()?.parse::<u64>().ok()?;
    Some(ver.to_string())
}
```

注意：文件顶部已有 `use std::io::{BufRead, BufReader, Read, Write};` 等，`std::sync::mpsc` 用完整路径书写即可，不需要新增 use；`Duration` 已导入。

- [ ] **步骤 1.2：扩展 `StatusPayload` 结构体**

将：

```rust
#[derive(Serialize, Clone)]
pub struct StatusPayload {
    pub dsh_installed: bool,
    pub service_running: bool,
    pub child_running: bool,
    pub url: Option<String>,
    pub pnpm_path: Option<String>,
    pub dsh_path: Option<String>,
}
```

替换为：

```rust
#[derive(Serialize, Clone)]
pub struct StatusPayload {
    pub dsh_installed: bool,
    pub service_running: bool,
    pub child_running: bool,
    pub url: Option<String>,
    pub pnpm_path: Option<String>,
    pub dsh_path: Option<String>,
    pub node_path: Option<String>,
    pub node_version: Option<String>,
    pub pnpm_version: Option<String>,
}
```

- [ ] **步骤 1.3：在 `app_status` 中填充新字段**

将：

```rust
    let pnpm = resolve_pnpm();
    let pnpm_path = pnpm.map(|p| p.to_string_lossy().into_owned());
```

替换为（先取版本再消费所有权，顺序不能颠倒）：

```rust
    let pnpm = resolve_pnpm();
    let pnpm_version = pnpm.as_ref().and_then(|p| read_tool_version(p));
    let pnpm_path = pnpm.map(|p| p.to_string_lossy().into_owned());

    let node = resolve_node();
    let node_version = node.as_ref().and_then(|p| read_tool_version(p));
    let node_path = node.map(|p| p.to_string_lossy().into_owned());
```

并将函数末尾的构造改为：

```rust
    StatusPayload {
        dsh_installed,
        service_running,
        child_running,
        url,
        pnpm_path,
        dsh_path,
        node_path,
        node_version,
        pnpm_version,
    }
```

- [ ] **步骤 1.4：编译验证**

运行：`cargo check --manifest-path src-tauri/Cargo.toml`
预期：`Finished` 且无 error（warning 允许）。

- [ ] **步骤 1.5：Commit**

```bash
git add src-tauri/src/dsh.rs
git commit -m "feat(backend): 环境预检探测 node/pnpm 安装与版本"
```

---

### 任务 2：前端桥接层与状态透传

**文件：**
- 修改：`src/lib/tauri.ts`（`StatusPayload` 接口约 24-31 行）
- 修改：`src/store/useAppStore.ts`（`AppStore` 接口约 20-39 行；初始值约 109-119 行；`init` 约 153-168 行；`refreshStatus` 约 178-195 行）

- [ ] **步骤 2.1：`src/lib/tauri.ts` 的 `StatusPayload` 接口追加字段**

```ts
export interface StatusPayload {
  dsh_installed: boolean;
  service_running: boolean;
  child_running: boolean;
  url: string | null;
  pnpm_path: string | null;
  dsh_path: string | null;
  node_path: string | null;
  node_version: string | null;
  pnpm_version: string | null;
}
```

- [ ] **步骤 2.2：`useAppStore.ts` 的 `AppStore` 接口与初始值**

在接口的 `dshPath: string | null;` 之后追加：

```ts
  nodePath: string | null;
  nodeVersion: string | null;
  pnpmVersion: string | null;
```

在 create 初始值对象的 `dshPath: null,` 之后追加：

```ts
  nodePath: null,
  nodeVersion: null,
  pnpmVersion: null,
```

- [ ] **步骤 2.3：`init()` 的 `set({...})` 写入新字段**

在 `init()` 中 `dshPath: s.dsh_path,` 之后追加：

```ts
          nodePath: s.node_path,
          nodeVersion: s.node_version,
          pnpmVersion: s.pnpm_version,
```

- [ ] **步骤 2.4：`refreshStatus()` 同样写入**

在 `refreshStatus()` 中 `dshPath: s.dsh_path,` 之后追加同样的三行：

```ts
          nodePath: s.node_path,
          nodeVersion: s.node_version,
          pnpmVersion: s.pnpm_version,
```

- [ ] **步骤 2.5：构建验证**

运行：`pnpm build`
预期：tsc 无类型错误，vite 构建成功。

- [ ] **步骤 2.6：Commit**

```bash
git add src/lib/tauri.ts src/store/useAppStore.ts
git commit -m "feat(store): 透传 node/pnpm 环境探测结果到前端状态"
```

---

### 任务 3：新增图标（暂不删旧图标，保证构建常绿）

**文件：**
- 修改：`src/components/icons.tsx`

- [ ] **步骤 3.1：在 `RefreshIcon` 之后新增两个图标**

```tsx
export function RotateCwIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.85.99 6.36 2.64L21 8" />
      <path d="M21 3v5h-5" />
    </svg>
  );
}

export function TerminalSquareIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
      <path d="m7 11 2-2-2-2" />
      <path d="M11 13h4" />
    </svg>
  );
}
```

说明：`RotateCwIcon` 是单箭头顺时针循环（区别于双箭头的 `RefreshIcon` 刷新）；`TerminalSquareIcon` 为方框终端造型，用于日志入口。电源符号 `RestartIcon` 本任务保留（TitleBar 仍引用），任务 4 中一并删除。

- [ ] **步骤 3.2：构建验证**

运行：`pnpm build`
预期：成功（新增导出未被引用不会触发 noUnusedLocals）。

- [ ] **步骤 3.3：Commit**

```bash
git add src/components/icons.tsx
git commit -m "feat(ui): 新增循环重启与终端日志图标"
```

---

### 任务 4：标题栏三按钮与确认弹框

**文件：**
- 修改：`src/components/TitleBar.tsx`（整文件重写引用与 center 区域）
- 修改：`src/components/icons.tsx`（删除 `RestartIcon`）
- 修改：`src/styles/global.css`（约 690-704 行 `.restart-btn` 区块）

- [ ] **步骤 4.1：从 `icons.tsx` 删除整个 `RestartIcon` 函数**（第 30-37 行）：

```tsx
export function RestartIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M12 2v10" />
      <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
    </svg>
  );
}
```

- [ ] **步骤 4.2：重写 `TitleBar.tsx`**

```tsx
import { App as AntApp } from "antd";
import { useState } from "react";
import { useNavigate } from "react-router";
import logo from "../assets/logo.svg";
import { ArrowLeftIcon, CopyIcon, ExternalIcon, RefreshIcon, RotateCwIcon, StopIcon, TerminalSquareIcon } from "./icons";
import ThemeSwitch from "./ThemeSwitch";
import WindowControls from "./WindowControls";
import { api } from "../lib/tauri";
import { useAppStore } from "../store/useAppStore";
import { useUiStore } from "../store/useUiStore";

export default function TitleBar() {
  const navigate = useNavigate();
  const { message, modal } = AntApp.useApp();
  const url = useAppStore((s) => s.url);
  const phase = useAppStore((s) => s.phase);
  const serviceRunning = useAppStore((s) => s.serviceRunning);
  const stop = useAppStore((s) => s.stop);
  const startFlow = useAppStore((s) => s.startFlow);
  const bumpReload = useUiStore((s) => s.bumpReload);
  const [restarting, setRestarting] = useState(false);

  const copyUrl = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      message.success("地址已复制到剪贴板");
    } catch {
      message.error("复制失败");
    }
  };

  // 重启：停止当前服务 → 重新启动 → 自动刷新已加载的页面
  const handleRestart = async () => {
    if (restarting) return;
    setRestarting(true);
    message.open({ type: "loading", content: "正在重启服务…", key: "restart", duration: 0 });
    try {
      await stop();
      await startFlow();
      bumpReload();
      message.success({ content: "服务已重新启动", key: "restart" });
    } catch (e) {
      message.error({ content: `重启失败：${String(e)}`, key: "restart" });
    } finally {
      setRestarting(false);
    }
  };

  // 危险操作统一弹框确认后再执行
  const confirmRestart = () => {
    modal.confirm({
      title: "重启服务",
      content: "确定要重启服务吗？正在浏览的页面会短暂中断。",
      okText: "重启",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: () => void handleRestart(),
    });
  };

  const confirmStop = () => {
    modal.confirm({
      title: "停止服务",
      content: "确定要停止当前服务吗？停止后需重新启动才能继续访问。",
      okText: "停止",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: () => {
        void stop();
        navigate("/");
      },
    });
  };

  // 安装/启动过程中禁用重启按钮，避免重复触发
  const busy = phase === "installing" || phase === "starting";

  return (
    <header className="titlebar">
      <div className="titlebar-left">
        <img src={logo} alt="Harness" draggable={false} className="titlebar-logo" />
        <span className="titlebar-name">DeepSeek Harness Desktop</span>
      </div>

      <div className="titlebar-center">
        <button
          className="icon-btn stop-btn"
          type="button"
          title="停止服务"
          aria-label="停止服务"
          disabled={!serviceRunning || restarting}
          onClick={confirmStop}
        >
          <StopIcon />
        </button>
        <button
          className="icon-btn"
          type="button"
          title="重启服务"
          aria-label="重启服务"
          disabled={restarting || busy}
          onClick={confirmRestart}
        >
          {/* 重启中不旋转方向性图标（避免怪异动效），loading 状态由消息气泡提示 */}
          <RotateCwIcon />
        </button>
        <button
          className="icon-btn"
          type="button"
          title="查看日志"
          aria-label="查看日志"
          onClick={() => navigate("/terminal")}
        >
          <TerminalSquareIcon />
        </button>
        <button className="icon-btn" type="button" title="返回启动页" aria-label="返回启动页" onClick={() => navigate("/")}>
          <ArrowLeftIcon />
        </button>
        <div className="url-pill">
          <span className="dot" />
          <span className="url-value">{url ?? "未检测到服务"}</span>
        </div>
        <button className="icon-btn" type="button" title="刷新" aria-label="刷新" onClick={bumpReload}>
          <RefreshIcon />
        </button>
        <button className="icon-btn" type="button" title="复制地址" aria-label="复制地址" onClick={() => void copyUrl()}>
          <CopyIcon />
        </button>
        <button
          className="icon-btn"
          type="button"
          title="在浏览器中打开"
          aria-label="在浏览器中打开"
          onClick={() => {
            if (url)
              void api.openInBrowser(url).catch((e) =>
                message.error(String(e instanceof Error ? e.message : e)),
              );
          }}
        >
          <ExternalIcon />
        </button>
      </div>

      <div className="titlebar-right">
        <ThemeSwitch />
        <WindowControls />
      </div>
    </header>
  );
}
```

要点：停止按钮在 `!serviceRunning` 时置灰禁用（布局稳定）；重启按钮改中性色（去掉红色类），红色语义只留给停止，消除"像关机"的双红歧义。

- [ ] **步骤 4.3：替换 `global.css` 中的 `.restart-btn` 区块**

将以下三段（原 690-704 行）：

```css
/* 标题栏红色"重启服务"按钮（位于返回键左侧） */
.restart-btn {
  color: var(--danger);
}

.restart-btn:hover {
  color: #fff;
  background: rgba(248, 113, 113, 0.16);
  border-color: rgba(248, 113, 113, 0.45);
}

.restart-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
```

替换为：

```css
/* 标题栏红色"停止服务"按钮（位于重启键左侧）；重启改用中性色，红色语义只留给停止 */
.stop-btn {
  color: var(--danger);
}

.stop-btn:hover:not(:disabled) {
  color: #fff;
  background: rgba(248, 113, 113, 0.16);
  border-color: rgba(248, 113, 113, 0.45);
}

.stop-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
```

- [ ] **步骤 4.4：构建验证**

运行：`pnpm build`
预期：成功（无 `RestartIcon` 未定义引用残留——若报错说明还有文件引用它，用 grep 检查 `RestartIcon` 应零命中）。

- [ ] **步骤 4.5：Commit**

```bash
git add src/components/TitleBar.tsx src/components/icons.tsx src/styles/global.css
git commit -m "feat(titlebar): 停止/重启/日志按钮，危险操作二次确认"
```

---

### 任务 5：启动页环境检查卡片与阻断逻辑

**文件：**
- 修改：`src/pages/Launch.tsx`（整页调整）
- 修改：`src/styles/global.css`（启动页区块，约 403 行 footer 之前插入）

- [ ] **步骤 5.1：重写 `Launch.tsx`**

```tsx
import { useEffect, type ReactNode } from "react";
import { useNavigate } from "react-router";
import logo from "../assets/logo.svg";
import { tauri } from "../lib/tauri";
import { useAppStore } from "../store/useAppStore";

/** 环境要求：Node.js ≥ 22.19 */
const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 19;

function parseNodeVersion(v: string | null): { major: number; minor: number } | null {
  if (!v) return null;
  const m = /^(\d+)\.(\d+)/.exec(v);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]) };
}

function meetsNodeRequirement(version: string | null): boolean {
  const parsed = parseNodeVersion(version);
  if (!parsed) return false;
  return (
    parsed.major > MIN_NODE_MAJOR ||
    (parsed.major === MIN_NODE_MAJOR && parsed.minor >= MIN_NODE_MINOR)
  );
}

interface EnvRow {
  name: string;
  state: "ok" | "bad" | "warn";
  detail: ReactNode;
}

export default function Launch() {
  const navigate = useNavigate();
  const { phase, url, dshInstalled, pnpmPath, dshPath, initialized, init, refreshStatus } =
    useAppStore();
  const nodePath = useAppStore((s) => s.nodePath);
  const nodeVersion = useAppStore((s) => s.nodeVersion);
  const pnpmVersion = useAppStore((s) => s.pnpmVersion);

  useEffect(() => {
    if (!initialized) {
      void init();
    } else {
      void refreshStatus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const busy = phase === "checking" || phase === "installing" || phase === "starting";

  // ---- 环境判定 ----
  const nodeOk = meetsNodeRequirement(nodeVersion);
  const pnpmOk = Boolean(pnpmPath);
  const envAllOk = nodeOk && pnpmOk; // dsh 未安装不阻断（会自动安装）
  // 仅主按钮会触发启动流程的状态才阻断；运行中"打开应用"、浏览器预览模式不受影响
  const startGated =
    tauri && !envAllOk && (phase === "idle" || phase === "stopped" || phase === "error");
  const cardState = startGated ? "bad" : envAllOk ? "" : "warn";

  // ---- 环境检查行 ----
  const envRows: EnvRow[] = [];
  if (!tauri) {
    envRows.push({
      name: "运行环境",
      state: "warn",
      detail: "浏览器预览模式：环境检查需在桌面应用内进行",
    });
  } else {
    if (nodeOk) {
      envRows.push({ name: "Node.js", state: "ok", detail: <>已安装 v{nodeVersion}</> });
    } else if (!nodePath) {
      envRows.push({
        name: "Node.js",
        state: "bad",
        detail: <>未检测到 Node.js，请安装 LTS 版本（≥ 22.19）：https://nodejs.org/</>,
      });
    } else if (!nodeVersion) {
      envRows.push({
        name: "Node.js",
        state: "bad",
        detail: <>已找到 Node 但无法读取版本，建议重新安装 LTS 版本</>,
      });
    } else {
      envRows.push({
        name: "Node.js",
        state: "bad",
        detail: <>当前 v{nodeVersion}，低于要求的 22.19，请升级后重启本应用</>,
      });
    }

    envRows.push(
      pnpmOk
        ? {
            name: "pnpm",
            state: "ok" as const,
            detail: pnpmVersion ? <>已安装 v{pnpmVersion}</> : <>已安装</>,
          }
        : {
            name: "pnpm",
            state: "bad" as const,
            detail: <>未检测到 pnpm，请执行 npm install -g pnpm（https://pnpm.io/zh-CN/installation）</>,
          },
    );

    envRows.push(
      dshInstalled
        ? { name: "dsh CLI", state: "ok" as const, detail: <>已安装</> }
        : { name: "dsh CLI", state: "warn" as const, detail: <>未安装 · 首次启动时自动安装 @deepseek-ai/dsh</> },
    );
  }

  let statusText: ReactNode;
  let statusClass = "launch-status";
  if (phase === "checking") {
    statusText = "正在检测运行环境…";
    statusClass += " busy";
  } else if (phase === "running") {
    statusText = (
      <>
        服务运行中
        {url ? <span className="url-text">{url}</span> : null}
      </>
    );
    statusClass += " running";
  } else if (phase === "error") {
    statusText = "启动失败，请检查终端日志";
    statusClass += " error";
  } else if (phase === "stopped") {
    statusText = "服务已停止，点击重新启动";
  } else {
    statusText = dshInstalled ? "环境就绪 · 点击启动本地服务" : "首次使用 · 将自动安装 @deepseek-ai/dsh";
  }

  const handlePrimary = () => {
    if (phase === "running") {
      navigate("/preview");
      return;
    }
    navigate("/terminal");
  };

  let btnText = "启动应用";
  if (phase === "checking") btnText = "检测中…";
  else if (phase === "running") btnText = "打开应用";
  else if (phase === "installing") btnText = "安装中…";
  else if (phase === "starting") btnText = "启动中…";
  else if (phase === "error" || phase === "stopped") btnText = "重新启动";

  return (
    <div className="page launch">
      <div className="launch-logo-wrap">
        <div className="launch-logo">
          <img src={logo} alt="Harness Logo" draggable={false} />
        </div>
      </div>

      <h1 className="launch-title">DeepSeek Harness Desktop</h1>
      <p className="launch-subtitle">DeepSeek Harness · 本地服务启动器</p>

      <div className={statusClass}>
        <span className="dot" />
        <span>{statusText}</span>
      </div>

      {initialized ? (
        <div className={`env-card ${cardState}`.trim()}>
          {envRows.map((r) => (
            <div key={r.name} className="env-row">
              <span className={`env-mark ${r.state}`}>
                {r.state === "ok" ? "✓" : r.state === "warn" ? "○" : "✗"}
              </span>
              <span className="env-name">{r.name}</span>
              <span className="env-detail">{r.detail}</span>
            </div>
          ))}
          {startGated ? (
            <div className="env-hint">请先修复以上环境问题，修复后重启应用再启动服务</div>
          ) : null}
        </div>
      ) : null}

      {!tauri ? (
        <div className="launch-preview-note">
          🖥 浏览器预览模式：仅界面预览，启动/停止等服务操作需在桌面应用内使用
        </div>
      ) : null}

      <div className="launch-actions">
        <button
          className="btn-primary"
          disabled={busy || startGated}
          onClick={handlePrimary}
          style={{ minWidth: 220 }}
        >
          <span className="btn-shine" />
          {btnText}
        </button>
      </div>

      {initialized ? (
        <div className="launch-footer">
          {nodeVersion ? (
            <span className="env-chip">
              node <b>v{nodeVersion}</b>
            </span>
          ) : null}
          {pnpmPath ? (
            <span className="env-chip">
              pnpm <b>{pnpmPath.split(/[\\/]/).slice(-2).join("/")}</b>
            </span>
          ) : null}
          {dshPath ? (
            <span className="env-chip">
              dsh <b>{dshPath.split(/[\\/]/).slice(-2).join("/")}</b>
            </span>
          ) : null}
          <span className="env-chip">v0.1.0</span>
        </div>
      ) : null}
    </div>
  );
}
```

要点：
- 移除了原来 `phase === "running"` 时的文字版"查看日志"次按钮（用户选择标题栏单一入口）；
- 阻断只作用于会触发启动的状态（idle/stopped/error），且文案不变、由卡片承担原因说明。

- [ ] **步骤 5.2：在 `global.css` 的 `.launch-actions` 规则之前插入环境卡片样式**

```css
/* 环境检查卡片：逐项展示 Node.js / pnpm / dsh 状态 */
.env-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(500px, 92%);
  margin-bottom: 22px;
  padding: 14px 18px;
  border-radius: 14px;
  background: var(--panel);
  border: 1px solid var(--border);
  animation: fadeUp 0.7s 0.26s cubic-bezier(0.22, 1, 0.36, 1) both;
}

.env-card.bad {
  border-color: rgba(248, 113, 113, 0.45);
  box-shadow: 0 0 0 1px rgba(248, 113, 113, 0.12);
}

/* 服务运行中发现环境变化：不阻断，仅黄色提醒 */
.env-card.warn {
  border-color: rgba(250, 204, 21, 0.4);
}

.env-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 13px;
}

.env-mark {
  flex-shrink: 0;
  width: 16px;
  text-align: center;
  font-weight: 700;
}

.env-mark.ok {
  color: var(--success);
}

.env-mark.bad {
  color: var(--danger);
}

.env-mark.warn {
  color: var(--warn);
}

.env-name {
  flex-shrink: 0;
  font-weight: 600;
  color: var(--text-1);
}

.env-detail {
  min-width: 0;
  font-size: 12.5px;
  color: var(--text-3);
  overflow-wrap: anywhere;
}

.env-hint {
  padding-top: 8px;
  border-top: 1px dashed var(--border-strong);
  font-size: 12.5px;
  color: var(--danger);
}
```

同时把 `.launch-status` 的 `margin: 30px 0 20px;` 改为 `margin: 30px 0 22px;`（与卡片间距协调，可选微调）。

- [ ] **步骤 5.3：构建验证**

运行：`pnpm build`
预期：tsc 与 vite 构建均成功。

- [ ] **步骤 5.4：Commit**

```bash
git add src/pages/Launch.tsx src/styles/global.css
git commit -m "feat(launch): 环境预检卡片与阻断式启动保护"
```

---

### 任务 6：整体回归验证

**文件：** 无代码改动（验证任务）

- [ ] **步骤 6.1：Rust 与前端全量编译**

```bash
cargo check --manifest-path src-tauri/Cargo.toml
pnpm build
```
预期：两者均成功。

- [ ] **步骤 6.2：手动验证清单（`pnpm tauri:dev`，需要用户配合观察）**

1. 正常环境启动页：卡片三行 Node.js ✓（显示版本）、pnpm ✓（显示版本）、dsh ✓ 或 ○（提示自动安装）；主按钮可点。
2. 模拟 Node 缺失（临时把 node.exe 改名后重启应用）：Node 行 ✗ 附 nodejs.org 指引，卡片红边 + 底部提示，启动/重新启动按钮禁用；标题栏日志按钮仍可进入日志页。
3. 模拟版本过低（PATH 前置一个低版本 node）：显示"当前 vX.Y，低于要求的 22.19"，同样阻断。
4. 重启按钮：图标为单箭头循环；点击弹出确认框，取消不动作，确认后出现"正在重启服务…"气泡并恢复运行。
5. 停止按钮：服务运行时可点，确认后服务停止并回到启动页（状态"服务已停止"）；服务未运行时置灰不可点。
6. 日志按钮：任意页面点击跳转 `/terminal` 日志页；原启动页文字版"查看日志"按钮已不存在。
7. 回归：刷新/复制地址/浏览器打开/主题切换/窗口控制均正常。

- [ ] **步骤 6.3：收尾 Commit（如有微调）**

```bash
git add -A
git commit -m "chore: 启动页预检与标题栏服务控制回归修正"
```

---

## 自检记录

- **规格覆盖度**：后端探测→任务 1；状态透传→任务 2；图标更换→任务 3/4；停止/重启/日志按钮+确认框→任务 4；预检卡片+阻断+徽章→任务 5；运行中标黄、非 Tauri 占位、版本不可读边界→任务 5（cardState warn 分支、!tauri 占位行、`!nodeVersion` 分支）与任务 1（超时/失败返回 None）；验证→任务 6。无遗漏。
- **占位符扫描**：全部步骤含实际代码/命令，无 TODO/待定。
- **类型一致性**：`StatusPayload`（snake_case 字段）在任务 1/2 两端一致；store 字段 `nodePath/nodeVersion/pnpmVersion` 在任务 2 定义、任务 5 消费一致；`meetsNodeRequirement`/`MIN_NODE_MAJOR`/`MIN_NODE_MINOR` 定义与使用一致；`RotateCwIcon`/`TerminalSquareIcon` 在任务 3 定义、任务 4 引用一致；CSS 类名 `env-card/env-row/env-mark/env-name/env-detail/env-hint/stop-btn` 与 TSX 一致。
