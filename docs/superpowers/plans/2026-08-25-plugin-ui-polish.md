# 插件 UI 打磨 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。

**目标：** 启动页插件改小标签并移除行内删除；插件管理弹框视觉对齐启动页（胶囊按钮族 + 面板化内容区）。

**规格：** `docs/superpowers/specs/2026-08-25-plugin-ui-polish-design.md`

---

### 任务 1：启动页标签化

- [ ] `src/pages/Launch.tsx`：
  - 删除 `confirmRemove` 函数、`AntApp.useApp()` 行、`api` 导入（`tauri` 保留）；
  - Plugins 小节 JSX 改为：

```tsx
<div className="env-section-title">Plugins</div>
<div className="plugin-tags">
  {plugins.map((p) => (
    <span key={p} className="plugin-tag">
      {p}
    </span>
  ))}
</div>
{plugins.length === 0 ? <div className="plugin-empty">暂无用户插件</div> : null}
```

- [ ] `src/styles/global.css`：删除 `.plugin-remove-btn` 两段规则与 `.plugin-row/.plugin-name/.plugin-toolbar` 中仅弹框用的旧样式保留不动（弹框仍用）；新增：

```css
.plugin-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.plugin-tag {
  padding: 3px 10px;
  border-radius: 6px;
  background: var(--panel);
  border: 1px solid var(--border-strong);
  font-family: var(--mono);
  font-size: 12px;
  color: var(--text-2);
}
```

- [ ] `pnpm build` exit=0 → commit `feat(launch): 插件改为标签展示，移除行内删除按钮`

### 任务 2：弹框重设计

- [ ] `src/components/PluginManager.tsx`：
  - Modal 加 `className="plugin-manager-modal"`；
  - 所有 antd Button 换为原生 button + `.pm-btn` 类（新增/更新/后台运行用基类；删除/终止安装加 `danger`；关闭用 `pm-btn primary`）；
  - footer/列表结构不变。
- [ ] `src/styles/global.css` 追加 `.plugin-manager-modal` 作用域样式（内容区面板化、`.pm-btn` 族、行悬停、输入框覆盖）。
- [ ] `pnpm build` exit=0 → commit `feat(ui): 插件管理弹框对齐启动页视觉风格`

### 任务 3：回归验证

- [ ] 手动核对：启动页标签展示无删除按钮；弹框各按钮为胶囊风格、终止/关闭语义正确；交互回归正常。
