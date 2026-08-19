# 自定义标题栏 + 浅色主题 + 托盘驻留 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 去掉系统标题栏改为自绘标题栏（左 logo/名称、中导航条、右窗口控制+主题切换），新增浅色主题并自动跟随系统（含手动三态覆盖），关闭窗口最小化到托盘（打开/浏览器中打开/退出 + 单实例恢复）。

**架构：** Rust 侧负责无边框窗口、托盘、单实例与"关闭=隐藏"；前端负责自绘标题栏（拖拽/双击最大化/三键）、主题状态（zustand，跟随 `prefers-color-scheme`）与 antd/CSS 双层主题切换。导航条从 Preview 页上移到标题栏，通过全局 `useUiStore.reloadKey` 驱动 iframe 刷新。

**技术栈：** Tauri v2（`tray-icon` feature + `tauri-plugin-single-instance`）、React 19 + antd 6 + zustand、TypeScript、Vite 8。

**规格：** `docs/superpowers/specs/2026-08-17-titlebar-theme-tray-design.md`

**约定：** 仓库当前无测试框架（遵循现有模式，不做测试基建）。每个任务以"编译/类型检查通过 + 提交"作为验证门槛；最终任务含完整构建与手动验证清单。所有 Rust 命令在 `src-tauri` 目录下运行；前端命令在仓库根目录运行。

---

### 任务 1：Rust 依赖与窗口配置

**文件：**
- 修改：`src-tauri/Cargo.toml`
- 修改：`src-tauri/tauri.conf.json`

- [ ] **步骤 1：Cargo.toml 增加 tray-icon feature 与单实例插件**

将 `src-tauri/Cargo.toml` 第 16-19 行的 dependencies 改为：

```toml
[dependencies]
tauri = { version = "2", features = ["tray-icon"] }
tauri-plugin-single-instance = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

- [ ] **步骤 2：tauri.conf.json 主窗口去装饰**

将 `src-tauri/tauri.conf.json` 的 `app.windows[0]` 中 `"resizable": true` 之后增加一行：

```json
        "decorations": false,
```

（最终该窗口对象包含 `title/label/width/height/minWidth/minHeight/center/resizable/decorations/fullscreen`。）

- [ ] **步骤 3：验证配置可解析**

运行（仓库根目录）：`node -e "JSON.parse(require('fs').readFileSync('src-tauri/tauri.conf.json','utf8')); console.log('tauri.conf.json OK')"`
预期：输出 `tauri.conf.json OK`

- [ ] **步骤 4：Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/tauri.conf.json
git commit -m "feat: 窗口去装饰，引入 tray-icon 与单实例插件依赖"
```

---

### 任务 2：dsh.rs 抽出 open_url 公共函数

**文件：**
- 修改：`src-tauri/src/dsh.rs`（文件末尾 `open_in_browser`，约 592-611 行）

- [ ] **步骤 1：将 open_in_browser 改为调用公共 open_url**

把 `src-tauri/src/dsh.rs` 末尾的 `open_in_browser` 命令整体替换为：

```rust
/// 在系统默认浏览器中打开 URL（前端命令与托盘菜单共用）
pub fn open_url(url: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        hide_window(Command::new("cmd").args(["/C", "start", "", url]))
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg(url).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open").arg(url).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 在系统默认浏览器中打开 URL
#[tauri::command]
pub fn open_in_browser(url: String) -> Result<(), String> {
    open_url(&url)
}
```

（`hide_window` 是同一模块内的私有函数，可直接使用。）

- [ ] **步骤 2：编译验证**

运行（`src-tauri` 目录）：`cargo check`
预期：`Finished \`dev\` profile`，无错误

- [ ] **步骤 3：Commit**

```bash
git add src-tauri/src/dsh.rs
git commit -m "refactor: 抽出 open_url 供托盘复用"
```

---

### 任务 3：lib.rs 托盘 + 单实例 + 关闭隐藏

**文件：**
- 修改：`src-tauri/src/lib.rs`（整体替换）

- [ ] **步骤 1：整体替换 lib.rs**

将 `src-tauri/src/lib.rs` 全文替换为：

```rust
mod dsh;

use dsh::AppState;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, RunEvent, WindowEvent,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            dsh::app_status,
            dsh::probe_service,
            dsh::install_dsh,
            dsh::start_dsh_web,
            dsh::stop_dsh_web,
            dsh::open_in_browser,
        ])
        .setup(|app| {
            let open = MenuItem::with_id(app, "open", "打开", true, None::<&str>)?;
            let browser = MenuItem::with_id(app, "browser", "浏览器中打开", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &browser, &quit])?;

            let mut tray_builder = TrayIconBuilder::with_id("main-tray")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main_window(app),
                    "browser" => open_service_in_browser(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray_builder = tray_builder.icon(icon.clone());
            }
            tray_builder.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // 关闭窗口 → 隐藏到托盘，服务继续运行（托盘"退出"才真正退出）
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<AppState>() {
                    dsh::stop_dsh_web(state);
                }
            }
        });
}

/// 恢复主窗口到前台（托盘"打开"、左键单击、单实例回调共用）
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// 托盘"浏览器中打开"：读取已探测到的服务 URL 并在默认浏览器打开
fn open_service_in_browser(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        let url = state.detected_url.lock().unwrap().clone();
        if let Some(url) = url {
            let _ = dsh::open_url(&url);
        }
    }
}
```

注意：原 `on_window_event` 里"关闭即 stop_dsh_web"的逻辑已被删除（改为隐藏）；`RunEvent::Exit` 的停服务逻辑保留。

- [ ] **步骤 2：编译验证**

运行（`src-tauri` 目录）：`cargo check`
预期：`Finished \`dev\` profile`，无错误

- [ ] **步骤 3：Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat: 托盘菜单(打开/浏览器中打开/退出) + 单实例 + 关闭隐藏到托盘"
```

---

### 任务 4：前端主题状态 useThemeStore + useUiStore

**文件：**
- 创建：`src/store/useThemeStore.ts`
- 创建：`src/store/useUiStore.ts`

- [ ] **步骤 1：创建 useThemeStore.ts**

```ts
import { create } from "zustand";

export type ThemeMode = "system" | "light" | "dark";
export type EffectiveTheme = "light" | "dark";

const STORAGE_KEY = "hl.theme";

function systemPref(): EffectiveTheme {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function loadMode(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* ignore */
  }
  return "system";
}

interface ThemeState {
  mode: ThemeMode;
  effective: EffectiveTheme;
  init: () => void;
  setMode: (m: ThemeMode) => void;
}

let inited = false;

export const useThemeStore = create<ThemeState>((set, get) => {
  const initial = loadMode();
  return {
    mode: initial,
    effective: initial === "system" ? systemPref() : initial,
    init: () => {
      if (inited) return;
      inited = true;
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const onChange = () => {
        if (get().mode === "system") {
          set({ effective: mq.matches ? "dark" : "light" });
        }
      };
      mq.addEventListener("change", onChange);
    },
    setMode: (m) => {
      try {
        localStorage.setItem(STORAGE_KEY, m);
      } catch {
        /* ignore */
      }
      set({ mode: m, effective: m === "system" ? systemPref() : m });
    },
  };
});
```

- [ ] **步骤 2：创建 useUiStore.ts**

```ts
import { create } from "zustand";

interface UiState {
  reloadKey: number;
  bumpReload: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  reloadKey: 0,
  bumpReload: () => set((s) => ({ reloadKey: s.reloadKey + 1 })),
}));
```

- [ ] **步骤 3：类型检查**

运行（仓库根目录）：`npx tsc --noEmit`
预期：无错误

- [ ] **步骤 4：Commit**

```bash
git add src/store/useThemeStore.ts src/store/useUiStore.ts
git commit -m "feat: 主题三态 store（跟随系统）与全局 reload 信号 store"
```

---

### 任务 5：icons.tsx 新增图标

**文件：**
- 修改：`src/components/icons.tsx`

- [ ] **步骤 1：追加窗口控制与主题图标**

在 `src/components/icons.tsx` 文件末尾（`HomeIcon` 之后）追加：

```tsx
export function MinusIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M5 12h14" />
    </svg>
  );
}

export function MaximizeIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="5" y="5" width="14" height="14" rx="1" />
    </svg>
  );
}

export function RestoreIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="3.5" y="7.5" width="13" height="13" rx="1" />
      <path d="M7.5 7.5V4.5A1.5 1.5 0 0 1 9 3h10.5A1.5 1.5 0 0 1 21 4.5V15a1.5 1.5 0 0 1-1.5 1.5H16.5" />
    </svg>
  );
}

export function CloseIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
    </svg>
  );
}

export function SunIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

export function MoonIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

export function SystemIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}
```

- [ ] **步骤 2：类型检查**

运行（仓库根目录）：`npx tsc --noEmit`
预期：无错误

- [ ] **步骤 3：Commit**

```bash
git add src/components/icons.tsx
git commit -m "feat: 新增窗口控制与主题图标"
```

---

### 任务 6：WindowControls.tsx（最小化/最大化/关闭）

**文件：**
- 创建：`src/components/WindowControls.tsx`

- [ ] **步骤 1：创建组件**

```tsx
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import { CloseIcon, MaximizeIcon, MinusIcon, RestoreIcon } from "./icons";

export default function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let alive = true;

    void win
      .isMaximized()
      .then(setMaximized)
      .catch(() => undefined);
    void win
      .onResized(() => {
        void win
          .isMaximized()
          .then(setMaximized)
          .catch(() => undefined);
      })
      .then((fn) => {
        if (alive) unlisten = fn;
        else fn();
      });

    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  const win = getCurrentWindow();

  return (
    <div className="window-controls">
      <button
        type="button"
        className="win-btn"
        title="最小化"
        aria-label="最小化"
        onClick={() => void win.minimize()}
      >
        <MinusIcon size={14} />
      </button>
      <button
        type="button"
        className="win-btn"
        title={maximized ? "还原" : "最大化"}
        aria-label={maximized ? "还原" : "最大化"}
        onClick={() => void win.toggleMaximize()}
      >
        {maximized ? <RestoreIcon size={14} /> : <MaximizeIcon size={14} />}
      </button>
      <button
        type="button"
        className="win-btn win-btn-close"
        title="关闭"
        aria-label="关闭"
        onClick={() => void win.close()}
      >
        <CloseIcon size={14} />
      </button>
    </div>
  );
}
```

- [ ] **步骤 2：类型检查**

运行（仓库根目录）：`npx tsc --noEmit`
预期：无错误

- [ ] **步骤 3：Commit**

```bash
git add src/components/WindowControls.tsx
git commit -m "feat: 自定义窗口控制按钮(最小化/最大化/关闭)"
```

---

### 任务 7：ThemeSwitch.tsx（三态主题切换）

**文件：**
- 创建：`src/components/ThemeSwitch.tsx`

- [ ] **步骤 1：创建组件**

```tsx
import { Dropdown } from "antd";
import { MoonIcon, SunIcon, SystemIcon } from "./icons";
import { useThemeStore, type ThemeMode } from "../store/useThemeStore";

export default function ThemeSwitch() {
  const mode = useThemeStore((s) => s.mode);
  const effective = useThemeStore((s) => s.effective);
  const setMode = useThemeStore((s) => s.setMode);

  return (
    <Dropdown
      trigger={["click"]}
      placement="bottomRight"
      menu={{
        selectable: true,
        selectedKeys: [mode],
        items: [
          { key: "system", label: "跟随系统", icon: <SystemIcon size={14} /> },
          { key: "light", label: "浅色", icon: <SunIcon size={14} /> },
          { key: "dark", label: "深色", icon: <MoonIcon size={14} /> },
        ],
        onClick: ({ key }) => setMode(key as ThemeMode),
      }}
    >
      <button type="button" className="icon-btn theme-switch" title="切换主题">
        {effective === "dark" ? <MoonIcon size={15} /> : <SunIcon size={15} />}
      </button>
    </Dropdown>
  );
}
```

- [ ] **步骤 2：类型检查**

运行（仓库根目录）：`npx tsc --noEmit`
预期：无错误

- [ ] **步骤 3：Commit**

```bash
git add src/components/ThemeSwitch.tsx
git commit -m "feat: 三态主题切换按钮"
```

---

### 任务 8：TitleBar.tsx（自绘标题栏）

**文件：**
- 创建：`src/components/TitleBar.tsx`

- [ ] **步骤 1：创建组件**

```tsx
import { App as AntApp } from "antd";
import { type MouseEvent } from "react";
import { useNavigate } from "react-router";
import { getCurrentWindow } from "@tauri-apps/api/window";
import logo from "../assets/logo.svg";
import { ArrowLeftIcon, CopyIcon, ExternalIcon, RefreshIcon } from "./icons";
import ThemeSwitch from "./ThemeSwitch";
import WindowControls from "./WindowControls";
import { api } from "../lib/tauri";
import { useAppStore } from "../store/useAppStore";
import { useUiStore } from "../store/useUiStore";

/** 交互元素 —— 不得触发窗口拖拽 */
const NO_DRAG_CLOSEST =
  "button, input, a, select, textarea, label, .url-pill, .window-controls, .theme-switch, .ant-dropdown-trigger";

export default function TitleBar() {
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const url = useAppStore((s) => s.url);
  const bumpReload = useUiStore((s) => s.bumpReload);

  const copyUrl = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      message.success("地址已复制到剪贴板");
    } catch {
      message.error("复制失败");
    }
  };

  const onTitlebarMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as Element;
    if (target.closest(NO_DRAG_CLOSEST)) return;
    if (e.detail === 2) {
      void getCurrentWindow().toggleMaximize();
      return;
    }
    void getCurrentWindow().startDragging();
  };

  return (
    <header className="titlebar" onMouseDown={onTitlebarMouseDown}>
      <div className="titlebar-left">
        <img src={logo} alt="Harness" draggable={false} className="titlebar-logo" />
        <span className="titlebar-name">DeepSeek Harness Desktop</span>
      </div>

      <div className="titlebar-center">
        <button className="icon-btn" title="返回启动页" onClick={() => navigate("/")}>
          <ArrowLeftIcon />
        </button>
        <div className="url-pill">
          <span className="dot" />
          <span className="url-value">{url ?? "未检测到服务"}</span>
        </div>
        <button className="icon-btn" title="刷新" onClick={bumpReload}>
          <RefreshIcon />
        </button>
        <button className="icon-btn" title="复制地址" onClick={() => void copyUrl()}>
          <CopyIcon />
        </button>
        <button
          className="icon-btn"
          title="在浏览器中打开"
          onClick={() => {
            if (url) void api.openInBrowser(url);
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

- [ ] **步骤 2：类型检查**

运行（仓库根目录）：`npx tsc --noEmit`
预期：无错误

- [ ] **步骤 3：Commit**

```bash
git add src/components/TitleBar.tsx
git commit -m "feat: 自绘标题栏(logo/导航条/拖拽/双击最大化)"
```

---

### 任务 9：App.tsx 主题化 + 常驻标题栏布局

**文件：**
- 修改：`src/App.tsx`（整体替换）

- [ ] **步骤 1：整体替换 App.tsx**

```tsx
import { App as AntApp, ConfigProvider, theme as antdTheme } from "antd";
import { useEffect } from "react";
import { HashRouter, Navigate, Route, Routes } from "react-router";
import TitleBar from "./components/TitleBar";
import Launch from "./pages/Launch";
import Preview from "./pages/Preview";
import Terminal from "./pages/Terminal";
import { useThemeStore } from "./store/useThemeStore";

const FONT_FAMILY =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';

const DARK_TOKENS = {
  colorPrimary: "#6366f1",
  colorInfo: "#22d3ee",
  colorBgBase: "#07090d",
  colorTextBase: "#eef1f7",
  borderRadius: 10,
  fontFamily: FONT_FAMILY,
};

const LIGHT_TOKENS = {
  colorPrimary: "#6366f1",
  colorInfo: "#0891b2",
  colorBgBase: "#f6f7fb",
  colorTextBase: "#1c2129",
  borderRadius: 10,
  fontFamily: FONT_FAMILY,
};

export default function App() {
  const effective = useThemeStore((s) => s.effective);
  const initTheme = useThemeStore((s) => s.init);

  useEffect(() => {
    initTheme();
  }, [initTheme]);

  // 把实际主题同步到 <html> 的 data-theme 与 color-scheme（驱动 CSS 变量）
  useEffect(() => {
    const el = document.documentElement;
    el.dataset.theme = effective;
    el.style.colorScheme = effective;
  }, [effective]);

  return (
    <ConfigProvider
      theme={{
        algorithm:
          effective === "dark"
            ? antdTheme.darkAlgorithm
            : antdTheme.defaultAlgorithm,
        token: effective === "dark" ? DARK_TOKENS : LIGHT_TOKENS,
      }}
    >
      <AntApp>
        <div className="app-bg" />
        <HashRouter>
          <div className="app-shell">
            <TitleBar />
            <div className="app-content">
              <Routes>
                <Route path="/" element={<Launch />} />
                <Route path="/terminal" element={<Terminal />} />
                <Route path="/preview" element={<Preview />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </div>
          </div>
        </HashRouter>
      </AntApp>
    </ConfigProvider>
  );
}
```

- [ ] **步骤 2：类型检查**

运行（仓库根目录）：`npx tsc --noEmit`
预期：无错误

- [ ] **步骤 3：Commit**

```bash
git add src/App.tsx
git commit -m "feat: 主题化 ConfigProvider + 常驻标题栏布局"
```

---

### 任务 10：Preview.tsx 移除本地工具栏

**文件：**
- 修改：`src/pages/Preview.tsx`（整体替换）

- [ ] **步骤 1：整体替换 Preview.tsx**

```tsx
import { App as AntApp } from "antd";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { ArrowLeftIcon } from "../components/icons";
import { api } from "../lib/tauri";
import { useAppStore } from "../store/useAppStore";
import { useUiStore } from "../store/useUiStore";

export default function Preview() {
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const url = useAppStore((s) => s.url);
  const phase = useAppStore((s) => s.phase);
  const reloadKey = useUiStore((s) => s.reloadKey);

  const [loaded, setLoaded] = useState(false);
  const [alive, setAlive] = useState(true);
  const [rechecking, setRechecking] = useState(false);

  // 服务健康轮询
  useEffect(() => {
    if (!url) return;
    let disposed = false;
    const tick = async () => {
      try {
        const ok = await api.probeService(url);
        if (!disposed) setAlive(ok);
      } catch {
        if (!disposed) setAlive(false);
      }
    };
    void tick();
    const timer = setInterval(tick, 6000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [url]);

  // 标题栏"刷新"→ reloadKey 变化 → 重置加载态并重挂 iframe
  useEffect(() => {
    setLoaded(false);
  }, [reloadKey]);

  const recheck = useCallback(async () => {
    if (!url) return;
    setRechecking(true);
    try {
      const ok = await api.probeService(url);
      setAlive(ok);
      if (ok) message.success("服务连接正常");
    } finally {
      setRechecking(false);
    }
  }, [url, message]);

  // 无 URL → 空态
  if (!url) {
    return (
      <div className="page preview">
        <div className="empty-box">
          <div className="big">🛰</div>
          <div>未检测到本地服务地址</div>
          <button className="btn-secondary" onClick={() => navigate("/")}>
            <ArrowLeftIcon size={14} /> 返回启动页
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="page preview">
      <div className="preview-frame">
        <iframe
          key={reloadKey}
          src={url}
          title="Harness Preview"
          onLoad={() => setLoaded(true)}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            border: "none",
            background: "#fff",
          }}
          allow="clipboard-read; clipboard-write; fullscreen"
        />

        {!alive ? (
          <div className="preview-overlay">
            <div className="empty-box">
              <div className="big">📡</div>
              <div>本地服务已断开连接</div>
              <div style={{ color: "var(--text-3)", fontSize: 12.5 }}>
                {phase === "stopped" ? "服务已被停止" : "服务无响应，可尝试重新连接"}
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <button
                  className="btn-secondary"
                  onClick={() => void recheck()}
                  disabled={rechecking}
                >
                  {rechecking ? "检测中…" : "重新连接"}
                </button>
                <button className="btn-secondary" onClick={() => navigate("/")}>
                  返回启动页
                </button>
              </div>
            </div>
          </div>
        ) : !loaded ? (
          <div className="preview-overlay">
            <div className="preview-loading">
              <div className="spinner-ring" />
              <div>正在加载 {url} …</div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
```

注意：删除原 `.preview-toolbar` 及其 `reload`/`copyUrl` 回调（已上移标题栏）；`recheck`/健康轮询/空态/断开覆盖层保留。

- [ ] **步骤 2：类型检查**

运行（仓库根目录）：`npx tsc --noEmit`
预期：无错误

- [ ] **步骤 3：Commit**

```bash
git add src/pages/Preview.tsx
git commit -m "refactor: Preview 移除本地工具栏，刷新改走全局 reload 信号"
```

---

### 任务 11：global.css 标题栏样式 + 浅色主题变量

**文件：**
- 修改：`src/styles/global.css`

- [ ] **步骤 1：页面布局改为 flex（标题栏常驻）**

在 `src/styles/global.css` 的 `.ant-app` 块（约 45-47 行）之后追加：

```css
.app-shell {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  height: 100dvh;
}

.app-content {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
```

并将 `.page` 规则（约 113-121 行）中的 `min-height: 100dvh;` 改为 `min-height: 0;`：

```css
.page {
  position: relative;
  z-index: 1;
  height: 100%;
  /* 标题栏常驻后由 .app-content 提供高度，不再按视口撑满 */
  min-height: 0;
  display: flex;
  flex-direction: column;
}
```

- [ ] **步骤 2：追加标题栏/窗口控制/主题按钮样式**

在 `src/styles/global.css` 文件末尾追加：

```css
/* --------------------------------------------------------------------------
   自绘标题栏
   -------------------------------------------------------------------------- */

.titlebar {
  position: relative;
  z-index: 10;
  flex-shrink: 0;
  height: 44px;
  display: flex;
  align-items: center;
  background: var(--bg-elev);
  border-bottom: 1px solid var(--border);
  user-select: none;
}

.titlebar-left {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  flex-shrink: 0;
}

.titlebar-logo {
  width: 20px;
  height: 20px;
  display: block;
  pointer-events: none;
}

.titlebar-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
  white-space: nowrap;
}

.titlebar-center {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px;
}

.titlebar-center .icon-btn {
  flex-shrink: 0;
}

.titlebar-right {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.theme-switch {
  margin-right: 4px;
}

/* 窗口控制按钮（贴近系统风格：窄按钮 + 关闭红色悬停） */
.window-controls {
  display: flex;
  align-items: stretch;
  height: 44px;
}

.win-btn {
  width: 46px;
  display: grid;
  place-items: center;
  border: none;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  transition:
    background 0.15s ease,
    color 0.15s ease;
}

.win-btn:hover {
  background: var(--panel-strong);
  color: var(--text-1);
}

.win-btn-close:hover {
  background: #e81123;
  color: #fff;
}
```

- [ ] **步骤 3：浅色主题变量与覆盖**

在文件末尾追加浅色主题块：

```css
/* --------------------------------------------------------------------------
   浅色主题（html[data-theme="light"]，由 useThemeStore 驱动）
   -------------------------------------------------------------------------- */

html[data-theme="light"] {
  color-scheme: light;

  --bg: #f6f7fb;
  --bg-elev: #ffffff;
  --panel: rgba(15, 23, 42, 0.04);
  --panel-strong: rgba(15, 23, 42, 0.07);
  --border: rgba(15, 23, 42, 0.1);
  --border-strong: rgba(15, 23, 42, 0.16);

  --text-1: #1c2129;
  --text-2: #5a6478;
  --text-3: #98a1b3;

  --accent-1: #6366f1;
  --accent-2: #0891b2;
  --accent-3: #7c3aed;

  --success: #059669;
  --warn: #d97706;
  --danger: #dc2626;
}

html[data-theme="light"] .app-bg {
  background:
    radial-gradient(900px 520px at 12% -8%, rgba(99, 102, 241, 0.1), transparent 62%),
    radial-gradient(820px 500px at 88% 112%, rgba(14, 165, 233, 0.08), transparent 62%),
    radial-gradient(560px 380px at 72% -14%, rgba(124, 58, 237, 0.06), transparent 60%),
    var(--bg);
}

html[data-theme="light"] .app-bg::after {
  background-image:
    linear-gradient(rgba(15, 23, 42, 0.035) 1px, transparent 1px),
    linear-gradient(90deg, rgba(15, 23, 42, 0.035) 1px, transparent 1px);
}

html[data-theme="light"] ::selection {
  background: rgba(99, 102, 241, 0.22);
}

html[data-theme="light"] ::-webkit-scrollbar-thumb {
  background: rgba(15, 23, 42, 0.18);
}

html[data-theme="light"] ::-webkit-scrollbar-thumb:hover {
  background: rgba(15, 23, 42, 0.3);
}
```

- [ ] **步骤 4：审计残留硬编码深色（grep 检查）**

运行（仓库根目录）：`Select-String -Path "src\styles\global.css" -Pattern "rgba\(255,\s*255,\s*255|color:\s*#fff|background:\s*#fff" | Select-Object LineNumber, Line`

逐条检查输出中的选择器：凡属深色专用、浅色下会不可读的（如固定白色文本/固定白色半透明背景），在浅色块追加对应覆盖；若该规则同时依赖 `var(--*)`（如 `.btn-shine` 高光、logo 渐变），在浅色下可读则跳过。**检查重点：** `.launch-*`、`.term-*`、`.btn-*`、`.env-chip`、`.empty-box`、`.preview-*`、`.spinner-ring` 在浅色下的对比度。

- [ ] **步骤 5：构建验证**

运行（仓库根目录）：`npx tsc --noEmit && pnpm build`
预期：tsc 无错误；vite 构建成功

- [ ] **步骤 6：Commit**

```bash
git add src/styles/global.css
git commit -m "feat: 标题栏/窗口控制样式 + 浅色主题变量与覆盖"
```

---

### 任务 12：全量构建验证

**文件：** 无（仅验证）

- [ ] **步骤 1：Rust 编译**

运行（`src-tauri` 目录）：`cargo check`
预期：`Finished \`dev\` profile`，无错误

- [ ] **步骤 2：前端构建**

运行（仓库根目录）：`npx tsc --noEmit && pnpm build`
预期：无错误；`dist/` 产出

- [ ] **步骤 3：完整打包**

运行（仓库根目录）：`pnpm tauri:build:win`
预期：`Finished 1 bundle at: ...\DeepSeek Harness Desktop_0.1.0_x64-setup.exe`

- [ ] **步骤 4：Commit（如构建过程有残留修改）**

```bash
git status --porcelain
git add -A
git commit -m "chore: 全量构建验证"
```

（若工作区已干净则跳过本步。）

---

### 任务 13：手动运行验证清单

**文件：** 无（仅验证）

- [ ] **步骤 1：安装并启动**

运行 `src-tauri\target\release\bundle\nsis\DeepSeek Harness Desktop_0.1.0_x64-setup.exe` 安装并启动（或直接运行 `src-tauri\target\release\deepseek-harness-desktop.exe`）。

- [ ] **步骤 2：标题栏验证**

- [ ] 拖动标题栏空白区域可移动窗口；拖到屏幕边缘出现磁吸分屏
- [ ] 双击标题栏空白区域 最大化/还原
- [ ] 最小化按钮生效；最大化按钮切换且图标随状态变化；关闭按钮 → 窗口隐藏（见步骤 3）
- [ ] 点击返回/地址栏/刷新/复制/浏览器打开按钮**不会**触发窗口拖拽
- [ ] 地址栏显示服务 URL（服务运行后）或"未检测到服务"

- [ ] **步骤 3：托盘验证**

- [ ] 点击关闭 → 窗口消失，进程仍在（任务管理器可见），服务仍在运行
- [ ] 托盘图标存在；左键单击 → 窗口恢复
- [ ] 右键菜单：**打开** 恢复窗口；**浏览器中打开** 用默认浏览器打开服务 URL；**退出** 停止服务并结束进程
- [ ] 窗口隐藏时再次双击 exe → 不新建窗口，恢复已有窗口（单实例）

- [ ] **步骤 4：主题验证**

- [ ] 深色/浅色主题下 Launch、Terminal、Preview 三页均无固定深色残留、文字可读
- [ ] Windows 系统主题切换（设置→个性化→颜色→深/浅）→ 应用实时跟随（system 模式）
- [ ] 标题栏主题按钮：三态切换生效；图标随实际主题变化；刷新/重启后记忆所选模式
- [ ] 浅色下滚动条、下拉菜单等原生控件为浅色（color-scheme 生效）

- [ ] **步骤 5：回归验证**

- [ ] 安装/启动/停止 dsh web 服务、日志输出、预览 iframe 加载与刷新、复制地址、浏览器打开均正常
