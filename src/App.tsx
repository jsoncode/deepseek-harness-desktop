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
import Launch from "./pages/Launch";
import Loading from "./pages/Loading";
import Preview from "./pages/Preview";
import Settings from "./pages/Settings";
import TtsStudio from "./pages/TtsStudio";
import { useThemeStore } from "./store/useThemeStore";
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

  // 订阅 Rust 侧投递过的推送消息（供前端通道消费，目前是语音留桩）；幂等，整个 App 生命周期只挂一次
  useEffect(() => {
    startNotifyListener();
  }, []);

  // 把实际主题同步到 <html> 的 data-theme 与 color-scheme（驱动 CSS 变量）
  // 用 useLayoutEffect：DOM 提交后、paint 前同步执行，避免首帧闪烁（浅色用户启动时先渲染深色）
  useLayoutEffect(() => {
    const el = document.documentElement;
    el.dataset.theme = effective;
    el.style.colorScheme = effective;
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
        <PluginFailureModal />
        <HashRouter>
          <Shell />
        </HashRouter>
      </AntApp>
    </ConfigProvider>
  );
}

/**
 * 壳层分流：主窗口壳（TitleBar + 内容区 + BottomBar + 主窗口级弹窗）与
 * 独立工具窗口壳（语音合成工具：StudioTitleBar + 页面，无底部导航与凭据/
 * 通知激活等主窗口专属弹窗）共用同一 bundle，经 hash 路由区分。
 */
function Shell() {
  const location = useLocation();
  // 全局刷新纪元：刷新按钮自增，作为内容区 key 使当前页面（启动页/终端页/服务预览页）
  // 整体重挂载——任何页面都能被刷新，而不止服务预览页
  const reloadKey = useUiStore((s) => s.reloadKey);

  if (location.pathname.startsWith("/tts-studio")) {
    return (
      <div className="app-shell">
        <StudioTitleBar />
        <div className="app-content">
          <Routes>
            <Route path="/tts-studio" element={<TtsStudio />} />
            <Route path="*" element={<Navigate to="/tts-studio" replace />} />
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
      <div className="app-shell">
        <TitleBar />
        <div className="app-content" key={reloadKey}>
          <Routes>
            <Route path="/" element={<Launch />} />
            <Route path="/loading" element={<Loading />} />
            <Route path="/preview" element={<Preview />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
        {/* 底部导航条：flex 布局最后一个元素，占位且固定在窗口底部 */}
        <BottomBar />
      </div>
    </>
  );
}
