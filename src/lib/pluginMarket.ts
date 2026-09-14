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
 * - 作者推荐（author）：检索式固定为 AUTHOR_QUERY（dsh- user:jsoncode），
 *   不接受用户关键词，走的仍是 GitHub 仓库搜索接口与同一套分页/排序规则，
 *   因此 UI 上无需搜索框；**安装规格优先 npm**：每个仓库先在 npm registry 直查
 *   同名包（精确命中、无搜索限流），latest 版本声明 keywords:dsh-plugin 才采纳
 *   （防同名无关包误装），此时安装走 npm 包（可随 npm 版本更新、装的是发布版），
 *   找不到或校验不过再回退 github:{full_name}（拉仓库源码）。结果按仓库名缓存，
 *   翻页/切换来源不重复请求；
 * - 排序：GitHub stars/date 走服务端 sort 参数；npm 接口无排序参数，
 *   周下载/发布日期在客户端对当前页排序（保持旧行为）。
 */
import { api, tauri } from "./tauri";

export type MarketSource = "github" | "npm" | "author";
export type MarketSort = "weekly" | "stars" | "date";

/** 【作者推荐】作者账号（与 AUTHOR_QUERY 保持一致） */
export const AUTHOR_LOGIN = "jsoncode";

/**
 * 【作者推荐】固定检索式：GitHub 上该作者名下的 dsh 系列插件。
 * 原样作为 q 参数发出（见 fetchMarketPage 的 author 分支），不追加任何限定符。
 */
export const AUTHOR_QUERY = `dsh- user:${AUTHOR_LOGIN}`;

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
  /** 源码仓库地址（GitHub）：详情弹框据此显示 Issues 入口并拉取 README；未知为 null */
  repoUrl: string | null;
  /** 缺陷跟踪地址（npm 包可由 package.links.bugs 提供）：优先于 repoUrl 的 /issues */
  issuesUrl: string | null;
}

export interface MarketPage {
  total: number;
  items: MarketPlugin[];
}

const GH_PAGE_SIZE = 20;
const NPM_PAGE_SIZE = 20;

export function pageSizeOf(source: MarketSource): number {
  return source === "npm" ? NPM_PAGE_SIZE : GH_PAGE_SIZE;
}

/** 默认搜索词：未输入关键词时展示 dsh-plugin 插件全集（作者推荐为固定检索式，不在其中） */
const DEFAULT_TERMS: Record<"github" | "npm", string> = {
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
  html_url?: string;
  description?: string | null;
  stargazers_count?: number;
  pushed_at?: string;
  created_at?: string;
  owner?: { login?: string; avatar_url?: string };
}

type GhSearchResponse = { total_count?: number; items?: GhItem[] };

function mapGhItem(it: GhItem): MarketPlugin {
  const full = it.full_name ?? it.name ?? "";
  const repoUrl = it.html_url ?? (full ? `https://github.com/${full}` : null);
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
    repoUrl,
    issuesUrl: repoUrl ? `${repoUrl}/issues` : null,
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
    /** npm 包元数据里的源码仓库 / 缺陷跟踪地址（npm search 接口直接返回，无需二次请求） */
    links?: { repository?: string; bugs?: string; homepage?: string };
  };
}

/**
 * npm `repository` 字段形态不一：可能是字符串、`{url}` 对象，
 * 也可能是 `git+https://github.com/u/r.git`、`git://…` 等 git 协议写法。
 * 统一归一化为可点击的 https 仓库地址；无法识别为非 GitHub 的返回 null
 * （后续的 Issues 入口与 README 拉取都依赖 GitHub API）。
 */
export function normalizeRepoUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim();
  if (!s) return null;
  // github 的简写形式 owner/repo
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) s = `https://github.com/${s}`;
  s = s
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^ssh:\/\/git@/, "https://")
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/\.git$/, "");
  if (!/^https?:\/\//.test(s)) return null;
  try {
    const u = new URL(s);
    if (!/(^|\.)github\.com$/i.test(u.hostname)) return null;
    // 去掉树状路径与片段，只保留 owner/repo 两段
    const seg = u.pathname.replace(/^\/+|\/+$/g, "").split("/").slice(0, 2).join("/");
    return seg ? `https://github.com/${seg}` : null;
  } catch {
    return null;
  }
}

/** npm `bugs` 字段同样可能是字符串或 `{url}` 对象 */
function normalizeBugsUrl(raw: unknown): string | null {
  if (!raw) return null;
  if (typeof raw === "object") {
    const u = (raw as { url?: string }).url;
    return typeof u === "string" && u.startsWith("http") ? u : null;
  }
  return typeof raw === "string" && raw.startsWith("http") ? raw : null;
}

function mapNpmObject(o: NpmObject): MarketPlugin {
  const repoUrl = normalizeRepoUrl(o.package?.links?.repository);
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
    repoUrl,
    // npm 显式声明 bugs.url 高于推导出的 /issues（部分包用 issue tracker 而非 GitHub Issues）
    issuesUrl: normalizeBugsUrl(o.package?.links?.bugs) ?? (repoUrl ? `${repoUrl}/issues` : null),
  };
}

/**
 * 按关键词拉取一页市场列表（单一请求、纯服务端分页）：
 * - 搜索词组装规则见 buildNpmText / buildGithubQ 与文件头注释；
 * - author（作者推荐）忽略调用方关键词，使用固定检索式 AUTHOR_QUERY；
 * - total 为服务端返回的真实命中总数，直接驱动分页；
 * - 调用方保证换词时重置 page，避免请求越界页导致搜不到结果。
 */
export async function fetchMarketPage(
  source: MarketSource,
  query: string,
  page: number,
  sort: MarketSort,
): Promise<MarketPage> {
  if (source === "author") return fetchGithubPage(AUTHOR_QUERY, page, sort, true);
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

/** GitHub 搜索的排序参数：stars / updated 走服务端，相关度（默认）不带参数 */
function githubSortParam(sort: MarketSort): string {
  if (sort === "stars") return "&sort=stars&order=desc";
  if (sort === "date") return "&sort=updated&order=desc";
  return "";
}

/**
 * GitHub 仓库搜索一页。
 * @param q 检索式；raw=true 时原样发出（作者推荐的固定检索式），
 *          否则走 buildGithubQ 补齐「未输入关键词 → dsh-plugin 全集」的默认词。
 *          raw（作者推荐）时逐仓解析 npm 同名包：命中则安装规格改用 npm 包名。
 */
async function fetchGithubPage(
  q: string,
  page: number,
  sort: MarketSort,
  raw = false,
): Promise<MarketPage> {
  const r = await fetchGithubSearch(raw ? q : buildGithubQ(q), githubSortParam(sort), page);
  const items = (r.items ?? []).map(mapGhItem);
  if (!raw) return { total: r.total_count ?? 0, items };
  // 作者推荐：逐仓解析 npm 同名包（并发直查 registry），命中改用 npm 规格。
  // 单个解析失败不影响整页：该行回退 github: 规格。
  const resolved = await Promise.allSettled(items.map((it) => resolveNpmForRepo(it.name)));
  const enriched = items.map((it, i) => {
    const hit = resolved[i].status === "fulfilled" ? resolved[i].value : null;
    // 版本列改显 npm 最新版（安装来源即 npm）；releasedAt 保持 GitHub pushed_at——
    // 本页排序是服务端按 pushed_at 排的，改掉会让日期列与排序脱节
    return hit ? { ...it, spec: hit.name, version: hit.version } : it;
  });
  return { total: r.total_count ?? 0, items: enriched };
}

/** npm packument 摘要（直查单个包用） */
interface NpmPackument {
  "dist-tags"?: Record<string, string>;
  versions?: Record<string, { keywords?: string[] } | undefined>;
}

interface ResolvedNpm {
  /** npm 包名（= 仓库名），作为 dsh plugin add 的规格 */
  name: string;
  /** dist-tags.latest，供版本列展示 */
  version: string | null;
}

// ---------------------------------------------------------------------------
// 本应用自身（DeepSeek Harness Desktop / dsh CLI）识别
// ---------------------------------------------------------------------------

/**
 * 宿主自身的包名/仓库名（小写、已归一化分隔符后）：
 * - deepseek-harness-desktop / deepseek-harness / harness-desktop / deepseek_harness…
 * - dsh / @deepseek-ai/dsh（dsh CLI 的包名与 bin 名）
 *
 * 归一化（去掉 - _ . / 空白与 @ 作用域前缀）后比较，因此 NPM 搜索结果里的
 * `@deepseek-ai/dsh`、GitHub 上的 `deepseek-harness-desktop`、手动输入
 * `dsh` / `deepseek_harness` 都会命中。
 */
const SELF_PACKAGE_KEYS = new Set([
  "deepseekharnessdesktop",
  "deepseekharness",
  "harnessdesktop",
  "dsh",
  "deepseekaidsh",
]);

/**
 * 判断一个插件名/安装规格是否指向本应用自身（宿主 dsh CLI 或桌面壳仓库）。
 * 用于把「安装本应用」从插件市场引流到「关于本应用」的 dsh CLI 更新弹框——
 * 把它当普通插件装只会注入一份重复/过期的宿主，正确做法是更新 dsh CLI。
 */
export function isSelfPackage(nameOrSpec: string | null | undefined): boolean {
  if (!nameOrSpec) return false;
  // 去掉协议/来源前缀（github:、npm:、git+…）与仓库 owner（user/repo 里的 user），
  // 再归一化比较：github:jsoncode/deepseek-harness-desktop 也要能命中。
  let raw = nameOrSpec.trim().toLowerCase().replace(/^(github:|git\+|npm:)/, "");
  if (raw.includes("/")) raw = raw.slice(raw.lastIndexOf("/") + 1);
  const key = raw.replace(/^@/, "").replace(/[-_./\s@]/g, "");
  return SELF_PACKAGE_KEYS.has(key);
}

/** npm 解析缓存（会话内，按仓库名）：翻页/切来源不重复请求 */
const npmResolveCache = new Map<string, Promise<ResolvedNpm | null>>();

/**
 * 在 npm 上找与仓库同名的 dsh 插件包：registry 直查（精确命中、无搜索限流）。
 * 采纳条件：存在 dist-tags.latest，且该版本声明 keywords 含 dsh-plugin——
 * 防止同名无关包被误当插件安装。404（未发布）/网络失败/校验不过 → null（回退 github:）。
 */
function resolveNpmForRepo(name: string): Promise<ResolvedNpm | null> {
  let p = npmResolveCache.get(name);
  if (!p) {
    p = doResolveNpm(name);
    npmResolveCache.set(name, p);
  }
  return p;
}

async function doResolveNpm(name: string): Promise<ResolvedNpm | null> {
  try {
    const doc = await fetchJson<NpmPackument>(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
    const latest = doc["dist-tags"]?.latest;
    if (!latest) return null;
    const keywords = doc.versions?.[latest]?.keywords;
    if (!Array.isArray(keywords) || !keywords.includes("dsh-plugin")) return null;
    return { name, version: latest };
  } catch {
    return null;
  }
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

// ---------------------------------------------------------------------------
// README 拉取（插件详情弹框）
// ---------------------------------------------------------------------------

/**
 * README 拉取结果：
 * - `ok`：拿到正文（markdown 原文）；
 * - `empty`：仓库没有 README（GitHub 返回 404）；
 * - `error`：网络失败 / 限流 / 其他异常。
 * 用状态而非抛异常，是因为弹框需要区分「暂无 README」与「加载失败」两种提示。
 */
export type ReadmeResult =
  | { state: "ok"; markdown: string }
  | { state: "empty" }
  | { state: "error"; message: string };

/** README 正文体积上限：超长仓库（如 monorepo 全量说明）截断，避免弹框渲染卡顿 */
const README_MAX_CHARS = 60000;

/** 会话内 README 缓存（按仓库地址）：同一插件反复打开详情不重复请求 */
const readmeCache = new Map<string, Promise<ReadmeResult>>();

/**
 * 拉取 GitHub 仓库 README 并返回 Markdown 原文。
 *
 * 走 `api.github.com/repos/{owner}/{repo}/readme` + `Accept: application/vnd.github.raw`：
 * 该接口会自动定位默认分支下的 README（大小写/扩展名各异的 *.md / *.rst 均可命中），
 * 响应体即正文本身——比拼接 raw.githubusercontent.com 少一次探测、也不用猜分支名
 * （且 raw 域名在打包环境中常被网络策略拦截）。
 *
 * 结果按 repoUrl 缓存在会话内；失败不缓存，允许用户重试。
 */
export function fetchReadme(repoUrl: string): Promise<ReadmeResult> {
  const cached = readmeCache.get(repoUrl);
  if (cached) return cached;
  const task = doFetchReadme(repoUrl);
  readmeCache.set(repoUrl, task);
  // 失败结果不留在缓存里，下次打开可重试
  void task.then((r) => {
    if (r.state === "error") readmeCache.delete(repoUrl);
  });
  return task;
}

async function doFetchReadme(repoUrl: string): Promise<ReadmeResult> {
  const m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)/i.exec(repoUrl);
  if (!m) return { state: "error", message: "非 GitHub 仓库，暂不支持读取 README" };
  const url = `https://api.github.com/repos/${m[1]}/${m[2]}/readme`;
  try {
    const text = tauri
      ? await api.httpGetJson(url, "application/vnd.github.raw")
      : await fetchText(url, "application/vnd.github.raw");
    const body = text?.trim() ?? "";
    if (!body) return { state: "empty" };
    return {
      state: "ok",
      markdown: body.length > README_MAX_CHARS ? `${body.slice(0, README_MAX_CHARS)}\n\n…（内容过长，已截断）` : body,
    };
  } catch (e) {
    const msg = String(e);
    if (msg.includes("404")) return { state: "empty" };
    if (msg.includes("403")) return { state: "error", message: "GitHub 接口限流，请稍后再试" };
    return { state: "error", message: "README 加载失败，请检查网络后重试" };
  }
}

/** 浏览器预览模式：原生 fetch 取文本 */
async function fetchText(url: string, accept: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: accept } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** ISO → YYYY-MM-DD */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().slice(0, 10);
}
