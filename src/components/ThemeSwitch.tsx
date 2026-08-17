import { Dropdown } from "antd";
import { MoonIcon, SunIcon, SystemIcon } from "./icons";
import { useThemeStore, type ThemeMode } from "../store/useThemeStore";

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
          { key: "system", label: "跟随系统", icon: <SystemIcon size={14} /> },
          { key: "light", label: "浅色", icon: <SunIcon size={14} /> },
          { key: "dark", label: "深色", icon: <MoonIcon size={14} /> },
        ],
        onClick: ({ key }) => setMode(key as ThemeMode),
      }}
    >
      <button type="button" className="icon-btn theme-switch" title="切换主题">
        {effective === "dark" ? <MoonIcon size={15} /> : <SunIcon size={15} />}
      </button>
    </Dropdown>
  );
}
