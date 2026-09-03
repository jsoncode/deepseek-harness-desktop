//! TTS 语音播报模块：基于 ONNX Runtime 调用 Audio8_TTS 模型进行推理
//!
//! 参考项目：https://github.com/Audio8-AI/Audio8_TTS
//! 推荐模型：Audio8/audio8-TTS-0.1B-ONNX-INT8
//!
//! 架构：
//! - TtsEngine：封装模型加载与推理，支持 CPU/GPU 设备切换
//! - VoiceChannel（notify.rs）：调用引擎进行播报
//! - 模型下载/选择：由前端 store 管理
//!
//! 模型结构（多阶段流水线）：
//!   tokenizer/ → token_ids
//!   ↓
//!   slow_ar_int8.onnx (慢速自回归模型)
//!   ↓
//!   fast_ar_int8.onnx (快速自回归模型)
//!   ↓
//!   codec_decoder_fp16.onnx (声码器)
//!   ↓
//!   waveform (f32) → rodio 播放

use std::path::Path;
use std::sync::OnceLock;

/// 推理设备类型
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InferenceDevice {
    /// CPU 推理（默认，兼容性好，适合低配电脑）
    Cpu,
    /// GPU 推理（CUDA / DirectML / CoreML，需对应硬件和驱动）
    Gpu,
}

impl Default for InferenceDevice {
    fn default() -> Self {
        InferenceDevice::Cpu
    }
}

impl InferenceDevice {
    #[allow(dead_code)]
    pub fn from_u8(v: u8) -> Self {
        match v {
            1 => InferenceDevice::Gpu,
            _ => InferenceDevice::Cpu,
        }
    }

    #[allow(dead_code)]
    pub fn to_u8(&self) -> u8 {
        match self {
            InferenceDevice::Cpu => 0,
            InferenceDevice::Gpu => 1,
        }
    }
}

/// TTS 推理器：封装 ONNX 模型加载与推理
pub struct TtsEngine {
    #[cfg(feature = "tts")]
    _loaded: bool,
    /// 推理设备（CPU/GPU）
    device: InferenceDevice,
    #[cfg(not(feature = "tts"))]
    _marker: std::marker::PhantomData<()>,
}

impl TtsEngine {
    /// 创建新的 TTS 引擎实例（延迟加载模型）
    #[allow(dead_code)]
    pub fn new() -> Self {
        Self {
            #[cfg(feature = "tts")]
            _loaded: false,
            device: InferenceDevice::default(),
            #[cfg(not(feature = "tts"))]
            _marker: std::marker::PhantomData,
        }
    }

    /// 设置推理设备
    #[allow(dead_code)]
    pub fn set_device(&mut self, device: InferenceDevice) {
        if self.device != device {
            #[cfg(feature = "tts")]
            {
                self._loaded = false;
            }
            self.device = device;
        }
    }

    /// 获取当前推理设备
    #[allow(dead_code)]
    pub fn device(&self) -> InferenceDevice {
        self.device
    }

    /// 加载模型（如果尚未加载）
    /// model_path: 模型目录路径（包含多个 .onnx 文件）
    #[cfg(feature = "tts")]
    pub fn ensure_loaded(&mut self, model_path: &Path) -> Result<(), String> {
        if self._loaded {
            return Ok(());
        }

        if !model_path.exists() {
            return Err(format!("模型目录不存在: {:?}", model_path));
        }

        // 加载 ONNX 模型
        // 模型目录应包含：
        //   - slow_ar_int8.onnx + .data
        //   - fast_ar_int8.onnx + .data
        //   - codec_decoder_fp16.onnx + .data

        // TODO: 实际使用 ort::Session::builder().commit_from_file() 加载
        // 当前 ort 2.0.0-rc.13 API 需要根据模型的实际输入输出签名适配
        //
        // 典型流程：
        // let slow_ar = Session::builder()?
        //     .commit_from_file(model_path.join("slow_ar_int8.onnx"))?;
        // let fast_ar = Session::builder()?
        //     .commit_from_file(model_path.join("fast_ar_int8.onnx"))?;
        // let decoder = Session::builder()?
        //     .commit_from_file(model_path.join("codec_decoder_fp16.onnx"))?;

        // 当前为占位实现，标记为已加载
        self._loaded = true;
        Ok(())
    }

    #[cfg(not(feature = "tts"))]
    pub fn ensure_loaded(&mut self, _model_path: &Path) -> Result<(), String> {
        Err("TTS 特性未启用，请使用 --features tts 编译".to_string())
    }

    /// 文本转语音并播放
    /// model_path: 模型目录路径
    /// 返回生成的音频时长（毫秒），失败时返回错误
    pub fn speak(&mut self, text: &str, model_path: &Path) -> Result<u64, String> {
        if text.trim().is_empty() {
            return Ok(0);
        }

        #[cfg(feature = "tts")]
        {
            self.ensure_loaded(model_path)?;

            // TODO: 实现真实的 ONNX 推理流水线
            //
            // 推理步骤（需要根据实际模型接口实现）：
            // 1. 加载 tokenizer（使用 tokenizer.json 或 merges.txt/vocab.json）
            // 2. 文本 → token_ids (Vec<i64>)
            // 3. 构造输入 tensor: input_ids [1, seq_len]
            // 4. session.run(slow_ar_int8) → 中间特征
            // 5. session.run(fast_ar_int8) → 加速特征
            // 6. session.run(codec_decoder) → waveform (Vec<f32>)
            // 7. 使用 rodio 播放 waveform
            //
            // 当前返回估算时长，实际推理需根据模型接口完成
            // 临时播放提示音验证音频链路
            #[cfg(feature = "tts")]
            {
                use rodio::{OutputStream, Sink, source::SineWave, Source};
                if let Ok((_stream, stream_handle)) = OutputStream::try_default() {
                    if let Ok(sink) = Sink::try_new(&stream_handle) {
                        // 播放 440Hz 正弦波 500ms 作为占位提示音
                        let source =
                            SineWave::new(440.0).take_duration(std::time::Duration::from_millis(500));
                        sink.append(source);
                        sink.sleep_until_end();
                    }
                }
            }

            let estimated_ms = 500u64;
            eprintln!(
                "[tts] 收到播报请求（推理占位，设备={:?}，模型={:?}）: {}",
                self.device,
                model_path,
                text
            );
            Ok(estimated_ms)
        }

        #[cfg(not(feature = "tts"))]
        {
            let _ = (text, model_path);
            Err("TTS 特性未启用".to_string())
        }
    }
}

/// 全局 TTS 引擎单例（避免重复加载模型）
pub static TTS_ENGINE: OnceLock<std::sync::Mutex<TtsEngine>> = OnceLock::new();

/// 获取全局 TTS 引擎
#[allow(dead_code)]
pub fn get_engine() -> std::sync::MutexGuard<'static, TtsEngine> {
    TTS_ENGINE
        .get_or_init(|| std::sync::Mutex::new(TtsEngine::new()))
        .lock()
        .expect("TTS 引擎锁中毒")
}

/// 尝试非阻塞获取全局 TTS 引擎
pub fn try_get_engine() -> Option<std::sync::MutexGuard<'static, TtsEngine>> {
    TTS_ENGINE.get().and_then(|m| m.try_lock().ok())
}

/// 默认模型路径（占位）
pub fn default_model_path() -> std::path::PathBuf {
    std::path::PathBuf::from("./models/audio8_tts_0.1b_int8.onnx")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 创建引擎不崩溃() {
        let _engine = TtsEngine::new();
    }
}
