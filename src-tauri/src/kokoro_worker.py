"""Kokoro TTS 常驻推理 worker（由 Rust tts.rs 通过 stdin/stdout JSONL 驱动）。

与 tts_worker.py（Audio8）使用同一套 JSONL 协议与宿主编排逻辑，引擎选择由
宿主按配置决定拉起哪个脚本。协议（每行一个 JSON 对象，UTF-8）：
- 启动后加载模型，成功输出 {"event": "ready", "device": ..., "sample_rate": 24000}，
  加载失败输出 {"event": "fatal", "error": ...} 后退出（由宿主决定是否重启）。
- 请求 {"id": ..., "text": ..., "output": ..., "params": {"speed": 1.0,
  "voice": "zf_xiaoxiao"}}：合成 24kHz WAV 写入 output，回
  {"id": ..., "ok": true, "segments": n} 或 {"id": ..., "ok": false, "error": ...}。
  reference_audio/reference_text 忽略：Kokoro 不支持参考音频克隆，音色由
  voices/*.pt 音色包决定。speed 缺省 1.0；voice 缺省优先 zf_xiaoxiao，
  否则 voices 目录排序第一个。
- 空闲超过 10 分钟自动退出释放内存（宿主下次请求会重新拉起）。

用法：python kokoro_worker.py <Kokoro-82M 模型目录> [kokoro 源码目录]

模型目录 = `git clone https://www.modelscope.cn/AI-ModelScope/Kokoro-82M.git`
的产物（config.json + kokoro-v1_0.pth + voices/*.pt）。完全本地加载、全程
不访问网络：
- KModel(repo_id=..., config=<本地 config.json>, model=<本地 .pth>)：
  两个参数给足即不触发 hf_hub_download；
- 音色直接 torch.load 本地 .pt 成张量后作为 voice 传入（绕过 KPipeline 的
  HF 音色下载分支）；
- repo_id 仅作为逻辑标识（决定中文 G2P 的版本选择：'hexgrad/Kokoro-82M'
  → v0.19 风格中文韵律，与本仓库 voices 的训练配置一致），并抑制 KModel
  的 stdout 警告打印（stdout 是 JSONL 协议通道，任何打印都会污染协议）。

可选第 3 参 = kokoro 库源码目录（git clone https://github.com/hexgrad/kokoro
得到、含 kokoro/__init__.py 的目录）：提供时插到 sys.path 最前，优先于 pip
安装的 kokoro 包加载（与 Audio8 的「仓库目录」同构，便于跟踪上游 main）；
留空用 pip 安装的包（pip install "kokoro>=0.9.4"）。misaki G2P 始终来自 pip。

依赖：pip install "kokoro>=0.9.4" soundfile "misaki[zh]"（中文音色需要
misaki[zh]，即 jieba/pypinyin 等；英文音色的生词回退可选装 espeak-ng）。
"""

from __future__ import annotations

import glob
import json
import os
import sys
import time

# 宿主按 UTF-8 写读 JSONL；中文 Windows 下默认编码是 cp936，不强制会导致
# 请求解码失败 / 应答乱码（Rust 读线程遇非 UTF-8 字节直接判 worker 退出）
if hasattr(sys.stdout, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")

MODEL_DIR = sys.argv[1]
# 可选：kokoro 库源码目录（含 kokoro/__init__.py）；提供时优先于 pip 包加载
KOKORO_REPO_DIR = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2].strip() else ""
IDLE_SECONDS = 600
SAMPLE_RATE = 24000  # Kokoro 固定 24kHz 输出
SEG_GAP_S = 0.08  # 多段（长文本）拼接时段间静音，模拟句间停顿

# 设计上完全本地加载：任何意外的 hf_hub_download 调用都应快速失败而不是
# 挂起（离线环境/国内网络下网络下载既慢又不可靠）
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

# 逻辑 repo id：与 ModelScope 仓库对应的 HF 官方仓库名。只用于
# 1) KModel/KPipeline 抑制 stdout 默认值警告；
# 2) KPipeline 中文 G2P 版本选择（repo_id 以 '/Kokoro-82M' 结尾 → v0.19 韵律，
#    与本仓库 zf_*/zm_* 音色训练配置一致；否则会误用 v1.1 韵律）。
# 权重/config/音色全部走本地文件，该 id 不会触发任何下载。
REPO_ID = "hexgrad/Kokoro-82M"

# 音色名前缀 → KPipeline lang_code（G2P 语言），与官方文档一致
LANG_BY_PREFIX = {
    "a": "a",  # American English
    "b": "b",  # British English
    "e": "e",  # Spanish
    "f": "f",  # French fr-fr
    "h": "h",  # Hindi
    "i": "i",  # Italian
    "p": "p",  # Brazilian Portuguese
    "j": "j",  # Japanese
    "z": "z",  # Mandarin Chinese
}


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def find_weights(model_dir: str) -> str:
    """定位权重文件：kokoro-v1_0.pth 优先，回退目录内排序第一个 .pth"""
    preferred = os.path.join(model_dir, "kokoro-v1_0.pth")
    if os.path.isfile(preferred):
        return preferred
    others = sorted(glob.glob(os.path.join(model_dir, "*.pth")))
    if others:
        return others[0]
    raise FileNotFoundError(
        f"模型目录缺少权重文件（config.json + kokoro-v1_0.pth）: {model_dir}"
    )


def resolve_voice(voices_dir: str, name: str) -> str:
    """音色名 → 本地 .pt 绝对路径。空名优先 zf_xiaoxiao，回退排序第一个。"""
    name = (name or "").strip()
    if name.endswith(".pt"):
        if not os.path.isfile(name):
            raise FileNotFoundError(f"音色文件不存在: {name}")
        return name
    if name:
        path = os.path.join(voices_dir, f"{name}.pt")
        if os.path.isfile(path):
            return path
        avail = ", ".join(
            sorted(os.path.splitext(os.path.basename(p))[0] for p in glob.glob(os.path.join(voices_dir, "*.pt")))[:40]
        )
        raise FileNotFoundError(f"音色不存在: {name}（可用音色: {avail or '无'}）")
    preferred = os.path.join(voices_dir, "zf_xiaoxiao.pt")
    if os.path.isfile(preferred):
        return preferred
    pts = sorted(glob.glob(os.path.join(voices_dir, "*.pt")))
    if not pts:
        raise FileNotFoundError(f"voices 目录没有 .pt 音色文件: {voices_dir}")
    return pts[0]


def main() -> None:
    # 可选源码目录优先：插到 sys.path 最前，`from kokoro import ...` 命中源码包
    # 而不是 pip 安装版（与 Audio8 worker 的 REPO_DIR 机制同构）
    if KOKORO_REPO_DIR:
        if not os.path.isfile(os.path.join(KOKORO_REPO_DIR, "kokoro", "__init__.py")):
            emit({
                "event": "fatal",
                "error": (
                    f"kokoro 源码目录无效（缺少 kokoro/__init__.py）: {KOKORO_REPO_DIR}"
                    "（留空即改用 pip 安装的 kokoro 包）"
                ),
            })
            return
        sys.path.insert(0, KOKORO_REPO_DIR)
    from kokoro import KModel, KPipeline  # 缺依赖时 ImportError → fatal 提示安装

    import torch

    try:
        weights = find_weights(MODEL_DIR)
        config_path = os.path.join(MODEL_DIR, "config.json")
        if not os.path.isfile(config_path):
            raise FileNotFoundError(f"模型目录缺少 config.json: {MODEL_DIR}")
        device = "cuda" if torch.cuda.is_available() else "cpu"
        # config/model 都给本地路径 → 不触发 HF 下载；repo_id 抑制 stdout 打印
        model = KModel(repo_id=REPO_ID, config=config_path, model=weights).to(device).eval()
    except Exception as exc:  # noqa: BLE001 - 单行 JSON 报告全部加载失败原因
        emit({
            "event": "fatal",
            "error": (
                f"{type(exc).__name__}: {exc}（Kokoro 依赖未安装时请执行 "
                'pip install "kokoro>=0.9.4" soundfile "misaki[zh]"）'
            ),
        })
        return

    # 音色包（G2P 语言）按需建 pipeline：KModel 语言无关，跨 pipeline 复用一份权重
    pipelines: dict[str, "KPipeline"] = {}

    def get_pipeline(lang_code: str) -> "KPipeline":
        pipe = pipelines.get(lang_code)
        if pipe is None:
            try:
                pipe = KPipeline(lang_code=lang_code, repo_id=REPO_ID, model=model)
            except ImportError as exc:
                # lang_code='z' 缺 misaki[zh] 时 KPipeline 内部抛 ImportError
                raise ImportError(
                    f"{exc}（中文音色需要 pip install \"misaki[zh]\"）"
                ) from exc
            pipelines[lang_code] = pipe
        return pipe

    voices_dir = os.path.join(MODEL_DIR, "voices")
    if not glob.glob(os.path.join(voices_dir, "*.pt")):
        emit({"event": "fatal", "error": f"voices 目录没有 .pt 音色文件: {voices_dir}"})
        return

    emit({"event": "ready", "device": device, "sample_rate": SAMPLE_RATE})

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
            speed = float(params.get("speed", 1.0))
            if not speed > 0:
                speed = 1.0
            voice_path = resolve_voice(voices_dir, str(params.get("voice") or ""))
            stem = os.path.splitext(os.path.basename(voice_path))[0]
            lang_code = LANG_BY_PREFIX.get(stem[:1], "a")
            text = str(req["text"]).strip()
            if not text:
                raise ValueError("text 为空")

            # 音色直接加载成本地张量传入：不经过 KPipeline 的 HF 音色下载分支
            pack = torch.load(voice_path, map_location="cpu", weights_only=True)
            pipeline = get_pipeline(lang_code)

            segments: list[np.ndarray] = []
            # 逐段生成（KPipeline 内部按 510 音素/400 字自动分块）；Rust 侧已把
            # 文本分成 ≤120 字的段，这里通常只有一段
            for _gs, _ps, audio in pipeline(text, voice=pack, speed=speed, split_pattern=r"\n+"):
                if audio is None:
                    continue
                segments.append(audio.detach().cpu().numpy().astype(np.float32))
            if not segments:
                raise ValueError("没有生成任何音频")
            audio_out = segments[0]
            if len(segments) > 1:
                gap = np.zeros(int(SAMPLE_RATE * SEG_GAP_S), dtype=np.float32)
                for seg in segments[1:]:
                    audio_out = np.concatenate([audio_out, gap, seg])

            out_path = req["output"]
            os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
            sf.write(out_path, audio_out, SAMPLE_RATE)
            emit({"id": req_id, "ok": True, "segments": len(segments)})
        except Exception as exc:  # noqa: BLE001 - 单条失败回复后继续服务
            emit({"id": req_id, "ok": False, "error": f"{type(exc).__name__}: {exc}"})


if __name__ == "__main__":
    main()
