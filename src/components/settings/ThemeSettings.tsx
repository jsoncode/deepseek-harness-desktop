import { Segmented } from "antd";
import { AppstoreOutlined, DesktopOutlined, MoonOutlined, SunOutlined } from "@ant-design/icons";
import { useThemeStore, type ThemeMode } from "../../store/useThemeStore";

const OPTIONS: Array<{ label: string; value: ThemeMode; icon: React.ReactNode }> = [
  { label: "跟随宿主", value: "host", icon: <AppstoreOutlined style={{ fontSize: 13 }} /> },
  { label: "跟随系统", value: "system", icon: <DesktopOutlined style={{ fontSize: 13 }} /> },
  { label: "浅色", value: "light", icon: <SunOutlined style={{ fontSize: 13 }} /> },
  { label: "深色", value: "dark", icon: <MoonOutlined style={{ fontSize: 13 }} /> },
];

/**
 * 主题设置（设置页区块）：原底部导航条 ThemeSwitch 的完整形态——
 * 四种模式用 Segmented 平铺选择，避免下拉菜单在设置页内显得局促。
 */
export default function ThemeSettings() {
  const mode = useThemeStore((s) => s.mode);
  const setMode = useThemeStore((s) => s.setMode);

  return (
    <>
      <div className="settings-nav">
        <span className="settings-nav-title">主题设置</span>
      </div>
      <div className="settings-body">
        <div className="settings-card">
          <div className="settings-card-title">外观主题</div>
          <p className="settings-desc">
            选择应用的显示主题。跟随宿主：与应用内嵌的 dsh 网页保持同一明暗；
            跟随系统：随操作系统明暗自动切换；也可以手动固定为浅色或深色。
          </p>
          <Segmented
            block
            value={mode}
            onChange={(v) => setMode(v as ThemeMode)}
            options={OPTIONS.map((o) => ({
              value: o.value,
              label: (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  {o.icon}
                  {o.label}
                </span>
              ),
            }))}
          />
        </div>
      </div>
    </>
  );
}
