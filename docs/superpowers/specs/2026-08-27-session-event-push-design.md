# dsh 会话事件 → 系统推送设计

- **日期：** 2026-08-27
- **状态：** 已批准并已实现
- **技术栈：** Rust 侧 `tungstenite`（下行 WS 订阅）+ `notify-rust`（Windows toast）+ Tauri `emit`；前端 antd 铃铛开关（底部导航条）；语音播放本期留桩。

## 目标

监听 dsh 宿主的会话消息事件，把其中**需要提醒用户的两类**经系统推送告知：

1. 任务清单更新：`更新任务清单：{n} 已完成 · {n} 进行中 · {n} 待处理`
2. 一轮对话结束：`对话结束：{当前对话的标题} 对话已结束`

推送必须带本应用 logo，文案形如 `{标题}：{描述}`；并且要为**后续的语音播放**留出扩展点——事件只需解析渲染一次，多个通道共用同一份结果。

## 需求决策记录

| 决策点 | 结论 | 依据 |
|---|---|---|
| 推送范围 | 所有正在运行的会话 | 用户选择；服务端自行决定订阅集，客户端本就无法按会话收窄 |
| 前台免打扰 | 加总开关（底部导航条铃铛），**默认始终推** | 用户选择；不做「窗口聚焦时静默」的自动判断 |
| 任务清单去重 | 三个计数全等则不推 | 用户选择；`todo/write` 是整表快照，逐字段 diff 无意义 |
| 投递侧 | Rust 直发系统通知，前端只被动收 `emit` | 窗口关闭后应用驻留托盘，webview 可能被 WebView2 节流；「人不在窗口前也能收到」正是系统推送的目的 |
| 文案连接符 | 零值段省略、以 ` · ` 连接 | 与 dsh 客户端 `progressLabel()` 同源（需求原文「已完成」后的两个空格按此实现） |

## 事件白名单与数据形状

下行通道只有一条：`ws://127.0.0.1:<port>/api/events.mux`（**纯推**，客户端一发数据帧即被 `close(1008, "downlink only")`）。每条文本帧的形状固定为

```json
{"type":"server-request","rpcId":"...","method":"<payload.type>","payload":<MuxFrame>}
```

本模块关心的 `MuxFrame` 变体与事件数据（已对 dsh rc.8 源码与本机 3080 服务实测核实）：

| `payload.type` | 关心字段 | 处理 |
|---|---|---|
| `session/event` | `sessionId`, `event{type,seq,time,data,ignorable?}` | 按 `event.type` 白名单分派 |
| `session/projection` | `key == "title"` → `value: string\|null` | 更新会话标题，不推送 |
| `session/subscribed` | `lastSeq` | 忽略（新连接必然收到若干条） |

| `event.type` | `data` | 是否推送 |
|---|---|---|
| `todo/write` | `{todos:[{content,status:'pending'\|'in_progress'\|'completed'}]}`（整表快照，last-write-wins） | 推（去重后）；空数组不推 |
| `turn/end` | `{turn,reason:{kind:completed\|aborted\|blocked\|error\|max-tokens\|interrupted}}` | 推 |
| `session/title` | `{title:string}` | 只更新标题 |
| 其余（`assistant/chunk`、`tool/call`、`approval/*`、`user/message` …） | — | 忽略，**这就是需求的「过滤」** |
| 任意事件 `ignorable == true` | — | 丢弃 |

标题另有三个来源，按「晚到的基线不覆盖实时学到的值」合并：`POST /api/session.list` 连接时的 `projections.values.title`（仅作 baseline）→ `session/title` 事件 → `title` 投影，后者优先级按到达顺序覆盖。

## 架构

```
dsh web service ──ws(/api/events.mux)──► session_events.rs（后台线程）
                                            │ 订阅 / 解析 / 白名单过滤 / 去重 / 渲染
                                            ▼
                                        NotifyMessage（唯一渲染结果）
                                            │ notify::dispatch()
                          ┌─────────────────┴───────────────┐
                          ▼                                 ▼
                   ToastChannel（notify-rust）        app.emit("dsh://notify-message")
                   Windows toast + logo                        │
                                                              ▼
                                              src/lib/notify.ts → channels[]
                                                              │
                                                        voiceChannel（本期留桩）
```

- `session_events.rs`：**不做任何 UI / 平台调用**，只负责连接生命周期与文案渲染。
- `notify.rs`：投递层，`NotifyChannel` trait + 静态通道表；加语音只需 `push` 一个通道进去。
- 开关：`AppState.notify_enabled: AtomicBool`（默认 `true`）。为 `false` 时后台线程**照常消费帧**以维护标题与去重基线，只是不投递——这样「关→开」不会把积压的历史事件一次性刷屏。
- 服务未起时线程挂在探活循环（`dsh::probe_url`，500ms 超时 / 1s 间隔），因此不与 `start_dsh_web` / `stop_dsh_web` 耦合，应用启动时 spawn 一次即可。

## 文案规则表

| 场景 | `summary`（toast 标题 = 需求的 `{标题}：{描述}`） | `body`（toast 第二行） |
|---|---|---|
| 任务清单 | `更新任务清单：3 已完成 · 1 进行中 · 2 待处理` | 会话标题（多会话并发时用于区分） |
| 对话结束 | `对话结束：{会话标题} 对话已结束` | `原因：正常完成`（按 `reason.kind` 映射） |
| 开关自检 | `系统推送：已开启，任务进展会在这里提醒你` | `dsh 会话更新任务清单或结束对话时会弹出这样的通知` |

- 会话标题未知 → `未命名对话`。
- `reason.kind` 映射：`completed→正常完成`、`aborted→已中断`、`blocked→被阻塞`、`error→运行出错`、`max-tokens→达到输出上限`、`interrupted→被重启中断`、未知→`未知原因`。
- 零值段省略：`(0,1,0) → "1 进行中"`；全零 → 空串（且空清单已在更早处分支丢弃，不会出现 `更新任务清单：`）。

## 候选通道与选型

| 方案 | 做法 | 结论 |
|---|---|---|
| **A. Rust 直连 WS**（选定） | 后台线程 `tungstenite` 连 `/api/events.mux`，只读消费 | 与 webview 生命周期解耦，托盘驻留期仍能提醒；无 UI 侵入；不新增 Tauri 权限 |
| B. 注入 iframe / 前端订阅 | 在预览页里 hook 前端 WebSocket，再 `invoke` 回 Rust | 依赖 iframe 内部实现与注入时机；窗口隐藏后 WebView2 节流 → 恰好丢掉「人不在窗口前」这一核心场景 |
| C. 监听 session 日志文件 | watch `~/.dsh/sessions/*.jsonl.zstd` | 需处理 zstd 增量解压与文件写入原子性；无推送语义、延迟不可控；标题等投影信息不在事件流里 |

trust fence 已核实：`isTrustedApiRequest` 只要求 `Host` 为 loopback 且「无 `Origin` 或 `Origin.host === Host`」，tungstenite 默认不发 `Origin` → 通过（本机 PowerShell `ClientWebSocket` 与 tungstenite 均实测连上 3080 收到帧）。`GET /api/events.mux` 在 web 部署下返回 **426 Upgrade Required**，SSE 不可用，必须走 WS。

## AUMID 与 logo 约束（notify-rust 4.17，Windows）

- 映射关系：`summary → toast title`、`body → text2`、`image_path(p) → toast.image(p)`。
- **`.icon()` 在 Windows 被忽略**（仅 XDG 后端的 `image-path`），故 logo 必须走 `image_path`。
- **`app_id()` 是 Windows-only 且必须显式设置**：不设则回退 `Toast::POWERSHELL_APP_ID`，toast 会显示成「Windows PowerShell」。取 `com.deepseek.harness.desktop`，与 tauri `identifier` 一致。
- logo 文件随 bundle 走：`tauri.conf.json → bundle.resources: ["icons/icon.png"]`；`logo_path()` 依次尝试「bundle 资源 → `CARGO_MANIFEST_DIR/icons/icon.png`（dev 态）」，且必须 `is_file()` 校验——dev 态 `resolve()` 会**成功返回路径但文件不存在**。
- 依赖版本约束：`notify-rust >=4.17, <4.18`（4.18 起要求 rustc 1.89，与本 crate 声明的 MSRV 1.77.2 冲突）；`default-features = false` 是刻意的——默认特性会拉进 Linux 专用的 zbus/dbus。`tungstenite = 0.29`（0.30 需 rustc 1.85），`default-features = false, features = ["handshake"]`（本机只连 loopback 明文 ws，不需要 TLS）。
- 通知不干扰主流程：`show()` 失败仅 `eprintln!`（保留可诊断性——AUMID 未注册是 toast 不出现的首要嫌疑）。**未注册 AUMID 是本期最高风险**，兜底方案见计划文档，本期不预先实现。

## 语音扩展点

一条事件只解析渲染一次，之后是纯 fan-out：

- **Rust 半边**：`notify::NotifyChannel { name(), deliver() }`，静态表 `CHANNELS` 目前只有 `ToastChannel`；`VoiceChannel`（Windows SAPI）落地 = 实现 trait + 加进表，`session_events` 零改动。trait 需 `Sync` 超类型（通道表是 `static`，投递在后台线程）。
- **前端半边**：`src/lib/notify.ts` 的 `channels: NotifyChannel[]`，目前只有 `voiceChannel` 空实现；接 Web Speech API 即在其中朗读 `${m.title}，${m.desc}`。若隐藏窗口下 `speechSynthesis` 不可靠，改走 Rust 侧 `VoiceChannel`，上游同样零改动。
- 自检通知（`push_sample`）**不 emit**：它不是会话事件，没必要让语音通道跟着念一遍。
- 前端消费经 `App.tsx` 挂载的 `startNotifyListener()`（幂等），非 Tauri 环境（纯浏览器预览）直接跳过。

## 错误处理

- 帧解析用 `serde_json::Value` 宽松逐级判型，**任何字段不符即静默返回 `None`**：下行帧种类远多于关心的两类，逐条报错只会淹没日志。
- WS 读节拍 500ms（`TcpStream::set_read_timeout` + `tungstenite::client(url, tcp)`——0.29 的 `WebSocket` 上没有 `set_read_timeout`，必须先自建 TCP），`Error::Io(WouldBlock | TimedOut)` 视为「本周期无数据」；每 10s 借机探活，服务停止则主动断开。
- 任何连接/握手/HTTP 失败都只是 `return`，由外层 supervisor 睡 2s 重来。会话状态表（标题、上次计数）仅存活于本进程，重连后重新 `seed_titles()`。

## 测试

- Rust 单测 13 个（`session_events.rs` 11 + `notify.rs` 2），覆盖：`todo_desc` 零值省略、真实 server-request 帧解析、计数全等去重、空清单不推、`ignorable` 丢弃、非白名单事件不推、`turn/end` 文案与标题兜底、标题三来源合并、多会话互不干扰、端点解析、`session.list` 请求体信封。
- 手动验证清单见计划文档「手动验证」小节（含关窗驻留托盘、已安装 NSIS 版本复跑两个关键验收点）。
