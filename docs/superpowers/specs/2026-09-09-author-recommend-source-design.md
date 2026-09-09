# 插件市场新增「作者推荐」来源 设计

- **日期：** 2026-09-09
- **状态：** 已实现
- **前置：** 2026-08-25-plugin-market-design.md（GitHub / NPM 双源插件市场，已实现）
- **技术栈：** 前端（React + antd，`src/lib/pluginMarket.ts` + `src/components/PluginManagerPanel.tsx`）；
  数据经既有 Rust 命令 `http_get_json` 代理（绕开打包版 CSP），后端零改动

## 目标

插件管理面板的**来源切换**在 GitHub / NPM 之后新增第三个来源 **【作者推荐】**：
一次请求 GitHub 仓库搜索接口

```
https://api.github.com/search/repositories?q=dsh-+user:jsoncode
```

展示插件作者 `jsoncode` 名下的全部 dsh 系列插件，供用户直接安装。

## 方案

### 1. 数据源（`src/lib/pluginMarket.ts`）

| 项 | 实现 |
|---|---|
| 来源枚举 | `MarketSource = "github" \| "npm" \| "author"` |
| 检索式 | 常量 `AUTHOR_QUERY = "dsh- user:jsoncode"`（`AUTHOR_LOGIN = "jsoncode"`）；**原样**作为 `q` 发出，不追加任何限定符 |
| 请求 | 复用 `fetchGithubPage(AUTHOR_QUERY, page, sort, raw = true)` → 与 GitHub 源同一接口、同一 `per_page/page` 分页、同一 `mapGhItem` 映射 |
| 排序 | 服务端 `sort`：`stars` → `&sort=stars&order=desc`；`date` → `&sort=updated&order=desc`（`githubSortParam` 抽成公共函数，GitHub 源共用） |
| 分页 | `pageSizeOf` 改为「NPM 用 NPM_PAGE_SIZE，其余用 GH_PAGE_SIZE」 |
| 关键词 | **忽略**调用方传入的关键词（固定精选列表，UI 不渲染搜索框） |

`raw = true` 的意义：GitHub 源的 `buildGithubQ` 会把空关键词补成默认词 `dsh-plugin`，
作者推荐必须绕开该补齐逻辑、原样发出固定检索式。

### 2. UI（`src/components/PluginManagerPanel.tsx`）

- **来源分段组**：`SOURCE_ORDER = ["github", "npm", "author"]` + `SOURCE_LABEL` 驱动，
  顺序即「GitHub / NPM / 作者推荐」；穿梭动画方向改为按**序号比较**决定（原先硬编码
  npm=右、github=左，三源下会错）。
- **默认排序**：`SOURCE_DEFAULT_SORT = { github: "stars", npm: "weekly", author: "date" }`
  ——作者推荐按最近更新优先（该账号多数仓库 stars 为 0，stars 排序无信息量）。
- **工具栏第一行**：作者推荐不渲染搜索框，改渲染 `.mk-reco-hint` 说明条
  （渐变徽标 + 作者 `@jsoncode` + 实际检索式 `q=dsh- user:jsoncode`），
  让用户清楚「这份列表为什么是这些插件」。搜索按钮同排消失（无搜索语义）。
- **视图 tab**：作者推荐下首个 tab 标签由「所有插件(N)」改为「作者推荐(N)」，N 取服务端 `total_count`。
- **排序项**：`isNpm ? [周下载] : [Stars]` + 发布日期；作者推荐显示 Stars / 发布日期。
- **指标列**：`isNpm ? 周下载 : Stars`（GitHub 无下载数，作者推荐同 GitHub）。
- **安装动词**：`isNpm ? 一键安装 : 源码安装`——作者推荐行的 `spec` 为 `github:jsoncode/<repo>`，
  走源码安装（与 GitHub 源一致，详情弹框内同样口径）。
- **空态**：作者推荐无结果时显示「作者暂无 dsh 系列插件」。
- 已安装 tab / 详情弹框 / 安装·更新·卸载链路**零改动**（行结构 `MkRow` 未变）。

### 3. 样式（`src/styles/global.css`）

新增 `.mk-reco-hint`（虚线下边框提示条）+ `.mk-reco-badge`（与分段组选中态同一渐变），
沿用 `--panel-strong / --border-strong / --text-* / --mono` 变量，深浅色主题自动适配。

## 关键决策记录

| 决策点 | 结论 | 依据 |
|---|---|---|
| 是否新增后端命令 | **否**，复用 `http_get_json` | 该命令已按 https 放行任意 URL，作者推荐只是另一个 GitHub 搜索 URL |
| 是否接受关键词 | **否**，固定检索式 | 需求即「请求该接口」；8 条精选列表无需二次过滤，避免用户误以为搜的是全网 |
| 默认排序 | 最近更新优先（`date`） | 该账号仓库 stars 多为 0，stars 排序几乎不改变次序 |
| 分页 | 保留服务端分页 | 与 GitHub 源共用一套分页 UI；当前 8 条 → 1 页，翻页按钮自动禁用 |
| 来源数量与顺序 | 三源，作者推荐排第三 | 需求「在 github/npm 后面新增」 |

## 验证

- `pnpm build`（`check-acl` + `tsc --noEmit` + `vite build`）通过。
- 用 Node 直接跑真实 `pluginMarket.ts`（stub 掉 `./tauri` 的桥接、其余代码零改动）
  对接线上接口，逐项断言通过：
  - `fetchMarketPage("author", "任意关键词", 1, "date")` → `total = 8`，全部 `dsh-` 前缀、
    `author = jsoncode`、`spec = github:jsoncode/<repo>`、`weekly/monthly = null`；
  - `date` 排序确为最近更新优先；第 2 页返回空列表不报错；
  - 回归：GitHub 源（`q=dsh-plugin&sort=stars`）与 NPM 源（`keywords:dsh-plugin`，客户端排序）行为不变。
- 实机（桌面应用内）手动清单：
  1. 打开设置页 → 插件管理 → 头部出现「GitHub / NPM / 作者推荐」三段；
  2. 切到作者推荐 → 首行出现说明条、无搜索框、tab 显示「作者推荐(8)」，表格列出 8 个插件；
  3. 点击行 → 详情弹框显示 Stars / 更新于 / `github:jsoncode/...`，「源码安装」按钮可直接安装；
  4. 切回 GitHub / NPM → 搜索框恢复、默认排序分别为 Stars / 周下载。

## 风险

- **GitHub 未认证限流**（约 10 次/分钟）：沿用既有 403 → `RateLimitedError`
  友好提示；作者推荐与 GitHub 源共享同一配额，切换来源不额外放大请求（每次切换只发 1 个请求）。
- **该账号仓库命名变化**：检索式依赖 `dsh-` 前缀与 `user:jsoncode`；若作者改用其他前缀，
  改 `AUTHOR_QUERY` 一个常量即可。
