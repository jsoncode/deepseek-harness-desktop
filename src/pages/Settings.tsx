import { AppstoreOutlined, BellOutlined, ClusterOutlined, InfoCircleOutlined } from "@ant-design/icons";
import { Menu } from "antd";
import { useState } from "react";
import PluginManagerPanel from "../components/PluginManagerPanel";
import AboutSettings from "../components/settings/AboutSettings";
import NotifySettings from "../components/settings/NotifySettings";
import ThemeSettings from "../components/settings/ThemeSettings";

type SectionKey = "plugins" | "notify" | "theme" | "about";

const MENU_ITEMS = [
  { key: "plugins", icon: <ClusterOutlined />, label: "插件管理" },
  { key: "notify", icon: <BellOutlined />, label: "通知管理" },
  { key: "theme", icon: <AppstoreOutlined />, label: "主题设置" },
  { key: "about", icon: <InfoCircleOutlined />, label: "关于本应用" },
];

/**
 * 设置页：左侧竖排 Menu 作为菜单区域，右侧为设置内容区。
 * 内容区由各区块自行渲染「固定顶部导航条（settings-nav）+ 可滚动内容（settings-body）」；
 * 插件管理等自管理滚动的内容使用 flush 容器（外层不滚动、内部自行滚动）。
 */
export default function Settings() {
  const [active, setActive] = useState<SectionKey>("plugins");

  return (
    <div className="page settings-page">
      <Menu
        className="settings-menu"
        mode="inline"
        selectedKeys={[active]}
        items={MENU_ITEMS}
        onClick={({ key }) => setActive(key as SectionKey)}
      />
      <div className="settings-main">
        {active === "plugins" ? <PluginManagerPanel /> : null}
        {active === "notify" ? <NotifySettings /> : null}
        {active === "theme" ? <ThemeSettings /> : null}
        {active === "about" ? <AboutSettings /> : null}
      </div>
    </div>
  );
}
