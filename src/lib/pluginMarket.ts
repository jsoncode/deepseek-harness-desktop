/**
 * 插件市场数据源：GitHub 仓库搜索 + npm 包搜索。
 * 打包版 WebView 的 CSP connect-src 不含外网域名，前端直连会被拦截，
 * 因此桌面端经 Rust 命令 http_get_json 代理请求；浏览器预览模式保留原生 fetch。
 *
 * 搜索策略：服务端关键词分页搜索 —— 保持 page/pageSize 参数，由调用方负责防抖与分页重置。
 * 全部采用字段级精准匹配，规避平台全文分词造成的模糊结果（实测裸词 dsh-jenkins
 * 会被 npm 按 "-" 分词全文匹配命中 1 万+ 条）：
 * - NPM：keywords:<词> 关键字字段精确匹配；多词短语以引号整体匹配 keywords:"a b"；
 * - GitHub：<词> in:name 仅匹配仓库名；
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

/**
 * 组装 NPM 精准搜索词：
 * - 单个无限定符的词 → keywords:<词>，关键字字段精确匹配（如 dsh-jenkins 仅命中同名插件）；
 * - 多词短语 → keywords:"a b"，去掉内部引号后作为整体关键字短语匹配；
 * - 自带限定语法原样透传；空词回退 dsh-plugin 默认全集词。
 */
function buildNpmText(query: string): string {
  const term = query.trim();
  if (!term) return DEFAULT_TERMS.npm;
  if (hasSearchQualifier(term)) return term;
  if (/\s/.test(term)) return `keywords:"${term.replace(/"/g, "")}"`;
  return `keywords:${term}`;
}

/**
 * 组装 GitHub 精准搜索词：
 * - 无限定符的词 → <词> in:name，仅匹配仓库名（避免描述/README 带来的模糊命中）；
 * - 自带限定语法原样透传；空词回退 dsh-plugin 默认全集词。
 */
function buildGithubQ(query: string): string {
  const term = query.trim();
  if (!term) return DEFAULT_TERMS.github;
  if (hasSearchQualifier(term)) return term;
  return `${term} in:name`;
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
 * - 搜索词组装规则见 buildNpmText / buildGithubQ 与文件头注释（全部精准匹配）；
 *   GitHub stars/date 走服务端排序，NPM 接口不支持全量排序，在客户端排当前页；
 * - 调用方保证翻页/换词时重置 page，避免请求越界页导致搜不到结果。
 */
export async function fetchMarketPage(
  source: MarketSource,
  query: string,
  page: number,
  sort: MarketSort,
): Promise<MarketPage> {
  if (source === "github") {
    const ghQ = buildGithubQ(query);
    const sortParam =
      sort === "stars"
        ? "&sort=stars&order=desc"
        : sort === "date"
          ? "&sort=updated&order=desc"
          : "";
    const url =
      `https://api.github.com/search/repositories?q=${encodeURIComponent(ghQ)}` +
      `${sortParam}&per_page=${GH_PAGE_SIZE}&page=${page}`;
    let g: GhSearchResponse;
    try {
      g = await fetchJson(url);
    } catch (e) {
      if (String(e).includes("403")) throw new RateLimitedError("GitHub 搜索速率受限，请稍后再试");
      throw e;
    }
    return {
      total: g.total_count ?? 0,
      items: (g.items ?? []).map(mapGhItem),
    };
  }

  const text = buildNpmText(query);
  const from = (page - 1) * NPM_PAGE_SIZE;
  const url =
    `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(text)}` +
    `&size=${NPM_PAGE_SIZE}&from=${from}`;
  const n = await fetchJson<{ total?: number; objects?: NpmObject[] }>(url);

  const items: MarketPlugin[] = (n.objects ?? []).map(mapNpmObject);
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
