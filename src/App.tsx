import { App as AntApp, ConfigProvider, theme as antdTheme } from "antd";
import { useEffect, useLayoutEffect } from "react";
import { HashRouter, Navigate, Route, Routes, useLocation } from "react-router";
import { useUiStore } from "./store/useUiStore";
import BottomBar from "./components/BottomBar";
import CredentialsFixModal from "./components/CredentialsFixModal";
import NotifyActivateHandler from "./components/NotifyActivateHandler";
import PluginFailureModal from "./components/PluginFailureModal";
import StudioTitleBar from "./components/StudioTitleBar";
import TitleBar from "./components/TitleBar";
import Loading from "./pages/Loading";
import Preview from "./pages/Preview";
import Settings from "./pages/Settings";
import TtsStudio from "./pages/TtsStudio";
import TtsHistory from "./pages/TtsHistory";
import { useThemeStore, EFFECTIVE_STORAGE_KEY } from "./store/useThemeStore";
import { initNotifySync } from "./store/useNotifyStore";
import { startNotifyListener } from "./lib/notify";

const FONT_FAMILY =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';

const DARK_TOKENS = {
  colorPrimary: "#6366f1",
  colorInfo: "#22d3ee",
  colorBgBase: "#07090d",
  colorTextBase: "#eef1f7",
  borderRadius: 10,
  fontFamily: FONT_FAMILY,
};

const LIGHT_TOKENS = {
  colorPrimary: "#6366f1",
  colorInfo: "#0891b2",
  colorBgBase: "#f6f7fb",
  colorTextBase: "#1c2129",
  borderRadius: 10,
  fontFamily: FONT_FAMILY,
};

export default function App() {
  const effective = useThemeStore((s) => s.effective);
  const initTheme = useThemeStore((s) => s.init);

  useEffect(() => {
    initTheme();
  }, [initTheme]);

  // 移除 index.html 里的内联启动画面：effect 在 React 提交后执行，此时真实界面已
  // 挂到 DOM，拆掉覆盖层不会闪出空白帧（bundle 加载期间它挡着白屏）
  useEffect(() => {
    document.getElementById("boot")?.remove();
  }, []);

  // 订阅 Rust 侧投递过的推送消息（供前端通道消费，目前是语音留桩）；幂等，整个 App 生命周期只挂一次
  useEffect(() => {
    startNotifyListener();
    // 启动即把推送开关/样式/语音配置回灌 Rust（幂等）：历史上回灌只发生在
    // 「打开过设置页/语音工具窗口」时——重启后 Rust 侧语音配置停留在默认
    // （enabled=false），通知语音被静默跳过。根因修复，见 initNotifySync 注释。
    initNotifySync();
  }, []);

  // 把实际主题同步到 <html> 的 data-theme 与 color-scheme（驱动 CSS 变量）
  // 用 useLayoutEffect：DOM 提交后、paint 前同步执行，避免首帧闪烁（浅色用户启动时先渲染深色）
  useLayoutEffect(() => {
    const el = document.documentElement;
    el.dataset.theme = effective;
    el.style.colorScheme = effective;
    // 写入跨窗口生效主题键：storage 事件不回送写入方，设置/语音合成等窗口经此
    // 跟随真实生效主题——含 host 模式（宿主主题只到达主窗口）
    try {
      localStorage.setItem(EFFECTIVE_STORAGE_KEY, effective);
    } catch {
      /* ignore */
    }
  }, [effective]);

  return (
    <ConfigProvider
      theme={{
        algorithm:
          effective === "dark"
            ? antdTheme.darkAlgorithm
            : antdTheme.defaultAlgorithm,
        token: effective === "dark" ? DARK_TOKENS : LIGHT_TOKENS,
      }}
    >
      <AntApp>
        <div className="app-bg" />
        <HashRouter>
          <Shell />
        </HashRouter>
      </AntApp>
    </ConfigProvider>
  );
}

/**
 * 壳层分流：主窗口壳（TitleBar + 内容区 + BottomBar + 主窗口级弹窗）与
 * 独立工具窗口壳（语音合成工具/设置：StudioTitleBar + 页面，无底部导航与凭据/
 * 通知激活等主窗口专属弹窗）共用同一 bundle，经 hash 路由区分。
 */
function Shell() {
  const location = useLocation();
  // 全局刷新纪元：刷新按钮自增，作为内容区 key 使当前页面（状态页/终端页/服务预览页）
  // 整体重挂载——任何页面都能被刷新，而不止服务预览页
  const reloadKey = useUiStore((s) => s.reloadKey);

  if (location.pathname.startsWith("/tts-studio")) {
    return (
      <div className="app-shell">
        <StudioTitleBar />
        <div className="app-content">
          <Routes>
            <Route path="/tts-studio" element={<TtsStudio />} />
            <Route path="/tts-studio/history" element={<TtsHistory />} />
            <Route path="*" element={<Navigate to="/tts-studio" replace />} />
          </Routes>
        </div>
      </div>
    );
  }

  // 设置独立窗口壳：桌面端由 Rust open_settings 命令创建（index.html#/settings），
  // 主窗口不再内嵌设置页；浏览器预览模式下入口回退 navigate 时也走此壳
  if (location.pathname.startsWith("/settings")) {
    return (
      <div className="app-shell">
        <StudioTitleBar title="设置" />
        <div className="app-content">
          <Routes>
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/settings" replace />} />
          </Routes>
        </div>
      </div>
    );
  }

  return (
    <>
      <CredentialsFixModal />
      {/* 系统通知点击：切预览页 + 暂存待打开会话（见组件注释） */}
      <NotifyActivateHandler />
      {/* 插件加载失败弹框：需在 Router 内（弹框前要按当前路由离开预览页） */}
      <PluginFailureModal />
      <div className="app-shell">
        <TitleBar />
        <div className="app-content" key={reloadKey}>
          <Routes>
            {/* 启动检查页已移除：根路径直接进服务状态页（自动检测环境并启动），
                旧「/」入口（含通配兜底）一律重定向到 /loading */}
            <Route path="/" element={<Navigate to="/loading" replace />} />
            <Route path="/loading" element={<Loading />} />
            <Route path="/preview" element={<Preview />} />
            <Route path="*" element={<Navigate to="/loading" replace />} />
          </Routes>
        </div>
        {/* 底部导航条：flex 布局最后一个元素，占位且固定在窗口底部 */}
        <BottomBar />
      </div>
    </>
  );
}
