# 托盘悬停提示（应用名称 + 服务状态）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 鼠标移入系统托盘图标时，悬浮提示显示「应用名称 + dsh web 服务运行状态」，随服务状态自动刷新。

**架构：** 改动仅 Rust 侧一个文件。新增纯函数拼文案（TDD）；setup 中计算应用名与初始提示并挂到 `TrayIconBuilder.tooltip()`；托盘构建完成后 spawn 常驻心跳线程，每秒读 `AppState` 比对文案、变化才调 `set_tooltip`。选择轮询而非在各状态变更点回调：`detected_url` 在 `dsh.rs` 有 8 处赋值点，集中轮询不侵入现有代码且对未来路径免疫。

**技术栈：** Tauri v2（tauri 2.11.x，`tray-icon` feature）、Rust 2021。

**规格：** `docs/superpowers/specs/2026-08-27-tray-tooltip-design.md`

---

## 文件结构

只修改一个文件：

- 修改：`src-tauri/src/lib.rs`
  - 新增 `tray_tooltip_text(app_name, service_url, child_running) -> String` 纯函数（文件末尾，紧邻现有托盘辅助函数 `quit_label()` 风格）及其 `#[cfg(test)]` 测试模块；
  - `setup` 闭包内三处小改：① 计算应用名与初始提示；② builder 链上加 `.tooltip(...)`；③ `tray_builder.build(app)?` 之后插入心跳线程。

不改任何 Cargo.toml（无需新依赖）、不动前端。

## 关键背景（工作者须知）

- **状态来源：** `dsh.rs` 的 `AppState` 已由 `.manage(AppState::default())` 注册（`lib.rs:163`），字段：
  - `detected_url: Mutex<Option<String>>` —— 服务探测到的 URL，`Some` 即视为运行中（与 `app_status_blocking` 的 `service_running = url.is_some()` 同口径）；
  - `child_pid: Mutex<Option<u32>>` —— dsh web 子进程句柄存在即「启动中」。
- **API 事实（已对 2.11.5 源码核实）：**
  - `TrayIconBuilder::tooltip<S: AsRef<str>>` 设初始提示；
  - `TrayIcon::set_tooltip(Option<S>) -> crate::Result<()>` 动态更新；
  - `AppHandle::tray_by_id("main-tray") -> Option<TrayIcon>` 可用（`shared_app_impl!` 宏同时生成给 App/AppHandle）；
  - `Config.product_name: Option<String>`；`package_info().name: String`。
- **调试后缀在测试里的表现：** `cargo test` 默认 debug 构建，`cfg!(debug_assertions)` 恒为 true，因此测试断言的第一行都带「（调试）」。正式构建仅少此后缀，无法在单元测试中构造，靠手动验证覆盖。
- **git 提交纪律：** 工作区可能存在与本功能无关的已修改前端文件（BottomBar.tsx 等）。每个步骤的 commit 都必须只 `git add` 明确列出的文件，禁止 `git add .` / `git add -A`。
- 所有命令都在仓库根目录 `D:\workspace\custom\deepseek-harness-desktop` 下执行。

### 任务 1：托盘文案纯函数（TDD）

**文件：**
- 修改：`src-tauri/src/lib.rs`（文件末尾，`open_service_in_browser` 函数之后新增）

- [ ] **步骤 1：编写失败的测试**

在 `src-tauri/src/lib.rs` 文件最末尾（`open_service_in_browser` 函数的结束大括号之后）只追加以下测试模块（此时 `tray_tooltip_text` 尚不存在）：

```rust
#[cfg(test)]
mod tray_tooltip_tests {
    use super::tray_tooltip_text;

    const NAME: &str = "DeepSeek Harness Desktop";

    // cargo test 默认 debug 构建，cfg!(debug_assertions) 恒真，故第一行均带「（调试）」。
    #[test]
    fn 运行中_显示服务地址() {
        assert_eq!(
            tray_tooltip_text(NAME, Some("http://127.0.0.1:3080"), true),
            format!("{NAME}（调试）\n服务运行中 · http://127.0.0.1:3080")
        );
    }

    #[test]
    fn 子进程已起但url未探测到_显示启动中() {
        assert_eq!(
            tray_tooltip_text(NAME, None, true),
            format!("{NAME}（调试）\n服务启动中…")
        );
    }

    #[test]
    fn 全部停止_显示未运行() {
        assert_eq!(
            tray_tooltip_text(NAME, None, false),
            format!("{NAME}（调试）\n服务未运行")
        );
    }
}
```

- [ ] **步骤 2：运行测试验证失败**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib tray_tooltip_tests
```

预期：编译错误 `E0425: cannot find function tray_tooltip_text in this crate`（红色信号：测试确实绑定了即将实现的符号）。

- [ ] **步骤 3：编写最少实现**

在同一文件紧贴测试模块上方追加：

```rust
/// 托盘悬浮提示文案：第一行应用名称（调试构建追加「（调试）」，与托盘菜单
/// 「退出调试」同理——调试/正式实例经 6088/3080 端口隔离可能同时驻留托盘，
/// 见 quit_label）；第二行服务运行状态。
///
/// 参数取原始标量而非 &AppState：纯数据输入便于单测，也让本函数不依赖
/// managed state 的生命周期。
fn tray_tooltip_text(app_name: &str, service_url: Option<&str>, child_running: bool) -> String {
    let name = if cfg!(debug_assertions) {
        format!("{app_name}（调试）")
    } else {
        app_name.to_string()
    };
    let status = match service_url {
        Some(url) => format!("服务运行中 · {url}"),
        None if child_running => "服务启动中…".to_string(),
        None => "服务未运行".to_string(),
    };
    format!("{name}\n{status}")
}
```

- [ ] **步骤 4：运行测试验证通过**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib tray_tooltip_tests
```

预期：`test result: ok. 3 passed; 0 failed`。

- [ ] **步骤 5：Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat: 托盘悬停提示文案纯函数与三态单元测试"
```

### 任务 2：setup 接入初始提示与心跳线程

**文件：**
- 修改：`src-tauri/src/lib.rs`（`setup` 闭包内，约 204-233 行区域）

- [ ] **步骤 1：插入应用名与初始提示计算**

定位 `lib.rs` 中 webview 构建链的结尾（当前行号约 204，特征是缩进四层的 `.build()?;`，其后紧跟空行和 `let open = MenuItem::with_id(...)`），在这两者之间插入：

```rust
            // 托盘悬浮提示第一行应用名：优先 tauri.conf.json 的 productName，
            // 回退包名。运行期不变，取一次即可。
            let app_name = app
                .config()
                .product_name
                .clone()
                .unwrap_or_else(|| app.package_info().name.clone());
            let initial_tooltip = {
                let state = app.state::<AppState>();
                let url = state.detected_url.lock().unwrap().clone();
                let child_running = state.child_pid.lock().unwrap().is_some();
                tray_tooltip_text(&app_name, url.as_deref(), child_running)
            };
```

（`Manager` trait 已在文件顶部 use 列表中，`app.config()` / `app.state::<AppState>()` 无需新增导入。）

- [ ] **步骤 2：builder 链上挂初始提示**

定位：

```rust
            let mut tray_builder = TrayIconBuilder::with_id("main-tray")
                .menu(&menu)
                .show_menu_on_left_click(false)
```

在 `.show_menu_on_left_click(false)` 之后插入一行：

```rust
                .tooltip(initial_tooltip)
```

- [ ] **步骤 3：托盘构建后插入心跳线程**

定位 `tray_builder.build(app)?;` 行，在其后、注释 `// 收养上次会话遗留的孤儿服务……` 之前插入：

```rust
            // 托盘悬浮提示心跳：每秒比对服务状态，变化才 set_tooltip（规格：
            // docs/superpowers/specs/2026-08-27-tray-tooltip-design.md）。
            // 轮询而非在 dsh.rs 各状态赋值点回调：detected_url 散布 8 处，
            // 集中轮询是唯一保证提示与服务实际状态一致的侵入式最小方案。
            let tooltip_handle = app.handle().clone();
            let tooltip_app_name = app_name.clone();
            std::thread::spawn(move || {
                let mut last = String::new();
                loop {
                    std::thread::sleep(std::time::Duration::from_secs(1));
                    let Some(state) = tooltip_handle.try_state::<AppState>() else {
                        continue;
                    };
                    let url = state.detected_url.lock().unwrap().clone();
                    let child_running = state.child_pid.lock().unwrap().is_some();
                    let text =
                        tray_tooltip_text(&tooltip_app_name, url.as_deref(), child_running);
                    if text == last {
                        continue;
                    }
                    if let Some(tray) = tooltip_handle.tray_by_id("main-tray") {
                        // 设置成功才记缓存；失败下一轮用同一文案重试
                        if tray.set_tooltip(Some(text.clone())).is_ok() {
                            last = text;
                        }
                    }
                }
            });
```

说明：变量命名刻意避开既有孤儿收养线程的 `handle`，避免遮蔽混淆；两把锁先后短暂持有即可，竞态窗口 ≤1 秒且下轮自愈。

- [ ] **步骤 4：运行全部单元测试**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

预期：`test result: ok`，原有测试与本功能的 3 个测试全绿，无编译警告（`cargo` 会把未使用变量等报出来）。

- [ ] **步骤 5：手动验证（pnpm tauri dev）**

```bash
pnpm tauri dev
```

验证清单（每项看完再进行下一项）：

1. 应用窗口出现、托盘图标就位后，鼠标悬停在托盘图标上 ≥1 秒：显示两行，第一行 `DeepSeek Harness Desktop（调试）`，第二行为「服务启动中…」或「服务运行中 · http://127.0.0.1:6088」（取决于服务是否已被探测接管）；
2. 服务就绪后再次悬停：第二行变为 `服务运行中 · <URL>`；
3. 在应用界面停止服务（底部操作区），≤1 秒后再悬停：第二行变为 `服务未运行`；
4. 从界面重新启动服务：悬停恢复「服务运行中」；
5. 托盘左键单击唤起主窗口、右键菜单「打开 / 浏览器中打开 / 退出调试」功能不受影响。

预期：5 项全部符合。若第 3 项超过 2 秒仍未刷新，检查心跳线程是否被前置步骤阻塞（`try_state` 失败 continue 路径不应长期命中）。

- [ ] **步骤 6：Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat: 托盘悬停显示应用名称与服务状态"
```
