# dsh 会话事件 → 系统推送（含语音扩展点）

## 摘要

新增一条 **Rust 主导** 的推送链路：后台线程连 `ws://127.0.0.1:<服务端口>/api/events.mux`，只挑出 `todo/write` 与 `turn/end` 两类会话事件，渲染成 `{标题}：{描述}`，用 `notify-rust` 弹带本应用 logo 的 Windows toast；渲染结果同时 `emit` 给前端，供「未来的语音播放通道」与界面消费。推送总开关放在底部导航条（默认开启）。

投递放在 Rust 而非前端的原因：应用关闭窗口后驻留托盘，webview 可能被 WebView2 节流；toast 由 Rust 直发可保证「人不在窗口前也能收到提醒」——这正是系统推送的目的。

## 关键事实（本机实测 + dsh rc.8 源码核实，工作者可直接依赖）

- **下行通道**：`ws://127.0.0.1:<port>/api/events.mux`（纯推，客户端发任何消息会被 `close(1008,"downlink only")`）；`GET /api/events.mux` 在 web 部署下返回 **426 Upgrade Required**，SSE 不可用，必须走 WS。
- **trust fence**：`isTrustedApiRequest` 只要求 `Host` 为 loopback 且（无 `Origin` 或 `Origin.host === Host`）。tungstenite 默认不发 `Origin` → 通过。已用 PowerShell `ClientWebSocket` 实测连上 3080 并收到帧。
- **帧线格式**：每条文本消息 = `{"type":"server-request","rpcId":"...","method":"<payload.type>","payload":<MuxFrame>}`。
- **MuxFrame 相关变体**：`{type:'session/event',sessionId,event:{type,seq,time,data,ignorable?}}`、`{type:'session/subscribed',sessionId,lastSeq}`、`{type:'session/projection',sessionId,key,value,seq}`。
- **事件数据**：`todo/write → {todos:[{content,status:'pending'|'in_progress'|'completed'}]}`（整表快照，last-write-wins）；`turn/end → {turn,reason:{kind:completed|aborted|blocked|error|max-tokens|interrupted}}`；`session/title → {title:string}`。会话标题另有 projection key `"title"`（`string|null`）。
- **标题基线**：`POST /api/session.list`，体 `{"type":"client-request","rpcId":"<uuid>","method":"session.list","payload":{}}`，`content-type: application/json`；响应 `result.value.items[]`，每项含 `running`、`blank`、`projections.values.title`。实测返回 246 条且 loopback 非浏览器客户端不被 403。
- **文案同源**：dsh 客户端 `progressLabel()` = 零值段省略 + `" · "` 连接，与需求文案一一对应（用户示例中「已完成」后的两个空格按 dsh 实现取 ` · `）。
- **依赖版本**（`cargo add --dry-run` 实测，受 `rust-version = 1.77.2` 封顶）：`tungstenite 0.29`（0.30 需 rustc 1.85）、`notify-rust 4.17`（4.18 需 1.89）。
- **notify-rust Windows 映射**：`summary → toast title`、`body → text2`、`image_path(p) → toast.image(p)`；`.icon()` 在 Windows 被忽略（仅 XDG `image-path`），故 logo 必须用 `image_path`；`app_id()` 是 Windows-only，不设则回退 `Toast::POWERSHELL_APP_ID`（toast 会显示成 PowerShell）——**必须显式设置**。

## Rust：依赖与打包资源

- `src-tauri/Cargo.toml`：
  ```toml
  tungstenite = { version = "0.29", default-features = false }

  [target.'cfg(windows)'.dependencies]
  notify-rust = { version = "4.17", default-features = false }
  ```
  平台限定是刻意的：notify-rust 默认特性会拉进 `zbus`/`dbus`（Linux 专用），Windows 下无需且可能编译失败。
- `src-tauri/tauri.conf.json` → `bundle` 增 `"resources": ["icons/icon.png"]`，使 logo 在运行时可按资源路径解析。

## Rust：`src-tauri/src/session_events.rs`（新建）

职责：连接生命周期 + 帧解析 + 白名单过滤 + 文案渲染 + 去重 + 投递编排。**不做**任何 UI/平台调用（交给 `notify.rs`）。

- `pub fn spawn(app: AppHandle)`：`std::thread::spawn` 跑 supervisor 循环 —— `wait_service_up()`（复用 `dsh::probe_url`，500ms 超时，1s 间隔轮询）→ `run_once()` → `sleep(2s)` → 重连。服务停止时循环自然挂起等待，无需与 `start/stop_dsh_web` 耦合。
- `fn ws_url(state: &AppState, path: &str) -> String`：优先把 `detected_url` 的 `http`→`ws`；缺省回退 `ws://127.0.0.1:{dsh::service_port()}`（dev 6088 / release 3080，端口隔离沿用现状）。
- `fn seed_titles()`：连上后先 `POST /api/session.list` 灌一次 `sessionId → title` 基线（ureq，`.set("content-type","application/json").send_string(&body)`，解析用现成的 `serde_json`）。
- 读取循环：`tungstenite::connect(url)?` → `ws.set_read_timeout(Some(Duration::from_millis(500)))` → `match ws.read()`，`Error::Io(kind == WouldBlock)` 视为「本周期无数据」继续（借此每 500ms 检查一次 `notify_enabled` 与服务状态），`Message::Text` 交给 `handle_frame`，`Message::Close`/其它错误 → 返回触发重连。**永不 `ws.write`**。
- `struct SessionNote { title: Option<String>, last: Option<TodoCounts> }` + `HashMap<String, SessionNote>`（`sessionId` 作 key，仅本进程存活期内有效，无需落盘）。
- `handle_frame(app, raw:&str, notes)`：`serde_json::Value` 宽松解析，逐级判型，**任何字段不符即静默丢弃**（不 panic、不 log 洪水）：
  - `payload.type == "session/event"` 且 `event.ignorable != true`：
    - `event.type == "todo/write"` → 计数 `(done, active, pending)`，与 `note.last` 全等则**跳过**（去重），否则渲染投递并记下新值；`todos` 为空数组 → 不推。
    - `event.type == "turn/end"` → 渲染「对话结束」投递。
    - `event.type == "session/title"` → 更新 `note.title`。
    - 其余事件类型（`assistant/chunk`、`tool/call`、`approval/*` …）→ 直接忽略，这就是需求的「过滤」。
  - `payload.type == "session/projection"` 且 `key == "title"` → 更新 `note.title`。
- 渲染（纯函数，便于单测）：
  ```rust
  pub const TITLE_TODO: &str = "更新任务清单";
  pub const TITLE_TURN_END: &str = "对话结束";
  const UNTITLED: &str = "未命名对话";

  /// 与 dsh 客户端 progressLabel 同源：零值段省略，" · " 连接
  fn todo_desc(done: u32, active: u32, pending: u32) -> String;
  fn reason_label(kind: &str) -> &'static str; // completed→"正常完成" / aborted→"已中断"
                                                  // blocked→"被阻塞" / error→"运行出错"
                                                  // "max-tokens"→"达到输出上限" / interrupted→"被重启中断"
  ```
- 负载（`Serialize` + `#[serde(rename_all = "camelCase")]`，emit 与后续语音共用）：
  ```rust
  pub struct NotifyMessage {
      pub kind: &'static str,   // "todo" | "turnEnd"
      pub session_id: String,
      pub session_title: String,
      pub title: &'static str,  // 标题（"更新任务清单" / "对话结束"）
      pub desc: String,         // 描述
      pub summary: String,      // format!("{title}：{desc}") —— 需求的 {标题}：{描述}
      pub body: String,         // todo→会话标题；turnEnd→format!("原因：{}", reason_label(..))
      pub ts: i64,
  }
  ```
  两条投递文案：
  - todo：`summary = "更新任务清单：3 已完成 · 1 进行中 · 2 待处理"`，`body = 会话标题`（多会话并发时用于区分）。
  - turnEnd：`summary = "对话结束：{会话标题} 对话已结束"`，`body = "原因：正常完成"`；标题未知取「未命名对话」。

## Rust：`src-tauri/src/notify.rs`（新建）

- `pub const APP_ID: &str = "com.deepseek.harness.desktop";`（= tauri `identifier`）。
- `pub fn logo_path(app:&AppHandle) -> Option<PathBuf>`：`app.path().resolve("icons/icon.png", BaseDirectory::Resource)`，失败回退 `Path::new(env!("CARGO_MANIFEST_DIR")).join("icons/icon.png")`（dev 态）；文件不存在返回 `None`。
- `pub fn push(app:&AppHandle, msg:&NotifyMessage)`：
  ```rust
  #[cfg(windows)]
  {
      use notify_rust::Notification;
      let mut n = Notification::new();
      n.app_id(APP_ID).summary(&msg.summary).body(&msg.body);
      if let Some(p) = logo_path(app) { n.image_path(&p.to_string_lossy()); }
      let _ = n.show(); // 投递失败静默：推送不得干扰主流程
  }
  #[cfg(not(windows))]
  { let _ = (app, msg); } // 本期非 Windows 只 emit，不弹系统通知
  ```
- `pub fn push_sample(app:&AppHandle)`：一条「系统推送：已开启，任务进展会在这里提醒你」的自检通知，供开关与验证使用。
- **通道扩展点**（语音接入位）：
  ```rust
  /// 一条通知消息的多通道投递。新增语音只需 push 一个 VoiceChannel 进 channels()，
  /// 上游（session_events）零改动。
  pub trait NotifyChannel { fn name(&self) -> &'static str; fn deliver(&self, app:&AppHandle, msg:&NotifyMessage); }
  pub struct ToastChannel;
  // 后续：VoiceChannel（Windows SAPI / 前端 speechSynthesis），本期不落实现
  ```
  `push` 内部遍历 `channels()`；`session_events` 只调 `notify::dispatch(app, &msg)`（同时 `app.emit(dsh::NOTIFY_MESSAGE_EVENT, msg)`）。

## Rust：接线

- `src-tauri/src/lib.rs`：`mod notify; mod session_events;`；`setup` 末尾（收养孤儿服务那段之后）`session_events::spawn(app.handle().clone());`。
- `src-tauri/src/dsh.rs`：
  - 事件常量区追加 `pub const NOTIFY_MESSAGE_EVENT: &str = "dsh://notify-message";`
  - `AppState` 增 `pub notify_enabled: std::sync::atomic::AtomicBool`，`Default` 里初始化为 `true`（默认始终推）。
  - 新命令并注册进 `generate_handler!`：
    ```rust
    #[tauri::command]
    pub async fn set_notify_enabled(app: AppHandle, state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
        let prev = state.notify_enabled.swap(enabled, std::sync::atomic::Ordering::SeqCst);
        if enabled && !prev { notify::push_sample(&app); } // 关→开：自检 + 让用户立刻看到效果
        Ok(())
    }
    ```
  - `run_once()` 每轮读 `state.notify_enabled`；为 false 时仍消费帧以维护标题/去重基线，但**不投递**（避免关掉再开后一次性刷屏历史）。

## 前端

- `src/lib/tauri.ts`：`EVENTS` 增 `notifyMessage: "dsh://notify-message"`；`api` 增 `setNotifyEnabled: (enabled: boolean) => requireTauri(() => invoke<void>("set_notify_enabled", { enabled }))`。
- `src/store/useNotifyStore.ts`（新建）：仿 `useThemeStore` 的 localStorage 模式，键 `hl.notify`，取值 `"on"|"off"`，默认 `"on"`；`toggle()` 内写盘并 `void api.setNotifyEnabled(next).catch(() => {})`；store 创建时用初始值调用一次同步（浏览器预览模式下由 `requireTauri` 静默 reject）。
- `src/components/NotifyToggle.tsx`（新建）：`icon-btn` + `Tooltip`（开：「系统推送：已开启（点击关闭）」/ 关：「系统推送：已关闭（点击开启）」），图标 `BellOutlined`，关闭态加 `off` class；`aria-label="系统推送开关"`。
- `src/components/BottomBar.tsx`：`<PluginManager />` 与 `<ThemeSwitch />` 之间插入 `<NotifyToggle />`。
- `src/styles/global.css`：新增 `.icon-btn.off { opacity: .45; }`（沿用现有 icon-btn 尺寸/悬停样式）。
- `src/lib/notify.ts`（新建，**语音扩展点的前端半边**）：
  ```ts
  export interface NotifyMessage { kind:"todo"|"turnEnd"; sessionId:string; sessionTitle:string;
    title:string; desc:string; summary:string; body:string; ts:number }
  export type NotifyChannel = (m: NotifyMessage) => void;
  /** 语音播放通道：本期留桩。接 Web Speech API 时在此
      speechSynthesis.speak(new Utterance(`${m.title}，${m.desc}`))；
      若隐藏窗口下不可靠，改在 Rust notify.rs 增 VoiceChannel（SAPI），上游同样零改动。 */
  const voiceChannel: NotifyChannel = () => { /* TODO(voice) */ };
  export const channels: NotifyChannel[] = [voiceChannel];
  let started = false;
  export function startNotifyListener(): void { /* onEvent(EVENTS.notifyMessage, m => channels.forEach(c => c(m)))，幂等 */ }
  ```
- `src/App.tsx`：新增 `useEffect(() => { startNotifyListener(); }, [])`。

## 文档落盘（仓库约定）

- 新建 `docs/superpowers/specs/2026-08-27-session-event-push-design.md`：事件白名单与数据形状、三条候选通道（Rust WS / iframe 注入劫持 / 监听 `~/.dsh/sessions/*.jsonl.zstd`）与选型理由、文案规则表、AUMID 与 logo 约束、语音扩展点设计。
- 新建 `docs/superpowers/plans/2026-08-27-session-event-push.md`：本计划落盘为复选框任务清单（沿用 tray-tooltip 计划的格式：目标/架构/技术栈/规格/文件结构/关键背景/任务与步骤）。

## 测试计划

Rust 单测（`#[cfg(test)] mod tests` 放在 `session_events.rs`，遵循仓库中文测试名风格）：
- `todo_desc 省略零值段并用间隔号连接`：`(3,1,2)→"3 已完成 · 1 进行中 · 2 待处理"`、`(0,1,0)→"1 进行中"`、`(0,0,0)→""`。
- `计数未变化时不重复推送`：喂两帧相同 `todo/write`，断言只 dispatch 一次。
- `解析真实 server-request 帧`：内联一段 `{"type":"server-request","rpcId":"r","method":"session/event","payload":{"type":"session/event","sessionId":"session-x","event":{"type":"todo/write","seq":7,"time":0,"data":{"todos":[...]}}}}` 字符串，断言渲染结果。
- `ignorable 事件被丢弃`、`非白名单事件不产生推送`（喂 `assistant/chunk`）。
- `turn/end 生成对话结束文案`（含 title 缺失→「未命名对话」）。
- `标题来源合并`：`session/list` 基线 → `session/title` 事件 → `session/projection(key=title)` 后者覆盖。

门槛命令（仓库根目录）：
```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib
pnpm exec tsc --noEmit
pnpm build
```

## 手动验证清单

1. `pnpm tauri dev` → 启动服务 → 底部导航条出现铃铛，Tooltip 显示「已开启」。
2. 铃铛点「关→开」→ 右下角弹出带 logo 的自检 toast「系统推送：已开启…」。
3. 在预览页里让 dsh 跑一个带任务清单的对话：清单每次净变化 → 一条 `更新任务清单：…`；本轮结束 → 一条 `对话结束：<标题> 对话已结束`。
4. 关闭窗口驻留托盘，继续第 3 步 → 仍能收到 toast（这条是「Rust 侧投递」决策的验收点）。
5. 托盘「退出」→ 服务停止 → 无新 toast、日志无重连刷屏。
6. **已安装版本**（NSIS）复跑第 2-4 步：品牌名应为「DeepSeek Harness Desktop」且带 logo。

## 假设与已知风险

- **AUMID 风险（最高）**：已核实现有开始菜单快捷方式 `DeepSeek Harness Desktop.lnk` **不含** `System.AppUserModel.ID`，HKCU 也无本应用 AUMID 注册。若验证步骤 2/6 的 toast 不出现或无品牌，按此兜底（作为独立可选项，不预先实现）：启动时用 `windows` crate 的 `IShellLinkW + IPropertyStore(PKEY_AppUserModel_ID)` 幂等创建一条带 AUMID 的开始菜单快捷方式，并在进程启动时 `SetCurrentProcessExplicitAppUserModelID(APP_ID)`。dev 态（`pnpm tauri dev`）若仍不显示属预期，以安装态为准出结论。
- 若 notify-rust `default-features = false` 在本 crate 版本上编译失败，退路是仅保留 `[target.'cfg(windows)'.dependencies]` 的默认特性集合并确认不引入 zbus。
- 假设「对话结束」= 一轮 `turn/end`（一次用户提问的收尾），而非会话永久销毁；多会话并发时每条推送都带自己的会话标题。
- 不订阅 `/api/events.host`（`host/session-status` 是「对话结束」的替代信号，本期不需要，文档中记为备选）。
- 不改 `capabilities/default.json`、不加 Tauri 通知插件：直用 notify-rust，零新增权限，符合项目「不新增权限」的既有边界。
- 工作区存在与本功能无关的未提交改动：每步 commit 只 `git add` 本任务实际改动的文件，禁止 `git add .`。
