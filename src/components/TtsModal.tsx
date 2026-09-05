import { App as AntApp } from "antd";
import { Button, Space } from "antd";
import { ExportOutlined, HistoryOutlined } from "@ant-design/icons";
import AppModal from "./AppModal";
import TtsSynthWorkbench from "./voice/TtsSynthWorkbench";
import { api } from "../lib/tauri";

export interface TtsModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * 语音合成弹框（主窗口底部导航条左侧入口）：内嵌长文本合成工作台，可在不打断
 * 当前页面的情况下快速合成 / 试听 / 导出 WAV；页脚提供「生成历史」与「打开语音
 * 合成工具」跳转独立工具窗口（/tts-studio，含语音配置面板）。
 * 弹框关闭不卸载内容（AppModal 不销毁隐藏层）：后台合成继续，重开可见进度。
 */
export default function TtsModal({ open, onClose }: TtsModalProps) {
  const { message } = AntApp.useApp();

  // 跳转独立工具窗口（已开则聚焦并切页）；浏览器预览模式无 Tauri 运行时，给出提示
  const openStudio = async (section: "synth" | "history") => {
    try {
      await api.ttsOpenStudio(section);
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
          <Button icon={<ExportOutlined />} onClick={() => void openStudio("synth")}>
            打开语音合成工具
          </Button>
          <Button type="primary" onClick={onClose}>
            关闭
          </Button>
        </Space>
      }
    >
      <TtsSynthWorkbench compact />
    </AppModal>
  );
}
