# 托盘悬停提示（应用名称）实现计划 v2

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 鼠标移入系统托盘图标时，悬浮提示显示应用名称；调试构建带「（调试）」后缀。无任何动态刷新机制。

**架构：** 一处纯函数 + setup 内一行接线。应用名从配置取一次，builder 上静态设置 tooltip，完成后即结束——无常驻线程、无状态轮询。

**技术栈：** Tauri v2（tauri 2.11.x，`tray-icon` feature）、Rust 2021。

**规格：** `docs/superpowers/specs/2026-08-27-tray-tooltip-design.md`

> **v1 → v2 变更说明：** 用户于同日要求"去掉状态同步，只保留项目名称显示"。v1 的任务 2（初始状态读取 + 每秒心跳线程 + 三态文案）整体作废；提交 `5954dce` 已交付的三态签名 `(app_name, service_url, child_running)` 函数与三个测试由本计划的任务 1 收窄替换。

**执行记录（2026-08-27）：** 步骤 1-6、8 由实现子代理完成于提交 `3f2bd64`（红：E0061 → 绿：`cargo test --lib` 7 passed, exit 0）；步骤 7 手动 GUI 验证待用户执行——悬停托盘图标应显示一行 `DeepSeek Harness Desktop（调试）`，且托盘左键/右键菜单行为不变。规格合规审查与代码质量审查均已通过。

---

## 文件结构

只修改一个文件：

- 修改：`src-tauri/src/lib.rs`
  - 文件末尾（约 304-354 行）：三态版 `tray_tooltip_text` 与测试模块 → 单参数版本与单个测试；
  - `setup` 闭包内两处小改：① 计算应用名；② builder 链上加 `.tooltip(...)`。

不改任何 Cargo.toml（无需新依赖）、不动前端、不触碰 `dsh.rs` 与 `AppState`。

## 关键背景（工作者须知）

- **API 事实（已对 tauri 2.11.5 源码核实）：**
  - `TrayIconBuilder::tooltip<S: AsRef<str>>` 设静态提示，`String` 满足约束；
  - `Config.product_name: Option<String>`；`package_info().name: String`；
  - `Manager` trait 已在 lib.rs use 列表中，`app.config()` 无需新增导入。
- **调试后缀在测试里的表现：** `cargo test` 默认 debug 构建，`cfg!(debug_assertions)` 恒真，测试断言的第一行带「（调试）」。正式形态无法在单测构造，靠手动验证覆盖。
- **git 提交纪律：** 工作区存在与本功能无关的已修改前端文件（BottomBar.tsx 等）。每步 commit 只 `git add src-tauri/src/lib.rs`，禁止 `git add .` / `git add -A`。用户已明确同意直接提交到 main。
- 所有命令都在仓库根目录 `D:\workspace\custom\deepseek-harness-desktop` 下执行。

### 任务 1：函数收窄 + setup 接线（合并实施）

**文件：**
- 修改：`src-tauri/src/lib.rs`

- [x] **步骤 1：先改测试（红）**

将文件末尾整个 `#[cfg(test)] mod tray_tooltip_tests { ... }`（当前含三个用例）替换为：

```rust
#[cfg(test)]
mod tray_tooltip_tests {
    use super::tray_tooltip_text;

    const NAME: &str = "DeepSeek Harness Desktop";

    // cargo test 默认 debug 构建，cfg!(debug_assertions) 恒真，故断言带「（调试）」。
    #[test]
    fn 调试构建返回名称加后缀() {
        assert_eq!(tray_tooltip_text(NAME), format!("{NAME}（调试）"));
    }
}
```

此时旧函数是三参签名，编译必然失败——这就是红灯。

- [x] **步骤 2：运行验证失败**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib tray_tooltip_tests
```

预期：编译错误（E0061 参数数量不符 或 E0425/E0432 符号不匹配均可接受，根因须是新测试调用了单参形式而函数尚未替换）。

- [x] **步骤 3：替换实现（绿）**

将现有三态版函数及其文档注释（以 `/// 托盘悬浮提示文案：第一行应用名称` 开头到 `}` 结束的整个 `fn tray_tooltip_text(...) -> String`）替换为：

```rust
/// 托盘悬浮提示文案：应用名称；调试构建追加「（调试）」，与托盘菜单
/// 「退出调试」同理——调试/正式实例经 6088/3080 端口隔离可能同时驻留托盘，
/// 见 quit_label。
fn tray_tooltip_text(app_name: &str) -> String {
    if cfg!(debug_assertions) {
        format!("{app_name}（调试）")
    } else {
        app_name.to_string()
    }
}
```

- [x] **步骤 4：运行验证通过**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

预期：全部通过（既有测试 + 本模块 1 个新用例），无失败。

- [x] **步骤 5：setup 接线**

定位 webview 构建链结尾 `.build()?;`（缩进四层，其后是空行和 `let open = MenuItem::with_id(...)`），在两者之间插入：

```rust
            // 托盘悬浮提示应用名：优先 tauri.conf.json 的 productName，
            // 回退包名。运行期不变，取一次即可。
            let app_name = app
                .config()
                .product_name
                .clone()
                .unwrap_or_else(|| app.package_info().name.clone());
```

再在 builder 链上：

```rust
            let mut tray_builder = TrayIconBuilder::with_id("main-tray")
                .menu(&menu)
                .show_menu_on_left_click(false)
```

`.show_menu_on_left_click(false)` 之后插入一行：

```rust
                .tooltip(tray_tooltip_text(&app_name))
```

- [x] **步骤 6：全量测试复验**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

预期：仍然全部通过、无编译警告（未使用变量等会被 cargo 报出）。

- [x] **步骤 7：手动验证（pnpm tauri dev）**

```bash
pnpm tauri dev
```

验证清单：

1. 应用窗口出现后悬停托盘图标 ≥1 秒：显示一行 `DeepSeek Harness Desktop（调试）`；
2. 无论服务运行与否该文案不变（无状态字样、无 URL）；
3. 托盘左键单击唤起主窗口、右键菜单「打开 / 浏览器中打开 / 退出调试」不受影响。

- [x] **步骤 8：Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat: 托盘悬停显示应用名称"
```
