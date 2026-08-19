# 设计：自定义标题栏 + 浅色主题跟随系统 + 托盘驻留

- 日期：2026-08-17
- 状态：已确认（用户批准设计）
- 目标版本：0.1.0（下一 patch）

## 背景与动机

应用当前使用系统原生标题栏，页面内容为写死的暗色主题（antd `darkAlgorithm` + 硬编码 `#07090d`）。系统切到浅色主题时，原生标题栏变浅色而内容仍为深色，观感割裂。本次将：

1. 去掉系统边框，自绘完整标题栏（颜色随应用主题，应用主题自动跟随系统主题）
2. 新增浅色主题，深/浅自动跟随系统，并提供手动三态切换（跟随系统/浅色/深色）
3. 关闭按钮改为最小化到系统托盘（服务继续运行），托盘提供 打开 / 浏览器中打开 / 退出，并支持单实例恢复

## 1. 窗口与标题栏

### 1.1 窗口配置（`src-tauri/tauri.conf.json`）

- 主窗口增加 `"decorations": false`（去掉系统标题栏与边框）
- 其余窗口配置（尺寸、居中、resizable）不变
- Windows 优先；macOS/Linux 同样生效，不做平台差异适配

### 1.2 标题栏组件（新增 `src/components/TitleBar.tsx`）

常驻组件，放在 `App.tsx` 的 `<HashRouter>` 外层，所有页面共用：

- **左侧**：现有 logo（`src/assets/logo.svg`）+ "DeepSeek Harness Desktop" 文本
- **中间导航条**（由 `Preview.tsx` 的 `.preview-toolbar` 上移而来）：
  - 返回：路由回启动页（`navigate("/")`）；已在启动页时点击无操作
  - 地址栏：当前服务 URL（`useAppStore.url`）；无 URL 时显示"未检测到服务"
  - 刷新：触发预览 iframe 重新加载（通过 `useUiStore.reloadKey`；Preview 未挂载时 bump 无副作用）
  - 复制：复制当前 URL 到剪贴板（沿用 `navigator.clipboard` + antd message 提示）
  - 浏览器中打开：调用 `api.openInBrowser(url)`
- **右侧窗口控制**（新增 `src/components/WindowControls.tsx`）：
  - 最小化：`getCurrentWindow().minimize()`
  - 最大化/还原：`toggleMaximize()`，图标随 `isMaximized` 状态切换（`onResized` 监听）
  - 关闭：`getCurrentWindow().close()` → 触发 `CloseRequested`（见 2.2，隐藏到托盘）
- **主题切换按钮**位于窗口控制按钮左侧（antd Dropdown 三态，见 3.4）

### 1.3 拖拽与双击

- 标题栏容器设置 `data-tauri-drag-region`（Tauri v2 原生支持）
- 交互元素（按钮、地址栏、logo 链接等）用 `data-tauri-drag-region` 排除或独立容器，避免点击被吞
- 标题栏空白区域双击 = 最大化/还原（参考 `frountend-project-manager` 的 TopBar 做法）

## 2. 托盘 + 单实例（Rust 侧）

### 2.1 依赖（`src-tauri/Cargo.toml`）

- `tauri` features 增加 `"tray-icon"`
- 新增 `tauri-plugin-single-instance = "2"`

### 2.2 关闭行为（`src-tauri/src/lib.rs`）

- `on_window_event` 的 `CloseRequested`：`api.prevent_close()` + `window.hide()`，**删除**原有的"关闭即 `stop_dsh_web`"逻辑（服务继续在后台运行）
- `RunEvent::Exit` 保留 `stop_dsh_web`：托盘"退出"→ `app.exit(0)` → 停服务 → 进程结束（`app.exit` 不触发窗口 `CloseRequested`，无需退出标志）

### 2.3 托盘（`lib.rs` `setup()`）

- `TrayIconBuilder`：图标用 `app.default_window_icon()`（应用图标）
- 右键菜单三项（`tauri::menu`）：
  - **打开**：恢复主窗口到前台（`show` + `unminimize` + `set_focus`）
  - **浏览器中打开**：读取 `AppState.detected_url`，有则调用 `dsh::open_url`，无则点击无操作
  - **退出**：`app.exit(0)`
- 托盘左键单击：恢复主窗口到前台
- `show_menu_on_left_click(false)`（右键弹菜单）

### 2.4 单实例

- `tauri_plugin_single_instance::init` 注册；回调：恢复主窗口到前台（与"打开"共用辅助函数 `show_main_window`）

### 2.5 复用（`src-tauri/src/dsh.rs`）

- 现有 `open_in_browser` 命令的"打开默认浏览器"逻辑抽为公共函数 `pub fn open_url(url: &str) -> Result<(), String>`（内部仍是 `cmd /C start`），命令与托盘菜单共同调用

## 3. 主题系统（前端）

### 3.1 状态（新增 `src/store/useThemeStore.ts`）

- `mode: "system" | "light" | "dark"`，持久化到 `localStorage`（key: `hl.theme`）
- `system` 模式：用 `window.matchMedia("(prefers-color-scheme: dark)")` 解析实际主题，并 `addEventListener("change")` 监听系统切换
- 对外暴露：`mode`、`effective`（实际生效主题）、`setMode`

### 3.2 antd（`App.tsx`）

- `ConfigProvider.theme.algorithm`：深色 `darkAlgorithm` / 浅色 `defaultAlgorithm`
- 两套 token：深色沿用现值（`colorBgBase #07090d` 等）；浅色新建（主色 `#6366f1` 不变，背景/文本用浅色系）

### 3.3 CSS 变量（`src/styles/global.css`）

- 深色为 `:root` 默认（`data-theme` 属性缺省）
- 浅色用 `html[data-theme="light"]` 覆盖全部 `--bg / --panel / --text-* / --border / --success / --danger / --warn` 等
- 设置 `color-scheme: dark` / `color-scheme: light`，让滚动条、表单控件等原生控件跟随
- 审计硬编码色：`app-bg` 网格/光晕、`.launch-logo` 光晕、`.btn-primary` 渐变、`.term-*`、`.preview-*` 等在浅色下的可读性，逐处补浅色变体

### 3.4 切换入口（标题栏右侧）

- 主题按钮 + antd Dropdown 三态：跟随系统 / 浅色 / 深色；按钮图标随 `effective` 切换（太阳/月亮/半自动）

## 4. 页面调整

### 4.1 `Preview.tsx`

- 删除本地 `.preview-toolbar`（功能已上移标题栏）
- iframe 刷新：`reloadKey` 由本地 state 改为订阅全局 `useUiStore.reloadKey`（新增 `src/store/useUiStore.ts`，含 `reloadKey` / `bumpReload()`）
- 空态（无 URL）与断开重连覆盖层保留，仅去掉工具栏

### 4.2 `Launch.tsx` / `Terminal.tsx`

- 应用容器改为 flex 纵向布局：`TitleBar` 为固定高度（约 44px）的第一行，页面容器 `flex: 1; min-height: 0`，无需 padding 偏移
- Terminal 的模拟窗口头（圆点/标题/状态）保留

## 5. 范围与取舍

- **不做**标题栏"全屏"按钮（最小化/最大化/关闭三键）
- **不**主题化 Preview iframe 内嵌的外部 dsh web 页面（只主题化外壳）
- **不**做 macOS/Linux 平台差异适配（`decorations:false` 全平台生效，macOS 交通灯按钮由自定义按钮替代）
- 无新增 capability 权限（托盘为核心 API；单实例插件无命令权限）

## 6. 改动文件清单

| 文件 | 改动 |
|---|---|
| `src-tauri/tauri.conf.json` | 窗口加 `decorations: false` |
| `src-tauri/Cargo.toml` | `tray-icon` feature；`tauri-plugin-single-instance` |
| `src-tauri/src/lib.rs` | 托盘创建、菜单事件、单实例、CloseRequested 改隐藏、`show_main_window` |
| `src-tauri/src/dsh.rs` | 抽出 `open_url()` 公共函数 |
| `src/App.tsx` | TitleBar 常驻、主题化 ConfigProvider |
| `src/components/TitleBar.tsx`（新） | 标题栏：logo/名称/导航条/拖拽/双击 |
| `src/components/WindowControls.tsx`（新） | 最小化/最大化/关闭 + 最大化状态监听 |
| `src/store/useThemeStore.ts`（新） | 主题三态 + 系统跟随 |
| `src/store/useUiStore.ts`（新） | 全局 reload 信号 |
| `src/pages/Preview.tsx` | 删本地工具栏、改订阅全局 reload |
| `src/pages/Launch.tsx` / `Terminal.tsx` | 标题栏高度偏移 |
| `src/styles/global.css` | 浅色变量、标题栏/窗口控制/主题按钮样式、硬编码色审计 |
| `src/components/icons.tsx` | 窗口控制图标、主题图标 |

## 7. 验证

1. `cargo check`（src-tauri）通过
2. `tsc --noEmit` + `vite build` 通过
3. `pnpm tauri:build:win` 产出安装包
4. 运行验证：
   - 标题栏：拖拽移动、双击最大化/还原、三键工作、按钮区域不触发拖拽
   - 托盘：关闭后窗口隐藏、服务存活；右键菜单三项；左键恢复；"浏览器中打开"正确；"退出"停服务并结束进程
   - 单实例：托盘驻留时二次启动恢复已有窗口
   - 主题：系统深/浅切换实时跟随；手动三态覆盖；刷新后记忆；浅色下各页面无硬编码深色残留
