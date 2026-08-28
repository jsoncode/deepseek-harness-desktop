import { BellOutlined } from "@ant-design/icons";
import { Switch } from "antd";
import { useNotifyStore } from "../../store/useNotifyStore";

/**
 * 通知管理（设置页区块）：原底部导航条 NotifyToggle 的完整形态——
 * 开关 + 说明文字，说明 dsh 会话事件通知的触发场景。
 */
export default function NotifySettings() {
  const mode = useNotifyStore((s) => s.mode);
  const toggle = useNotifyStore((s) => s.toggle);
  const on = mode === "on";

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
        </div>
      </div>
    </>
  );
}
