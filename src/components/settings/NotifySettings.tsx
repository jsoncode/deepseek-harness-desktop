import { BellOutlined, ExperimentOutlined, SoundOutlined } from "@ant-design/icons";
import { Alert, App as AntApp, Button, Segmented, Switch, Typography } from "antd";
import { useNotifyStore } from "../../store/useNotifyStore";
import { api } from "../../lib/tauri";

const { Text } = Typography;

/**
 * 通知管理（设置页区块）：系统推送（总开关 + 消息样式）与语音播报。
 *
 * 文案原则：这里只讲「怎么用、有什么用」，不讲实现细节（音频链路、窗口架构、
 * 目录探测位置之类一律不写在界面上）。
 *
 * 交互原则：开关 / 分段控件只负责「改状态」，一律不做跳转；打开工具窗口只由
 * 底部按钮触发（未配置时额外给一个「去配置」按钮）。把打开窗口挂在切换控件上，
 * 会让「我想切个引擎」变成「凭空冒出个窗口」，交互上不可预期。
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

  // 打开引擎工具窗口：失败必须可见，避免用户觉得「点了没反应」。
  // 只有底部按钮和「去配置」会调用它——切换控件不碰。
  const openStudioWindow = (engine: "audio8" | "kokoro") => {
    const task = engine === "kokoro" ? api.ttsOpenKokoroStudio() : api.ttsOpenStudio();
    void task.catch((e: unknown) =>
      message.error(`打开工具窗口失败：${e instanceof Error ? e.message : String(e)}`),
    );
  };

  const isKokoro = voice.engine === "kokoro";
  const kokoroReady = !!voice.kokoroModelDir;

  return (
    <>
      <div className="settings-body">
        <div className="settings-card">
          <div className="settings-card-title">系统推送</div>
          <p className="settings-desc">会话有新进展时弹出系统通知。</p>

          <div className="settings-row">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <BellOutlined style={{ color: "var(--text-2)" }} />
              系统通知
            </span>
            <Switch checked={on} onChange={() => toggle()} />
          </div>

          <div className="settings-row">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <BellOutlined style={{ color: "var(--text-2)" }} />
              带按钮
              <Text type="secondary" style={{ fontSize: 12 }}>
                通知上带「打开对话」按钮，点击直达对应会话
              </Text>
            </span>
            <Switch
              checked={style === "clickable"}
              onChange={(v) => setStyle(v ? "clickable" : "plain")}
            />
          </div>

          <p className="settings-desc settings-desc-tail">
            全屏游戏或放映时自动静音弹窗，退出全屏后恢复。
          </p>
        </div>

        {/* 平台能力门控：Linux 无音频播放链路，整块换成说明而不是留一堆点了会失败的按钮 */}
        {!voiceSupported ? (
          <div className="settings-card">
            <div className="settings-card-title">语音播报</div>
            <Alert
              type="info"
              showIcon
              message="当前平台不支持语音播报"
              description="语音播报仅 Windows / macOS 提供，系统推送不受影响。"
            />
          </div>
        ) : (
          <div className="settings-card">
            <div className="settings-card-title">语音播报</div>
            <p className="settings-desc">通知触发时用本地模型朗读，推理完全在本机运行。</p>

            <div className="settings-row">
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <SoundOutlined style={{ color: "var(--text-2)" }} />
                语音播报
              </span>
              <Switch checked={voice.enabled} onChange={(v) => commitVoice({ enabled: v })} />
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
                // 只做切换，不附带任何跳转：引擎未配置时下方会给出「去配置」提示，
                // 打开工具窗口是底部按钮的职责（切换控件不应有副作用）
                onChange={(v) => commitVoice({ engine: v })}
              />
            </div>

            <p className="settings-desc settings-desc-tail">
              {isKokoro
                ? kokoroReady
                  ? "Kokoro 已就绪，音色与语速在工具窗口中调整。"
                  : "Kokoro 尚未配置模型，请先打开工具窗口完成配置。"
                : "Audio8 的音色与参数在工具窗口中调整。"}
            </p>

            {/* 仅在未配置时出现：一条待办式提示 + 单按钮 */}
            {isKokoro && !kokoroReady && (
              <div className="settings-row">
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  <ExperimentOutlined style={{ color: "#e6a23c" }} />
                  <Text style={{ fontSize: 12.5 }}>模型未配置</Text>
                </span>
                <Button size="small" type="primary" onClick={() => openStudioWindow("kokoro")}>
                  去配置
                </Button>
              </div>
            )}

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

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
              {/* 主按钮跟随当前引擎，避免误点进另一套配置 */}
              {isKokoro ? (
                <>
                  <Button
                    type="primary"
                    icon={<ExperimentOutlined />}
                    onClick={() => openStudioWindow("kokoro")}
                  >
                    打开 Kokoro 工具窗口
                  </Button>
                  <Button
                    ghost
                    icon={<SoundOutlined />}
                    onClick={() => openStudioWindow("audio8")}
                  >
                    Audio8 工具窗口
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    type="primary"
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
                    Kokoro 工具窗口
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
