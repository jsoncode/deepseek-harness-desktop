//! dsh 会话事件 → 系统推送：订阅、过滤、渲染、去重。
//!
//! 后台线程连 dsh web 服务的下行 WebSocket（`/api/events.mux`，纯推：客户端一发
//! 数据帧就会被 `close(1008, "downlink only")`，所以这里**只读不写**），从海量事件里
//! 只挑两类需要提醒的：`todo/write`（任务清单更新）与 `turn/end`（一轮对话结束），
//! 渲染成文案交给 [`notify`](crate::notify) 投递。
//!
//! 本模块刻意不碰任何 UI / 平台 API：投递通道（toast、未来的语音）全部收在
//! `notify.rs`，所以加通道时这里零改动。
//!
//! 投递放在 Rust 而不是前端：窗口关掉后应用驻留托盘，webview 可能被 WebView2 节流，
//! 而「人不在窗口前也能收到提醒」正是系统推送的目的。

use crate::dsh;
use crate::notify;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io;
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tungstenite::Message;

/// 需求文案里的两个标题
pub const TITLE_TODO: &str = "更新任务清单";
pub const TITLE_TURN_END: &str = "对话结束";
/// 标题还没生成（或压根没这个会话）时的兜底
const UNTITLED: &str = "未命名对话";

/// 消息种类，与前端 `src/lib/notify.ts` 的 `NotifyMessage["kind"]` 一致
const KIND_TODO: &str = "todo";
const KIND_TURN_END: &str = "turnEnd";

/// dsh 的会话事件下行通道
const MUX_PATH: &str = "/api/events.mux";
/// 会话列表（取标题基线）
const SESSION_LIST_PATH: &str = "/api/session.list";
/// 读循环节拍：每 500ms 醒一次，用于检查服务是否还在
const READ_TICK: Duration = Duration::from_millis(500);
/// 服务探活间隔（不必每拍都发 HTTP 请求，免得污染服务日志）
const ALIVE_INTERVAL: Duration = Duration::from_secs(10);
/// 断线后重连前的等待
const RECONNECT_DELAY: Duration = Duration::from_secs(2);

/// 一条推送的多通道负载：`emit` 给前端与系统通知共用同一份渲染结果，
/// 后续语音通道只需消费这个结构，不必重新解析事件。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NotifyMessage {
    /// "todo" | "turnEnd"
    pub kind: &'static str,
    pub session_id: String,
    /// 会话标题，未知为「未命名对话」
    pub session_title: String,
    /// 标题（"更新任务清单" / "对话结束"）
    pub title: &'static str,
    /// 描述
    pub desc: String,
    /// 需求的 `{标题}：{描述}`
    pub summary: String,
    /// toast 第二行：todo 带会话标题（多会话并发时用于区分），turnEnd 带结束原因
    pub body: String,
    pub ts: i64,
}

/// 已渲染待投递的会话状态表（进程存活期内有效，无需落盘）
type Notes = HashMap<String, SessionNote>;

/// 单个会话的推送状态
#[derive(Default)]
struct SessionNote {
    /// 会话标题（来源：session.list 基线 / session/title 事件 / title 投影）
    title: Option<String>,
    /// 上次已推送的清单计数，用于「无净变化不重复推」
    last: Option<TodoCounts>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
struct TodoCounts {
    done: u32,
    active: u32,
    pending: u32,
}

// ---------------------------------------------------------------------------
// 后台线程：连接生命周期
// ---------------------------------------------------------------------------

/// 启动订阅线程。服务未就绪时线程挂起在探活循环里，因此无需与
/// `start_dsh_web` / `stop_dsh_web` 耦合，应用启动时调一次即可。
pub fn spawn(app: AppHandle) {
    let _ = std::thread::Builder::new()
        .name("dsh-session-events".to_string())
        .spawn(move || {
            let mut notes: Notes = HashMap::new();
            loop {
                wait_service_up(&app);
                run_once(&app, &mut notes);
                std::thread::sleep(RECONNECT_DELAY);
            }
        });
}

fn wait_service_up(app: &AppHandle) {
    loop {
        if Endpoint::of(app).alive() {
            return;
        }
        std::thread::sleep(Duration::from_secs(1));
    }
}

/// 建立一次连接并消费事件，直到断开或检测到服务停止。
/// 任何失败都只是返回，交给外层 supervisor 重来 —— 提醒是旁路能力，不打日志、不报错。
fn run_once(app: &AppHandle, notes: &mut Notes) {
    let ep = Endpoint::of(app);
    let Some(tcp) = ep.connect_tcp() else { return };
    // 握手阶段不设读超时（loopback 上毫秒级），握手完成后才切到节拍读
    let Ok((mut ws, _resp)) = tungstenite::client(ep.ws_url(MUX_PATH), tcp) else {
        return;
    };
    let _ = ws.get_mut().set_read_timeout(Some(READ_TICK));
    seed_titles(&ep, notes);

    let mut last_alive = Instant::now();
    loop {
        match ws.read() {
            Ok(Message::Text(text)) => {
                if let Some(msg) = extract(text.as_str(), notes) {
                    // 关掉开关时依然走完解析（维护标题与去重基线），只是不投递，
                    // 免得「关→开」瞬间把积压的历史事件一次性刷屏
                    if notify_enabled(app) {
                        notify::dispatch(app, &msg);
                    }
                }
            }
            // 服务端主动收尾：断开重连
            Ok(Message::Close(_)) => break,
            // ping / pong / binary 与推送无关（tungstenite 自动回 pong）
            Ok(_) => {}
            Err(tungstenite::Error::Io(ref e))
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) =>
            {
                // 本周期无数据。服务被停掉时连接可能半开（收不到 RST），
                // 所以定期探活：死了就断开，回到外层等服务回来
                if last_alive.elapsed() >= ALIVE_INTERVAL {
                    last_alive = Instant::now();
                    if !ep.alive() {
                        break;
                    }
                }
            }
            Err(_) => break,
        }
    }
}

fn notify_enabled(app: &AppHandle) -> bool {
    app.state::<dsh::AppState>()
        .notify_enabled
        .load(Ordering::SeqCst)
}

// ---------------------------------------------------------------------------
// 服务端点
// ---------------------------------------------------------------------------

/// dsh web 服务的 host + port。
///
/// 优先用已探测到的 `detected_url`（用户可能以任意端口起服务），缺省回退本应用
/// 管理的端口（dev 6088 / release 3080，与 `dsh::service_port` 一致，隔离沿用现状）。
struct Endpoint {
    host: String,
    port: u16,
}

impl Endpoint {
    fn of(app: &AppHandle) -> Self {
        let detected = app
            .state::<dsh::AppState>()
            .detected_url
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        detected
            .as_deref()
            .and_then(Self::parse)
            .unwrap_or_else(|| Self {
                host: "127.0.0.1".to_string(),
                port: dsh::service_port(),
            })
    }

    /// 从 `http://host:port[/...]` 取 host 与 port。
    /// 本应用只与明文 HTTP 的本地服务通信（dsh web 不提供 TLS），故 https 也按
    /// http 解析、下行同样用明文 ws。
    fn parse(url: &str) -> Option<Self> {
        let rest = url
            .strip_prefix("http://")
            .or_else(|| url.strip_prefix("https://"))?;
        let authority = rest.split('/').next().unwrap_or(rest);
        let (host, port) = authority.rsplit_once(':')?;
        if host.is_empty() {
            return None;
        }
        Some(Self {
            host: host.to_ascii_lowercase(),
            port: port.parse().ok()?,
        })
    }

    fn http_base(&self) -> String {
        format!("http://{}:{}", self.host, self.port)
    }

    fn ws_url(&self, path: &str) -> String {
        format!("ws://{}:{}{path}", self.host, self.port)
    }

    fn connect_tcp(&self) -> Option<TcpStream> {
        let addrs = (self.host.as_str(), self.port).to_socket_addrs().ok()?;
        addrs
            .filter_map(|a| TcpStream::connect_timeout(&a, Duration::from_secs(2)).ok())
            .next()
    }

    /// 服务是否在（复用 dsh 的纯 std 探活）
    fn alive(&self) -> bool {
        dsh::probe_url(&self.http_base(), 500)
    }
}

// ---------------------------------------------------------------------------
// 标题基线：连上后先灌一次会话列表
// ---------------------------------------------------------------------------

/// `POST /api/session.list` 灌一次 `sessionId → title` 基线，
/// 这样第一条推送就能带上会话名，而不是等 `session/title` 事件到达。
fn seed_titles(ep: &Endpoint, notes: &mut Notes) {
    let body = jsonrpc("session.list", serde_json::json!({})).to_string();
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(8))
        .user_agent("deepseek-harness-desktop")
        .build();
    let Ok(resp) = agent
        .post(&format!("{}{SESSION_LIST_PATH}", ep.http_base()))
        .set("content-type", "application/json")
        .send_string(&body)
    else {
        return;
    };
    let Ok(text) = resp.into_string() else {
        return;
    };
    let Ok(v) = serde_json::from_str::<Value>(&text) else {
        return;
    };
    let Some(items) = v.pointer("/result/value/items").and_then(Value::as_array) else {
        return;
    };
    for item in items {
        let Some(id) = item.get("sessionId").and_then(Value::as_str) else {
            continue;
        };
        let title = item
            .pointer("/projections/values/title")
            .and_then(Value::as_str)
            .and_then(non_empty)
            .map(str::to_string);
        merge_title(notes, id, title, true);
    }
}

/// dsh 的 RPC 信封：`{"type":"client-request","rpcId":...,"method":...,"payload":...}`
fn jsonrpc(method: &str, payload: Value) -> Value {
    serde_json::json!({
        "type": "client-request",
        "rpcId": rpc_id(),
        "method": method,
        "payload": payload,
    })
}

/// rpcId 只用于服务端关联请求，本侧不等响应，「时间戳 + 递增序号」足够唯一
fn rpc_id() -> String {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    format!(
        "dsh-desktop-{}-{}",
        notify::now_ms(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    )
}

// ---------------------------------------------------------------------------
// 帧解析 + 白名单过滤 + 渲染（纯逻辑，可单测）
// ---------------------------------------------------------------------------

/// 解析一条下行文本帧，返回需要投递的消息。
///
/// `None` 表示：与推送无关、被白名单过滤、计数无净变化（去重）、或格式不符。
/// 任何字段不符合预期都静默丢弃 —— 下行帧的种类远多于本模块关心的两类，
/// 逐条报错只会淹没日志。
fn extract(raw: &str, notes: &mut Notes) -> Option<NotifyMessage> {
    let frame: Value = serde_json::from_str(raw).ok()?;
    // 下行帧统一包在 server-request 信封里（method 与 payload.type 同源）
    let payload = frame.get("payload")?;
    match payload.get("type").and_then(Value::as_str)? {
        "session/event" => session_event(payload, notes),
        "session/projection" => {
            let sid = payload.get("sessionId").and_then(Value::as_str)?;
            // 投影有十几种（tokenUsage / plan / goal …），只有 title 会影响文案
            if payload.get("key").and_then(Value::as_str) != Some("title") {
                return None;
            }
            let title = payload
                .get("value")
                .and_then(Value::as_str)
                .and_then(non_empty)
                .map(str::to_string);
            merge_title(notes, sid, title, false);
            None
        }
        // session/subscribed、stream/error 等与推送无关
        _ => None,
    }
}

fn session_event(payload: &Value, notes: &mut Notes) -> Option<NotifyMessage> {
    let sid = payload.get("sessionId").and_then(Value::as_str)?;
    let event = payload.get("event")?;
    // ignorable 事件（服务端标记的可忽略帧）不参与提醒
    if event.get("ignorable").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    match event.get("type").and_then(Value::as_str)? {
        "session/title" => {
            let title = event
                .pointer("/data/title")
                .and_then(Value::as_str)
                .and_then(non_empty);
            merge_title(notes, sid, title.map(str::to_string), false);
            None
        }
        "todo/write" => {
            // todo/write 是整表快照（last-write-wins），只需数三个状态
            let todos = event.pointer("/data/todos").and_then(Value::as_array)?;
            // 空清单不算「进展」，推一条 0/0/0 只是扰民
            if todos.is_empty() {
                return None;
            }
            let counts = count_todos(todos);
            let note = notes.entry(sid.to_string()).or_default();
            if note.last == Some(counts) {
                return None; // 去重：三个数字全等即视为无净变化
            }
            note.last = Some(counts);
            Some(todo_message(sid, note.title.as_deref(), counts))
        }
        "turn/end" => {
            let reason = event
                .pointer("/data/reason/kind")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let title = notes.get(sid).and_then(|n| n.title.as_deref());
            Some(turn_end_message(sid, title, reason))
        }
        // assistant/chunk、tool/call、approval/* … 一律不推，这就是需求的「过滤」
        _ => None,
    }
}

/// 标题合并。`only_if_empty` 用于会话列表基线：晚到的基线不覆盖实时事件学到的标题。
fn merge_title(notes: &mut Notes, sid: &str, title: Option<String>, only_if_empty: bool) {
    let note = notes.entry(sid.to_string()).or_default();
    if only_if_empty && note.title.is_some() {
        return;
    }
    note.title = title;
}

/// 空白标题按「无标题」处理（供 `Option::and_then` 直接接在 `as_str` 后面）
fn non_empty(s: &str) -> Option<&str> {
    let t = s.trim();
    (!t.is_empty()).then_some(t)
}

/// 与 dsh 客户端一致：只认三种状态，未知状态并入待处理，保证三段之和等于清单长度
fn count_todos(todos: &[Value]) -> TodoCounts {
    let mut c = TodoCounts::default();
    for t in todos {
        match t.get("status").and_then(Value::as_str) {
            Some("completed") => c.done += 1,
            Some("in_progress") => c.active += 1,
            _ => c.pending += 1,
        }
    }
    c
}

/// `{num} 已完成 · {num} 进行中 · {num} 待处理`，零值段省略、以间隔号连接
/// （需求原文「已完成」后的两个空格按 dsh 客户端 `progressLabel()` 取 ` · `）
fn todo_desc(done: u32, active: u32, pending: u32) -> String {
    let mut parts: Vec<String> = Vec::new();
    if done > 0 {
        parts.push(format!("{done} 已完成"));
    }
    if active > 0 {
        parts.push(format!("{active} 进行中"));
    }
    if pending > 0 {
        parts.push(format!("{pending} 待处理"));
    }
    parts.join(" · ")
}

/// `turn/end` 的结束原因 → 中文
fn reason_label(kind: &str) -> &'static str {
    match kind {
        "completed" => "正常完成",
        "aborted" => "已中断",
        "blocked" => "被阻塞",
        "error" => "运行出错",
        "max-tokens" => "达到输出上限",
        "interrupted" => "被重启中断",
        _ => "未知原因",
    }
}

fn todo_message(sid: &str, title: Option<&str>, c: TodoCounts) -> NotifyMessage {
    let desc = todo_desc(c.done, c.active, c.pending);
    NotifyMessage {
        kind: KIND_TODO,
        session_id: sid.to_string(),
        session_title: title.unwrap_or(UNTITLED).to_string(),
        title: TITLE_TODO,
        body: title.unwrap_or(UNTITLED).to_string(),
        summary: format!("{TITLE_TODO}：{desc}"),
        desc,
        ts: notify::now_ms(),
    }
}

fn turn_end_message(sid: &str, title: Option<&str>, reason: &str) -> NotifyMessage {
    let session_title = title.unwrap_or(UNTITLED);
    let desc = format!("{session_title} 对话已结束");
    NotifyMessage {
        kind: KIND_TURN_END,
        session_id: sid.to_string(),
        session_title: session_title.to_string(),
        title: TITLE_TURN_END,
        body: format!("原因：{}", reason_label(reason)),
        summary: format!("{TITLE_TURN_END}：{desc}"),
        desc,
        ts: notify::now_ms(),
    }
}

// ---------------------------------------------------------------------------
// 单测
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// 包成一条真实下行帧：`{"type":"server-request","rpcId":...,"method":...,"payload":...}`
    fn downlink(payload: Value) -> String {
        serde_json::json!({
            "type": "server-request",
            "rpcId": "r-1",
            "method": payload["type"],
            "payload": payload,
        })
        .to_string()
    }

    fn session_event_frame(sid: &str, event: Value) -> String {
        downlink(serde_json::json!({
            "type": "session/event",
            "sessionId": sid,
            "event": event,
        }))
    }

    fn todos(items: &[(&str, &str)]) -> Value {
        Value::Array(
            items
                .iter()
                .map(
                    |(content, status)| serde_json::json!({ "content": content, "status": status }),
                )
                .collect(),
        )
    }

    #[test]
    fn todo_desc_省略零值段并用间隔号连接() {
        assert_eq!(todo_desc(3, 1, 2), "3 已完成 · 1 进行中 · 2 待处理");
        assert_eq!(todo_desc(0, 1, 0), "1 进行中");
        assert_eq!(todo_desc(2, 0, 0), "2 已完成");
        assert_eq!(todo_desc(0, 0, 4), "4 待处理");
        assert_eq!(todo_desc(0, 0, 0), "");
    }

    /// 解析一条与线上同形的 server-request 帧
    #[test]
    fn 解析真实下行帧并渲染需求文案() {
        let raw = r#"{"type":"server-request","rpcId":"r","method":"session/event","payload":{"type":"session/event","sessionId":"session-x","event":{"type":"todo/write","seq":7,"time":0,"data":{"todos":[{"content":"a","status":"completed"},{"content":"b","status":"completed"},{"content":"c","status":"completed"},{"content":"d","status":"in_progress"},{"content":"e","status":"pending"},{"content":"f","status":"pending"}]}}}}"#;
        let mut notes = Notes::new();
        let msg = extract(raw, &mut notes).expect("应产生一条推送");
        assert_eq!(msg.kind, "todo");
        assert_eq!(msg.session_id, "session-x");
        assert_eq!(msg.summary, "更新任务清单：3 已完成 · 1 进行中 · 2 待处理");
        // 标题未知时 body 用兜底会话名
        assert_eq!(msg.body, "未命名对话");
        assert_eq!(msg.session_title, "未命名对话");
    }

    #[test]
    fn 计数未变化时不重复推送() {
        let mut notes = Notes::new();
        let items = &[("a", "completed"), ("b", "in_progress")];
        let frame = session_event_frame(
            "s1",
            serde_json::json!({ "type": "todo/write", "seq": 1, "time": 0, "data": { "todos": todos(items) } }),
        );
        assert!(extract(&frame, &mut notes).is_some());
        // 内容改了但三个计数没变（completed → in_progress 互换）→ 不推
        let again = session_event_frame(
            "s1",
            serde_json::json!({ "type": "todo/write", "seq": 2, "time": 0, "data": { "todos": todos(&[("a", "in_progress"), ("b", "completed")]) } }),
        );
        assert!(extract(&again, &mut notes).is_none(), "计数全等应被去重");
        // 计数变了 → 推
        let changed = session_event_frame(
            "s1",
            serde_json::json!({ "type": "todo/write", "seq": 3, "time": 0, "data": { "todos": todos(&[("a", "completed"), ("b", "completed")]) } }),
        );
        let msg = extract(&changed, &mut notes).expect("计数变化应推送");
        assert_eq!(msg.summary, "更新任务清单：2 已完成");
    }

    #[test]
    fn 空清单不推送() {
        let mut notes = Notes::new();
        let frame = session_event_frame(
            "s1",
            serde_json::json!({ "type": "todo/write", "seq": 1, "time": 0, "data": { "todos": [] } }),
        );
        assert!(extract(&frame, &mut notes).is_none());
    }

    #[test]
    fn ignorable_事件被丢弃() {
        let mut notes = Notes::new();
        let frame = session_event_frame(
            "s1",
            serde_json::json!({ "type": "turn/end", "seq": 1, "time": 0, "ignorable": true, "data": { "turn": 1, "reason": { "kind": "completed" } } }),
        );
        assert!(extract(&frame, &mut notes).is_none());
    }

    #[test]
    fn 非白名单事件不产生推送() {
        let mut notes = Notes::new();
        for ty in [
            "assistant/chunk",
            "tool/call",
            "approval/request",
            "user/message",
        ] {
            let frame = session_event_frame(
                "s1",
                serde_json::json!({ "type": ty, "seq": 1, "time": 0, "data": {} }),
            );
            assert!(extract(&frame, &mut notes).is_none(), "{ty} 不应推送");
        }
        // 无关的下行帧种类也不报错
        assert!(extract(
            &downlink(
                serde_json::json!({ "type": "session/subscribed", "sessionId": "s1", "lastSeq": 3 })
            ),
            &mut notes
        )
        .is_none());
        assert!(extract("not json", &mut notes).is_none());
        assert!(extract("{}", &mut notes).is_none());
    }

    #[test]
    fn turn_end_生成对话结束文案() {
        let mut notes = Notes::new();
        // 先学到标题
        let title = session_event_frame(
            "s1",
            serde_json::json!({ "type": "session/title", "seq": 1, "time": 0, "data": { "title": "重构推送链路" } }),
        );
        assert!(extract(&title, &mut notes).is_none(), "标题事件本身不推送");
        let frame = session_event_frame(
            "s1",
            serde_json::json!({ "type": "turn/end", "seq": 2, "time": 0, "data": { "turn": 3, "reason": { "kind": "completed" } } }),
        );
        let msg = extract(&frame, &mut notes).expect("turn/end 应推送");
        assert_eq!(msg.kind, "turnEnd");
        assert_eq!(msg.summary, "对话结束：重构推送链路 对话已结束");
        assert_eq!(msg.body, "原因：正常完成");
        // 标题缺失 → 未命名对话
        let frame2 = session_event_frame(
            "s2",
            serde_json::json!({ "type": "turn/end", "seq": 1, "time": 0, "data": { "turn": 1, "reason": { "kind": "aborted" } } }),
        );
        let msg2 = extract(&frame2, &mut notes).expect("应推送");
        assert_eq!(msg2.summary, "对话结束：未命名对话 对话已结束");
        assert_eq!(msg2.body, "原因：已中断");
        assert_eq!(reason_label("max-tokens"), "达到输出上限");
        assert_eq!(reason_label(""), "未知原因");
    }

    /// 标题来源合并：基线只填空白，事件与投影按到达顺序后者覆盖
    #[test]
    fn 标题来源合并() {
        let mut notes = Notes::new();
        // 1) session.list 基线
        merge_title(&mut notes, "s1", Some("基线标题".into()), true);
        assert_eq!(notes.get("s1").unwrap().title.as_deref(), Some("基线标题"));
        // 基线不覆盖已有标题
        merge_title(&mut notes, "s1", Some("晚到基线".into()), true);
        assert_eq!(notes.get("s1").unwrap().title.as_deref(), Some("基线标题"));
        // 2) session/title 事件覆盖
        let ev = session_event_frame(
            "s1",
            serde_json::json!({ "type": "session/title", "seq": 9, "time": 0, "data": { "title": "事件标题" } }),
        );
        extract(&ev, &mut notes);
        assert_eq!(notes.get("s1").unwrap().title.as_deref(), Some("事件标题"));
        // 3) title 投影覆盖
        let pj = downlink(serde_json::json!({
            "type": "session/projection", "sessionId": "s1", "key": "title", "value": "投影标题", "seq": 10,
        }));
        extract(&pj, &mut notes);
        assert_eq!(notes.get("s1").unwrap().title.as_deref(), Some("投影标题"));
        // 无关投影 key 不动标题
        let other = downlink(serde_json::json!({
            "type": "session/projection", "sessionId": "s1", "key": "tokenUsage", "value": { "total": 1 }, "seq": 11,
        }));
        extract(&other, &mut notes);
        assert_eq!(notes.get("s1").unwrap().title.as_deref(), Some("投影标题"));
        // 标题随后生效于推送文案
        let frame = session_event_frame(
            "s1",
            serde_json::json!({ "type": "turn/end", "seq": 12, "time": 0, "data": { "turn": 1, "reason": { "kind": "error" } } }),
        );
        assert_eq!(
            extract(&frame, &mut notes).unwrap().summary,
            "对话结束：投影标题 对话已结束"
        );
    }

    /// 多会话并发：各自的计数基线与标题互不干扰
    #[test]
    fn 多会话状态互不干扰() {
        let mut notes = Notes::new();
        let f = |sid: &str, done: u32| {
            session_event_frame(
                sid,
                serde_json::json!({ "type": "todo/write", "seq": 1, "time": 0, "data": { "todos": todos(&vec![("a", "completed"); done as usize]) } }),
            )
        };
        let a = extract(&f("sa", 1), &mut notes).unwrap();
        let b = extract(&f("sb", 5), &mut notes).unwrap();
        assert_eq!(a.summary, "更新任务清单：1 已完成");
        assert_eq!(b.summary, "更新任务清单：5 已完成");
        // sa 再推同样内容 → 去重；sb 不受影响
        assert!(extract(&f("sa", 1), &mut notes).is_none());
        assert!(extract(&f("sb", 5), &mut notes).is_none());
    }

    #[test]
    fn 端点解析优先探测地址() {
        let ep = Endpoint::parse("http://localhost:3080").unwrap();
        assert_eq!((ep.host.as_str(), ep.port), ("localhost", 3080));
        assert_eq!(ep.ws_url(MUX_PATH), "ws://localhost:3080/api/events.mux");
        assert_eq!(ep.http_base(), "http://localhost:3080");
        // 带路径、大写主机名、https 都能解析
        assert!(Endpoint::parse("https://127.0.0.1:6088/some/path").is_some());
        // 非法输入回退默认端口
        assert!(Endpoint::parse("http://localhost").is_none());
        assert!(Endpoint::parse("http://localhost:abc").is_none());
        assert!(Endpoint::parse("ftp://127.0.0.1:21").is_none());
    }

    #[test]
    fn 会话列表请求体符合信封格式() {
        let v = jsonrpc("session.list", serde_json::json!({}));
        assert_eq!(v["type"], "client-request");
        assert_eq!(v["method"], "session.list");
        assert_eq!(v["payload"], Value::Object(Default::default()));
        assert!(v["rpcId"].as_str().unwrap().starts_with("dsh-desktop-"));
    }
}
