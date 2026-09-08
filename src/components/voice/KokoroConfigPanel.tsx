import { useEffect, useRef, useState, type ReactNode } from "react";
import { App as AntApp } from "antd";
import { Button, Collapse, Input, InputNumber, Select, Space, Typography } from "antd";
import { useNotifyStore } from "../../store/useNotifyStore";
import {
  api,
  EVENTS,
  onEvent,
  type KokoroVoiceMeta,
  type LogLine,
  type NotifyVoicePayload,
  type VoiceEnvReport,
} from "../../lib/tauri";

const { Text } = Typography;

/**
 * Kokoro 配置面板（Kokoro 语音合成工具窗口内）：与 Audio8 的 VoiceConfigPanel
 * 同构（独立拷贝、各自维护），字段顺序与按钮一一对应——Python 解释器、
 * 仓库目录（「一键克隆」kokoro 源码）、模型目录（「一键下载模型」）、音色
 * （voices/*.pt 列表）、合成参数、环境自检、依赖一键安装、试听与停止服务、
 * 首次使用引导。与 Audio8 面板的差异仅来自引擎能力：仓库是可选的源码目录
 * （留空 = pip 包，Audio8 的仓库是必需的推理代码），无参考音频克隆（音色由
 * 音色包决定），采样参数替换为语速。
 * 播报状态事件（EVENTS.notifyVoice）带 Rust 侧 worker 实时驻留标记（running），
 * 停止服务按钮据此保持新鲜；事件只在播报时来，另有 20s 轮询兜底。
 */
export default function KokoroConfigPanel() {
  const { message } = AntApp.useApp();
  const voice = useNotifyStore((s) => s.voice);
  const setVoice = useNotifyStore((s) => s.setVoice);

  // 路径类输入用本地草稿、失焦提交：避免每个按键都同步 Rust 与校验报错
  const [pythonDraft, setPythonDraft] = useState(voice.pythonCmd);
  const [modelDraft, setModelDraft] = useState(voice.kokoroModelDir);
  const [repoDraft, setRepoDraft] = useState(voice.kokoroRepoDir);

  const [env, setEnv] = useState<VoiceEnvReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [testing, setTesting] = useState(false);
  const [voiceState, setVoiceState] = useState<string | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installTail, setInstallTail] = useState<string[]>([]);
  const [serviceRunning, setServiceRunning] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [autoDetecting, setAutoDetecting] = useState(false);

  // Kokoro 音色列表（实时扫描模型目录 voices/*.pt）：模型目录变化即刷新。
  // 浏览器预览模式无 Tauri 运行时列表为空，下拉框只剩「默认」
  const [voices, setVoices] = useState<KokoroVoiceMeta[]>([]);
  const [loadingVoices, setLoadingVoices] = useState(false);

  // runEnvCheck 的 ref：安装/下载/探测结束事件回调里触发最新版本的自检
  const runEnvCheckRef = useRef<() => void>(() => {});

  // 打开窗口时模型目录为空则自动探测一次（应用数据目录 → 工作目录及父目录 →
  // exe 目录）；源码目录同样只在未填写时回填，均可手动修改/清空
  useEffect(() => {
    if (voice.kokoroModelDir.trim()) return;
    let cancelled = false;
    setAutoDetecting(true);
    api
      .ttsKokoroAutodetect()
      .then((res) => {
        if (cancelled) return;
        const patch: Partial<typeof voice> = {};
        if (res.modelDir) patch.kokoroModelDir = res.modelDir;
        if (res.repoDir && !voice.kokoroRepoDir.trim()) patch.kokoroRepoDir = res.repoDir;
        if (Object.keys(patch).length > 0) {
          setVoice(patch);
          message.success(
            res.modelDir
              ? `已自动填入检测到的模型目录：${res.modelDir}`
              : `已自动填入检测到的源码目录：${res.repoDir}`,
          );
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setAutoDetecting(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 语音播报状态事件：generating / playing / done / error（见 tts.rs emit_voice）。
  // 事件负载带 Rust 侧 worker 实时驻留状态（running）：命中缓存直接播放时不启
  // worker，不能凭「有播报事件」就认定服务在运行
  useEffect(() => {
    let unbind: (() => void) | undefined;
    void onEvent<NotifyVoicePayload>(EVENTS.notifyVoice, (p) => {
      setVoiceState(p.state);
      setVoiceError(p.error);
      setServiceRunning(p.running);
      // skipped（播报被跳过）同样终止试听等待态，原因由 statusText 展示
      if (p.state === "done" || p.state === "error" || p.state === "skipped") setTesting(false);
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

  // 配置经跨窗口 storage 同步变化（主窗口总开关/引擎切换等）时，草稿输入框跟进
  useEffect(() => {
    setPythonDraft(voice.pythonCmd);
    setModelDraft(voice.kokoroModelDir);
    setRepoDraft(voice.kokoroRepoDir);
  }, [voice.pythonCmd, voice.kokoroModelDir, voice.kokoroRepoDir]);

  // 音色列表随模型目录刷新（扫描 voices/*.pt；目录未就绪返回空）
  useEffect(() => {
    if (!voice.kokoroModelDir.trim()) {
      setVoices([]);
      return;
    }
    let cancelled = false;
    setLoadingVoices(true);
    api
      .ttsKokoroVoices(voice.kokoroModelDir.trim())
      .then((list) => {
        if (!cancelled) setVoices(list);
      })
      .catch(() => {
        if (!cancelled) setVoices([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingVoices(false);
      });
    return () => {
      cancelled = true;
    };
  }, [voice.kokoroModelDir]);

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
      // kokoro / misaki[zh] 体量小（torch 已由 Audio8 装好），通常数分钟
      await api.ttsInstallKokoroDeps();
      message.success("Kokoro 依赖安装完成，正在重新自检…");
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
      // 状态由 notifyVoice 事件驱动；Kokoro 冷启动通常数秒内就绪
    } catch (e) {
      setTesting(false);
      message.error(`试听失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // 自动探测路径：模型/源码目录为空时按常用位置扫描并回填（对应 Audio8 面板
  // 的「自动配置路径」交互位）
  const runAutoDetect = async () => {
    if (autoDetecting) return;
    setAutoDetecting(true);
    try {
      const res = await api.ttsKokoroAutodetect();
      if (!res.modelDir && !res.repoDir) {
        message.info("常用位置没有检测到 Kokoro 模型：可点「一键下载模型」或手动填写目录路径");
        return;
      }
      const patch: Partial<typeof voice> = {};
      if (res.modelDir) patch.kokoroModelDir = res.modelDir;
      if (res.repoDir && !voice.kokoroRepoDir.trim()) patch.kokoroRepoDir = res.repoDir;
      setVoice(patch);
      message.success(
        res.modelDir ? `已填入模型目录：${res.modelDir}` : `已填入源码目录：${res.repoDir}`,
      );
      runEnvCheckRef.current();
    } catch (e) {
      message.error(`自动探测失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setAutoDetecting(false);
    }
  };

  // 一键下载模型：目标 = 模型输入框路径（留空则 app_data/tts/Kokoro-82M）；
  // ModelScope 优先、HF 回退，已存在且权重完整则跳过；完成回填输入框并重跑自检
  const runDownloadModel = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const res = await api.ttsDownloadKokoroModel(modelDraft.trim() || undefined);
      commitVoice({ kokoroModelDir: res.modelDir });
      if (res.skipped) {
        message.info("模型目录已存在且权重完整，无需重复下载");
      } else {
        message.success("Kokoro 模型下载完成，正在重新自检…");
      }
      runEnvCheckRef.current();
    } catch (e) {
      message.error(`一键下载模型失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDownloading(false);
    }
  };

  // 一键克隆仓库：目标 = 仓库输入框路径（留空则 app_data/tts/kokoro）；已存在
  // 跳过；完成回填输入框（草稿经 store 同步 useEffect 跟进）并重跑自检。
  // 与 Audio8 面板的「一键克隆」交互一致；克隆的源码对引擎是可选的（留空 = pip 包）
  const runCloneRepo = async () => {
    if (cloning) return;
    setCloning(true);
    try {
      const res = await api.ttsCloneKokoroRepo(repoDraft.trim() || undefined);
      commitVoice({ kokoroRepoDir: res.repoDir });
      if (res.skipped) {
        message.info("仓库目录已存在，无需重复克隆");
      } else {
        message.success("kokoro 源码仓库克隆完成，正在重新自检…");
        runEnvCheckRef.current();
      }
    } catch (e) {
      message.error(`一键克隆失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCloning(false);
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
    // skipped：通知到达但被跳过（总开关未开 / 路径无效 / 自检通知），原因在 error 字段。
    // 必须先于 voiceError 判断：skipped 的原因不等于「失败」
    voiceState === "skipped"
      ? `已跳过播报：${voiceError ?? "条件不满足"}`
      : voiceError != null
        ? `失败：${voiceError}`
        : voiceState === "generating"
          ? "正在生成语音…（首次需加载模型，Kokoro 通常数秒内就绪）"
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

  return (
    <div style={{ display: "grid", gap: 10 }}>
      {/* 卡片标题行：标题后跟「自动探测路径」（一键拉齐模型与源码目录），与
          Audio8 面板的「自动配置路径」交互位对齐——标题由本面板渲染 */}
      <div className="settings-card-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span>Kokoro 配置</span>
        <Button
          size="small"
          type="dashed"
          loading={autoDetecting}
          disabled={downloading}
          onClick={runAutoDetect}
          title="在应用数据目录、工作目录及父目录、exe 目录等常用位置探测 Kokoro-82M 模型与源码目录并自动回填"
        >
          自动探测路径
        </Button>
      </div>
      <p className="settings-desc">
        通知朗读与长文本合成共用这套配置：Python 解释器需已安装 kokoro / misaki[zh]
        （可用「一键安装依赖」）；有 NVIDIA 显卡时自动用 GPU（CUDA 版 torch），否则走 CPU。
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
        <p className="settings-desc">
          kokoro 源码仓库目录（可选，含 kokoro/__init__.py；留空使用 pip 安装的 kokoro 包，
          两者等价，克隆只为跟踪上游 main；打开本窗口时会自动探测）：
        </p>
        <Space.Compact style={{ width: "100%" }}>
          <Input
            size="small"
            value={repoDraft}
            placeholder="留空 = pip 包；留空克隆则用应用数据目录 tts/kokoro，例如 D:\\code\\owner\\kokoro"
            onChange={(e) => setRepoDraft(e.target.value)}
            onBlur={() => commitVoice({ kokoroRepoDir: repoDraft.trim() })}
            onPressEnter={() => commitVoice({ kokoroRepoDir: repoDraft.trim() })}
          />
          <Button
            size="small"
            type="dashed"
            loading={cloning}
            disabled={autoDetecting}
            title="克隆 kokoro 源码仓库到上方路径（留空则用应用数据目录 tts/kokoro）；目录已存在则跳过"
            onClick={() => void runCloneRepo()}
          >
            一键克隆
          </Button>
        </Space.Compact>
      </div>
      <div>
        <p className="settings-desc">
          模型 checkpoint 目录（含 config.json / kokoro-v1_0.pth / voices；打开本窗口时会自动探测）：
        </p>
        <Space.Compact style={{ width: "100%" }}>
          <Input
            size="small"
            value={modelDraft}
            placeholder="留空默认 app_data/tts/Kokoro-82M，例如 D:\\code\\owner\\Kokoro-82M"
            onChange={(e) => setModelDraft(e.target.value)}
            onBlur={() => commitVoice({ kokoroModelDir: modelDraft.trim() })}
            onPressEnter={() => commitVoice({ kokoroModelDir: modelDraft.trim() })}
          />
          <Button
            size="small"
            type="dashed"
            loading={downloading}
            disabled={autoDetecting}
            title="git clone 模型到上方路径（留空则用应用数据目录 tts/Kokoro-82M）；目录已存在且权重完整则跳过"
            onClick={() => void runDownloadModel()}
          >
            一键下载模型
          </Button>
        </Space.Compact>
      </div>
      <div>
        <p className="settings-desc">
          音色：来自模型目录 voices 下的音色包（文件名即音色名，选哪个就稳定是哪个音色）；
          通知朗读与长文本合成共用。Kokoro 无参考音频克隆，音色由音色包决定
        </p>
        <Select
          size="small"
          style={{ width: "100%" }}
          placeholder={loadingVoices ? "扫描音色中…" : "先下载/填写模型目录"}
          value={voice.kokoroVoice}
          loading={loadingVoices}
          disabled={!voice.kokoroModelDir}
          onChange={(v) => commitVoice({ kokoroVoice: v })}
          options={[
            { label: "默认（优先 zf_xiaoxiao）", value: "" },
            ...voices.map((v) => ({ label: `${v.id}（${v.langLabel}）`, value: v.id })),
          ]}
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
          disabled={!voice.pythonCmd || !voice.kokoroModelDir}
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
          {envRow(env.kokoroPkgOk, "Kokoro 依赖", env.kokoroPkgInfo ?? "", env.kokoroPkgError)}
          {envRow(env.kokoroModelOk, "Kokoro 模型", env.kokoroModelHint, null)}
          {envRow(env.kokoroVoicesOk, "音色库", env.kokoroVoicesHint, null)}
          {envRow(env.kokoroRepoOk, "源码目录", env.kokoroRepoHint, null)}
          {envRow(env.torchOk, "torch", env.torchInfo ?? "", env.torchError)}
        </div>
      )}
      {env && !env.kokoroPkgOk && env.kokoroInstallCmd && (
        <div style={{ display: "grid", gap: 6 }}>
          <Text type="secondary">
            Kokoro 依赖（kokoro / misaki[zh]）缺失或损坏。完整安装命令如下（中文系统已带
            华为云 PyPI 镜像），可直接复制到终端执行，或一键安装：
          </Text>
          <Text code copyable style={{ wordBreak: "break-all" }}>
            {env.kokoroInstallCmd}
          </Text>
          <Space wrap>
            <Button size="small" type="primary" loading={installing} onClick={runInstall}>
              一键安装依赖
            </Button>
            {installing && <Text type="secondary">首次安装含 torch 等依赖，可能持续数十分钟</Text>}
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
      {voice.engine !== "kokoro" && (
        <Text type="warning" style={{ fontSize: 12 }}>
          当前合成引擎是 Audio8：上面的配置不会用于播报。要试听 Kokoro 请先在
          设置 → 通知管理 把引擎切到「Kokoro」。
        </Text>
      )}
      <KokoroParams voice={voice} commitVoice={commitVoice} />
      <Collapse
        size="small"
        ghost
        items={[
          {
            key: "guide",
            label: "首次使用引导（下载模型 / 安装依赖 / 换音色）",
            children: (
              <div style={{ display: "grid", gap: 8 }}>
                <Text type="secondary">1. 下载 Kokoro-82M 模型（约 330MB，含全部音色包）：</Text>
                <Text code copyable>
                  git clone https://www.modelscope.cn/AI-ModelScope/Kokoro-82M.git
                </Text>
                <Text type="secondary">
                  服务器需装有 git-lfs（缺 lfs 时 clone 出的 .pth 是文本指针）；「一键下载模型」
                  会在这种情况下自动执行 git lfs pull 补齐。手动克隆到任意位置也可以：
                  打开本窗口时会自动探测常用位置（应用数据目录、工作目录旁、各盘符下的
                  code 等开发目录）并回填，或直接把路径填进输入框。
                </Text>
                <Text type="secondary">2. 安装 Python 依赖（解释器复用 Audio8 那套即可）：</Text>
                <Text code copyable>
                  pip install "kokoro&gt;=0.9.4" soundfile "misaki[zh]"
                </Text>
                <Text type="secondary">
                  中文音色（zf_*/zm_*）必须装 misaki[zh]；英文音色的生词回退可选装 espeak-ng
                  （Windows 下载 x64.msi 安装），不装只影响个别生词发音。源码目录为可选项：
                  不填就用 pip 包，二者等价（pip 包即上游 main）。
                </Text>
                <Text type="secondary">
                  3. 回到这里点「环境自检」确认全绿，再点「试听」。当前引擎是 Kokoro 时，
                  通知播报与长文本合成都走 Kokoro；Audio8 的配置原样保留，随时切回。
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
 * Kokoro 参数区块：对通知朗读与长文本合成同时生效。与 Audio8 的采样参数区
 * 同构（同样的 borderTop 分区与「恢复默认」位置）；引擎能力差异：无温度/
 * top_p/top_k 等 AR 采样参数，仅语速（按请求下发，改值无需重启 worker）。
 */
function KokoroParams({
  voice,
  commitVoice,
}: {
  voice: import("../../lib/tauri").VoiceConfig;
  commitVoice: (patch: Partial<import("../../lib/tauri").VoiceConfig>) => void;
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
        <Button size="small" type="text" onClick={() => commitVoice({ kokoroSpeed: 1.0 })}>
          恢复默认
        </Button>
        <Text type="secondary" style={{ fontSize: 12 }}>
          即时生效（无需重启语音服务）；同一文本不同参数分别缓存
        </Text>
      </Space>
      <div style={{ display: "grid", gap: 10 }}>
        {field(
          "语速（0.5~2.0，1.0 原速；低于 1 放慢、高于 1 加快）：",
          <InputNumber
            size="small"
            style={{ width: "100%" }}
            min={0.5}
            max={2}
            step={0.05}
            value={voice.kokoroSpeed}
            onChange={(v) => v != null && commitVoice({ kokoroSpeed: v })}
          />,
        )}
      </div>
    </div>
  );
}
