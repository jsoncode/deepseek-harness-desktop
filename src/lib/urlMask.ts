/**
 * 服务地址展示打码（仅影响只读展示，复制/浏览器打开仍使用真实完整地址）。
 *
 * 新版宿主启动后生成带进程 token 的完整地址（形如
 * `http://127.0.0.1:3080/?token=<base64url>`），地址栏/状态文案里直接展示会把
 * token 暴露在截屏/录屏中。这里把 `token` 查询参数的值整体替换为圆点占位符
 * （如 `token=......`），其余部分（scheme / host / port / 路径 / 其他查询参数）
 * 原样保留。
 */
const TOKEN_MASK = "......";

/** 该 URL 的查询串里是否带 `token` 参数（值为非空字符串） */
export function hasServiceToken(raw: string): boolean {
  try {
    const u = new URL(raw);
    const value = u.searchParams.get("token");
    return typeof value === "string" && value.length > 0;
  } catch {
    return false;
  }
}

/** 把 URL 中 `token` 参数值打码后返回；无 token（旧版宿主/解析失败）时原样返回 */
export function maskServiceUrl(raw: string): string {
  if (!hasServiceToken(raw)) return raw;
  try {
    const u = new URL(raw);
    u.searchParams.set("token", TOKEN_MASK);
    return u.href;
  } catch {
    return raw;
  }
}

/**
 * 内嵌预览用的同站地址（浏览器预览回退路径）。
 *
 * 新版宿主的浏览器认证通过「root 请求换 SameSite=Strict 会话 Cookie」完成；Strict
 * Cookie 只在【同站】请求里携带。桌面壳在开发模式（Vite dev server）下的顶层页面是
 * `http://localhost:6089`，若 iframe 用日志里的 `http://127.0.0.1:<port>`（与
 * localhost 不同 host，非同站），换来的 Cookie 永远不会随 iframe 内请求发回，
 * 页面停在 `dsh web authentication required`。
 *
 * 因此在顶层页面本身就是 `http://localhost` 时（开发模式 / 浏览器预览），把内嵌
 * 地址的 host 改写为 `localhost`（同 scheme+host = 同站，端口不影响 site），
 * Strict Cookie 即可正常生效。
 *
 * 注意：打包正式版的顶层是 `tauri://localhost`（自定义 scheme），与任何 http
 * 站点都不同站，此处改写无效——但正式版预览不经过本函数：Tauri 运行时里宿主页
 * 通过本地反向代理（src-tauri/src/proxy.rs）以普通 DOM iframe 同源内嵌，认证
 * Cookie 由代理在 Rust 侧持有并注入，浏览器无需任何 Cookie。本函数仅供浏览器
 * 预览（非 Tauri、顶层为 http://localhost）时兜底使用。
 *
 * 仅用于 iframe src；复制/浏览器打开/健康探测仍使用日志解析出的原始地址。
 */
export function sameSiteEmbedUrl(raw: string): string {
  try {
    const top = window.location;
    if (top.protocol !== "http:" && top.protocol !== "https:") return raw;
    if (top.hostname !== "localhost" && top.hostname !== "127.0.0.1") return raw;
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return raw;
    const host = u.hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") {
      // 仅当顶层是 localhost 时改写为 localhost；顶层是 127.0.0.1 则保持原样即可
      if (top.hostname === "localhost" && host !== "localhost") {
        u.hostname = "localhost";
      }
    }
    return u.href;
  } catch {
    return raw;
  }
}
