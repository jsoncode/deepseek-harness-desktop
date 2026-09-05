import json, os, subprocess, sys, threading, time

REPO = os.path.join(os.environ["APPDATA"], "com.deepseek.harness.desktop", "tts", "Audio8_TTS")
MODEL = os.path.join(os.environ["APPDATA"], "com.deepseek.harness.desktop", "tts", "Audio8-TTS-Preview-0.1b")
HF = os.path.join(os.environ["APPDATA"], "com.deepseek.harness.desktop", "tts", "hf")
OUT = os.path.join(os.environ["TEMP"], "dsh-e2e-tts.wav")

# 与修复后的 Rust spawn_worker_with / apply_worker_env 完全一致的环境
env = dict(os.environ)
env["HF_HOME"] = HF
env["HF_HUB_CACHE"] = os.path.join(HF, "hub")
env["TRANSFORMERS_CACHE"] = os.path.join(HF, "hub")
env["HF_MODULES_CACHE"] = os.path.join(HF, "modules")
env["HF_DATASETS_CACHE"] = os.path.join(HF, "datasets")

p = subprocess.Popen([sys.executable, "src-tauri/src/tts_worker.py", REPO, MODEL],
                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding="utf-8", env=env)

def send(obj):
    p.stdin.write(json.dumps(obj) + "\n")
    p.stdin.flush()

start = time.time()
ready = None
for line in p.stdout:
    v = json.loads(line)
    if v.get("event") == "ready":
        ready = v
        break
    if v.get("event") == "fatal":
        print("FATAL:", v["error"])
        sys.exit(1)
print(f"READY in {time.time()-start:.1f}s:", ready)

t0 = time.time()
send({"id": "e2e-1", "text": "你好，语音合成修复验证成功。", "output": OUT,
      "params": {"temperature": 0.8, "top_p": 0.95, "top_k": 50, "seed": 42,
                 "max_new_tokens": 512, "greedy": False}})
for line in p.stdout:
    v = json.loads(line)
    if v.get("id") == "1":
        break
print(f"GENERATE in {time.time()-t0:.1f}s:", v)
p.kill()

size = os.path.getsize(OUT) if os.path.exists(OUT) else 0
with open(OUT, "rb") as f:
    head = f.read(4)
print(f"WAV: {OUT} size={size} header={head[:4]}")
print("E2E PASS" if v.get("ok") and size > 44 and head[:4] == b"RIFF" else "E2E FAIL")
