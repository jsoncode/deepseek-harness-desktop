# 系统通知点击 → 打开对应会话对话框 设计

- **日期：** 2026-08-28
- **状态：** 已批准并已实现
- **前置：** 2026-08-27-session-event-push-design.md（会话事件 → 系统推送，已实现）
- **技术栈：** Rust 侧 `tauri-winrt-notification`（toast 激活回调）+ 注入桥脚本（iframe 内 DOM 定位）+ 前端 postMessage 转发

## 目标

用户点击系统通知（toast）后，桌面应用恢复到前台，并让 dsh web 工作区打开**该通知对应会话**的对话框（选中该会话并显示其对话）。

## 调研结论（为什么不能「调 dsh API 打开页面」）

用户最初设想：dsh 服务提供 API 打开对应页面，应用只负责 `show`。对宿主源码
（`../deepseek-harness`，只读）逐项核实后，**当前版本不存在任何此类 API**：

| 候选入口 | 核实结果 |
|---|---|
| 服务端 RPC（`@Remote` 全量枚举） | `session` 命名空间只有 list/search/create/selectModel/modelCatalog/openWorkspacePath/rename/fork/prompt/attachment/updateQueue/cancel/page/follow/control；`openWorkspacePath` 是用系统默认程序打开目录，不是 UI 导航；其余命名空间（workspace/goals/presets/subagents/…）同样无导航方法 |
| HTTP 路由 | webserver 是通用路由注册表，`/api/...` 仅承载上述 RPC 的 Fetch/WS 通道，无广播/导航端点 |
| CLI | `dsh --profile web` 只有 `--host/--port/--no-open/--trusted-host`，无 open 子命令 |
| URL 深链 | 前端导航是纯状态驱动 `sessions.open(sessionId)`（ui-workspace/src/client/navigation.ts），全仓库无 hash 路由、无 `?session=` 参数（唯一 `location.search` 读取是 fixture 测试参数） |
| window 钩子 | `ctx` 是 boot.ts 局部变量；window 上只有 `__DSH_BOOT__`（模块图）与 `__ModuleLoader__`，无控制句柄 |
| 会话行 DOM | `SessionNodeItem`（Rows.tsx）只有 role/aria/title 文本，**不含会话 id** |

→ 结论：宿主零改动前提下，只能走「注入桥脚本 + iframe 内 DOM 定位模拟点击」；
若以后 dsh 提供官方深链/API，把桥脚本收口成适配层即可切换（见「后续演进」）。

## 架构

```
Windows toast（clickable：tauri-winrt-notification）
  └─「打开对话」按钮，激活参数 = 会话 id
       │ 点击 → on_activated（非主线程）
       ├─► run_on_main_thread：恢复窗口（unminimize/show/set_focus）
       └─► emit "dsh://notify-activate" { sessionId }
              │
              ▼
  NotifyActivateHandler（前端，HashRouter 内常驻）
       ├─ 服务 running 且 url 存在才处理
       ├─ 不在 /preview → navigate("/preview")
       └─ sessionId 非空 → useUiStore.pendingOpenSession
              │
              ▼
  Preview 页：iframe onLoad 就绪后 postMessage
       └─► { "dsh-desktop:open-session": true, sessionId }
              │
              ▼
  SESSION_OPEN_BRIDGE（Rust 注入预览 iframe 的脚本）
       ├─ 轮询 [role="treeitem"] 行（8s 上限）
       ├─ 主路径：沿 React fiber（__reactFiber$* → memoizedProps.node.id）精确匹配会话 id
       ├─ 兜底：按行标题文本匹配（fiber 结构变化时）
       └─ 命中 → el.click() → sessions.open(id) → 工作区打开该会话对话框
```

## 关键决策记录

| 决策点 | 结论 | 依据 |
|---|---|---|
| toast 实现 | **两种并存，`AppState::notify_style` 切换**（0=legacy/1=clickable，默认 clickable）；设置页「消息样式」Segmented（可点击/不可点击）已接入 `set_notify_style` 命令 | 用户要求保留原 notify-rust 实现；切换只需写状态值 |
| 点击感知 | 直连 `tauri-winrt-notification`（0.7.3，MSRV 1.74）的 `add_button` + `on_activated` | notify-rust 4.17 的 Windows 后端（windows.rs::show_notification）不渲染 actions、不注册 Activated 处理器，`action()/wait_for_action` 均属 XDG/Linux 专属 |
| 激活参数 | 按钮 arguments 直接 = 会话 id；`on_activated` 收到即知目标 | 无需二次查询；toast 级 launch 参数该 fork 不支持，故正文点击为 None（只恢复窗口） |
| 窗口恢复 | 激活回调内 `run_on_main_thread` 恢复主窗口 | 托盘驻留期窗口可能隐藏；WinRT 激活事件跑在非主线程 |
| iframe 定位 | 注入桥脚本读 React fiber 拿 `memoizedProps.node.id` 精确匹配 | 会话行 DOM 无 id；标题匹配对重名/改名脆弱，fiber 匹配不受影响（React 19.2.8 版本随安装固定） |
| 行不可见时 | 轮询 8s；超时静默降级（只保留窗口聚焦） | 侧边栏折叠（COLLAPSED_SESSION_LIMIT=5）/rail 图标态等场景不强求 |
| 前端入口 | 常驻组件 `NotifyActivateHandler`（HashRouter 内）订阅 `dsh://notify-activate` | 事件可能在任意路由到达；Preview 卸载时不能丢 |

## 事件与负载

- `dsh://notify-activate`（Rust `notify::ActivatePayload` ⇄ 前端 `tauri.ts::NotifyActivatePayload`）：
  `{ sessionId: string | null }`——按钮点击带会话 id，正文点击为 null。
- postMessage（壳 → iframe）：`{ "dsh-desktop:open-session": true, sessionId }`。

## 测试

- Rust：`notify.rs` 新增 `打开按钮只在有会话时出现`（空会话不挂按钮、参数即会话 id）；
  原 `logo_文件真实存在` / `通道名不重复` 保留；`session_events` 13 个单测不受影响。
  `cargo test --lib` 共 37 项通过。
- 已知测试构建约束：`on_activated` 注册块用 `#[cfg(not(test))]` 排除——`TypedEventHandler`
  会把 tauri/tao 窗口实现链进测试二进制，本机 Windows 上测试进程加载期报 0xc0000139
  （无法启动，与代码正确性无关；桌面应用本体始终链接全套窗口代码）。点击感知需真实
  toast 激活，单测本就不可能覆盖。
- 前端：`tsc --noEmit`；无单测框架（沿用现状）。
- 手动验证清单（需打包/实机）：
  1. 服务运行中发起会话（更新任务清单/对话结束）→ 弹出带「打开对话」按钮的 toast；
  2. 点按钮 → 窗口恢复前台、切预览页、工作区选中该会话并显示对话；
  3. 点 toast 正文 → 只恢复窗口 + 回预览页，不指定会话；
  4. 开关关闭（legacy）→ toast 无按钮、点击仅系统默认行为（验证切换开关位的保留路径）。

## 风险与后续演进

- **unpackaged 激活链路**：本应用为托盘常驻（进程存活），in-process `Activated`
  应可达；若实机验证到不了，需补 COM `NotificationActivator` 注册（较重）。
- **fiber 读取**依赖 React 内部结构：dsh 升级换 React 版本可能打破 → 标题匹配兜底；
  再不行退化为「只恢复窗口」（优雅降级，不打扰）。
- **两种提示切换开关**：已接入——`set_notify_style` 命令（dsh.rs）+ 设置页「消息样式」
  Segmented（可点击/不可点击），前端 `useNotifyStore.style` 持久化到 localStorage 并同步
  Rust；切到「可点击」时补发自检通知（带「打开对话」按钮，直观展示新样式）。
- **官方深链适配**：若 dsh 未来提供「打开会话页面」的官方入口（URL/API），
  将桥脚本与前端转发收口为导航适配层，一处切换。

## 2026-08-29 实测修复：多工作区下点通知打开错会话

**现象**：a 工作区会话 1 运行中，用户切到 b 工作区会话 2 并关闭窗口（托盘驻留）；
点通知按钮后只打开 b/2（最后会话），打不开 a/1。

**根因（已用真实 3080 服务 + Playwright 实测确认）**：dsh 工作区浏览器的
`deriveGroups` 对**折叠的工作区分组输出空 `sessions`**——目标会话所在组折叠时，
其行**不在 DOM**，桥脚本轮询 `[role="treeitem"]` 找不到行、不点击，窗口恢复后
停留在最后状态。fiber 定位本身无问题（同组可见行 0ms 命中；跨组定位需先展开）。

**修复（SESSION_OPEN_BRIDGE v2，已实测通过）**：
1. **自动展开所在分组**：找不到目标行时，从任意行沿 fiber 链上溯到 SessionTree
   取 `workspaces`（会话 → 工作区映射），找到目标会话所在工作区，点击其组头
   （`onToggle` 展开）；组已展开但目标在「展开其余 N 个会话」折叠行之后时，
   点该组的溢出展开按钮。幂等（每页生命周期只试一次）。
2. **超时 8s → 20s**：覆盖托盘隐藏期间 WebView2 可能丢弃页面、恢复时 dsh 冷启动
   的耗时。
3. **ACK 回执**：桥点开成功后向壳回传 `dsh-desktop:session-open-acked`；壳在收到
   ACK 前不清除待打开状态，iframe 重载（onLoad）时重新下发同一会话（幂等），
   超过 60s 视为陈旧丢弃。覆盖「隐藏期间页面被丢弃重建、首条消息丢失」的场景。
