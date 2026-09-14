import {
  ApiOutlined,
  AppstoreOutlined,
  BellOutlined,
  ClusterOutlined,
  FileTextOutlined,
  InfoCircleOutlined,
} from "@ant-design/icons";
import { Menu } from "antd";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import PluginManagerPanel from "../components/PluginManagerPanel";
import AboutSettings from "../components/settings/AboutSettings";
import LogManagerSettings from "../components/settings/LogManagerSettings";
import NotifySettings from "../components/settings/NotifySettings";
import ProxySettings from "../components/settings/ProxySettings";
import ThemeSettings from "../components/settings/ThemeSettings";
import { useAppStore } from "../store/useAppStore";
import { useUiStore } from "../store/useUiStore";

type SectionKey = "plugins" | "notify" | "theme" | "proxy" | "logs" | "about";

const SECTION_KEYS: SectionKey[] = ["plugins", "notify", "theme", "proxy", "logs", "about"];

/** 跨窗口设置意图的 localStorage 键（写入方：PluginManagerPanel 的自身包引流） */
const SETTINGS_INTENT_KEY = "dsh:settings-intent";

const MENU_ITEMS = [
  { key: "plugins", icon: <ClusterOutlined />, label: "插件管理" },
  { key: "notify", icon: <BellOutlined />, label: "通知管理" },
  { key: "theme", icon: <AppstoreOutlined />, label: "主题设置" },
  { key: "proxy", icon: <ApiOutlined />, label: "代理设置" },
  { key: "logs", icon: <FileTextOutlined />, label: "日志管理" },
  { key: "about", icon: <InfoCircleOutlined />, label: "关于本应用" },
];

/**
 * 设置页：左侧竖排 Menu 作为菜单区域，右侧为设置内容区。
 * 设置页**没有顶部标题栏**（settings-nav 只在独立工具窗口里用），各区块直接以
 * 可滚动内容（settings-body）开场；带操作的区块（插件管理、日志管理）把工具栏
 * 放进内容区顶部自行渲染。插件管理等自管理滚动的内容使用 flush 容器
 * （外层不滚动、内部自行滚动）。
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
  /** 已消费的跨窗口意图时间戳（storage 与 hash 两条通道去重） */
  const lastIntentTsRef = useRef(0);

  // 设置窗口兜底初始化：窗口经 ?section=xx 深链直开（如 ?section=about）时，默认
  // 分区「插件管理」不挂载、没人调 init，store 会一直停留在 phase=checking /
  // dshInstalled=false 的未初始化态——关于页的环境行永远「检测中」，依赖环境值
  // 的操作（如 dsh CLI 更新）也会因守卫静默失效。init 幂等（单次 app_status），
  // 已初始化时再调一次无害。
  useEffect(() => {
    const st = useAppStore.getState();
    if (!st.initialized) void st.init();
  }, []);

  // 外部 URL 变化（如再次从标题栏/启动页进入）时同步选中菜单
  useEffect(() => {
    if (param && SECTION_KEYS.includes(param) && param !== active) {
      setActive(param);
    }
  }, [param, active]);

  // 跨窗口意图：插件管理里搜到本应用自身时，会请求切到「关于本应用」并打开
  // dsh CLI 更新弹框。设置页已打开时 Rust 只聚焦窗口 + 改 hash——本窗口若不
  // 监听，插件管理那边点了「去更新 dsh CLI」会毫无反应。
  // 两条通道取其一即可：URL hash（Rust 侧 eval，路由监听会同步 active）与
  // localStorage（同源另一窗口广播）；按 ts 去重，避免同一意图在两条通道下重复处理。
  useEffect(() => {
    const apply = (section: string, action?: string, ts?: number) => {
      if (ts != null && ts <= lastIntentTsRef.current) return;
      if (ts != null) lastIntentTsRef.current = ts;
      if (SECTION_KEYS.includes(section as SectionKey)) setActive(section as SectionKey);
      if (action) useUiStore.getState().requestSettingsIntent(section, action);
    };

    const onStorage = (e: StorageEvent) => {
      if (e.key !== SETTINGS_INTENT_KEY || !e.newValue) return;
      try {
        const d = JSON.parse(e.newValue) as { section?: string; action?: string; ts?: number };
        if (d.section) apply(d.section, d.action, d.ts);
      } catch {
        /* 非法载荷忽略 */
      }
    };
    window.addEventListener("storage", onStorage);

    // URL 深链：Rust 打开/聚焦窗口时把 hash 改成 #/settings?section=about&action=dsh-update。
    // 这里主动读一次当前 hash（取 ?section=&action=），覆盖「窗口已存在 → 只改 hash」的场景。
    const readHash = () => {
      const hash = window.location.hash;
      const qi = hash.indexOf("?");
      if (qi < 0) return;
      const sp = new URLSearchParams(hash.slice(qi + 1));
      const section = sp.get("section");
      const action = sp.get("action");
      if (section) {
        apply(section, action ?? undefined, Date.now() + Math.random());
      }
    };
    readHash();
    window.addEventListener("hashchange", readHash);

    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("hashchange", readHash);
    };
  }, []);

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
        {active === "proxy" ? <ProxySettings /> : null}
        {active === "logs" ? <LogManagerSettings /> : null}
        {active === "about" ? <AboutSettings /> : null}
      </div>
    </div>
  );
}
