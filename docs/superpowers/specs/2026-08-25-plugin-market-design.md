# 插件市场弹框重构 — 设计文档

日期：2026-08-25
状态：已批准

## 需求

重构插件管理弹框为「插件市场」：

1. 大尺寸弹框。
2. 标题右侧插件源切换：GitHub / NPM，分别用官方搜索接口拉取列表：
   - GitHub：`https://api.github.com/search/repositories?q=topic:dsh-plugin&per_page={pageSize}&page={pageNum}`
   - NPM：`https://registry.npmjs.org/-/v1/search?text=keywords:dsh-plugin&size={pageSize}&from={from}`
3. 列表列：序号、作者头像、插件名称、作者名称、周下载/月下载、版本号（已安装括号显示本机版本）、Stars、发布日期；行尾操作：安装/更新/卸载。
4. 排序：周下载、Stars、发布日期。
5. 列表上方：搜索框 + 「所有插件(total)/已安装(count)」按钮组。
6. 视觉：毛玻璃高斯模糊增强、美观大方、交互舒适。

## 已实测的接口事实

- GitHub：`total_count`、`items[]{name, full_name, stargazers_count, pushed_at, created_at, owner{login, avatar_url}}`；**不提供仓库下载数**；服务端排序支持 `sort=stars|updated&order=desc`；未认证搜索限流约 10 次/分钟。
- NPM：`total`、`objects[]{downloads:{weekly,monthly}, package:{name, version, date, publisher.username}}`；自带周/月下载，无需二次请求。

## 设计决策

- **下载列**：NPM 显示 `周/月`（格式化 K/M）；GitHub 显示"—"（平台无此数据）。
- **排序**：周下载（仅 NPM，客户端排当前页）/ Stars（仅 GitHub，服务端 `sort=stars`）/ 发布日期（双源）。切源自动重置为该源默认排序，不适用的排序项禁用；NPM 排序作用于当前页（接口无全量排序）。
- **搜索**：400ms 防抖，追加到 q/text 参数，重置页码。
- **分页**：pageSize 20，底部页码器（上一页/下一页/第 x 页）；已取页面内存缓存不做（翻页即重新请求），GitHub 触发 403 时表格区显示「GitHub 搜索速率受限，请稍后再试」。
- **头像**：GitHub 用 owner.avatar_url；NPM 尝试 `https://github.com/{publisher}.png?size=64`，加载失败回退首字母渐变圆标。
- **版本与操作**：
  - 已安装判定 = 包名 ∈ 本地 profile 插件列表；本机版本来自 pluginVers.current。
  - 未安装 → [安装]；已安装且 latest≠current → [更新]+[卸载]；已安装无新版 → [卸载]。GitHub 行安装规格传 `github:{full_name}`；NPM 行传包名。全部复用现有确认弹框 + 终端视图流式执行链路。
  - 操作进行中所有行按钮禁用。
- **已安装 tab**：渲染本地 profile 插件（首字母头像 + 版本 + 最新版提示 + 更新/卸载），计数 = plugins.length；「所有插件」计数 = 当前源 total。
- **视觉**：Modal 内容区半透明毛玻璃（blur 24px）；表格行悬停高亮；数字等宽字体；主按钮沿用 `.pm-btn.primary` 渐变；新增 `.mk-*` 样式族（作用域 `.plugin-manager-modal`）。

## 文件结构

| 文件 | 操作 |
|------|------|
| `src/lib/pluginMarket.ts` | 新建：类型、双源分页查询、排序比较器、K/M 与日期格式化 |
| `src/components/PluginManager.tsx` | 重构：大 Modal + 市场/终端双视图 + 工具栏状态 |
| `src/styles/global.css` | 追加 `.mk-*` 市场样式 |

终端视图、确认弹框、完成提示等既有机制不变。

## 验证

cargo check + pnpm build；tauri:dev 手动：双源切换/搜索/排序/翻页、安装→终端流程→完成后行内变为卸载、已安装计数正确、模糊玻璃效果与整体观感。

## 不做的事

- 不做无限滚动（用页码器）；不做收藏/详情页；不为 GitHub 下载数引入第三方代理；不做 token 配置（后续可加）。
