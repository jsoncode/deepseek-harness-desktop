/**
 * 插件市场数据源：GitHub 仓库搜索 + npm 包搜索。
 * 打包版 WebView 的 CSP connect-src 不含外网域名，前端直连会被拦截，
 * 因此桌面端经 Rust 命令 http_get_json 代理请求；浏览器预览模式保留原生 fetch。
 *
 * 搜索策略（单一请求 + 服务端分页，杜绝旧版多路拼接/客户端过滤造成的失真）：
 * - NPM：URL 只保留 text 与分页参数（size/from），其他参数一律不带。
 *   未输入关键词 → text=keywords:dsh-plugin（dsh 插件全集）；
 *   输入关键词 → text=keywords:{关键词}（按包声明的 keywords 精确匹配）；
 *   用户自带限定符（keywords:/author: 等）时原样透传，避免双重前缀；
 * - GitHub：URL 只保留 q 与分页参数（per_page/page）。未输入关键词 →
 *   q=dsh-plugin；输入关键词 → q={关键词} 原样作为搜索词，不追加任何限定符
 *   （用户可自带 topic:/in: 等语法，平台直接解析）；
 * - 排序：GitHub stars/date 走服务端 sort 参数；npm 接口无排序参数，
 *   周下载/发布日期在客户端对当前页排序（保持旧行为）。
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
  github: "dsh-plugin",
  npm: "keywords:dsh-plugin",
};

/** 判断用户输入是否自带搜索限定符（keywords:/author: 等）：带则原样透传，避免双重前缀 */
function hasSearchQualifier(q: string): boolean {
  return /^[a-z][a-z0-9_-]*:/i.test(q.trim());
}

/**
 * 组装 NPM 搜索 text 参数：
 * - 空词 → keywords:dsh-plugin 默认全集；
 * - 自带限定符 → 原样透传；
 * - 普通关键词 → keywords:{词}（按包声明 keywords 匹配）。
 */
function buildNpmText(query: string): string {
  const term = query.trim();
  if (!term) return DEFAULT_TERMS.npm;
  if (hasSearchQualifier(term)) return term;
  return `keywords:${term}`;
}

/**
 * 组装 GitHub 搜索 q 参数：
 * - 空词 → dsh-plugin 默认全集；
 * - 关键词原样作为搜索词，不追加任何限定符（自带 topic:/in: 等语法可直接生效）。
 */
function buildGithubQ(query: string): string {
  const term = query.trim();
  return term || DEFAULT_TERMS.github;
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
    maintainers?: Array<{ username?: string }>;
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
 * 按关键词拉取一页市场列表（单一请求、纯服务端分页）：
 * - 搜索词组装规则见 buildNpmText / buildGithubQ 与文件头注释；
 * - total 为服务端返回的真实命中总数，直接驱动分页；
 * - 调用方保证换词时重置 page，避免请求越界页导致搜不到结果。
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
  const r = await fetchGithubSearch(buildGithubQ(query), sortParam, page);
  return { total: r.total_count ?? 0, items: (r.items ?? []).map(mapGhItem) };
}

function buildNpmUrl(text: string, size: number, from: number): string {
  return (
    `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(text)}` +
    `&size=${size}&from=${from}`
  );
}

/** 排序副本：weekly/date 在客户端排；默认（相关度）不动 */
function sortNpmItems(items: MarketPlugin[], sort: MarketSort): MarketPlugin[] {
  const list = [...items];
  if (sort === "weekly") list.sort((a, b) => (b.weekly ?? -1) - (a.weekly ?? -1));
  else if (sort === "date")
    list.sort(
      (a, b) => new Date(b.releasedAt ?? 0).getTime() - new Date(a.releasedAt ?? 0).getTime(),
    );
  return list;
}

async function fetchNpmPage(query: string, page: number, sort: MarketSort): Promise<MarketPage> {
  const text = buildNpmText(query);
  const n = await fetchJson<{ total?: number; objects?: NpmObject[] }>(
    buildNpmUrl(text, NPM_PAGE_SIZE, (page - 1) * NPM_PAGE_SIZE),
  );
  const items = (n.objects ?? []).map(mapNpmObject);
  // npm 无服务端排序参数：周下载/发布日期在客户端对当前页排序
  return { total: n.total ?? 0, items: sortNpmItems(items, sort) };
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
