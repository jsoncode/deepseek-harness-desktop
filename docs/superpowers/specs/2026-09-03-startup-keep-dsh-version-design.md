# 启动链不再重装/更新已安装的 dsh 设计

- **日期：** 2026-09-03
- **状态：** 已实现
- **技术栈：** 前端改动（`src/store/useAppStore.ts`、`src/pages/Launch.tsx`、`src/pages/Loading.tsx`），后端命令不变

## 背景

启动链此前存在两条会**覆盖现有 dsh 版本**的自动安装路径：

1. `startFlow`：pnpm ≥11 被降级到 10 后，无条件重新全局安装 `@deepseek-ai/dsh@latest`；
2. `installEnvAndStart`：同样以 `!dshInstalled || downgraded` 触发重装。

`pnpm add -g @deepseek-ai/dsh@latest` 对已安装的 dsh 等价于**升级到最新版**。历史上 dsh 升级
曾引发兼容性问题（见提交 `0547bbd`、`dc651f7`），用户明确要求：**启动时不要再更新或重复安装
latest 版本，避免覆盖现有 dsh 版本**。

## 目标

- 已安装的 dsh 在任何启动/重启链路中都保留现有版本——不自动重装、不自动更新。
- dsh 仅在两种情况下安装：
  - **缺失**（`!dshInstalled`）：首次使用，无现有版本可覆盖；
  - **损坏**（`dshInstalled && !dshVersion`，与后端 `start_dsh_web` 的完整性校验一致）：
    此时用户已通过启动页「安装」按钮或失败页「重试」**明确发起**修复，属于用户主动重装。
- pnpm 11 → 10 的一键降级保留（不覆盖 dsh），但降级后**不再**联动重装 dsh。

## 行为变化

| 场景 | 旧行为 | 新行为 |
|---|---|---|
| dsh 已安装 + pnpm 降级 11→10 | 自动重装 `@latest`（覆盖版本） | 保留现有版本继续启动，日志说明；若损坏由用户手动重装 |
| dsh 已安装（正常） | 跳过安装（不变） | 跳过安装（不变） |
| dsh 缺失 | 自动安装 `@latest`（不变） | 自动安装 `@latest`（不变） |
| dsh 已安装但读不出版本（损坏） | 启动失败后无 UI 重装入口（死胡同） | 启动页主按钮变「安装」、失败页「重试」走重装链，可恢复 |

## 实现

1. **`useAppStore.startFlow`**：删除 `dshInstalled && downgraded → installDsh()` 分支；
   `dshInstalled` 时一律跳过安装，`downgraded` 仅追加一条「保留现有 dsh 版本」日志。
2. **`useAppStore.installEnvAndStart`**：步骤 ③ 条件由 `!dshInstalled || downgraded`
   改为 `!dshInstalled || (dshInstalled && !dshVersion)`；降级但 dsh 正常时追加说明日志。
3. **`Launch.tsx`**：新增 `dshBroken = dshInstalled && !dshVersion`，纳入 `needsInstall`
   （主按钮变「安装」）；环境检查行对损坏状态给出黄色提示文案。
4. **`Loading.tsx`**：重试的 `needsInstall` 判定同步纳入 `Boolean(s.dshVersion)`，
   使「dsh web 启动失败（安装已损坏）」后的重试能真正进入重装链，形成恢复闭环。

后端 `install_dsh` 命令保持 `@latest` 不变——它只被上述「缺失/用户主动」路径调用。

## 测试

- `pnpm build`（tsc --noEmit + vite build）通过。
- 手动验证：已装 dsh 的机器反复「启动/重启/重试」，日志不再出现
  `pnpm add -g @deepseek-ai/dsh@latest`；dsh 版本保持不变。
