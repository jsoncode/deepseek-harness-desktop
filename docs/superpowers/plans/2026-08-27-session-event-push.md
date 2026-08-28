# dsh 会话事件 → 系统推送实现计划（含语音扩展点）

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 后台订阅 dsh web 服务的下行 WebSocket，只挑 `todo/write` 与 `turn/end` 两类会话事件，渲染成 `{标题}：{描述}`，用 `notify-rust` 弹带本应用 logo 的 Windows toast；渲染结果同时 `emit` 给前端供界面与「未来的语音播放通道」消费。推送总开关放在底部导航条，默认开启。

**架构：** Rust 主导。`session_events.rs` 负责连接生命周期 + 帧解析 + 白名单过滤 + 去重 + 文案渲染（不碰任何 UI/平台 API），`notify.rs` 负责多通道投递（`NotifyChannel` trait + 静态通道表 + 一次 `emit`）。前端只加一个开关与一个通道消费侧留桩。

**技术栈：** Tauri v2.11.x（Rust 2021，`rust-version = 1.77.2`）、`tungstenite` 0.29、`notify-rust` 4.17（`[target.'cfg(windows)']`）、`ureq` 2、React 19 + zustand 5 + antd 6。

**规格：** `docs/superpowers/specs/2026-08-27-session-event-push-design.md`

**执行记录（2026-08-28）：** 任务 1-7 全部完成。`cargo test --manifest-path src-tauri/Cargo.toml --lib` → **20 passed / 0 failed**（既有 7 + 本次新增 13），`cargo check --lib --tests` 零警告，`cargo fmt --check` 干净；`pnpm exec tsc --noEmit` 无输出通过，`pnpm build` 通过。各任务的 Commit 步骤尚未执行（等用户确认提交切分）。手动验证清单（GUI toast / 托盘驻留 / 已安装态品牌）**尚未由用户执行**，是验收的最后一环。

---

## 文件结构

- 修改：`src-tauri/Cargo.toml` —— 新增 `tungstenite`；`[target.'cfg(windows)'.dependencies]` 新增 `notify-rust`
- 修改：`src-tauri/tauri.conf.json` —— `bundle.resources` 带上 `icons/icon.png`
- 新建：`src-tauri/src/session_events.rs` —— 订阅 / 解析 / 过滤 / 渲染 / 去重 + 单测
- 新建：`src-tauri/src/notify.rs` —— logo 解析 + `ToastChannel` + `dispatch` + `push_sample`
- 修改：`src-tauri/src/dsh.rs` —— 事件常量、`AppState.notify_enabled`、`set_notify_enabled` 命令、`service_port` 提为 `pub(crate)`
- 修改：`src-tauri/src/lib.rs` —— `mod` 声明、命令注册、`setup` 末尾 spawn
- 修改：`src/lib/tauri.ts` —— `EVENTS.notifyMessage` + `api.setNotifyEnabled`
- 新建：`src/store/useNotifyStore.ts`、`src/components/NotifyToggle.tsx`、`src/lib/notify.ts`
- 修改：`src/components/BottomBar.tsx`、`src/styles/global.css`、`src/App.tsx`

## 关键背景（工作者须知）

- **下行通道**：`ws://127.0.0.1:<port>/api/events.mux` 纯推，客户端发任何消息 → `close(1008,"downlink only")`，**永不 `ws.write`**；`GET` 同路径返回 426，SSE 不可用。
- **trust fence**：`isTrustedApiRequest` 只要求 loopback `Host` 且「无 `Origin` 或 `Origin.host === Host`」→ tungstenite 默认不发 Origin，直接通过（已实测收到帧）。
- **帧线格式**：`{"type":"server-request","rpcId":"...","method":"<payload.type>","payload":<MuxFrame>}`。
- **实测新事实**（本机 3080 / dsh rc.8）：`POST /api/session.list` 返回 `result.value.items[]`，**会话 id 字段名是 `sessionId`**（不是 `id`），标题在 `projections.values.title`；新建 WS 连接会立即收到若干 `session/subscribed`（**服务端自行决定订阅集 = 活的会话，客户端无法也不需要指定订阅范围**）。
- **API 事实（已核实源码）**：`tungstenite` 0.29 的 `Message::Text(Utf8Bytes)`（取 `&str` 用 `.as_str()`）、**`WebSocket` 上没有 `set_read_timeout`**（必须自建 `TcpStream` 后再 `tungstenite::client(url, tcp)`），`read()` 会把 `Error::Io(WouldBlock)` 透传；`tauri::path::BaseDirectory` 不在 root re-export；dev 态 `resolve()` 会成功但路径可能不存在，须 `is_file()` 校验。
- **依赖版本**：`tungstenite 0.29`（0.30 需 rustc 1.85）、`notify-rust >=4.17,<4.18`（4.18 需 1.89），均受本 crate `rust-version = 1.77.2` 封顶；`notify-rust` 平台限定 + `default-features = false` 是为了不拉进 Linux 专用的 zbus/dbus。
- **notify-rust Windows 映射**：`summary → toast title`、`body → text2`、`image_path(p) → toast.image(p)`；`.icon()` 在 Windows 被忽略，故 logo 走 `image_path`；**`app_id()` 必须显式设置**，否则回退 PowerShell AUMID。
- **git 提交纪律**：每步 commit 只 `git add` 本任务实际改动的文件，禁止 `git add .` / `git add -A`。所有命令在仓库根目录 `D:\workspace\custom\deepseek-harness-desktop` 下执行。

### 任务 1：依赖与打包资源

**文件：** `src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`

- [x] **步骤 1：加依赖**

  ```toml
  # dsh 会话事件下行订阅（/api/events.mux）。`handshake` 是 client::connect 的必需特性，
  # 显式列出只为表达「刻意不要 TLS 相关默认项」——本机只连 loopback 明文 ws。
  tungstenite = { version = "0.29", default-features = false, features = ["handshake"] }

  # 系统推送：平台限定是刻意的——notify-rust 默认特性会拉进 Linux 专用的 zbus/dbus。
  # 版本上界锁在 4.18：4.18 起要求 rustc 1.89，与本 crate 声明的 MSRV 1.77.2 冲突。
  [target.'cfg(windows)'.dependencies]
  notify-rust = { version = ">=4.17, <4.18", default-features = false }
  ```

- [x] **步骤 2：logo 随 bundle 走** —— `bundle` 段加 `"resources": ["icons/icon.png"]`
- [x] **步骤 3：验证** `cargo fetch` 成功；`cargo test --lib` 确认解析到的是 notify-rust 4.17.0（**不是** 4.18）
- [ ] **步骤 4：Commit** `git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json`

### 任务 2：`dsh.rs` 状态与开关命令

**文件：** `src-tauri/src/dsh.rs`

- [x] **步骤 1：事件常量** —— `pub const NOTIFY_MESSAGE_EVENT: &str = "dsh://notify-message";`
- [x] **步骤 2：状态** —— `AppState` 增 `pub notify_enabled: AtomicBool`，`Default` 里 `AtomicBool::new(true)`（默认始终推）
- [x] **步骤 3：命令**（定义在 `generate_handler!` 可见处，注册留给任务 4）

  ```rust
  /// 设置系统推送总开关；关→开时补一条自检通知，让用户立刻确认提醒通道可用。
  /// 异步定义（而非同步）以避开主线程：notify-rust 在 Windows 上要走 WinRT 调用。
  #[tauri::command]
  pub async fn set_notify_enabled(app: AppHandle, state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
      let prev = state.notify_enabled.swap(enabled, std::sync::atomic::Ordering::SeqCst);
      if enabled && !prev { crate::notify::push_sample(&app); }
      Ok(())
  }
  ```

- [x] **步骤 4：`service_port()` 提为 `pub(crate)`**（`session_events` 需要在缺 `detected_url` 时回退端口）
- [ ] **步骤 5：Commit** `git add src-tauri/src/dsh.rs`

### 任务 3：`notify.rs` 投递层（语音扩展点 Rust 半边）

**文件：** 新建 `src-tauri/src/notify.rs`

- [x] **步骤 1：常量与通道抽象** —— `APP_ID`（= tauri `identifier`）、`pub trait NotifyChannel: Sync { name(); deliver() }`、`ToastChannel`、`static CHANNELS: &[&dyn NotifyChannel]`。`Sync` 超类型是必需的：通道表是 `static` 而投递发生在后台线程
- [x] **步骤 2：`ToastChannel::deliver`** —— `#[cfg(windows)]` 内 `n.app_id(APP_ID).summary(&msg.summary).body(&msg.body)`，`logo_path()` 命中则 `image_path`；`show()` 失败**只 `eprintln!`**（不干扰主流程，但 AUMID 类问题必须可诊断）；`#[cfg(not(windows))]` 空实现
- [x] **步骤 3：`logo_path`** —— bundle 资源 → `CARGO_MANIFEST_DIR/icons/icon.png` 两候选，`find(|p| p.is_file())`
- [x] **步骤 4：`dispatch` / `push_sample`** —— `dispatch` 遍历通道后 `app.emit(dsh::NOTIFY_MESSAGE_EVENT, msg)`；`push_sample` 只走 toast、**不 emit**
- [x] **步骤 5：单测** —— `logo_文件真实存在`、`通道名不重复`
- [ ] **步骤 6：Commit** `git add src-tauri/src/notify.rs`

### 任务 4：`session_events.rs` 订阅与渲染

**文件：** 新建 `src-tauri/src/session_events.rs`

- [x] **步骤 1：常量与负载** —— `TITLE_TODO` / `TITLE_TURN_END` / `UNTITLED`、`KIND_*`、`MUX_PATH`、`SESSION_LIST_PATH`、`READ_TICK = 500ms`、`ALIVE_INTERVAL = 10s`、`RECONNECT_DELAY = 2s`；`NotifyMessage`（`Serialize` + `#[serde(rename_all = "camelCase")]`）
- [x] **步骤 2：supervisor** —— `spawn()` 起命名线程：`wait_service_up()`（`dsh::probe_url`）→ `run_once()` → sleep 2s → 重来；服务停止时自然挂起等待，不与 start/stop 命令耦合
- [x] **步骤 3：`run_once`** —— `Endpoint::connect_tcp()` → `tungstenite::client(url, tcp)` → `ws.get_mut().set_read_timeout(Some(READ_TICK))` → `seed_titles()` → `loop { match ws.read() }`：`Text` → `extract` → 开关为真才 `notify::dispatch`；`Close`/其它错误 → break；`Io(WouldBlock|TimedOut)` → 每 10s 探活。**永不 `ws.write`**
- [x] **步骤 4：`Endpoint`** —— `detected_url` 优先（`http`→`ws`），缺省回退 `127.0.0.1:{dsh::service_port()}`
- [x] **步骤 5：`seed_titles`** —— `POST /api/session.list`（`client-request` 信封 + `content-type: application/json`），读 `result.value.items[]` 的 `sessionId` 与 `projections.values.title`，以 `only_if_empty = true` 合并
- [x] **步骤 6：`extract` / `session_event`** —— 宽松逐级判型，字段不符即 `None`；`ignorable == true` 丢弃；`todo/write` 空数组不推、`TodoCounts` 全等去重；`turn/end` 渲染；`session/title` 与 `title` 投影只更新标题；其余事件类型即「过滤」
- [x] **步骤 7：纯函数渲染** —— `todo_desc`（零值段省略 + `" · "` 连接，与 dsh `progressLabel()` 同源）、`reason_label`、`todo_message`、`turn_end_message`
- [x] **步骤 8：11 个中文单测** —— 覆盖清单见规格「测试」小节
- [x] **步骤 9：验证** —— `cargo test --lib` 20 passed、`cargo check --lib --tests` 零警告
- [ ] **步骤 10：Commit** `git add src-tauri/src/session_events.rs`

### 任务 5：lib.rs 接线

**文件：** `src-tauri/src/lib.rs`

- [x] **步骤 1：** `mod notify; mod session_events;`
- [x] **步骤 2：** `generate_handler!` 注册 `dsh::set_notify_enabled`
- [x] **步骤 3：** `setup` 末尾（收养孤儿服务那段之后）`session_events::spawn(app.handle().clone());`

  ```rust
      // 会话事件 → 系统推送：后台线程订阅服务的下行 WebSocket。
      // 服务未起时线程挂在探活循环里，故不依赖 start/stop 命令的时机。
      session_events::spawn(app.handle().clone());
  ```

- [ ] **步骤 4：Commit** `git add src-tauri/src/lib.rs`

### 任务 6：前端开关与通道消费

**文件：** `src/lib/tauri.ts`、`src/store/useNotifyStore.ts`、`src/components/NotifyToggle.tsx`、`src/components/BottomBar.tsx`、`src/styles/global.css`、`src/lib/notify.ts`、`src/App.tsx`

- [x] **步骤 1：** `EVENTS.notifyMessage = "dsh://notify-message"`；`api.setNotifyEnabled(enabled)`
- [x] **步骤 2：** `useNotifyStore` —— 仿 `useThemeStore` 的 localStorage 模式，键 `hl.notify`，`"on"|"off"` 默认 `"on"`；`toggle()` 写盘 + `void api.setNotifyEnabled(next).catch(...)`；store 创建时用初始值同步一次（本机存 `"off"` 时一开始就压住推送）
- [x] **步骤 3：** `NotifyToggle` —— `icon-btn` + `Tooltip placement="right"` + `BellOutlined`，关闭态加 `off` class，`aria-label="系统推送开关"` / `aria-pressed`
- [x] **步骤 4：** `BottomBar` 在 `<PluginManager />` 与 `<ThemeSwitch />` 之间插入 `<NotifyToggle />`
- [x] **步骤 5：** `global.css` 加 `.icon-btn.off { opacity: 0.45; }`（仓库小数写法带前导 0）
- [x] **步骤 6：** `src/lib/notify.ts` —— `NotifyMessage` / `NotifyChannel` / `voiceChannel` 留桩 / `channels` / 幂等 `startNotifyListener()`；`App.tsx` 加 `useEffect(() => { startNotifyListener(); }, [])`
- [x] **步骤 7：验证** —— `pnpm exec tsc --noEmit` 与 `pnpm build` 均通过
- [ ] **步骤 8：Commit** `git add src/lib/tauri.ts src/lib/notify.ts src/store/useNotifyStore.ts src/components/NotifyToggle.tsx src/components/BottomBar.tsx src/styles/global.css src/App.tsx`

### 任务 7：文档落盘

- [x] **步骤 1：** 规格 `docs/superpowers/specs/2026-08-27-session-event-push-design.md`
- [x] **步骤 2：** 本计划落盘
- [ ] **步骤 3：Commit** `git add docs/superpowers/specs/2026-08-27-session-event-push-design.md docs/superpowers/plans/2026-08-27-session-event-push.md`

## 手动验证清单（待用户执行）

1. `pnpm tauri dev` → 启动服务 → 底部导航条出现铃铛，Tooltip 显示「已开启」。
2. 铃铛点「关→开」→ 右下角弹出带 logo 的自检 toast「系统推送：已开启，任务进展会在这里提醒你」。
3. 在预览页里让 dsh 跑一个带任务清单的对话：清单每次净变化 → 一条 `更新任务清单：…`；本轮结束 → 一条 `对话结束：<标题> 对话已结束`。
4. 关闭窗口驻留托盘，继续第 3 步 → 仍能收到 toast（这条是「Rust 侧投递」决策的验收点）。
5. 托盘「退出」→ 服务停止 → 无新 toast、控制台无重连刷屏。
6. **已安装版本**（NSIS）复跑第 2-4 步：品牌名应为「DeepSeek Harness Desktop」且带 logo。

## 假设与已知风险

- **AUMID 风险（最高）**：现有开始菜单快捷方式 `DeepSeek Harness Desktop.lnk` **不含** `System.AppUserModel.ID`，HKCU 亦无本应用 AUMID 注册。若验证步骤 2/6 的 toast 不出现或无品牌，兜底（独立可选项，**本期不预先实现**）：启动时用 `windows` crate 的 `IShellLinkW + IPropertyStore(PKEY_AppUserModel_ID)` 幂等创建一条带 AUMID 的开始菜单快捷方式，并在进程启动时 `SetCurrentProcessExplicitAppUserModelID(APP_ID)`。dev 态（`pnpm tauri dev`）若仍不显示属预期，以安装态为准出结论。
- 假设「对话结束」= 一轮 `turn/end`（一次用户提问的收尾），而非会话永久销毁；多会话并发时每条推送都带自己的会话标题。
- 不订阅 `/api/events.host`（`host/session-status` 是「对话结束」的替代信号，本期不需要，记为备选）。
- 不改 `capabilities/default.json`、不加 Tauri 通知插件：直用 notify-rust，零新增权限，符合项目「不新增权限」的既有边界。
- 门槛命令：`cargo test --manifest-path src-tauri/Cargo.toml --lib`、`pnpm exec tsc --noEmit`、`pnpm build`。
