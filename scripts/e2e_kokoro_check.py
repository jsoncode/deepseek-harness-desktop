import json, os, subprocess, sys, time

APP = os.path.join(os.environ["APPDATA"], "com.deepseek.harness.desktop", "tts")
MODEL = os.path.join(APP, "Kokoro-82M")
OUT = os.path.join(os.environ["TEMP"], "dsh-e2e-kokoro.wav")

# 与 Rust spawn_worker_with / apply_worker_env 完全一致的环境（含 HF 离线：
# kokoro_worker.py 全本地加载，任何意外下载都应快速失败而不是挂起）
env = dict(os.environ)
env["HF_HOME"] = os.path.join(APP, "hf")
env["HF_HUB_CACHE"] = os.path.join(APP, "hf", "hub")
env["HF_HUB_OFFLINE"] = "1"
env["TRANSFORMERS_OFFLINE"] = "1"

p = subprocess.Popen([sys.executable, "src-tauri/src/kokoro_worker.py", MODEL],
                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
                     encoding="utf-8", env=env)

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
send({"id": "kokoro-e2e-1", "text": "你好，Kokoro 语音合成验证成功。",
      "output": OUT, "params": {"speed": 1.0, "voice": "zf_xiaoxiao"}})
for line in p.stdout:
    v = json.loads(line)
    if v.get("id") == "kokoro-e2e-1":
        break
print(f"GENERATE in {time.time()-t0:.1f}s:", v)
p.kill()

size = os.path.getsize(OUT) if os.path.exists(OUT) else 0
with open(OUT, "rb") as f:
    head = f.read(4)
print(f"WAV: {OUT} size={size} header={head[:4]}")
print("E2E PASS" if v.get("ok") and size > 44 and head[:4] == b"RIFF" else "E2E FAIL")
