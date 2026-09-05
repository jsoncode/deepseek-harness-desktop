"""Processor 级参考音频通路验证（不加载模型，秒级）：
用与 tts_worker.py 完全相同的 processor 调用形态，确认
reference_audio + reference_text 产生参考条件输入（reference_audio_values），
无参考时不产生；成对校验缺失时报 ValueError。
"""
import os
import sys

import numpy as np
import soundfile as sf

MODEL = os.path.join(os.environ["APPDATA"], "com.deepseek.harness.desktop", "tts",
                     "Audio8-TTS-Preview-0.1b")
HF = os.path.join(os.environ["APPDATA"], "com.deepseek.harness.desktop", "tts", "hf")
os.environ["HF_HOME"] = HF
os.environ["HF_MODULES_CACHE"] = os.path.join(HF, "modules")
os.environ["HF_HUB_CACHE"] = os.path.join(HF, "hub")
os.environ["TRANSFORMERS_CACHE"] = os.path.join(HF, "hub")

REPO = os.path.join(os.environ["APPDATA"], "com.deepseek.harness.desktop", "tts", "Audio8_TTS")
sys.path.insert(0, REPO)
from audio8_tts_data import clean_text  # noqa: E402

from transformers import AutoProcessor  # noqa: E402

# 造一段 2 秒 44.1kHz 参考音频（44.1kHz 正好免 resample，不依赖 torchaudio）
ref = os.path.join(os.environ["TEMP"], "dsh-ref.wav")
sr = 44100
t = np.linspace(0, 1.0, sr, endpoint=False)
sf.write(ref, (0.1 * np.sin(2 * np.pi * 220 * t)).astype(np.float32), sr)

p = AutoProcessor.from_pretrained(MODEL, trust_remote_code=True)

# 1) 无参考：默认音色 prompt，不应有 reference 键
plain = p(text=["你好"], return_tensors="pt")
assert "reference_audio_values" not in plain, "无参考不应出现 reference 键"

# 2) 有参考：与 worker 请求路径同构（clean_text 清洗后的参考原文）
inputs = p(text=["你好"], reference_audio=[ref],
           reference_text=[clean_text("这是参考原文")], return_tensors="pt")
assert "reference_audio_values" in inputs, "有参考必须注入 reference_audio_values"
assert int(inputs["reference_audio_lengths"][0]) == sr, "参考长度应等于样本数"
prefix_len = int(inputs["prefix_input_ids"].shape[1])
print(f"PASS: reference conditioning OK (prefix tokens={prefix_len}, ref_samples={sr})")

# 3) 成对校验：只给音频不给原文必须报错（worker 侧同样拦截）
try:
    p(text=["你好"], reference_audio=[ref], return_tensors="pt")
    print("FAIL: 缺 reference_text 未报错")
    sys.exit(1)
except ValueError as e:
    print(f"PASS: pair validation raises: {e}")
