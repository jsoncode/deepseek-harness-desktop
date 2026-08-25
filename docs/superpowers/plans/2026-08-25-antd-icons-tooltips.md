# antd 图标替换 + 标题栏 Tooltip 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 全应用 17 个自绘 SVG 图标换为 @ant-design/icons v6；标题栏全部按钮提示改用 antd Tooltip（停止键置灰显示「服务未运行」）。

**架构：** 逐文件替换 import 与标签，尺寸用 `style={{ fontSize }}` 表达；最后删除 `src/components/icons.tsx` 并验证零引用。

**技术栈：** React 19 + antd 6 + @ant-design/icons 6.3.2。

**规格：** `docs/superpowers/specs/2026-08-25-antd-icons-tooltips-design.md`

---

## 文件结构

| 文件 | 操作 |
|------|------|
| `src/components/TitleBar.tsx` | 修改：7 个图标 + 全部按钮 Tooltip + 停止键 span 包裹 |
| `src/components/WindowControls.tsx` | 修改：4 个图标 + 三键 Tooltip |
| `src/components/ThemeSwitch.tsx` | 修改：3 个图标 + 触发按钮 Tooltip |
| `src/pages/Terminal.tsx` | 修改：Home/Play/Stop 图标 |
| `src/pages/Preview.tsx` | 修改：ArrowLeft 图标 |
| `src/components/icons.tsx` | 删除 |

---

### 任务 1：TitleBar 图标与 Tooltip

- [ ] 步骤 1.1：import 替换——删除 `./icons` 导入，新增：

```tsx
import { Tooltip } from "antd";
import {
  ArrowLeftOutlined,
  CodeOutlined,
  CopyOutlined,
  ExportOutlined,
  ReloadOutlined,
  StopOutlined,
  SyncOutlined,
} from "@ant-design/icons";
```

- [ ] 步骤 1.2：center 区按钮改为（保留 disabled/onClick/className 等逻辑不变）：

```tsx
        <Tooltip title={!serviceRunning ? "服务未运行" : "停止服务"}>
          <span className="tip-wrap">
            <button
              className="icon-btn stop-btn"
              type="button"
              aria-label="停止服务"
              disabled={!serviceRunning || restarting}
              onClick={confirmStop}
            >
              <StopOutlined />
            </button>
          </span>
        </Tooltip>
        <Tooltip title="重启服务">
          <button
            className="icon-btn"
            type="button"
            aria-label="重启服务"
            disabled={restarting || busy}
            onClick={confirmRestart}
          >
            {/* 重启中不旋转方向性图标（避免怪异动效），loading 状态由消息气泡提示 */}
            <ReloadOutlined />
          </button>
        </Tooltip>
        <Tooltip title="查看日志">
          <button
            className="icon-btn"
            type="button"
            aria-label="查看日志"
            onClick={() => navigate("/terminal")}
          >
            <CodeOutlined />
          </button>
        </Tooltip>
        <Tooltip title="返回启动页">
          <button className="icon-btn" type="button" aria-label="返回启动页" onClick={() => navigate("/")}>
            <ArrowLeftOutlined />
          </button>
        </Tooltip>
```

url-pill 不变；刷新/复制/外链三个按钮同样包 Tooltip（标题分别为 刷新 / 复制地址 / 在浏览器中打开），图标换 SyncOutlined / CopyOutlined / ExportOutlined，移除全部原生 title 属性。

- [ ] 步骤 1.3：global.css 的 `.stop-btn:disabled` 后追加：

```css
/* antd Tooltip 包裹层：保证 disabled 按钮也能触发气泡 */
.tip-wrap {
  display: inline-flex;
}
```

- [ ] 步骤 1.4：`pnpm build` exit=0 → commit `refactor(titlebar): 图标换用 antd 并改用气泡提示（任务 1/4）`

### 任务 2：WindowControls 与 ThemeSwitch

- [ ] 步骤 2.1：WindowControls —— import `Tooltip` 与 `BorderOutlined, CloseOutlined, MinusOutlined, SwitcherOutlined`；三键分别包 `<Tooltip title="最小化"/"最大化"/"还原"/"关闭">`（最大化键动态 title），图标 `style={{ fontSize: 14 }}`，移除原生 title。id="win-maximize" 保留在 button 上。
- [ ] 步骤 2.2：ThemeSwitch —— 菜单三项 icon 换 `<DesktopOutlined/SunOutlined/MoonOutlined style={{ fontSize: 14 }} />`；触发按钮包 `<Tooltip title="切换主题">`，移除原生 title。
- [ ] 步骤 2.3：`pnpm build` exit=0 → commit `refactor(ui): 窗口控制与主题切换换用 antd 图标气泡（任务 2/4）`

### 任务 3：Terminal 与 Preview 页图标

- [ ] 步骤 3.1：Terminal.tsx —— `CaretRightFilled`(打开应用 14/重试 15/重新启动 15)、`StopOutlined`(停止服务 14)、`HomeOutlined`(返回启动页 14)。
- [ ] 步骤 3.2：Preview.tsx —— 返回启动页 `ArrowLeftOutlined style={{ fontSize: 14 }}`。
- [ ] 步骤 3.3：删除 `src/components/icons.tsx`；grep `components/icons|from "./icons"` 零命中；`pnpm build` exit=0 → commit `refactor(icons): 移除自绘 SVG 图标集，全量换用 @ant-design/icons（任务 3/4）`

### 任务 4：回归验证

- [ ] 步骤 4.1：`cargo check` + `pnpm build` 均 exit=0。
- [ ] 步骤 4.2：tauri:dev 手动清单：
  1. 标题栏每个按钮悬停出现单个深色气泡、无原生 title 双重提示；
  2. 服务未运行时停止键置灰且悬停显示「服务未运行」；
  3. 主题下拉三项图标正常、切换正常；窗口控制三键正常、Win11 磁吸不受影响；
  4. 终端页/预览页按钮图标正常显示。
- [ ] 步骤 4.3：如有微调收尾提交。

---

## 自检记录

映射表与规格一致；所有被引用图标已逐一 Test-Path 验证存在于 @ant-design/icons@6.3.2（仅 TerminalOutlined 不存在，已选 CodeOutlined 替代）；删除 icons.tsx 前有零引用校验步骤；停止键 span 包裹与 `.tip-wrap` CSS 配套定义。
