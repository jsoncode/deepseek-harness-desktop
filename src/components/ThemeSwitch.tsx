import { Dropdown } from "antd";
import { MoonIcon, SunIcon, SystemIcon } from "./icons";
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
          { key: "system", label: "跟随系统", icon: <SystemIcon size={14} /> },
          { key: "light", label: "浅色", icon: <SunIcon size={14} /> },
          { key: "dark", label: "深色", icon: <MoonIcon size={14} /> },
        ],
        onClick: ({ key }) => {
          if (key === "system" || key === "light" || key === "dark") setMode(key);
        },
      }}
    >
      <button type="button" className="icon-btn theme-switch" title="切换主题" aria-label="切换主题">
        {mode === "system" ? (
          <SystemIcon size={15} />
        ) : effective === "dark" ? (
          <MoonIcon size={15} />
        ) : (
          <SunIcon size={15} />
        )}
      </button>
    </Dropdown>
  );
}
