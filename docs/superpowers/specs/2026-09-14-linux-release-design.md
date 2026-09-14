# Linux 版本发行设计（deb / rpm / AppImage）

- **日期：** 2026-09-14
- **状态：** 已实现（Windows 上完成静态验证；Linux 实机编译/打包由 CI 守卫，见「验证」）
- **改动面：** `src-tauri/src/{dsh,preview,notify}.rs`、`src-tauri/{Cargo.toml,tauri.conf.json,permissions/app-commands/default.toml}`、
  `src/{pages/Preview.tsx,lib/tauri.ts,components/settings/NotifySettings.tsx}`、
  `.github/workflows/{release.yml,linux-build.yml}`、`package.json`、README（中/英）

## 背景与目标

应用原先只发 Windows / macOS：`Cargo.toml` 里明确写着「本应用只发布 Windows / macOS 安装包，
Linux 仅用作测试机」。目标是把 Linux 变成**可发行平台**：安装包能装、主流程（环境检测 →
装 dsh → 启动服务 → 用宿主界面 → 停止/托盘/设置）能跑，并接进发布流水线。

## 调研结论（可行性）

**代码侧早就基本跨平台。** `cargo test` 一直在 ubuntu-latest 的 quality job 上跑，说明
`#[cfg(not(windows))]` 那些分支（`which`、`kill`、`lsof`、`xdg-open`、XDG 目录、`HOME`）
是真实现而非占位。真正的阻塞点是三处：**① 预览承载在 Linux 上不可用；② 打包/发布配置没有
Linux；③ 若干运行时细节在桌面发行版上会踩坑。** 逐条如下。

### ① 预览承载：Linux 不能复用「同窗口子 webview」（本设计的关键约束）

原实现（Windows/macOS）用 Tauri unstable 多 webview API 把宿主页作为**子 webview 悬浮在
内容区**上。这条路在 Linux 上不成立，证据链（全部可在依赖源码里核对）：

1. `tauri::Window::add_child` → `WebviewKind::WindowChild`；
2. `tauri-runtime-wry/src/lib.rs` 在非 win/mac 平台把 `WindowChild` 交给
   `window.default_vbox()`（`gtk::Box`）承载，注释自称 "also works for multiwebviews :)";
3. `wry/src/webkitgtk/mod.rs::add_to_container` 对 `GtkBox` 只做
   `pack_start(webview, true, true, 0)`（纵向排布）；**只有父容器是 `GtkFixed` 时才
   `fixed.put(webview, x, y)`**，并置 `is_in_fixed_parent = true`；
4. 同文件 `set_bounds` 里 `if self.is_in_fixed_parent { ... }` —— 即 GtkBox 父容器下
   **坐标/尺寸设置是空操作**。结果是子 webview 与壳页面纵向平分窗口，无法「只覆盖内容区」。

因此 Linux 改由**独立预览窗口**承载宿主页（`window_imp`）。关键点：窗口以宿主地址为
**顶层文档**加载，`SameSite=Strict` 认证链路与内嵌子 webview 完全一致（这正是当初放弃
iframe 的原因），桥接脚本与 `preview_bridge_report` 上报路径也原样复用——capability 认的是
webview label，两种承载都用 `preview` 这个名字（同一平台互斥，不会冲突）。

> 备选方案与被否原因：
> - **iframe + 反向代理**（曾用过、后被原生子 webview 取代）：要重写一个在 Rust 侧持有
>   Cookie 并注入转发请求的 nginx 式代理（含 WebSocket 与 HTML 重写），工作量大、且是在
>   已经解决问题的方向上倒退回旧架构；
> - **GtkFixed 重挂载**：`with_webview` 拿到 webkitgtk 指针后自己 reparent 进 `GtkFixed`，
>   需要引入 gtk-rs 依赖 + unsafe FFI，无 Linux 实机时不可接受；
> - **只走系统浏览器**：零风险但砍掉了「应用内看宿主界面」这一核心形态，作为兜底而非主路径。

### ② 打包依赖：Tauri 的 deb **不会**自带默认依赖

官方文档说「stock Debian package ... specifying the dependencies `libwebkit2gtk-4.1-0` and
`libgtk-3-0`」，但 `tauri-bundler/src/bundle/linux/debian.rs` 的实际实现是：

```rust
let dependencies = settings.deb().depends.as_ref().cloned().unwrap_or_default();
if !dependencies.is_empty() { writeln!(file, "Depends: {}", dependencies.join(", "))?; }
```

即 `Depends:` **只来自配置**。不显式写，装出来的包在任何系统上都声明零依赖 → 缺 WebKitGTK
的机器装完直接起不来。故在 `tauri.conf.json` 里显式声明：

| 格式 | depends |
|---|---|
| deb | `libwebkit2gtk-4.1-0`、`libgtk-3-0`、`libayatana-appindicator3-1` |
| rpm | `webkit2gtk4.1`、`gtk3`、`libayatana-appindicator-gtk3` |

AppIndicator 是托盘（`tray-icon` feature）的运行时依赖，必须带上；两个大版本包名（ayatana /
非 ayatana）在各发行版上不同，故 deb 用 ayatana 名、rpm 用 Fedora 名，构建机同时装两个 dev 包。

**AppImage 不打包系统库**（这是 AppImage 的通用限制，不是本项目问题）：目标机仍需
`libwebkit2gtk-4.1-0`，README 里已写明。

### ③ 基线版本：glibc 只向下兼容 → 固定 ubuntu-22.04

在 24.04 上构建的产物在 22.04 上会 `GLIBC_2.39 not found`。Tauri v2 的 WebKitGTK 4.1 基线
正是 Ubuntu 22.04 / Debian 12，故 CI 固定 `ubuntu-22.04`（本机若用更新的发行版打包同理）。

### ④ 运行时细节（Linux 桌面发行版特有）

| 问题 | 处理 |
|---|---|
| **GUI 进程 PATH 不含用户级目录**：`.desktop` 启动不读 `.bashrc`，而 nvm 的初始化正在 `.bashrc` 里（Debian/Ubuntu 的 `.bashrc` 对非交互 shell 直接 return），pnpm 全局 bin（`~/.local/share/pnpm`）也不在系统 PATH。→ 明明装了 node/pnpm 却判「未安装」 | `ensure_search_path()` 在 Linux 上合并①登录 shell PATH（复用 macOS 那条路径，`SHELL` 缺失时退 `/bin/bash`→`/bin/sh`）②固定目录兜底：`/usr/local/bin`、`/snap/bin`、`~/.local/bin`、`~/.npm-global/bin`、nvm 各版本 bin（按版本号新→旧）、pnpm 全局 bin；「重新检测」会重扫一次（不缓存） |
| **`lsof` 未必预装**（精简发行版/容器）→ 端口占用检查恒返回「空闲」，重复启动的 dsh web 绑定失败并原地重试，界面永远停在「启动中」 | 首选 `lsof`，无输出或命令缺失时退回 `/proc/net/tcp{,6}`（`st == 0A` 的 LISTEN 行取 socket inode）→ 遍历 `/proc/<pid>/fd` 反查持有者 pid。纯 std，无外部命令依赖 |
| **`kill -9 <pid>` 只杀一个进程**，而 dsh CLI 会派生 node 子进程（Windows 用 `taskkill /T` 才对了） | Linux 下先按 `/proc/<pid>/stat` 的 ppid 建父子表，收集全部后代、深→浅依次杀，最后杀自己 |
| **装系统包需要 sudo**，GUI 里代跑会弹提权框且各发行版命令不同 | 不做一键安装，按本机实际存在的包管理器给出命令（apt/dnf/pacman/zypper 各自提示，并优先推荐 NodeSource / nvm——发行版自带的 nodejs 常低于 dsh 要求） |

### ⑤ 功能差异（Linux 上明确不做的部分）

- **系统通知**：新增 `notify-rust`（Linux target，默认特性 = zbus 后端；zbus 5.19 本就在依赖图里
  ——`tauri-plugin-single-instance` 的 DBus 单实例，故不新增编译单元）。差异：notify-rust 的
  XDG 后端**没有激活回调**，点通知无法直达会话（Windows 走 winrt `on_activated` 才有），
  因此「带按钮」开关在非 Windows 平台直接隐藏（新增 `platform_info.notify_clickable` 能力位），
  而不是留一个点了没反应的开关。macOS 的系统通知行为不变（本期不动）。
- **语音播报**：`rodio` 的 Linux 后端要拉 `alsa-sys`（无 vendored 版本，必须系统装
  `libasound2-dev`），本期**不纳入**依赖；`voice_supported()` 仍返回 false，前端自动隐藏入口。
  后续要开：Cargo 的 rodio cfg 加 linux + CI 装 `libasound2-dev` + deb/rpm 增加 ALSA 运行时依赖。

## 实现清单

| 位置 | 内容 |
|---|---|
| `src-tauri/src/preview.rs` | 平台分派：win/mac = 内嵌子 webview；其它 = `window_imp`（独立预览窗口：开窗/导航/置前、关闭、会话桥 eval、站内导航放行 + 外链转系统浏览器、注入两个桥接脚本） |
| `src-tauri/src/dsh.rs` | `platform_info` 命令（os / previewMode / notifyClickable）；Linux PATH 兜底；`/proc` 监听者反查；后代进程树杀；node 安装指引 |
| `src-tauri/src/notify.rs` | `linux_toast`（notify-rust/D-Bus，带 image-path logo；失败只记日志） |
| `src-tauri/Cargo.toml` | `[target.'cfg(target_os = "linux")'.dependencies] notify-rust`（默认特性） |
| `src-tauri/tauri.conf.json` | `bundle.linux.{deb,rpm}.depends` |
| `src-tauri/permissions/app-commands/default.toml` | `preview_native_supported` → `platform_info`（check-acl 守卫命令表一致性） |
| `src/pages/Preview.tsx` | 探测 `previewMode`；窗口模式下的说明卡片（重新打开 / 在浏览器中打开）、刷新重导航、桥接事件与会话直达对两种承载统一 |
| `src/components/settings/NotifySettings.tsx` | 「带按钮」按 `notifyClickable` 门控 |
| `src/lib/tauri.ts` | `PlatformInfo` 类型 + `platformInfo()`；预览 API 注释更新 |
| `.github/workflows/release.yml` | 新增 `ubuntu-22.04` 矩阵（deb,rpm,appimage）+ Linux 依赖安装 + 产物上传 + Release 说明 |
| `.github/workflows/linux-build.yml` | **非发布**的 Linux 构建验证：push 即跑 `cargo fmt --check` + `cargo test` + 打包，产物只进 Actions artifact |
| `package.json` | `tauri:build:linux` / `:deb` / `:appimage` |

## 验证

本地（Windows 开发机）能做的与不能做的，以及替代手段：

1. `cargo test`（118 项）+ `pnpm build`（check-acl + tsc + vite）+ `cargo fmt --check`：全绿。
2. **Linux 分支的编译验证（关键）**：`cfg(target_os = "linux")` 的代码在 Windows 上根本不会被
   编译，所以临时把相关 cfg 翻转成「在 Windows 上也编译」（`window_imp`、`linux_toast`、
   `/proc` 三个函数、`kill_pid`/进程树分支、Unix PATH 三个函数与两处调用点），跑 `cargo check`
   逐个过类型检查——**这一步真的抓到过一个 bug**（`linux_extra_path_dirs` 里 nvm 版本排序的
   `unwrap_or_default()` 临时值被 `&str` 借用，E0716），修好后 0 error。事后已把全部 cfg 翻回，
  并用 `git diff --no-index` 逐字节比对确认只留下那处修复。
3. **真正的验收在 CI**：`linux-build.yml` 会在 Linux 上编译 + 跑测试 + 打三种包。任何 Linux
   专属代码的编译错误都会在这里暴露（这也是新增这条流水线的唯一理由）。
4. 仍需**人工实机**确认的：托盘图标在 GNOME/KDE 上的显示（需要 AppIndicator 扩展）、
   独立预览窗口的观感、D-Bus 通知是否出现在通知中心、`lsof` 缺失时的端口回收路径。

## 后续可做（本期未做）

- 语音播报上 Linux（见 ⑤，需要 ALSA 依赖 + CI 装机包）。
- macOS 也接上 notify-rust（当前 macOS 完全没有系统通知，属于既有差距，与本次改动无关）。
- Linux 的 `.desktop` 里补 `StartupWMClass` / 图标主题名，让任务栏归类更准。
- AppImage 打包 `webkitextras`/自带 WebKit（体积代价大，社区通行做法仍是依赖发行版）。
- 独立预览窗口的「跟随主窗口置顶/最小化」等窗口联动细节。
