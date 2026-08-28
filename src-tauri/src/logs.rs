//! 会话化日志管理：每次服务启动/重启创建一条独立日志会话（`logs/{id}.jsonl`），
//! 前端把每条日志串行镜像到当前会话文件；应用退出/崩溃后历史记录仍可查看。
//!
//! 文件格式（JSON Lines）：
//! - 首行：会话 header（id / title / started_at / ended_at / status）
//! - 后续每行：一条日志 `{"time","stream","text"}`

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

use crate::dsh::AppState;

/// 当前活动日志会话（内存态；文件路径由 id 推导）
pub struct ActiveLog {
    pub id: String,
}

/// 单条日志（与前端 useAppStore 的 LogEntry 同构）
#[derive(Serialize, Deserialize, Clone)]
pub struct LogEntry {
    pub time: String,
    pub stream: String,
    pub text: String,
}

/// 会话元信息（供列表展示）
#[derive(Serialize, Clone)]
pub struct LogSessionMeta {
    pub id: String,
    pub title: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    /// "active" | "success" | "error" | "closed"
    pub status: String,
    pub lines: usize,
}

/// 会话文件首行 header（含 id / 标题 / 起止时间 / 状态）
#[derive(Serialize, Deserialize, Clone)]
struct SessionHeader {
    id: String,
    title: String,
    started_at: i64,
    ended_at: Option<i64>,
    status: String,
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 日志目录：应用数据目录/logs（自动创建）
fn logs_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录: {e}"))?
        .join("logs");
    fs::create_dir_all(&dir).map_err(|e| format!("创建日志目录失败: {e}"))?;
    Ok(dir)
}

fn session_file(dir: &PathBuf, id: &str) -> PathBuf {
    dir.join(format!("{id}.jsonl"))
}

/// 生成会话 id：unix 纳秒字符串，保证唯一
fn session_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos}")
}

/// 重写会话文件 header 行（保留后续日志行不变）；失败静默（非关键路径）
fn rewrite_header(file: &PathBuf, f: impl FnOnce(&mut SessionHeader)) {
    let Ok(content) = fs::read_to_string(file) else { return };
    let mut it = content.lines();
    let Some(first) = it.next() else { return };
    let Ok(mut h) = serde_json::from_str::<SessionHeader>(first) else { return };
    f(&mut h);
    let Ok(new_first) = serde_json::to_string(&h) else { return };
    let mut out = String::with_capacity(content.len() + 16);
    out.push_str(&new_first);
    out.push('\n');
    for l in it {
        out.push_str(l);
        out.push('\n');
    }
    let _ = fs::write(file, out);
}

/// 结束当前活动会话：补写 ended_at；status 仍为 active 时置 closed。
/// 应用启动（setup）与退出（RunEvent::Exit）时各调用一次，覆盖崩溃/异常退出。
pub fn finalize_active(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else { return };
    let id = state.active_log.lock().unwrap().take().map(|a| a.id);
    let Some(id) = id else { return };
    if let Ok(dir) = logs_dir(app) {
        rewrite_header(&session_file(&dir, &id), |h| {
            h.ended_at = Some(unix_now());
            if h.status == "active" {
                h.status = "closed".into();
            }
        });
    }
}

/// 开始新日志会话：先 finalize 旧会话，再创建新会话文件并返回会话 id
#[tauri::command]
pub fn log_start_session(app: AppHandle, title: String) -> Result<String, String> {
    finalize_active(&app);
    let dir = logs_dir(&app)?;
    let id = session_id();
    let header = SessionHeader {
        id: id.clone(),
        title,
        started_at: unix_now(),
        ended_at: None,
        status: "active".into(),
    };
    let mut file = fs::File::create(session_file(&dir, &id))
        .map_err(|e| format!("创建日志会话失败: {e}"))?;
    writeln!(
        file,
        "{}",
        serde_json::to_string(&header).map_err(|e| format!("序列化失败: {e}"))?
    )
    .map_err(|e| format!("写入日志会话失败: {e}"))?;
    if let Some(state) = app.try_state::<AppState>() {
        *state.active_log.lock().unwrap() = Some(ActiveLog { id: id.clone() });
    }
    Ok(id)
}

/// 追加一条日志到当前活动会话（无活动会话时静默忽略）
#[tauri::command]
pub fn log_append(app: AppHandle, entry: LogEntry) -> Result<(), String> {
    let Some(state) = app.try_state::<AppState>() else {
        return Ok(());
    };
    let id = state
        .active_log
        .lock()
        .unwrap()
        .as_ref()
        .map(|a| a.id.clone());
    let Some(id) = id else {
        return Ok(());
    };
    let dir = logs_dir(&app)?;
    let mut file = fs::OpenOptions::new()
        .append(true)
        .open(session_file(&dir, &id))
        .map_err(|e| format!("打开日志会话失败: {e}"))?;
    writeln!(
        file,
        "{}",
        serde_json::to_string(&entry).map_err(|e| format!("序列化失败: {e}"))?
    )
    .map_err(|e| format!("写入日志失败: {e}"))?;
    Ok(())
}

/// 更新会话状态（success / error / closed）；状态非 active 时同时补写结束时间
#[tauri::command]
pub fn log_set_status(app: AppHandle, id: String, status: String) -> Result<(), String> {
    if !matches!(status.as_str(), "success" | "error" | "closed") {
        return Err(format!("不支持的会话状态: {status}"));
    }
    let dir = logs_dir(&app)?;
    let file = session_file(&dir, &id);
    if !file.exists() {
        return Ok(()); // 会话已被清空等：静默忽略
    }
    rewrite_header(&file, move |h| {
        h.status = status;
        if h.ended_at.is_none() {
            h.ended_at = Some(unix_now());
        }
    });
    Ok(())
}

/// 会话列表：扫描日志目录解析各文件 header，按开始时间倒序（含行数）
#[tauri::command]
pub fn log_sessions(app: AppHandle) -> Result<Vec<LogSessionMeta>, String> {
    let dir = logs_dir(&app)?;
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| format!("读取日志目录失败: {e}"))? {
        let entry = entry.map_err(|e| format!("读取日志目录失败: {e}"))?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        let mut it = content.lines();
        let Some(first) = it.next() else { continue };
        let Ok(h) = serde_json::from_str::<SessionHeader>(first) else {
            continue;
        };
        out.push(LogSessionMeta {
            id: h.id,
            title: h.title,
            started_at: h.started_at,
            ended_at: h.ended_at,
            status: h.status,
            lines: it.count(),
        });
    }
    out.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    Ok(out)
}

/// 读取会话全部日志行（跳过 header）
#[tauri::command]
pub fn log_content(app: AppHandle, id: String) -> Result<Vec<LogEntry>, String> {
    let dir = logs_dir(&app)?;
    let file = session_file(&dir, &id);
    let content = fs::read_to_string(&file).map_err(|e| format!("读取日志会话失败: {e}"))?;
    let mut out = Vec::new();
    for line in content.lines().skip(1) {
        if let Ok(e) = serde_json::from_str::<LogEntry>(line) {
            out.push(e);
        }
    }
    Ok(out)
}

/// 清空全部日志会话（保留目录）
#[tauri::command]
pub fn log_clear(app: AppHandle) -> Result<(), String> {
    if let Some(state) = app.try_state::<AppState>() {
        *state.active_log.lock().unwrap() = None;
    }
    let dir = logs_dir(&app)?;
    for entry in fs::read_dir(&dir).map_err(|e| format!("读取日志目录失败: {e}"))? {
        let entry = entry.map_err(|e| format!("读取日志目录失败: {e}"))?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            let _ = fs::remove_file(&path);
        }
    }
    Ok(())
}
