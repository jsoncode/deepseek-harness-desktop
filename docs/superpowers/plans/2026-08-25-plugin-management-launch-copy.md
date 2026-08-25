# 插件管理 + 文案精简 + 启动链路插件安装 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 精简启动页文案；读取并展示 `%USERPROFILE%\.dsh\profiles\web\package.json` 的用户插件列表（可移除）；启动 dsh web 前自动在插件目录执行 `pnpm install`。

**架构：** 后端新增 profile 读取（StatusPayload 增 `plugins`/`profile_ready`）、`remove_plugin` 与 `install_plugins` 命令及独立事件对；前端沿用 install_dsh 的流式日志模式，`startFlow` 编排为 装 dsh → 装插件 → 启动 三段式。

**技术栈：** Tauri 2 / Rust（serde_json preserve_order）、React 19 + zustand、antd 6 modal。

**测试说明：** 项目无测试框架，验证为 `cargo check` + `pnpm build` + tauri:dev 手动清单。

**规格：** `docs/superpowers/specs/2026-08-25-plugin-management-launch-copy-design.md`

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `src-tauri/Cargo.toml` | 修改 | serde_json 启用 preserve_order |
| `src-tauri/src/dsh.rs` | 修改 | profile_dir/read_profile_plugins/remove_plugin/install_plugins；StatusPayload 扩展 |
| `src-tauri/src/lib.rs` | 修改 | 注册两个新命令 |
| `src/lib/tauri.ts` | 修改 | 新事件、新 api、StatusPayload 接口扩展 |
| `src/store/useAppStore.ts` | 修改 | plugins/profileReady 状态；ensurePluginsThenStart 编排 |
| `src/pages/Launch.tsx` | 修改 | 文案精简；Plugins 小节与移除确认 |
| `src/styles/global.css` | 修改 | 删 subtitle/footer/env-chip 样式；增插件小节样式 |

---

### 任务 1：后端 profile 读取与 remove_plugin

**文件：**
- 修改：`src-tauri/Cargo.toml:21`
- 修改：`src-tauri/src/dsh.rs`
- 修改：`src-tauri/src/lib.rs:70-77`

- [ ] **步骤 1.1：Cargo.toml 启用 preserve_order**

将 `serde_json = "1"` 改为：

```toml
serde_json = { version = "1", features = ["preserve_order"] }
```

- [ ] **步骤 1.2：dsh.rs 新增三个函数（放在 `open_in_browser` 命令之后）**

```rust
// ---------------------------------------------------------------------------
// dsh profile 插件管理（%USERPROFILE%\.dsh\profiles\web\package.json）
// ---------------------------------------------------------------------------

/// 用户 dsh profile 目录（%USERPROFILE%\.dsh\profiles\web），不存在时 None
fn profile_dir() -> Option<PathBuf> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    let dir = PathBuf::from(home).join(".dsh").join("profiles").join("web");
    dir.is_dir().then_some(dir)
}

fn profile_package_json() -> Option<PathBuf> {
    profile_dir().map(|d| d.join("package.json"))
}

/// 读取插件列表：按 bundles 数组顺序过滤出存在于 dependencies 中的名字。
/// 返回 (package.json 存在且可解析, 插件名列表)；文件缺失/解析失败均为 (false, [])
fn read_profile_plugins() -> (bool, Vec<String>) {
    let Some(path) = profile_package_json() else {
        return (false, Vec::new());
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return (false, Vec::new());
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return (false, Vec::new());
    };
    let deps = v.get("dependencies").and_then(|d| d.as_object());
    let bundles = v
        .get("dsh")
        .and_then(|d| d.get("profile"))
        .and_then(|p| p.get("bundles"))
        .and_then(|b| b.as_array());
    let mut plugins = Vec::new();
    if let (Some(deps), Some(bundles)) = (deps, bundles) {
        for b in bundles {
            if let Some(name) = b.as_str() {
                if deps.contains_key(name) && !plugins.iter().any(|p| p == name) {
                    plugins.push(name.to_string());
                }
            }
        }
    }
    (true, plugins)
}

/// 从 profile package.json 移除插件：同时删除 bundles 数组项与 dependencies 键，
/// 写回时保持键顺序（preserve_order）与两空格缩进
#[tauri::command]
pub fn remove_plugin(name: String) -> Result<(), String> {
    let path =
        profile_package_json().ok_or("未找到插件目录（%USERPROFILE%\\.dsh\\profiles\\web）")?;
    let text = std::fs::read_to_string(&path).map_err(|e| format!("读取 package.json 失败: {e}"))?;
    let mut v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("package.json 解析失败: {e}"))?;

    let in_deps = v
        .get_mut("dependencies")
        .and_then(|d| d.as_object_mut())
        .map(|o| o.remove(&name).is_some())
        .unwrap_or(false);
    let mut in_bundles = false;
    if let Some(arr) = v
        .get_mut("dsh")
        .and_then(|d| d.get_mut("profile"))
        .and_then(|p| p.get_mut("bundles"))
        .and_then(|b| b.as_array_mut())
    {
        let before = arr.len();
        arr.retain(|x| x.as_str() != Some(name.as_str()));
        in_bundles = arr.len() != before;
    }

    if !in_deps && !in_bundles {
        return Err(format!("插件 {name} 不在 package.json 中"));
    }

    let out = serde_json::to_string_pretty(&v).map_err(|e| format!("序列化失败: {e}"))?;
    std::fs::write(&path, out + "\n").map_err(|e| format!("写回 package.json 失败: {e}"))?;
    Ok(())
}
```

- [ ] **步骤 1.3：StatusPayload 扩展与 app_status 填充**

结构体追加两个字段（`pnpm_version` 之后）：

```rust
    pub plugins: Vec<String>,
    pub profile_ready: bool,
```

`app_status` 中 `let node_path = ...` 之后加：

```rust
    let (profile_ready, plugins) = read_profile_plugins();
```

构造处追加：

```rust
        plugins,
        profile_ready,
```

- [ ] **步骤 1.4：lib.rs 注册命令**

generate_handler 数组中 `dsh::open_in_browser,` 后加一行：

```rust
            dsh::remove_plugin,
```

- [ ] **步骤 1.5：验证 + Commit**

运行 `cargo check --manifest-path src-tauri/Cargo.toml`（预期 exit=0）。

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/dsh.rs src-tauri/src/lib.rs
git commit -m "feat(backend): 读取 profile 插件列表并支持移除（任务 1/5）"
```

---

### 任务 2：后端 install_plugins 命令

**文件：**
- 修改：`src-tauri/src/dsh.rs`（事件常量区约 15-19 行；命令区）
- 修改：`src-tauri/src/lib.rs`

- [ ] **步骤 2.1：事件常量**

在 `URL_EVENT` 后加：

```rust
pub const PLUGIN_INSTALL_LOG_EVENT: &str = "dsh://plugin-install-log";
pub const PLUGIN_INSTALL_EXIT_EVENT: &str = "dsh://plugin-install-exit";
```

- [ ] **步骤 2.2：命令实现（放 remove_plugin 之后）**

```rust
/// 在 profile 目录执行 pnpm install（幂等，无变化秒级完成）；
/// 目录或 package.json 不存在时直接成功（首次运行尚未生成 profile）。
/// 输出经 plugin-install-log 流式转发，退出码经 plugin-install-exit 通知前端续接。
#[tauri::command]
pub fn install_plugins(app: AppHandle) -> Result<(), String> {
    let Some(dir) = profile_dir() else {
        return Ok(());
    };
    if !dir.join("package.json").is_file() {
        return Ok(());
    }
    let pnpm = resolve_pnpm().ok_or("未找到 pnpm，请先安装 pnpm（https://pnpm.io/zh-CN/installation）")?;
    emit_log(
        &app,
        PLUGIN_INSTALL_LOG_EVENT,
        "system",
        &format!("$ pnpm install（{}）", dir.display()),
    );
    let child = hide_window(
        Command::new(&pnpm)
            .arg("install")
            .current_dir(&dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null()),
    )
    .spawn()
    .map_err(|e| format!("启动 pnpm install 失败: {e}"))?;
    let app2 = app.clone();
    std::thread::spawn(move || {
        pump_process(&app2, child, PLUGIN_INSTALL_LOG_EVENT, PLUGIN_INSTALL_EXIT_EVENT);
    });
    Ok(())
}
```

- [ ] **步骤 2.3：lib.rs 注册**

generate_handler 中再加一行：

```rust
            dsh::install_plugins,
```

- [ ] **步骤 2.4：验证 + Commit**

`cargo check` exit=0 后：

```bash
git add src-tauri/src/dsh.rs src-tauri/src/lib.rs
git commit -m "feat(backend): 启动前对插件目录执行 pnpm install（任务 2/5）"
```

---

### 任务 3：前端桥接层与启动编排

**文件：**
- 修改：`src/lib/tauri.ts`（EVENTS 约 33-39 行；StatusPayload；api 约 50-57 行）
- 修改：`src/store/useAppStore.ts`

- [ ] **步骤 3.1：tauri.ts 三处扩展**

EVENTS 追加：

```ts
  pluginInstallLog: "dsh://plugin-install-log",
  pluginInstallExit: "dsh://plugin-install-exit",
```

StatusPayload 追加：

```ts
  plugins: string[];
  profile_ready: boolean;
```

api 追加：

```ts
  removePlugin: (name: string) => requireTauri(() => invoke<void>("remove_plugin", { name })),
  installPlugins: () => requireTauri(() => invoke<void>("install_plugins")),
```

- [ ] **步骤 3.2：store 接口/初始值/init/refreshStatus**

接口（`pnpmVersion` 后）与初始值（`pnpmVersion: null,` 后）各追加：

```ts
  plugins: string[];
  profileReady: boolean;
```

```ts
  plugins: [],
  profileReady: false,
```

init 与 refreshStatus 的 set 中 `pnpmVersion: s.pnpm_version,` 后各追加：

```ts
          plugins: s.plugins ?? [],
          profileReady: s.profile_ready,
```

接口方法声明（`startFlow` 前）追加：

```ts
  ensurePluginsThenStart: () => Promise<void>;
```

- [ ] **步骤 3.3：wireEvents 新增接线 + 改造全局安装回调**

`webExit` 接线之前插入：

```ts
    onEvent<LogLine>(EVENTS.pluginInstallLog, (p) => {
      get().appendLog("system", p.line);
    });

    onEvent<ExitPayload>(EVENTS.pluginInstallExit, (p) => {
      if (get().phase !== "installing") return; // 仅插件安装阶段生效
      if (p.code === 0) {
        get().appendLog("success", "✅ 插件依赖安装完成");
        set({ phase: "starting" });
        get().appendLog("system", "开始启动本地服务：dsh web …");
        void api.startDshWeb().catch((e) => {
          get().appendLog("error", `启动失败：${String(e)}`);
          set({ phase: "error", error: String(e) });
        });
      } else {
        get().appendLog("error", `❌ 插件依赖安装失败（退出码 ${p.code}）`);
        set({ phase: "error", error: `插件依赖安装失败，退出码 ${p.code}` });
      }
    });
```

全局安装回调 `installExit` 中，成功分支改为（删除原内联 starting/startDshWeb 段）：

```ts
      if (p.code === 0) {
        get().appendLog("success", "✅ @deepseek-ai/dsh 全局安装完成");
        set({ dshInstalled: true });
        void get().ensurePluginsThenStart();
      } else {
```

- [ ] **步骤 3.4：新增 ensurePluginsThenStart 并改造 startFlow**

action 实现（放在 startFlow 之前）：

```ts
    ensurePluginsThenStart: async () => {
      const s = get();
      // 浏览器预览或 profile 未生成（首次运行）：跳过插件安装直接启动
      if (!tauri || !s.profileReady) {
        set({ phase: "starting", error: null });
        get().appendLog("system", "开始启动本地服务：dsh web …");
        try {
          await api.startDshWeb();
        } catch (e) {
          get().appendLog("error", `启动失败：${String(e)}`);
          set({ phase: "error", error: String(e) });
        }
        return;
      }
      get().appendLog("system", "安装插件依赖：pnpm install …");
      set({ phase: "installing", error: null });
      try {
        await api.installPlugins(); // 结果由 plugin-install-exit 事件驱动续接
      } catch (e) {
        get().appendLog("error", `插件依赖安装失败：${String(e)}`);
        set({ phase: "error", error: String(e) });
      }
    },
```

startFlow 中 `if (dshInstalled) {` 分支体替换为：

```ts
      if (dshInstalled) {
        get().appendLog("system", "✔ 检测到 dsh 已全局安装，跳过安装步骤");
        void get().ensurePluginsThenStart();
      } else {
```

（else 分支保持原全局安装逻辑不变。）

- [ ] **步骤 3.5：验证 + Commit**

`pnpm build` exit=0 后：

```bash
git add src/lib/tauri.ts src/store/useAppStore.ts
git commit -m "feat(store): 启动链路三段编排与插件状态透传（任务 3/5）"
```

---

### 任务 4：启动页文案精简 + Plugins 小节

**文件：**
- 修改：`src/pages/Launch.tsx`
- 修改：`src/styles/global.css`

- [ ] **步骤 4.1：Launch.tsx 调整**

1. import 区增加：`import { App as AntApp } from "antd";`；把 `import { tauri } from "../lib/tauri";` 改为 `import { api, tauri } from "../lib/tauri";`
2. 组件开头取 `const { modal, message } = AntApp.useApp();`；store 解构增加 `plugins`。
3. 删除 `<p className="launch-subtitle">…</p>` 整行。
4. stopped 分支文案改为 `"服务已停止"`。
5. 删除整个 `{initialized ? (<div className="launch-footer">…</div>) : null}` 区块。
6. 卡片 envRows 渲染之后、`startGated` 提示之前插入：

```tsx
          {tauri ? (
            <>
              <div className="env-section-title">Plugins</div>
              {plugins.length === 0 ? (
                <div className="env-row">
                  <span className="env-detail">暂无用户插件</span>
                </div>
              ) : (
                plugins.map((name) => (
                  <div key={name} className="env-row">
                    <span className="env-mark ok">◆</span>
                    <span className="env-name">{name}</span>
                    <button
                      className="plugin-remove-btn"
                      type="button"
                      onClick={() => confirmRemove(name)}
                    >
                      移除
                    </button>
                  </div>
                ))
              )}
            </>
          ) : null}
```

7. 组件内（handlePrimary 附近）新增移除确认：

```tsx
  const confirmRemove = (name: string) => {
    modal.confirm({
      title: "移除插件",
      content: `确定移除插件 ${name}？将同时从 bundles 与 dependencies 中删除。`,
      okText: "移除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        try {
          await api.removePlugin(name);
          await refreshStatus();
          message.success(`已移除 ${name}`);
        } catch (e) {
          message.error(String(e instanceof Error ? e.message : e));
        }
      },
    });
  };
```

- [ ] **步骤 4.2：global.css 调整**

删除四个区块：`.launch-subtitle`（260 行附近）、`.launch-footer`（473 行附近）、`.env-chip`、`.env-chip b`。
在 `.env-hint` 规则后追加：

```css
.env-section-title {
  margin-top: 2px;
  padding-top: 8px;
  border-top: 1px dashed var(--border-strong);
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-3);
}

.plugin-remove-btn {
  margin-left: auto;
  flex-shrink: 0;
  border: none;
  background: transparent;
  color: var(--danger);
  font-size: 12px;
  cursor: pointer;
  padding: 2px 8px;
  border-radius: 6px;
  transition: background 0.15s ease;
}

.plugin-remove-btn:hover {
  background: rgba(248, 113, 113, 0.12);
}
```

- [ ] **步骤 4.3：验证 + Commit**

`pnpm build` exit=0；grep 确认 `launch-subtitle|launch-footer|env-chip` 在 src 下零残留。

```bash
git add src/pages/Launch.tsx src/styles/global.css
git commit -m "feat(launch): 插件列表管理与文案精简（任务 4/5）"
```

---

### 任务 5：回归验证

- [ ] **步骤 5.1：** `cargo check --manifest-path src-tauri/Cargo.toml` 与 `pnpm build` 均 exit=0。
- [ ] **步骤 5.2：手动清单（tauri:dev）**

1. 启动页无副标题、无底部徽章；停止服务后状态条显示「服务已停止」。
2. 环境卡片出现 Plugins 小节，列出 dependencies 中的 5 个插件，核心包不出现。
3. 移除某插件 → 确认框 → 列表刷新，package.json 中 bundles 与 dependencies 同步删除且键顺序不变。
4. 手动向 package.json 加一个 link 插件 → 点击启动 → 终端页出现「安装插件依赖」与 pnpm install 流水 → 成功进入 running。
5. 移除的插件在下次启动 pnpm install 时从 node_modules 清理。

- [ ] **步骤 5.3：如有微调收尾提交**

```bash
git add -A; git commit -m "chore: 插件管理与文案精简回归修正"
```

---

## 自检记录

- **规格覆盖度**：文案三处→任务 4；读取/展示/移除→任务 1+3+4；启动前安装→任务 2+3；边界→任务 1/2 错误路径与规格第 6 节一致；验证→任务 5。
- **占位符扫描**：所有步骤含完整代码/命令。
- **类型一致性**：`plugins: Vec<String>`/`profile_ready: bool` ↔ `plugins: string[]`/`profile_ready: boolean`；事件名 `plugin-install-log/exit` 两端一致；`ensurePluginsThenStart` 在接口、实现、startFlow、installExit 四处引用同名；`removePlugin` api 名与 Rust `remove_plugin` 命令对应（Tauri 自动驼峰映射）。
