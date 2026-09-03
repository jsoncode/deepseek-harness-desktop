//! TTS 语音播报模块：基于 ONNX Runtime 调用 Audio8_TTS 模型进行推理
//!
//! 参考项目：https://github.com/Audio8-AI/Audio8_TTS
//! 推荐模型：Audio8/audio8-TTS-0.1B-ONNX-INT8
//!
//! 架构：
//! - TtsEngine：封装模型加载与推理，支持 CPU/GPU 设备切换
//! - VoiceChannel（notify.rs）：调用引擎进行播报
//! - 模型下载/选择：由前端 store 管理

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

/// TTS 推理器
pub struct TtsEngine {
    #[cfg(feature = "tts")]
    _loaded: bool,
    /// 推理设备（CPU/GPU）
    device: InferenceDevice,
    #[cfg(not(feature = "tts"))]
    _marker: std::marker::PhantomData<()>,
}

impl TtsEngine {
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
        // 如果设备改变，需要重新加载模型（以应用新设备配置）
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

    #[cfg(feature = "tts")]
    pub fn ensure_loaded(&mut self, model_path: &Path) -> Result<(), String> {
        if !model_path.exists() {
            return Err(format!("模型文件不存在: {:?}", model_path));
        }
        // TODO: 实际加载 ort::Session
        // 加载时应根据 self.device 配置 ExecutionProvider：
        // - Cpu: 默认 CPU EP
        // - Gpu: CUDAExecutionProvider / DirectMLExecutionProvider / CoreMLExecutionProvider
        // 当前 ort 2.0.0-rc.13 API 复杂，需根据 Audio8_TTS 模型接口适配
        // 占位：假设加载成功
        self._loaded = true;
        Ok(())
    }

    #[cfg(not(feature = "tts"))]
    pub fn ensure_loaded(&mut self, _model_path: &Path) -> Result<(), String> {
        Err("TTS 特性未启用".to_string())
    }

    pub fn speak(&mut self, text: &str, model_path: &Path) -> Result<u64, String> {
        if text.trim().is_empty() {
            return Ok(0);
        }

        #[cfg(feature = "tts")]
        {
            self.ensure_loaded(model_path)?;
            // TODO: 实现真实的 ONNX 推理 + rodio 播放
            // 当前：使用 rodio 播放一个简单的提示音，验证音频链路
            // 实际应在 ONNX 推理后播放生成的 waveform
            #[cfg(feature = "tts")]
            {
                use rodio::{OutputStream, Sink, source::SineWave, Source};
                if let Ok((_stream, stream_handle)) = OutputStream::try_default() {
                    if let Ok(sink) = Sink::try_new(&stream_handle) {
                        // 播放 440Hz 正弦波 500ms 作为占位提示音
                        let source = SineWave::new(440.0).take_duration(std::time::Duration::from_millis(500));
                        sink.append(source);
                        sink.sleep_until_end();
                    }
                }
            }

            let estimated_ms = 500u64;
            eprintln!(
                "[tts] 收到播报请求（音频占位，设备={:?}）: {}，播放 {}ms 提示音",
                self.device, text, estimated_ms
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

/// 全局引擎单例
pub static TTS_ENGINE: OnceLock<std::sync::Mutex<TtsEngine>> = OnceLock::new();

#[allow(dead_code)]
pub fn get_engine() -> std::sync::MutexGuard<'static, TtsEngine> {
    TTS_ENGINE
        .get_or_init(|| std::sync::Mutex::new(TtsEngine::new()))
        .lock()
        .expect("TTS 引擎锁中毒")
}

pub fn try_get_engine() -> Option<std::sync::MutexGuard<'static, TtsEngine>> {
    TTS_ENGINE.get().and_then(|m| m.try_lock().ok())
}

pub fn default_model_path() -> std::path::PathBuf {
    std::path::PathBuf::from("./models/audio8_tts_0.1b_int8.onnx")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn 创建引擎不崩溃() {
        let _ = TtsEngine::new();
    }
}
