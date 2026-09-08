import logo from "../assets/logo.svg";
import WindowControls from "./WindowControls";

/**
 * 独立工具窗口（语音合成 / Kokoro 语音合成 / 设置）的标题栏：复用主窗口 .titlebar
 * 的拖拽区与布局样式，无地址栏与页面入口（工具窗口自洽）。title 由各窗口壳传入。
 * WindowControls 内部用 getCurrentWindow()，天然作用于本窗口（最小化/最大化/关闭，
 * 含 Windows 11 磁吸布局命中区）。
 */
export default function StudioTitleBar({ title = "语音合成工具" }: { title?: string }) {
  return (
    <header className="titlebar">
      <div className="titlebar-left">
        <img src={logo} alt="Harness" draggable={false} className="titlebar-logo" />
        <span className="titlebar-name">{title}</span>
      </div>
      {/* 空的弹性中段：与主窗口标题栏同构，把窗口控制按钮推到最右侧 */}
      <div className="titlebar-center" />
      <div className="titlebar-right">
        <WindowControls />
      </div>
    </header>
  );
}
