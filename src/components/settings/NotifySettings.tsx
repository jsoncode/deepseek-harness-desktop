import { BellOutlined, ExperimentOutlined, SoundOutlined } from "@ant-design/icons";
import { Alert, App as AntApp, Button, Segmented, Switch, Typography } from "antd";
import { useNotifyStore, type NotifyStyle } from "../../store/useNotifyStore";
import { api } from "../../lib/tauri";

const { Text } = Typography;

/**
 * 通知管理（设置页区块）：系统推送（总开关 + 消息样式）与语音播报入口。
 * 语音播报的配置集中在两个形态完全一致的独立工具窗口（人工 A/B 测试期间两个
 * 引擎共存）：Audio8 → 「语音合成工具」（/tts-studio，原始方案不动）；Kokoro →
 * 「Kokoro 语音合成工具」（/kokoro-studio，与 Audio8 窗口同构的拷贝版）。
 * 这里提供「合成引擎」切换与两个窗口入口，主按钮跟随当前引擎。
 */
export default function NotifySettings() {
  const { message } = AntApp.useApp();
  const mode = useNotifyStore((s) => s.mode);
  const toggle = useNotifyStore((s) => s.toggle);
  const style = useNotifyStore((s) => s.style);
  const setStyle = useNotifyStore((s) => s.setStyle);
  const voice = useNotifyStore((s) => s.voice);
  const setVoice = useNotifyStore((s) => s.setVoice);
  // 平台能力（Rust tts_supported 探测）：Linux 无音频播放链路，整块入口屏蔽
  const voiceSupported = useNotifyStore((s) => s.voiceSupported);
  const on = mode === "on";

  const commitVoice = (patch: Partial<typeof voice>) => setVoice(patch);

  // 打开引擎工具窗口：失败必须可见。此前各入口 .catch(() => undefined) 静默吞错，
  // 窗口创建失败（并发竞态/WebView2 异常）时用户只会觉得「点了没反应」。
  const openStudioWindow = (engine: "audio8" | "kokoro") => {
    const task = engine === "kokoro" ? api.ttsOpenKokoroStudio() : api.ttsOpenStudio();
    void task.catch((e: unknown) =>
      message.error(`打开工具窗口失败：${e instanceof Error ? e.message : String(e)}`),
    );
  };

  // 总开关打开前置校验按引擎各查各的：Audio8 缺仓库/模型路径 → 去工具窗口；
  // Kokoro 缺模型目录 → 打开 Kokoro 工具窗口（面板会自动探测回填模型路径）
  const onVoiceToggle = (checked: boolean) => {
    if (checked) {
      const missing =
        voice.engine === "kokoro"
          ? !voice.kokoroModelDir
          : !voice.repoDir || !voice.modelDir;
      if (missing) {
        // 跨窗口 storage 同步会保鲜本窗口的 voice 配置；走到这里说明确实还没配过：
        // 不落开关（保持 off），先带用户完成配置
        if (voice.engine === "kokoro") {
          openStudioWindow("kokoro");
        } else {
          openStudioWindow("audio8");
        }
        return;
      }
    }
    commitVoice({ enabled: checked });
  };

  return (
    <>
      <div className="settings-nav">
        <span className="settings-nav-title">通知管理</span>
      </div>
      <div className="settings-body">
        <div className="settings-card">
          <div className="settings-card-title">系统推送</div>
          <p className="settings-desc">
            dsh 会话事件（任务清单更新、对话结束等）发生时，是否弹出操作系统通知。
            关闭后事件仍会被记录，只是不再打扰你；开关状态会同步到后端推送线程。
          </p>
          <div className="settings-row">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <BellOutlined style={{ color: "var(--text-2)" }} />
              系统通知
            </span>
            <Switch checked={on} onChange={() => toggle()} />
          </div>
          <p className="settings-desc">
            消息样式决定通知的外观：可点击样式带「打开对话」按钮，点击直达对应会话的
            对话框；不可点击样式为原有外观，仅展示提醒。
          </p>
          <div className="settings-row">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <BellOutlined style={{ color: "var(--text-2)" }} />
              消息样式
            </span>
            <Segmented<NotifyStyle>
              options={[
                { label: "可点击", value: "clickable" },
                { label: "不可点击", value: "plain" },
              ]}
              value={style}
              onChange={(v) => setStyle(v)}
            />
          </div>
          <p className="settings-desc">
            <Text type="secondary" style={{ fontSize: 12 }}>
              游戏模式：前台运行全屏应用（游戏/放映）时自动暂停弹框推送，仅保留语音播报，
              退出全屏后恢复。
            </Text>
          </p>
        </div>

        {/* 平台能力门控（Rust tts_supported）：Linux 没有音频播放链路，
            整块入口换成说明而不是留一堆点了会失败的按钮 */}
        {!voiceSupported ? (
          <div className="settings-card">
            <div className="settings-card-title">语音播报</div>
            <Alert
              type="info"
              showIcon
              message="当前平台不支持语音播报"
              description={
                "语音播报依赖本机音频输出（rodio → cpal → ALSA），仅 Windows / macOS " +
                "安装包提供该链路，因此这里不展示配置入口；系统推送不受影响。"
              }
            />
          </div>
        ) : (
        <div className="settings-card">
          <div className="settings-card-title">语音播报</div>
          <p className="settings-desc">
            通知触发时用本地 TTS 模型朗读播报内容，推理完全在本机运行。合成引擎二选一：
            <b>Audio8</b>（0.1B，支持参考音频克隆音色，性能占用与延迟较高，配置在
            「语音合成工具」窗口）；<b>Kokoro</b>（82M，轻量低延迟，配置在
            「Kokoro 语音合成工具」窗口）。两个窗口形态与交互一致，配置互不影响，
            切换引擎即时生效，可 A/B 对比后决定去留。
          </p>
          <div className="settings-row">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <SoundOutlined style={{ color: "var(--text-2)" }} />
              语音播报
            </span>
            <Switch checked={voice.enabled} onChange={onVoiceToggle} />
          </div>
          <div className="settings-row">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <SoundOutlined style={{ color: "var(--text-2)" }} />
              合成引擎
            </span>
            <Segmented<"audio8" | "kokoro">
              options={[
                { label: "Audio8", value: "audio8" },
                { label: "Kokoro", value: "kokoro" },
              ]}
              value={voice.engine}
              onChange={(v) => {
                commitVoice({ engine: v });
                // 切到 Kokoro 且还没配模型目录：立刻打开 Kokoro 工具窗口（面板
                // 自动探测回填应用数据目录/常用位置的 Kokoro-82M），避免找不到入口
                if (v === "kokoro" && !voice.kokoroModelDir) {
                  openStudioWindow("kokoro");
                }
              }}
            />
          </div>
          {voice.engine === "kokoro" && !voice.kokoroModelDir && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 10px",
                borderRadius: 6,
                background: "rgba(230, 162, 60, 0.12)",
                border: "1px solid rgba(230, 162, 60, 0.45)",
              }}
            >
              <ExperimentOutlined style={{ color: "#e6a23c" }} />
              <Text style={{ fontSize: 12, flex: 1 }}>
                Kokoro 引擎待配置：点右侧按钮打开「Kokoro 语音合成工具」窗口，会自动探测
                已下载的模型（应用数据目录 / D:\code\owner\Kokoro-82M 等常用位置）。
              </Text>
              <Button
                size="small"
                type="primary"
                onClick={() => openStudioWindow("kokoro")}
              >
                配置 Kokoro
              </Button>
            </div>
          )}
          <p className="settings-desc">
            <Text type="secondary" style={{ fontSize: 12 }}>
              {voice.engine === "kokoro"
                ? voice.kokoroModelDir
                  ? "Kokoro 引擎已就绪：模型/音色/语速可在「Kokoro 语音合成工具」窗口调整。"
                  : "Kokoro 引擎尚未配置模型目录：点上方「配置 Kokoro」完成下载与自检后再启用播报。"
                : "Audio8 引擎：模型路径、音色克隆、采样参数与试听都在「语音合成工具」窗口，本次未做改动。"}
            </Text>
          </p>
          <div className="settings-row">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <SoundOutlined style={{ color: "var(--text-2)" }} />
              播报内容
            </span>
            <Segmented<"summary" | "title" | "desc">
              options={[
                { label: "标题+描述", value: "summary" },
                { label: "仅标题", value: "title" },
                { label: "仅描述", value: "desc" },
              ]}
              value={voice.speakContent}
              onChange={(v) => commitVoice({ speakContent: v })}
            />
          </div>
          <p className="settings-desc">
            <Text type="secondary" style={{ fontSize: 12 }}>
              首次使用、更换模型或排查环境问题，请打开对应引擎的工具窗口；在工具里点
              「停止服务」可随时释放模型占用的内存。
            </Text>
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {/* 主按钮跟随当前引擎：当前用哪个引擎，哪个配置窗口就是主按钮，
                避免误点进另一套配置（历史问题：Kokoro 入口是弱化 ghost 样式，
                用户点了视觉主按钮「打开语音合成工具」落进 Audio8 配置） */}
            {voice.engine === "kokoro" ? (
              <>
                <Button
                  type="primary"
                  icon={<ExperimentOutlined />}
                  onClick={() => openStudioWindow("kokoro")}
                >
                  Kokoro 语音合成工具（当前引擎）
                </Button>
                <Button
                  ghost
                  icon={<SoundOutlined />}
                  title="Audio8 引擎的完整配置窗口（长文本合成 / 音色克隆 / 历史导出）"
                  onClick={() => openStudioWindow("audio8")}
                >
                  Audio8 工具窗口
                </Button>
              </>
            ) : (
              <>
                <Button
                  type="primary"
                  ghost
                  icon={<SoundOutlined />}
                  onClick={() => openStudioWindow("audio8")}
                >
                  打开语音合成工具
                </Button>
                <Button
                  ghost
                  icon={<ExperimentOutlined />}
                  onClick={() => openStudioWindow("kokoro")}
                >
                  Kokoro 语音合成工具
                </Button>
              </>
            )}
          </div>
        </div>
        )}
      </div>
    </>
  );
}
