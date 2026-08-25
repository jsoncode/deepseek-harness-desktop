# 断连提示改为标题栏指示灯 — 设计文档

日期：2026-08-25
状态：已批准

## 背景与根因

服务正常运行时频繁出现「本地服务已断开连接」全屏覆盖层。根因：`Preview.tsx` 健康轮询每 6 秒探测一次（Rust 端 `probe_service` 超时 800ms），**单次探测失败立即**渲染覆盖层拦截预览区。本地服务繁忙/单次请求变慢即可触发误报。

## 目标行为

1. 移除预览页断连覆盖层，不再拦截内容。
2. 服务断连只反映在**标题栏地址条指示灯**上：绿 → 红。

## 方案

### 1. 全局健康轮询（`src/store/useAppStore.ts`）

- 新增状态 `serviceAlive: boolean`（默认 true）。
- 轮询逻辑移入 store：仅 `url && phase === "running"` 时每 6 秒调用 `api.probeService(url)`；条件不满足时自动停止轮询。
- 防抖：连续 2 次失败才置 `serviceAlive = false`；任一次成功立即置回 `true` 并清零计数。
- `dsh://url` 事件与 `refreshStatus` 检测到运行中时重置为 true。
- 探测结果只更新状态，不产生任何弹层。

### 2. 标题栏指示灯三态（`TitleBar.tsx` + `global.css`）

- 灰（`.dot.off`）：无服务地址；红（`.dot.down`）：运行中但断连或已停止；绿：运行中且存活（现有样式）。

### 3. 预览页移除拦截（`Preview.tsx`）

- 删除覆盖层 JSX、`alive/rechecking` 状态、`recheck()`、页面内轮询 effect 及 `.preview-overlay` 两段 CSS（含浅色主题变体）；README 两处功能描述同步更新。空态（无 URL）保留。

## 验证

`cargo check` + `pnpm build`；tauri:dev 手动：正常时常绿无弹层；杀掉 dsh 进程模拟断连 → 数秒内灯变红且预览不被遮挡；重启服务 → 灯自动恢复绿色。

## 不做的事（YAGNI）

- 不做断连后的自动重连按钮；不改 Rust 探测超时；不做通知/声音提醒。
