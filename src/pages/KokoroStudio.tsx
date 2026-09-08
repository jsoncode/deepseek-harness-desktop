import { useNavigate } from "react-router";
import { Button } from "antd";
import { HistoryOutlined } from "@ant-design/icons";
import KokoroConfigPanel from "../components/voice/KokoroConfigPanel";
import TtsSynthWorkbench from "../components/voice/TtsSynthWorkbench";

/**
 * Kokoro 语音合成工具（独立窗口 /kokoro-studio）：与 Audio8 的 TtsStudio 完全
 * 同构（拷贝的 UI/交互，仅配置面板换成 Kokoro 字段）——上半是长文本合成工作台
 * （共享组件 TtsSynthWorkbench，合成走当前全局引擎）；下半是 Kokoro 配置面板
 * （模型/源码目录、音色、语速、环境自检、依赖安装、试听、停止服务）。页面挂在
 * 主前端 bundle 的 hash 路由下，主题、zustand 配置与主窗口共享；标题栏右侧
 * 提供「生成历史」页入口（/kokoro-studio/history，历史两引擎共用一份记录）。
 */
export default function KokoroStudio() {
  const navigate = useNavigate();
  return (
    <>
      <div className="settings-nav">
        <span className="settings-nav-title">Kokoro 语音合成工具</span>
        <div className="settings-nav-actions">
          <Button size="small" icon={<HistoryOutlined />} onClick={() => navigate("/kokoro-studio/history")}>
            生成历史
          </Button>
        </div>
      </div>
      <div className="settings-body">
        <TtsSynthWorkbench />

        <div className="settings-card">
          {/* 「Kokoro 配置」标题行（含「自动探测路径」按钮）由 KokoroConfigPanel 自渲染 */}
          <KokoroConfigPanel />
        </div>
      </div>
    </>
  );
}
