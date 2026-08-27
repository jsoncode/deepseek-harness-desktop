/**
 * 插件市场数据源：GitHub 仓库搜索 + npm 包搜索。
 * 打包版 WebView 的 CSP connect-src 不含外网域名，前端直连会被拦截，
 * 因此桌面端经 Rust 命令 http_get_json 代理请求；浏览器预览模式保留原生 fetch。
 *
 * 搜索策略：服务端关键词分页搜索 —— 保持 page/pageSize 参数，由调用方负责提交时机与分页重置。
 * 全部采用字段级精准匹配，规避平台全文分词造成的模糊结果（实测裸词 dsh-jenkins
 * 会被 npm 按 "-" 分词全文匹配命中 1 万+ 条）：
 * - NPM：不整体替换关键词，而是在基础词 keywords:dsh-plugin 上叠加三路字段匹配
 *   （name/author/maintainer），并发请求后客户端并集去重、排序再截断为一页条数；
 * - GitHub：在基础词 topic:dsh-plugin 上先查仓库名（in:name），当页不足一整页时
 *   才补发 author:<词> 一路（节省未认证约 10 次/分钟 的限流配额），同样并集去重截断；
 * - 未输入关键词时使用默认全集词（dsh-plugin）；自带限定语法（keywords:/topic:/in: 等）原样透传。
 */
import { api, tauri } from "./tauri";

export type MarketSource = "github" | "npm";
export type MarketSort = "weekly" | "stars" | "date";

export interface MarketPlugin {
  key: string;
  name: string;
  /** 安装时传给 `dsh plugin add` 的规格：NPM 为包名，GitHub 为 github:{full_name} */
  spec: string;
  author: string;
  avatarUrl: string | null;
  description: string | null;
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

/** 默认搜索词：未输入关键词时展示 dsh-plugin 插件全集 */
const DEFAULT_TERMS: Record<MarketSource, string> = {
  github: "topic:dsh-plugin",
  npm: "keywords:dsh-plugin",
};

/** 判断查询是否自带平台搜索限定符（keywords:/topic:/in:/author: 等），带则原样透传 */
function hasSearchQualifier(q: string): boolean {
  return /^[a-z][a-z0-9_-]*:/i.test(q.trim());
}

/** NPM 联合搜索的字段路：普通关键词在三路中任一命中即展示（客户端并集去重） */
const NPM_UNION_FIELDS = ["name", "author", "maintainer"] as const;

/**
 * 组装 NPM 多路搜索词（结果取并集）：
 * - 空词 → 单路返回默认全集词 keywords:dsh-plugin；
 * - 自带限定语法原样透传（单路）；
 * - 普通词 → 在基础词 keywords:dsh-plugin 上分别叠加 name/author/maintainer 三路，
 *   如「jenkins」产生 keywords:dsh-plugin name:jenkins / author:jenkins / maintainer:jenkins，
 *   多词短语以引号整体匹配（如 name:"a b"）；三路由 fetchNpmPage 并发请求后合并去重。
 */
function buildNpmTexts(query: string): string[] {
  const term = query.trim();
  if (!term) return [DEFAULT_TERMS.npm];
  if (hasSearchQualifier(term)) return [term];
  const word = /\s/.test(term) ? `"${term.replace(/"/g, "")}"` : term;
  return NPM_UNION_FIELDS.map((field) => `${DEFAULT_TERMS.npm} ${field}:${word}`);
}

/**
 * 组装 GitHub 主路查询词：
 * - 无限定符的词 → topic:dsh-plugin <词> in:name，仅匹配仓库名；
 * - 自带限定语法原样透传；空词回退 dsh-plugin 默认全集词。
 */
function buildGithubPrimaryQ(query: string): string {
  const term = query.trim();
  if (!term) return DEFAULT_TERMS.github;
  if (hasSearchQualifier(term)) return term;
  return `${DEFAULT_TERMS.github} ${term} in:name`;
}

/**
 * GitHub 补充路查询词 author:<词>（匹配仓库属主/组织）：
 * 仅普通关键词需要补充；空词或自带限定语法时返回 null（不补发，节省未认证限流配额）。
 */
function buildGithubAuthorQ(query: string): string | null {
  const term = query.trim();
  if (!term || hasSearchQualifier(term)) return null;
  return `${DEFAULT_TERMS.github} author:${term}`;
}

/** GitHub 未认证搜索限流（约 10 次/分钟）时抛出，UI 显示友好提示 */
export class RateLimitedError extends Error {}

async function fetchJson<T>(url: string, timeoutMs = 10000): Promise<T> {
  // 桌面端：经 Rust 代理请求（绕开打包版 CSP），响应文本由后端原样返回
  if (tauri) {
    const text = await api.httpGetJson(url);
    return JSON.parse(text) as T;
  }
  // 浏览器预览模式：无 Rust 后端，原生 fetch
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
  description?: string | null;
  stargazers_count?: number;
  pushed_at?: string;
  created_at?: string;
  owner?: { login?: string; avatar_url?: string };
}

type GhSearchResponse = { total_count?: number; items?: GhItem[] };

function mapGhItem(it: GhItem): MarketPlugin {
  return {
    key: it.full_name ?? it.name ?? Math.random().toString(36).slice(2),
    name: it.name ?? it.full_name ?? "—",
    spec: `github:${it.full_name ?? it.name ?? ""}`,
    author: it.owner?.login ?? "—",
    avatarUrl: it.owner?.avatar_url ?? null,
    description: it.description?.trim() ? it.description : null,
    // GitHub 不提供仓库级下载数
    weekly: null,
    monthly: null,
    stars: it.stargazers_count ?? null,
    version: null,
    releasedAt: it.pushed_at ?? it.created_at ?? null,
  };
}

interface NpmObject {
  downloads?: { weekly?: number; monthly?: number };
  package?: {
    name?: string;
    version?: string;
    date?: string;
    description?: string | null;
    publisher?: { username?: string };
  };
}

function mapNpmObject(o: NpmObject): MarketPlugin {
  return {
    key: o.package?.name ?? Math.random().toString(36).slice(2),
    name: o.package?.name ?? "—",
    spec: o.package?.name ?? "",
    author: o.package?.publisher?.username ?? "—",
    avatarUrl: o.package?.publisher?.username
      ? `https://github.com/${o.package.publisher.username}.png?size=64`
      : null,
    description: o.package?.description?.trim() ? o.package.description : null,
    weekly: o.downloads?.weekly ?? null,
    monthly: o.downloads?.monthly ?? null,
    stars: null,
    version: o.package?.version ?? null,
    releasedAt: o.package?.date ?? null,
  };
}

/**
 * 按关键词拉取一页市场列表：
 * - 搜索词组装规则见 buildNpmTexts / buildGithubPrimaryQ 与文件头注释（全部精准匹配）；
 * - NPM：name/author/maintainer 三路并发请求，按包名并集去重后客户端排序再截断一页；
 *   个别路失败自动降级为其余路的结果，只有全部失败才抛错（total 取各路最大值，见
 *   fetchNpmPage 内注释——npm 接口对限定符做加权匹配而非硬过滤）；
 * - GitHub：先走 in:name 主路，仅当主路当页不足一整页且存在 author 补充路时补发，
 *   并集去重后截断；stars/date 仍由服务端排序，total 为各已发路 total 之和（近似值）；
 * - 调用方保证翻页/换词时重置 page，避免请求越界页导致搜不到结果。
 */
export async function fetchMarketPage(
  source: MarketSource,
  query: string,
  page: number,
  sort: MarketSort,
): Promise<MarketPage> {
  if (source === "github") return fetchGithubPage(query, page, sort);
  return fetchNpmPage(query, page, sort);
}

function buildGithubUrl(q: string, sortParam: string, page: number): string {
  return (
    `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}` +
    `${sortParam}&per_page=${GH_PAGE_SIZE}&page=${page}`
  );
}

/** 单次 GitHub 搜索：403 → 转为友好的限流提示错误 */
async function fetchGithubSearch(
  q: string,
  sortParam: string,
  page: number,
): Promise<GhSearchResponse> {
  try {
    return await fetchJson<GhSearchResponse>(buildGithubUrl(q, sortParam, page));
  } catch (e) {
    if (String(e).includes("403")) throw new RateLimitedError("GitHub 搜索速率受限，请稍后再试");
    throw e;
  }
}

async function fetchGithubPage(query: string, page: number, sort: MarketSort): Promise<MarketPage> {
  const sortParam =
    sort === "stars"
      ? "&sort=stars&order=desc"
      : sort === "date"
        ? "&sort=updated&order=desc"
        : "";
  // 主路先行；未认证限流配额宝贵（~10 次/分钟），仅当主路当页不足一整页时才补发 author 路
  const primary = await fetchGithubSearch(buildGithubPrimaryQ(query), sortParam, page);
  const authorQ = buildGithubAuthorQ(query);
  const responses: GhSearchResponse[] = [primary];
  if (authorQ && (primary.items?.length ?? 0) < GH_PAGE_SIZE) {
    try {
      responses.push(await fetchGithubSearch(authorQ, sortParam, page));
    } catch {
      // 补充路失败可忽略：主路结果照常展示
    }
  }

  // 并集去重：按仓库 full_name 保留首次出现（in:name 路 → author 路），截断为一页条数
  const seen = new Set<string>();
  const items: MarketPlugin[] = [];
  let total = 0;
  for (const r of responses) {
    total += r.total_count ?? 0;
    for (const it of r.items ?? []) {
      if (items.length >= GH_PAGE_SIZE) break;
      const m = mapGhItem(it);
      if (seen.has(m.key)) continue;
      seen.add(m.key);
      items.push(m);
    }
    if (items.length >= GH_PAGE_SIZE) break;
  }
  return { total, items };
}

function buildNpmUrl(text: string, from: number): string {
  return (
    `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(text)}` +
    `&size=${NPM_PAGE_SIZE}&from=${from}`
  );
}

async function fetchNpmPage(query: string, page: number, sort: MarketSort): Promise<MarketPage> {
  const texts = buildNpmTexts(query);
  const from = (page - 1) * NPM_PAGE_SIZE;
  // 三路并发请求；个别路失败静默降级（npm 接口偶发抖动时不至于整页空白）
  const settled = await Promise.allSettled(
    texts.map((text) => fetchJson<{ total?: number; objects?: NpmObject[] }>(buildNpmUrl(text, from))),
  );

  let okCount = 0;
  let lastError: unknown;
  // 实测：npm 接口对限定符做加权匹配而非硬过滤，各字段路的 total 均为同一模糊基数，
  // 求和会虚高约 N 倍，故取最大值近似并集总量；子项仍按三路并集去重。
  let total = -1;
  // 并集去重：按包名保留首次出现（name 路 → author 路 → maintainer 路）
  const seen = new Set<string>();
  const merged: MarketPlugin[] = [];
  for (const r of settled) {
    if (r.status !== "fulfilled") {
      lastError = r.reason;
      continue;
    }
    okCount++;
    total = Math.max(total, r.value.total ?? 0);
    for (const o of r.value.objects ?? []) {
      const m = mapNpmObject(o);
      if (seen.has(m.key)) continue;
      seen.add(m.key);
      merged.push(m);
    }
  }
  if (okCount === 0) throw lastError;

  // NPM 不支持全量排序：对合并后的并集排序，再截断为一页条数
  if (sort === "weekly") merged.sort((a, b) => (b.weekly ?? -1) - (a.weekly ?? -1));
  else if (sort === "date")
    merged.sort(
      (a, b) => new Date(b.releasedAt ?? 0).getTime() - new Date(a.releasedAt ?? 0).getTime(),
    );
  return { total, items: merged.slice(0, NPM_PAGE_SIZE) };
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
