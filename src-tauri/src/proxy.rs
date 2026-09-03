//! 本地反向代理（nginx 式）——把宿主页“变回”同源 DOM iframe 的桥梁。
//!
//! 背景：打包正式版壳顶层是自定义协议 `tauri://localhost`，与任何 http 站点都
//! 跨站，DOM iframe 内无法完成宿主认证（SameSite=Strict Cookie 永不发回，见
//! `urlMask.ts` 的注释）。此前用「原生子 webview」（把宿主页作为子 webview 的
//! 顶层文档，见 preview.rs）绕开，但子 webview 与壳 DOM 浮层（Tooltip /
//! Popconfirm / message 气泡）天然分层，气泡显示与 webview 移出/移回联动始终
//! 有瑕疵，且平台受限（目前仅 Windows）。
//!
//! 现改为「认证终结型反向代理」：桌壳内起一个只监听 127.0.0.1 的本地 HTTP 代理，
//! 把 dsh web 暴露为另一个本地 origin；宿主页回归普通 DOM iframe，所有跨站
//! Cookie 问题在 Rust 侧一次性解决：
//!
//! ```text
//! WebView2 顶层 tauri://localhost
//!    └─ DOM iframe http://127.0.0.1:<代理端口>/   （同源：页面内一切请求都相对它）
//!           │  GET /plugins/…、/api/…、WS /api/remote.mux
//!           ▼
//!        本代理（认证终结）── Cookie 注入 ──► http://127.0.0.1:<dsh端口>（真实 dsh web）
//! ```
//!
//! - 代理自己拿 launch token 换 dsh-auth-* 会话 Cookie（复用 session_events 的
//!   [`fetch_session_cookie`]，同一套「root 请求换 Cookie」认证），缓存 key =
//!   (host, port, token)——dsh web 重启、token 变化时自动重换；
//! - 浏览器永远接触不到 Cookie：请求转发时注入、响应里的 `Set-Cookie` 一律剥掉，
//!   因此不存在「跨站/第三方 Cookie 语义」，SameSite=Strict 约束形同虚设；
//! - 转发只改写请求头 `Host`（→ 上游 authority，Cookie 以 Host authority 绑定）
//!   并丢弃 Origin/Referer（本应用 Rust 侧客户端同样不带这两个头即可通过认证，
//!   丢弃最稳）；响应剥 `Set-Cookie`、绝对 `Location` 改回相对路径（防止浏览器
//!   跳出代理直连上游 → 401）；
//! - body 以「原样字节透传」为主：帧内容不改动、由浏览器自己解码，但会用轻量
//!   帧界定（Content-Length 字节数 / chunked 终止块）判断“何时转发完”，不依赖
//!   上游主动关连接；无帧（close 界定）时读到 EOF。天然支持大文件上传与流式
//!   响应。WebSocket 升级请求保留 connection/upgrade 头原样转发，上游 101 后
//!   进入双向字节泵；
//! - 不依赖 AppState 之外任何 dsh 生命周期：每条连接实时从 detected_url 解析
//!   上游，服务未起时回 502（页面此时本就不该挂载，纯兜底）。
//!
//! # 连接模型
//!
//! 一次 TCP 连接只服务一个请求（响应里强制 `Connection: close`），浏览器会自动
//! 开新连接复用页面。好处：无需维护 keep-alive 会话状态；WebSocket 的 101 升级
//! 在“同一连接”里自然结束请求/响应语义、随后转为字节泵，实现最小且稳。
//! loopback 上开连接开销可忽略。
//!
//! # 线程模型
//!
//! accept 后每连接一个处理线程；处理线程里再开两个泵线程（请求体上行、
//! 响应下行）。响应下行线程先读/改写响应头，再按帧界定转发 body；上行线程先
//! 补发读请求头时已读入的残留字节（body 起始），再持续 copy。任一端 EOF/出错
//! → 关停另一端。纯 std 阻塞 I/O，与 dsh.rs / session_events.rs 风格一致，
//! 无新增依赖。

use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use tauri::AppHandle;

use crate::dsh;
use crate::session_events::{fetch_session_cookie, Endpoint};

/// 代理监听端口基准：dev 服务端口 6088（vite UI 6089），release 3080，
/// 这里取 service_port + 10 错开（dev → 6098，release → 3090），避免与 dsh 服务
/// 或 vite 开发端口冲突。绑定失败时按序顺延，仍失败退回端口 0（系统分配）。
fn proxy_port_candidates() -> Vec<u16> {
    let base = dsh::service_port() + 10;
    (base..base + 8).collect()
}

/// 实际绑定成功的代理端口（0 = 未启动）。前端经 [`proxy_base_url`] 命令读取。
static BOUND_PORT: AtomicU16 = AtomicU16::new(0);

/// 会话 Cookie 缓存：(host, port, token) → dsh-auth-* Cookie 首段（name=value）。
static SESSION: Mutex<Option<(String, u16, String, String)>> = Mutex::new(None);

/// 读请求头超时（客户端连上后迟迟不发包视为异常，避免线程悬挂）
const HEAD_READ_TIMEOUT: Duration = Duration::from_secs(15);
/// 读响应头超时（上游长时间无响应视为异常）
const RESPONSE_HEAD_TIMEOUT: Duration = Duration::from_secs(30);
/// 连接上游超时
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
/// 单次读入缓冲（body 透传用）
const CHUNK: usize = 16 * 1024;
/// 请求头/响应头上限（防御性；真实页面远小于此）
const HEAD_LIMIT: usize = 128 * 1024;

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

/// 启动本地反向代理监听线程。setup 里调用一次；与 dsh web 启动时机解耦。
pub fn spawn(app: AppHandle) {
    let listener = proxy_port_candidates()
        .iter()
        .find_map(|port| TcpListener::bind(("127.0.0.1", *port)).ok())
        .or_else(|| TcpListener::bind(("127.0.0.1", 0)).ok());
    let Some(listener) = listener else {
        eprintln!("[proxy] 本地代理端口全部被占用，预览代理不可用");
        return;
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    BOUND_PORT.store(port, Ordering::SeqCst);
    eprintln!("[proxy] 预览代理已就绪: http://127.0.0.1:{port}");

    thread::Builder::new()
        .name("dsh-proxy".to_string())
        .spawn(move || accept_loop(listener, app))
        .expect("failed to spawn proxy thread");
}

/// 前端查询预览用代理地址（origin 形态，如 `http://127.0.0.1:3090`）。
/// 未启动成功返回 None，前端据此回退/提示。
#[tauri::command]
pub fn proxy_base_url() -> Option<String> {
    let port = BOUND_PORT.load(Ordering::SeqCst);
    if port == 0 {
        None
    } else {
        Some(format!("http://127.0.0.1:{port}"))
    }
}

fn accept_loop(listener: TcpListener, app: AppHandle) {
    for conn in listener.incoming() {
        let Ok(client) = conn else { continue };
        let _ = client.set_nodelay(true);
        let app = app.clone();
        thread::Builder::new()
            .name("dsh-proxy-conn".to_string())
            .spawn(move || handle_client(client, &app))
            .ok();
    }
}

// ---------------------------------------------------------------------------
// 单连接处理
// ---------------------------------------------------------------------------

/// 处理一条客户端连接。任何失败都只结束本连接（浏览器自动重连），不向外报错。
fn handle_client(client: TcpStream, app: &AppHandle) {
    // 解析上游：当前 detected_url。无服务（服务未启动/刚停止）→ 502 兜底。
    let ep = Endpoint::detected(app);
    serve_client(client, ep);
}

/// 单连接交易主体：读请求头 → 换/注入会话 Cookie → 转发 → 双向泵。
/// 无端点（服务未启动）时回 502；测试可直接注入假端点复用本函数。
fn serve_client(mut client: TcpStream, ep: Option<Endpoint>) {
    // 1. 读请求头（残留字节 = body 起始，稍后由上行泵补发）
    let mut buf: Vec<u8> = Vec::new();
    let head = match read_head(&mut client, &mut buf, HEAD_READ_TIMEOUT) {
        Ok(Some(h)) => h,
        Ok(None) | Err(_) => return,
    };
    // 请求头已读完：此后上行泵/WS 隧道可能长时间空闲（如连接只收不发），
    // 清除读超时，让字节泵阻塞等待，连接的生命由 EOF/错误/对端关闭来界定。
    let _ = client.set_read_timeout(None);

    // 2. 解析上游。无服务 → 502 兜底。
    let Some(ep) = ep else {
        let _ = write_bad_gateway(&mut client);
        return;
    };

    // 3. 认证终结：拿 token 换 Cookie（缓存命中则复用）。
    let cookie = ep.token.as_deref().and_then(|t| session_cookie(&ep, t));

    // 4. 组装上游请求头并连接上游。
    let is_upgrade = is_ws_upgrade(&head);
    let upstream_head = rewrite_request_head(&head, &ep, cookie.as_deref(), is_upgrade);

    let addr = match (ep.host.as_str(), ep.port).to_socket_addrs() {
        Ok(mut addrs) => addrs.next(),
        Err(_) => None,
    };
    let Some(addr) = addr else {
        let _ = write_bad_gateway(&mut client);
        return;
    };
    let mut upstream = match TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT) {
        Ok(s) => s,
        Err(_) => {
            let _ = write_bad_gateway(&mut client);
            return;
        }
    };
    let _ = upstream.set_nodelay(true);
    if upstream.write_all(&upstream_head).is_err() {
        return;
    }

    // 5. 双向泵：上行（client→upstream）与下行（upstream→client）各一线程。
    //    - 普通请求：下行线程先改写响应头（剥 Set-Cookie、绝对 Location 改相对、
    //      强制 Connection: close），body 帧内容原样透传（浏览器自己解码），
    //      按 Content-Length / chunked 终止块界定转发何时结束；
    //    - WebSocket 升级：响应（101）头原样透传、不做任何改写，随后进入
    //      长连接双向字节泵（隧道）。上行泵先补发请求头残留字节再持续 copy。
    //    克隆出各方向的句柄：主线程保留原件用于最后统一关停。
    let mut cl_read = match client.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    };
    let mut cl_write = match client.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    };
    let mut up_read = match upstream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    };
    let mut up_write = match upstream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    };

    let upstream_authority = ep.http_base();

    let up_handle = thread::Builder::new()
        .name("dsh-proxy-up".to_string())
        .spawn(move || {
            // 补发读请求头时已读入的残留字节（body 起始），再持续透传
            if !buf.is_empty() && up_write.write_all(&buf).is_err() {
                return;
            }
            let _ = pump(&mut cl_read, &mut up_write);
        });

    let down_handle = thread::Builder::new()
        .name("dsh-proxy-down".to_string())
        .spawn(move || {
            if !is_upgrade {
                // 响应头（可能多个 1xx 中间响应，逐个透传后取最终响应头改写）
                loop {
                    let mut hbuf: Vec<u8> = Vec::new();
                    match read_head(&mut up_read, &mut hbuf, RESPONSE_HEAD_TIMEOUT) {
                        Ok(Some(h)) => {
                            if is_interim_status(&h) {
                                // 100 Continue 等：原样透传给浏览器，继续读下一个头
                                if cl_write.write_all(&h).is_err() {
                                    return;
                                }
                                continue;
                            }
                            let rw = rewrite_response_head(&h, &upstream_authority);
                            if cl_write.write_all(&rw).is_err() {
                                return;
                            }
                            // body 透传不再受响应头读取超时限制（长/慢 body 只靠
                            // 帧界定或 EOF）
                            let _ = up_read.set_read_timeout(None);
                            // body：按头部帧界定精确转发（chunked / Content-Length /
                            // 无帧 = 读到 EOF），不依赖上游主动关连接；
                            // hbuf 里可能已有 body 起始字节，一并交给 relay。
                            let _ = relay_response_body(&h, hbuf, &mut up_read, &mut cl_write);
                            return;
                        }
                        Ok(None) | Err(_) => return,
                    }
                }
            }
            // WS 升级（101）：响应头原样透传、不做改写（此前未动字节），这里直接
            // 进入长连接隧道本体——双向泵，任一端断开即由外层关停另一端。
            let _ = pump(&mut up_read, &mut cl_write);
        });

    // 6. 汇合：任一端结束后关停另一端，防止另一线程悬挂。
    //    普通请求：下行泵按帧界定转发完 body 即结束 → 关停两端；
    //    WS：任一端关闭（浏览器离开/上游断开）即结束。
    let up_handle = up_handle.ok();
    let down_handle = down_handle.ok();
    loop {
        let up_done = up_handle.as_ref().map_or(true, |h| h.is_finished());
        let down_done = down_handle.as_ref().map_or(true, |h| h.is_finished());
        if up_done || down_done {
            break;
        }
        thread::sleep(Duration::from_millis(20));
    }
    let _ = client.shutdown(Shutdown::Both);
    let _ = upstream.shutdown(Shutdown::Both);
    if let Some(h) = up_handle {
        let _ = h.join();
    }
    if let Some(h) = down_handle {
        let _ = h.join();
    }
}

/// 纯字节透传直到 EOF/出错。
fn pump(r: &mut impl Read, w: &mut impl Write) -> std::io::Result<u64> {
    let mut total = 0u64;
    let mut buf = [0u8; CHUNK];
    loop {
        match r.read(&mut buf) {
            Ok(0) => return Ok(total),
            Ok(n) => {
                w.write_all(&buf[..n])?;
                total += n as u64;
            }
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                // 上游/客户端空闲超时：静默结束（连接由外层关闭）
                return Err(e);
            }
            Err(e) => return Err(e),
        }
    }
}

/// 按响应头给出的帧界定，把 body 精确转发给浏览器后停止：
/// - `Transfer-Encoding: chunked`：透传并解析到终止 chunk（0 长度 + 尾随空行）；
/// - 否则若有 `Content-Length`：转发恰好该字节数；
/// - 都没有（close 界定 body）：读到 EOF。
///
/// `rest` 是读响应头时已多读出的 body 起始字节（先于 socket 消费）。
/// 不依赖上游主动关连接——即使上游想 keep-alive，这里也在 body 边界收手，
/// 由外层统一关停两端，避免下行线程悬挂。
fn relay_response_body(
    head: &[u8],
    mut rest: Vec<u8>,
    up: &mut TcpStream,
    down: &mut TcpStream,
) -> std::io::Result<()> {
    let lower = String::from_utf8_lossy(head).to_ascii_lowercase();
    let is_chunked = lower
        .lines()
        .any(|l| l.trim_start().starts_with("transfer-encoding:") && l.contains("chunked"));
    if is_chunked {
        // 解析并透传 chunk 帧：逐行读大小（透传），正文按字节数透传，直到 0 终止块
        loop {
            let Some(size_line) = read_line_from(&mut rest, up)? else {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "eof in chunked body",
                ));
            };
            if down.write_all(&size_line).is_err() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    "client closed",
                ));
            }
            // 取 chunk 大小：十六进制，到 ';'（扩展）/ CR 为止
            let size_bytes: Vec<u8> = size_line
                .split(|&b| b == b';')
                .next()
                .unwrap_or(&[])
                .iter()
                .copied()
                .take_while(|b| b.is_ascii_hexdigit())
                .collect();
            let size_text = String::from_utf8_lossy(&size_bytes);
            let chunk_len = usize::from_str_radix(size_text.trim(), 16).unwrap_or(0);
            if chunk_len == 0 {
                // 尾随字段直到空行
                loop {
                    let Some(trailer) = read_line_from(&mut rest, up)? else {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::UnexpectedEof,
                            "eof in chunked trailers",
                        ));
                    };
                    if down.write_all(&trailer).is_err() {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::BrokenPipe,
                            "client closed",
                        ));
                    }
                    if trailer == b"\r\n" || trailer == b"\n" {
                        return Ok(());
                    }
                }
            }
            // chunk 正文 + 行尾 CRLF，原样透传
            if !copy_n(up, down, &mut rest, chunk_len as u64)? {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "eof inside chunk",
                ));
            }
            let mut crlf = [0u8; 2];
            if rest.len() >= 2 {
                crlf.copy_from_slice(&rest[..2]);
                rest.drain(..2);
            } else {
                let mut have = rest.clone();
                rest.clear();
                while have.len() < 2 {
                    let mut b = [0u8; 1];
                    match up.read(&mut b) {
                        Ok(0) => {
                            return Err(std::io::Error::new(
                                std::io::ErrorKind::UnexpectedEof,
                                "eof before chunk crlf",
                            ))
                        }
                        Ok(_) => have.extend_from_slice(&b),
                        Err(e) => return Err(e),
                    }
                }
                crlf.copy_from_slice(&have[..2]);
                rest.extend_from_slice(&have[2..]);
            }
            if down.write_all(&crlf).is_err() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    "client closed",
                ));
            }
        }
    }
    let content_length: Option<u64> = lower
        .lines()
        .find(|l| l.trim_start().starts_with("content-length:"))
        .and_then(|l| l.split(':').nth(1).and_then(|v| v.trim().parse().ok()));
    if let Some(n) = content_length {
        if !copy_n(up, down, &mut rest, n)? {
            // 少于声明长度：按 EOF 收尾（已透传的全部内容都已到浏览器）
            return Ok(());
        }
        return Ok(());
    }
    // 无帧（close 界定）：rest + 剩余字节读到 EOF
    if !rest.is_empty() && down.write_all(&rest).is_err() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::BrokenPipe,
            "client closed",
        ));
    }
    let _ = pump(up, down);
    Ok(())
}

/// 读一行（含行尾 \n），优先消费 rest 中已缓冲字节。
fn read_line_from(rest: &mut Vec<u8>, s: &mut TcpStream) -> std::io::Result<Option<Vec<u8>>> {
    loop {
        if let Some(pos) = rest.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = rest.drain(..=pos).collect();
            return Ok(Some(line));
        }
        let mut buf = [0u8; CHUNK];
        match s.read(&mut buf) {
            Ok(0) => {
                return if rest.is_empty() {
                    Ok(None)
                } else {
                    Err(std::io::Error::new(
                        std::io::ErrorKind::UnexpectedEof,
                        "eof inside line",
                    ))
                }
            }
            Ok(n) => rest.extend_from_slice(&buf[..n]),
            Err(e) => return Err(e),
        }
    }
}

/// 从 (rest 优先, 然后 s) 精确转发 n 字节到 w。返回是否凑满 n（EOF 提前返回 false）。
fn copy_n(
    s: &mut TcpStream,
    w: &mut TcpStream,
    rest: &mut Vec<u8>,
    mut n: u64,
) -> std::io::Result<bool> {
    while n > 0 {
        if rest.is_empty() {
            let mut buf = [0u8; CHUNK];
            match s.read(&mut buf) {
                Ok(0) => return Ok(false),
                Ok(k) => rest.extend_from_slice(&buf[..k]),
                Err(e) => return Err(e),
            }
        }
        let take = rest.len().min(n as usize);
        w.write_all(&rest[..take])?;
        rest.drain(..take);
        n -= take as u64;
    }
    Ok(true)
}

// ---------------------------------------------------------------------------
// 认证终结
// ---------------------------------------------------------------------------

/// 取（必要时重新换取并缓存）dsh-auth-* Cookie。返回首段 `name=value`。
fn session_cookie(ep: &Endpoint, token: &str) -> Option<String> {
    {
        let guard = SESSION.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((h, p, t, c)) = guard.as_ref() {
            if h == &ep.host && *p == ep.port && t == token {
                return Some(c.clone());
            }
        }
    }
    let cookie = fetch_session_cookie(ep, token)?;
    if let Ok(mut guard) = SESSION.lock() {
        *guard = Some((ep.host.clone(), ep.port, token.to_string(), cookie.clone()));
    }
    Some(cookie)
}

// ---------------------------------------------------------------------------
// 头解析 / 改写
// ---------------------------------------------------------------------------

/// 从流中读一个 HTTP 头块（直到 `\r\n\r\n`）。多读的字节保留在 `rest`。
/// 返回 None 表示对端在读到完整头前关闭。
fn read_head(
    stream: &mut TcpStream,
    rest: &mut Vec<u8>,
    timeout: Duration,
) -> std::io::Result<Option<Vec<u8>>> {
    let _ = stream.set_read_timeout(Some(timeout));
    let mut acc: Vec<u8> = Vec::with_capacity(4096);
    let mut chunk = [0u8; CHUNK];
    loop {
        // 已在缓冲中找分隔符（含 rest 里来自上次的残留）
        if let Some(end) = find_head_end(&acc) {
            let head: Vec<u8> = acc.drain(..end).collect();
            *rest = acc; // 分隔符之后的字节留给调用方
            return Ok(Some(head));
        }
        if acc.len() > HEAD_LIMIT {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "http head too large",
            ));
        }
        match stream.read(&mut chunk) {
            Ok(0) => {
                return if acc.is_empty() {
                    Ok(None)
                } else {
                    Err(std::io::Error::new(
                        std::io::ErrorKind::UnexpectedEof,
                        "eof in http head",
                    ))
                }
            }
            Ok(n) => acc.extend_from_slice(&chunk[..n]),
            Err(e) => return Err(e),
        }
    }
}

/// 定位 `\r\n\r\n` 结束位置（含分隔符自身）。
fn find_head_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n").map(|p| p + 4)
}

/// 是否 WebSocket 升级请求：`Connection: Upgrade` + `Upgrade: websocket`
fn is_ws_upgrade(head: &[u8]) -> bool {
    let text = String::from_utf8_lossy(head);
    let conn = text
        .lines()
        .find(|l| l.to_ascii_lowercase().starts_with("connection:"))
        .map(|l| {
            let c = l.find(':').unwrap_or(l.len());
            l[c + 1..].trim().to_ascii_lowercase()
        });
    let upgrade = text
        .lines()
        .find(|l| l.to_ascii_lowercase().starts_with("upgrade:"))
        .map(|l| {
            let c = l.find(':').unwrap_or(l.len());
            l[c + 1..].trim().to_ascii_lowercase()
        });
    let conn_has_upgrade = conn
        .map(|c| c.split(',').any(|t| t.trim() == "upgrade"))
        .unwrap_or(false);
    conn_has_upgrade && upgrade.as_deref() == Some("websocket")
}

/// 响应头是否 1xx 中间响应。
fn is_interim_status(head: &[u8]) -> bool {
    // 形如 `HTTP/1.1 100 Continue`
    let text = String::from_utf8_lossy(head);
    let Some(first) = text.lines().next() else {
        return false;
    };
    let code = first
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse::<u16>().ok())
        .unwrap_or(0);
    (100..200).contains(&code)
}

/// 组装发往上游的请求头：
/// - 请求行原样保留；
/// - `Host` 一律替换为上游 authority（认证 Cookie 以 Host authority 绑定）；
/// - 丢弃浏览器侧 Cookie，注入代理持有的会话 Cookie；
/// - 丢弃 Origin/Referer（本应用 Rust 侧客户端同样不带这两个头即通过认证，
///   丢弃可避免 CSRF/CORS 语义干扰）；
/// - 普通请求丢弃 hop-by-hop 头（connection/keep-alive/proxy-connection/te），
///   并强制 `Connection: close`（body 靠上游关闭界定）；
/// - WebSocket 升级请求保留 connection/upgrade/sec-websocket-* 头原样转发。
fn rewrite_request_head(
    head: &[u8],
    ep: &Endpoint,
    cookie: Option<&str>,
    is_upgrade: bool,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(head.len() + 64);
    let authority = format!("{}:{}", ep.host, ep.port);
    let text = String::from_utf8_lossy(head);

    // 请求行
    let mut lines = text.lines();
    if let Some(line) = lines.next() {
        out.extend_from_slice(line.as_bytes());
        out.extend_from_slice(b"\r\n");
    }

    const DROP: &[&str] = &[
        "host",
        "cookie",
        "origin",
        "referer",
        "connection",
        "keep-alive",
        "proxy-connection",
        "te",
        "trailer",
    ];
    const UPGRADE_KEEP: &[&str] = &[
        "connection",
        "upgrade",
        "sec-websocket-key",
        "sec-websocket-version",
        "sec-websocket-extensions",
        "sec-websocket-protocol",
    ];

    for line in lines {
        if line.is_empty() {
            break; // 空行 = 头结束（body 不在此）
        }
        let lower = line.to_ascii_lowercase();
        let name = lower.split(':').next().unwrap_or("").trim();
        if DROP.contains(&name) {
            if !(is_upgrade && UPGRADE_KEEP.contains(&name)) {
                continue;
            }
        }
        out.extend_from_slice(line.as_bytes());
        out.extend_from_slice(b"\r\n");
    }

    out.extend_from_slice(format!("Host: {authority}\r\n").as_bytes());
    if let Some(c) = cookie {
        out.extend_from_slice(format!("Cookie: {c}\r\n").as_bytes());
    }
    if !is_upgrade {
        out.extend_from_slice(b"Connection: close\r\n");
    }
    out.extend_from_slice(b"\r\n");
    out
}

/// 改写响应头：
/// - 剥掉 `Set-Cookie`（浏览器永不持有会话 Cookie，认证终结的关键）；
/// - 绝对 `Location` 若指向本代理上游 authority，改回相对路径（防止浏览器跳出
///   代理直连上游：无 Cookie 必然 401）；
/// - 去掉上游的 connection/keep-alive 并强制 `Connection: close`：代理按
///   “一次 TCP 连接只服务一个请求”实现，浏览器看到 close 后自会开新连接复用。
fn rewrite_response_head(head: &[u8], upstream_authority: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(head.len() + 32);
    let text = String::from_utf8_lossy(head);
    let mut lines = text.lines();
    if let Some(line) = lines.next() {
        out.extend_from_slice(line.as_bytes());
        out.extend_from_slice(b"\r\n");
    }
    let upstream_origin = format!("http://{upstream_authority}");
    for line in lines {
        if line.is_empty() {
            break;
        }
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("set-cookie:")
            || lower.starts_with("connection:")
            || lower.starts_with("keep-alive:")
        {
            continue;
        }
        if lower.starts_with("location:") {
            // 取冒号之后的值（去掉前导空白）
            let colon = line.find(':').unwrap_or(line.len());
            let value = line[colon + 1..].trim();
            if let Some(path) = value.strip_prefix(&upstream_origin) {
                out.extend_from_slice(format!("Location: {path}\r\n").as_bytes());
                continue;
            }
        }
        out.extend_from_slice(line.as_bytes());
        out.extend_from_slice(b"\r\n");
    }
    out.extend_from_slice(b"Connection: close\r\n\r\n");
    out
}

/// 上游不可达时的兜底 502（服务未启动时页面不应挂载，正常不会看到）
fn write_bad_gateway(client: &mut TcpStream) -> std::io::Result<()> {
    let body = "dsh web 服务未就绪（本地预览代理无法连接上游）。";
    let resp = format!(
        "HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    client.write_all(resp.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn endpoint(host: &str, port: u16, token: Option<&str>) -> Endpoint {
        Endpoint {
            host: host.to_string(),
            port,
            token: token.map(|s| s.to_string()),
        }
    }

    #[test]
    fn 请求头改写host注入cookie剥origin() {
        let head = b"GET /?token=x HTTP/1.1\r\nHost: 127.0.0.1:3090\r\nCookie: stale=1\r\nOrigin: http://127.0.0.1:3090\r\nReferer: http://127.0.0.1:3090/\r\n\r\n";
        let ep = endpoint("127.0.0.1", 3080, None);
        let out = rewrite_request_head(head, &ep, Some("dsh-auth-abc=v1.2"), false);
        let s = String::from_utf8(out).unwrap();
        assert!(s.starts_with("GET /?token=x HTTP/1.1\r\n"));
        assert!(s.contains("Host: 127.0.0.1:3080\r\n"));
        assert!(s.contains("Cookie: dsh-auth-abc=v1.2\r\n"));
        assert!(!s.contains("Cookie: stale=1"));
        assert!(!s.contains("Origin:"));
        assert!(!s.contains("Referer:"));
        assert!(s.contains("Connection: close\r\n"));
        assert!(s.ends_with("\r\n\r\n"));
    }

    #[test]
    fn 升级请求保留upgrade头不发close() {
        let head = b"GET /api/remote.mux HTTP/1.1\r\nHost: 127.0.0.1:3090\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: k\r\n\r\n";
        let ep = endpoint("127.0.0.1", 3080, None);
        let out = rewrite_request_head(head, &ep, Some("dsh-auth-abc=v1.2"), true);
        let s = String::from_utf8(out).unwrap();
        assert!(s.contains("Connection: Upgrade\r\n"));
        assert!(s.contains("Upgrade: websocket\r\n"));
        assert!(s.contains("Sec-WebSocket-Key: k\r\n"));
        assert!(s.contains("Host: 127.0.0.1:3080\r\n"));
        assert!(!s.contains("Connection: close"));
    }

    #[test]
    fn 响应头剥set_cookie改location() {
        let head = b"HTTP/1.1 302 Found\r\nSet-Cookie: dsh-auth-abc=v1.2; Path=/\r\nLocation: http://127.0.0.1:3080/login\r\nContent-Length: 0\r\n\r\n";
        let out = rewrite_response_head(head, "127.0.0.1:3080");
        let s = String::from_utf8(out).unwrap();
        assert!(s.starts_with("HTTP/1.1 302 Found\r\n"));
        assert!(!s.contains("Set-Cookie"));
        assert!(s.contains("Location: /login\r\n"));
        assert!(s.ends_with("\r\n\r\n"));
    }

    #[test]
    fn 中间响应识别() {
        assert!(is_interim_status(b"HTTP/1.1 100 Continue\r\n\r\n"));
        assert!(!is_interim_status(b"HTTP/1.1 200 OK\r\n\r\n"));
        assert!(is_interim_status(b"HTTP/1.1 103 Early Hints\r\n\r\n"));
    }

    #[test]
    fn find_head_end定位() {
        assert_eq!(find_head_end(b"a\r\n\r\nb"), Some(5));
        assert_eq!(find_head_end(b"abc"), None);
    }

    // ------------------------------------------------------------------
    // 端到端（真 socket）：假上游 + 假浏览器，验证转发/注入/剥 Cookie
    // ------------------------------------------------------------------

    /// 按 Content-Length 读完整 HTTP 响应（不依赖对端关连接）。
    fn read_http_response(stream: &mut TcpStream) -> Vec<u8> {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        // 头
        loop {
            if let Some(end) = find_head_end(&buf) {
                let head = String::from_utf8_lossy(&buf[..end]).to_string();
                // 只响应普通 200（测试里代理返回的最终响应）
                let len: usize = head
                    .lines()
                    .find(|l| l.to_ascii_lowercase().starts_with("content-length:"))
                    .and_then(|l| l.split(':').nth(1))
                    .and_then(|v| v.trim().parse().ok())
                    .unwrap_or(0);
                while buf.len() < end + len {
                    match stream.read(&mut chunk) {
                        Ok(0) => break,
                        Ok(n) => buf.extend_from_slice(&chunk[..n]),
                        Err(_) => break,
                    }
                }
                break;
            }
            match stream.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
                Err(_) => break,
            }
        }
        buf
    }

    /// 起一个“假 dsh web”上游，直到 done 置位前持续接受连接：
    /// token 交换应答 303+Set-Cookie，正文请求应答 200+正文（带 Set-Cookie 供断言剥除）。
    /// 记录收到的请求头供断言。返回 (端口, 收到的请求头列表, done 标志)。
    fn start_fake_upstream() -> (
        u16,
        std::sync::Arc<std::sync::Mutex<Vec<String>>>,
        std::sync::Arc<std::sync::atomic::AtomicBool>,
    ) {
        use std::sync::atomic::AtomicBool;
        use std::sync::atomic::Ordering as AOrdering;
        use std::sync::{Arc, Mutex};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let _ = listener.set_nonblocking(true);
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let seen2 = seen.clone();
        let done = Arc::new(AtomicBool::new(false));
        let done2 = done.clone();
        thread::spawn(move || {
            while !done2.load(AOrdering::Relaxed) {
                let Ok((mut sock, _)) = listener.accept() else {
                    thread::sleep(Duration::from_millis(5));
                    continue;
                };
                let _ = sock.set_read_timeout(Some(Duration::from_secs(5)));
                let mut raw = Vec::new();
                let mut chunk = [0u8; 4096];
                loop {
                    match sock.read(&mut chunk) {
                        Ok(0) => break,
                        Ok(n) => {
                            raw.extend_from_slice(&chunk[..n]);
                            if find_head_end(&raw).is_some() {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
                let head = String::from_utf8_lossy(&raw).to_string();
                if let Ok(mut s) = seen2.lock() {
                    s.push(head.clone());
                }
                let resp = if head.starts_with("GET /?token=") {
                    // 认证交换：303 + Set-Cookie
                    "HTTP/1.1 303 See Other\r\nLocation: /\r\nSet-Cookie: dsh-auth-fake=v1.2; Path=/; HttpOnly; SameSite=Strict\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string()
                } else {
                    // 正文响应：带 Set-Cookie，代理应剥掉
                    let body = "hello from upstream";
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nSet-Cookie: dsh-auth-fake=v1.2; Path=/\r\nContent-Length: {}\r\n\r\n{}",
                        body.len(),
                        body
                    )
                };
                let _ = sock.write_all(resp.as_bytes());
                let _ = sock.flush();
            }
        });
        (port, seen, done)
    }

    #[test]
    fn 端到端_注入cookie并剥set_cookie() {
        // 假上游 + 假浏览器（连入 serve_client 的客户端侧）
        let (up_port, seen, done) = start_fake_upstream();
        let proxy_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let proxy_port = proxy_listener.local_addr().unwrap().port();

        let ep = Endpoint::parse(&format!("http://127.0.0.1:{up_port}/?token=abc")).unwrap();
        let server_thread = thread::spawn(move || {
            if let Ok((client, _)) = proxy_listener.accept() {
                serve_client(client, Some(ep));
            }
        });

        // 假浏览器：向“代理”发起请求
        let mut browser = TcpStream::connect(("127.0.0.1", proxy_port)).unwrap();
        let _ = browser.set_read_timeout(Some(Duration::from_secs(5)));
        browser
            .write_all(
                b"GET / HTTP/1.1\r\nHost: 127.0.0.1:9999\r\nOrigin: http://127.0.0.1:9999\r\n\r\n",
            )
            .unwrap();
        let resp = read_http_response(&mut browser);
        drop(browser);
        // serve_client 线程自行收尾（其内部会关停两端）
        drop(server_thread);
        done.store(true, std::sync::atomic::Ordering::Relaxed);
        // 等待 token 交换与正文请求都被上游记录（最多 ~1s）
        let heads = seen.lock().unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while !heads.iter().any(|h| h.starts_with("GET / HTTP/1.1"))
            && std::time::Instant::now() < deadline
        {
            thread::sleep(Duration::from_millis(10));
        }

        // 上游收到了注入的会话 Cookie，且没有透传浏览器的 Origin
        let forwarded = heads
            .iter()
            .find(|h| h.starts_with("GET / HTTP/1.1"))
            .expect("应有一次真正的正文请求转发到上游")
            .clone();
        assert!(
            forwarded.contains("Cookie: dsh-auth-fake=v1.2\r\n"),
            "{forwarded}"
        );
        assert!(!forwarded.contains("Origin:"), "{forwarded}");

        // 浏览器收到的响应：正文原样、Set-Cookie 被剥掉
        let text = String::from_utf8_lossy(&resp);
        assert!(text.starts_with("HTTP/1.1 200 OK\r\n"), "{text}");
        assert!(!text.to_ascii_lowercase().contains("set-cookie"), "{text}");
        assert!(text.contains("hello from upstream"), "{text}");
    }

    #[test]
    fn 无上游时返回502() {
        // 无人监听的端口
        let probe = TcpListener::bind("127.0.0.1:0").unwrap();
        let dead_port = probe.local_addr().unwrap().port();
        drop(probe);

        let proxy_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let proxy_port = proxy_listener.local_addr().unwrap().port();
        let ep = Endpoint {
            host: "127.0.0.1".into(),
            port: dead_port,
            token: Some("abc".into()),
        };
        let server_thread = thread::spawn(move || {
            if let Ok((client, _)) = proxy_listener.accept() {
                serve_client(client, Some(ep));
            }
        });
        let mut browser = TcpStream::connect(("127.0.0.1", proxy_port)).unwrap();
        let _ = browser.set_read_timeout(Some(Duration::from_secs(5)));
        browser
            .write_all(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n")
            .unwrap();
        let mut resp = Vec::new();
        let _ = browser.read_to_end(&mut resp);
        drop(browser);
        drop(server_thread);
        let text = String::from_utf8_lossy(&resp);
        assert!(text.starts_with("HTTP/1.1 502 Bad Gateway"), "{text}");
    }
}
