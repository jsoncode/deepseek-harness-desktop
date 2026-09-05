import { BellOutlined, SoundOutlined } from "@ant-design/icons";
import { Button, Segmented, Switch, Typography } from "antd";
import { useNotifyStore, type NotifyStyle } from "../../store/useNotifyStore";
import { api } from "../../lib/tauri";

const { Text } = Typography;

/**
 * 通知管理（设置页区块）：系统推送（总开关 + 消息样式）与语音播报入口。
 * 语音播报的配置/试听/长文本合成已整体迁入独立工具窗口（/tts-studio，经
 * tts_open_studio 打开），这里只留总开关与播报内容两个高频项。
 */
export default function NotifySettings() {
  const mode = useNotifyStore((s) => s.mode);
  const toggle = useNotifyStore((s) => s.toggle);
  const style = useNotifyStore((s) => s.style);
  const setStyle = useNotifyStore((s) => s.setStyle);
  const voice = useNotifyStore((s) => s.voice);
  const setVoice = useNotifyStore((s) => s.setVoice);
  const on = mode === "on";

  const commitVoice = (patch: Partial<typeof voice>) => setVoice(patch);

  const onVoiceToggle = (checked: boolean) => {
    if (checked && (!voice.repoDir || !voice.modelDir)) {
      // 跨窗口 storage 同步会保鲜本窗口的 voice 配置；走到这里说明确实还没配过：
      // 不落开关（保持 off），直接带用户去工具窗口完成配置
      void api.ttsOpenStudio().catch(() => undefined);
      return;
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

        <div className="settings-card">
          <div className="settings-card-title">语音播报</div>
          <p className="settings-desc">
            通知触发时用本地 Audio8 TTS 模型（0.1B，开源）朗读播报内容，模型与推理
            完全在本机运行。路径配置、环境自检、试听与长文本合成导出都在
            「语音合成工具」窗口中完成。
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
              首次使用、更换模型或排查环境问题，请打开下方工具窗口；在工具里点「停止服务」
              可随时释放模型占用的内存。
            </Text>
          </p>
          <Button
            type="primary"
            ghost
            icon={<SoundOutlined />}
            onClick={() => void api.ttsOpenStudio().catch(() => undefined)}
          >
            打开语音合成工具
          </Button>
        </div>
      </div>
    </>
  );
}
