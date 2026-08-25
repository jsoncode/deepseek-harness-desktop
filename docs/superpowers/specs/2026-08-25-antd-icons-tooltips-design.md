# 全应用换用 @ant-design/icons + 标题栏 antd Tooltip — 设计文档

日期：2026-08-25
状态：已批准

## 背景与目标

项目此前使用自绘内联 SVG 图标集（`src/components/icons.tsx`）。用户已安装 `@ant-design/icons@6.3.2`：

1. 全应用图标替换：删除自绘图标集，所有位置换用 antd 图标。
2. 标题栏所有按钮的原生 `title` 提示改为 antd `Tooltip` 气泡。

已确认决策：替换范围为全应用（含终端页/预览页/主题切换/窗口控制）；停止服务按钮置灰时气泡显示「服务未运行」（外包一层 span 使 disabled 态可触发）。

## 图标映射

| 现有 | 用途 | antd 替代 |
|------|------|------|
| ArrowLeftIcon | 返回启动页（标题栏、预览页） | ArrowLeftOutlined |
| RotateCwIcon | 重启服务 | ReloadOutlined |
| StopIcon | 停止服务（标题栏、终端页） | StopOutlined |
| TerminalSquareIcon | 查看日志 | CodeOutlined（v6 无 TerminalOutlined） |
| RefreshIcon | 刷新预览 | SyncOutlined（与重启单箭头区分） |
| CopyIcon / ExternalIcon | 复制地址 / 浏览器打开 | CopyOutlined / ExportOutlined |
| HomeIcon / PlayIcon | 终端页返回 / 打开应用·重试·重启 | HomeOutlined / CaretRightFilled |
| MinusIcon / MaximizeIcon / RestoreIcon / CloseIcon | 窗口控制 | MinusOutlined / BorderOutlined / SwitcherOutlined / CloseOutlined |
| SunIcon / MoonIcon / SystemIcon | 主题切换 | SunOutlined / MoonOutlined / DesktopOutlined |

尺寸规则：原 `size` prop 改为 `style={{ fontSize }}`——标题栏 16，窗口控制 14，菜单项 14，正文按钮 14-15。完成后删除 `src/components/icons.tsx` 并确认零引用。

## Tooltip 方案

- 标题栏全部按钮包 `<Tooltip>`：停止/重启/日志/返回/刷新/复制/外链、主题切换「切换主题」、窗口三键「最小化」「最大化(还原)」「关闭」。
- 移除全部原生 `title` 属性；保留 `aria-label`；url-pill 地址条非按钮不处理。
- 停止服务按钮：`serviceRunning === false` 时气泡显示「服务未运行」，否则「停止服务」；外层包 `<span className="tip-wrap">`（`display:inline-flex`）保证 antd 对 disabled 按钮默认不弹气泡的限制被绕过。
- `win-maximize` 的 snap-layout id 保留在 button 元素上，Tooltip 只作外层包裹不影响磁吸功能。

## 验证方式

1. `pnpm build` 通过；grep 确认 `components/icons` 引用为零后删除文件。
2. `tauri:dev` 手动：各按钮悬停出现单一 antd 气泡（无原生 title 双重提示）；置灰停止键显示「服务未运行」；主题下拉三图标正常；窗口控制三键正常。

## 不做的事（YAGNI）

- 不引入其他图标库或统一封装组件；不调整气泡样式主题（antd 自动跟随明暗主题）。
