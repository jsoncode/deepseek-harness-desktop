import logo from "../assets/logo.svg";
import WindowControls from "./WindowControls";

/**
 * 语音合成工具独立窗口的标题栏：复用主窗口 .titlebar 的拖拽区与布局样式，
 * 无地址栏与页面入口（工具窗口自洽）。WindowControls 内部用 getCurrentWindow()，
 * 天然作用于本窗口（最小化/最大化/关闭，含 Windows 11 磁吸布局命中区）。
 */
export default function StudioTitleBar() {
  return (
    <header className="titlebar">
      <div className="titlebar-left">
        <img src={logo} alt="Harness" draggable={false} className="titlebar-logo" />
        <span className="titlebar-name">语音合成工具</span>
      </div>
      {/* 空的弹性中段：与主窗口标题栏同构，把窗口控制按钮推到最右侧 */}
      <div className="titlebar-center" />
      <div className="titlebar-right">
        <WindowControls />
      </div>
    </header>
  );
}
