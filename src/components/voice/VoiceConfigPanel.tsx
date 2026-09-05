import { useEffect, useRef, useState, type ReactNode } from "react";
import { App as AntApp } from "antd";
import { Button, Collapse, Input, InputNumber, Segmented, Space, Typography } from "antd";
import { useNotifyStore, VOICE_SYNTH_DEFAULTS } from "../../store/useNotifyStore";
import {
  api,
  EVENTS,
  onEvent,
  type LogLine,
  type NotifyVoicePayload,
  type VoiceConfig,
  type VoiceEnvReport,
} from "../../lib/tauri";

const { Text } = Typography;

/**
 * 语音配置面板（语音合成工具窗口内）：Audio8 路径配置、环境自检、依赖一键安装、
 * 试听与停止服务、合成参数（采样模式 / temperature / top_p / top_k / seed /
 * max_new_tokens）、首次使用引导。从设置页「通知管理」整体迁出——配置与验证都
 * 集中在工具窗口，主窗口只留总开关与入口。
 * 播报状态事件（EVENTS.notifyVoice）带 Rust 侧 worker 实时驻留标记（running），
 * 停止服务按钮据此保持新鲜；事件只在播报时来，另有 20s 轮询兜底。
 */
export default function VoiceConfigPanel() {
  const { message } = AntApp.useApp();
  const voice = useNotifyStore((s) => s.voice);
  const setVoice = useNotifyStore((s) => s.setVoice);

  // 路径类输入用本地草稿、失焦提交：避免每个按键都同步 Rust 与校验报错
  const [pythonDraft, setPythonDraft] = useState(voice.pythonCmd);
  const [repoDraft, setRepoDraft] = useState(voice.repoDir);
  const [modelDraft, setModelDraft] = useState(voice.modelDir);

  const [env, setEnv] = useState<VoiceEnvReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [testing, setTesting] = useState(false);
  const [voiceState, setVoiceState] = useState<string | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installTail, setInstallTail] = useState<string[]>([]);
  const [serviceRunning, setServiceRunning] = useState(false);

  // runEnvCheck 的 ref：安装结束事件回调（挂载时订阅）里需要触发最新版本的自检
  const runEnvCheckRef = useRef<() => void>(() => {});

  // 语音播报状态事件：generating / playing / done / error（见 tts.rs emit_voice）。
  // 事件负载带 Rust 侧 worker 实时驻留状态（running）：命中缓存直接播放时不启
  // worker，不能凭「有播报事件」就认定服务在运行
  useEffect(() => {
    let unbind: (() => void) | undefined;
    void onEvent<NotifyVoicePayload>(EVENTS.notifyVoice, (p) => {
      setVoiceState(p.state);
      setVoiceError(p.error);
      setServiceRunning(p.running);
      if (p.state === "done" || p.state === "error") setTesting(false);
    }).then((u) => {
      unbind = u;
    });
    return () => unbind?.();
  }, []);

  // worker 会随时按需启动/空闲自退/崩溃，而事件只在播报时来：窗口停留期间
  // 每 20s 直接向后端校准一次，保证「停止服务」按钮状态不陈旧（含刚打开时）
  useEffect(() => {
    const refresh = () =>
      void api
        .ttsVoiceStatus()
        .then(setServiceRunning)
        .catch(() => {});
    refresh();
    const id = setInterval(refresh, 20000);
    return () => clearInterval(id);
  }, []);

  // 配置经跨窗口 storage 同步变化（主窗口总开关等）时，草稿输入框跟进最新值
  useEffect(() => {
    setPythonDraft(voice.pythonCmd);
    setRepoDraft(voice.repoDir);
    setModelDraft(voice.modelDir);
  }, [voice.pythonCmd, voice.repoDir, voice.modelDir]);

  const commitVoice = (patch: Partial<typeof voice>) => setVoice(patch);

  const runEnvCheck = async () => {
    setChecking(true);
    setEnv(null);
    try {
      const report = await api.ttsEnvCheck();
      setEnv(report);
    } catch (e) {
      message.error(`环境自检失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    runEnvCheckRef.current = () => void runEnvCheck();
  });

  // 依赖一键安装的日志事件（Rust tts.rs：pip 逐行输出；结果由命令 Promise 返回）
  useEffect(() => {
    let unbind: (() => void) | undefined;
    void onEvent<LogLine>(EVENTS.voiceInstallLog, (p) => {
      setInstallTail((prev) => {
        const next = [...prev, p.line];
        return next.length > 300 ? next.slice(next.length - 300) : next;
      });
    }).then((u) => {
      unbind = u;
    });
    return () => unbind?.();
  }, []);

  const runInstall = async () => {
    if (installing) return;
    setInstalling(true);
    setInstallTail([]);
    try {
      // torch CUDA 包可达数 GB，可能跑数十分钟；结束（成功或失败）都等这里返回
      await api.ttsInstallVoiceDeps();
      message.success("语音依赖安装完成，正在重新自检…");
      runEnvCheckRef.current();
    } catch (e) {
      message.error(`一键安装失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setInstalling(false);
    }
  };

  const runSpeakTest = async () => {
    setTesting(true);
    setVoiceState(null);
    setVoiceError(null);
    try {
      await api.ttsSpeakTest();
      // 首次合成要等模型加载（10~90s），状态由 notifyVoice 事件驱动
    } catch (e) {
      setTesting(false);
      message.error(`试听失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const onStopService = async () => {
    try {
      const stopped = await api.ttsStopVoiceService();
      setServiceRunning(false);
      setVoiceState(null);
      setVoiceError(null);
      message.success(
        stopped ? "已停止语音服务，模型占用的内存已释放" : "语音服务未在运行",
      );
    } catch (e) {
      message.error(`停止失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const statusText =
    voiceError != null
      ? `失败：${voiceError}`
      : voiceState === "generating"
        ? "正在生成语音…（首次需加载模型，可能 1~2 分钟）"
        : voiceState === "playing"
          ? "正在播放…"
          : voiceState === "done"
            ? "播报完成"
            : null;

  const envRow = (ok: boolean, label: string, hint: string, err: string | null) => (
    <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
      <Text type={ok ? "success" : "danger"}>{ok ? "✓" : "✗"}</Text>
      <Text type="secondary">
        {label}：{ok ? hint : (err ?? hint)}
      </Text>
    </div>
  );

  // 安装命令里含 --index-url 即 CUDA 版 torch（Rust 侧按 nvidia-smi 探测结果生成）
  const hasNvidia = env?.torchInstallCmd?.includes("download.pytorch.org") ?? false;

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <p className="settings-desc">
        通知朗读与长文本合成共用这套配置：Python 解释器需已安装 torch / transformers 等
        Audio8 依赖；有 NVIDIA 显卡时自动用 GPU（CUDA 版 torch），否则走 CPU。
      </p>
      <div>
        <p className="settings-desc">Python 解释器（命令名或 venv 绝对路径）：</p>
        <Input
          size="small"
          value={pythonDraft}
          placeholder='例如 python / py，或 venv 绝对路径 "D:\\path\\.venv\\Scripts\\python.exe"'
          onChange={(e) => setPythonDraft(e.target.value)}
          onBlur={() => commitVoice({ pythonCmd: pythonDraft.trim() || "python" })}
          onPressEnter={() => commitVoice({ pythonCmd: pythonDraft.trim() || "python" })}
        />
      </div>
      <div>
        <p className="settings-desc">Audio8_TTS 仓库目录（含 audio8_tts_infer.py / audio8_tts_data.py）：</p>
        <Input
          size="small"
          value={repoDraft}
          placeholder="例如 D:\\workspace\\custom\\Audio8_TTS"
          onChange={(e) => setRepoDraft(e.target.value)}
          onBlur={() => commitVoice({ repoDir: repoDraft.trim() })}
          onPressEnter={() => commitVoice({ repoDir: repoDraft.trim() })}
        />
      </div>
      <div>
        <p className="settings-desc">模型 checkpoint 目录（完整下载，含 config.json / tokenizer / codec.pth）：</p>
        <Input
          size="small"
          value={modelDraft}
          placeholder="例如 D:\\workspace\\custom\\Audio8-TTS-Preview-0.1b"
          onChange={(e) => setModelDraft(e.target.value)}
          onBlur={() => commitVoice({ modelDir: modelDraft.trim() })}
          onPressEnter={() => commitVoice({ modelDir: modelDraft.trim() })}
        />
      </div>
      <Space wrap>
        <Button size="small" loading={checking} onClick={runEnvCheck}>
          环境自检
        </Button>
        <Button
          size="small"
          type="primary"
          ghost
          loading={testing}
          disabled={!voice.pythonCmd || !voice.repoDir || !voice.modelDir}
          onClick={runSpeakTest}
        >
          试听
        </Button>
        <Button size="small" danger ghost disabled={!serviceRunning} onClick={onStopService}>
          停止服务
        </Button>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {serviceRunning
            ? "模型驻留内存中（空闲 10 分钟自动退出），可点「停止服务」立即释放"
            : "服务未运行：合成/试听时按需启动"}
        </Text>
      </Space>
      {env && (
        <div style={{ display: "grid", gap: 2 }}>
          {envRow(env.pythonVersion != null, "Python", env.pythonVersion ?? "", env.pythonError)}
          {envRow(env.repoOk, "Audio8 仓库", env.repoHint, null)}
          {envRow(env.modelOk, "模型目录", env.modelHint, null)}
          {envRow(env.codecOk, "codec 权重", env.codecHint, null)}
          {envRow(env.torchOk, "torch", env.torchInfo ?? "", env.torchError)}
        </div>
      )}
      {env && !env.torchOk && env.torchInstallCmd && (
        <div style={{ display: "grid", gap: 6 }}>
          <Text type="secondary">
            torch 依赖缺失或损坏。已按你的机器（
            {hasNvidia ? "检测到 NVIDIA 显卡，安装 CUDA 版 torch" : "无 NVIDIA 显卡，安装 CPU 版 torch"}
            ，中文系统走华为云 PyPI 镜像）生成完整安装命令，可直接复制到终端执行，或一键安装：
          </Text>
          <Text code copyable style={{ wordBreak: "break-all" }}>
            {env.torchInstallCmd}
          </Text>
          <Space wrap>
            <Button size="small" type="primary" loading={installing} onClick={runInstall}>
              一键安装依赖
            </Button>
            {installing && <Text type="secondary">下载量较大，可能持续数十分钟，请保持网络畅通</Text>}
          </Space>
          {installTail.length > 0 && (
            <pre
              style={{
                margin: 0,
                maxHeight: 120,
                overflow: "auto",
                fontSize: 12,
                lineHeight: 1.5,
                background: "var(--bg-2, rgba(128,128,128,0.08))",
                borderRadius: 6,
                padding: "6px 8px",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}
            >
              {installTail.slice(-40).join("\n")}
            </pre>
          )}
        </div>
      )}
      {statusText && <p className="settings-desc">{statusText}</p>}
      <SynthParams voice={voice} commitVoice={commitVoice} />
      <Collapse
        size="small"
        ghost
        items={[
          {
            key: "guide",
            label: "首次使用引导（克隆仓库 / 安装依赖 / 下载模型）",
            children: (
              <div style={{ display: "grid", gap: 8 }}>
                <Text type="secondary">1. 克隆 Audio8 TTS 仓库：</Text>
                <Text code copyable>
                  git clone https://github.com/Audio8-AI/Audio8_TTS.git
                </Text>
                <Text type="secondary">
                  2. 安装 Python 3.10+ 并创建虚拟环境（推荐 .venv），安装依赖：
                </Text>
                <Text code copyable>
                  python -m venv .venv && .venv/Scripts/pip install -r requirements.txt
                </Text>
                <Text type="secondary">
                  有 NVIDIA 显卡想走 GPU 的话，再装 CUDA 版 torch（否则默认 CPU 版即可）：
                </Text>
                <Text code copyable>
                  .venv/Scripts/pip install torch --index-url
                  https://download.pytorch.org/whl/cu128
                </Text>
                <Text type="secondary">
                  3. 下载完整模型 checkpoint（0.1B 约 1.7GB，必须含 codec.pth）：
                </Text>
                <Text code copyable>
                  pip install "huggingface_hub[cli]"
                </Text>
                <Text code copyable>
                  hf download Audio8/Audio8-TTS-Preview-0.1b --local-dir
                  D:\Audio8-TTS-Preview-0.1b
                </Text>
                <Text type="secondary">
                  国内网络可加环境变量 HF_ENDPOINT=https://hf-mirror.com 加速。
                </Text>
                <Text type="secondary">
                  4. 回到这里填写 Python 命令 / 仓库目录 / 模型目录，点「环境自检」确认
                  全绿，再点「试听」。
                </Text>
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}

/**
 * 合成参数区块：对通知朗读与长文本合成同时生效。数值改动即时提交并同步 Rust，
 * 越界中间值交给 Rust 校验拦下（保持旧值），失焦时 antd 按 min/max 自动纠正；
 * 贪心模式下 temperature/top_p/top_k/seed 不参与解码（worker 端不下发），输入禁用。
 */
function SynthParams({
  voice,
  commitVoice,
}: {
  voice: VoiceConfig;
  commitVoice: (patch: Partial<VoiceConfig>) => void;
}) {
  const field = (label: string, node: ReactNode) => (
    <div>
      <p className="settings-desc">{label}</p>
      {node}
    </div>
  );
  return (
    <div
      style={{
        display: "grid",
        gap: 8,
        borderTop: "1px solid rgba(128,128,128,0.25)",
        paddingTop: 10,
      }}
    >
      <Space wrap align="center">
        <Text strong>合成参数</Text>
        <Button size="small" type="text" onClick={() => commitVoice({ ...VOICE_SYNTH_DEFAULTS })}>
          恢复默认
        </Button>
        <Text type="secondary" style={{ fontSize: 12 }}>
          即时生效（无需重启语音服务）；同一文本不同参数分别缓存
        </Text>
      </Space>
      <Space wrap align="center">
        <Text type="secondary" style={{ fontSize: 12 }}>采样模式：</Text>
        <Segmented
          size="small"
          value={voice.greedy ? "greedy" : "sample"}
          options={[
            { label: "采样合成", value: "sample" },
            { label: "贪心（最稳定）", value: "greedy" },
          ]}
          onChange={(v) => commitVoice({ greedy: v === "greedy" })}
        />
      </Space>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))",
          gap: 8,
        }}
      >
        {field(
          "temperature（随机性 0.05~2）：",
          <InputNumber
            size="small"
            style={{ width: "100%" }}
            min={0.05}
            max={2}
            step={0.05}
            value={voice.temperature}
            disabled={voice.greedy}
            onChange={(v) => v != null && commitVoice({ temperature: v })}
          />,
        )}
        {field(
          "top_p（核采样 0.05~1）：",
          <InputNumber
            size="small"
            style={{ width: "100%" }}
            min={0.05}
            max={1}
            step={0.05}
            value={voice.topP}
            disabled={voice.greedy}
            onChange={(v) => v != null && commitVoice({ topP: v })}
          />,
        )}
        {field(
          "top_k（候选数 0~200，0 不启用）：",
          <InputNumber
            size="small"
            style={{ width: "100%" }}
            min={0}
            max={200}
            step={1}
            precision={0}
            value={voice.topK}
            disabled={voice.greedy}
            onChange={(v) => v != null && commitVoice({ topK: v })}
          />,
        )}
        {field(
          "max_new_tokens（单段上限 64~8192）：",
          <InputNumber
            size="small"
            style={{ width: "100%" }}
            min={64}
            max={8192}
            step={64}
            precision={0}
            value={voice.maxNewTokens}
            onChange={(v) => v != null && commitVoice({ maxNewTokens: v })}
          />,
        )}
        {field(
          "seed（随机种子）：",
          <div style={{ display: "flex", gap: 6 }}>
            <InputNumber
              size="small"
              style={{ flex: 1, minWidth: 0 }}
              min={0}
              max={2147483647}
              step={1}
              precision={0}
              value={voice.seed}
              disabled={voice.greedy}
              onChange={(v) => v != null && commitVoice({ seed: v })}
            />
            <Button
              size="small"
              disabled={voice.greedy}
              onClick={() => commitVoice({ seed: Math.floor(Math.random() * 2 ** 31) })}
            >
              随机
            </Button>
          </div>,
        )}
      </div>
    </div>
  );
}
