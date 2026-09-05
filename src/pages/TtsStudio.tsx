import { useNavigate } from "react-router";
import { Button } from "antd";
import { HistoryOutlined } from "@ant-design/icons";
import VoiceConfigPanel from "../components/voice/VoiceConfigPanel";
import TtsSynthWorkbench from "../components/voice/TtsSynthWorkbench";

/**
 * 语音合成工具（独立窗口 /tts-studio）：上半是长文本合成工作台（共享组件
 * TtsSynthWorkbench，主窗口「语音合成」弹框也复用它）；下半是语音配置面板
 * （环境自检、依赖安装、试听、停止服务）。页面挂在主前端 bundle 的 hash 路由下，
 * 主题、zustand 配置与主窗口共享；标题栏右侧提供「生成历史」页入口
 * （/tts-studio/history，记录所有生成过的语音，可播放/删除/打开文件夹）。
 */
export default function TtsStudio() {
  const navigate = useNavigate();
  return (
    <>
      <div className="settings-nav">
        <span className="settings-nav-title">语音合成工具</span>
        <div className="settings-nav-actions">
          <Button size="small" icon={<HistoryOutlined />} onClick={() => navigate("/tts-studio/history")}>
            生成历史
          </Button>
        </div>
      </div>
      <div className="settings-body">
        <TtsSynthWorkbench />

        <div className="settings-card">
          {/* 「语音配置」标题行（含「自动配置路径」按钮）由 VoiceConfigPanel 自渲染 */}
          <VoiceConfigPanel />
        </div>
      </div>
    </>
  );
}
