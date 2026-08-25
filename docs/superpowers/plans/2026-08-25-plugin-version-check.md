# 插件版本号展示与更新检测 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。

**目标：** 插件行显示灰色小字当前版本；registry 直查最新版本（并行 fetch），有新版时追加青色「→ 新版本」并仅此时渲染「更新」按钮。

**规格：** `docs/superpowers/specs/2026-08-25-plugin-version-check-design.md`

---

### 任务 1：后端 check_plugin_updates

- [ ] `src-tauri/src/dsh.rs` 追加（remove_plugin 之后）：

```rust
/// 插件版本基础信息（纯本地读取；latest 由前端查 registry）
#[derive(Serialize)]
pub struct PluginVersionInfo {
    pub name: String,
    pub spec: Option<String>,
    pub current: Option<String>,
    pub updatable: bool,
}

/// 纯 registry 规格才可检查更新（link/file/git/本地路径均排除）
fn is_registry_spec(spec: &str) -> bool {
    let s = spec.trim();
    if s.is_empty() {
        return false;
    }
    let lower = s.to_lowercase();
    if lower.starts_with("link:")
        || lower.starts_with("file:")
        || lower.starts_with("git")
        || lower.starts_with("github:")
        || lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("./")
        || lower.starts_with("../")
        || lower.contains("://")
    {
        return false;
    }
    // Windows 绝对路径（如 D:/workspace/x）
    if s.len() >= 2 && s.as_bytes()[1] == b':' {
        return false;
    }
    true
}

/// 读取 node_modules 内已安装版本（支持 @scope/name 嵌套路径）
fn read_installed_version(dir: &PathBuf, name: &str) -> Option<String> {
    let mut rel = PathBuf::from("node_modules");
    for part in name.split('/') {
        rel = rel.join(part);
    }
    let text = std::fs::read_to_string(dir.join(&rel).join("package.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v.get("version").and_then(|x| x.as_str()).map(|s| s.to_string())
}

/// 插件版本基础信息：名称、依赖规格、当前安装版本、是否可检查更新
#[tauri::command]
pub fn check_plugin_updates() -> Result<Vec<PluginVersionInfo>, String> {
    let dir = profile_dir().ok_or("未找到插件目录")?;
    let text = std::fs::read_to_string(profile_package_json().ok_or("未找到 package.json")?)
        .map_err(|e| format!("读取 package.json 失败: {e}"))?;
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("package.json 解析失败: {e}"))?;
    let deps = v.get("dependencies").and_then(|d| d.as_object());

    let (names, _) = read_profile_plugins();
    Ok(names
        .into_iter()
        .map(|name| {
            let spec = deps
                .and_then(|d| d.get(&name))
                .and_then(|x| x.as_str())
                .map(|s| s.to_string());
            let updatable = spec.as_deref().map(is_registry_spec).unwrap_or(false);
            PluginVersionInfo {
                updatable,
                current: read_installed_version(&dir, &name),
                spec,
                name,
            }
        })
        .collect())
}
```

- [ ] lib.rs 注册 `dsh::check_plugin_updates`；`cargo check` exit=0 → commit

### 任务 2：前端桥接与 store

- [ ] `tauri.ts`：

```ts
export interface PluginVersionInfo {
  name: string;
  spec: string | null;
  current: string | null;
  updatable: boolean;
}
```

api 追加 `checkPluginUpdates: () => requireTauri(() => invoke<PluginVersionInfo[]>("check_plugin_updates"))`（PluginVersionInfo 从本文件导出）。

- [ ] store：接口/初始值追加 `pluginVers: Record<string, { current?: string | null; latest?: string | null }>` 与 `refreshPluginVersions: () => Promise<void>`；实现：

```ts
    refreshPluginVersions: async () => {
      const base = await api.checkPluginUpdates();
      const vers: AppStore["pluginVers"] = {};
      for (const i of base) {
        vers[i.name] = { current: i.current, latest: null };
      }
      set({ pluginVers: vers });
      // 并行直查 registry latest；失败置 null 静默隐藏更新按钮
      await Promise.allSettled(
        base
          .filter((i) => i.updatable)
          .map(async (i) => {
            try {
              const ctrl = new AbortController();
              const timer = setTimeout(() => ctrl.abort(), 6000);
              const res = await fetch(
                `https://registry.npmjs.org/${encodeURIComponent(i.name)}/latest`,
                { signal: ctrl.signal },
              );
              clearTimeout(timer);
              const j = (await res.json()) as { version?: unknown };
              const latest = typeof j.version === "string" ? j.version : null;
              set((s) => ({
                pluginVers: { ...s.pluginVers, [i.name]: { ...s.pluginVers[i.name], latest } },
              }));
            } catch {
              set((s) => ({
                pluginVers: { ...s.pluginVers, [i.name]: { ...s.pluginVers[i.name], latest: null } },
              }));
            }
          }),
      );
    },
```

- [ ] `pnpm build` exit=0 → commit

### 任务 3：弹框 UI 接入

- [ ] PluginManager：
  - selectors 增加 `pluginVers` / `refreshPluginVersions`；
  - openManager() 与完成监听 effect 中各调 `void refreshPluginVersions()`；
  - 行渲染改为：

```tsx
plugins.map((p) => {
  const info = pluginVers[p];
  const outdated =
    !!info?.current && !!info?.latest && info.current !== info.latest;
  return (
    <div key={p} className="plugin-row">
      <span className="plugin-name">
        {p}
        {info?.current ? <span className="plugin-ver">{info.current}</span> : null}
        {outdated ? (
          <span className="plugin-ver new">→ {info.latest}</span>
        ) : null}
      </span>
      {outdated ? (
        <button className="pm-btn pm-btn-sm" type="button" disabled={running} onClick={() => confirmOp("update", p)}>
          更新
        </button>
      ) : null}
      <button className="pm-btn pm-btn-sm danger" type="button" disabled={running} onClick={() => confirmOp("remove", p)}>
        删除
      </button>
    </div>
  );
})
```

- [ ] CSS 追加：

```css
.plugin-ver {
  margin-left: 6px;
  font-size: 11px;
  color: var(--text-3);
}

.plugin-ver.new {
  color: #22d3ee;
}
```

- [ ] `pnpm build` exit=0 → commit

### 任务 4：回归验证

- [ ] 手动：版本号与 pnpm outdated 结果一致；dshmarket/dsh-better-sidebar 显示「→ 新版」并有更新按钮；dsh1024 无更新按钮；link 类插件无更新按钮；更新执行后刷新显示新版本号且按钮消失。
