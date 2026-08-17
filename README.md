# Harness Launcher

一个用于展示本地 DeepSeek Harness 网页服务的桌面客户端壳子。

- **技术栈**：Tauri 2.x · Vite 8 · React 19 · Ant Design 6 · React Router · Zustand
- **功能**：启动页 → 模拟终端页（安装/启动日志流式输出）→ 内嵌预览页（iframe 展示本地服务）

## 功能说明

| 页面 | 说明 |
| --- | --- |
| `/` 启动页 | 居中 logo + 标题 "Harness Launcher" + 主按钮。已有服务运行时按钮显示 **打开应用**，否则显示 **启动应用** |
| `/terminal` 终端页 | macOS 风格模拟终端。首次使用自动 `pnpm add -g @deepseek-ai/dsh@latest` 并流式输出；随后执行 `dsh web`，日志持续展示；服务就绪后自动进入预览页 |
| `/preview` 预览页 | 工具栏（返回 / 刷新 / 复制地址 / 浏览器打开）+ iframe 内嵌本地服务页面，带加载态与服务断开提示 |

### 智能检测逻辑

- 启动时探测本地服务（默认 `127.0.0.1:3080`，兼容 `3088`），已有实例则直接"打开应用"。
- 启动流程中只认自家子进程输出提及的 URL 与默认 3080 端口，不会误把外部实例当作启动结果。
- 停止服务时按进程树 + 端口兜底清理，避免残留进程。

## 开发

```bash
pnpm install
pnpm tauri dev      # 开发模式（Vite + Tauri）
```

## 构建

```bash
pnpm tauri:build          # 当前平台全量打包（Windows 含 NSIS/MSI）
pnpm tauri:build:win      # 仅 Windows NSIS 安装包（.exe）
pnpm tauri:build:mac      # macOS DMG
pnpm tauri:build:mac:app  # macOS .app
pnpm tauri:build:mac:universal  # macOS 通用（universal-apple-darwin）DMG
```

> Windows 打包依赖 NSIS 工具链：`tauri:build` / `tauri:build:win` 会先执行
> `scripts/setup-nsis.mjs`，从仓库 `libs/`（nsis-3.11.zip + nsis_tauri_utils.dll，
> 均含 SHA1 校验）离线部署到 `%LOCALAPPDATA%\tauri\NSIS`，构建全程不访问网络。

## 发布（GitHub Release）

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

或到 Actions 页面手动运行 `Release` 工作流（workflow_dispatch），可指定版本号。

流程（`.github/workflows/release.yml`）：

1. `quality`：前端 tsc + vite 构建、Rust 单元测试通过后才继续；
2. `create-release`：解析版本号（标签 / 输入参数 / tauri.conf.json），创建**已发布**的正式 Release（重跑同 tag 时先删除旧 Release）；
3. `release` 矩阵（Windows NSIS / macOS arm64 / macOS x64）：`tauri build` 后把安装包追加到同一 Release —— 全程无草稿，无需转正步骤。

> 说明：不使用 tauri-action 直接发布多平台资产，是因为它只认草稿，遇到已发布的 Release 会丢失部分产物；改为「gh 建 Release + softprops 追加资产」的方式。

## 目录结构

```
src/                前端（React + Zustand + React Router）
  pages/            Launch / Terminal / Preview
  store/            应用状态机与事件接线
  lib/tauri.ts      Tauri invoke/event 桥接
src-tauri/          Rust 后端
  src/dsh.rs        工具解析、进程管理、日志泵、URL 探测
capabilities/       权限声明
scripts/            setup-nsis（离线 NSIS 部署）/ sync-version（版本同步）
                    release-tag（一键打标签发布）/ verify-*（CDP 验证，开发用）
libs/               NSIS 离线工具链（nsis-3.11.zip + nsis_tauri_utils.dll）
```

## 说明

- `dsh web` 默认监听 `127.0.0.1:3080`（`dsh-host-webserver` 配置），通过解析其 stdout 的 `http://...` 行 + TCP 探活来确认服务就绪。
- 预览页使用 iframe 内嵌（本地服务无 `X-Frame-Options` 限制）；应用 CSP 已放行 `frame-src http://127.0.0.1:* http://localhost:*`。
