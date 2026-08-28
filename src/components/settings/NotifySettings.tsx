import { BellOutlined } from "@ant-design/icons";
import { Segmented, Switch } from "antd";
import { useNotifyStore, type NotifyStyle } from "../../store/useNotifyStore";

/**
 * 通知管理（设置页区块）：原底部导航条 NotifyToggle 的完整形态——
 * 总开关 + 消息样式（可点击/不可点击）切换，说明 dsh 会话事件通知的触发场景。
 */
export default function NotifySettings() {
  const mode = useNotifyStore((s) => s.mode);
  const toggle = useNotifyStore((s) => s.toggle);
  const style = useNotifyStore((s) => s.style);
  const setStyle = useNotifyStore((s) => s.setStyle);
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
        </div>
      </div>
    </>
  );
}
