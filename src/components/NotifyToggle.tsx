import { Tooltip } from "antd";
import { BellOutlined } from "@ant-design/icons";
import { useNotifyStore } from "../store/useNotifyStore";

/**
 * 系统推送开关（底部导航条）：控制 dsh 会话事件是否弹 Windows 通知。
 * 关闭态用 .off 半透明表达，与其它 icon 按钮同一套尺寸/悬停样式。
 */
export default function NotifyToggle() {
  const mode = useNotifyStore((s) => s.mode);
  const toggle = useNotifyStore((s) => s.toggle);
  const on = mode === "on";

  return (
    <Tooltip
      // 气泡朝右：底部导航条上方的页面内容不该被遮挡（与「切换主题」一致）
      title={on ? "系统推送：已开启（点击关闭）" : "系统推送：已关闭（点击开启）"}
      placement="right"
    >
      <button
        type="button"
        className={on ? "icon-btn" : "icon-btn off"}
        aria-label="系统推送开关"
        aria-pressed={on}
        onClick={toggle}
      >
        <BellOutlined style={{ fontSize: 15 }} />
      </button>
    </Tooltip>
  );
}
