# 启动页插件标签化 + 插件弹框视觉重设计 — 设计文档

日期：2026-08-25
状态：已批准

## 需求

1. 启动页环境卡片中，去掉插件右侧的「移除」按钮，插件改为小尺寸 tag 标签展示。
2. 插件管理弹框重新设计，与启动页风格一致（重点是按钮样式）。

## 设计

### 1. 启动页（`src/pages/Launch.tsx` + `global.css`）

- Plugins 小节改为标签流式排布：`.plugin-tags`（flex wrap, gap 8px）内渲染 `.plugin-tag`（mono 字体 12px、面板底、1px var(--border-strong) 边框、圆角 6px、padding 3px 10px）。
- 删除每行「移除」按钮与 `confirmRemove`；随之清理 Launch 中不再使用的 `AntApp.useApp()`（modal/message）与 `api` 导入。
- 删除 `.plugin-remove-btn` 样式块。
- 删除入口收敛到标题栏「插件管理」弹框（CLI 全量卸载）。

### 2. 插件管理弹框（`PluginManager.tsx` + `global.css`）

保留 antd Modal 外壳，内容改用原生 button + 新 `.pm-btn` 样式族，作用域 `.plugin-manager-modal`：

- 内容区：`var(--panel)` 底 + `var(--border-strong)` 边框 + 16px 圆角。
- `.pm-btn` 基类：胶囊形（radius 999）、面板底、细边框、悬停上浮 —— 对齐启动页 `.btn-secondary`。
- 变体：`.pm-btn.danger` 红描边（悬停淡红填充）；`.pm-btn.primary` 启动页同款靛→紫→青渐变实底白字（紧凑 padding）。
- 应用位置：「＋ 新增插件」「更新」「删除」「终止安装」「后台运行」「关闭」（完成态用 primary 渐变）。
- 行悬停高亮（panel-strong）；名称 mono 字体；输入框面板底色圆角 10px；标题加字距。

### 3. 验证

`pnpm build`；tauri:dev 手动核对启动页标签展示与弹框各按钮风格、交互回归。

## 不做的事

不新增功能；不动 CLI 执行链路；不改全局 antd 主题 token。
