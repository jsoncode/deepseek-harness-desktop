import {
  AppstoreOutlined,
  BellOutlined,
  ClusterOutlined,
  FileTextOutlined,
  InfoCircleOutlined,
} from "@ant-design/icons";
import { Menu } from "antd";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import PluginManagerPanel from "../components/PluginManagerPanel";
import AboutSettings from "../components/settings/AboutSettings";
import LogManagerSettings from "../components/settings/LogManagerSettings";
import NotifySettings from "../components/settings/NotifySettings";
import ThemeSettings from "../components/settings/ThemeSettings";

type SectionKey = "plugins" | "notify" | "theme" | "logs" | "about";

const SECTION_KEYS: SectionKey[] = ["plugins", "notify", "theme", "logs", "about"];

const MENU_ITEMS = [
  { key: "plugins", icon: <ClusterOutlined />, label: "插件管理" },
  { key: "notify", icon: <BellOutlined />, label: "通知管理" },
  { key: "theme", icon: <AppstoreOutlined />, label: "主题设置" },
  { key: "logs", icon: <FileTextOutlined />, label: "日志管理" },
  { key: "about", icon: <InfoCircleOutlined />, label: "关于本应用" },
];

/**
 * 设置页：左侧竖排 Menu 作为菜单区域，右侧为设置内容区。
 * 内容区由各区块自行渲染「固定顶部导航条（settings-nav）+ 可滚动内容（settings-body）」；
 * 插件管理等自管理滚动的内容使用 flush 容器（外层不滚动、内部自行滚动）。
 *
 * 支持通过 URL 查询参数 `section` 定位菜单（如 `#/settings?section=logs`），
 * 供标题栏版本号（关于本应用）与各处「查看日志」入口深链使用；菜单点击同步 URL（replace）。
 */
export default function Settings() {
  const [searchParams, setSearchParams] = useSearchParams();
  const param = searchParams.get("section") as SectionKey | null;
  const [active, setActive] = useState<SectionKey>(
    param && SECTION_KEYS.includes(param) ? param : "plugins",
  );

  // 外部 URL 变化（如再次从标题栏/启动页进入）时同步选中菜单
  useEffect(() => {
    if (param && SECTION_KEYS.includes(param) && param !== active) {
      setActive(param);
    }
  }, [param, active]);

  const onMenuClick = (key: SectionKey) => {
    setActive(key);
    // replace：不产生历史记录，避免返回键在设置页内来回跳动
    setSearchParams({ section: key }, { replace: true });
  };

  return (
    <div className="page settings-page">
      <Menu
        className="settings-menu"
        mode="inline"
        selectedKeys={[active]}
        items={MENU_ITEMS}
        onClick={({ key }) => onMenuClick(key as SectionKey)}
      />
      <div className="settings-main">
        {active === "plugins" ? <PluginManagerPanel /> : null}
        {active === "notify" ? <NotifySettings /> : null}
        {active === "theme" ? <ThemeSettings /> : null}
        {active === "logs" ? <LogManagerSettings /> : null}
        {active === "about" ? <AboutSettings /> : null}
      </div>
    </div>
  );
}
