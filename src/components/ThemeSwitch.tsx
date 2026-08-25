import { Tooltip } from "antd";
import { DesktopOutlined, MoonOutlined, SunOutlined } from "@ant-design/icons";
import { Dropdown } from "antd";
import { useThemeStore } from "../store/useThemeStore";

export default function ThemeSwitch() {
  const mode = useThemeStore((s) => s.mode);
  const effective = useThemeStore((s) => s.effective);
  const setMode = useThemeStore((s) => s.setMode);

  return (
    <Dropdown
      trigger={["click"]}
      placement="bottomRight"
      menu={{
        selectable: true,
        selectedKeys: [mode],
        items: [
          { key: "system", label: "跟随系统", icon: <DesktopOutlined style={{ fontSize: 14 }} /> },
          { key: "light", label: "浅色", icon: <SunOutlined style={{ fontSize: 14 }} /> },
          { key: "dark", label: "深色", icon: <MoonOutlined style={{ fontSize: 14 }} /> },
        ],
        onClick: ({ key }) => {
          if (key === "system" || key === "light" || key === "dark") setMode(key);
        },
      }}
    >
      <Tooltip title="切换主题">
        <button type="button" className="icon-btn theme-switch" aria-label="切换主题">
          {mode === "system" ? (
            <DesktopOutlined style={{ fontSize: 15 }} />
          ) : effective === "dark" ? (
            <MoonOutlined style={{ fontSize: 15 }} />
          ) : (
            <SunOutlined style={{ fontSize: 15 }} />
          )}
        </button>
      </Tooltip>
    </Dropdown>
  );
}
