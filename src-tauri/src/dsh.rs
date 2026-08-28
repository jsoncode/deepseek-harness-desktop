//! dsh 进程管理：工具解析、全局安装、dsh web 启动/停止、服务探测与日志流式输出。

use serde::Serialize;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU8};
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
/// 会话事件推送的多通道投递负载（见 `session_events::NotifyMessage`）
pub const NOTIFY_MESSAGE_EVENT: &str = "dsh://notify-message";
/// 用户点击了系统通知（toast 激活）：负载为 `notify::ActivatePayload`
/// （sessionId 为空表示点到 toast 正文、未落到具体会话按钮上）。
/// 前端据此切到预览页并让预览 iframe 打开对应会话对话框。
pub const NOTIFY_ACTIVATE_EVENT: &str = "dsh://notify-activate";

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
    /// 系统推送总开关：关闭时后台线程仍消费帧维护标题/去重基线，但不投递
    pub notify_enabled: AtomicBool,
    /// toast 投递方式：0 = legacy（notify-rust 原实现，无点击感知），
    /// 1 = clickable（winrt 直连，带「打开对话」按钮与激活回调，默认）。
    /// 「两种提示切换开关」后续在设置页接入，只需改这个值（见 notify.rs）。
    pub notify_style: AtomicU8,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            child_pid: Mutex::new(None),
            plugin_op: Mutex::new(None),
            detected_url: Mutex::new(None),
            pending_urls: Mutex::new(Vec::new()),
            notify_enabled: AtomicBool::new(true),
            notify_style: AtomicU8::new(1),
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
    for d in new_dirs
        .into_iter()
        .chain(current.split(sep).map(|s| s.to_string()))
    {
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

/// 候选 pnpm home 目录（按优先级）：环境变量 PNPM_HOME → 平台默认目录。
/// 平台默认与 pnpm 自身 getDataDir 的解析保持一致：
/// win %LOCALAPPDATA%\pnpm、macOS ~/Library/pnpm、Linux $XDG_DATA_HOME/pnpm 或 ~/.local/share/pnpm。
fn pnpm_home_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(h) = std::env::var("PNPM_HOME") {
        let h = h.trim();
        if !h.is_empty() {
            out.push(PathBuf::from(h));
        }
    }
    #[cfg(windows)]
    if let Some(la) = env_dir("LOCALAPPDATA") {
        out.push(la.join("pnpm"));
    }
    #[cfg(target_os = "macos")]
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        out.push(home.join("Library").join("pnpm"));
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        match std::env::var_os("XDG_DATA_HOME").map(PathBuf::from) {
            Some(x) => out.push(x.join("pnpm")),
            None => {
                if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
                    out.push(home.join(".local").join("share").join("pnpm"));
                }
            }
        }
    }
    out
}

/// 目录等价比较（Windows 忽略大小写；两端忽略尾部分隔符）
fn dirs_equal(a: &PathBuf, b: &PathBuf) -> bool {
    fn norm(p: &PathBuf) -> String {
        let s = p
            .to_string_lossy()
            .trim_end_matches(['/', '\\'])
            .to_string();
        #[cfg(windows)]
        let s = s.to_lowercase();
        s
    }
    norm(a) == norm(b)
}

/// 可能的“pnpm 全局 bin 目录”候选：home 本身与 home/bin 两种布局并存——
/// pnpm ≤10 的 shims 直接放在 PNPM_HOME；pnpm ≥11 固定改为 <PNPM_HOME>/bin
/// （v11 dist 源码：`bin = globalBinDir ?? join(pnpmHomeDir, "bin")`）。
fn pnpm_global_bin_candidates() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for home in pnpm_home_candidates() {
        for cand in [home.clone(), home.join("bin")] {
            if !out.iter().any(|d| dirs_equal(d, &cand)) {
                out.push(cand);
            }
        }
    }
    out
}

/// 解析 `pnpm bin -g` 输出首行为绝对路径目录。
/// 过滤异常输出（老命令在新版 pnpm 上会打印 "undefined"，随后报 Command "global" not found）
/// 与相对路径，避免把垃圾字符串注入 PATH。
fn parse_pnpm_bin_output(text: &str) -> Option<PathBuf> {
    let line = text.lines().next()?.trim();
    if line.is_empty()
        || line.eq_ignore_ascii_case("undefined")
        || line.eq_ignore_ascii_case("null")
    {
        return None;
    }
    let p = PathBuf::from(line);
    if !p.is_absolute() {
        return None;
    }
    Some(p)
}

/// 探测 pnpm 生效的全局 bin 目录（如 C:\Users\xxx\AppData\Local\pnpm 或 …\pnpm\bin）。
///
/// 兼容 pnpm 10 与 11（客户机 GLOBAL_BIN_DIR_NOT_IN_PATH 报错即 v11 未运行过 pnpm setup）：
/// - v10 校验目录 = 配置 global-bin-dir（默认 %LOCALAPPDATA%\pnpm）?? PNPM_HOME，
///   且 `bin -g` 不反映 PNPM_HOME、只打印默认/配置值；
/// - v11 校验目录 = 配置 global-bin-dir ?? <PNPM_HOME|平台默认>/bin，校验必然触发；
/// - 两版执行 `pnpm bin -g` 时都会先做同一 PATH 检查（v11 实测探测命令本身即失败退出），
///   因此先把候选目录预注入【探测子进程】的 PATH 再问 pnpm；
/// - `pnpm global bin` 在 pnpm ≥10 已移除，仅作为更老版本的回退探测保留。
///
/// 返回需注入的目录列表 = pnpm 自报目录（可反映自定义 global-bin-dir）∪ 平台推导
/// 候选（home 与 home/bin 两种布局，覆盖 v10 默认目录与 v11 的 <home>/bin）。
/// 探测结果缓存：键 = pnpm 路径，值 = 该 pnpm 的全局 bin 目录列表。
/// 只在探测出非空结果时写入；pnpm 路径变化时自动失效重探。
static PNPM_GLOBAL_DIRS_CACHE: Mutex<Option<(PathBuf, Vec<PathBuf>)>> = Mutex::new(None);

fn detect_pnpm_global_dirs() -> Vec<PathBuf> {
    let Some(pnpm) = resolve_pnpm() else {
        // 无 pnpm：仅返回推导候选（无子进程开销，供 resolve_dsh 兜底查找用）
        return pnpm_global_bin_candidates();
    };
    // 按 pnpm 路径键控缓存：环境检测/启动链会多次走到这里，避免每次都付
    // 秒级探测开销；pnpm 路径变化（如中途新装）时自动重新探测。
    if let Some((p, dirs)) = PNPM_GLOBAL_DIRS_CACHE.lock().unwrap().clone() {
        if dirs_equal(&p, &pnpm) {
            return dirs;
        }
    }
    let candidates = pnpm_global_bin_candidates();
    // 目录可能尚未创建（全新环境首次使用 pnpm）：主动建出，保证可注入 PATH 且 realpath 可用
    for d in &candidates {
        if !d.exists() {
            std::fs::create_dir_all(d).ok();
        }
    }
    let mut out: Vec<PathBuf> = Vec::new();
    {
        let mut push_unique = |d: PathBuf| {
            if !out.iter().any(|x| dirs_equal(x, &d)) {
                out.push(d);
            }
        };
        // 探测子进程 PATH：候选目录前置（pnpm 自身的 bin -g 也会先做同一检查）
        #[cfg(windows)]
        let sep = ";";
        #[cfg(not(windows))]
        let sep = ":";
        let cur_path = std::env::var("PATH").unwrap_or_default();
        let mut probe_parts: Vec<String> = candidates
            .iter()
            .map(|d| d.to_string_lossy().into_owned())
            .collect();
        probe_parts.push(cur_path);
        let probe_path = probe_parts.join(sep);

        // 1) pnpm 自报的生效目录（可反映自定义 global-bin-dir 配置）；
        //    现代命令 `bin -g` 成功即足够，失败才回退老命令
        for (args, timeout) in [
            (["bin", "-g"], Duration::from_secs(8)),
            (["global", "bin"], Duration::from_secs(4)),
        ] {
            let mut cmd = Command::new(&pnpm);
            cmd.args(args).env("PATH", &probe_path);
            if let Some(output) = run_with_timeout(cmd, timeout) {
                if output.status.success() {
                    if let Some(dir) =
                        parse_pnpm_bin_output(&String::from_utf8_lossy(&output.stdout))
                    {
                        push_unique(dir);
                        break;
                    }
                }
            }
        }
    }
    // 2) 推导候选并入：v10 的 `bin -g` 不反映 PNPM_HOME（默认 global-bin-dir 优先），
    //    v11 又固定在 <home>/bin——只有并集才能覆盖两版全部布局
    for c in candidates {
        if !out.iter().any(|x| dirs_equal(x, &c)) {
            out.push(c);
        }
    }
    if !out.is_empty() {
        *PNPM_GLOBAL_DIRS_CACHE.lock().unwrap() = Some((pnpm, out.clone()));
    }
    out
}

/// 把目录幂等追加进用户级注册表 PATH（每次会话最多尝试一轮，后台线程执行不阻塞）。
/// 等价于 `pnpm setup` 的持久化动作：.NET SetEnvironmentVariable(User) 写入
/// HKCU\Environment\Path 并广播 WM_SETTINGCHANGE，新开的终端/由 Explorer 启动的
/// 进程即可见。没有这一步，装好的 dsh 在下次启动应用时又会“找不到”而反复重装。
#[cfg(windows)]
fn spawn_persist_user_path(app: AppHandle, event: &'static str, dirs: Vec<String>) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static SPAWNED: AtomicBool = AtomicBool::new(false);
    if SPAWNED.swap(true, Ordering::SeqCst) {
        return; // 本会话已尝试过（脚本自身幂等，无需重复）
    }
    const SCRIPT: &str = concat!(
        "$d=$env:DSH_PNPM_DIR;",
        "if (-not $d) { exit 2 };",
        "$p=[Environment]::GetEnvironmentVariable('Path','User');",
        "if (-not $p) { $p='' };",
        "$parts=@($p -split ';' | Where-Object { $_ });",
        "$t=$d.TrimEnd('\\').ToLowerInvariant();",
        "foreach ($x in $parts) { if ($x.TrimEnd('\\').ToLowerInvariant() -eq $t) { Write-Output 'unchanged'; exit 0 } };",
        "[Environment]::SetEnvironmentVariable('Path', (($parts + $d) -join ';'), 'User');",
        "Write-Output 'updated'"
    );
    std::thread::spawn(move || {
        for dir in dirs {
            let mut c = Command::new("powershell");
            c.args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
                .env("DSH_PNPM_DIR", &dir);
            let updated = match run_with_timeout(c, Duration::from_secs(15)) {
                Some(out) if out.status.success() => {
                    String::from_utf8_lossy(&out.stdout).trim() == "updated"
                }
                _ => false, // 失败仅静默跳过：不影响本次安装流程
            };
            if updated {
                emit_log(
                    &app,
                    event,
                    "system",
                    &format!("已将 pnpm 全局目录写入用户 PATH（新开终端/重启应用后生效）：{dir}"),
                );
            }
        }
    });
}

/// 为即将执行的 pnpm / dsh 子进程注入全局 bin 环境：把 pnpm 全局目录前置到子进程 PATH。
///
/// 背景：未运行过 `pnpm setup` 的机器上该目录不在 PATH，`pnpm add -g` 会直接报错
/// （GLOBAL_BIN_DIR_NOT_IN_PATH: The configured global bin directory ... is not in PATH；
/// pnpm ≥11 因目录恒为 <home>/bin，此校验必然触发）。
/// 注意【不再覆盖 PNPM_HOME】：v11 的全局目录是 <PNPM_HOME>/bin，若把该环境变量
/// 改写成 bin 目录本身，pnpm 会解析出 <bin>/bin 双重错位；继承父进程原值即可，
/// PATH 前置已足以通过两版校验。
///
/// 同时：①把目录合并进本应用进程 PATH——安装完成后前端立即续接启动链，
/// resolve_dsh 要在同一会话内就能找到刚装好的 dsh；②Windows 下后台幂等写入用户级
/// 注册表 PATH（见 spawn_persist_user_path），避免下次启动反复重装。
/// 仅影响本会话与用户级 PATH，不改任何 shell 配置文件。
fn apply_pnpm_env(app: &AppHandle, event: &'static str, cmd: &mut Command) {
    let dirs = detect_pnpm_global_dirs();
    if dirs.is_empty() {
        emit_log(
            app,
            event,
            "system",
            "未能确定 pnpm 全局 bin 目录，跳过 PATH 注入（若安装失败请先手动运行 pnpm setup）",
        );
        return;
    }
    #[cfg(windows)]
    let sep = ";";
    #[cfg(not(windows))]
    let sep = ":";
    let cur = std::env::var("PATH").unwrap_or_default();
    let strs: Vec<String> = dirs
        .iter()
        .map(|d| d.to_string_lossy().into_owned())
        .collect();
    let missing: Vec<&String> = strs
        .iter()
        .filter(|s| {
            !cur.split(sep)
                .any(|p| p.trim().eq_ignore_ascii_case(s.as_str()))
        })
        .collect();
    let mut parts = strs.clone();
    parts.push(cur);
    cmd.env("PATH", parts.join(sep));
    if !missing.is_empty() {
        let list = missing
            .iter()
            .map(|s| s.as_str())
            .collect::<Vec<_>>()
            .join("; ");
        emit_log(
            app,
            event,
            "system",
            &format!("检测到 pnpm 全局目录不在 PATH（可能未运行过 pnpm setup），已为本流程临时注入：{list}"),
        );
    }
    // 会话内立即可见：合并进本进程 PATH，安装完成后 resolve_dsh 才能立刻找到 dsh
    #[cfg(any(windows, target_os = "macos"))]
    merge_into_process_path(strs.clone());
    // 持久化（仅 Windows）：幂等补写用户级注册表 PATH
    #[cfg(windows)]
    spawn_persist_user_path(app.clone(), event, strs);
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
    // 兜底：pnpm 全局 bin 目录（pnpm ≤10 布局 shims 在 home、≥11 在 home/bin，
    // 对全部候选逐一查找——目录不在进程 PATH 时这是找到 dsh 的关键路径）
    for bin in detect_pnpm_global_dirs() {
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
        if let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(timeout_ms))
        {
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
        handles.push(std::thread::spawn(move || {
            (u.clone(), probe_url(&u, timeout_ms))
        }));
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
pub(crate) fn service_port() -> u16 {
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

/// 泵送子进程 stdout/stderr 直到进程退出，返回退出码；不负责发出 exit 事件。
///
/// web 日志事件下同时尝试从输出行识别服务 URL（try_detect_url），与原
/// pump_process 行为一致；是否发出 exit 事件由调用方裁决。
fn pump_streams_until_exit(app: &AppHandle, mut child: Child, log_event: &'static str) -> i32 {
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
    status.map(|s| s.code().unwrap_or(-1)).unwrap_or(-1)
}

/// 读取子进程 stdout/stderr 并逐行发出事件；进程结束后发出 exit 事件。
fn pump_process(app: &AppHandle, child: Child, log_event: &'static str, exit_event: &'static str) {
    let code = pump_streams_until_exit(app, child, log_event);
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
        (
            hd.join().ok().flatten(),
            hp.join().ok().flatten(),
            hn.join().ok().flatten(),
        )
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
/// - 两平台 / pnpm：npm install -g pnpm@10（锁定 10.x 主版本——dsh 不支持 pnpm 11；
///   npm 随 Node.js 分发，全局目录用户可写）
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
    let npm =
        resolve_npm().ok_or("未找到 npm。请先安装 Node.js 后重试（npm 随 Node.js 一同分发）")?;
    log_npm_mirror(&app, ENV_INSTALL_LOG_EVENT);
    let mut cmd = Command::new(&npm);
    // 锁定 pnpm 10 主版本：dsh 与 pnpm 11 的全局虚拟仓库布局不兼容，不能用默认 latest（11.x）
    cmd.args(["install", "-g", "pnpm@10"]);
    cmd.args(npm_mirror_args());
    let display = format!("{} install -g pnpm@10", npm.display());
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
/// 全局安装 @deepseek-ai/dsh@latest（流式输出）。
///
/// async + spawn_blocking：pnpm 探测（where / `bin -g` 冷启动、杀软扫描）可达数秒，
/// 同步命令在主线程执行会冻结窗口——与 app_status / refresh_search_path 同一处理。
#[tauri::command]
pub async fn install_dsh(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || install_dsh_blocking(app))
        .await
        .map_err(|e| format!("安装任务异常: {e}"))?
}

fn install_dsh_blocking(app: AppHandle) -> Result<(), String> {
    let pnpm =
        resolve_pnpm().ok_or("未找到 pnpm，请先安装 pnpm（https://pnpm.io/zh-CN/installation）")?;
    log_npm_mirror(&app, INSTALL_LOG_EVENT);
    emit_log(
        &app,
        INSTALL_LOG_EVENT,
        "system",
        &format!("$ {} add -g @deepseek-ai/dsh@latest", pnpm.display()),
    );
    let mut cmd = Command::new(&pnpm);
    cmd.args(["add", "-g", "@deepseek-ai/dsh@latest"])
        // 关闭“清除模块目录”确认提示（无 TTY 时直接报 ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY）
        .arg("--config.confirm-modules-purge=false")
        .args(npm_mirror_args());
    // 未运行 pnpm setup 的机器会因全局目录不在 PATH 失败（pnpm ≥11 必然触发校验），
    // 这里显式补齐；同时合并进程 PATH 并持久化到用户注册表（详见 apply_pnpm_env）
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
    // 启动前完整性校验：命令入口存在但读不出版本 = 安装已损坏（全局目录被清理、
    // 路径失效、shim 悬空等）。直接返回可操作的错误而非用崩溃堆栈糊弄用户。
    if read_dsh_version(&dsh).is_none() {
        emit_log(
            &app,
            WEB_LOG_EVENT,
            "system",
            "检测到 dsh 安装已损坏：命令入口存在但无法读取版本（可能全局目录被清理或路径失效），请点击「安装」重新全局安装 @deepseek-ai/dsh",
        );
        return Err(
            "dsh 安装已损坏（无法读取版本），请点击「安装」重新全局安装 @deepseek-ai/dsh".into(),
        );
    }
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

    // 泵输出 + 退出后的存活性裁决：dsh web 会派生脱离父链的服务进程，
    // 壳进程先行退出并不代表服务不可用（真实案例：dsh 内部在非 git 目录打印
    // "fatal: not a git repository" 等非致命告警后以码 1 退出，而服务端口依旧
    // 健在）。此时绝不拦截访问——复探端口可达即收养监听进程继续托管，并重新
    // 广播 URL 让前端保持在运行态；只有确认服务不可达才上报失败。
    let app2 = app.clone();
    std::thread::spawn(move || {
        let code = pump_streams_until_exit(&app2, child, WEB_LOG_EVENT);
        // 先摘除自家 pid（也为随后的收养清位）
        if let Some(s) = app2.try_state::<AppState>() {
            *s.child_pid.lock().unwrap() = None;
        }
        // 短暂重试几次，避开重启窗口期的瞬时探测落空
        let mut alive_url: Option<String> = None;
        for _ in 0..3 {
            if let Some(s) = app2.try_state::<AppState>() {
                if s.child_pid.lock().unwrap().is_some() {
                    return; // 已有新一轮子进程接管（用户点了重试），本退出按旧进程忽略
                }
            }
            let pending: Vec<String> = app2
                .try_state::<AppState>()
                .map(|s| s.pending_urls.lock().unwrap().clone())
                .unwrap_or_default();
            let candidates = child_candidates(&pending);
            if let Some(url) = probe_parallel(&candidates, 600) {
                alive_url = Some(url);
                break;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        match alive_url {
            Some(url) => {
                if let Some(s) = app2.try_state::<AppState>() {
                    // 收养脱离父链的监听进程为新的管理对象，保证"停止服务"仍然有效
                    adopt_orphan_service(&s);
                    *s.detected_url.lock().unwrap() = Some(url.clone());
                }
                emit_log(
                    &app2,
                    WEB_LOG_EVENT,
                    "system",
                    &format!(
                        "dsh web 进程已退出（退出码 {code}），但服务仍正常运行，已自动接管继续提供访问"
                    ),
                );
                let _ = app2.emit(URL_EVENT, UrlPayload { url });
                // 服务可用即不算失败：不发出 WEB_EXIT_EVENT
            }
            None => {
                let _ = app2.emit(WEB_EXIT_EVENT, ExitPayload { code });
            }
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

    // dsh 插件操作内部同样会调用 pnpm，一并注入全局目录环境；
    // 并关闭“清除模块目录”确认提示（无 TTY 时直接失败），经环境变量传递给 dsh 内部的 pnpm
    apply_pnpm_env(&app, PLUGIN_OP_LOG_EVENT, &mut cmd);
    cmd.env("npm_config_confirm_modules_purge", "false");

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
            emit_log(
                &app,
                PLUGIN_OP_LOG_EVENT,
                "error",
                &format!("启动失败: {e}"),
            );
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
        let Some(output) = hide_window(Command::new("netstat").args(["-ano", "-p", "tcp"]))
            .output()
            .ok()
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
        Command::new("open")
            .arg(url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map_err(|e| e.to_string())?;
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
    let dir = PathBuf::from(home)
        .join(".dsh")
        .join("profiles")
        .join("web");
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

/// 从 profile package.json 卸载插件：仅从 bundles 数组移除该名字，并把名字登记到
/// dsh.profile.pendingRemovals；dependencies 键保留不动——真正的依赖移除推迟到
/// 下次启动（install_plugins 在 pnpm install 前清理登记表，见
/// prune_pending_plugin_deps），避免服务运行中直接卸载模块导致服务崩溃。
/// 写回时保持键顺序（preserve_order）与两空格缩进
#[tauri::command]
pub fn remove_plugin(name: String) -> Result<(), String> {
    let path =
        profile_package_json().ok_or("未找到插件目录（%USERPROFILE%\\.dsh\\profiles\\web）")?;
    let text =
        std::fs::read_to_string(&path).map_err(|e| format!("读取 package.json 失败: {e}"))?;
    let mut v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("package.json 解析失败: {e}"))?;

    let in_deps = v
        .get("dependencies")
        .and_then(|d| d.as_object())
        .map(|o| o.contains_key(name.as_str()))
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

    // 登记待清理依赖：下次启动 pnpm install 前从 dependencies 移除（见
    // prune_pending_plugin_deps）；本次卸载不动 dependencies，服务不受影响
    let dsh = v
        .as_object_mut()
        .ok_or("package.json 顶层不是对象")?
        .entry("dsh")
        .or_insert_with(|| serde_json::json!({}));
    let profile = dsh
        .as_object_mut()
        .ok_or("dsh 字段格式异常")?
        .entry("profile")
        .or_insert_with(|| serde_json::json!({}));
    let pending = profile
        .as_object_mut()
        .ok_or("dsh.profile 字段格式异常")?
        .entry("pendingRemovals")
        .or_insert_with(|| serde_json::json!([]));
    let pending = pending
        .as_array_mut()
        .ok_or("dsh.profile.pendingRemovals 字段格式异常")?;
    if !pending.iter().any(|x| x.as_str() == Some(name.as_str())) {
        pending.push(serde_json::Value::String(name));
    }

    let out = serde_json::to_string_pretty(&v).map_err(|e| format!("序列化失败: {e}"))?;
    std::fs::write(&path, out + "\n").map_err(|e| format!("写回 package.json 失败: {e}"))?;
    Ok(())
}

/// 启动前清理已卸载插件的残留依赖：把 dsh.profile.pendingRemovals 登记的插件名从
/// dependencies 移除（名字仍存在于 bundles 的视为重新安装/重新激活，保留依赖），
/// 随后清空登记表。仅编辑 package.json，不触碰 node_modules——随后的 pnpm install
/// 会顺带卸载这些包。返回是否发生了写回。
fn prune_pending_plugin_deps(path: &Path) -> Result<bool, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("读取 package.json 失败: {e}"))?;
    let mut v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("package.json 解析失败: {e}"))?;

    let pending: Vec<String> = v
        .get("dsh")
        .and_then(|d| d.get("profile"))
        .and_then(|p| p.get("pendingRemovals"))
        .and_then(|r| r.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    if pending.is_empty() {
        return Ok(false);
    }

    // 当前仍登记在 bundles 的名字（被重新安装/重新激活）不做依赖清理
    let bundles: Vec<String> = v
        .get("dsh")
        .and_then(|d| d.get("profile"))
        .and_then(|p| p.get("bundles"))
        .and_then(|b| b.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    let mut changed = false;
    if let Some(deps) = v.get_mut("dependencies").and_then(|d| d.as_object_mut()) {
        for name in &pending {
            if bundles.iter().any(|b| b == name) {
                continue; // 已装回 bundles，保留依赖
            }
            if deps.remove(name.as_str()).is_some() {
                changed = true;
            }
        }
    }

    // 清空登记表（无论是否实际移除依赖，本次启动都视为处理完毕）
    if let Some(profile) = v.get_mut("dsh").and_then(|d| d.get_mut("profile")) {
        if let Some(obj) = profile.as_object_mut() {
            if obj.remove("pendingRemovals").is_some() {
                changed = true;
            }
        }
    }

    if changed {
        let out = serde_json::to_string_pretty(&v).map_err(|e| format!("序列化失败: {e}"))?;
        std::fs::write(path, out + "\n").map_err(|e| format!("写回 package.json 失败: {e}"))?;
    }
    Ok(changed)
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
    v.get("version")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
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
    let path = dir.join("package.json");
    if !path.is_file() {
        return Ok(());
    }
    // 启动时清理卸载残留（见 remove_plugin）：卸载只移除 bundles 并登记
    // pendingRemovals，此刻服务未运行，从 package.json 移除依赖是安全的，
    // 随后的 pnpm install 会顺带卸载 node_modules 中的旧包
    match prune_pending_plugin_deps(&path) {
        Ok(true) => {
            emit_log(
                &app,
                PLUGIN_INSTALL_LOG_EVENT,
                "system",
                "已清理卸载插件的残留依赖（pnpm install 将同步卸载对应模块）",
            );
        }
        Ok(false) => {}
        Err(e) => {
            emit_log(
                &app,
                PLUGIN_INSTALL_LOG_EVENT,
                "error",
                &format!("清理卸载插件的残留依赖失败: {e}"),
            );
        }
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
            // 切换 pnpm 大版本（如 11→10）后旧 node_modules 布局不兼容需清除重建，
            // 无 TTY 时会因确认提示直接失败（ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY），
            // 显式关闭清除确认，让 pnpm 直接重建
            .arg("--config.confirm-modules-purge=false")
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
// 系统推送开关
// ---------------------------------------------------------------------------

/// 设置系统推送总开关；关→开时补一条自检通知，让用户立刻确认提醒通道可用。
/// 异步定义（而非同步）以避开主线程：notify-rust 在 Windows 上要走 WinRT 调用。
#[tauri::command]
pub async fn set_notify_enabled(
    app: AppHandle,
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    let prev = state
        .notify_enabled
        .swap(enabled, std::sync::atomic::Ordering::SeqCst);
    if enabled && !prev {
        crate::notify::push_sample(&app);
    }
    Ok(())
}

/// 设置 toast 投递方式：0 = legacy（不可点击，原 notify-rust 样式）、
/// 1 = clickable（可点击，带「打开对话」按钮，点击直达对应会话对话框）。
/// 切到可点击时补一条自检通知：自检消息带会话位，按钮会真实显示出来，
/// 让用户立刻看到新样式长什么样（点击自检按钮只会恢复窗口，桥找不到
/// 「sample」会话会静默降级）。异步定义原因同 `set_notify_enabled`。
#[tauri::command]
pub async fn set_notify_style(
    app: AppHandle,
    state: State<'_, AppState>,
    style: u8,
) -> Result<(), String> {
    let prev = state
        .notify_style
        .swap(style, std::sync::atomic::Ordering::SeqCst);
    if style == 1 && prev != 1 {
        crate::notify::push_sample(&app);
    }
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
        eprintln!(
            "dsh={:?} pnpm={pnpm:?} node={node:?}",
            dsh.as_ref().map(|d| &d.display)
        );
        let node_version = node.as_ref().and_then(|p| read_tool_version(p));
        let pnpm_version = pnpm.as_ref().and_then(|p| read_tool_version(p));
        let dsh_version = dsh.as_ref().and_then(read_dsh_version);
        eprintln!("node={node_version:?} pnpm={pnpm_version:?} dsh={dsh_version:?}");
        assert!(node.is_some(), "本机应能检测到 node");
        assert!(node_version.is_some(), "node 版本应可读取");
    }

    /// `pnpm bin -g` 输出解析：拒绝 undefined/空/相对路径等异常输出
    /// （`global bin` 在 pnpm ≥10 上会打印 "undefined" 并报 Command "global" not found）
    #[test]
    fn parse_pnpm_bin_output_rejects_junk() {
        assert!(parse_pnpm_bin_output("").is_none());
        assert!(parse_pnpm_bin_output("undefined\n").is_none());
        assert!(parse_pnpm_bin_output("null\r\n").is_none());
        assert!(parse_pnpm_bin_output("relative/path\n").is_none());
        // is_absolute() 按当前平台判定：Windows 风格路径仅在 Windows 上视为绝对，
        // unix 风格路径仅在 unix 上视为绝对，两个断言分别按平台门控
        #[cfg(windows)]
        {
            let win = parse_pnpm_bin_output("C:\\Users\\a\\AppData\\Local\\pnpm\\bin\r\n");
            assert!(win.is_some(), "绝对路径应可解析");
            assert!(win.unwrap().is_absolute());
        }
        #[cfg(unix)]
        {
            let unix = parse_pnpm_bin_output("/home/a/.local/share/pnpm\n");
            assert!(unix.is_some(), "unix 绝对路径应可解析");
            assert!(unix.unwrap().is_absolute());
        }
    }

    /// 候选目录去重与两种布局（home、home/bin）覆盖
    #[cfg(windows)]
    #[test]
    fn dirs_equal_and_candidates_cover_layouts() {
        assert!(dirs_equal(
            &PathBuf::from("C:\\A\\b\\"),
            &PathBuf::from("c:\\a\\b")
        ));
        assert!(!dirs_equal(
            &PathBuf::from("C:\\pnpm"),
            &PathBuf::from("C:\\pnpm\\bin")
        ));
        // 环境变量未设置时也应给出平台默认候选（不 panic 且非空由真实环境决定，仅验证结构）
        for c in pnpm_global_bin_candidates() {
            assert!(c.is_absolute(), "候选目录应为绝对路径: {c:?}");
        }
    }

    /// 集成冒烟（依赖本机装有 pnpm）：完整走一遍探测链路
    /// （where → 候选目录预注入 → `pnpm bin -g` → 输出解析），应得到
    /// 存在的绝对路径目录——这是修复 GLOBAL_BIN_DIR_NOT_IN_PATH 的核心路径。
    #[test]
    fn detect_pnpm_global_dirs_smoke() {
        if resolve_pnpm().is_none() {
            eprintln!("本机无 pnpm，跳过");
            return;
        }
        let dirs = detect_pnpm_global_dirs();
        assert!(
            !dirs.is_empty(),
            "装有 pnpm 的机器应至少探测到一个全局 bin 目录"
        );
        for d in &dirs {
            assert!(d.is_absolute(), "{d:?} 应为绝对路径");
            assert!(d.exists(), "{d:?} 应存在（探测前会主动创建）");
        }
        eprintln!("detected global dirs: {dirs:?}");
    }
}
