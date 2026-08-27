# 托盘悬停提示（应用名称 + 服务状态）设计

- **日期：** 2026-08-27
- **状态：** 已批准
- **技术栈：** Tauri v2（`tray-icon` feature），Rust 侧改动仅 `src-tauri/src/lib.rs`

## 目标

鼠标移入系统托盘图标时，悬浮提示显示两行内容：第一行为应用名称，第二行为 dsh web 服务运行状态。调试构建的应用名带「（调试）」后缀，与托盘菜单「退出调试」的区分逻辑一致。

## 需求决策记录

| 决策点 | 结论 | 依据 |
|---|---|---|
| 悬停内容 | 应用名称 + 服务状态 | 用户选择 |
| 调试区分 | 加「（调试）」后缀 | 与 `quit_label()` 一致；调试/正式实例可能同时驻留托盘（6088/3080 端口隔离） |
| 状态刷新机制 | 后台心跳线程轮询（方案 A） | `detected_url` 在 dsh.rs 有 8 处赋值点，集中轮询是唯一保证一致性且不侵入现有代码的低成本方案 |

## 提示文案

两行格式，总长在 Windows `NOTIFYICONDATA.szTip` 的 128 字符上限内：

```
DeepSeek Harness Desktop            ← 第一行：应用名称
服务运行中 · http://127.0.0.1:3080   ← 第二行：服务状态
```

调试构建第一行为 `DeepSeek Harness Desktop（调试）`。

### 服务状态三态

由 `AppState` 现有字段推导，不新增状态源：

| 条件 | 第二行文案 |
|---|---|
| `detected_url = Some(url)` | `服务运行中 · {url}` |
| 无 url 且 `child_pid` 存在 | `服务启动中…` |
| 两者皆无 | `服务未运行` |

> 若 child_pid 存在但 url 也存在，命中第一行——url 是权威信号，与 `app_status_blocking` 中 `service_running = url.is_some()` 的判定一致。

## 实现

改动仅 `src-tauri/src/lib.rs`，共三部分：

1. **纯函数拼文案**

   ```rust
   fn tray_tooltip_text(app_name: &str, service_url: Option<&str>, child_running: bool) -> String
   ```

   参数取原始标量而非 `&AppState`，便于单元测试；内部用 `cfg!(debug_assertions)` 追加「（调试）」后缀（与 `quit_label()` 同款判断）。
   附带 `#[cfg(test)]` 单元测试：三态文案 + 调试/正式两种第一行。

2. **setup 初始提示**

   - 应用名：`app.config().product_name.clone().unwrap_or_else(|| app.package_info().name.clone())`（`product_name` 为 `Option<String>`，回退值已是 `String`；当前解析为 "DeepSeek Harness Desktop"）；线程启动时取一次即可，运行期不变。
   - `TrayIconBuilder` 增加 `.tooltip(初始文案)`，首帧即有内容，不等第一次心跳。

3. **心跳线程**

   setup 完成托盘构建后 spawn 常驻线程：

   - 每 1000ms 一轮；
   - `handle.try_state::<AppState>()` 取状态、读 `detected_url` / `child_pid`，调用纯函数算出新文案；
   - 与上次已设置文案比较，相同则跳过；不同才 `handle.tray_by_id("main-tray")` → `set_tooltip(Some(text))`，并更新缓存；
   - 任一前置获取失败（无状态、无托盘句柄）静默跳过本轮，下轮重试；
   - `set_tooltip` 的 `Result` 忽略——提示失败不影响任何业务功能。

### 跨平台说明

tray-icon 在 Linux GTK 上 tooltip 为 no-op（调用安全无害）；Windows / macOS 正常显示。本项目主要面向 Windows，可接受。

## 错误处理

锁的使用与现有代码风格一致（`lock().unwrap()`）；所有托盘 API 失败路径均静默降级为"不更新"，绝不影响服务启停本身。

## 测试

1. **单元测试**：`tray_tooltip_text` 三态 × 调试/正式文案组合。
2. **手动验证**（`pnpm tauri dev`）：
   - 启动后悬停图标：显示名称 + 「服务启动中…」或「服务运行中 · URL」；
   - 托盘菜单停止服务后 ≤1 秒悬停：「服务未运行」；
   - 重新启动服务后悬停恢复「运行中」。
