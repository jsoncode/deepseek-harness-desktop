# 插件市场弹框重构 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。

**目标：** 插件管理弹框重构为大尺寸插件市场：GitHub/NPM 双源、搜索、三字段排序、分页表格（序号/头像/名称/作者/下载/版本/Stars/日期/操作），毛玻璃视觉；操作复用现有 CLI 执行链路。

**规格：** `docs/superpowers/specs/2026-08-25-plugin-market-design.md`

---

### 任务 1：数据层 `src/lib/pluginMarket.ts`（新建）

完整实现：

```ts
/** 插件市场数据源：GitHub 主题仓库搜索 + npm 关键字搜索 */

export type MarketSource = "github" | "npm";
export type MarketSort = "weekly" | "stars" | "date";

export interface MarketPlugin {
  key: string;
  name: string;
  author: string;
  avatarUrl: string | null;
  weekly: number | null;
  monthly: number | null;
  stars: number | null;
  version: string | null;
  releasedAt: string | null; // ISO
}

export interface MarketPage {
  total: number;
  items: MarketPlugin[];
}

const GH_PAGE_SIZE = 20;
const NPM_PAGE_SIZE = 20;

export function pageSizeOf(source: MarketSource): number {
  return source === "github" ? GH_PAGE_SIZE : NPM_PAGE_SIZE;
}

export class RateLimitedError extends Error {}

async function fetchJson<T>(url: string, timeoutMs = 10000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

interface GhItem {
  name: string;
  full_name: string;
  stargazers_count?: number;
  pushed_at?: string;
  created_at?: string;
  owner?: { login?: string; avatar_url?: string };
}

/** 拉取一页市场列表；GitHub 的 stars/date 走服务端排序，NPM 在客户端排当前页 */
export async function fetchMarketPage(
  source: MarketSource,
  page: number,
  query: string,
  sort: MarketSort,
): Promise<MarketPage> {
  if (source === "github") {
    const q = `topic:dsh-plugin${query ? ` ${query}` : ""}`;
    const sortParam =
      sort === "stars"
        ? "&sort=stars&order=desc"
        : sort === "date"
          ? "&sort=updated&order=desc"
          : "";
    const url =
      `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}` +
      `${sortParam}&per_page=${GH_PAGE_SIZE}&page=${page}`;
    let g: { total_count: number; items: GhItem[] };
    try {
      g = await fetchJson(url);
    } catch (e) {
      if (String(e).includes("403")) throw new RateLimitedError("GitHub 搜索速率受限，请稍后再试");
      throw e;
    }
    return {
      total: g.total_count ?? 0,
      items: (g.items ?? []).map((it) => ({
        key: it.full_name,
        name: it.name,
        author: it.owner?.login ?? "—",
        avatarUrl: it.owner?.avatar_url ?? null,
        weekly: null,
        monthly: null,
        stars: it.stargazers_count ?? null,
        version: null,
        releasedAt: it.pushed_at ?? it.created_at ?? null,
      })),
    };
  }

  const text = `keywords:dsh-plugin${query ? ` ${query}` : ""}`;
  const from = (page - 1) * NPM_PAGE_SIZE;
  const url =
    `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(text)}` +
    `&size=${NPM_PAGE_SIZE}&from=${from}`;
  const n = await fetchJson<{
    total: number;
    objects: Array<{
      downloads?: { weekly?: number; monthly?: number };
      package: { name: string; version?: string; date?: string; publisher?: { username?: string } };
    }>;
  }>(url);
  const items: MarketPlugin[] = (n.objects ?? []).map((o) => ({
    key: o.package.name,
    name: o.package.name,
    author: o.package.publisher?.username ?? "—",
    avatarUrl: o.package.publisher?.username
      ? `https://github.com/${o.package.publisher.username}.png?size=64`
      : null,
    weekly: o.downloads?.weekly ?? null,
    monthly: o.downloads?.monthly ?? null,
    stars: null,
    version: o.package.version ?? null,
    releasedAt: o.package.date ?? null,
  }));
  if (sort === "weekly") items.sort((a, b) => (b.weekly ?? -1) - (a.weekly ?? -1));
  else if (sort === "date")
    items.sort(
      (a, b) => new Date(b.releasedAt ?? 0).getTime() - new Date(a.releasedAt ?? 0).getTime(),
    );
  return { total: n.total ?? 0, items };
}

/** 数字格式化：1.2K / 3.4M */
export function formatCount(n: number | null): string {
  if (n === null || n === undefined) return "—";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

/** ISO → YYYY-MM-DD */
export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().slice(0, 10);
}
```

- [ ] 验证 `pnpm build` exit=0 → commit `feat(market): 双源分页查询与格式化工具`

### 任务 2：PluginManager 重构为市场视图 + CSS

- [ ] `src/components/PluginManager.tsx`：
  - 删除原 list 视图 JSX 与相关简单状态，新增市场状态与 effect：

```tsx
const [source, setSource] = useState<MarketSource>("npm");
const [tabMode, setTabMode] = useState<"all" | "installed">("all");
const [queryInput, setQueryInput] = useState("");
const [query, setQuery] = useState("");
const [sort, setSort] = useState<MarketSort>("weekly");
const [page, setPage] = useState(1);
const [market, setMarket] = useState<MarketPage | null>(null);
const [marketLoading, setMarketLoading] = useState(false);
const [marketError, setMarketError] = useState<string | null>(null);

// 搜索防抖
useEffect(() => {
  const t = setTimeout(() => { setQuery(queryInput); setPage(1); }, 400);
  return () => clearTimeout(t);
}, [queryInput]);

// 市场数据拉取
useEffect(() => {
  if (!open || view !== "market" || tabMode !== "all") return;
  let alive = true;
  setMarketLoading(true);
  setMarketError(null);
  fetchMarketPage(source, page, query, sort)
    .then((p) => { if (alive) setMarket(p); })
    .catch((e) => { if (alive) setMarketError(String(e instanceof Error ? e.message : e)); })
    .finally(() => { if (alive) setMarketLoading(false); });
  return () => { alive = false; };
}, [open, view, tabMode, source, query, sort, page]);

const switchSource = (s: MarketSource) => {
  setSource(s); setSort(s === "github" ? "stars" : "weekly"); setPage(1); setQuery(""); setQueryInput("");
};
```

  - Modal：`width={1080}`、title 节点内右侧放双源分段按钮；view 改为 `"market" | "terminal"`；
  - 工具栏：搜索 Input + 所有插件(`formatCount(total)`) / 已安装(plugins.length) chips + 排序 chip 组（周下载在 github 禁用、Stars 在 npm 禁用）+「手动安装」入口保留；
  - 表格：`.mk-table` grid 行（列模板见 CSS），行操作按已安装/过期规则渲染 安装/更新/卸载（安装传包名或 `github:{full_name}`），全部 disabled={running} 并走 confirmOp 同款确认；
  - 已安装 tab 渲染 store.plugins + pluginVers 版本与最新提示；
  - 底部分页器 + footer 关闭。
- [ ] `src/styles/global.css` 追加 `.mk-*` 样式族（toolbar/seg/chips/table/grid 模板/avatar 回退/pager/限流横幅）。
- [ ] `pnpm build` exit=0 → commit `feat(ui): 插件管理弹框重构为双源插件市场`

### 任务 3：回归验证

- [ ] 手动清单：
  1. 大弹框毛玻璃效果、双源切换计数变化；
  2. NPM：周/月下载数据真实、按周下载排序生效、搜索过滤、翻页；
  3. GitHub：头像/stars/日期正确、按 Stars 服务端排序、无下载数显示 —；
  4. 安装一个未装插件→终端流程→完成后行内变 卸载(+本机版本括号)；卸载恢复安装按钮；
  5. 已安装 tab 计数与内容正确；手动安装入口可用；
  6. 回归：终止/后台运行、完成提示、健康指示灯不受影响。
- [ ] 收尾提交与推送前确认。
