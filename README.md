# DeepSeek Harness Desktop

> 本地 **DeepSeek Harness** 网页服务的轻量桌面壳——一键安装、启动、监控与内嵌预览本地服务，关闭后驻留系统托盘持续运行。

[![Tauri](https://img.shields.io/badge/Tauri%202-24c8db?logo=tauri&logoColor=white)](https://tauri.app)
[![React](https://img.shields.io/badge/React%2019-61dafb?logo=react&logoColor=white)](https://react.dev)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-8892b0)]()
[![Release](https://img.shields.io/github/v/release/jsoncode/deepseek-harness-desktop)](https://github.com/jsoncode/deepseek-harness-desktop/releases/latest)

![DeepSeek Harness Desktop — 暗色预览](docs/assets/dark.png)

📸 [查看全部界面截图 →](docs/preview.md)

---

## 📥 下载安装

面向新用户：直接下载对应平台的安装包，双击安装即可，无需自己动手搭建环境。

| 平台 | 安装包 | 大小 |
| --- | --- | --- |
| Windows 10/11（64 位） | [下载 .exe（NSIS 安装包）](https://github.com/jsoncode/deepseek-harness-desktop/releases/latest) | ~2.0 MB |
| macOS Apple Silicon | [下载 .dmg](https://github.com/jsoncode/deepseek-harness-desktop/releases/latest) / [下载 .pkg](https://github.com/jsoncode/deepseek-harness-desktop/releases/latest) | ~2.9 MB |
| macOS Intel（64 位） | [下载 .dmg](https://github.com/jsoncode/deepseek-harness-desktop/releases/latest) / [下载 .pkg](https://github.com/jsoncode/deepseek-harness-desktop/releases/latest) | ~3.0 MB |
| Linux x86_64 | [下载 .deb](https://github.com/jsoncode/deepseek-harness-desktop/releases/latest) / [.rpm](https://github.com/jsoncode/deepseek-harness-desktop/releases/latest) / [.AppImage](https://github.com/jsoncode/deepseek-harness-desktop/releases/latest) | ~3 MB |

> 所有安装包统一发布在 [GitHub Releases](https://github.com/jsoncode/deepseek-harness-desktop/releases/latest)，选择最新版本、下载对应平台的安装包即可。

> **Linux 说明**：`.deb` / `.rpm` 会自动声明 WebKitGTK 4.1、GTK3 与托盘（AppIndicator）依赖，用
> `sudo apt install ./xxx.deb` 或 `sudo dnf install ./xxx.rpm` 安装即可；AppImage **不打包系统库**，
> 需要发行版已提供 `libwebkit2gtk-4.1-0` 与 `libayatana-appindicator3-1`（Ubuntu 22.04+ /
> Debian 12+ 仓库默认就有）：

```bash
chmod +x "DeepSeek Harness Desktop_x.y.z_amd64.AppImage"
./"DeepSeek Harness Desktop_x.y.z_amd64.AppImage"
```

> 💡 **轻量**：以上为 v0.1.2 实测大小（Windows 2.02 MB、macOS 2.91~3.01 MB），各版本略有差异——全平台安装包都只有 2~3 MB，秒级下载、秒级安装。

**首次使用（两步完成）**：

1. 安装 [Node.js](https://nodejs.org/) ≥ 22.19 与 [pnpm](https://pnpm.io/zh-CN/installation)——首次启动时应用会自动执行 `pnpm add -g @deepseek-ai/dsh@latest` 安装 DSH 并启动本地服务（仅在 dsh 未安装时执行）；
2. 打开应用，点击「启动应用」手动启动服务（统一进入启动过渡页展示检测/安装/启动进度），服务就绪后自动打开服务页面。

> - Windows 若提示 SmartScreen，请选择「更多信息 → 仍要运行」。
> - macOS 应用未签名，首次打开需在「系统设置 → 隐私与安全性」中点击「仍要打开」，或右键应用选择「打开」。

---

## ✨ 亮点

- **安装包极小** — 全平台安装包仅 **2~3 MB**（Windows NSIS 约 2 MB、macOS DMG/PKG 约 3 MB），秒级下载、秒级安装（对比 Electron 应用动辄上百 MB）。
- **一键启动** — 自动全局安装 `@deepseek-ai/dsh`（pnpm）并启动本地网页服务，无需任何手动配置。已安装的 dsh 在启动时**不会被更新或重装**（保留现有版本，避免 `@latest` 覆盖引发兼容性问题）；仅当 dsh 缺失或安装损坏（读不出版本）时才安装。
- **pnpm 兼容** — 兼容 pnpm 10 全局布局（shims 位于 `PNPM_HOME`）：未运行过 `pnpm setup` 的机器也会自动完成临时 PATH 注入与用户级 PATH 持久化，安装后立即启动，下次打开不再重装。**暂不支持 pnpm 11**（dsh 与其全局虚拟仓库布局不兼容，启动页会提示并一键降级到 pnpm 10；降级后同样保留现有 dsh 版本）。
- **智能服务检测** — 探测默认端口，且只认自家子进程输出中提及的 URL，绝不误连外部已运行的实例。
- **流式终端** — macOS 风格模拟终端，实时输出安装/启动日志，支持停止、重启与崩溃提示。
- **内嵌预览** — Windows / macOS 把本地 DSH 网页作为原生子 webview 悬浮在内容区，带健康轮询与标题栏刷新；**Linux 用独立预览窗口承载**（WebKitGTK 的子 webview 无法按坐标悬浮，详见「说明」一节）。
- **系统托盘** — 关闭窗口隐藏到托盘持续服务；托盘菜单（打开 / 浏览器中打开 / 退出）与单实例恢复。
- **自绘标题栏** — 支持拖拽、双击最大化，并在 Windows 11 上提供**原生磁吸布局预览**（悬停最大化按钮触发 Snap Layouts）。
- **深浅主题** — 暗色/浅色自动跟随系统，支持手动三态切换。
- **调试/正式隔离** — 调试构建使用独立 app id 与端口（6088），与正式版（3080）互不干扰。
- **自动发布** — GitHub Actions 从版本标签自动构建并发布 Windows NSIS、macOS 与 Linux（deb/rpm/AppImage）安装包。

## 🔗 相关链接

| 链接 | 说明 |
| --- | --- |
| [DeepSeek Harness 官网](https://www.deepseek.com/harness/) | 产品官网 |
| [GitHub 仓库](https://github.com/deepseek-ai/deepseek-harness) | DeepSeek Harness 官方开源仓库 |
| [开发者文档](https://deepseek-harness.github.io/deepseek-harness/guide/quickstart) | 快速上手指南 |
| [插件开发](https://deepseek-harness.github.io/deepseek-harness/develop/basic/) | 插件开发文档 |

## 🚀 快速开始

### 环境要求

- [Node.js](https://nodejs.org/) ≥ 22.19 与 [pnpm](https://pnpm.io/)
- [Rust](https://www.rust-lang.org/) 工具链（stable），Tauri 需要
- Windows 10/11、macOS，或 Linux（x86_64；Tauri v2 的 WebKitGTK 4.1 基线为 Ubuntu 22.04 / Debian 12 及以上）

> 💡 换新设备/新环境后若报 `cargo metadata ... program not found`，说明 Rust 工具链未安装。
> 构建前会先执行 `scripts/check-rust.mjs` 自检并给出安装指引（Windows 可运行
> `winget install Rustlang.Rustup` 后重开终端）。

**Linux 构建依赖**（Ubuntu / Debian 基线，其它发行版换成对应的包名）：

```bash
sudo apt install -y libwebkit2gtk-4.1-dev libgtk-3-dev \
  libayatana-appindicator3-dev librsvg2-dev patchelf file wget rpm
```

> ⚠️ `libappindicator3-dev` 与 `libayatana-appindicator3-dev` 在 Ubuntu 22.04 上**互相冲突**，
> 同时安装会让 apt 直接失败（`E: Unable to correct problems, you have held broken packages`），
> **只装 ayatana 那一个**。
>
> 构建期真正链接的是 `libwebkit2gtk-4.1`（webkit2gtk-sys）与 `libgtk-3`（gtk-sys）；AppIndicator
> 是**运行时**依赖——`libappindicator-sys` 用 `libloading` 在运行时 dlopen
> `libayatana-appindicator3.so.1`（回退 `libappindicator3.so.1`），构建期不查 pkg-config。
> `rpm` 提供 `rpmbuild`，只有需要打 `.rpm` 时才必须。

### 开发运行

```bash
pnpm install
pnpm tauri:dev        # 开发模式（Vite + Tauri），app id: com.deepseek.harness.desktop.dev
pnpm tauri:debug      # 开发模式 + RUST_BACKTRACE / WebView2 日志
```

> 开发模式下，壳层 UI 运行在 Vite dev server `http://localhost:6089`（支持浏览器预览），
> 由本应用托管的 `dsh web` 服务运行在 **6088** 端口。

### 构建打包

```bash
pnpm tauri:build               # 当前平台全量打包
pnpm tauri:build:win           # Windows NSIS 安装包（.exe）
pnpm tauri:build:mac           # macOS DMG
pnpm tauri:build:mac:app       # macOS .app
pnpm tauri:build:mac:universal # macOS 通用（universal-apple-darwin）DMG
pnpm tauri:build:linux         # Linux 三件套（.deb + .rpm + .AppImage）
pnpm tauri:build:deb           # 只打 .deb
pnpm tauri:build:appimage      # 只打 .AppImage
```

> Linux 产物落在 `src-tauri/target/release/bundle/{deb,rpm,appimage}/`。
> **务必在目标发行版的最低版本上构建**（推荐 Ubuntu 22.04）：glibc 只向下兼容，
> 在 Ubuntu 24.04 上构建的产物在 22.04 上会报 `GLIBC_x.xx not found`。CI 固定
> 用 `ubuntu-22.04` 就是这个原因。

> Windows 打包依赖离线 NSIS 工具链：`scripts/setup-nsis.mjs` 会把 `libs/` 中的
> `nsis-3.11.zip` + `nsis_tauri_utils.dll`（SHA1 校验）部署到
> `%LOCALAPPDATA%\tauri\NSIS`，构建全程不访问网络（该脚本在非 Windows 上直接跳过）。

## 🚢 发布（GitHub Actions）

推送 `v*` 标签即可自动构建并**直接发布**（非草稿）Windows / macOS 安装包：

```bash
git tag v0.1.0
git push origin v0.1.0
```

或使用一键发布脚本（自动 bump 版本 → 同步版本文件 → 提交 → 打标签 → 推送）：

```bash
pnpm release               # 自动 bump patch 并发布（0.1.0 → 0.1.1）
pnpm release 0.2.0         # 指定版本发布
pnpm release minor         # bump minor 并发布
pnpm release:tag-only      # 仅给当前版本打标签推送（不 bump）
```

流水线（`.github/workflows/release.yml`）：质量门禁（tsc + vite 构建 + Rust 测试）→ 创建**已发布**的正式 Release → 矩阵构建（Windows NSIS / macOS arm64 / macOS x64 / Linux deb+rpm+AppImage，基线 `ubuntu-22.04`）并把安装包追加到同一 Release。

另有一条 **Linux 构建验证**流水线（`.github/workflows/linux-build.yml`）：只要改动
`src-tauri/**`、`src/**` 等路径就自动跑 `cargo fmt --check` + `cargo test` + 打包，
产物只作为 Actions artifact 留存、不进 Release。它的意义是：**Linux 专用代码
（`cfg(target_os = "linux")` 分支、独立预览窗口、`/proc` 端口反查、notify-rust 通道）
只有在 Linux 上才会被编译到**，Windows/macOS 本地开发看不到这些分支的编译错误。

## 🖥 使用说明

| 页面 | 说明 |
| --- | --- |
| `/` 启动页 | 居中 logo + 环境预检卡片（Node.js / pnpm / dsh CLI 版本）+ 主按钮。已有服务运行时显示 **打开应用**，否则显示 **启动应用**（手动点击后才启动，不在进入页面时自动启动）；停止服务后回到本页。 |
| `/loading` 启动过渡页 | 所有启动/重启操作统一进入：全屏 loading 按阶段展示检测环境 → 安装依赖 → 启动服务，就绪自动进入预览页；失败给出重试 / 查看日志 / 返回启动页。 |
| `/terminal` 终端页 | 流式输出全局安装（`pnpm add -g @deepseek-ai/dsh@latest`）与 `dsh web` 启动日志；进入页面不会自动启动服务，仅查看日志。 |
| `/preview` 预览页 | 内嵌本地服务（Windows/macOS 原生子 webview 悬浮在内容区）；标题栏可刷新。**Linux**：宿主页面在**独立预览窗口**中打开，本页显示说明与「重新打开 / 在浏览器中打开」入口。服务断连时标题栏指示灯变红。 |

系统托盘（右键菜单）：**打开** 恢复窗口，**浏览器中打开** 用默认浏览器打开服务地址，**退出** 停止服务并结束进程。

## 🧱 技术栈

Tauri 2 · Rust · Vite 8 · React 19 · Ant Design 6 · React Router · Zustand

## 📁 目录结构

```
src/                前端（React + Zustand + React Router）
  pages/            Launch / Loading / Terminal / Preview
  store/            应用状态机与事件接线
  lib/tauri.ts      Tauri invoke/event 桥接
src-tauri/          Rust 后端
  src/dsh.rs        工具解析、进程管理、日志泵、URL 探测
  src/preview.rs    预览承载（Win/macOS 子 webview；Linux 独立预览窗口）
  src/session_events.rs  服务事件订阅（含 Cookie 换取）
  capabilities/     权限声明
scripts/            setup-nsis（离线 NSIS）/ sync-version / release-tag / verify-*
libs/               离线 NSIS 工具链（nsis-3.11.zip + nsis_tauri_utils.dll）
```

## 📄 说明

- `dsh web` 默认监听 `127.0.0.1:3080`（正式版）；应用通过解析其 stdout 的 `http://...` 行 + TCP 探活确认服务就绪。
- 新版宿主带进程 token 的浏览器认证（root 换 `SameSite=Strict` Cookie）在打包正式版里无法靠 DOM iframe 直接完成——壳顶层为 `tauri://localhost`，iframe 相对它是**跨站**，Strict Cookie 永不发回。因此预览一律以**顶层文档**加载宿主地址：Windows/macOS 用同窗口的原生子 webview（按内容区坐标悬浮在壳界面之上），**Linux 用独立预览窗口**——Tauri 在 Linux 把子 webview 交给窗口的 `GtkBox` 承载，wry 的坐标定位只在 `GtkFixed` 父容器里生效，无法悬浮，故改用独立窗口承载，认证与桥接语义完全相同（见 `src-tauri/src/preview.rs` 文件头）。非 Tauri 浏览器预览（开发模式顶层为 `http://localhost`）退回 iframe 直接内嵌，必要时把宿主 host 改写为 `localhost` 保持同站。
- 调试构建完全隔离：app id `com.deepseek.harness.desktop.dev`、服务端口 6088、UI 端口 6089。
- **Linux 已知差异**：① 预览在独立窗口（如上）；② 系统通知走 D-Bus（notify-rust），但**没有「打开对话」按钮**，点击通知无法直达会话（该能力依赖 Windows 的 toast 激活回调）；③ 语音播报不可用（rodio 的 Linux 后端要拉 ALSA，本期未纳入依赖，前端会自动隐藏入口）；④ Node.js 不能一键安装（装系统包需要 sudo），启动页会按发行版给出安装命令；⑤ 端口占用检查优先用 `lsof`，缺失时自动退回 `/proc` 反查（不依赖外部命令）；⑥ 托盘需要系统的 `libayatana-appindicator3-1`（.deb/.rpm 已自动声明）——**真缺了也不会启动失败**：应用会跳过托盘照常运行，此时关闭主窗口即退出（`.AppImage` 用户请自行确认装了该库）。

## 📖 其他语言

- [English README](README.en.md)
