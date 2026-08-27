# 托盘悬停提示（应用名称）设计

- **日期：** 2026-08-27（同日修订：应用户要求去除服务状态与轮询刷新，收窄为仅显示名称）
- **状态：** 已批准（简化版）
- **技术栈：** Tauri v2（`tray-icon` feature），Rust 侧改动仅 `src-tauri/src/lib.rs`

## 目标

鼠标移入系统托盘图标时，悬浮提示显示应用名称。调试构建的应用名带「（调试）」后缀，与托盘菜单「退出调试」的区分逻辑一致。

## 需求决策记录

| 决策点 | 结论 | 依据 |
|---|---|---|
| 悬停内容 | 仅应用名称（2026-08-27 用户修订；初版"名称 + 服务状态"因状态同步机制偏重被整体撤销） | 用户指示 |
| 调试区分 | 加「（调试）」后缀 | 与 `quit_label()` 一致；调试/正式实例可能同时驻留托盘（6088/3080 端口隔离） |
| 刷新机制 | 无 | 名称在运行期不变，builder 上静态设置一次即可 |

## 提示文案

单行，远低于 Windows `NOTIFYICONDATA.szTip` 的 128 字符上限：

```
DeepSeek Harness Desktop            ← 正式构建
DeepSeek Harness Desktop（调试）     ← 调试构建
```

## 实现

改动仅 `src-tauri/src/lib.rs` 两处：

1. **纯函数**

   ```rust
   fn tray_tooltip_text(app_name: &str) -> String
   ```

   返回应用名，`cfg!(debug_assertions)` 为真时追加「（调试）」（与 `quit_label()` 同款判断）。附一条单元测试断言 debug 形态。

2. **setup 接线**

   - 应用名：`app.config().product_name.clone().unwrap_or_else(|| app.package_info().name.clone())`（`product_name` 为 `Option<String>`，回退值已是 `String`；当前解析为 "DeepSeek Harness Desktop"）。
   - `TrayIconBuilder` 链上加 `.tooltip(tray_tooltip_text(&app_name))`。仅此一次设置，无常驻线程、无锁、不触碰 `AppState`。

> **历史说明：** 提交 `5954dce` 曾交付过带服务状态的签名为 `(app_name, service_url, child_running)` 的三态版本及其三个测试；按本规格由后续提交收窄替换。

### 跨平台说明

tray-icon 在 Linux GTK 上 tooltip 为 no-op（调用安全无害）；Windows / macOS 正常显示。本项目主要面向 Windows，可接受。

## 错误处理

纯 builder 配置路径，无运行时错误分支；不引入新的锁或线程。

## 测试

1. **单元测试**：`tray_tooltip_text` 的 debug 形态（正式形态仅在 release 构建,无法在默认 `cargo test` 进程内构造，靠手动验证覆盖）。
2. **手动验证**（`pnpm tauri dev`）：悬停图标显示 `DeepSeek Harness Desktop（调试）`；托盘左键单击唤起窗口、右键菜单功能不变。
