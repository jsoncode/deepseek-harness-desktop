//! 语音播报通道：把通知文本交给常驻 Python worker（Audio8 TTS）合成语音，
//! 再用 rodio 本地播放。设计约束与原因：
//!
//! - **不迁移 Python 代码**：Rust 只做进程编排，模型加载/推理全在 Audio8 原仓库
//!   的官方路径（AutoProcessor/AutoModel + trust_remote_code），与
//!   `audio8_tts_infer.py` 完全一致，仓库升级零跟进成本。worker 脚本
//!   （[`WORKER_PY`]，include_str! 内嵌）运行时写入应用数据目录，不污染用户克隆。
//! - **常驻 worker**：冷启动（torch import + 加载 AR+codec 模型）30~90s，每条通知
//!   重跑一次不可用；worker 加载一次后常驻，空闲 10 分钟自退，崩溃由宿主退避重启。
//! - **CPU/GPU 双覆盖**：device 由 torch 自动选择（CUDA → bf16，否则 CPU fp32），
//!   是 infer.py 的原生行为，Rust 侧不感知。
//! - **投递不阻塞**：[`VoiceChannel::deliver`] 只入队立即返回，toast 照常先弹；
//!   队列线程串行「合成 → 播放」，积压时只保留最新一条（旧通知的播报已失去时效）。
//! - **自检通知不朗读**：`push_sample` 的 kind=="sample" 在通道内直接跳过；
//!   主动试听走 [`tts_speak_test`]（绕过总开关，便于配置时验证）。

use crate::dsh::AppState;
use crate::session_events::NotifyMessage;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, VecDeque};
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::fs;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

/// 语音播报状态事件（设置页监听：生成中/播放中/完成/失败）
pub const VOICE_EVENT: &str = "dsh://notify-voice";

const WORKER_PY: &str = include_str!("tts_worker.py");
/// 单条合成等待上限（CPU 慢机 + 512 token 的兜底；进程死亡会提前唤醒）
const GENERATE_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// 模型加载等待上限（冷启动 torch import + 权重加载）
const READY_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// worker 崩溃后的最短重启间隔，避免配置错误时拉起风暴
const RESPAWN_BACKOFF: Duration = Duration::from_secs(5);
/// 文本缓存上限（LRU：超出删最旧）
const CACHE_KEEP: usize = 30;

// ---------------------------------------------------------------------------
// 内置音色
// ---------------------------------------------------------------------------

/// 内置音色：随应用打包的参考音频（zero-shot 克隆样本），运行时解压到
/// app_data/tts/voices/。为什么需要：Audio8 无参考音频时走模型无条件生成，
/// 没有固定说话人身份，采样随机性直接体现为音色漂移（同配置不同文本听感不一）；
/// 固定音色的官方手段是给一段参考音频 + 准确原文。内置样本用同一语料、不同
/// 韵律预生成，保证「选了哪个音色就稳定是哪个音色」。
struct BuiltinVoice {
    /// 配置里的音色 id（VoiceConfig.voice_id）
    id: &'static str,
    /// 展示名（设置页音色下拉框）
    name: &'static str,
    /// 一句话说明
    description: &'static str,
    /// 参考音频的准确原文（与录音内容一致）
    ref_text: &'static str,
    /// 44.1kHz 16bit 单声道 WAV（内嵌进二进制）
    wav: &'static [u8],
}

/// 内置音色共用参考语料：内置样本念的都是这段话，worker 的 reference_text 与之一致
const BUILTIN_REF_TEXT: &str =
    "大家好，我是你的语音助手。今天也要保持好心情，认真完成每一件事，让生活充满阳光和活力。";

/// 默认音色：voice_id 为空（老版本配置）时的实际生效项
const DEFAULT_VOICE_ID: &str = "wanwan";

/// 自定义音色的保留 id：使用用户填写的 ref_audio/ref_text
const CUSTOM_VOICE_ID: &str = "custom";

const BUILTIN_VOICES: &[BuiltinVoice] = &[
    BuiltinVoice {
        id: "wanwan",
        name: "晚晚 · 温柔女声",
        description: "语速平缓、音调偏甜，适合日常通知播报（默认）",
        ref_text: BUILTIN_REF_TEXT,
        wav: include_bytes!("../resources/voices/wanwan.wav"),
    },
    BuiltinVoice {
        id: "zhixia",
        name: "知夏 · 明快女声",
        description: "语速稍快、干净利落",
        ref_text: BUILTIN_REF_TEXT,
        wav: include_bytes!("../resources/voices/zhixia.wav"),
    },
    BuiltinVoice {
        id: "yunshu",
        name: "云舒 · 沉稳女声",
        description: "语速偏慢、音调低沉，适合长文朗读",
        ref_text: BUILTIN_REF_TEXT,
        wav: include_bytes!("../resources/voices/yunshu.wav"),
    },
];

fn find_builtin_voice(id: &str) -> Option<&'static BuiltinVoice> {
    BUILTIN_VOICES.iter().find(|v| v.id == id)
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

/// 语音播报配置（前端 localStorage 为持久层，启动时经 set_voice_config 回灌；
/// 与 notify_style 的同步模式一致，Rust 侧不落盘）
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct VoiceConfig {
    pub enabled: bool,
    /// 播报内容："summary"（标题+描述）| "title" | "desc"
    pub speak_content: String,
    /// Python 解释器（命令名或绝对路径；Audio8 依赖 torch/transformers，
    /// 建议指向装好依赖的 venv）
    pub python_cmd: String,
    /// Audio8_TTS 仓库克隆目录（含 audio8_tts_data.py）
    pub repo_dir: String,
    /// 完整模型 checkpoint 目录（config.json + tokenizer + codec.pth）
    pub model_dir: String,
    /// 音色选择：内置音色 id（见 BUILTIN_VOICES，如 "wanwan"）| "custom"（自定义
    /// 参考音频克隆）| 空（老版本配置，等价默认内置音色）。决定了合成时实际下发给
    /// worker 的 reference_audio/reference_text，进缓存键（换音色必须换缓存）
    pub voice_id: String,
    /// 参考音频路径（zero-shot 音色克隆）：仅 voice_id == "custom" 时生效，
    /// 与 ref_text 成对给出才走克隆，都空走模型原生默认音色。
    /// 只在 processor 输入层生效，不参与 worker 键（无需重启）
    pub ref_audio: String,
    /// 参考音频的准确原文（与录音内容一致；官方警告：转写不准会降低相似度与稳定性）
    pub ref_text: String,
    /// 采样温度（>0）：越高音色/韵律越随机，越低越平稳
    pub temperature: f32,
    /// nucleus 采样概率阈值（0 < top_p ≤ 1）
    pub top_p: f32,
    /// top-k 采样候选数（0 = 不启用）
    pub top_k: u32,
    /// 随机种子：同文本 + 同参数 + 同 seed 结果可复现；换种子即换一种读法
    pub seed: u64,
    /// 单段生成的 token 上限（不够时长会被截断，官方默认 1024）
    pub max_new_tokens: u32,
    /// 贪心解码：忽略采样参数，每步取最大概率，输出最稳定
    pub greedy: bool,
}

impl Default for VoiceConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            speak_content: "summary".into(),
            python_cmd: "python".into(),
            repo_dir: String::new(),
            model_dir: String::new(),
            // 默认音色锚定到内置音色：不再走模型原生默认（音色漂移）
            voice_id: DEFAULT_VOICE_ID.into(),
            ref_audio: String::new(),
            ref_text: String::new(),
            // 与 tts_worker.py 原硬编码值一致：默认行为不变
            temperature: 0.8,
            top_p: 0.95,
            top_k: 50,
            seed: 42,
            max_new_tokens: 512,
            greedy: false,
        }
    }
}

impl VoiceConfig {
    /// worker 身份键：三要素任一变化都要求重启 worker（换解释器/仓库/模型）。
    /// 采样参数刻意不参与：worker 按请求携带参数，改参数不需要重载模型。
    fn worker_key(&self) -> String {
        format!("{}\u{1f}{}\u{1f}{}", self.python_cmd, self.repo_dir, self.model_dir)
    }

    /// 采样参数进缓存键：同文本不同参数（尤其是 seed）必须产出不同缓存，
    /// 否则改参数后播的还是旧音频
    fn params_tag(&self) -> String {
        format!(
            "g{}\u{1f}s{}\u{1f}t{}\u{1f}p{}\u{1f}k{}\u{1f}n{}",
            self.greedy as u8,
            self.seed,
            self.temperature,
            self.top_p,
            self.top_k,
            self.max_new_tokens
        )
    }

    /// 完整缓存标签 = 采样参数 + 实际生效的参考音频指纹（路径 + 原文 + 文件
    /// mtime/字节长）。换音色/换参考文件内容必须换缓存，否则播的还是旧音色的
    /// 音频；无参考（custom 空对）时与 params_tag 相同。
    fn cache_tag(&self, reference: Option<(&Path, &str)>) -> String {
        let mut tag = self.params_tag();
        if let Some((audio, ref_text)) = reference {
            let meta = std::fs::metadata(audio).ok();
            let mtime = meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let len = meta.as_ref().map(|m| m.len()).unwrap_or(0);
            tag.push_str(&format!(
                "\u{1f}ra{}\u{1f}rt{}\u{1f}rm{}\u{1f}rl{}",
                audio.display(),
                ref_text,
                mtime,
                len
            ));
        }
        tag
    }
}

/// 参考音频是否生效（custom 模式）：两个字段都非空才算配齐（官方要求成对出现）
fn has_reference(cfg: &VoiceConfig) -> bool {
    !cfg.ref_audio.trim().is_empty() && !cfg.ref_text.trim().is_empty()
}

/// 音色选择归一化（resolve_reference 前置；纯函数供单测）：
/// 空/未知 id → 默认内置音色（老配置与脏数据的兜底），custom → 用户参考音频
enum EffectiveVoice {
    Builtin(&'static BuiltinVoice),
    Custom,
}

fn effective_voice(cfg: &VoiceConfig) -> EffectiveVoice {
    let id = cfg.voice_id.trim();
    if !id.is_empty() && id != CUSTOM_VOICE_ID {
        if let Some(v) = find_builtin_voice(id) {
            return EffectiveVoice::Builtin(v);
        }
    }
    if id == CUSTOM_VOICE_ID {
        return EffectiveVoice::Custom;
    }
    EffectiveVoice::Builtin(find_builtin_voice(DEFAULT_VOICE_ID).expect("默认音色必须在内置表中"))
}

/// 解析当前配置实际生效的参考音频（zero-shot 克隆条件；generate_wav 是合成
/// 唯一出口，通知播报/试听/长文本全部经此生效）：
/// - 内置音色 → 解压打包参考 wav + 内置原文
/// - custom → 用户填写的 ref_audio/ref_text（成对有效才走克隆，都空返回 None
///   走模型原生默认音色，即旧行为的逃生口）
fn resolve_reference(
    app: &AppHandle,
    cfg: &VoiceConfig,
) -> Result<Option<(PathBuf, String)>, String> {
    match effective_voice(cfg) {
        EffectiveVoice::Builtin(v) => {
            let path = ensure_builtin_voice_file(app, v)?;
            Ok(Some((path, v.ref_text.to_string())))
        }
        EffectiveVoice::Custom => {
            if has_reference(cfg) {
                Ok(Some((
                    PathBuf::from(cfg.ref_audio.trim()),
                    cfg.ref_text.trim().to_string(),
                )))
            } else {
                Ok(None)
            }
        }
    }
}

/// 把内嵌的内置音色参考 wav 解压到应用数据目录（幂等：已存在且大小一致直接
/// 复用；应用升级换样本后大小不同会自动覆盖）
fn ensure_builtin_voice_file(app: &AppHandle, v: &BuiltinVoice) -> Result<PathBuf, String> {
    let dir = tts_dir(app)?.join("voices");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建内置音色目录失败: {e}"))?;
    let path = dir.join(format!("{}.wav", v.id));
    let fresh = std::fs::metadata(&path)
        .map(|m| m.len() == v.wav.len() as u64)
        .unwrap_or(false);
    if !fresh {
        std::fs::write(&path, v.wav).map_err(|e| format!("写入内置音色参考音频失败: {e}"))?;
    }
    Ok(path)
}

/// 音色选择校验（set_voice_config 用；纯逻辑供单测）：
/// voice_id 为空（老配置兼容）或内置 id 合法；custom 时参考音频必须成对且
/// 文件存在；未知 id 拒绝（前端下拉框数据源是 tts_builtin_voices，正常不会出现）
fn validate_voice_selection(cfg: &VoiceConfig) -> Result<(), String> {
    let id = cfg.voice_id.trim();
    if id.is_empty() {
        return Ok(());
    }
    if id == CUSTOM_VOICE_ID {
        return validate_reference_pair(cfg);
    }
    if find_builtin_voice(id).is_none() {
        return Err(format!(
            "未知音色: {id}（请从内置音色列表选择，或使用 custom）"
        ));
    }
    Ok(())
}

/// 参考音频配置校验（set_voice_config 用；纯函数供单测）：
/// 成对出现（要么都空要么都非空）且文件真实存在
fn validate_reference_pair(cfg: &VoiceConfig) -> Result<(), String> {
    let has_audio = !cfg.ref_audio.trim().is_empty();
    let has_text = !cfg.ref_text.trim().is_empty();
    if has_audio != has_text {
        return Err("参考音频与参考原文必须同时填写（官方要求两者成对出现）".into());
    }
    if has_audio && !Path::new(cfg.ref_audio.trim()).is_file() {
        return Err(format!("参考音频文件不存在: {}", cfg.ref_audio.trim()));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 语音通道（接入 notify.rs 的通道表）
// ---------------------------------------------------------------------------

pub struct VoiceChannel;

impl crate::notify::NotifyChannel for VoiceChannel {
    fn name(&self) -> &'static str {
        "voice"
    }

    fn deliver(&self, app: &AppHandle, msg: &NotifyMessage) {
        // 自检通知（push_sample）不朗读：它不是会话事件；试听走 tts_speak_test。
        // 跳过不再纯静默：emit skipped 让语音面板能看到「为什么不响」
        if msg.kind == "sample" {
            emit_voice(
                app,
                "skipped",
                Some(&msg.summary),
                Some("自检通知不朗读（验证语音请用「试听」按钮）"),
            );
            return;
        }
        let cfg = app.state::<AppState>().voice.lock().unwrap().clone();
        if !cfg.enabled {
            // 总开关未开：通知照常弹，语音跳过但给出可诊断的 skipped 事件
            eprintln!("[tts] 语音播报跳过（总开关未开启）: {}", msg.summary);
            emit_voice(
                app,
                "skipped",
                Some(speak_text(msg, &cfg.speak_content)),
                Some("语音播报总开关未开启（在设置→通知管理或语音工具窗口开启）"),
            );
            return;
        }
        // 严格校验路径：不仅检查空，还检查盘符根等无效路径。
        // 校验失败同样 emit skipped：历史上这里是纯静默 return，用户只会看到
        // 「通知弹了但没声音」，无从定位是路径配置问题
        for (dir, label) in [(&cfg.repo_dir, "Audio8 仓库目录"), (&cfg.model_dir, "模型目录")] {
            if let Err(e) = validate_audio_path(dir, label) {
                eprintln!("[tts] 语音播报跳过（{label} 无效）: {e}");
                emit_voice(app, "skipped", Some(speak_text(msg, &cfg.speak_content)), Some(&e));
                return;
            }
        }
        enqueue_job(SpeakJob { app: app.clone(), text: speak_text(msg, &cfg.speak_content).to_string(), force: false });
    }
}

/// 按播报内容配置挑选朗读文本（纯函数，供单测）
fn speak_text<'a>(msg: &'a NotifyMessage, content: &str) -> &'a str {
    match content {
        "title" => msg.title,
        "desc" => &msg.desc,
        _ => &msg.summary,
    }
}

// ---------------------------------------------------------------------------
// 队列：折叠积压 + 串行「合成 → 播放」
// ---------------------------------------------------------------------------

struct SpeakJob {
    app: AppHandle,
    text: String,
    /// true = 试听命令（绕过总开关）
    force: bool,
}

struct Queue {
    inner: Mutex<VecDeque<SpeakJob>>,
    cv: Condvar,
}

static QUEUE: OnceLock<&'static Queue> = OnceLock::new();

fn queue() -> &'static Queue {
    *QUEUE.get_or_init(|| {
        let q: &'static Queue = Box::leak(Box::new(Queue {
            inner: Mutex::new(VecDeque::new()),
            cv: Condvar::new(),
        }));
        std::thread::Builder::new()
            .name("tts-voice".into())
            .spawn(move || queue_loop(q))
            .expect("spawn tts voice queue thread");
        q
    })
}

fn enqueue_job(job: SpeakJob) {
    let q = queue();
    let mut guard = q.inner.lock().unwrap();
    // 无界积压保护：只留最新 2 条（正在播的 + 刚来的）
    while guard.len() >= 2 {
        guard.pop_front();
    }
    guard.push_back(job);
    drop(guard);
    q.cv.notify_one();
}

fn queue_loop(q: &'static Queue) {
    loop {
        let mut guard = q.inner.lock().unwrap();
        while guard.is_empty() {
            guard = q.cv.wait(guard).unwrap();
        }
        // 折叠：一次只处理最新一条，其余直接丢弃（比排队播完更有时效价值）
        let job = guard.pop_back().unwrap();
        guard.clear();
        drop(guard);
        process_job(job);
    }
}

fn process_job(job: SpeakJob) {
    let SpeakJob { app, text, force } = job;
    let cfg = app.state::<AppState>().voice.lock().unwrap().clone();
    // 排队期间用户关掉总开关：放弃播报（试听 force 除外），同样给出 skipped 事件
    if !cfg.enabled && !force {
        emit_voice(&app, "skipped", Some(&text), Some("语音播报在排队期间被关闭"));
        return;
    }
    emit_voice(&app, "generating", Some(&text), None);

    let path = match cache_path_for(&app, &cfg, &text) {
        Ok(p) if p.is_file() && p.metadata().map(|m| m.len() > 0).unwrap_or(false) => Ok(p),
        _ => generate_wav(&app, &cfg, &text),
    };
    let path = match path {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[tts] 生成失败: {e}");
            emit_voice(&app, "error", Some(&text), Some(&e));
            return;
        }
    };
    // 生成成功即落历史（试听与通知播报都算「生成过的语音」）；记录失败不影响播报
    append_history(&app, &text, &path, if force { "test" } else { "notify" }, 1);

    emit_voice(&app, "playing", Some(&text), None);
    match play_wav(&path) {
        Ok(()) => emit_voice(&app, "done", Some(&text), None),
        Err(e) => {
            eprintln!("[tts] 播放失败: {e}");
            emit_voice(&app, "error", Some(&text), Some(&e));
        }
    }
}

fn emit_voice(app: &AppHandle, state: &str, text: Option<&str>, error: Option<&str>) {
    // running = worker 当前是否驻留：命中缓存的播放不走合成、不启动 worker，
    // 事件若只带 state 会让前端误判「服务已启动」，必须携带事实源
    let _ = app.emit(
        VOICE_EVENT,
        json!({ "state": state, "text": text, "error": error, "running": worker_running() }),
    );
}

// ---------------------------------------------------------------------------
// 文本缓存（app_data/tts-cache/<hash>.wav）
// ---------------------------------------------------------------------------

/// 缓存键：文本 + 模型目录 + 采样参数（换模型/换参数不能重放旧音频）。
/// DefaultHasher::new() 固定密钥，同一二进制跨重启稳定（跨 Rust 版本不保证——
/// 缓存失配只会重新生成）。
fn cache_key(text: &str, model_dir: &str, params_tag: &str) -> u64 {
    let mut h = DefaultHasher::new();
    text.hash(&mut h);
    model_dir.hash(&mut h);
    params_tag.hash(&mut h);
    h.finish()
}

fn tts_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("tts"))
        .map_err(|e| format!("解析应用数据目录失败: {e}"))
}

fn cache_path(
    app: &AppHandle,
    text: &str,
    model_dir: &str,
    params_tag: &str,
) -> Result<PathBuf, String> {
    let dir = tts_dir(app)?.join("tts-cache");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建缓存目录失败: {e}"))?;
    Ok(dir.join(format!("{:016x}.wav", cache_key(text, model_dir, params_tag))))
}

/// 当前配置对应的缓存路径（缓存键带实际生效的参考音频指纹）：process_job /
/// synthesize_blocking 的缓存预检与 generate_wav 的实际写入共用同一把键，
/// 保证「预检命中」与「合成落盘」不会因键不一致而双份生成
fn cache_path_for(app: &AppHandle, cfg: &VoiceConfig, text: &str) -> Result<PathBuf, String> {
    let reference = resolve_reference(app, cfg)?;
    let tag = cfg.cache_tag(reference.as_ref().map(|(p, t)| (p.as_path(), t.as_str())));
    cache_path(app, text, &cfg.model_dir, &tag)
}

fn trim_cache(dir: &Path) {
    trim_wav_dir(dir, CACHE_KEEP);
}

/// LRU 保留最新 keep 个 wav 文件（文本缓存与合成导出区共用）
fn trim_wav_dir(dir: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "wav").unwrap_or(false))
        .filter_map(|p| {
            let mtime = p.metadata().and_then(|m| m.modified()).ok()?;
            Some((mtime, p))
        })
        .collect();
    if files.len() <= keep {
        return;
    }
    files.sort_by_key(|(t, _)| *t);
    let excess = files.len() - keep;
    for (_, p) in files.iter().take(excess) {
        let _ = std::fs::remove_file(p);
    }
}

// ---------------------------------------------------------------------------
// 语音生成历史（app_data/tts/history.jsonl，JSONL 追加 + LRU 截断）
// ---------------------------------------------------------------------------

/// 历史记录条数上限（LRU：超出按时间删最旧）
const HISTORY_KEEP: usize = 200;
/// 单条记录的文本截断上限（防超长文本撑爆记录文件；展示够用）
const HISTORY_TEXT_KEEP: usize = 500;

/// 文件操作串行锁：追加/列表/删除可能来自队列线程与多个命令线程
static HISTORY_LOCK: Mutex<()> = Mutex::new(());

/// 历史自增序号：同毫秒内多条记录保证 id 唯一
static HISTORY_SEQ: AtomicU64 = AtomicU64::new(0);

/// 一条生成记录（JSONL 持久层；camelCase 与前端 VoiceHistoryEntry 同形）
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
struct HistoryRecord {
    id: String,
    /// 生成完成时刻（unix 毫秒）
    ts_ms: i64,
    /// 合成的文本（超长截断）
    text: String,
    /// WAV 文件绝对路径（文本缓存或导出区）
    path: String,
    /// "notify"（通知播报）| "test"（试听）| "studio"（长文本合成导出）
    source: String,
    /// 分段数（长文本合成为段数；单段来源恒为 1）
    chunks: u32,
}

/// 追加并按 LRU 截断（纯函数，供单测）：push 后按时间倒序保留最新 keep 条。
/// 排序带 id 兜底：同毫秒多条时保证截断稳定。
fn merge_history(records: &mut Vec<HistoryRecord>, rec: HistoryRecord, keep: usize) {
    records.push(rec);
    if records.len() > keep {
        records.sort_by(|a, b| b.ts_ms.cmp(&a.ts_ms).then_with(|| b.id.cmp(&a.id)));
        records.truncate(keep);
    }
}

fn history_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(tts_dir(app)?.join("history.jsonl"))
}

/// 读全部记录（坏行跳过；文件不存在视为空）
fn read_history_records(file: &Path) -> Vec<HistoryRecord> {
    let Ok(text) = std::fs::read_to_string(file) else {
        return Vec::new();
    };
    text.lines()
        .filter_map(|l| serde_json::from_str::<HistoryRecord>(l).ok())
        .collect()
}

/// 记录一条生成成功的历史（append + LRU 截断）。旁路能力：任何失败只打日志，
/// 不影响播报/合成本身。
fn append_history(app: &AppHandle, text: &str, path: &Path, source: &str, chunks: u32) {
    let ts_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let rec = HistoryRecord {
        id: format!("h{}-{}", ts_ms, HISTORY_SEQ.fetch_add(1, Ordering::Relaxed)),
        ts_ms,
        text: text.chars().take(HISTORY_TEXT_KEEP).collect(),
        path: path.to_string_lossy().into_owned(),
        source: source.into(),
        chunks,
    };
    let Ok(file) = history_path(app) else { return };
    let _guard = HISTORY_LOCK.lock().unwrap();
    let mut records = read_history_records(&file);
    merge_history(&mut records, rec, HISTORY_KEEP);
    let mut body = String::with_capacity(records.len() * 160);
    for r in &records {
        if let Ok(line) = serde_json::to_string(r) {
            body.push_str(&line);
            body.push('\n');
        }
    }
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Err(e) = std::fs::write(&file, body) {
        eprintln!("[tts] 写入语音历史失败: {e}");
    }
}

// ---------------------------------------------------------------------------
// 常驻 worker 管理
// ---------------------------------------------------------------------------

struct WorkerState {
    ready: bool,
    dead: bool,
    error: Option<String>,
}

/// 一次合成请求的采样参数（JSONL 请求的 params 字段；与官方 audio8_tts_infer.py
/// 的 generate 参数一一对应）。按请求携带：改参数不需要重启常驻 worker 重载模型。
#[derive(Serialize, Clone, Debug, PartialEq)]
struct GenerateParams {
    temperature: f32,
    top_p: f32,
    top_k: u32,
    seed: u64,
    max_new_tokens: u32,
    greedy: bool,
}

impl From<&VoiceConfig> for GenerateParams {
    fn from(cfg: &VoiceConfig) -> Self {
        Self {
            temperature: cfg.temperature,
            top_p: cfg.top_p,
            top_k: cfg.top_k,
            seed: cfg.seed,
            max_new_tokens: cfg.max_new_tokens,
            greedy: cfg.greedy,
        }
    }
}

struct WorkerInner {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    pending: Mutex<HashMap<String, mpsc::Sender<Result<(), String>>>>,
    state: Mutex<WorkerState>,
    cv: Condvar,
    dead_at: Mutex<Option<Instant>>,
    next_id: AtomicU64,
}

impl WorkerInner {
    /// 等待模型加载完成（ready 握手）。进程死亡/超时提前返回错误。
    fn wait_ready(&self, deadline: Instant) -> Result<(), String> {
        let mut st = self.state.lock().unwrap();
        loop {
            if st.ready {
                return Ok(());
            }
            if st.dead {
                return Err(st.error.clone().unwrap_or_else(|| "worker 已退出".into()));
            }
            if Instant::now() >= deadline {
                return Err("等待模型加载超时（5 分钟）".into());
            }
            let (g, _) = self
                .cv
                .wait_timeout(st, Duration::from_millis(200))
                .unwrap();
            st = g;
        }
    }

    /// 提交一条合成请求并等待 WAV 落盘。reference：Some((音频路径, 准确原文))
    /// 时走 zero-shot 音色克隆（worker 传给 processor，与官方 infer 同构）。
    fn generate(
        &self,
        text: &str,
        output: &Path,
        params: &GenerateParams,
        reference: Option<(&Path, &str)>,
    ) -> Result<(), String> {
        self.wait_ready(Instant::now() + READY_TIMEOUT)?;
        let id = self.next_id.fetch_add(1, Ordering::SeqCst).to_string();
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(id.clone(), tx);
        let mut line = json!({
            "id": id,
            "text": text,
            "output": output.to_string_lossy(),
            "params": params,
        });
        if let Some((audio, rtext)) = reference {
            line["reference_audio"] = json!(audio.display().to_string());
            line["reference_text"] = json!(rtext);
        }
        let line = line.to_string();
        {
            let mut guard = self.stdin.lock().unwrap();
            // JSONL 行必须有结尾换行：worker 按行读 stdin，缺 \n 会永远阻塞
            let sent = match guard.as_mut() {
                Some(w) => w
                    .write_all(line.as_bytes())
                    .and_then(|_| w.write_all(b"\n"))
                    .and_then(|_| w.flush())
                    .is_ok(),
                None => false,
            };
            if !sent {
                self.pending.lock().unwrap().remove(&id);
                return Err("worker 通信失败（进程可能已退出）".into());
            }
        }
        match rx.recv_timeout(GENERATE_TIMEOUT) {
            Ok(r) => {
                self.pending.lock().unwrap().remove(&id);
                r
            }
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err("生成超时".into())
            }
        }
    }

    fn mark_dead(&self, error: &str) {
        {
            let mut st = self.state.lock().unwrap();
            if st.dead {
                return;
            }
            st.ready = false;
            st.dead = true;
            st.error = Some(error.to_string());
        }
        *self.dead_at.lock().unwrap() = Some(Instant::now());
        self.fail_all(error);
        self.cv.notify_all();
    }

    fn fail_all(&self, error: &str) {
        for (_, tx) in self.pending.lock().unwrap().drain() {
            let _ = tx.send(Err(error.to_string()));
        }
    }

    fn kill(&self) {
        *self.stdin.lock().unwrap() = None;
        if let Some(mut c) = self.child.lock().unwrap().take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

struct WorkerEntry {
    key: String,
    inner: Arc<WorkerInner>,
}

static WORKER: Mutex<Option<WorkerEntry>> = Mutex::new(None);

/// 取（或拉起）与当前配置匹配的 worker。配置变化即重建；崩溃后带退避重启。
fn worker_for(cfg: &VoiceConfig, app: &AppHandle) -> Result<Arc<WorkerInner>, String> {
    let key = cfg.worker_key();
    let mut guard = WORKER.lock().unwrap();
    if let Some(entry) = guard.as_ref() {
        if entry.key == key {
            let (dead, error) = {
                let st = entry.inner.state.lock().unwrap();
                (st.dead, st.error.clone())
            };
            if !dead {
                return Ok(entry.inner.clone());
            }
            let in_backoff = entry
                .inner
                .dead_at
                .lock()
                .unwrap()
                .map(|t| t.elapsed() < RESPAWN_BACKOFF)
                .unwrap_or(false);
            if in_backoff {
                return Err(format!(
                    "worker 刚刚退出（{}），稍候重试",
                    error.unwrap_or_default()
                ));
            }
            entry.inner.kill();
        } else {
            // 配置变了：旧 worker 直接杀掉（换模型/解释器后旧进程无用）
            entry.inner.kill();
        }
    }
    let inner = spawn_worker(cfg, app)?;
    *guard = Some(WorkerEntry { key, inner: inner.clone() });
    Ok(inner)
}

fn spawn_worker(cfg: &VoiceConfig, app: &AppHandle) -> Result<Arc<WorkerInner>, String> {
    let script = ensure_worker_script(app)?;
    // HF 缓存与宿主环境解耦：固定在应用数据目录下，保证存在且可写
    let hf_home = tts_dir(app)?.join("hf");
    spawn_worker_with(cfg, &script, &hf_home)
}

/// worker 子进程的 HF 缓存环境覆盖（纯函数，供单测）。
/// worker 只用本地仓库/模型目录，从不下载，不需要共享宿主的 HF 缓存；而用户/
/// 系统环境里的 HF_HOME 可能指向不存在的盘（实机案例：HF_HOME=E:\... 且 E 盘未
/// 挂载），transformers trust_remote_code 初始化模块缓存时 os.makedirs 直接抛
/// 「系统找不到指定的路径: 'E:\'」——错误信息只有盘符根，极难定位。这里把
/// HF 全家桶缓存强制指到应用数据目录，与宿主环境彻底解耦。
fn apply_worker_env(cmd: &mut Command, hf_home: &Path) {
    let p = |sub: &str| hf_home.join(sub).to_string_lossy().into_owned();
    for (k, v) in [
        ("HF_HOME", hf_home.to_string_lossy().into_owned()),
        ("HF_HUB_CACHE", p("hub")),
        // TRANSFORMERS_CACHE 是旧名，部分 transformers 版本仍优先读取
        ("TRANSFORMERS_CACHE", p("hub")),
        // trust_remote_code 的动态模块缓存：本次 E:\ 报错的直接来源
        ("HF_MODULES_CACHE", p("modules")),
        ("HF_DATASETS_CACHE", p("datasets")),
    ] {
        cmd.env(k, v);
    }
}

/// 校验目录路径是否有效（非空、不是盘符根目录、有合理长度）
fn validate_audio_path(p: &str, label: &str) -> Result<(), String> {
    let t = p.trim();
    if t.is_empty() {
        return Err(format!("{} 不能为空", label));
    }
    // 可靠检测盘符根目录：检查是否形如 "X:" 或 "X:\"
    let chars: Vec<char> = t.chars().collect();
    if chars.len() >= 2 && chars[1] == ':' {
        let is_disk_root = if chars.len() == 2 {
            true // "E:"
        } else if chars.len() == 3 && (chars[2] == '\\' || chars[2] == '/') {
            true // "E:\" 或 "E:/"
        } else {
            false
        };
        if is_disk_root {
            eprintln!("[tts] validate_audio_path 检测到盘符根目录: label={}, raw={:?}, trimmed={:?}", label, p, t);
            return Err(format!("{} 不能是盘符根目录，请填写完整目录路径", label));
        }
    }
    // 兜底：原长度检查
    if t.len() <= 3 && t.chars().nth(1) == Some(':') {
        eprintln!("[tts] validate_audio_path 检测到短盘符路径: label={}, raw={:?}, trimmed={:?}", label, p, t);
        return Err(format!("{} 路径无效（仅盘符），请填写完整目录", label));
    }
    // 要求路径看起来像目录（包含分隔符或足够长）
    if !t.contains('/') && !t.contains('\\') && t.len() < 4 {
        return Err(format!("{} 路径格式不正确", label));
    }
    Ok(())
}

/// 拆出脚本路径参数：单测用桩脚本直连协议（无需 AppHandle）。
/// hf_home：worker 子进程的 HF 缓存根目录（先确保存在，再注入环境）。
fn spawn_worker_with(cfg: &VoiceConfig, script: &Path, hf_home: &Path) -> Result<Arc<WorkerInner>, String> {
    validate_audio_path(&cfg.repo_dir, "Audio8 仓库目录")?;
    validate_audio_path(&cfg.model_dir, "模型目录")?;
    std::fs::create_dir_all(hf_home)
        .map_err(|e| format!("创建 HF 缓存目录失败（{}）: {e}", hf_home.display()))?;
    let mut cmd = Command::new(&cfg.python_cmd);
    // GUI 进程派生控制台子进程会弹黑窗，worker 一驻留 10 分钟更不能闪
    crate::dsh::hide_window(&mut cmd);
    apply_worker_env(&mut cmd, hf_home);
    let mut child = cmd
        .arg(script)
        .arg(&cfg.repo_dir)
        .arg(&cfg.model_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // stderr 直通应用控制台：torch/transformers 的加载日志与报错就地可见
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("启动 python 失败: {e}（python_cmd={}）", cfg.python_cmd))?;
    let stdin = child.stdin.take().expect("stdin piped");
    let stdout: ChildStdout = child.stdout.take().expect("stdout piped");
    let inner = Arc::new(WorkerInner {
        child: Mutex::new(Some(child)),
        stdin: Mutex::new(Some(stdin)),
        pending: Mutex::new(HashMap::new()),
        state: Mutex::new(WorkerState { ready: false, dead: false, error: None }),
        cv: Condvar::new(),
        dead_at: Mutex::new(None),
        next_id: AtomicU64::new(1),
    });
    spawn_worker_reader(inner.clone(), stdout);
    Ok(inner)
}

fn spawn_worker_reader(inner: Arc<WorkerInner>, stdout: ChildStdout) {
    std::thread::Builder::new()
        .name("tts-worker-read".into())
        .spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
                    continue;
                };
                match v.get("event").and_then(|e| e.as_str()) {
                    Some("ready") => {
                        inner.state.lock().unwrap().ready = true;
                        inner.cv.notify_all();
                        continue;
                    }
                    Some("fatal") => {
                        let err = v.get("error").and_then(|e| e.as_str()).unwrap_or("模型加载失败");
                        inner.mark_dead(err);
                        continue;
                    }
                    _ => {}
                }
                if let Some(id) = v.get("id").and_then(|i| i.as_str()) {
                    let ok = v.get("ok").and_then(|o| o.as_bool()).unwrap_or(false);
                    let err = v.get("error").and_then(|e| e.as_str()).map(String::from);
                    if let Some(tx) = inner.pending.lock().unwrap().remove(id) {
                        let _ = tx.send(if ok {
                            Ok(())
                        } else {
                            Err(err.unwrap_or_else(|| "生成失败".into()))
                        });
                    }
                }
            }
            // EOF：进程退出（kill / idle 自退 / 崩溃）。对已有请求是硬错误。
            inner.mark_dead("worker 进程已退出");
        })
        .expect("spawn tts worker reader thread");
}

/// 把内嵌 worker 脚本写到应用数据目录（每次拉起都重写，保证与二进制同步）
fn ensure_worker_script(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = tts_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建 tts 目录失败: {e}"))?;
    let path = dir.join("worker.py");
    std::fs::write(&path, WORKER_PY).map_err(|e| format!("写入 worker.py 失败: {e}"))?;
    Ok(path)
}

/// 应用退出时回收 worker 进程（lib.rs 的 RunEvent::Exit 调用）
pub fn shutdown_worker() {
    if let Some(entry) = WORKER.lock().unwrap().take() {
        entry.inner.kill();
    }
}

/// worker 是否驻留且存活（设置页「运行中/未运行」状态展示）
fn worker_running() -> bool {
    let guard = WORKER.lock().unwrap();
    match guard.as_ref() {
        Some(e) => !e.inner.state.lock().unwrap().dead,
        None => false,
    }
}

/// 清空排队中尚未处理的播报：防止「停止服务」后积压任务立刻重新拉起 worker
fn drain_queue() {
    let q = queue();
    q.inner.lock().unwrap().clear();
}

/// 停止语音服务的实际动作（命令与单测共用）：清队列 + 杀常驻 worker，
/// 模型占用的显存/内存随进程立即释放。返回是否真的停掉了一个存活 worker。
fn stop_voice_service_blocking() -> bool {
    drain_queue();
    match WORKER.lock().unwrap().take() {
        Some(entry) => {
            let was_running = !entry.inner.state.lock().unwrap().dead;
            entry.inner.kill();
            was_running
        }
        None => false,
    }
}

// ---------------------------------------------------------------------------
// 合成 + 播放
// ---------------------------------------------------------------------------

fn generate_wav(app: &AppHandle, cfg: &VoiceConfig, text: &str) -> Result<PathBuf, String> {
    // 先解析实际生效的参考音频（音色选择 → 内置 wav 解压 / 自定义参考音频），
    // 缓存键随之带参考指纹：换音色自动换缓存，不会串音色
    let reference = resolve_reference(app, cfg)?;
    let cache_tag = cfg.cache_tag(reference.as_ref().map(|(p, t)| (p.as_path(), t.as_str())));
    let path = cache_path(app, text, &cfg.model_dir, &cache_tag)?;
    let worker = worker_for(cfg, app)?;
    worker.generate(
        text,
        &path,
        &GenerateParams::from(cfg),
        reference.as_ref().map(|(p, t)| (p.as_path(), t.as_str())),
    )?;
    if let Some(dir) = path.parent() {
        trim_cache(dir);
    }
    Ok(path)
}

/// rodio 播放 WAV（原生音频输出，不受 WebView2 后台节流影响——窗口隐藏时照常出声）
fn play_wav(path: &Path) -> Result<(), String> {
    use rodio::{Decoder, Source};
    let file = std::fs::File::open(path).map_err(|e| format!("打开音频失败: {e}"))?;
    let source = Decoder::new_wav(BufReader::new(file))
        .map_err(|e| format!("解码 WAV 失败: {e}"))?;
    let (channels, rate) = (source.channels(), source.sample_rate());
    let stream = rodio::OutputStream::try_default()
        .map_err(|e| format!("打开音频输出设备失败: {e}"))?;
    let sink =
        rodio::Sink::try_new(&stream.1).map_err(|e| format!("创建播放通道失败: {e}"))?;
    // 每次播放都新开输出流：设备会话启动（WASAPI 激活/蓝牙链路建立）会吞掉最先
    // 渲染的一小段，而缓存 WAV 的语音能量从 0ms 就开始（实测 rms@20ms>0），
    // 表现为开头一两个字被吃掉。在采样层面垫 400ms 静音让设备预热消耗垫片而非
    // 语音（蓝牙链路建立可达数百毫秒，垫短了仍会切字）；rodio 0.19 已无 chain
    // 组合子，直接把静音前缀拼进样本缓冲。
    let mut data: Vec<i16> = source.collect();
    let lead = rate as usize * channels as usize * 400 / 1000;
    let mut padded = vec![0i16; lead];
    padded.append(&mut data);
    sink.append(rodio::buffer::SamplesBuffer::new(channels, rate, padded));
    // 阻塞至播完：队列线程本来就是串行语义，睡在播放上即是排队机制
    sink.sleep_until_end();
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri 命令
// ---------------------------------------------------------------------------

/// 内置音色元数据（设置页音色下拉框数据源；与前端 BuiltinVoiceMeta 同形）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltinVoiceMeta {
    pub id: String,
    pub name: String,
    pub description: String,
    /// 是否默认音色（voiceId 为空时的实际生效项）
    pub is_default: bool,
}

/// 内置音色列表：静态表随应用打包，无需磁盘/模型参与，前端下拉框直接渲染
#[tauri::command]
pub async fn tts_builtin_voices() -> Result<Vec<BuiltinVoiceMeta>, String> {
    Ok(BUILTIN_VOICES
        .iter()
        .map(|v| BuiltinVoiceMeta {
            id: v.id.into(),
            name: v.name.into(),
            description: v.description.into(),
            is_default: v.id == DEFAULT_VOICE_ID,
        })
        .collect())
}

/// 环境自检报告（cheap：不加载模型；torch 检查只 import 不建 session）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceEnvReport {
    pub python_version: Option<String>,
    pub python_error: Option<String>,
    pub repo_ok: bool,
    pub repo_hint: String,
    pub model_ok: bool,
    pub model_hint: String,
    pub codec_ok: bool,
    pub codec_hint: String,
    pub torch_ok: bool,
    pub torch_info: Option<String>,
    pub torch_error: Option<String>,
    /// torch 检测失败且 Python 可用时的完整一键安装命令（按有无 N 卡与系统语言生成）
    pub torch_install_cmd: Option<String>,
}

#[tauri::command]
pub async fn set_voice_config(
    state: State<'_, AppState>,
    config: VoiceConfig,
) -> Result<(), String> {
    if !matches!(config.speak_content.as_str(), "summary" | "title" | "desc") {
        return Err("speakContent 必须是 summary / title / desc".into());
    }
    if config.python_cmd.trim().is_empty() {
        return Err("python 命令不能为空".into());
    }
    if config.enabled && (config.repo_dir.is_empty() || config.model_dir.is_empty()) {
        return Err("启用语音播报前请先填写 Audio8 仓库目录与模型目录".into());
    }
    validate_voice_selection(&config)?;
    validate_generate_params(&config)?;
    *state.voice.lock().unwrap() = config;
    Ok(())
}

/// 合成参数合法性（对齐官方 infer.py validate_args 的采样约束）；纯函数供单测
fn validate_generate_params(cfg: &VoiceConfig) -> Result<(), String> {
    if cfg.temperature <= 0.0 {
        return Err("temperature 必须大于 0".into());
    }
    if cfg.top_p <= 0.0 || cfg.top_p > 1.0 {
        return Err("topP 必须在 (0, 1] 范围内".into());
    }
    if cfg.max_new_tokens == 0 || cfg.max_new_tokens > 8192 {
        return Err("maxNewTokens 需在 1~8192 之间".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn tts_env_check(state: State<'_, AppState>) -> Result<VoiceEnvReport, String> {
    let cfg = state.voice.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || env_check_blocking(&cfg))
        .await
        .map_err(|e| e.to_string())?
}

fn env_check_blocking(cfg: &VoiceConfig) -> Result<VoiceEnvReport, String> {
    // 路径校验：若无效，直接返回错误，不执行后续检查
    if let Err(e) = validate_audio_path(&cfg.repo_dir, "Audio8 仓库目录")
        .and_then(|_| validate_audio_path(&cfg.model_dir, "模型目录"))
    {
        return Err(e);
    }

    let mut report = VoiceEnvReport {
        python_version: None,
        python_error: None,
        repo_ok: false,
        repo_hint: String::new(),
        model_ok: false,
        model_hint: String::new(),
        codec_ok: false,
        codec_hint: String::new(),
        torch_ok: false,
        torch_info: None,
        torch_error: None,
        torch_install_cmd: None,
    };

    // 1) python 可执行性
    match run_with_timeout(
        Command::new(&cfg.python_cmd).arg("--version"),
        Duration::from_secs(10),
    ) {
        Ok(out) if out.status.success() => {
            report.python_version = Some(String::from_utf8_lossy(&out.stdout).trim().to_string());
        }
        Ok(out) => {
            report.python_error = Some(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        Err(e) => {
            report.python_error = Some(format!(
                "{e}。Windows 商店占位的 python.exe 会抢名：改用 py / venv 绝对路径"
            ));
        }
    }

    // 2) 仓库目录（worker 复用其 audio8_tts_data）
    let repo = Path::new(&cfg.repo_dir);
    report.repo_hint = format!("{}/audio8_tts_infer.py", cfg.repo_dir);
    report.repo_ok = !cfg.repo_dir.is_empty() && repo.join("audio8_tts_infer.py").is_file();

    // 3) 模型目录 + 4) codec：抽出的纯函数（单测覆盖两种布局）
    let (model_ok, model_hint, codec_ok, codec_hint) = check_model_dir(&cfg.model_dir);
    report.model_ok = model_ok;
    report.model_hint = model_hint;
    report.codec_ok = codec_ok;
    report.codec_hint = codec_hint;

    // 5) torch/transformers + 设备（只 import，不加载模型）
    if report.python_version.is_some() {
        match run_with_timeout(
            Command::new(&cfg.python_cmd).arg("-c").arg(
                "import torch, transformers; print(torch.__version__); print(transformers.__version__); print('cuda' if torch.cuda.is_available() else 'cpu')",
            ),
            Duration::from_secs(120),
        ) {
            Ok(out) if out.status.success() => {
                let text = String::from_utf8_lossy(&out.stdout);
                let parts: Vec<&str> = text.split_whitespace().collect();
                if parts.len() >= 3 {
                    report.torch_ok = true;
                    report.torch_info =
                        Some(format!("torch {} / transformers {} / {}", parts[0], parts[1], parts[2]));
                } else {
                    report.torch_error = Some(format!("无法解析输出: {text}"));
                }
            }
            Ok(out) => {
                report.torch_error = Some(String::from_utf8_lossy(&out.stderr).trim().to_string());
            }
            Err(e) => report.torch_error = Some(e),
        }
    }
    if !report.torch_ok && report.python_version.is_some() {
        report.torch_install_cmd = Some(torch_install_cmd_display(&cfg.python_cmd));
    }
    Ok(report)
}

// ---------------------------------------------------------------------------
// 依赖一键安装
// ---------------------------------------------------------------------------

pub const VOICE_INSTALL_LOG_EVENT: &str = "dsh://voice-install-log";

/// 中文系统下 pip 追加华为云 PyPI 镜像（与 npm 镜像策略一致）；非中文系统不动源配置
fn pypi_mirror_args() -> Vec<&'static str> {
    if crate::dsh::system_is_chinese() {
        vec!["-i", "https://repo.huaweicloud.com/repository/pypi/simple"]
    } else {
        vec![]
    }
}

/// 探测 NVIDIA 显卡（nvidia-smi 可用即视为有 N 卡 → 装 CUDA 版 torch）
fn has_nvidia_gpu() -> bool {
    let mut cmd = Command::new("nvidia-smi");
    cmd.arg("-L");
    run_with_timeout(&mut cmd, Duration::from_secs(5))
        .ok()
        .map(|o| o.status.success() && !String::from_utf8_lossy(&o.stdout).trim().is_empty())
        .unwrap_or(false)
}

/// 生成安装步骤参数（与 torch_install_cmd_display 共用，保证展示 = 实际执行）
fn torch_install_steps(cuda: bool) -> Vec<Vec<String>> {
    let mirror: Vec<String> = pypi_mirror_args().into_iter().map(String::from).collect();
    if cuda {
        vec![
            vec![
                "install".into(),
                "torch".into(),
                "--index-url".into(),
                "https://download.pytorch.org/whl/cu128".into(),
            ],
            ["install", "transformers", "soundfile", "numpy"]
                .iter()
                .map(|s| s.to_string())
                .chain(mirror)
                .collect(),
        ]
    } else {
        vec![["install", "torch", "transformers", "soundfile", "numpy"]
            .iter()
            .map(|s| s.to_string())
            .chain(mirror)
            .collect()]
    }
}

fn quote_if_spaced(s: &str) -> String {
    if s.contains(' ') {
        format!("\"{s}\"")
    } else {
        s.to_string()
    }
}

/// 自检报告里展示的完整安装命令（CUDA 步骤间用 && 串联，可整段复制到终端执行）
fn torch_install_cmd_display(python_cmd: &str) -> String {
    let py = quote_if_spaced(python_cmd);
    let cuda = has_nvidia_gpu();
    torch_install_steps(cuda)
        .iter()
        .map(|args| format!("{py} -m pip {}", args.join(" ")))
        .collect::<Vec<_>>()
        .join(" && ")
}

static VOICE_INSTALL_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 一键安装语音依赖：按有无 N 卡自动选 CUDA/CPU 版 torch，逐条执行 pip 并把
/// 输出逐行推给前端（VOICE_INSTALL_LOG_EVENT）。torch CUDA 包可达数 GB，过程可能
/// 持续数十分钟，命令在全部步骤结束后才返回（成功 Ok，任一步失败 Err 带退出码）。
#[tauri::command]
pub async fn tts_install_voice_deps(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let cfg = state.voice.lock().unwrap().clone();
    if cfg.python_cmd.trim().is_empty() {
        return Err("请先填写 Python 解释器路径".into());
    }
    if VOICE_INSTALL_RUNNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("依赖安装已在进行中".into());
    }
    let result = match tauri::async_runtime::spawn_blocking(move || {
        let steps = torch_install_steps(has_nvidia_gpu());
        for args in &steps {
            let mut cmd = Command::new(&cfg.python_cmd);
            cmd.arg("-m").arg("pip").args(args);
            cmd.stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            let child = match crate::dsh::hide_window(&mut cmd).spawn() {
                Ok(c) => c,
                Err(_) => return Err("无法启动 pip 进程，请检查 Python 解释器".to_string()),
            };
            let code = crate::dsh::pump_streams_until_exit(&app, child, VOICE_INSTALL_LOG_EVENT);
            if code != 0 {
                return Err(format!(
                    "pip 安装失败（退出码 {code}），详见安装日志，或手动执行自检报告里的命令"
                ));
            }
        }
        Ok(())
    })
    .await
    {
        Ok(r) => r,
        Err(e) => Err(e.to_string()),
    };
    VOICE_INSTALL_RUNNING.store(false, Ordering::SeqCst);
    result
}

/// 试听：走同一队列与缓存；不要求总开关已开（配置过程中随时验证）
#[tauri::command]
pub async fn tts_speak_test(
    app: AppHandle,
    state: State<'_, AppState>,
    text: Option<String>,
) -> Result<(), String> {
    let cfg = state.voice.lock().unwrap().clone();
    if let Err(e) = validate_audio_path(&cfg.repo_dir, "Audio8 仓库目录")
        .and_then(|_| validate_audio_path(&cfg.model_dir, "模型目录"))
    {
        return Err(e);
    }
    let text = text
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "系统推送自检：任务进展会在这里提醒你".into());
    enqueue_job(SpeakJob { app, text, force: true });
    Ok(())
}

/// 手动停止语音服务（设置页「停止服务」按钮）：清空排队播报 + 杀常驻 worker，
/// 模型占用的显存/内存随进程立即释放。返回是否真的停掉了一个运行中的 worker；
/// 之后的播报/试听会按需重新拉起 worker（冷启动需重新加载模型）。
#[tauri::command]
pub async fn tts_stop_voice_service() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(stop_voice_service_blocking)
        .await
        .map_err(|e| e.to_string())
}

/// 语音 worker 驻留状态（true = 模型已加载、驻留内存中）
#[tauri::command]
pub async fn tts_voice_status() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(worker_running)
        .await
        .map_err(|e| e.to_string())
}

/// 模型目录布局识别（纯函数，供单测）。两种布局独立校验、不混用：
/// - torch remote-code checkpoint（当前引擎使用）：config.json、tokenizer.json（根目录）、
///   modeling_arktts.py、model.safetensors、codec.pth
/// - ONNX-INT8 运行时包：*.onnx + tokenizer/ 子目录 + runtime_manifest.json，
///   无 codec.pth / model.safetensors——本期 torch 引擎不使用，明确提示而非套用
///   torch 的文件清单（历史上把两布局要求取并集导致两边都过不了自检）
/// 返回 (model_ok, model_hint, codec_ok, codec_hint)
fn check_model_dir(model_dir: &str) -> (bool, String, bool, String) {
    let model = Path::new(model_dir);
    let is_onnx_pkg = model.join("runtime_manifest.json").is_file()
        || model.join("fast_ar_int8.onnx").is_file();
    if is_onnx_pkg {
        return (
            false,
            "检测到 ONNX-INT8 运行时包（tokenizer/ 子目录布局）：当前 torch 引擎不使用，\
             请改填完整 remote-code checkpoint（含 model.safetensors 与 codec.pth）"
                .to_string(),
            false,
            "ONNX-INT8 包不含 codec.pth（其解码器为 onnx 权重），torch 引擎不适用".to_string(),
        );
    }
    let tokenizer_json = if model.join("tokenizer.json").is_file() {
        Some(format!("{model_dir}/tokenizer.json"))
    } else if model.join("tokenizer").join("tokenizer.json").is_file() {
        Some(format!("{model_dir}/tokenizer/tokenizer.json"))
    } else {
        None
    };
    let model_ok = !model_dir.is_empty()
        && model.join("config.json").is_file()
        && tokenizer_json.is_some()
        && model.join("modeling_arktts.py").is_file()
        && model.join("model.safetensors").is_file();
    let model_hint = match tokenizer_json {
        Some(t) => t,
        None if model_dir.is_empty() => "未填写模型目录".to_string(),
        None => format!("{model_dir}/config.json + tokenizer.json 未找到"),
    };
    // codec.pth 是 HF 下载最常中断的大文件：缺/.incomplete 都要单独指出
    let codec_pth = model.join("codec.pth");
    let codec_incomplete = model.join("codec.pth.incomplete");
    let codec_ok = model_ok && codec_pth.is_file();
    let codec_hint = if codec_pth.is_file() {
        format!("{model_dir}/codec.pth")
    } else if codec_incomplete.is_file() {
        "codec.pth 未下载完成（存在 .incomplete），请续传后重试".to_string()
    } else {
        format!("{model_dir}/codec.pth 不存在")
    };
    (model_ok, model_hint, codec_ok, codec_hint)
}

// ---------------------------------------------------------------------------
// 子进程小工具
// ---------------------------------------------------------------------------

/// 带超时的子进程执行（输出都很小，不做并发读管道处理）
fn run_with_timeout(
    cmd: &mut Command,
    timeout: Duration,
) -> Result<std::process::Output, String> {
    // 环境自检的 python 探测不应闪黑窗
    crate::dsh::hide_window(cmd);
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("无法启动进程: {e}"))?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return child.wait_with_output().map_err(|e| e.to_string()),
            Ok(None) => {
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("执行超时（>{:?}）", timeout));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

// ---------------------------------------------------------------------------
// 语音合成工具（独立窗口）：长文本分段合成 + WAV 拼接导出
// ---------------------------------------------------------------------------

/// 分段合成逐段进度事件（前端工具窗口驱动 antd Progress）
pub const TTS_SYNTH_PROGRESS_EVENT: &str = "dsh://tts-synth-progress";

/// 单段合成上限：Audio8 官方脚本建议单条 ≤150 字，留余量取 120
const SYNTH_CHUNK_CHARS: usize = 120;
/// 合成导出区（app_data/tts/exports）LRU 保留上限
const EXPORTS_KEEP: usize = 20;
/// 拼接时段间静音（毫秒）：模拟自然句间停顿
const SYNTH_GAP_MS: u64 = 180;

/// 打开语音合成工具独立窗口（已开则聚焦），主窗口设置页「语音播报」卡片入口。
/// 复用同一前端 bundle 经 hash 路由到 /tts-studio；无边框 + 自绘标题栏与主窗口
/// 观感一致（WindowControls 按 getCurrentWindow 对本窗口操作）。
/// section：None/"synth" → 合成页；"history" → 生成历史页（已开窗时原地路由切换）。
#[tauri::command]
pub async fn tts_open_studio(app: AppHandle, section: Option<String>) -> Result<(), String> {
    let history = matches!(section.as_deref(), Some("history"));
    if let Some(w) = app.get_webview_window("tts-studio") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        // 已开则聚焦并原地路由到目标页（hash 变化由前端 HashRouter 消费）
        let _ = w.eval(&format!(
            "window.location.hash = '#/tts-studio{}';",
            if history { "/history" } else { "" }
        ));
        return Ok(());
    }
    // 窗口尺寸：放大宽度到 1100px
    let win_w = 1100.0_f64;
    let win_h = 820.0_f64;

    let url = if history {
        "index.html#/tts-studio/history"
    } else {
        "index.html#/tts-studio"
    };

    let mut builder = tauri::WebviewWindowBuilder::new(
        &app,
        "tts-studio",
        tauri::WebviewUrl::App(url.into()),
    )
    .title("语音合成工具")
    .inner_size(win_w, win_h)
    .min_inner_size(900.0, 680.0)
    .decorations(false);

    // 优先使用 Tauri 的 center() 方法（若可用），否则回退到手动计算
    // Tauri 2 的 WebviewWindowBuilder 支持 .center() 使窗口真正居中（而非仅设置左上角）
    builder = builder.center();

    builder
        .build()
        .map_err(|e| format!("创建语音合成工具窗口失败: {e}"))?;
    Ok(())
}

/// Audio8_TTS 仓库地址（自动配置 / 一键克隆共用）
const AUDIO8_REPO_URL: &str = "https://github.com/Audio8-AI/Audio8_TTS";
/// 模型仓库地址：ModelScope 优先（国内快），失败回退 HuggingFace
const AUDIO8_MODEL_URL_MODELSCOPE: &str =
    "https://www.modelscope.cn/Audio8/Audio8-TTS-Preview-0.1b.git";
const AUDIO8_MODEL_URL_HF: &str = "https://huggingface.co/Audio8/Audio8-TTS-Preview-0.1b";
/// 仓库 / 模型在应用数据目录 `tts/` 下的默认目录名
const AUDIO8_REPO_DIR_NAME: &str = "Audio8_TTS";
const AUDIO8_MODEL_DIR_NAME: &str = "Audio8-TTS-Preview-0.1b";

/// 解析克隆目标目录：命令参数 `target`（去空白后非空才认）优先——即语音配置面板
/// 输入框里填的路径；留空则落到应用数据目录 `tts/` 下的默认目录名。
fn resolve_clone_target(target: Option<String>, base: &Path, default_name: &str) -> PathBuf {
    match target.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()) {
        Some(t) => PathBuf::from(t),
        None => base.join(default_name),
    }
}

/// 克隆 Audio8_TTS 仓库到 `target_dir`（已存在则跳过）。
/// 返回 (是否跳过, 动作描述列表)；git 缺失 / 克隆失败都返回 Err。
fn ensure_audio8_repo(target_dir: &Path) -> Result<(bool, Vec<String>), String> {
    let mut actions = Vec::new();
    if target_dir.exists() {
        actions.push("仓库目录已存在，跳过克隆".into());
        return Ok((true, actions));
    }
    if let Some(parent) = target_dir.parent() {
        let _ = fs::create_dir_all(parent);
    }
    actions.push(format!(
        "git clone {AUDIO8_REPO_URL} {}",
        target_dir.display()
    ));
    let status = Command::new("git")
        .args(["clone", AUDIO8_REPO_URL, &target_dir.to_string_lossy()])
        .status()
        .map_err(|e| format!("执行 git clone 失败（请确保已安装 git）: {e}"))?;
    if !status.success() {
        return Err("Audio8_TTS 仓库克隆失败".into());
    }
    actions.push("Audio8_TTS 仓库克隆完成".into());
    Ok((false, actions))
}

/// 克隆模型 checkpoint 到 `target_dir`（已存在则跳过）：ModelScope 优先、
/// HuggingFace 回退（国内可配 HF_ENDPOINT）。返回 (是否跳过, 动作描述列表)。
fn ensure_audio8_model(target_dir: &Path) -> Result<(bool, Vec<String>), String> {
    let mut actions = Vec::new();
    if target_dir.exists() {
        actions.push("模型目录已存在，跳过下载".into());
        return Ok((true, actions));
    }
    if let Some(parent) = target_dir.parent() {
        let _ = fs::create_dir_all(parent);
    }
    actions.push(format!(
        "git clone {AUDIO8_MODEL_URL_MODELSCOPE} {}",
        target_dir.display()
    ));
    let ms = Command::new("git")
        .args([
            "clone",
            AUDIO8_MODEL_URL_MODELSCOPE,
            &target_dir.to_string_lossy(),
        ])
        .status();
    match ms {
        Ok(s) if s.success() => {
            actions.push("模型仓库克隆完成（ModelScope）".into());
        }
        _ => {
            actions.push("ModelScope 克隆失败，尝试 Hugging Face 回退…".into());
            let status = Command::new("git")
                .args([
                    "clone",
                    AUDIO8_MODEL_URL_HF,
                    &target_dir.to_string_lossy(),
                ])
                .status()
                .map_err(|e| format!("执行 git clone (HF) 失败: {e}"))?;
            if !status.success() {
                return Err("模型下载失败，请手动执行 git clone 或配置 HF_ENDPOINT".into());
            }
            actions.push("模型仓库（HF）克隆完成".into());
        }
    }
    Ok((false, actions))
}

/// 自动配置 Audio8_TTS 仓库和模型（若路径为空）。
/// 在用户未配置时，自动克隆到应用数据目录下的 `tts/` 子目录。
#[tauri::command]
pub async fn tts_auto_setup(app: AppHandle) -> Result<serde_json::Value, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {e}"))?
        .join("tts");
    fs::create_dir_all(&base).map_err(|e| format!("创建 tts 目录失败: {e}"))?;

    let repo_dir = base.join(AUDIO8_REPO_DIR_NAME);
    let model_dir = base.join(AUDIO8_MODEL_DIR_NAME);

    let mut actions = Vec::new();
    let (_, repo_actions) = ensure_audio8_repo(&repo_dir)?;
    actions.extend(repo_actions);
    let (_, model_actions) = ensure_audio8_model(&model_dir)?;
    actions.extend(model_actions);

    Ok(json!({
        "repoDir": repo_dir.to_string_lossy().to_string(),
        "modelDir": model_dir.to_string_lossy().to_string(),
        "actions": actions,
    }))
}

/// 一键克隆 Audio8_TTS 仓库（语音配置面板仓库输入框旁按钮）。
/// `target` 省略/空 → 克隆到 `app_data/tts/Audio8_TTS`；填了路径 → 克隆到该路径。
/// 目录已存在时 `skipped=true` 直接返回，前端把 `repoDir` 回填输入框。
#[tauri::command]
pub async fn tts_clone_repo(
    app: AppHandle,
    target: Option<String>,
) -> Result<serde_json::Value, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {e}"))?
        .join("tts");
    let target_dir = resolve_clone_target(target, &base, AUDIO8_REPO_DIR_NAME);
    let (skipped, actions) = ensure_audio8_repo(&target_dir)?;
    Ok(json!({
        "repoDir": target_dir.to_string_lossy().to_string(),
        "skipped": skipped,
        "actions": actions,
    }))
}

/// 一键下载模型 checkpoint（模型输入框旁按钮）：ModelScope 优先、HF 回退。
/// `target` 省略/空 → `app_data/tts/Audio8-TTS-Preview-0.1b`；填了路径 → 该路径。
/// 目录已存在时 `skipped=true` 直接返回，前端把 `modelDir` 回填输入框。
#[tauri::command]
pub async fn tts_download_model(
    app: AppHandle,
    target: Option<String>,
) -> Result<serde_json::Value, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {e}"))?
        .join("tts");
    let target_dir = resolve_clone_target(target, &base, AUDIO8_MODEL_DIR_NAME);
    let (skipped, actions) = ensure_audio8_model(&target_dir)?;
    Ok(json!({
        "modelDir": target_dir.to_string_lossy().to_string(),
        "skipped": skipped,
        "actions": actions,
    }))
}

/// 长文本分段（纯函数，供单测）：先按句末标点（。！？!?；;\n）分句，贪心组段
/// 不超过 max_chars；单句超长时优先在次级标点（，、,与空格）处切，无标点再按
/// 字数硬切。换行本身是切分点，段内不保留。
fn split_text_chunks(text: &str, max_chars: usize) -> Vec<String> {
    fn flush(buf: &mut String, out: &mut Vec<String>) {
        let t = buf.trim();
        if !t.is_empty() {
            out.push(t.to_string());
        }
        buf.clear();
    }

    // 一句入段：塞得进当前段就塞，塞不下先落段再重新装
    fn add_piece(piece: &str, buf: &mut String, out: &mut Vec<String>, max_chars: usize) {
        let n = piece.chars().count();
        if !buf.is_empty() && buf.chars().count() + n > max_chars {
            flush(buf, out);
        }
        if n <= max_chars {
            buf.push_str(piece);
            return;
        }
        // 单句超长：在窗口内从后往前找次级标点切，比齐头硬切更自然
        let chars: Vec<char> = piece.chars().collect();
        let mut start = 0;
        while start < chars.len() {
            let end = (start + max_chars).min(chars.len());
            let cut = chars[start..end]
                .iter()
                .rposition(|c| matches!(c, '，' | '、' | ',' | ' '))
                .map(|i| start + i + 1)
                .unwrap_or(end);
            let mut seg: String = chars[start..cut].iter().collect();
            flush(&mut seg, out);
            start = cut;
        }
    }

    let mut out: Vec<String> = Vec::new();
    let mut buf = String::new();
    let mut sentence = String::new();
    for ch in text.chars() {
        sentence.push(ch);
        if matches!(ch, '。' | '！' | '？' | '!' | '?' | '；' | ';' | '\n') {
            let s = sentence.trim().to_string();
            sentence.clear();
            if !s.is_empty() {
                add_piece(&s, &mut buf, &mut out, max_chars);
            }
        }
    }
    let rest = sentence.trim().to_string();
    if !rest.is_empty() {
        add_piece(&rest, &mut buf, &mut out, max_chars);
    }
    flush(&mut buf, &mut out);
    out
}

/// 读取 WAV 样本（hound）：整型按位宽归一到 [-1, 1)，Float 原样。
/// 返回 (样本, 声道数, 采样率)。本应用只会遇到 worker（soundfile PCM16）与
/// 自身导出的 WAV，其余格式给出明确错误。
fn read_wav_samples(path: &Path) -> Result<(Vec<f32>, u16, u32), String> {
    let reader = hound::WavReader::open(path).map_err(|e| format!("读取 WAV 失败: {e}"))?;
    let spec = reader.spec();
    let (channels, rate) = (spec.channels, spec.sample_rate);
    let mut samples = Vec::new();
    match spec.sample_format {
        hound::SampleFormat::Float => {
            for s in reader.into_samples::<f32>() {
                samples.push(s.map_err(|e| format!("读取 WAV 样本失败: {e}"))?);
            }
        }
        hound::SampleFormat::Int => {
            let scale = (1u64 << (spec.bits_per_sample.saturating_sub(1) as u64)) as f32;
            for s in reader.into_samples::<i32>() {
                let v = s.map_err(|e| format!("读取 WAV 样本失败: {e}"))?;
                samples.push(v as f32 / scale);
            }
        }
    }
    Ok((samples, channels, rate))
}

/// 拼接多段 WAV 为单个 PCM16 文件（导出用）：各段声道数/采样率必须一致
/// （都出自同一 worker，恒等成立；不一致时报错而非静默变速）。段间垫
/// gap_ms 静音，听感模拟句间停顿。
fn concat_wavs(parts: &[PathBuf], gap_ms: u64, out: &Path) -> Result<(), String> {
    let mut channels: u16 = 0;
    let mut rate: u32 = 0;
    let mut all: Vec<f32> = Vec::new();
    for (i, p) in parts.iter().enumerate() {
        let (samples, ch, r) = read_wav_samples(p)?;
        if i == 0 {
            channels = ch;
            rate = r;
        } else if ch != channels || r != rate {
            return Err(format!(
                "分段音频参数不一致（第 1 段 {rate}Hz×{channels}声道，第 {} 段 {r}Hz×{ch}声道），无法拼接",
                i + 1
            ));
        }
        if !all.is_empty() && gap_ms > 0 {
            let gap = rate as usize * channels as usize * gap_ms as usize / 1000;
            all.extend(std::iter::repeat(0.0f32).take(gap));
        }
        all.extend(samples);
    }
    if parts.is_empty() {
        return Err("没有可拼接的音频段".into());
    }
    let spec = hound::WavSpec {
        channels,
        sample_rate: rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer =
        hound::WavWriter::create(out, spec).map_err(|e| format!("创建 WAV 失败: {e}"))?;
    for s in all {
        let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
        writer.write_sample(v).map_err(|e| format!("写入 WAV 失败: {e}"))?;
    }
    writer.finalize().map_err(|e| format!("收尾 WAV 失败: {e}"))?;
    Ok(())
}

/// 长文本合成主流程（spawn_blocking 内执行）：分段 → 逐段合成（每段独立吃
/// 文本缓存，改几个字不用重合成全文）→ 拼接导出到 app_data/tts/exports。
/// 每完成一段 emit 进度事件；返回导出文件绝对路径。
fn synthesize_blocking(app: &AppHandle, cfg: &VoiceConfig, text: &str) -> Result<PathBuf, String> {
    let chunks = split_text_chunks(text, SYNTH_CHUNK_CHARS);
    if chunks.is_empty() {
        return Err("文本内容为空".into());
    }
    let total = chunks.len();
    let mut parts: Vec<PathBuf> = Vec::with_capacity(total);
    for (i, chunk) in chunks.iter().enumerate() {
        let _ = app.emit(
            TTS_SYNTH_PROGRESS_EVENT,
            json!({ "current": i + 1, "total": total }),
        );
        let path = match cache_path_for(app, cfg, chunk) {
            Ok(p) if p.is_file() && p.metadata().map(|m| m.len() > 0).unwrap_or(false) => Ok(p),
            _ => generate_wav(app, cfg, chunk),
        }?;
        parts.push(path);
    }
    let dir = tts_dir(app)?.join("exports");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建导出目录失败: {e}"))?;
    let epoch = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let out = dir.join(format!("tts-{epoch}.wav"));
    concat_wavs(&parts, SYNTH_GAP_MS, &out)?;
    trim_wav_dir(&dir, EXPORTS_KEEP);
    // 导出成功即落历史（source=studio，带分段数）；记录失败不影响返回结果
    append_history(app, text, &out, "studio", total as u32);
    Ok(out)
}

/// 长文本合成（语音合成工具窗口）：进度经 TTS_SYNTH_PROGRESS_EVENT 逐段推送，
/// 命令在全部段合成 + 拼接完成后才返回导出文件绝对路径。每段独立复用文本缓存，
/// 首次调用会拉起 worker 并加载模型（30~90s）。
#[tauri::command]
pub async fn tts_synthesize(
    app: AppHandle,
    state: State<'_, AppState>,
    text: String,
) -> Result<String, String> {
    let cfg = state.voice.lock().unwrap().clone();
    if let Err(e) = validate_audio_path(&cfg.repo_dir, "Audio8 仓库目录")
        .and_then(|_| validate_audio_path(&cfg.model_dir, "模型目录"))
    {
        return Err(e);
    }
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("请输入要合成的文本".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        synthesize_blocking(&app, &cfg, &text).map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 播放本地 WAV（合成结果预览）：rodio 直连系统音频，窗口失焦/最小化照常出声
#[tauri::command]
pub async fn tts_play_file(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || play_wav(Path::new(&path)))
        .await
        .map_err(|e| e.to_string())?
}

/// 另存合成结果（前端 dialog save 选定 dest 后调用）：复制而非移动，
/// 导出区保留原件便于再次导出/播放
#[tauri::command]
pub async fn tts_export_wav(src: String, dest: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::copy(&src, &dest)
            .map(|_| ())
            .map_err(|e| format!("导出失败: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 在文件管理器中打开路径（复用 dsh::open_url：Windows 上 start "" 对目录同样有效）
#[tauri::command]
pub async fn tts_open_path(path: String) -> Result<(), String> {
    crate::dsh::open_url(&path)
}

// ---------------------------------------------------------------------------
// 语音生成历史命令
// ---------------------------------------------------------------------------

/// 历史列表条目（持久层 HistoryRecord + 列表时计算的 exists 文件存在标记）
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VoiceHistoryEntry {
    pub id: String,
    pub ts_ms: i64,
    pub text: String,
    pub path: String,
    pub source: String,
    pub chunks: u32,
    /// WAV 文件当前是否还存在（缓存 LRU/手动清理可能已删；false 时不可播放）
    pub exists: bool,
}

/// 语音生成历史列表（按时间倒序；文件已缺失的条目 exists=false 原样返回，
/// 由前端标记「文件已缺失」并允许清理）
#[tauri::command]
pub async fn tts_history_list(app: AppHandle) -> Result<Vec<VoiceHistoryEntry>, String> {
    let file = history_path(&app)?;
    let _guard = HISTORY_LOCK.lock().unwrap();
    let mut records = read_history_records(&file);
    records.sort_by(|a, b| b.ts_ms.cmp(&a.ts_ms).then_with(|| b.id.cmp(&a.id)));
    Ok(records
        .into_iter()
        .map(|r| {
            let exists = Path::new(&r.path).is_file();
            VoiceHistoryEntry {
                id: r.id,
                ts_ms: r.ts_ms,
                text: r.text,
                path: r.path,
                source: r.source,
                chunks: r.chunks,
                exists,
            }
        })
        .collect())
}

/// 删除一条历史记录：移除记录行；当没有其他记录引用同一文件且文件位于应用
/// 数据目录内（防御性约束，绝不删用户目录下的文件）时连 WAV 一起删除。
#[tauri::command]
pub async fn tts_history_delete(app: AppHandle, id: String) -> Result<(), String> {
    let file = history_path(&app)?;
    let _guard = HISTORY_LOCK.lock().unwrap();
    let records = read_history_records(&file);
    let Some(target) = records.iter().find(|r| r.id == id) else {
        return Err("记录不存在（可能已被删除）".into());
    };
    let target_path = target.path.clone();
    let still_referenced = records
        .iter()
        .any(|r| r.id != id && r.path == target_path);
    let rest: String = records
        .iter()
        .filter(|r| r.id != id)
        .filter_map(|r| serde_json::to_string(r).ok())
        .map(|mut l| {
            l.push('\n');
            l
        })
        .collect();
    std::fs::write(&file, rest).map_err(|e| format!("写入语音历史失败: {e}"))?;
    if !still_referenced {
        if let Ok(base) = tts_dir(&app) {
            let p = Path::new(&target_path);
            if p.starts_with(&base) {
                if let Err(e) = std::fs::remove_file(p) {
                    // 文件可能已被缓存 LRU 清掉：删不掉不视为错误，只记日志
                    eprintln!("[tts] 删除历史音频文件失败（忽略）: {e}");
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 克隆目标解析：命令 target 非空（含前后空白）优先，None/空白回退默认目录
    #[test]
    fn 克隆目标解析_target优先_留空回默认() {
        let base = Path::new("C:\\data\\tts");
        assert_eq!(
            resolve_clone_target(None, base, AUDIO8_REPO_DIR_NAME),
            base.join(AUDIO8_REPO_DIR_NAME)
        );
        assert_eq!(
            resolve_clone_target(Some("   ".into()), base, AUDIO8_REPO_DIR_NAME),
            base.join(AUDIO8_REPO_DIR_NAME)
        );
        assert_eq!(
            resolve_clone_target(Some(" D:\\custom\\repo ".into()), base, AUDIO8_REPO_DIR_NAME),
            PathBuf::from("D:\\custom\\repo")
        );
    }

    fn msg() -> NotifyMessage {
        NotifyMessage {
            kind: "todo",
            session_id: "s1".into(),
            session_title: "重构登录".into(),
            title: "更新任务清单",
            desc: "2 项完成、1 项进行中".into(),
            summary: "更新任务清单：2 项完成、1 项进行中".into(),
            body: "重构登录：2 项完成、1 项进行中".into(),
            ts: 0,
        }
    }

    #[test]
    fn 播报文本按配置选择() {
        let m = msg();
        assert_eq!(speak_text(&m, "summary"), "更新任务清单：2 项完成、1 项进行中");
        assert_eq!(speak_text(&m, "title"), "更新任务清单");
        assert_eq!(speak_text(&m, "desc"), "2 项完成、1 项进行中");
        // 未知值回退 summary
        assert_eq!(speak_text(&m, "bogus"), "更新任务清单：2 项完成、1 项进行中");
    }

    #[test]
    fn 自检通知不朗读走独立常量() {
        // VoiceChannel 对 kind=="sample" 的跳过在 deliver 里；这里锁定
        // push_sample 使用的 kind 值，防止有人改名后静默失效。
        assert_eq!(crate::notify::SAMPLE_KIND, "sample");
    }

    #[test]
    fn 缓存键随文本模型与参数变化() {
        let a = cache_key("你好", "model_a", "p1");
        assert_eq!(a, cache_key("你好", "model_a", "p1"), "同输入必须稳定");
        assert_ne!(a, cache_key("再见", "model_a", "p1"));
        assert_ne!(a, cache_key("你好", "model_b", "p1"));
        assert_ne!(a, cache_key("你好", "model_a", "p2"), "换采样参数不能重放缓存");
    }

    #[test]
    fn 配置默认值与worker键() {
        let d = VoiceConfig::default();
        assert!(!d.enabled);
        assert_eq!(d.speak_content, "summary");
        assert_eq!(d.python_cmd, "python");
        // 默认音色锚定内置音色：不再走模型原生默认（音色漂移）
        assert_eq!(d.voice_id, DEFAULT_VOICE_ID);
        assert_eq!(d.worker_key(), "python\u{1f}\u{1f}");
        // 采样参数默认与 worker 原硬编码值一致（行为不变）
        assert_eq!(
            d.params_tag(),
            "g0\u{1f}s42\u{1f}t0.8\u{1f}p0.95\u{1f}k50\u{1f}n512"
        );
        let mut c = d.clone();
        c.python_cmd = "py".into();
        assert_ne!(c.worker_key(), d.worker_key(), "换解释器必须重建 worker");
        // 采样参数不参与 worker 键：改参数不需要重载模型
        c.python_cmd = "python".into();
        c.seed = 7;
        assert_eq!(c.worker_key(), d.worker_key(), "采样参数不应触发 worker 重建");
        assert_ne!(c.params_tag(), d.params_tag(), "换 seed 必须换缓存");
    }

    #[test]
    fn 配置反序列化容忍缺省字段() {
        let cfg: VoiceConfig =
            serde_json::from_str(r#"{"enabled":true,"repoDir":"D:/a","modelDir":"D:/m"}"#)
                .expect("缺 speakContent/pythonCmd 时用 default");
        assert!(cfg.enabled);
        assert_eq!(cfg.speak_content, "summary");
        assert_eq!(cfg.python_cmd, "python");
        // 老版本存储没有采样参数字段：默认值补齐
        assert_eq!(cfg.temperature, 0.8);
        assert_eq!(cfg.top_p, 0.95);
        assert_eq!(cfg.seed, 42);
        assert_eq!(cfg.max_new_tokens, 512);
        assert!(!cfg.greedy);
        // 老版本存储没有参考音频字段：默认为空（默认音色）
        assert!(cfg.ref_audio.is_empty());
        assert!(cfg.ref_text.is_empty());
        // 老版本存储没有音色字段：默认内置音色补齐（resolve 时等价生效）
        assert_eq!(cfg.voice_id, DEFAULT_VOICE_ID);
    }

    /// 参考音频缓存指纹：换参考（路径/原文/文件内容）必须换缓存；无参考
    /// （custom 空对）时 cache_tag 与 params_tag 相同
    #[test]
    fn 参考音频进缓存键() {
        let tmp = std::env::temp_dir().join("dsh-tts-ref-tag");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let wav = tmp.join("ref.wav");
        std::fs::write(&wav, b"RIFF....").unwrap();
        let d = VoiceConfig::default();
        // 无参考：cache_tag == params_tag（模型原生默认音色的逃生口）
        assert_eq!(d.cache_tag(None), d.params_tag());
        // 有参考（generate_wav 传入实际生效的参考音频）
        let ref_some = Some((wav.as_path(), "参考原文"));
        assert_ne!(d.cache_tag(ref_some), d.params_tag(), "配了参考必须换缓存键");
        // 换参考原文
        let with_text_a = d.cache_tag(ref_some);
        assert_ne!(
            d.cache_tag(Some((wav.as_path(), "另一句原文"))),
            with_text_a,
            "换参考原文必须换缓存键"
        );
        // 同路径换文件内容（mtime/len 变化）
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&wav, b"RIFF..........").unwrap();
        assert_ne!(
            d.cache_tag(ref_some),
            with_text_a,
            "参考文件内容变化必须换缓存键"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 音色归一化：内置 id 原样生效；空/未知 id 回退默认内置音色（老配置与脏数据
    /// 兜底）；custom 走用户参考音频
    #[test]
    fn 音色选择归一化() {
        let mut c = VoiceConfig::default();
        match effective_voice(&c) {
            EffectiveVoice::Builtin(v) => assert_eq!(v.id, DEFAULT_VOICE_ID),
            EffectiveVoice::Custom => panic!("默认配置不应是 custom"),
        }
        c.voice_id = "zhixia".into();
        match effective_voice(&c) {
            EffectiveVoice::Builtin(v) => assert_eq!(v.id, "zhixia"),
            EffectiveVoice::Custom => panic!("内置 id 应解析为内置音色"),
        }
        c.voice_id = CUSTOM_VOICE_ID.into();
        assert!(matches!(effective_voice(&c), EffectiveVoice::Custom));
        c.voice_id = String::new();
        match effective_voice(&c) {
            EffectiveVoice::Builtin(v) => assert_eq!(v.id, DEFAULT_VOICE_ID, "空值回退默认音色"),
            EffectiveVoice::Custom => panic!("空值不应是 custom"),
        }
        c.voice_id = "no-such-voice".into();
        match effective_voice(&c) {
            EffectiveVoice::Builtin(v) => assert_eq!(v.id, DEFAULT_VOICE_ID, "未知 id 回退默认音色"),
            EffectiveVoice::Custom => panic!("未知 id 不应是 custom"),
        }
    }

    /// 音色选择校验：内置 id 合法；custom 时参考音频成对且文件存在；未知 id 拒绝；
    /// 空值（老配置兼容）通过
    #[test]
    fn 音色选择校验() {
        let tmp = std::env::temp_dir().join("dsh-tts-voice-validate");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let wav = tmp.join("ref.wav");
        std::fs::write(&wav, b"RIFF").unwrap();
        // 空 voice_id：老配置兼容，通过
        let mut c = VoiceConfig::default();
        c.voice_id = String::new();
        assert!(validate_voice_selection(&c).is_ok());
        // 内置音色：通过
        c.voice_id = "zhixia".into();
        assert!(validate_voice_selection(&c).is_ok());
        // 未知音色：拒绝
        c.voice_id = "no-such-voice".into();
        assert!(validate_voice_selection(&c).is_err());
        // custom：成对且存在通过；只填一边/文件不存在拒绝；都空走模型原生默认，通过
        c.voice_id = CUSTOM_VOICE_ID.into();
        c.ref_audio = wav.to_string_lossy().into_owned();
        assert!(validate_voice_selection(&c).is_err(), "只填音频不成对应拒绝");
        c.ref_text = "参考原文".into();
        assert!(validate_voice_selection(&c).is_ok());
        c.ref_audio = tmp.join("nope.wav").to_string_lossy().into_owned();
        assert!(validate_voice_selection(&c).is_err(), "文件不存在应拒绝");
        c.ref_audio = String::new();
        c.ref_text = String::new();
        assert!(validate_voice_selection(&c).is_ok(), "custom 空对走模型原生默认");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 参考音频成对校验：只填一边拒绝；文件不存在拒绝；成对且存在通过
    #[test]
    fn 参考音频配置必须成对且文件存在() {
        let tmp = std::env::temp_dir().join("dsh-tts-ref-validate");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let wav = tmp.join("ref.wav");
        std::fs::write(&wav, b"RIFF").unwrap();
        let w = |ref_audio: &str, ref_text: &str| {
            validate_reference_pair(&VoiceConfig {
                ref_audio: ref_audio.into(),
                ref_text: ref_text.into(),
                ..VoiceConfig::default()
            })
        };
        // 都空：默认音色，通过
        assert!(w("", "").is_ok());
        // 只填一边：官方要求成对
        assert!(w(wav.to_str().unwrap(), "").is_err());
        assert!(w("", "原文").is_err());
        // 成对但文件不存在
        assert!(w(tmp.join("nope.wav").to_str().unwrap(), "原文").is_err());
        // 成对且存在
        assert!(w(wav.to_str().unwrap(), "原文").is_ok());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn 合成参数校验_边界() {
        let mut c = VoiceConfig::default();
        assert!(validate_generate_params(&c).is_ok(), "默认参数应合法");
        c.temperature = 0.0;
        assert!(validate_generate_params(&c).is_err(), "temperature 必须大于 0");
        c.temperature = 2.0;
        assert!(validate_generate_params(&c).is_ok());
        c.top_p = 0.0;
        assert!(validate_generate_params(&c).is_err());
        c.top_p = 1.0;
        assert!(validate_generate_params(&c).is_ok(), "topP=1 合法");
        c.max_new_tokens = 0;
        assert!(validate_generate_params(&c).is_err());
        c.max_new_tokens = 8192;
        assert!(validate_generate_params(&c).is_ok());
    }

    #[test]
    fn generate参数序列化为python侧字段名() {
        // 锁定 JSONL wire 格式：worker 按 snake_case 取值，误加 rename_all 会静默失效
        let v = serde_json::to_value(GenerateParams::from(&VoiceConfig::default())).unwrap();
        // temperature/top_p 按 f32 精度写 JSONL（0.8f32 → 0.800000011920929，
        // Python float() 可无损读回），比较也须用 f32 值
        assert_eq!(v["temperature"], json!(0.8f32));
        assert_eq!(v["top_p"], json!(0.95f32));
        assert_eq!(v["top_k"], json!(50));
        assert_eq!(v["seed"], json!(42));
        assert_eq!(v["max_new_tokens"], json!(512));
        assert_eq!(v["greedy"], json!(false));
    }

    // -----------------------------------------------------------------------
    // 桩 worker 联调：无 torch 环境验证 JSONL 协议全链路
    // -----------------------------------------------------------------------

    /// 测试机可用解释器；都不可用则跳过（开源 CI 可能没有 Python）
    fn python_for_tests() -> Option<String> {
        ["py", "python", "python3"]
            .into_iter()
            .find(|cmd| {
                Command::new(cmd)
                    .arg("--version")
                    .output()
                    .map(|o| o.status.success())
                    .unwrap_or(false)
            })
            .map(String::from)
    }

    /// 桩 worker：argv[1] 为模式（ok | fatal），ok 模式对每条请求写一段
    /// 0.2s 440Hz WAV 后按协议应答；对非法输出路径如实回复失败
    const STUB_PY: &str = r#"
import sys, os, json, wave, struct, math
def emit(o):
    sys.stdout.write(json.dumps(o) + "\n")
    sys.stdout.flush()
mode = os.path.basename(sys.argv[1])
if "fatal" in mode:
    emit({"event": "fatal", "error": "stub fatal: boom"})
    sys.exit(1)
emit({"event": "ready", "device": "stub"})
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = json.loads(line)
    try:
        rate = 22050
        n = rate // 5
        with wave.open(req["output"], "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(rate)
            w.writeframes(b"".join(
                struct.pack("<h", int(6000 * math.sin(2 * math.pi * 440 * i / rate)))
                for i in range(n)))
        emit({"id": req.get("id"), "ok": True})
    except Exception as e:
        emit({"id": req.get("id"), "ok": False, "error": f"{type(e).__name__}: {e}"})
"#;

    fn stub_cfg(python: &str, tmp: &Path, mode: &str) -> VoiceConfig {
        let script = tmp.join(format!("stub_{mode}.py"));
        std::fs::write(&script, STUB_PY).unwrap();
        // repo_dir 传模式开关给桩；用真实存在的目录路径（盘符根等会被校验拒绝）
        let repo = tmp.join(format!("repo-{mode}"));
        std::fs::create_dir_all(&repo).unwrap();
        VoiceConfig {
            enabled: true,
            speak_content: "summary".into(),
            python_cmd: python.into(),
            repo_dir: repo.to_string_lossy().into_owned(), // 桩按目录名取模式
            model_dir: "stub-model".into(),
            ..VoiceConfig::default()
        }
    }

    #[test]
    fn 桩worker协议联调_握手生成与错误回传() {
        let Some(python) = python_for_tests() else {
            eprintln!("skip: 测试机无可用 Python");
            return;
        };
        let tmp = std::env::temp_dir().join("dsh-tts-stub");
        std::fs::create_dir_all(&tmp).unwrap();
        let cfg = stub_cfg(&python, &tmp, "ok");
        let worker =
            spawn_worker_with(&cfg, &tmp.join("stub_ok.py"), &tmp.join("hf-home"))
                .expect("拉起桩 worker 失败");

        // 1) ready 握手
        worker.wait_ready(Instant::now() + Duration::from_secs(30)).expect("握手失败");

        // 2) 正常生成：WAV 落盘且带 RIFF 头
        let out = tmp.join("out_ok.wav");
        worker
            .generate("你好", &out, &GenerateParams::from(&cfg), None)
            .expect("生成失败");
        let bytes = std::fs::read(&out).expect("wav 未写出");
        assert!(bytes.len() > 44, "wav 过小: {}", bytes.len());
        assert_eq!(&bytes[..4], b"RIFF");

        // 3) 非法输出路径：worker 回 ok:false，Rust 侧拿到 Err
        let bad = tmp.join("already_a_file.wav");
        std::fs::write(&bad, b"x").unwrap();
        let err = worker
            .generate("你好", &bad.join("nested.wav"), &GenerateParams::from(&cfg), None)
            .expect_err("非法路径应失败");
        assert!(!err.is_empty());

        worker.kill();
    }

    #[test]
    fn 桩worker致命错误置死并快速失败() {
        let Some(python) = python_for_tests() else {
            eprintln!("skip: 测试机无可用 Python");
            return;
        };
        let tmp = std::env::temp_dir().join("dsh-tts-stub");
        std::fs::create_dir_all(&tmp).unwrap();
        let cfg = stub_cfg(&python, &tmp, "fatal");
        let worker =
            spawn_worker_with(&cfg, &tmp.join("stub_fatal.py"), &tmp.join("hf-home"))
                .expect("拉起桩 worker 失败");
        let err = worker
            .wait_ready(Instant::now() + Duration::from_secs(30))
            .expect_err("fatal 后握手必须失败");
        assert!(err.contains("stub fatal"), "实际错误: {err}");
        worker.kill();
    }

    /// HF 缓存环境覆盖（纯函数）：HF 全家桶一律指向传入的 hf_home。
    /// 这是「系统找不到指定的路径 E:\」的根因修复——worker 不继承宿主 HF_HOME。
    #[test]
    fn worker子进程覆盖HF缓存环境变量() {
        let mut cmd = Command::new("python");
        let hf = Path::new("D:\\anywhere\\hf");
        apply_worker_env(&mut cmd, hf);
        let get = |k: &str| {
            cmd.get_envs()
                .find(|(name, _)| name.to_string_lossy() == k)
                .and_then(|(_, v)| v)
                .map(|v| v.to_string_lossy().into_owned())
        };
        assert_eq!(get("HF_HOME").as_deref(), Some("D:\\anywhere\\hf"));
        assert_eq!(get("HF_MODULES_CACHE").as_deref(), Some("D:\\anywhere\\hf\\modules"));
        assert_eq!(get("HF_HUB_CACHE").as_deref(), Some("D:\\anywhere\\hf\\hub"));
        assert_eq!(get("TRANSFORMERS_CACHE").as_deref(), Some("D:\\anywhere\\hf\\hub"));
        assert_eq!(get("HF_DATASETS_CACHE").as_deref(), Some("D:\\anywhere\\hf\\datasets"));
    }

    /// 端到端回归：宿主环境把 HF_HOME 指到不存在的盘（实机 E:\ 案例）时，
    /// worker 子进程必须收到覆盖后的应用内缓存路径，而不是继承的坏值。
    /// 桩把子进程里的 HF_MODULES_CACHE 原样回传，Rust 侧断言其等于 hf_home/modules。
    #[test]
    fn 桩worker继承的HF缓存环境被覆盖() {
        let Some(python) = python_for_tests() else {
            eprintln!("skip: 测试机无可用 Python");
            return;
        };
        let tmp = std::env::temp_dir().join("dsh-tts-env");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let echo_py = tmp.join("stub_env.py");
        std::fs::write(
            &echo_py,
            r#"
import sys, os, json
def emit(o):
    sys.stdout.write(json.dumps(o) + "\n")
    sys.stdout.flush()
emit({"event": "ready", "device": "stub"})
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = json.loads(line)
    emit({"id": req.get("id"), "ok": False,
          "error": os.environ.get("HF_MODULES_CACHE", "<unset>")})
"#,
        )
        .unwrap();
        let cfg = VoiceConfig {
            enabled: true,
            speak_content: "summary".into(),
            python_cmd: python.into(),
            repo_dir: tmp.to_string_lossy().into_owned(),
            model_dir: "stub-model".into(),
            ..VoiceConfig::default()
        };
        let hf_home = tmp.join("hf-home");
        let worker = spawn_worker_with(&cfg, &echo_py, &hf_home).expect("spawn stub worker");
        worker
            .wait_ready(Instant::now() + Duration::from_secs(30))
            .expect("握手失败");
        let err = worker
            .generate("你好", &tmp.join("env.wav"), &GenerateParams::from(&cfg), None)
            .expect_err("桩按约定以错误回传环境值");
        assert_eq!(
            err,
            hf_home.join("modules").to_string_lossy().into_owned(),
            "子进程必须收到覆盖后的 HF_MODULES_CACHE，而不是宿主的 E:\\ 等坏值"
        );
        worker.kill();
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn 缓存LRU超出上限删最旧() {
        use std::time::{Duration as D, SystemTime};
        let dir = std::env::temp_dir().join("dsh-tts-lru");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for i in 0..(CACHE_KEEP + 3) {
            let p = dir.join(format!("{i:03}.wav"));
            std::fs::write(&p, b"wav").unwrap();
            // set_modified 需要 FILE_WRITE_ATTRIBUTES，只读句柄（File::open）会被拒绝
            std::fs::OpenOptions::new()
                .write(true)
                .open(&p)
                .unwrap()
                .set_modified(SystemTime::now() - D::from_secs((CACHE_KEEP as u64 + 3 - i as u64) * 10))
                .unwrap();
        }
        std::fs::write(dir.join("keep.txt"), b"not wav").unwrap();
        trim_cache(&dir);
        let left: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().collect();
        assert_eq!(left.iter().filter(|e| e.path().extension().unwrap() == "wav").count(), CACHE_KEEP);
        assert!(dir.join("keep.txt").is_file(), "非 wav 不应被清理");
        assert!(!dir.join("000.wav").is_file(), "最旧的应先删");
        assert!(dir.join(format!("{:03}.wav", CACHE_KEEP + 2)).is_file(), "最新的应保留");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 手写最小 WAV（RIFF/PCM16 单声道），供播放测试
    fn write_beep_wav(path: &Path) {
        let rate = 22050u32;
        let n = (rate / 5) as usize; // 0.2s
        let mut data = Vec::with_capacity(n * 2);
        for i in 0..n {
            let s = (6000.0 * (2.0 * std::f32::consts::PI * 440.0 * i as f32 / rate as f32).sin()) as i16;
            data.extend_from_slice(&s.to_le_bytes());
        }
        let mut b = Vec::new();
        b.extend_from_slice(b"RIFF");
        b.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
        b.extend_from_slice(b"WAVEfmt ");
        b.extend_from_slice(&16u32.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes()); // PCM
        b.extend_from_slice(&1u16.to_le_bytes()); // mono
        b.extend_from_slice(&rate.to_le_bytes());
        b.extend_from_slice(&(rate * 2).to_le_bytes()); // byte rate
        b.extend_from_slice(&2u16.to_le_bytes()); // block align
        b.extend_from_slice(&16u16.to_le_bytes()); // bits
        b.extend_from_slice(b"data");
        b.extend_from_slice(&(data.len() as u32).to_le_bytes());
        b.extend_from_slice(&data);
        std::fs::write(path, b).unwrap();
    }

    #[test]
    fn 模型目录校验_两种布局不混用() {
        let tmp = std::env::temp_dir().join("dsh-tts-layout");
        let _ = std::fs::remove_dir_all(&tmp);

        // torch remote-code checkpoint：tokenizer.json 在根目录
        let torch = tmp.join("torch-ckpt");
        std::fs::create_dir_all(&torch).unwrap();
        for f in [
            "config.json",
            "tokenizer.json",
            "modeling_arktts.py",
            "model.safetensors",
            "codec.pth",
        ] {
            std::fs::write(torch.join(f), b"x").unwrap();
        }
        let (ok, hint, codec_ok, codec_hint) = check_model_dir(torch.to_str().unwrap());
        assert!(ok, "torch 布局必须通过: {hint}");
        assert!(codec_ok && codec_hint.ends_with("codec.pth"));

        // torch checkpoint 缺 codec.pth：模型项通过、codec 项单独报缺失
        std::fs::remove_file(torch.join("codec.pth")).unwrap();
        let (ok, _, codec_ok, codec_hint) = check_model_dir(torch.to_str().unwrap());
        assert!(ok && !codec_ok && codec_hint.contains("不存在"));

        // codec.pth 只下到一半：提示续传
        std::fs::write(torch.join("codec.pth.incomplete"), b"x").unwrap();
        let (_, _, _, codec_hint) = check_model_dir(torch.to_str().unwrap());
        assert!(codec_hint.contains("续传"));

        // ONNX-INT8 运行时包：tokenizer/ 子目录 + onnx 权重，无 codec.pth——
        // 不是 torch 引擎的模型目录，给出原因明确的提示
        let onnx = tmp.join("onnx-pkg");
        std::fs::create_dir_all(onnx.join("tokenizer")).unwrap();
        for f in ["config.json", "runtime_manifest.json", "fast_ar_int8.onnx"] {
            std::fs::write(onnx.join(f), b"x").unwrap();
        }
        std::fs::write(onnx.join("tokenizer").join("tokenizer.json"), b"x").unwrap();
        let (ok, hint, codec_ok, _) = check_model_dir(onnx.to_str().unwrap());
        assert!(!ok && hint.contains("ONNX-INT8") && !codec_ok);

        // 布局混用防护：ONNX 包即使补齐 torch 的文件也拒绝
        std::fs::write(onnx.join("tokenizer.json"), b"x").unwrap();
        std::fs::write(onnx.join("model.safetensors"), b"x").unwrap();
        std::fs::write(onnx.join("modeling_arktts.py"), b"x").unwrap();
        let (ok, hint, _, _) = check_model_dir(onnx.to_str().unwrap());
        assert!(!ok && hint.contains("ONNX-INT8"));

        // 空目录 / 未填写
        let empty = tmp.join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        let (ok, hint, _, _) = check_model_dir(empty.to_str().unwrap());
        assert!(!ok && hint.contains("未找到"));
        let (ok, hint, _, _) = check_model_dir("");
        assert!(!ok && hint.contains("未填写"));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 真实模型目录回归（机器相关）：设 DSH_TTS_MODEL_DIR 才启用
    #[test]
    fn 本机真实模型目录自检() {
        let Some(dir) = std::env::var("DSH_TTS_MODEL_DIR").ok().filter(|d| !d.is_empty())
        else {
            eprintln!("skip: 未设 DSH_TTS_MODEL_DIR");
            return;
        };
        let (ok, hint, codec_ok, _) = check_model_dir(&dir);
        assert!(ok, "真实 checkpoint 应通过: {hint}");
        assert!(codec_ok);
    }

    /// 一键安装步骤：CUDA 版拆 torch/其余依赖两步（torch 必须走 pytorch 官方源），
    /// CPU 版单步全装；中文系统（本机默认）会追加华为云 PyPI 镜像参数
    #[test]
    fn 安装步骤_cuda与cpu布局() {
        let cuda = torch_install_steps(true);
        assert_eq!(cuda.len(), 2);
        let t = cuda[0].join(" ");
        assert!(t.contains("torch") && t.contains("--index-url") && t.contains("download.pytorch.org"));
        let rest = cuda[1].join(" ");
        for pkg in ["transformers", "soundfile", "numpy"] {
            assert!(rest.contains(pkg));
        }
        assert!(!rest.contains("download.pytorch.org"));

        let cpu = torch_install_steps(false);
        assert_eq!(cpu.len(), 1);
        let all = cpu[0].join(" ");
        for pkg in ["torch", "transformers", "soundfile", "numpy"] {
            assert!(all.contains(pkg));
        }
    }

    #[test]
    fn 命令引用_含空格才加引号() {
        assert_eq!(quote_if_spaced("python"), "python");
        assert_eq!(
            quote_if_spaced("C:\\Program Files\\py\\python.exe"),
            "\"C:\\Program Files\\py\\python.exe\""
        );
    }

    // -----------------------------------------------------------------------
    // 语音生成历史
    // -----------------------------------------------------------------------

    fn hist_rec(id: &str, ts: i64) -> HistoryRecord {
        HistoryRecord {
            id: id.into(),
            ts_ms: ts,
            text: format!("文本{id}"),
            path: format!("C:\\tmp\\{id}.wav"),
            source: "notify".into(),
            chunks: 1,
        }
    }

    /// 追加超上限按时间倒序截断，最新保留；同毫秒按 id 兜底稳定
    #[test]
    fn 历史LRU超出上限删最旧() {
        let mut records: Vec<HistoryRecord> = Vec::new();
        for i in 0..(HISTORY_KEEP + 5) {
            merge_history(&mut records, hist_rec(&format!("r{i}"), 1000 + i as i64), HISTORY_KEEP);
        }
        assert_eq!(records.len(), HISTORY_KEEP);
        // 205 条截到 200：最旧的 r0..r4 被删，第一条是最新
        assert_eq!(records[0].id, format!("r{}", HISTORY_KEEP + 4));
        assert!(!records.iter().any(|r| r.id == "r0"), "最旧应被删");
    }

    /// 历史记录 wire 格式锁定：camelCase（前端 VoiceHistoryEntry 同形）
    #[test]
    fn 历史记录序列化为camelCase() {
        let v = serde_json::to_value(hist_rec("x", 1234)).unwrap();
        assert_eq!(v["id"], json!("x"));
        assert_eq!(v["tsMs"], json!(1234));
        assert_eq!(v["path"], json!("C:\\tmp\\x.wav"));
        assert_eq!(v["source"], json!("notify"));
        assert_eq!(v["chunks"], json!(1));
        // 反序列化容忍缺字段（手改/旧版记录）
        let back: HistoryRecord = serde_json::from_value(v).unwrap();
        assert_eq!(back.id, "x");
    }

    /// append → list → delete 全链路（用 AppHandle 的 tts_dir 依赖真实 app，
    /// 这里只测纯函数可覆盖的部分：记录读取容错坏行）
    #[test]
    fn 历史文件读取跳过坏行() {
        let tmp = std::env::temp_dir().join("dsh-tts-history");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let file = tmp.join("history.jsonl");
        std::fs::write(
            &file,
            format!(
                "{}\nnot-json\n{{\"id\":\"b\",\"tsMs\":2,\"text\":\"t\",\"path\":\"p\",\"source\":\"studio\",\"chunks\":3}}\n",
                serde_json::to_string(&hist_rec("a", 1)).unwrap()
            ),
        )
        .unwrap();
        let records = read_history_records(&file);
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].id, "a");
        assert_eq!(records[1].chunks, 3);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 停止服务：杀掉驻留 worker 并置为未运行；幂等（无 worker 再停返回 false）。
    /// 期间若 worker 已死亡（如空闲自退），停止返回 false 但仍清理队列。
    #[test]
    fn 停止服务_杀worker并置未运行() {
        let Some(python) = python_for_tests() else {
            eprintln!("skip: 测试机无可用 Python");
            return;
        };
        let tmp = std::env::temp_dir().join("dsh-tts-stop-test");
        std::fs::create_dir_all(&tmp).unwrap();
        let cfg = stub_cfg(&python, &tmp, "ok");
        let inner = spawn_worker_with(&cfg, &tmp.join("stub_ok.py"), &tmp.join("hf-home"))
            .expect("spawn stub worker");
        *WORKER.lock().unwrap() =
            Some(WorkerEntry { key: cfg.worker_key(), inner: inner.clone() });
        inner
            .wait_ready(Instant::now() + Duration::from_secs(10))
            .expect("stub worker 应握手成功");
        assert!(worker_running(), "ready 后应视为运行中");
        assert!(stop_voice_service_blocking(), "停止应返回 true");
        assert!(!worker_running(), "停止后应视为未运行");
        assert!(!stop_voice_service_blocking(), "再停一次应返回 false（幂等）");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn rodio播放wav出声() {
        let p = std::env::temp_dir().join("dsh-tts-beep.wav");
        write_beep_wav(&p);
        match play_wav(&p) {
            Ok(()) => {}
            Err(e) if e.contains("音频输出设备") => {
                eprintln!("skip: 无音频输出设备（{e}）");
            }
            Err(e) => panic!("播放失败: {e}"),
        }
        let _ = std::fs::remove_file(&p);
    }

    // -----------------------------------------------------------------------
    // 语音合成工具：长文本分段 + WAV 拼接
    // -----------------------------------------------------------------------

    #[test]
    fn 长文本分段_短文本单段与空文本() {
        assert_eq!(split_text_chunks("你好世界", 120), vec!["你好世界"]);
        assert!(split_text_chunks("  \n ", 120).is_empty());
        assert!(split_text_chunks("", 120).is_empty());
    }

    #[test]
    fn 长文本分段_按句贪心组段() {
        let text = "第一句。第二句！第三句？";
        // 全放得下 → 单段
        assert_eq!(split_text_chunks(text, 120), vec![text]);
        // 4 字/句，max=8：前两句恰好装满一段
        assert_eq!(
            split_text_chunks(text, 8),
            vec!["第一句。第二句！", "第三句？"]
        );
    }

    #[test]
    fn 长文本分段_换行是句边界() {
        // 换行与句末标点同为句边界；上限内的短句仍贪心并入同一段（段内不留换行）
        assert_eq!(split_text_chunks("第一行\n第二行", 120), vec!["第一行第二行"]);
        // 装不下时自然分段
        assert_eq!(
            split_text_chunks("第一行\n第二行\n第三行", 7),
            vec!["第一行第二行", "第三行"]
        );
    }

    #[test]
    fn 长文本分段_超长句次级标点优先与硬切() {
        // 无句末标点、只有逗号：160 字超长，在窗口内最后一个逗号后切
        let text = "啊，".repeat(80);
        let chunks = split_text_chunks(&text, 120);
        assert_eq!(chunks.len(), 2);
        assert!(chunks[0].ends_with('，'), "应切在次级标点后: {}", chunks[0]);

        // 完全无标点：按字数硬切
        let raw: String = std::iter::repeat('甲').take(250).collect();
        let chunks = split_text_chunks(&raw, 120);
        assert_eq!(
            chunks.iter().map(|c| c.chars().count()).collect::<Vec<_>>(),
            vec![120, 120, 10]
        );
    }

    #[test]
    fn wav拼接_保留样本并垫段间静音() {
        use hound::{SampleFormat, WavSpec, WavWriter};
        let tmp = std::env::temp_dir().join("dsh-tts-concat");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let spec = WavSpec {
            channels: 1,
            sample_rate: 8000,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        };
        let write = |name: &str, data: &[i16]| {
            let mut w = WavWriter::create(tmp.join(name), spec).unwrap();
            for v in data {
                w.write_sample(*v).unwrap();
            }
            w.finalize().unwrap();
            tmp.join(name)
        };
        let a = write("a.wav", &[100, -200, 300]);
        let b = write("b.wav", &[-400, 500]);
        let out = tmp.join("out.wav");
        concat_wavs(&[a.clone(), b], 1, &out).expect("拼接失败"); // gap 1ms @8kHz = 8 样本
        let (samples, ch, rate) = read_wav_samples(&out).unwrap();
        assert_eq!((ch, rate), (1, 8000));
        assert_eq!(samples.len(), 3 + 8 + 2);
        // PCM16 量化往返容差 ±1 LSB
        let near = |x: f32, v: i32| (x - v as f32 / 32768.0).abs() < 2.0 / 32768.0;
        assert!(near(samples[0], 100));
        assert!(near(samples[2], 300));
        assert!(samples[3..11].iter().all(|s| *s == 0.0), "段间应为静音");
        assert!(near(samples[11], -400));
        assert!(near(samples[12], 500));

        // 采样率不一致：拒绝拼接而非静默变速
        let spec2 = WavSpec {
            channels: 1,
            sample_rate: 22050,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        };
        let mut w = WavWriter::create(tmp.join("c.wav"), spec2).unwrap();
        w.write_sample(1).unwrap();
        w.finalize().unwrap();
        let err = concat_wavs(&[a.clone(), tmp.join("c.wav")], 0, &tmp.join("out2.wav")).unwrap_err();
        assert!(err.contains("不一致"), "实际: {err}");

        // 空输入
        let err = concat_wavs(&[], 0, &tmp.join("out3.wav")).unwrap_err();
        assert!(err.contains("没有可拼接"));
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
