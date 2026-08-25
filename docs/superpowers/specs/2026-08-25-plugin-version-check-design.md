# 插件版本号展示与更新检测 — 设计文档

日期：2026-08-25
状态：已批准

## 需求

1. 插件管理弹框中，插件名后以小字灰色显示当前安装版本号。
2. 检测插件新版本：无新版不显示「更新」按钮；有新版时在旧版本号后追加显示新版本号。

## 方案（registry 直查，快速路径）

| 环节 | 实现 |
|------|------|
| 当前安装版本 | 后端读 `node_modules/<name>/package.json` 的 version（本地毫秒级） |
| 依赖原始规格 | 后端从 package.json `dependencies` 读取 spec |
| 最新版本 | 前端并行 `fetch https://registry.npmjs.org/{name}/latest`（几 KB/个，CORS 开放；AbortController 6 秒超时，失败静默置未知） |
| 可更新判定 | 前端比对 `current !== latest` |

- **updatable**：spec 为纯 registry 规格（非 `link:` / `file:` / git / 本地路径）才参与查询与更新按钮渲染——本地链接包不会被误判。
- 局限：自定义私有 registry 场景会查公共源；后续按需配置化。

## 改动点

### 后端（`src-tauri/src/dsh.rs`）

新命令 `check_plugin_updates() -> Result<Vec<PluginVersionInfo>, String>`：

```rust
#[derive(Serialize)]
pub struct PluginVersionInfo {
    pub name: String,
    pub spec: Option<String>,
    pub current: Option<String>,
    pub updatable: bool,
}
```

实现：`read_profile_plugins()` 取名字列表 → 读 dependencies spec → 读 node_modules 安装版本 → `is_registry_spec(spec)` 判定 updatable。纯本地读取。

### 前端

- `tauri.ts`：`PluginVersionInfo` 接口 + `api.checkPluginUpdates()`。
- store：`pluginVers: Record<string, { current?: string | null; latest?: string | null }>`、`refreshPluginVersions()`：
  1. 调后端拿基础信息写入 current；
  2. 对 updatable 项并行 fetch registry latest，逐个落位 latest；
  3. 失败项 latest = null。
- 组件：打开弹框时、操作完成回调里各调一次刷新。
- 行内展示：名称后 `.plugin-ver`（11px 灰色 mono）当前版本；outdated 时追加 `.plugin-ver.new`（青色 accent）「→ 新版本」；仅 outdated 渲染「更新」按钮。

### 验证

cargo check + pnpm build；tauri:dev 手动：版本号正确显示（对照 pnpm outdated 结果）、无新版无更新按钮、有新版双版本号 + 更新按钮可执行。
