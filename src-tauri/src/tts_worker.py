"""Audio8 TTS 常驻推理 worker（由 Rust tts.rs 通过 stdin/stdout JSONL 驱动）。

协议（每行一个 JSON 对象，UTF-8）：
- 启动后加载模型，成功输出 {"event": "ready", "device": ..., "sample_rate": ...}，
  加载失败输出 {"event": "fatal", "error": ...} 后退出（由宿主决定是否重启）。
- 请求 {"id": ..., "text": ..., "output": ..., "params": {...}（可选）}：合成 44.1kHz
  WAV 写入 output，回 {"id": ..., "ok": true} 或 {"id": ..., "ok": false, "error": ...}。
  params 支持 temperature / top_p / top_k / seed / max_new_tokens / greedy（与官方
  audio8_tts_infer.py 参数同名同义），缺省用下方常量（原默认行为）。按请求携带：
  改参数无需重启 worker 重载模型。
  单条失败不影响常驻；模型目录/参数合法性由宿主保证有效。
- 空闲超过 10 分钟自动退出释放内存（宿主下次请求会重新拉起）。

用法：python tts_worker.py <Audio8_TTS 仓库目录> <模型目录>
仓库目录进 sys.path 以复用 audio8_tts_data.clean_text 等官方工具函数；
模型加载与 audio8_tts_infer.py 完全一致（AutoProcessor/AutoModel + trust_remote_code）。
"""

from __future__ import annotations

import json
import os
import sys
import time

# 宿主按 UTF-8 写读 JSONL；中文 Windows 下默认编码是 cp936，不强制会导致
# 请求解码失败 / 应答乱码（Rust 读线程遇非 UTF-8 字节直接判 worker 退出）
if hasattr(sys.stdout, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")

REPO_DIR = sys.argv[1]
MODEL_DIR = sys.argv[2]
IDLE_SECONDS = 600
MAX_TEXT_CHARS = 150  # Audio8 官方建议单次输入 ≤150 字，超长音质下降
MAX_NEW_TOKENS = 512
SEED = 42

sys.path.insert(0, REPO_DIR)


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> None:
    import torch
    from transformers import AutoModel, AutoProcessor

    from audio8_tts_data import clean_text

    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.bfloat16 if device == "cuda" else torch.float32
    try:
        processor = AutoProcessor.from_pretrained(MODEL_DIR, trust_remote_code=True)
        model = (
            AutoModel.from_pretrained(MODEL_DIR, trust_remote_code=True, dtype=dtype)
            .eval()
            .to(device)
        )
    except Exception as exc:  # noqa: BLE001 - 单行 JSON 报告全部加载失败原因
        emit({"event": "fatal", "error": f"{type(exc).__name__}: {exc}"})
        return
    sample_rate = int(model.config.codec_sample_rate)
    emit({"event": "ready", "device": device, "sample_rate": sample_rate})

    last_active = time.monotonic()

    import threading

    def idle_watch() -> None:
        while True:
            time.sleep(30)
            if time.monotonic() - last_active > IDLE_SECONDS:
                os._exit(0)

    threading.Thread(target=idle_watch, daemon=True).start()

    import numpy as np
    import soundfile as sf

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        last_active = time.monotonic()
        try:
            req = json.loads(line)
        except json.JSONDecodeError as exc:
            emit({"id": None, "ok": False, "error": f"bad request json: {exc}"})
            continue
        req_id = req.get("id")
        try:
            params = req.get("params") or {}
            temperature = float(params.get("temperature", 0.8))
            top_p = float(params.get("top_p", 0.95))
            top_k = int(params.get("top_k", 50))
            seed = int(params.get("seed", SEED))
            max_new_tokens = int(params.get("max_new_tokens", MAX_NEW_TOKENS))
            greedy = bool(params.get("greedy", False))

            text = clean_text(req["text"])
            if len(text) > MAX_TEXT_CHARS:
                text = text[:MAX_TEXT_CHARS]
            inputs = processor(text=[text], return_tensors="pt")
            inputs = {k: v.to(device) for k, v in inputs.items()}
            generator = torch.Generator(device=device).manual_seed(seed)
            gen_kwargs: dict = {
                "max_new_tokens": max_new_tokens,
                "do_sample": not greedy,
                "generator": generator,
                "return_dict_in_generate": True,
            }
            if not greedy:
                # greedy 下传采样参数只会触发 transformers 的 do_sample 不一致警告
                gen_kwargs.update(temperature=temperature, top_p=top_p, top_k=top_k)
            with torch.inference_mode():
                output = model.generate(**inputs, **gen_kwargs)
            code_length = int(output.code_lengths[0])
            waveforms, waveform_lengths = model.decode_audio(output.codes)
            waveform = waveforms[0, : int(waveform_lengths[0])]
            audio = waveform.float().cpu().numpy().astype(np.float32)
            out_path = req["output"]
            os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
            sf.write(out_path, audio, sample_rate)
            emit({"id": req_id, "ok": True, "code_frames": code_length})
        except Exception as exc:  # noqa: BLE001 - 单条失败回复后继续服务
            emit({"id": req_id, "ok": False, "error": f"{type(exc).__name__}: {exc}"})


if __name__ == "__main__":
    main()
