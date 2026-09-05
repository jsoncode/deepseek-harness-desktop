"""端到端音色克隆验证（真实 worker + 真实模型，GPU/CPU 均可）：
带 reference_audio + reference_text 走 tts_worker.py 全链路，
确认 zero-shot 条件合成成功落盘。模型加载需数分钟，耐心等待。
"""
import json
import os
import subprocess
import sys
import time

import numpy as np
import soundfile as sf

APP = os.path.join(os.environ["APPDATA"], "com.deepseek.harness.desktop", "tts")
REPO = os.path.join(APP, "Audio8_TTS")
MODEL = os.path.join(APP, "Audio8-TTS-Preview-0.1b")
HF = os.path.join(APP, "tts-hf-check", "hf")
OUT = os.path.join(os.environ["TEMP"], "dsh-e2e-ref.wav")

# 与 Rust apply_worker_env 相同的 HF 缓存覆盖（独立目录避免撞锁：直接跑的话先关应用）
os.makedirs(HF, exist_ok=True)
env = dict(os.environ)
env["HF_HOME"] = HF
env["HF_HUB_CACHE"] = os.path.join(HF, "hub")
env["TRANSFORMERS_CACHE"] = os.path.join(HF, "hub")
env["HF_MODULES_CACHE"] = os.path.join(HF, "modules")
env["HF_DATASETS_CACHE"] = os.path.join(HF, "datasets")

# 3 秒 220.5Hz 纯音作参考（44.1kHz 免 resample）
ref = os.path.join(os.environ["TEMP"], "dsh-ref-e2e.wav")
import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402

sr = 44100
t = np.linspace(0, 3.0, sr * 3, endpoint=False)
sf.write(ref, (0.05 * np.sin(2 * np.pi * 220.5 * t)).astype(np.float32), sr)

p = subprocess.Popen([sys.executable, "src-tauri/src/tts_worker.py", REPO, MODEL],
                     stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                     text=True, encoding="utf-8", env=env)

def send(obj):
    p.stdin.write(json.dumps(obj) + "\n")
    p.stdin.flush()

start = time.time()
for line in p.stdout:
    v = json.loads(line)
    if v.get("event") == "ready":
        print(f"READY in {time.time()-start:.1f}s: {v}")
        break
    if v.get("event") == "fatal":
        print("FATAL:", v["error"])
        sys.exit(1)

t0 = time.time()
send({"id": "ref-e2e", "text": "你好，参考音频验证成功。",
      "reference_audio": ref, "reference_text": "这是一段参考音频录音。",
      "output": OUT,
      "params": {"temperature": 0.8, "top_p": 0.95, "top_k": 50, "seed": 42,
                 "max_new_tokens": 512, "greedy": False}})
for line in p.stdout:
    v = json.loads(line)
    if v.get("id") == "e2e-ref":
        break
print(f"GENERATE in {time.time()-t0:.1f}s:", v)
p.kill()

size = os.path.getsize(OUT) if os.path.exists(OUT) else 0
head = open(OUT, "rb").read(4) if size else b""
print(f"WAV size={size} header={head[:4]}")
print("E2E PASS" if v.get("ok") and size > 44 and head[:4] == b"RIFF" else "E2E FAIL")
