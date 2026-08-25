//! dsh 进程管理：工具解析、全局安装、dsh web 启动/停止、服务探测与日志流式输出。

use serde::Serialize;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

// ---------------------------------------------------------------------------
// 事件名（前端通过 @tauri-apps/api/event 监听）
// ---------------------------------------------------------------------------
pub const INSTALL_LOG_EVENT: &str = "dsh://install-log";
pub const INSTALL_EXIT_EVENT: &str = "dsh://install-exit";
pub const WEB_LOG_EVENT: &str = "dsh://web-log";
pub const WEB_EXIT_EVENT: &str = "dsh://web-exit";
pub const URL_EVENT: &str = "dsh://url";
pub const PLUGIN_INSTALL_LOG_EVENT: &str = "dsh://plugin-install-log";
pub const PLUGIN_INSTALL_EXIT_EVENT: &str = "dsh://plugin-install-exit";

// ---------------------------------------------------------------------------
// 状态与负载
// ---------------------------------------------------------------------------

pub struct AppState {
    /// 正在运行的 `dsh web` 子进程 pid（无则为 None）
    pub child_pid: Mutex<Option<u32>>,
    /// 已探测到的服务 URL
    pub detected_url: Mutex<Option<String>>,
    /// 子进程输出中出现的候选 URL（用于持续复探与停止时按端口兜底清理）
    pub pending_urls: Mutex<Vec<String>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            child_pid: Mutex::new(None),
            detected_url: Mutex::new(None),
            pending_urls: Mutex::new(Vec::new()),
        }
    }
}

#[derive(Serialize, Clone)]
pub struct LogLine {
    pub stream: String, // "system" | "stdout" | "stderr"
    pub line: String,
}

#[derive(Serialize, Clone)]
pub struct ExitPayload {
    pub code: i32,
}

#[derive(Serialize, Clone)]
pub struct UrlPayload {
    pub url: String,
}

#[derive(Serialize, Clone)]
pub struct StatusPayload {
    pub dsh_installed: bool,
    pub service_running: bool,
    pub child_running: bool,
    pub url: Option<String>,
    pub pnpm_path: Option<String>,
    pub dsh_path: Option<String>,
    pub node_path: Option<String>,
    pub node_version: Option<String>,
    pub pnpm_version: Option<String>,
    pub plugins: Vec<String>,
    pub profile_ready: bool,
}

// ---------------------------------------------------------------------------
// 工具解析
// ---------------------------------------------------------------------------

/// Windows 下隐藏子进程的控制台窗口（防止黑窗口一闪而过），其他平台为 no-op。
///
/// GUI 父进程（本应用为 windows_subsystem=windows）派生的控制台子进程默认会
/// 新建一个控制台窗口；设置 `CREATE_NO_WINDOW`（0x08000000）即可避免闪烁。
fn hide_window(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// 通过 PATH 查找可执行文件（Windows: where.exe；类 Unix: which）
fn run_where(name: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let result = {
        #[cfg(windows)]
        {
            hide_window(Command::new("where.exe").arg(name)).output()
        }
        #[cfg(not(windows))]
        {
            Command::new("which").arg(name).output()
        }
    };
    if let Ok(output) = result {
        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout);
            for line in text.lines() {
                let p = PathBuf::from(line.trim());
                if p.exists() {
                    out.push(p);
                }
            }
        }
    }
    out
}

fn is_exec_shim(p: &PathBuf) -> bool {
    let name = p.to_string_lossy().to_lowercase();
    #[cfg(windows)]
    {
        name.ends_with(".exe") || name.ends_with(".cmd") || name.ends_with(".bat")
    }
    #[cfg(not(windows))]
    {
        // Unix 下 `which` 返回的文件即视为可执行（含 dsh 的 shebang 脚本）
        !name.ends_with(".ps1")
    }
}

fn is_ps1(p: &PathBuf) -> bool {
    p.to_string_lossy().to_lowercase().ends_with(".ps1")
}

fn resolve_pnpm() -> Option<PathBuf> {
    for p in run_where("pnpm") {
        if is_exec_shim(&p) {
            return Some(p);
        }
    }
    None
}

/// 通过 PATH 查找 node 可执行文件
fn resolve_node() -> Option<PathBuf> {
    run_where("node").into_iter().find(|p| is_exec_shim(p))
}

/// 执行 `<program> --version` 并解析首行输出版本号（去前导 v，如 `22.21.1`）。
///
/// 带 2 秒超时：子进程挂起时不阻塞 app_status；失败/超时/输出不合预期一律 None。
/// 输出首行必须形如 `major.minor[.patch]` 才视为有效版本。
fn read_tool_version(program: &PathBuf) -> Option<String> {
    let program = program.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let out = hide_window(Command::new(&program).arg("--version")).output();
        let _ = tx.send(out);
    });
    // recv_timeout 与子进程 output 是两层 Result，任一失败（超时/进程出错）都按 None 处理
    let output = match rx.recv_timeout(Duration::from_secs(2)) {
        Ok(Ok(out)) => out,
        _ => return None,
    };
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().next()?.trim();
    let ver = line.strip_prefix('v').unwrap_or(line);
    let mut parts = ver.split('.');
    parts.next()?.parse::<u64>().ok()?;
    Some(ver.to_string())
}

/// pnpm 全局 bin 目录（如 C:\Users\xxx\AppData\Local\pnpm）
fn pnpm_global_bin() -> Option<PathBuf> {
    let pnpm = resolve_pnpm()?;
    let output = hide_window(Command::new(&pnpm).args(["global", "bin"]))
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let dir = text.lines().next()?.trim();
    if dir.is_empty() {
        return None;
    }
    let p = PathBuf::from(dir);
    p.exists().then_some(p)
}

/// 可执行描述：program + 前置 args（ps1 需经 powershell 包装）
pub struct DshExec {
    pub program: String,
    pub args: Vec<String>,
    pub display: String,
}

fn resolve_dsh() -> Option<DshExec> {
    let matches = run_where("dsh");
    // 优先 .exe / .cmd / .bat
    for p in &matches {
        if is_exec_shim(p) {
            return Some(DshExec {
                program: p.to_string_lossy().into_owned(),
                args: vec![],
                display: p.to_string_lossy().into_owned(),
            });
        }
    }
    // .ps1 → powershell -File 包装
    for p in &matches {
        if is_ps1(p) {
            let path = p.to_string_lossy().into_owned();
            return Some(DshExec {
                program: "powershell".into(),
                args: vec![
                    "-NoProfile".into(),
                    "-ExecutionPolicy".into(),
                    "Bypass".into(),
                    "-File".into(),
                    path.clone(),
                ],
                display: path,
            });
        }
    }
    // 兜底：pnpm 全局 bin 目录
    if let Some(bin) = pnpm_global_bin() {
        #[cfg(windows)]
        let names = ["dsh.exe", "dsh.cmd", "dsh.bat"];
        #[cfg(not(windows))]
        let names = ["dsh"];
        for name in names {
            let p = bin.join(name);
            if p.exists() {
                return Some(DshExec {
                    program: p.to_string_lossy().into_owned(),
                    args: vec![],
                    display: p.to_string_lossy().into_owned(),
                });
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// 服务探测（纯 std TCP 探活）
// ---------------------------------------------------------------------------

pub fn probe_url(url: &str, timeout_ms: u64) -> bool {
    let stripped = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"));
    let Some(rest) = stripped else {
        return false;
    };
    let host_port = rest.split('/').next().unwrap_or(rest);
    let Some((host, port_str)) = host_port.rsplit_once(':') else {
        return false;
    };
    let Ok(port) = port_str.parse::<u16>() else {
        return false;
    };
    let Ok(addrs) = (host, port).to_socket_addrs() else {
        return false;
    };
    for addr in addrs {
        if let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(timeout_ms)) {
            let _ = stream.set_read_timeout(Some(Duration::from_millis(timeout_ms)));
            let req = format!("GET / HTTP/1.1\r\nHost: {host}:{port}\r\nUser-Agent: deepseek-harness-desktop\r\nConnection: close\r\n\r\n");
            let _ = stream.write_all(req.as_bytes());
            let mut buf = [0u8; 32];
            if let Ok(n) = stream.read(&mut buf) {
                if n > 0 {
                    return true;
                }
            }
        }
    }
    false
}

/// 并行探测多个 URL，返回第一个成功的
fn probe_parallel(urls: &[String], timeout_ms: u64) -> Option<String> {
    let mut handles = Vec::new();
    for u in urls {
        let u = u.clone();
        handles.push(std::thread::spawn(move || (u.clone(), probe_url(&u, timeout_ms))));
    }
    for h in handles {
        if let Ok((u, true)) = h.join() {
            return Some(u);
        }
    }
    None
}

/// 本应用管理的 dsh web 服务端口。
///
/// dev（tauri dev / debug 构建）与正式版（release 构建）使用不同端口，
/// 避免调试时误连/误杀正式版在 3080 上运行的服务，实现完全隔离：
/// - dev：6088（固定，不做进程身份探测）
/// - release：3080（dsh web 默认端口）
fn service_port() -> u16 {
    if cfg!(debug_assertions) {
        6088
    } else {
        3080
    }
}

fn default_candidates() -> Vec<String> {
    let port = service_port();
    vec![
        format!("http://127.0.0.1:{port}"),
        format!("http://localhost:{port}"),
    ]
}

/// 通过进程身份探测正在运行的 dsh web 服务，返回其实际监听端口对应的候选 URL。
///
/// 使用者可能以任意端口启动服务（如 `dsh web --port 9000`，或 `--port 0`
/// 由系统随机分配），固定端口探测会漏掉这些实例。这里枚举进程命令行
/// （含 "dsh" 且含 " web" 的进程），解析其监听端口；`--port 0` 或无 `--port`
/// 时用 netstat 反查该进程实际监听的端口。
///
/// 会排除本应用（deepseek-harness-desktop）自身派生的服务进程（父链上存在
/// deepseek-harness-desktop.exe），避免重复计入自家子进程；并过滤掉 dev 调试端口
/// 6088，防止正式版误连调试中的服务。仅 Windows 实现；其他平台返回空。
/// 注意：仅 release 编译并调用（dev 固定 6088，不做动态识别）。
#[cfg(not(debug_assertions))]
fn detect_dsh_process_urls() -> Vec<String> {
    #[cfg(windows)]
    {
        const SCRIPT: &str = r#"
$out = @()
function Test-IsLauncherChild([int]$ProcId) {
  $cur = $ProcId
  for ($i = 0; $i -lt 8; $i++) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction SilentlyContinue
    if (-not $p) { return $false }
    if ($p.Name -eq 'deepseek-harness-desktop.exe') { return $true }
    $cur = $p.ParentProcessId
  }
  return $false
}
$procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.CommandLine -and $_.CommandLine -match 'dsh' -and $_.CommandLine -match ' web( |$)' -and
  -not (Test-IsLauncherChild $_.ProcessId)
}
foreach ($p in $procs) {
  $port = $null
  if ($p.CommandLine -match '--port[ =](\d+)') { $port = [int]$Matches[1] }
  if (-not $port -or $port -eq 0) {
    $ls = Get-NetTCPConnection -State Listen -OwningProcess $p.ProcessId -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty LocalPort
    foreach ($lp in $ls) { $out += [string]$lp }
  } else {
    $out += [string]$port
  }
}
$out | Sort-Object -Unique
"#;
        let output = hide_window(
            Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
                .stdout(Stdio::piped())
                .stderr(Stdio::null()),
        )
        .output();
        let Ok(output) = output else {
            return Vec::new();
        };
        if !output.status.success() {
            return Vec::new();
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let mut urls: Vec<String> = Vec::new();
        for line in text.lines() {
            if let Ok(port) = line.trim().parse::<u16>() {
                if port == 0 || port == 6088 {
                    // 0 = 无监听；6088 = dev 调试端口，正式版一律跳过
                    continue;
                }
                urls.push(format!("http://127.0.0.1:{port}"));
                urls.push(format!("http://localhost:{port}"));
            }
        }
        urls.sort();
        urls.dedup();
        urls
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

/// 自家子进程运行时的探测候选：只认子进程输出提及的 URL 与本应用的默认端口，
/// 绝不把外部已存在的实例（如其他端口）当作我们的服务
fn child_candidates(pending: &[String]) -> Vec<String> {
    let port = service_port();
    let mut c = pending.to_vec();
    c.push(format!("http://127.0.0.1:{port}"));
    c.push(format!("http://localhost:{port}"));
    c.dedup();
    c
}

/// 从一行文本中提取 http://host:port 形式的 URL
fn extract_urls(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = line;
    while let Some(idx) = rest.find("http://") {
        let tail = &rest[idx + 7..];
        let end = tail
            .find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | ')' | '>' | '<' | ','))
            .unwrap_or(tail.len());
        let host_port = &tail[..end];
        if host_port.contains(':') && host_port.ends_with(|c: char| c.is_ascii_digit()) {
            out.push(format!("http://{host_port}"));
        }
        rest = &tail[end..];
    }
    out
}

// ---------------------------------------------------------------------------
// 日志 / 进程泵
// ---------------------------------------------------------------------------

fn emit_log(app: &AppHandle, event: &str, stream: &str, line: &str) {
    let _ = app.emit(
        event,
        LogLine {
            stream: stream.to_string(),
            line: line.to_string(),
        },
    );
}

/// 读取子进程 stdout/stderr 并逐行发出事件；进程结束后发出 exit 事件
fn pump_process(
    app: &AppHandle,
    mut child: Child,
    log_event: &'static str,
    exit_event: &'static str,
) {
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let app_out = app.clone();
    let h_out = std::thread::spawn(move || {
        if let Some(out) = stdout {
            let reader = BufReader::new(out);
            for line in reader.lines().map_while(Result::ok) {
                let line = line.trim_end_matches('\r').to_string();
                emit_log(&app_out, log_event, "stdout", &line);
                if log_event == WEB_LOG_EVENT {
                    try_detect_url(&app_out, &line);
                }
            }
        }
    });

    let app_err = app.clone();
    let h_err = std::thread::spawn(move || {
        if let Some(err) = stderr {
            let reader = BufReader::new(err);
            for line in reader.lines().map_while(Result::ok) {
                let line = line.trim_end_matches('\r').to_string();
                emit_log(&app_err, log_event, "stderr", &line);
            }
        }
    });

    let status = child.wait();
    let _ = h_out.join();
    let _ = h_err.join();
    let code = status
        .map(|s| s.code().unwrap_or(-1))
        .unwrap_or(-1);
    let _ = app.emit(exit_event, ExitPayload { code });
}

/// 从输出行里尝试探测 URL；记录候选并只处理一次成功
fn try_detect_url(app: &AppHandle, line: &str) {
    let urls = extract_urls(line);
    if urls.is_empty() {
        return;
    }
    // 记录到 pending，供 watcher 持续复探与 stop 时按端口兜底清理
    if let Some(state) = app.try_state::<AppState>() {
        let mut pending = state.pending_urls.lock().unwrap();
        for u in &urls {
            if !pending.contains(u) {
                pending.push(u.clone());
            }
        }
    }
    if let Some(state) = app.try_state::<AppState>() {
        if state.detected_url.lock().unwrap().is_some() {
            return;
        }
    }
    if let Some(url) = probe_parallel(&urls, 800) {
        if let Some(state) = app.try_state::<AppState>() {
            *state.detected_url.lock().unwrap() = Some(url.clone());
        }
        let _ = app.emit(URL_EVENT, UrlPayload { url });
    }
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn app_status(state: State<'_, AppState>) -> StatusPayload {
    let dsh = resolve_dsh();
    let dsh_installed = dsh.is_some();
    let dsh_path = dsh.map(|d| d.display);

    let pnpm = resolve_pnpm();
    let pnpm_version = pnpm.as_ref().and_then(|p| read_tool_version(p));
    let pnpm_path = pnpm.map(|p| p.to_string_lossy().into_owned());

    let node = resolve_node();
    let node_version = node.as_ref().and_then(|p| read_tool_version(p));
    let node_path = node.map(|p| p.to_string_lossy().into_owned());

    let (profile_ready, plugins) = read_profile_plugins();

    let child_running = {
        let guard = state.child_pid.lock().unwrap();
        guard.is_some()
    };

    let mut candidates: Vec<String> = Vec::new();
    if let Some(url) = state.detected_url.lock().unwrap().clone() {
        candidates.push(url);
    }
    candidates.extend(default_candidates());
    candidates.dedup();

    // dev 下不重赋值 → 不可变绑定，避免 unused_mut 警告；
    // release 下可能按进程身份复探并重赋值 → 可变绑定
    #[cfg(debug_assertions)]
    let url = probe_parallel(&candidates, 400);
    #[cfg(not(debug_assertions))]
    let mut url = probe_parallel(&candidates, 400);
    // 仅 release 在固定端口未命中时按进程身份探测（使用者以自定义端口启动的实例）；
    // dev 固定 6088，不做动态识别，避免与用户自启的 dsh 进程/正式版实例冲突
    #[cfg(not(debug_assertions))]
    if url.is_none() {
        let extra = detect_dsh_process_urls();
        if !extra.is_empty() {
            url = probe_parallel(&extra, 400);
        }
    }
    if let Some(ref u) = url {
        *state.detected_url.lock().unwrap() = Some(u.clone());
    }
    let service_running = url.is_some();

    StatusPayload {
        dsh_installed,
        service_running,
        child_running,
        url,
        pnpm_path,
        dsh_path,
        node_path,
        node_version,
        pnpm_version,
        plugins,
        profile_ready,
    }
}

#[tauri::command]
pub fn probe_service(url: String) -> bool {
    probe_url(&url, 800)
}

/// 全局安装 @deepseek-ai/dsh@latest（流式输出）
#[tauri::command]
pub fn install_dsh(app: AppHandle) -> Result<(), String> {
    let pnpm = resolve_pnpm().ok_or("未找到 pnpm，请先安装 pnpm（https://pnpm.io/zh-CN/installation）")?;
    emit_log(
        &app,
        INSTALL_LOG_EVENT,
        "system",
        &format!("$ {} add -g @deepseek-ai/dsh@latest", pnpm.display()),
    );
    let child = hide_window(
        Command::new(&pnpm)
            .args(["add", "-g", "@deepseek-ai/dsh@latest"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null()),
    )
    .spawn()
    .map_err(|e| format!("启动 pnpm 失败: {e}"))?;
    let app2 = app.clone();
    std::thread::spawn(move || {
        pump_process(&app2, child, INSTALL_LOG_EVENT, INSTALL_EXIT_EVENT);
    });
    Ok(())
}

/// 启动 dsh web（流式输出；子进程存活期间持有 pid）
#[tauri::command]
pub fn start_dsh_web(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if state.child_pid.lock().unwrap().is_some() {
        return Ok(()); // 已在运行
    }
    // 新子进程 → 重置上一轮的探测结果，避免误用外部实例/旧 URL
    *state.detected_url.lock().unwrap() = None;
    state.pending_urls.lock().unwrap().clear();
    let dsh = resolve_dsh().ok_or("未找到 dsh，请先执行全局安装 @deepseek-ai/dsh")?;
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".into());
    emit_log(
        &app,
        WEB_LOG_EVENT,
        "system",
        // --no-open：dsh web 默认会在服务就绪后调用系统浏览器打开 UI（见
        // @deepseek-ai/dsh-web-app 的 openBrowser 配置），桌面壳自身以 iframe 承载 UI，必须禁用
        &format!("$ {} web --no-open", dsh.display),
    );

    let mut cmd = Command::new(&dsh.program);
    cmd.args(&dsh.args)
        .arg("web")
        .arg("--no-open")
        .arg("--port")
        .arg(service_port().to_string())
        .current_dir(&home)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    let child = hide_window(&mut cmd)
        .spawn()
        .map_err(|e| format!("启动 dsh web 失败: {e}"))?;
    let pid = child.id();
    *state.child_pid.lock().unwrap() = Some(pid);

    // 泵输出 + 退出后清理 pid
    let app2 = app.clone();
    std::thread::spawn(move || {
        pump_process(&app2, child, WEB_LOG_EVENT, WEB_EXIT_EVENT);
        if let Some(s) = app2.try_state::<AppState>() {
            *s.child_pid.lock().unwrap() = None;
        }
    });

    // 后台探测循环：服务就绪后发出 URL 事件（最长约 20 分钟，覆盖首次联网初始化）
    let app3 = app.clone();
    std::thread::spawn(move || {
        for _ in 0..2400 {
            let alive = app3
                .try_state::<AppState>()
                .map(|s| s.child_pid.lock().unwrap().is_some())
                .unwrap_or(false);
            if !alive {
                return;
            }
            let already = app3
                .try_state::<AppState>()
                .map(|s| s.detected_url.lock().unwrap().is_some())
                .unwrap_or(false);
            if already {
                return;
            }
            let pending: Vec<String> = app3
                .try_state::<AppState>()
                .map(|s| s.pending_urls.lock().unwrap().clone())
                .unwrap_or_default();
            let candidates = child_candidates(&pending);
            if let Some(url) = probe_parallel(&candidates, 250) {
                if let Some(s) = app3.try_state::<AppState>() {
                    *s.detected_url.lock().unwrap() = Some(url.clone());
                }
                let _ = app3.emit(URL_EVENT, UrlPayload { url });
                return;
            }
            std::thread::sleep(Duration::from_millis(400));
        }
    });
    Ok(())
}

pub fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        let _ = hide_window(
            Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null()),
        )
        .status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill")
            .arg("-9")
            .arg(pid.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

/// 停止 dsh web（杀死整棵进程树，并按子进程输出过的端口兜底清理脱离进程）
#[tauri::command]
pub fn stop_dsh_web(state: State<'_, AppState>) {
    let pid = state.child_pid.lock().unwrap().take();
    if let Some(pid) = pid {
        kill_tree(pid);
    }
    // 等待树清理，然后按端口兜底（dsh 会派生脱离父链的进程）
    let urls: Vec<String> = state.pending_urls.lock().unwrap().clone();
    std::thread::sleep(Duration::from_millis(600));
    for url in &urls {
        if let Some(port) = url_port(url) {
            kill_listener(port);
        }
    }
    // 服务已停止，清除已探测 URL，避免托盘"浏览器中打开"打开死链
    *state.detected_url.lock().unwrap() = None;
}

fn url_port(url: &str) -> Option<u16> {
    let stripped = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))?;
    let host_port = stripped.split('/').next()?;
    host_port.rsplit_once(':')?.1.parse().ok()
}

/// 杀掉监听指定端口的进程（仅用于我们自己子进程输出过的端口）
fn kill_listener(port: u16) {
    let output = hide_window(Command::new("netstat").args(["-ano", "-p", "tcp"]))
        .output()
        .ok();
    let Some(out) = output else {
        return;
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let needle = format!(":{port}");
    for line in text.lines() {
        let l = line.trim();
        if l.contains(&needle) && l.contains("LISTENING") {
            if let Some(pid_str) = l.split_whitespace().last() {
                if let Ok(pid) = pid_str.parse::<u32>() {
                    let _ = hide_window(
                        Command::new("taskkill")
                            .args(["/PID", &pid.to_string(), "/T", "/F"])
                            .stdout(Stdio::null())
                            .stderr(Stdio::null()),
                    )
                    .status();
                }
            }
        }
    }
}

/// 在系统默认浏览器中打开 URL（前端命令与托盘菜单共用）
pub fn open_url(url: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        hide_window(Command::new("cmd").args(["/C", "start", "", url]))
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg(url).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open").arg(url).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 在系统默认浏览器中打开 URL
#[tauri::command]
pub fn open_in_browser(url: String) -> Result<(), String> {
    open_url(&url)
}

// ---------------------------------------------------------------------------
// dsh profile 插件管理（%USERPROFILE%\.dsh\profiles\web\package.json）
// ---------------------------------------------------------------------------

/// 用户 dsh profile 目录（%USERPROFILE%\.dsh\profiles\web），不存在时 None
fn profile_dir() -> Option<PathBuf> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    let dir = PathBuf::from(home).join(".dsh").join("profiles").join("web");
    dir.is_dir().then_some(dir)
}

fn profile_package_json() -> Option<PathBuf> {
    profile_dir().map(|d| d.join("package.json"))
}

/// 读取插件列表：按 bundles 数组顺序过滤出存在于 dependencies 中的名字。
/// 返回 (package.json 存在且可解析, 插件名列表)；文件缺失/解析失败均为 (false, [])
fn read_profile_plugins() -> (bool, Vec<String>) {
    let Some(path) = profile_package_json() else {
        return (false, Vec::new());
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return (false, Vec::new());
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return (false, Vec::new());
    };
    let deps = v.get("dependencies").and_then(|d| d.as_object());
    let bundles = v
        .get("dsh")
        .and_then(|d| d.get("profile"))
        .and_then(|p| p.get("bundles"))
        .and_then(|b| b.as_array());
    let mut plugins = Vec::new();
    if let (Some(deps), Some(bundles)) = (deps, bundles) {
        for b in bundles {
            if let Some(name) = b.as_str() {
                if deps.contains_key(name) && !plugins.iter().any(|p| p == name) {
                    plugins.push(name.to_string());
                }
            }
        }
    }
    (true, plugins)
}

/// 从 profile package.json 移除插件：同时删除 bundles 数组项与 dependencies 键，
/// 写回时保持键顺序（preserve_order）与两空格缩进
#[tauri::command]
pub fn remove_plugin(name: String) -> Result<(), String> {
    let path =
        profile_package_json().ok_or("未找到插件目录（%USERPROFILE%\\.dsh\\profiles\\web）")?;
    let text = std::fs::read_to_string(&path).map_err(|e| format!("读取 package.json 失败: {e}"))?;
    let mut v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("package.json 解析失败: {e}"))?;

    let in_deps = v
        .get_mut("dependencies")
        .and_then(|d| d.as_object_mut())
        .map(|o| o.remove(&name).is_some())
        .unwrap_or(false);
    let mut in_bundles = false;
    if let Some(arr) = v
        .get_mut("dsh")
        .and_then(|d| d.get_mut("profile"))
        .and_then(|p| p.get_mut("bundles"))
        .and_then(|b| b.as_array_mut())
    {
        let before = arr.len();
        arr.retain(|x| x.as_str() != Some(name.as_str()));
        in_bundles = arr.len() != before;
    }

    if !in_deps && !in_bundles {
        return Err(format!("插件 {name} 不在 package.json 中"));
    }

    let out = serde_json::to_string_pretty(&v).map_err(|e| format!("序列化失败: {e}"))?;
    std::fs::write(&path, out + "\n").map_err(|e| format!("写回 package.json 失败: {e}"))?;
    Ok(())
}

/// 在 profile 目录执行 pnpm install（幂等，无变化秒级完成）；
/// 目录或 package.json 不存在时直接成功（首次运行尚未生成 profile）。
/// 输出经 plugin-install-log 流式转发，退出码经 plugin-install-exit 通知前端续接。
#[tauri::command]
pub fn install_plugins(app: AppHandle) -> Result<(), String> {
    let Some(dir) = profile_dir() else {
        return Ok(());
    };
    if !dir.join("package.json").is_file() {
        return Ok(());
    }
    let pnpm =
        resolve_pnpm().ok_or("未找到 pnpm，请先安装 pnpm（https://pnpm.io/zh-CN/installation）")?;
    emit_log(
        &app,
        PLUGIN_INSTALL_LOG_EVENT,
        "system",
        &format!("$ pnpm install（{}）", dir.display()),
    );
    let child = hide_window(
        Command::new(&pnpm)
            .arg("install")
            .current_dir(&dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null()),
    )
    .spawn()
    .map_err(|e| format!("启动 pnpm install 失败: {e}"))?;
    let app2 = app.clone();
    std::thread::spawn(move || {
        pump_process(
            &app2,
            child,
            PLUGIN_INSTALL_LOG_EVENT,
            PLUGIN_INSTALL_EXIT_EVENT,
        );
    });
    Ok(())
}
