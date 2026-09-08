# 模型代理（按提供方域名）设计

- **日期：** 2026-09-09
- **状态：** 已实现
- **技术栈：** 后端新增 `src-tauri/src/model_proxy.rs`，改动 `dsh.rs`（启动注入 / 停止回收）、`lib.rs`（命令注册）；前端 `src/lib/modelProviders.ts`、`src/lib/tauri.ts`、`src/components/settings/ProxySettings.tsx`

## 背景

宿主的模型请求由 `@deepseek-ai/dsh-http-proxy` 统一路由：`dsh` 启动器在第一个插件挂载前
从启动环境解析出**一份**策略（`http_proxy` / `https_proxy` / `no_proxy` / `all_proxy`），
装成 undici 的全局 dispatcher，按 origin 调 `proxyForUrl()` 决定走哪个代理
（`../deepseek-harness/packages/util/http-proxy/src/install.ts`、
`../deepseek-harness/apps/cli/src/profile-boot.ts:215`）。

它是「每进程一个答案」，没有按域名 / 按提供方的配置入口。模型请求最终都落在
`globalThis.fetch`（`llm-deepseek/src/adapter.ts:643` 直接 fetch；`llm-pi-ai` 适配器
从不给 pi-ai 传 `options.fetch`），因此只要控制住进程的代理环境，就能控制全部模型流量。

用户需求：**按模型提供方的域名，一条一条地决定是否启用代理**（openai + 启用代理、
xxx + 启用代理），并能看到宿主实际发出的模型请求。

## 目标

- 设置页按「提供方域名」逐条启用代理，代理地址沿用现有的「安装代理」配置。
- 未启用的域名**行为完全不变**：沿用宿主进程原本的代理环境（用户自己导出的
  `HTTPS_PROXY` 等），没有则直连。
- 能看到宿主实际访问了哪些域名、走了代理还是直连、成功还是失败。
- 不改动宿主代码、不注入宿主插件、不写宿主配置文件。

## 方案

在桌面壳内起一个**只监听 127.0.0.1 的路由代理**，启动 `dsh web` 时把
`HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 指向它；宿主启动时读到的就是它，
于是宿主的全部出站流量都经过这里，再由它逐条决定去向：

| 目标域名 | 去向 |
|---|---|
| 命中「启用代理」的规则 | 「安装代理」里配置的代理 |
| 其余域名 | 壳进程启动时捕获的原有代理环境变量；没有则直连 |
| loopback（`localhost` / `127.0.0.0/8` / `::1` / `0.0.0.0`） | 永远直连 |

只做 CONNECT / HTTP 隧道转发，**不解密 TLS**：因此只能看到域名与去向，看不到请求内容
——这也是「监听宿主内模型请求」在不 MITM 的前提下能给出的全部信息。

### 为什么不走「宿主插件」路线

宿主侧确实有注入点（web profile 是 `patchReload: live`，`$DSH_HOME/cordis.patch.yml`
与 profile 的 `cordis.patch.yml` 都被 watcher 监听，`insert` 一行即可热加载插件；
`llm/stream` waterfall 还能拿到 provider / model）。但那条路要维护一个宿主插件仓库、
跟随宿主升级，且插件必须包 `globalThis.fetch`。壳侧路由代理不需要宿主任何改动，
对任意版本的 DSH 都成立，代价是只有域名级信息、且仅对「由本应用启动的宿主」生效。

## 行为细节

1. **生效时机**：环境变量只在 `spawn` 时注入一次。因此**单条规则开关即时生效**
   （规则表在 `Arc<RwLock>` 里，代理线程每次连接都重读），而**启用 / 停用整个功能
   需要重启服务**：设置页在状态由「不需重启」变为「需重启」时弹框提示
   （「立即重启」/「稍后」），确认后只发 `request_service_restart` 请求，
   实际重启由主窗口的 `ServiceRestartHandler` 执行（复用底部导航条的同一套状态机）；
   卡片内同时保留一行常驻提示与「重启服务」按钮。
   **改「安装代理」地址不需要重启**：代理线程就地换上游（`reload_upstream`）。
2. **上游**：取自「安装代理」配置（`proxy.json`）。`http` / `https` 按明文 CONNECT 使用；
   `socks4` / `socks5` 不支持，设置页显示原因且不启用；`direct` 时同样给出原因。
3. **非命中流量**：壳进程启动时捕获 `https_proxy` → `HTTPS_PROXY` → `http_proxy` →
   `HTTP_PROXY` → `all_proxy` → `ALL_PROXY` 中第一个 `http(s)://` 值作为兜底上游；
   进程环境里都没有时再读 `$DSH_HOME/.env`（宿主启动器同样的兜底顺序），
   保证用户为 web 搜索 / MCP 配的代理不会因为本功能被悄悄降级成直连。
4. **loopback**：宿主自己的 Web UI、连接传输与本地测试服务绝不经过代理（写进注入的
   `NO_PROXY`），否则会成环。用户自己写的 `NO_PROXY` 条目一并保留，只把 `*`
   （全部直连）丢掉 —— 否则开关会变成哑的，对应语义改为「非命中流量直连」。
5. **子进程**：同时注入 `NODE_USE_ENV_PROXY=1`，让宿主派生的 Node 子进程遵循同一套变量；
   我们只写 `http://` 上游，不会触发 Node 启动期对非法 scheme 的退出。
6. **请求日志**：内存保留最近 200 条（域名 / 端口 / 去向 / 上游 / 成败 / 时间），
   不落盘；设置页在代理运行期间每 1.5s 轮询刷新。
7. **域名来源**：`$DSH_HOME/settings.yaml` 的 `llm-pi-ai.providers.<route>.baseURL`
   与 `llm-deepseek.baseURL`（缺省 `https://api.deepseek.com`）+ 代理实测见过的域名 +
   前端内置的 pi-ai 提供方目录（`src/lib/modelProviders.ts`）。
8. **添加方式**：下拉选提供方**选中即添加**（不依赖「添加」按钮）；自定义域名走右侧
   输入框 + 「添加」/ 回车。下拉刻意不控制 `searchValue`——受控搜索框会在选中后被
   antd 清空（选完即 `onSearch('')`），导致域名丢失、按钮报「请填写域名」。

## 实现

| 位置 | 内容 |
|---|---|
| `src-tauri/src/model_proxy.rs` | 规则配置（`model_proxy.json`）读写与规范化；loopback 路由代理（CONNECT + 绝对 URI 转发、双向透传、握手透传）；按域名判定去向；请求日志；提供方发现；4 个 Tauri 命令 |
| `src-tauri/src/dsh.rs` | `AppState` 增加 `model_proxy` / `model_proxy_injected`；`apply_model_proxy_env` 在 `spawn` 前注入环境变量；`stop_dsh_web` / `stop_dsh_web_sync` 回收代理 |
| `src-tauri/src/lib.rs` | 注册 `get_model_proxy_status` / `set_model_proxy_config` / `clear_model_proxy_log` / `discover_model_proxy_hosts` / `request_service_restart` |
| `src-tauri/src/proxy_config.rs` | 保存「安装代理」后就地热更新运行中的路由代理上游（不必重启） |
| `src/lib/modelProviders.ts` | pi-ai 提供方端点目录（候选行） |
| `src/lib/tauri.ts` | `ModelProxyRule` / `ModelProxyStatus` / `DiscoveredHost` 类型与 API，`restartRequest` 事件 |
| `src/components/settings/ProxySettings.tsx` | 「模型代理（按提供方）」卡片：规则表（开关 / 删除 / 最近请求）、添加提供方（下拉**选中即添加**，自定义域名走输入框 + 「添加」）、状态与上游提示、**需重启时的弹框提醒**、最近请求日志 |
| `src/components/PluginManagerPanel.tsx` | 插件安装 / 更新 / 卸载成功后弹框提示「需要重启服务才能生效」（「立即重启」/「稍后」），失败仍走 message |
| `src/components/ServiceRestartHandler.tsx` | 主窗口侧的跨窗口重启执行者：收到 `dsh://restart-request` 后走与底部导航条相同的 stop → 预置日志标题 → startFlow 流程 |

## 测试

- `cargo test --lib`：105 项通过，其中 `model_proxy` 13 项覆盖域名规范化与匹配、
  loopback 判定、请求行解析、去向判定（规则 → 兜底 → 直连）、上游 URL 解析、
  `host:port` 拆分、`.env` 兜底与 `NO_PROXY` 合并，以及三个端到端用例：
  命中规则的域名经假上游代理建隧道并留下 `via=proxy` 记录、未命中时直连并留下
  `via=direct` 记录、真实 Node（宿主同款运行时）在 `HTTP(S)_PROXY` +
  `NODE_USE_ENV_PROXY` 下经本代理发出 CONNECT 且被路由到规则上游。
- `pnpm build`（`tsc --noEmit` + `vite build`）通过。

## 相关行为：重启提醒

代理与插件都有「配置改了但进程还没重启」的窗口期，两处都给了弹框而不是一闪而过的提示：

| 场景 | 提示 | 触发时机 |
|---|---|---|
| 模型代理启用 / 停用（`restartRequired` 由 false 变 true） | 弹框「需要重启服务才能启用/停用模型代理」+ 立即重启 / 稍后 | 规则保存的返回值 |
| 安装插件 / 更新插件 / 卸载插件成功（退出码 0） | 弹框「插件已安装/更新/卸载，需要重启服务才能生效」+ 立即重启 / 稍后 | 插件操作 running → false |
| 只改「安装代理」地址 | 无弹框 | 运行中的路由代理已就地换上游 |
| 单条提供方规则开关 | 无弹框 | 规则热更新 |

设置窗口的弹框不自己重启服务，只调用 `request_service_restart` 发 `dsh://restart-request`
事件；主窗口的 `ServiceRestartHandler` 收到后执行与底部导航条完全一致的重启流程
（`stop()` → 预置「重启服务」日志标题 → `startFlow()` → 跳服务状态页），
避免两个窗口各跑一套启动状态机。

## 已知限制

- 只对**由本应用启动的宿主**生效（外部 `dsh web` 实例没有注入环境变量，设置页显示
  「宿主未接入」）。
- 只能看到域名与去向，看不到请求内容与模型 / 用量（不解密 TLS）。
- 上游不支持 SOCKS；需要 SOCKS 时请在代理软件里改用 http 端口。
- 请求日志只在内存中，应用退出即清空。
