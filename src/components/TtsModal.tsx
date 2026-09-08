import { App as AntApp } from "antd";
import { Alert, Button, Space } from "antd";
import { ExportOutlined, ExperimentOutlined, HistoryOutlined } from "@ant-design/icons";
import AppModal from "./AppModal";
import TtsSynthWorkbench from "./voice/TtsSynthWorkbench";
import { api } from "../lib/tauri";
import { useNotifyStore } from "../store/useNotifyStore";

export interface TtsModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * 语音合成弹框（主窗口底部导航条左侧入口）：内嵌长文本合成工作台，可在不打断
 * 当前页面的情况下快速合成 / 试听 / 导出 WAV；页脚提供「生成历史」与引擎工具
 * 窗口跳转（Audio8 → /tts-studio；当前引擎是 Kokoro 时直达 /kokoro-studio，
 * 两窗口形态一致、配置互不影响）。
 * 弹框关闭不卸载内容（AppModal 不销毁隐藏层）：后台合成继续，重开可见进度。
 * 当前引擎是 Kokoro 时顶部给出引擎提示（Kokoro 的配置在其独立工具窗口，避免
 * 用户误以为本窗口的 Audio8 面板是唯一配置入口）；Audio8 引擎下保持原样。
 */
export default function TtsModal({ open, onClose }: TtsModalProps) {
  const { message } = AntApp.useApp();
  const engine = useNotifyStore((s) => s.voice.engine);
  const kokoroReady = useNotifyStore((s) => !!s.voice.kokoroModelDir);

  // 跳转独立工具窗口（已开则聚焦并切页）；浏览器预览模式无 Tauri 运行时，给出提示
  const openStudio = async (section: "synth" | "history") => {
    try {
      await api.ttsOpenStudio(section);
      onClose();
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    }
  };

  const openKokoroStudio = async () => {
    try {
      await api.ttsOpenKokoroStudio();
      onClose();
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <AppModal
      title="语音合成"
      open={open}
      onCancel={onClose}
      width={640}
      centered
      footer={
        <Space wrap>
          <Button icon={<HistoryOutlined />} onClick={() => void openStudio("history")}>
            生成历史
          </Button>
          {engine === "kokoro" ? (
            <Button type="primary" icon={<ExperimentOutlined />} onClick={() => void openKokoroStudio()}>
              Kokoro 工具窗口（当前引擎）
            </Button>
          ) : (
            <Button icon={<ExportOutlined />} onClick={() => void openStudio("synth")}>
              打开语音合成工具
            </Button>
          )}
          <Button type="primary" onClick={onClose}>
            关闭
          </Button>
        </Space>
      }
    >
      {engine === "kokoro" && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 10 }}
          message="当前合成引擎：Kokoro（轻量）"
          description={
            kokoroReady
              ? "本窗口的合成/试听同样走 Kokoro；模型/音色/语速在「Kokoro 语音合成工具」窗口调整（与 Audio8 的工具窗口同形态）。"
              : "尚未配置 Kokoro 模型目录，合成会失败：点下方「Kokoro 工具窗口」完成配置（面板会自动探测已下载的模型）。"
          }
        />
      )}
      <TtsSynthWorkbench compact />
    </AppModal>
  );
}
