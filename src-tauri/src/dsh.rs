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
pub const ENV_INSTALL_LOG_EVENT: &str = "dsh://env-install-log";
pub const ENV_INSTALL_EXIT_EVENT: &str = "dsh://env-install-exit";
pub const WEB_LOG_EVENT: &str = "dsh://web-log";
pub const WEB_EXIT_EVENT: &str = "dsh://web-exit";
pub const URL_EVENT: &str = "dsh://url";
pub const PLUGIN_INSTALL_LOG_EVENT: &str = "dsh://plugin-install-log";
pub const PLUGIN_INSTALL_EXIT_EVENT: &str = "dsh://plugin-install-exit";
pub const PLUGIN_OP_LOG_EVENT: &str = "dsh://plugin-op-log";
pub const PLUGIN_OP_EXIT_EVENT: &str = "dsh://plugin-op-exit";

// ---------------------------------------------------------------------------
// 状态与负载
// ---------------------------------------------------------------------------

/// 进行中的插件 CLI 操作
/// （kind/name 暂未被读取，保留给后续状态查询与日志展示使用）
#[allow(dead_code)]
pub struct PluginOpState {
    pub pid: u32,
    pub kind: String,
    pub name: String,
}

pub struct AppState {
    /// 正在运行的 `dsh web` 子进程 pid（无则为 None）
    pub child_pid: Mutex<Option<u32>>,
    /// 进行中的插件 CLI 操作（单并发，无则为 None）
    pub plugin_op: Mutex<Option<PluginOpState>>,
    /// 已探测到的服务 URL
    pub detected_url: Mutex<Option<String>>,
    /// 子进程输出中出现的候选 URL（用于持续复探与停止时按端口兜底清理）
    pub pending_urls: Mutex<Vec<String>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            child_pid: Mutex::new(None),
            plugin_op: Mutex::new(None),
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
    pub dsh_version: Option<String>,
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

/// 带超时执行命令并收集输出；超时后杀死进程树并返回 None。
///
/// 环境检测（app_status）会在前台串行探测 node / pnpm / dsh，任何一次子进程
/// 挂起（where.exe 卡壳、PowerShell 的 Get-CimInstance 全量进程枚举变慢、npm
/// shim 等待等）都会让同步命令永久阻塞、前端永远等不到结果而"卡死"。
/// 统一在此兜底：超时即 taskkill 整棵进程树，保证命令最迟在超时时刻返回。
///
/// 注意：必须显式把 stdin/stdout/stderr 设为管道/丢弃，等价于 Command::output()
/// 的语义——否则子进程输出会继承 GUI 父进程的句柄（无效或直接打到终端），
/// wait_with_output 捕获不到内容，导致版本/路径解析全部为空。
fn run_with_timeout(mut cmd: Command, timeout: Duration) -> Option<std::process::Output> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let child = hide_window(&mut cmd).spawn().ok()?;
    let pid = child.id();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let out = child.wait_with_output();
        let _ = tx.send(out);
    });
    match rx.recv_timeout(timeout) {
        Ok(Ok(out)) => Some(out),
        Ok(Err(_)) => None,
        Err(_) => {
            // 超时：杀掉整棵进程树（taskkill /T /F），避免残留子进程继续占用
            kill_tree(pid);
            None
        }
    }
}

/// 通过 PATH 查找可执行文件（Windows: where.exe；类 Unix: which）
fn run_where(name: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let result = {
        #[cfg(windows)]
        {
            let mut cmd = Command::new("where.exe");
            cmd.arg(name);
            run_with_timeout(cmd, Duration::from_secs(3))
        }
        #[cfg(not(windows))]
        {
            let mut cmd = Command::new("which");
            cmd.arg(name);
            run_with_timeout(cmd, Duration::from_secs(3))
        }
    };
    if let Some(output) = result {
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

/// 执行 `<program> [args...] --version` 并解析首行输出版本号（去前导 v，如 `22.21.1`）。
///
/// 带 2 秒超时：子进程挂起时不阻塞 app_status；失败/超时/输出不合预期一律 None。
/// 输出首行必须形如 `major.minor[.patch]` 才视为有效版本。
fn read_exec_version(program: &str, args: &[String]) -> Option<String> {
    let mut cmd = Command::new(program);
    cmd.args(args).arg("--version");
    let output = run_with_timeout(cmd, Duration::from_secs(2))?;
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

/// 执行 `<program> --version` 并解析首行输出版本号（node / pnpm 等无前置参数的工具）
fn read_tool_version(program: &PathBuf) -> Option<String> {
    read_exec_version(&program.to_string_lossy(), &[])
}

/// 读取已解析的 dsh 可执行文件版本（`.ps1` 包装经 powershell 前置参数执行）
fn read_dsh_version(dsh: &DshExec) -> Option<String> {
    read_exec_version(&dsh.program, &dsh.args)
}

// ---------------------------------------------------------------------------
// PATH 刷新与环境依赖安装辅助
// ---------------------------------------------------------------------------

/// 把新目录合并进当前进程的 PATH（新目录优先、去重）。
///
/// 安装器（winget/brew/npm 全局安装）写入的新路径只反映在注册表/登录配置里，
/// 本进程与后续子进程继承的还是启动时的旧 PATH——不刷新的话，刚装好的
/// node/pnpm 在同一会话里永远探测不到。前端在每步安装后调用
/// refresh_search_path 触发本合并。
#[cfg(any(windows, target_os = "macos"))]
fn merge_into_process_path(new_dirs: Vec<String>) {
    #[cfg(windows)]
    let sep = ';';
    #[cfg(not(windows))]
    let sep = ':';
    let current = std::env::var("PATH").unwrap_or_default();
    let mut merged: Vec<String> = Vec::new();
    for d in new_dirs.into_iter().chain(current.split(sep).map(|s| s.to_string())) {
        let d = d.trim().to_string();
        if d.is_empty() {
            continue;
        }
        #[cfg(windows)]
        let dup = merged.iter().any(|m| m.eq_ignore_ascii_case(&d));
        #[cfg(not(windows))]
        let dup = merged.iter().any(|m| m == &d);
        if !dup {
            merged.push(d);
        }
    }
    // Vec<String>::join 只接受 &str；char 分隔符在此不可用
    let sep_str: String = sep.to_string();
    std::env::set_var("PATH", merged.join(&sep_str));
}

/// macOS：读取登录 shell 的 PATH（结果进程内缓存）。
/// GUI 应用从 Finder 启动时不经过 .zprofile/.zshrc，/opt/homebrew/bin 等
/// 目录常缺席，导致明明装了 node/pnpm/dsh 却探测不到；登录 shell 会加载完整配置。
#[cfg(target_os = "macos")]
fn login_shell_path() -> Option<String> {
    static CACHE: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    CACHE
        .get_or_init(|| {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
            let mut cmd = Command::new(shell);
            cmd.args(["-l", "-c", "printf %s \"$PATH\""]);
            let out = run_with_timeout(cmd, Duration::from_secs(6))?;
            if !out.status.success() {
                return None;
            }
            let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
            (!text.is_empty()).then_some(text)
        })
        .clone()
}

/// macOS：把登录 shell 的 PATH 合并进当前进程 PATH（幂等，重复调用开销极低）。
#[cfg(target_os = "macos")]
fn merge_login_shell_path() {
    if let Some(p) = login_shell_path() {
        let dirs: Vec<String> = p
            .split(':')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        merge_into_process_path(dirs);
    }
}

/// 环境检测前的搜索路径兜底：macOS 合并登录 shell PATH；其他平台为 no-op。
pub fn ensure_search_path() {
    #[cfg(target_os = "macos")]
    merge_login_shell_path();
}

/// 读取用户环境目录（如 %LOCALAPPDATA%）
#[cfg(windows)]
fn env_dir(var: &str) -> Option<PathBuf> {
    std::env::var_os(var).map(PathBuf::from)
}

/// 定位 npm 可执行文件：
/// - Windows：where.exe 解析（取 .exe/.cmd/.bat shim），全局安装在用户目录无需管理员；
/// - macOS/Linux：先 which（ensure_search_path 已合并登录 PATH），再常见固定位置兜底。
fn resolve_npm() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        run_where("npm").into_iter().find(|p| is_exec_shim(p))
    }
    #[cfg(not(windows))]
    {
        for p in run_where("npm") {
            return Some(p);
        }
        for c in ["/opt/homebrew/bin/npm", "/usr/local/bin/npm"] {
            let p = PathBuf::from(c);
            if p.exists() {
                return Some(p);
            }
        }
        None
    }
}

// ---------------------------------------------------------------------------
// 系统语言检测与 npm 国内镜像
// ---------------------------------------------------------------------------

/// 系统语言是否为中文（进程内缓存，应用打开后首次使用时收集一次）。
/// - Windows：注册表 PreferredUILanguages（reg query 快速读取，无需额外依赖）；
/// - macOS/Linux：LANG / LC_ALL 环境变量以 zh 开头。
/// 检测失败一律按非中文处理：绝不改动用户的源配置。
fn system_is_chinese() -> bool {
    static CACHE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *CACHE.get_or_init(|| {
        #[cfg(windows)]
        {
            // 注意：builder 链返回 &mut Command，需先绑定到变量再按值传给 run_with_timeout
            let mut reg = Command::new("reg");
            reg.args([
                "query",
                "HKCU\\Control Panel\\Desktop",
                "/v",
                "PreferredUILanguages",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
            if let Some(output) = run_with_timeout(reg, Duration::from_secs(3)) {
                if output.status.success() {
                    let text = String::from_utf8_lossy(&output.stdout);
                    for tok in text.split_whitespace() {
                        let t = tok.to_lowercase();
                        // 形如 zh-CN / zh-Hans / zh
                        if t == "zh" || t.starts_with("zh-") || t.starts_with("zh_") {
                            return true;
                        }
                    }
                }
            }
            // 兜底：终端/WSL 场景会话里带 LANG
            std::env::var("LANG")
                .map(|v| v.to_lowercase().starts_with("zh"))
                .unwrap_or(false)
        }
        #[cfg(not(windows))]
        {
            for k in ["LC_ALL", "LANG"] {
                if let Ok(v) = std::env::var(k) {
                    if v.to_lowercase().starts_with("zh") {
                        return true;
                    }
                }
            }
            false
        }
    })
}

/// 中文系统下为 npm/pnpm 安装追加华为云国内镜像源参数；
/// 非中文系统返回空切片（完全不动用户源配置）。
fn npm_mirror_args() -> Vec<&'static str> {
    if system_is_chinese() {
        vec!["--registry", "https://repo.huaweicloud.com/repository/npm/"]
    } else {
        Vec::new()
    }
}

/// 中文系统时先输出一条提示日志（让用户知道本次下载走国内镜像源）
fn log_npm_mirror(app: &AppHandle, event: &'static str) {
    if system_is_chinese() {
        emit_log(
            app,
            event,
            "system",
            "已检测到中文系统：本次安装使用国内镜像源 https://repo.huaweicloud.com/repository/npm/",
        );
    }
}

/// pnpm 全局 bin 目录（如 C:\Users\xxx\AppData\Local\pnpm）
fn pnpm_global_bin() -> Option<PathBuf> {
    let pnpm = resolve_pnpm()?;
    let mut cmd = Command::new(&pnpm);
    cmd.args(["global", "bin"]);
    let output = run_with_timeout(cmd, Duration::from_secs(3))?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let dir = text.lines().next()?.trim();
    if dir.is_empty() {
        return None;
    }
    let p = PathBuf::from(dir);
    // 目录可能尚未创建（全新环境首次使用 pnpm）：主动建出，保证可注入 PATH
    if !p.exists() {
        std::fs::create_dir_all(&p).ok()?;
    }
    Some(p)
}

/// 为即将执行的 pnpm / dsh 子进程注入全局 bin 相关环境：
/// 把 pnpm 全局目录前置到子进程 PATH，并设置 PNPM_HOME。
/// 背景：未执行过 `pnpm setup` 的机器上该目录不在 PATH，`pnpm add -g` 会直接报错
/// （the configured global bin directory ... is not in PATH）。
/// 仅影响本次子进程，不改用户 shell 配置；当前 PATH 已包含时不重复记日志。
fn apply_pnpm_env(app: &AppHandle, event: &'static str, cmd: &mut Command) {
    let Some(dir) = pnpm_global_bin() else { return };
    #[cfg(windows)]
    let sep = ";";
    #[cfg(not(windows))]
    let sep = ":";
    let cur = std::env::var("PATH").unwrap_or_default();
    let dir_str = dir.to_string_lossy().into_owned();
    let already = cur.split(sep).any(|p| p.trim().eq_ignore_ascii_case(dir_str.as_str()));
    cmd.env("PATH", format!("{dir_str}{sep}{cur}"));
    cmd.env("PNPM_HOME", &dir);
    if !already {
        emit_log(
            app,
            event,
            "system",
            &format!("检测到未运行过 pnpm setup：已为本进程临时注入全局目录 {}", dir.display()),
        );
    }
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
        let output = run_with_timeout(
            {
                let mut cmd = Command::new("powershell");
                cmd.args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null());
                cmd
            },
            // PowerShell 冷启动 + Get-CimInstance 全量进程枚举可能很慢，
            // 放宽到 5 秒但绝不无限等待（否则打包版 app_status 卡死）
            Duration::from_secs(5),
        );
        let Some(output) = output else {
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

/// 环境检测：子进程解析/版本读取/服务探测均为秒级阻塞操作。
/// Tauri 同步命令在【主线程】执行，会冻结整个窗口（表现为启动时"卡死"）；
/// 因此必须是 async 命令并把重活移交 spawn_blocking 线程池，主线程零阻塞。
#[tauri::command]
pub async fn app_status(state: State<'_, AppState>) -> Result<StatusPayload, String> {
    // 主线程仅做微秒级锁快照；State 借用无法移入 'static 闭包，先取出所需值
    let child_running = state.child_pid.lock().unwrap().is_some();
    let detected_url = state.detected_url.lock().unwrap().clone();
    let payload = tauri::async_runtime::spawn_blocking(move || {
        app_status_blocking(child_running, detected_url)
    })
    .await
    .map_err(|e| format!("环境检测任务异常: {e}"))?;
    // 探测到运行中的服务则记入状态，供托盘"浏览器中打开"与停止兜底复用
    if let Some(u) = &payload.url {
        *state.detected_url.lock().unwrap() = Some(u.clone());
    }
    Ok(payload)
}

fn app_status_blocking(child_running: bool, detected_url: Option<String>) -> StatusPayload {
    // macOS 先合并登录 shell PATH（GUI 启动时 PATH 常缺 /opt/homebrew/bin 等目录）
    ensure_search_path();
    // 工具解析与版本读取并行执行：每个子进程调用都带超时（见 run_with_timeout），
    // 并行后 app_status 最坏耗时约等于最慢单次调用，而不是三者之和。
    let (dsh, pnpm, node) = std::thread::scope(|s| {
        let hd = s.spawn(resolve_dsh);
        let hp = s.spawn(resolve_pnpm);
        let hn = s.spawn(resolve_node);
        (hd.join().ok().flatten(), hp.join().ok().flatten(), hn.join().ok().flatten())
    });
    let (dsh_version, pnpm_version, node_version) = std::thread::scope(|s| {
        let hv = s.spawn(|| dsh.as_ref().and_then(read_dsh_version));
        let hp = s.spawn(|| pnpm.as_ref().and_then(|p| read_tool_version(p)));
        let hn = s.spawn(|| node.as_ref().and_then(|p| read_tool_version(p)));
        (
            hv.join().ok().flatten(),
            hp.join().ok().flatten(),
            hn.join().ok().flatten(),
        )
    });
    let dsh_installed = dsh.is_some();
    let dsh_path = dsh.map(|d| d.display);
    let pnpm_path = pnpm.map(|p| p.to_string_lossy().into_owned());
    let node_path = node.map(|p| p.to_string_lossy().into_owned());

    let (profile_ready, plugins) = read_profile_plugins();

    // child_running / detected_url 已由 async 包装层快照传入
    let mut candidates: Vec<String> = Vec::new();
    if let Some(url) = detected_url {
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
    // 命中服务 URL 时由 async 包装层写回 AppState（此处不持有状态句柄）
    let service_running = url.is_some();

    StatusPayload {
        dsh_installed,
        dsh_version,
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

/// 服务探活：同样移交线程池，避免健康轮询周期性阻塞主线程
#[tauri::command]
pub async fn probe_service(url: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || probe_url(&url, 800))
        .await
        .map_err(|e| format!("服务探测任务异常: {e}"))
}

/// 流式启动一个安装子进程：命令行回显与输出经 log_event 逐行转发，
/// 退出码经 exit_event 异步通知前端续接下一步。
fn spawn_streamed(
    app: AppHandle,
    display: &str,
    mut cmd: Command,
    log_event: &'static str,
    exit_event: &'static str,
) -> Result<(), String> {
    emit_log(&app, log_event, "system", &format!("$ {display}"));
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    let child = hide_window(&mut cmd)
        .spawn()
        .map_err(|e| format!("启动安装进程失败: {e}"))?;
    std::thread::spawn(move || pump_process(&app, child, log_event, exit_event));
    Ok(())
}

/// 按平台安装缺失的环境依赖（tool = "node" | "pnpm"）。
///
/// 全自动链路由前端驱动：每步安装完成后调用 refresh_search_path 刷新 PATH、
/// 重测环境，再决定下一步；本命令只负责单步安装并流式转发输出。
/// - Windows / node：winget install -e --id OpenJS.NodeJS.LTS
///   （静默 + 免交互 + 自动接受协议；MSI 安装器可能弹 UAC 授权窗口，属正常现象）
/// - macOS / node：brew install node（无 Homebrew 时报错并引导先安装 brew）
/// - 两平台 / pnpm：npm install -g pnpm（npm 随 Node.js 分发，全局目录用户可写）
#[tauri::command]
pub fn install_env_tool(app: AppHandle, tool: String) -> Result<(), String> {
    match tool.as_str() {
        "node" => install_tool_node(app),
        "pnpm" => install_tool_pnpm(app),
        _ => Err(format!("不支持的环境依赖: {tool}")),
    }
}

fn install_tool_node(app: AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        let winget = run_where("winget")
            .into_iter()
            .next()
            .or_else(|| {
                // winget 以应用执行别名形式存在于 WindowsApps（where.exe 偶发解析不到）
                env_dir("LOCALAPPDATA")
                    .map(|d| d.join("Microsoft\\WindowsApps\\winget.exe"))
                    .filter(|p| p.is_file())
            })
            .ok_or("未找到 winget。请手动安装 Node.js LTS：https://nodejs.org/")?;
        let mut cmd = Command::new(&winget);
        cmd.args([
            "install",
            "-e",
            "--id",
            "OpenJS.NodeJS.LTS",
            "--silent",
            "--accept-package-agreements",
            "--accept-source-agreements",
            "--disable-interactivity",
        ]);
        let display = format!(
            "{} install -e --id OpenJS.NodeJS.LTS --silent",
            winget.display()
        );
        return spawn_streamed(
            app,
            &display,
            cmd,
            ENV_INSTALL_LOG_EVENT,
            ENV_INSTALL_EXIT_EVENT,
        );
    }
    #[cfg(target_os = "macos")]
    {
        let brew = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]
            .iter()
            .map(PathBuf::from)
            .find(|p| p.is_file())
            .ok_or(
                "未找到 Homebrew。请先在终端执行 Homebrew 官方安装脚本（https://brew.sh），完成后重新点击安装",
            )?;
        let mut cmd = Command::new(&brew);
        cmd.args(["install", "node"]);
        let display = format!("{} install node", brew.display());
        return spawn_streamed(
            app,
            &display,
            cmd,
            ENV_INSTALL_LOG_EVENT,
            ENV_INSTALL_EXIT_EVENT,
        );
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = app;
        Err("当前平台暂不支持自动安装 Node.js，请手动安装：https://nodejs.org/".into())
    }
}

fn install_tool_pnpm(app: AppHandle) -> Result<(), String> {
    let npm = resolve_npm()
        .ok_or("未找到 npm。请先安装 Node.js 后重试（npm 随 Node.js 一同分发）")?;
    log_npm_mirror(&app, ENV_INSTALL_LOG_EVENT);
    let mut cmd = Command::new(&npm);
    cmd.args(["install", "-g", "pnpm"]);
    cmd.args(npm_mirror_args());
    let display = format!("{} install -g pnpm", npm.display());
    spawn_streamed(
        app,
        &display,
        cmd,
        ENV_INSTALL_LOG_EVENT,
        ENV_INSTALL_EXIT_EVENT,
    )
}

/// 刷新本进程的 PATH：Windows 经 PowerShell 读注册表 Machine/User Path
/// （[Environment]::GetEnvironmentVariable 自动展开 REG_EXPAND_SZ）；
/// macOS 合并登录 shell 的 PATH。每步环境依赖安装完成后由前端调用，
/// 使刚装好的工具无需重启应用即可被 where/which 探测到。
/// PowerShell 冷启动可达数秒 → async 命令移交线程池，避免阻塞主线程。
#[tauri::command]
pub async fn refresh_search_path() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(refresh_search_path_blocking)
        .await
        .map_err(|e| format!("刷新 PATH 失败: {e}"))?
}

fn refresh_search_path_blocking() -> Result<(), String> {
    ensure_search_path();
    #[cfg(windows)]
    {
        const SCRIPT: &str = concat!(
            "$m=[Environment]::GetEnvironmentVariable('Path','Machine');",
            "$u=[Environment]::GetEnvironmentVariable('Path','User');",
            "($m,$u | Where-Object { $_ }) -join ';'"
        );
        let out = run_with_timeout(
            {
                let mut c = Command::new("powershell");
                c.args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT]);
                c
            },
            Duration::from_secs(8),
        )
        .ok_or("读取系统 PATH 超时")?;
        if !out.status.success() {
            return Err("读取系统 PATH 失败".into());
        }
        let text = String::from_utf8_lossy(&out.stdout);
        let dirs: Vec<String> = text
            .split(';')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        merge_into_process_path(dirs);
    }
    Ok(())
}
/// 全局安装 @deepseek-ai/dsh@latest（流式输出）
#[tauri::command]
pub fn install_dsh(app: AppHandle) -> Result<(), String> {
    let pnpm = resolve_pnpm().ok_or("未找到 pnpm，请先安装 pnpm（https://pnpm.io/zh-CN/installation）")?;
    log_npm_mirror(&app, INSTALL_LOG_EVENT);
    emit_log(
        &app,
        INSTALL_LOG_EVENT,
        "system",
        &format!("$ {} add -g @deepseek-ai/dsh@latest", pnpm.display()),
    );
    let mut cmd = Command::new(&pnpm);
    cmd.args(["add", "-g", "@deepseek-ai/dsh@latest"])
        .args(npm_mirror_args());
    // 未运行过 pnpm setup 的环境会因全局目录不在 PATH 而失败，这里显式补齐
    apply_pnpm_env(&app, INSTALL_LOG_EVENT, &mut cmd);
    let child = hide_window(&mut cmd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
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
    // 收养遗留的孤儿服务：如安装新版本时安装器强杀了旧应用，dsh web 仍在占用服务端口。
    // 此时直接接管（可停止/继续使用），而不是再拉起一个注定绑定失败的重复实例。
    if adopt_orphan_service(&state) {
        emit_log(
            &app,
            WEB_LOG_EVENT,
            "system",
            "检测到上次未正常退出遗留的服务实例，已接管（可直接停止或继续使用）",
        );
        if let Some(url) = state.detected_url.lock().unwrap().clone() {
            let _ = app.emit(URL_EVENT, UrlPayload { url });
        }
        return Ok(());
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

/// 校验插件 CLI 操作类型
fn validate_plugin_op(op: &str) -> Result<(), String> {
    match op {
        "add" | "update" | "remove" => Ok(()),
        _ => Err(format!("不支持的插件操作: {op}")),
    }
}

/// 执行 `dsh plugin --profile web {op} {name}`（流式输出、可终止、单并发）。
/// dsh CLI 会转发 pnpm 并按安装结果对账 profile bundles（见宿主 apps/cli/src/plugin.ts）。
/// 进程退出由泵线程发 exit 事件并清理状态。
#[tauri::command]
pub fn run_plugin_op(
    app: AppHandle,
    state: State<'_, AppState>,
    op: String,
    name: String,
) -> Result<(), String> {
    validate_plugin_op(&op)?;
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("插件名称不能为空".into());
    }
    {
        let guard = state.plugin_op.lock().unwrap();
        if guard.is_some() {
            return Err("已有插件操作正在进行中，请稍后再试".into());
        }
    }
    let dsh = resolve_dsh().ok_or("未找到 dsh，请先全局安装 @deepseek-ai/dsh")?;
    // 先占位再 spawn，防并发；spawn 失败回滚
    *state.plugin_op.lock().unwrap() = Some(PluginOpState {
        pid: 0,
        kind: op.clone(),
        name: name.clone(),
    });

    emit_log(
        &app,
        PLUGIN_OP_LOG_EVENT,
        "system",
        &format!("$ dsh plugin --profile web {op} {name}"),
    );

    let mut cmd = Command::new(&dsh.program);
    cmd.args(&dsh.args)
        .arg("plugin")
        .arg("--profile")
        .arg("web")
        .arg(&op)
        .arg(&name)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

    // dsh 插件操作内部同样会调用 pnpm，一并注入全局目录环境
    apply_pnpm_env(&app, PLUGIN_OP_LOG_EVENT, &mut cmd);

    match hide_window(&mut cmd).spawn() {
        Ok(child) => {
            let pid = child.id();
            if let Some(st) = state.plugin_op.lock().unwrap().as_mut() {
                st.pid = pid;
            }
            emit_log(
                &app,
                PLUGIN_OP_LOG_EVENT,
                "system",
                &format!("进程已启动（PID {pid}），输出如下"),
            );
            let app2 = app.clone();
            std::thread::spawn(move || {
                pump_process(&app2, child, PLUGIN_OP_LOG_EVENT, PLUGIN_OP_EXIT_EVENT);
                if let Some(s) = app2.try_state::<AppState>() {
                    *s.plugin_op.lock().unwrap() = None;
                }
            });
            Ok(())
        }
        Err(e) => {
            *state.plugin_op.lock().unwrap() = None;
            emit_log(&app, PLUGIN_OP_LOG_EVENT, "error", &format!("启动失败: {e}"));
            Err(format!("启动插件操作失败: {e}"))
        }
    }
}

/// 终止当前插件 CLI 操作（整树杀灭，避免 Windows shell 链上的孤儿进程）；
/// 返回是否存在被终止的操作。exit 事件由泵线程照常发出。
#[tauri::command]
pub fn cancel_plugin_op(state: State<'_, AppState>) -> Result<bool, String> {
    let pid = state.plugin_op.lock().unwrap().take().map(|s| s.pid);
    match pid {
        Some(pid) if pid != 0 => {
            kill_tree(pid);
            Ok(true)
        }
        _ => Ok(false),
    }
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

/// 同步停止（仅应用退出钩子使用）：进程即将结束，阻塞无碍。
pub fn stop_dsh_web_sync(state: &AppState) {
    let pid = state.child_pid.lock().unwrap().take();
    if let Some(pid) = pid {
        kill_tree(pid);
    }
    // 等待树清理，然后按端口兜底（dsh 会派生脱离父链的进程）
    let mut urls: Vec<String> = state.pending_urls.lock().unwrap().clone();
    // 兜底：无任何 URL 记录时也清理本应用专属端口（覆盖孤儿服务等场景）
    if urls.is_empty() {
        urls.push(format!("http://127.0.0.1:{}", service_port()));
    }
    std::thread::sleep(Duration::from_millis(600));
    for url in &urls {
        if let Some(port) = url_port(url) {
            kill_listener(port);
        }
    }
    // 服务已停止，清除已探测 URL，避免托盘"浏览器中打开"打开死链
    *state.detected_url.lock().unwrap() = None;
}

/// 停止 dsh web：杀树 + 兜底清理耗时秒级，移交线程池执行避免冻结窗口
#[tauri::command]
pub async fn stop_dsh_web(state: State<'_, AppState>) -> Result<(), String> {
    let pid = state.child_pid.lock().unwrap().take();
    let mut urls = state.pending_urls.lock().unwrap().clone();
    // 兜底：无任何 URL 记录时也清理本应用专属端口（覆盖孤儿服务等场景）
    if urls.is_empty() {
        urls.push(format!("http://127.0.0.1:{}", service_port()));
    }
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(pid) = pid {
            kill_tree(pid);
        }
        std::thread::sleep(Duration::from_millis(600));
        for url in &urls {
            if let Some(port) = url_port(url) {
                kill_listener(port);
            }
        }
    })
    .await
    .map_err(|e| format!("停止服务失败: {e}"))?;
    // 服务已停止，清除已探测 URL，避免托盘"浏览器中打开"打开死链
    *state.detected_url.lock().unwrap() = None;
    Ok(())
}

fn url_port(url: &str) -> Option<u16> {
    let stripped = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))?;
    let host_port = stripped.split('/').next()?;
    host_port.rsplit_once(':')?.1.parse().ok()
}

/// 枚举监听指定端口的进程 PID（仅用于本应用专属的服务端口：dev 6088 / release 3080）
fn listener_pids(port: u16) -> Vec<u32> {
    #[cfg(windows)]
    {
        let Some(output) =
            hide_window(Command::new("netstat").args(["-ano", "-p", "tcp"])).output().ok()
        else {
            return Vec::new();
        };
        let text = String::from_utf8_lossy(&output.stdout);
        let needle = format!(":{port}");
        let mut pids: Vec<u32> = Vec::new();
        for line in text.lines() {
            let l = line.trim();
            if l.contains(&needle) && l.contains("LISTENING") {
                if let Some(pid_str) = l.split_whitespace().last() {
                    if let Ok(pid) = pid_str.parse::<u32>() {
                        if pid != 0 && !pids.contains(&pid) {
                            pids.push(pid);
                        }
                    }
                }
            }
        }
        pids
    }
    #[cfg(not(windows))]
    {
        let Some(output) = hide_window(Command::new("lsof").args(["-ti", &format!("tcp:{port}")]))
            .output()
            .ok()
        else {
            return Vec::new();
        };
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|l| l.trim().parse::<u32>().ok())
            .filter(|pid| *pid != 0)
            .collect()
    }
}

/// 杀掉监听指定端口的进程（仅用于我们自己子进程输出过的端口与本应用专属端口兜底）
fn kill_listener(port: u16) {
    for pid in listener_pids(port) {
        kill_tree(pid);
    }
}

/// 收养遗留的孤儿服务实例，返回是否发生收养。
///
/// 场景：应用运行中已启动服务，此时用户安装新版本——安装器会【强制结束】本应用进程，
/// 退出清理钩子（RunEvent::Exit → stop_dsh_web_sync）不会执行，`dsh web` 进程树成为
/// 孤儿并继续占用服务端口。重装后打开的新实例 AppState 全新（child_pid/pending_urls
/// 均为空），点"停止"会静默无效、"重启"会拉起一个绑定失败的重复实例。
///
/// 处理：检查本应用专属服务端口上是否有监听；有则把监听进程 PID 记入 child_pid、
/// 把默认 URL 记入 pending_urls/detected_url。之后停止（杀树 + 按端口兜底）与重启
/// 即恢复正常。只探测本应用固定服务端口（dev/release 天然隔离），绝不误伤其他进程。
///
/// 注意：收养的 PID 没有 pump 线程看护，若孤儿后续自行退出，child_pid 会残留到下次
/// 停止时由 taskkill 对失效 PID 的空操作与端口兜底自然消化，无副作用。
pub fn adopt_orphan_service(state: &AppState) -> bool {
    if state.child_pid.lock().unwrap().is_some() {
        return false; // 已有自己的子进程在管理，无需收养
    }
    let port = service_port();
    let pids = listener_pids(port);
    if pids.is_empty() {
        return false;
    }
    // 记录第一个监听者作为主管理对象；同端口其余监听者由停止时的按端口兜底统一清理
    *state.child_pid.lock().unwrap() = Some(pids[0]);
    {
        let mut pending = state.pending_urls.lock().unwrap();
        for u in [
            format!("http://127.0.0.1:{port}"),
            format!("http://localhost:{port}"),
        ] {
            if !pending.contains(&u) {
                pending.push(u);
            }
        }
    }
    if state.detected_url.lock().unwrap().is_none() {
        let url = format!("http://127.0.0.1:{port}");
        if probe_url(&url, 400) {
            *state.detected_url.lock().unwrap() = Some(url);
        }
    }
    true
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

/// 插件版本基础信息（纯本地读取；latest 由前端直查 npm registry）
#[derive(Serialize)]
pub struct PluginVersionInfo {
    pub name: String,
    pub spec: Option<String>,
    pub current: Option<String>,
    pub updatable: bool,
}

/// 纯 registry 规格才可检查更新（link/file/git/本地路径均排除）
fn is_registry_spec(spec: &str) -> bool {
    let s = spec.trim();
    if s.is_empty() {
        return false;
    }
    let lower = s.to_lowercase();
    if lower.starts_with("link:")
        || lower.starts_with("file:")
        || lower.starts_with("git")
        || lower.starts_with("github:")
        || lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("./")
        || lower.starts_with("../")
        || lower.contains("://")
    {
        return false;
    }
    // Windows 绝对路径（如 D:/workspace/x）
    if s.len() >= 2 && s.as_bytes()[1] == b':' {
        return false;
    }
    true
}

/// 读取 node_modules 内已安装版本（支持 @scope/name 嵌套路径）
fn read_installed_version(dir: &PathBuf, name: &str) -> Option<String> {
    let mut rel = PathBuf::from("node_modules");
    for part in name.split('/') {
        rel = rel.join(part);
    }
    let text = std::fs::read_to_string(dir.join(&rel).join("package.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v.get("version").and_then(|x| x.as_str()).map(|s| s.to_string())
}

/// 插件版本基础信息：名称、依赖规格、当前安装版本、是否可检查更新。
/// latest 不在此处获取——前端并行直查 registry，比拉起 pnpm outdated 快数倍。
#[tauri::command]
pub fn check_plugin_updates() -> Result<Vec<PluginVersionInfo>, String> {
    let dir = profile_dir().ok_or("未找到插件目录")?;
    let path = profile_package_json().ok_or("未找到 package.json")?;
    let text = std::fs::read_to_string(path).map_err(|e| format!("读取 package.json 失败: {e}"))?;
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("package.json 解析失败: {e}"))?;
    let deps = v.get("dependencies").and_then(|d| d.as_object());

    let parsed: (bool, Vec<String>) = read_profile_plugins();
    let names: Vec<String> = parsed.1;
    let _ = parsed.0;
    Ok(names
        .into_iter()
        .map(|name| {
            let spec = deps
                .and_then(|d| d.get(&name))
                .and_then(|x| x.as_str())
                .map(|s| s.to_string());
            let updatable = spec.as_deref().map(is_registry_spec).unwrap_or(false);
            PluginVersionInfo {
                updatable,
                current: read_installed_version(&dir, &name),
                spec,
                name,
            }
        })
        .collect())
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
    log_npm_mirror(&app, PLUGIN_INSTALL_LOG_EVENT);
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
            .args(npm_mirror_args())
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

// ---------------------------------------------------------------------------
// 前端 HTTP 代理（GitHub / npm 市场请求）
// ---------------------------------------------------------------------------
// 打包版 WebView 的 CSP `connect-src` 不含外网域名，前端直连
// api.github.com / registry.npmjs.org 会被拦截（调试模式 Vite dev server
// 不强制 CSP 所以正常）；统一经此命令由 Rust 侧发出请求，绕开 CSP。
// 仅放行 https 请求，避免被当作任意 URL 代理滥用。

/// 以 GET 请求一个 https URL，返回响应体文本（JSON 字符串由前端解析）。
#[tauri::command]
pub async fn http_get_json(url: String) -> Result<String, String> {
    if !url.starts_with("https://") {
        return Err("仅支持 https 请求".into());
    }
    let resp = tauri::async_runtime::spawn_blocking(move || {
        let agent = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(12))
            .user_agent("deepseek-harness-desktop")
            .build();
        agent.get(&url).call()
    })
    .await
    .map_err(|e| e.to_string())?;
    let resp = resp.map_err(|e| match e {
        ureq::Error::Status(code, _) => format!("HTTP {code}"),
        other => other.to_string(),
    })?;
    resp.into_string().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 环境检测回归测试：确认 run_with_timeout 能正确捕获子进程输出
    /// （曾因未设置 stdio 管道导致 where/--version 输出全为空、检测不到工具）
    #[test]
    fn run_with_timeout_captures_output() {
        let mut cmd = Command::new("node");
        cmd.arg("--version");
        let out = run_with_timeout(cmd, Duration::from_secs(5)).expect("node --version 应正常返回");
        assert!(out.status.success());
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(
            text.trim_start_matches('v').trim_start().starts_with("2"),
            "node --version 输出应含主版本号，实际: {text:?}"
        );
    }

    #[test]
    fn run_with_timeout_kills_hung_process() {
        // powershell 挂起 30 秒 → 1 秒超时应被杀掉并返回 None
        let mut cmd = Command::new("powershell");
        cmd.args(["-NoProfile", "-Command", "Start-Sleep -Seconds 30"]);
        let started = std::time::Instant::now();
        let out = run_with_timeout(cmd, Duration::from_secs(1));
        assert!(out.is_none(), "挂起进程超时应返回 None");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "超时应及时返回，实际耗时 {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn resolves_tools_and_versions() {
        // 本机应有 node / pnpm / dsh；任一缺失只打印不失败（环境相关）
        let dsh = resolve_dsh();
        let pnpm = resolve_pnpm();
        let node = resolve_node();
        eprintln!("dsh={:?} pnpm={pnpm:?} node={node:?}", dsh.as_ref().map(|d| &d.display));
        let node_version = node.as_ref().and_then(|p| read_tool_version(p));
        let pnpm_version = pnpm.as_ref().and_then(|p| read_tool_version(p));
        let dsh_version = dsh.as_ref().and_then(read_dsh_version);
        eprintln!("node={node_version:?} pnpm={pnpm_version:?} dsh={dsh_version:?}");
        assert!(node.is_some(), "本机应能检测到 node");
        assert!(node_version.is_some(), "node 版本应可读取");
    }
}
