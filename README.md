# DeepSeek Harness Desktop

> A lightweight desktop shell for your local **DeepSeek Harness** web service — install, launch, monitor and preview it with one click, then keep it alive in the system tray.

[![Tauri](https://img.shields.io/badge/Tauri%202-24c8db?logo=tauri&logoColor=white)](https://tauri.app)
[![React](https://img.shields.io/badge/React%2019-61dafb?logo=react&logoColor=white)](https://react.dev)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS-8892b0)]()
[![Release](https://img.shields.io/github/v/release/jsoncode/deepseek-harness-desktop)](https://github.com/jsoncode/deepseek-harness-desktop/releases/latest)

![DeepSeek Harness Desktop — dark preview](docs/assets/dark.png)

📸 [See all screenshots →](docs/preview.md)

---

## ✨ Features

- **One-click setup** — automatically installs `@deepseek-ai/dsh` (pnpm global) and starts the local web service; no manual configuration.
- **Smart service detection** — probes the default port and only trusts URLs printed by its own child process, so it never hijacks an external instance.
- **Streaming terminal** — macOS-style terminal with live install/start logs, stop/restart, and crash notifications.
- **Embedded preview** — iframe view of the local DSH web UI with health polling, reload, copy URL, and open-in-browser.
- **System tray** — close-to-tray, tray menu (Open / Open in Browser / Quit), single-instance window restore.
- **Custom titlebar** — drag, double-click to maximize, and native **Windows 11 Snap Layouts** (magnetic snap preview on the maximize button).
- **Themes** — dark / light, auto-follows the OS with a manual 3-state override.
- **Dev / release isolation** — debug builds use a separate app id and port (6088) so they never interfere with the release instance (3080).
- **Auto releases** — GitHub Actions builds and publishes Windows NSIS + macOS installers from a version tag.

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) ≥ 22.19 and [pnpm](https://pnpm.io/)
- [Rust](https://www.rust-lang.org/) toolchain (stable) for Tauri
- Windows 10/11 or macOS (Linux builds are not preconfigured)

### Run in development

```bash
pnpm install
pnpm tauri:dev        # dev mode (Vite + Tauri), app id: com.deepseek.harness.desktop.dev
pnpm tauri:debug      # dev mode with RUST_BACKTRACE + WebView2 logging
```

> In dev mode the launcher UI runs on the Vite dev server at `http://localhost:6089`
> (browser-preview friendly), while the managed `dsh web` service runs on port **6088**.

### Build

```bash
pnpm tauri:build               # full bundle for the current platform
pnpm tauri:build:win           # Windows NSIS installer (.exe)
pnpm tauri:build:mac           # macOS DMG
pnpm tauri:build:mac:app       # macOS .app
pnpm tauri:build:mac:universal # macOS universal DMG (universal-apple-darwin)
```

> Windows packaging uses an offline NSIS toolchain: `scripts/setup-nsis.mjs` deploys
> `nsis-3.11.zip` + `nsis_tauri_utils.dll` from `libs/` (SHA1-verified) to
> `%LOCALAPPDATA%\tauri\NSIS`, so the build never needs network access.

## 🚢 Release (GitHub Actions)

Push a `v*` tag to build and **publish** Windows / macOS installers automatically (not drafts):

```bash
git tag v0.1.0
git push origin v0.1.0
```

Or use the one-shot release script (bumps version → syncs files → commits → tags → pushes):

```bash
pnpm release               # bump patch and release (0.1.0 → 0.1.1)
pnpm release 0.2.0         # release a specific version
pnpm release minor         # bump minor and release
pnpm release:tag-only      # tag and push the current version only
```

The pipeline (`.github/workflows/release.yml`): quality gate (tsc + vite build + Rust tests) → create a **published** GitHub Release → matrix build (Windows NSIS / macOS arm64 / macOS x64) and append artifacts to the same release.

## 🖥 Usage

| Page | Description |
| --- | --- |
| `/` Launch | Centered logo + primary button. Shows **Open App** when a service is already running, otherwise **Launch App**. |
| `/terminal` Terminal | Streaming logs of the global install (`pnpm add -g @deepseek-ai/dsh@latest`) and `dsh web` startup; auto-navigates to the preview once the service is ready. |
| `/preview` Preview | iframe of the local service with refresh / copy URL / open in browser and a disconnected-state overlay. |

System tray (right-click): **Open** restores the window, **Open in Browser** opens the service URL in your default browser, **Quit** stops the service and exits.

## 🧱 Tech Stack

Tauri 2 · Rust · Vite 8 · React 19 · Ant Design 6 · React Router · Zustand

## 📁 Project Structure

```
src/                Frontend (React + Zustand + React Router)
  pages/            Launch / Terminal / Preview
  store/            App state machine & event wiring
  lib/tauri.ts      Tauri invoke/event bridge
src-tauri/          Rust backend
  src/dsh.rs        Tool resolution, process management, log pump, URL probing
  capabilities/     Permission declarations
scripts/            setup-nsis (offline NSIS) / sync-version / release-tag / verify-*
libs/               Offline NSIS toolchain (nsis-3.11.zip + nsis_tauri_utils.dll)
```

## 📄 Notes

- `dsh web` listens on `127.0.0.1:3080` by default (release); the launcher confirms readiness by parsing `http://...` lines from its stdout plus TCP probing.
- The preview embeds the local service via iframe; the app CSP allows `frame-src http://127.0.0.1:* http://localhost:*`.
- Debug builds are fully isolated: app id `com.deepseek.harness.desktop.dev`, service port 6088, UI port 6089.

## 📖 Readme in other languages

- [中文说明 (Chinese)](README.zh-CN.md)
