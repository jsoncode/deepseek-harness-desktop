# DeepSeek Harness Desktop

> A lightweight desktop shell for your local **DeepSeek Harness** web service — install, launch, monitor and preview it with one click, then keep it alive in the system tray.

[![Tauri](https://img.shields.io/badge/Tauri%202-24c8db?logo=tauri&logoColor=white)](https://tauri.app)
[![React](https://img.shields.io/badge/React%2019-61dafb?logo=react&logoColor=white)](https://react.dev)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-8892b0)]()
[![Release](https://img.shields.io/github/v/release/jsoncode/deepseek-harness-desktop)](https://github.com/jsoncode/deepseek-harness-desktop/releases/latest)

![DeepSeek Harness Desktop — dark preview](docs/assets/dark.png)

📸 [See all screenshots →](docs/preview.md)

---

## 📥 Download & Install

For new users: grab the installer for your platform and double-click to install — no environment setup needed.

| Platform | Installer | Size |
| --- | --- | --- |
| Windows 10/11 (64-bit) | [Download .exe (NSIS installer)](https://github.com/jsoncode/deepseek-harness-desktop/releases/latest) | ~2.0 MB |
| macOS Apple Silicon | [Download .dmg](https://github.com/jsoncode/deepseek-harness-desktop/releases/latest) / [Download .pkg](https://github.com/jsoncode/deepseek-harness-desktop/releases/latest) | ~2.9 MB |
| macOS Intel (64-bit) | [Download .dmg](https://github.com/jsoncode/deepseek-harness-desktop/releases/latest) / [Download .pkg](https://github.com/jsoncode/deepseek-harness-desktop/releases/latest) | ~3.0 MB |
| Linux x86_64 | [Download .deb](https://github.com/jsoncode/deepseek-harness-desktop/releases/latest) / [.rpm](https://github.com/jsoncode/deepseek-harness-desktop/releases/latest) / [.AppImage](https://github.com/jsoncode/deepseek-harness-desktop/releases/latest) — see the support matrix below | ~10 MB (AppImage ~88 MB) |

> All installers are published on [GitHub Releases](https://github.com/jsoncode/deepseek-harness-desktop/releases/latest) — pick the latest release and download the package for your platform.

> **Asset naming**: `dhd_{version}_{platform}[_{compat}]_{arch}.{ext}` — `dhd` is short for DeepSeek
> Harness Desktop, stamped in by the release pipeline after bundling (Tauri hard-codes bundle names,
> there is no template hook). The short form keeps names compact and **space-free**: GitHub rewrites
> spaces in uploaded asset names to `.`, which makes the download page disagree with the local
> bundle name and forces quoting everywhere on the command line. The right download is obvious at
> a glance:
>
> ```
> dhd_1.0.5_windows_x64-setup.exe
> dhd_1.0.5_macos_arm64.dmg            / dhd_1.0.5_macos_arm64.pkg
> dhd_1.0.5_macos_x64.dmg              / dhd_1.0.5_macos_x64.pkg
> dhd_1.0.5_linux_glibc2.35_amd64.deb
> dhd_1.0.5_linux_glibc2.35_x86_64.rpm
> dhd_1.0.5_linux_glibc2.35_x86_64.AppImage
> ```
>
> > **Only the filenames changed**: the installed app, the macOS `.app`, the window title and the
> > uninstall entry are still **DeepSeek Harness Desktop**. `dhd` appears only on the installer you
> > download.
>
> The `glibc2.35` token in the Linux names is a **compatibility floor** (next section), not part of
> the version. Arch tokens: macOS `.dmg` / `.pkg` both use `arm64` / `x64` (Tauri names the dmg
> `aarch64` / `x86_64`, so the release step normalises them); Linux `.deb` uses Debian's `amd64`
> while `.rpm` / `.AppImage` use the generic `x86_64`.

### 🐧 Linux support

All three Linux packages are built on `ubuntu-22.04`, so they require **glibc ≥ 2.35** and a system
that provides **webkit2gtk-4.1**.

That is **the lowest baseline this stack can reach** (Ubuntu 20.04 only ships webkit2gtk-4.0, which
tauri v2 does not use), so there is **no per-distribution packaging** — rolling releases such as Arch
just use the AppImage:

| System | Recommended artifact |
| --- | --- |
| Ubuntu 22.04+ / Debian 12+ / Mint 21+ / Pop!_OS 22.04+ | `.deb` |
| Fedora 36+ / openSUSE Tumbleweed (rpm family — the repo must provide `webkit2gtk4.1`) | `.rpm` |
| Arch / CachyOS / Manjaro and other rolling releases | `.AppImage` (bring `webkit2gtk-4.1` + `libayatana-appindicator`) |
| ❌ RHEL / Rocky / Alma **9** (glibc 2.34), openSUSE **Leap** 15.x (2.31), Ubuntu 20.04 (no webkit2gtk-4.1) | below the floor — won't run |

> The floor is verified by the pipeline's `Verify glibc floor` step, which measures the highest
> `GLIBC_*` symbol version the binary actually references. If a baseline change ever pushes the real
> floor above `2.35`, the release fails instead of letting the filename lie.

#### Black window / won't open? (AppImage + new Mesa — known upstream issue)

**The AppImage goes black on systems with Mesa ≥ 26.1** (CachyOS / Arch / Fedora and other rolling
releases) and prints:

```
Could not create default EGL display: EGL_BAD_PARAMETER. Aborting...
```

**Root cause**: the AppImage bundles an Ubuntu-built `libwebkit2gtk-4.1.so.0` but ships **no `libEGL`
of its own** — so that WebKit runs against *your* Mesa. Mesa ≥ 26.1 rejects the way it calls
`eglGetPlatformDisplay()`, hence `EGL_BAD_PARAMETER`. The window itself is created (which is why the
main window looks black and the settings window looks white — that's just each window's background),
but the WebView never paints a single frame.

The failure is in EGL **display creation**, which happens **before** WebKit consults any rendering-path
flag. Therefore:

> ⚠️ **No environment variable fixes this black window** — `WEBKIT_DISABLE_DMABUF_RENDERER`,
> `WEBKIT_DISABLE_COMPOSITING_MODE`, `LIBGL_ALWAYS_SOFTWARE=1`, `EGL_PLATFORM=surfaceless` were all
> tested and behave identically. Don't spend time down that path.

Building **from source** on the same machine works, because your distro's WebKit was compiled against
the Mesa you actually run.

**Fixed in packaging**: from **v1.0.7** the AppImage no longer bundles WebKitGTK / GTK / GStreamer
(the release pipeline gained a `Slim the AppImage` step) and uses the **host's** stack instead — the
host's copy is by construction built against the host's Mesa. **Users do nothing**; there is no manual
step. The trade-off is that the host must provide `webkit2gtk-4.1` and `libayatana-appindicator` (the
same contract as the `.deb` / `.rpm`).

<details>
<summary>Workaround while still on v1.0.6 or older (for verification only)</summary>

⚠️ Everything below happens only inside the **AppImage's own unpacked copy**
(`~/Downloads/squashfs-root`); **nothing on your system is modified**. `rm -rf squashfs-root` undoes
it, and re-running the AppImage is unaffected.

Removing only WebKit is not enough: the system WebKit then pairs with the bundle's Ubuntu GStreamer and
fails with `undefined symbol: gst_debug_log_id` (two GStreamer builds in one process). Swap the **whole
stack**:

```bash
sudo pacman -S webkit2gtk-4.1 libayatana-appindicator     # prerequisites
./dhd_1.0.6_linux_glibc2.35_x86_64.AppImage --appimage-extract
for f in squashfs-root/usr/lib/*.so*; do
  b=$(basename "$f")
  [ -e "/usr/lib/$b" ] && rm -f "$f"
done
rm -rf squashfs-root/usr/lib/gstreamer-1.0 squashfs-root/usr/lib/webkit2gtk-4.1
./squashfs-root/AppRun
```

Another confirmed path: build from source (`pnpm install && pnpm tauri:build`).

</details>



> Upstream tauri's "truly portable appimage" fix is still open
> ([tauri#12491](https://github.com/tauri-apps/tauri/pull/12491), unmerged), so **upgrading tauri does
> not get you this fix** — it has to be handled in packaging.

<details>
<summary>Other black-window classes (only if the above doesn't match)</summary>

| Symptom / log keyword | Meaning | What to do |
| --- | --- | --- |
| Black window **but you can see the spinner and "正在启动服务…"** | WebKit is fine — the frontend bundle or the dsh service failed | App-level issue: please report with logs |
| `Failed to get GBM device` | DMA-BUF renderer | Try `WEBKIT_DISABLE_DMABUF_RENDERER=1` |
| `bwrap` / sandbox errors | WebKit sandbox can't start | Install bubblewrap (Arch: `sudo pacman -S bubblewrap`) |

</details>

> **Linux install notes**: the `.deb` / `.rpm` declare their WebKitGTK 4.1, GTK3 and tray
> (AppIndicator) dependencies, so `sudo apt install ./xxx.deb` (or
> `sudo dnf install ./xxx.rpm`) pulls everything in. The AppImage does **not** bundle
> system libraries and needs the target machine to provide them — on dpkg distros
> `sudo apt install libwebkit2gtk-4.1-0 libayatana-appindicator3-1`, on Arch
> `sudo pacman -S webkit2gtk-4.1 libayatana-appindicator`:

```bash
chmod +x dhd_x.y.z_linux_glibc2.35_x86_64.AppImage
./dhd_x.y.z_linux_glibc2.35_x86_64.AppImage
```

> 💡 **Lightweight**: sizes above are measured on v0.1.2 (Windows 2.02 MB, macOS 2.91–3.01 MB) and vary slightly per release — every installer is only 2–3 MB, so downloads and installs take seconds.

**First run (two steps)**:

1. Install [Node.js](https://nodejs.org/) ≥ 22.19 and [pnpm](https://pnpm.io/installation) — the app automatically runs `pnpm add -g @deepseek-ai/dsh@latest` to install DSH and start the local service;
2. Open the app and click **Launch App** to start the service manually (the service status page then shows environment detection / install / start progress); the service page opens automatically once it is ready.

> - On Windows, if SmartScreen warns you, choose **More info → Run anyway**.
> - On macOS, the app is not notarized: on first open go to **System Settings → Privacy & Security** and click **Open Anyway**, or right-click the app and choose **Open**.

---

## ✨ Features

- **Tiny installer** — installers are only **2–3 MB** across all platforms (~2 MB Windows NSIS, ~3 MB macOS DMG/PKG), so they download and install in seconds (vs. 100+ MB typical for Electron apps).
- **One-click setup** — automatically installs `@deepseek-ai/dsh` (pnpm global) and starts the local web service; no manual configuration.
- **pnpm compatible** — works with the pnpm 10 global layout (shims in `PNPM_HOME`). Even if `pnpm setup` was never run, it injects the bin dir into the session PATH and persists it to the user PATH, so the service starts immediately and stays installed across launches. **pnpm 11 is not supported** (dsh is incompatible with its global virtual store layout; the start chain downgrades to pnpm 10 automatically).
- **Smart service detection** — probes the default port and only trusts URLs printed by its own child process, so it never hijacks an external instance.
- **Streaming terminal** — macOS-style terminal with live install/start logs, stop/restart, and crash notifications.
- **Embedded preview** — on Windows / macOS the local DSH web UI is loaded as a native child webview floating over the content area (health polling + titlebar reload); **on Linux it opens in a standalone preview window** (WebKitGTK child webviews cannot be positioned over the shell UI — see Notes).
- **System tray** — close-to-tray, tray menu (Open / Open in Browser / Quit), single-instance window restore.
- **Custom titlebar** — drag, double-click to maximize, and native **Windows 11 Snap Layouts** (magnetic snap preview on the maximize button).
- **Themes** — dark / light, auto-follows the OS with a manual 3-state override.
- **Dev / release isolation** — debug builds use a separate app id and port (6088) so they never interfere with the release instance (3080).
- **Auto releases** — GitHub Actions builds and publishes Windows NSIS, macOS and Linux (deb / rpm / AppImage) installers from a version tag.

## 🔗 Related Links

| Link | Description |
| --- | --- |
| [DeepSeek Harness Website](https://www.deepseek.com/harness/) | Official product website |
| [GitHub Repository](https://github.com/deepseek-ai/deepseek-harness) | Official DeepSeek Harness source repository |
| [Developer Documentation](https://deepseek-harness.github.io/deepseek-harness/guide/quickstart) | Quickstart guide |
| [Plugin Development](https://deepseek-harness.github.io/deepseek-harness/develop/basic/) | Plugin development docs |

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) ≥ 22.19 and [pnpm](https://pnpm.io/)
- [Rust](https://www.rust-lang.org/) toolchain (stable) for Tauri
- Windows 10/11, macOS, or Linux (x86_64; Tauri v2's WebKitGTK 4.1 baseline is Ubuntu 22.04 / Debian 12 and newer)

**Linux build dependencies** (Ubuntu / Debian baseline; adapt package names on other distributions):

```bash
sudo apt install -y libwebkit2gtk-4.1-dev libgtk-3-dev \
  libayatana-appindicator3-dev librsvg2-dev patchelf file wget rpm
```

> ⚠️ On Ubuntu 22.04 `libappindicator3-dev` and `libayatana-appindicator3-dev` **conflict**
> with each other — installing both makes apt fail with
> `E: Unable to correct problems, you have held broken packages`. Install **only the ayatana one**.
>
> The real link-time dependencies are `libwebkit2gtk-4.1` (webkit2gtk-sys) and `libgtk-3`
> (gtk-sys); AppIndicator is a **runtime** dependency — `libappindicator-sys` dlopens
> `libayatana-appindicator3.so.1` (falling back to `libappindicator3.so.1`) via `libloading`,
> so no pkg-config lookup happens at build time. `rpm` provides `rpmbuild` and is only
> needed for `.rpm` bundles.

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
pnpm tauri:build:linux         # Linux trio (.deb + .rpm + .AppImage)
pnpm tauri:build:deb           # .deb only
pnpm tauri:build:appimage      # .AppImage only
```

> Linux bundles land in `src-tauri/target/release/bundle/{deb,rpm,appimage}/`.
> **Always build on the oldest distribution you intend to support** (Ubuntu 22.04 is the
> recommended baseline): glibc is only forward-compatible, so an artifact built on
> Ubuntu 24.04 fails on 22.04 with `GLIBC_x.xx not found`. That is why CI pins
> `ubuntu-22.04`.

> Windows packaging uses an offline NSIS toolchain: `scripts/setup-nsis.mjs` deploys
> `nsis-3.11.zip` + `nsis_tauri_utils.dll` from `libs/` (SHA1-verified) to
> `%LOCALAPPDATA%\tauri\NSIS`, so the build never needs network access (the script
> exits immediately on non-Windows platforms).

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

The pipeline (`.github/workflows/release.yml`): quality gate (tsc + vite build + Rust tests) → create a **published** GitHub Release → matrix build (Windows NSIS / macOS arm64 / macOS x64 / Linux deb+rpm+AppImage on the `ubuntu-22.04` baseline) → rename every bundle to `dhd_{version}_{platform}[_{compat}]_{arch}` via `scripts/tag-release-assets.mjs` and append it to that same release (the Linux leg first measures the highest `GLIBC_*` symbol version the binary references with `objdump` and fails if it exceeds the `glibc2.35` in the filename). Tauri hard-codes bundle filenames with no template hook, so the rename has to happen after the build and before the upload; the script writes the renamed paths to `$GITHUB_OUTPUT` and the upload steps consume that list instead of a glob, so a naming/glob drift can never silently drop an asset.

A second workflow, **Linux build** (`.github/workflows/linux-build.yml`), runs
`cargo fmt --check` + `cargo test` + bundling whenever `src-tauri/**`, `src/**` and
friends change, and uploads the bundles as Actions artifacts only (never to a release).
It exists because **Linux-only code (`cfg(target_os = "linux")` branches, the standalone
preview window, `/proc` port lookup, the notify-rust channel) is only ever compiled on
Linux** — Windows/macOS development cannot catch its compile errors.

## 🖥 Usage

| Page | Description |
| --- | --- |
| `/` Launch cover | A **purely presentational cover**: centered logo + title + gradient **Launch App** button (with a shimmer effect). It appears **only when the service is not running** — a running service goes straight to the preview page, and starting/installing goes straight to the status page. The cover takes no part in the startup flow (no environment detection, no install, no start); its button just hands the start intent to the status page. Stopping the service returns here. |
| `/loading` Service status | The **single home of the start/install/restart flow**: a full-screen loading view stepping through environment detection → dependency install → service start, then auto-entering the preview page; on failure or stop it offers retry / start / view logs. |
| `/preview` Preview | The local service loaded as a native child webview (Windows / macOS) with titlebar reload. **On Linux** the host UI opens in a standalone preview window and this page shows an explanation plus *Reopen preview window* / *Open in browser* buttons. The titlebar indicator turns red when the service disconnects. |

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
  src/preview.rs    Preview hosting (child webview on Win/macOS; standalone window on Linux)
  capabilities/     Permission declarations
scripts/            setup-nsis (offline NSIS) / sync-version / release-tag / tag-release-assets (release renaming) / verify-*
libs/               Offline NSIS toolchain (nsis-3.11.zip + nsis_tauri_utils.dll)
```

## 📄 Notes

- `dsh web` listens on `127.0.0.1:3080` by default (release); the launcher confirms readiness by parsing `http://...` lines from its stdout plus TCP probing.
- The host's newer process-token browser auth (root request exchanges for a `SameSite=Strict` cookie) cannot be completed by a DOM iframe in a packaged build: the shell origin is `tauri://localhost`, so an iframe is **cross-site** and Strict cookies are never sent back. The preview therefore always loads the host URL as a **top-level document** — a same-window native child webview on Windows/macOS (positioned over the content area), and a **standalone preview window on Linux**, where Tauri hands child webviews to the window's `GtkBox` and wry only honours coordinates inside a `GtkFixed` parent. Both paths share the same auth and bridge semantics (`src-tauri/src/preview.rs`).
- Debug builds are fully isolated: app id `com.deepseek.harness.desktop.dev`, service port 6088, UI port 6089.
- **Linux differences**: ① preview runs in a standalone window (above); ② system notifications go through D-Bus (notify-rust) but have **no "Open conversation" button** — click-through only exists on Windows' toast activation callback; ③ voice playback is unavailable (rodio's Linux backend needs ALSA, not part of this release; the UI hides the entry point); ④ Node.js cannot be installed by the app (system packages need sudo) — the start chain prints the per-distribution install command into the start log; ⑤ port-occupancy checks prefer `lsof` and fall back to a `/proc` lookup when it is missing; ⑥ the tray needs the system's `libayatana-appindicator3-1` (declared by the .deb/.rpm) — and if it really is missing the app **still starts**: it skips the tray, and closing the main window then quits the app (AppImage users should make sure that library is present).

## 📖 Readme in other languages

- [中文说明 (Chinese)](README.md)
