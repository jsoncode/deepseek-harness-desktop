/**
 * 插件市场数据源：GitHub 主题仓库搜索 + npm 关键字搜索。
 * 两个接口均为公开 CORS 端点，前端直连无需后端转发。
 */

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

/** GitHub 未认证搜索限流（约 10 次/分钟）时抛出，UI 显示友好提示 */
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
  name?: string;
  full_name?: string;
  stargazers_count?: number;
  pushed_at?: string;
  created_at?: string;
  owner?: { login?: string; avatar_url?: string };
}

/** 拉取一页市场列表。GitHub 的 stars/date 走服务端排序；NPM 接口不支持全量排序，在客户端排当前页 */
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
    let g: { total_count?: number; items?: GhItem[] };
    try {
      g = await fetchJson(url);
    } catch (e) {
      if (String(e).includes("403")) throw new RateLimitedError("GitHub 搜索速率受限，请稍后再试");
      throw e;
    }
    return {
      total: g.total_count ?? 0,
      items: (g.items ?? []).map((it) => ({
        key: it.full_name ?? it.name ?? Math.random().toString(36).slice(2),
        name: it.name ?? it.full_name ?? "—",
        author: it.owner?.login ?? "—",
        avatarUrl: it.owner?.avatar_url ?? null,
        // GitHub 不提供仓库级下载数
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
    total?: number;
    objects?: Array<{
      downloads?: { weekly?: number; monthly?: number };
      package?: {
        name?: string;
        version?: string;
        date?: string;
        publisher?: { username?: string };
      };
    }>;
  }>(url);

  const items: MarketPlugin[] = (n.objects ?? []).map((o) => ({
    key: o.package?.name ?? Math.random().toString(36).slice(2),
    name: o.package?.name ?? "—",
    author: o.package?.publisher?.username ?? "—",
    avatarUrl: o.package?.publisher?.username
      ? `https://github.com/${o.package.publisher.username}.png?size=64`
      : null,
    weekly: o.downloads?.weekly ?? null,
    monthly: o.downloads?.monthly ?? null,
    stars: null,
    version: o.package?.version ?? null,
    releasedAt: o.package?.date ?? null,
  }));
  if (sort === "weekly") items.sort((a, b) => (b.weekly ?? -1) - (a.weekly ?? -1));
  else if (sort === "date")
    items.sort(
      (a, b) => new Date(b.releasedAt ?? 0).getTime() - new Date(a.releasedAt ?? 0).getTime(),
    );
  return { total: n.total ?? 0, items };
}

/** 数字格式化：1.2K / 3.4M；空值显示 — */
export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

/** ISO → YYYY-MM-DD */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().slice(0, 10);
}
