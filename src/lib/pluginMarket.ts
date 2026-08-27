/**
 * 插件市场数据源：GitHub 仓库搜索 + npm 包搜索。
 * 打包版 WebView 的 CSP connect-src 不含外网域名，前端直连会被拦截，
 * 因此桌面端经 Rust 命令 http_get_json 代理请求；浏览器预览模式保留原生 fetch。
 *
 * 搜索策略：服务端关键词分页搜索 —— 保持 page/pageSize 参数，由调用方负责提交时机与分页重置。
 * 全部采用字段级精准匹配，规避平台全文分词造成的模糊结果（实测裸词 dsh-jenkins
 * 会被 npm 按 "-" 分词全文匹配命中 1 万+ 条）：
 * - NPM：普通关键词走三路并集（并发）：①author: ②maintainer: 由服务端硬过滤，
 *   命中的包整体排在最前；③name: 不做硬过滤（实测 total 不变）但参与相关度加权、
 *   会把名称命中浮到本路最前，取 250 条大窗口后由客户端按包名/发布者/维护者
 *   归一化包含严格校验兜底。并集去重后整体排序、客户端切片分页，同一关键词复用
 *   缓存结果（total 为过滤后精确总数）；空词/自带限定语法仍为单路服务端分页；
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

/** npm 搜索单次返回的候选窗口上限（接口允许的最大 size，用于候选路一次拉足） */
const NPM_CANDIDATE_SIZE = 250;

/** 归一化：小写并去掉 -/_/. 与空白 —— dsh_jenkins / DshJenkins / dsh-jenkins 同形 */
function normalizeTerm(s: string): string {
  return s.toLowerCase().replace(/[-_.\s]/g, "");
}

/** NPM 并集搜索的字段路：author/maintainer 命中置前，name 路兜底候选 */
type NpmRouteField = "author" | "maintainer" | "name";
interface NpmRoute {
  field: NpmRouteField;
  text: string;
}

/**
 * 组装 NPM 搜索计划：
 * - 空词 / 自带限定语法 → 单路服务端分页（plain）；
 * - 普通词 → 三路并集（exact，并发请求后客户端合并）：
 *   ①author: ②maintainer: 两路由服务端硬过滤，命中的包整体排在最前；
 *   ③name: 不做硬过滤（实测 total 不变）但参与相关度加权、名称命中会浮到本路最前，
 *   取大窗口后由客户端按包名/发布者/维护者归一化包含严格校验兜底。
 *   多词短语以引号整体匹配。
 */
function buildNpmRoutes(query: string): { exact: false; plain: string } | { exact: true; routes: NpmRoute[] } {
  const term = query.trim();
  if (!term) return { exact: false, plain: DEFAULT_TERMS.npm };
  if (hasSearchQualifier(term)) return { exact: false, plain: term };
  const word = /\s/.test(term) ? `"${term.replace(/"/g, "")}"` : term;
  const base = DEFAULT_TERMS.npm;
  return {
    exact: true,
    routes: [
      { field: "author", text: `${base} author:${word}` },
      { field: "maintainer", text: `${base} maintainer:${word}` },
      { field: "name", text: `${base} name:${word}` },
    ],
  };
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
 * 按关键词拉取一页市场列表：
 * - 搜索词组装规则见 buildNpmRouteTexts / buildGithubPrimaryQ 与文件头注释（全部精准匹配）；
 * - NPM：双路并发（维护者路服务端硬过滤 + 候选路客户端包名校验），并集去重后整体
 *   排序、按页切片，total 为过滤后精确总数；个别路失败自动降级为另一路的结果；
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

function buildNpmUrl(text: string, size: number, from: number): string {
  return (
    `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(text)}` +
    `&size=${size}&from=${from}`
  );
}

/** NPM 客户端严格校验：包名归一化包含，或发布者/维护者用户名命中（归一化包含） */
function npmObjectMatches(o: NpmObject, term: string): boolean {
  const t = normalizeTerm(term);
  if (!t) return true;
  const name = o.package?.name;
  if (name && normalizeTerm(name).includes(t)) return true;
  const users = [
    o.package?.publisher?.username ?? "",
    ...(o.package?.maintainers ?? []).map((m) => m.username ?? ""),
  ];
  return users.some((u) => u && normalizeTerm(u).includes(t));
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

interface NpmQueryCache {
  key: string;
  /** 过滤后的完整结果集：排序随每次调用重做，切片分页直接取窗口 */
  list: MarketPlugin[];
}

/**
 * 普通关键词的过滤结果缓存：客户端过滤使服务端 from 分页失真（跨页有洞），
 * 因此一次拉足候选窗口并缓存过滤后的全集，翻页/改排序直接复用不重发请求；
 * 换关键词即整条替换。
 */
let npmCache: NpmQueryCache | null = null;

async function fetchJsonNpm(text: string, size: number, from: number) {
  return fetchJson<{ total?: number; objects?: NpmObject[] }>(buildNpmUrl(text, size, from));
}

async function loadNpmExactList(query: string): Promise<MarketPlugin[]> {
  const plan = buildNpmRoutes(query);
  if (!plan.exact) return [];
  // 三路并发：author/maintainer 路由服务端硬过滤，name 路只提供相关度排序，
  // 拉满窗口后交给客户端校验。个别路失败静默降级，全部失败才抛错。
  const settled = await Promise.allSettled(
    plan.routes.map((r) => fetchJsonNpm(r.text, NPM_CANDIDATE_SIZE, 0)),
  );

  let okCount = 0;
  let lastError: unknown;
  const seen = new Set<string>();
  // 两桶合并（去重后 author/maintainer 桶整体置前）：
  // - 属主桶：author:/maintainer: 服务端已过滤出「属主与关键词匹配」的包，无需再校验；
  // - 名称桶：接口忽略 name: 过滤会混入无关包，按包名/发布者/维护者归一化包含严格校验。
  const ownerItems: MarketPlugin[] = [];
  const nameItems: MarketPlugin[] = [];
  settled.forEach((r, i) => {
    if (r.status !== "fulfilled") {
      lastError = r.reason;
      return;
    }
    okCount++;
    const field = plan.routes[i].field;
    for (const o of r.value.objects ?? []) {
      const m = mapNpmObject(o);
      if (seen.has(m.key)) continue;
      if (field === "name") {
        if (!npmObjectMatches(o, query.trim())) continue;
        nameItems.push(m);
      } else {
        ownerItems.push(m);
      }
      seen.add(m.key);
    }
  });
  if (okCount === 0) throw lastError;
  return [...ownerItems, ...nameItems];
}

async function fetchNpmPage(query: string, page: number, sort: MarketSort): Promise<MarketPage> {
  const plan = buildNpmRoutes(query);

  // 空词 / 自带限定语法：单路、结果即全集，保持原来的服务端分页语义
  if (!plan.exact) {
    const n = await fetchJsonNpm(plan.plain, NPM_PAGE_SIZE, (page - 1) * NPM_PAGE_SIZE);
    const items = (n.objects ?? []).map(mapNpmObject);
    return { total: n.total ?? 0, items: sortNpmItems(items, sort).slice(0, NPM_PAGE_SIZE) };
  }

  // 普通关键词：取合并全集（缓存），total 精确；翻页/改排序不再发请求
  const key = query.trim().toLowerCase();
  if (!npmCache || npmCache.key !== key) {
    npmCache = { key, list: await loadNpmExactList(query) };
  }
  const sorted = sortNpmItems(npmCache.list, sort);
  return {
    total: npmCache.list.length,
    items: sorted.slice((page - 1) * NPM_PAGE_SIZE, page * NPM_PAGE_SIZE),
  };
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
