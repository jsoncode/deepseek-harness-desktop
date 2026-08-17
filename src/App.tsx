import { App as AntApp, ConfigProvider, theme as antdTheme } from "antd";
import { HashRouter, Navigate, Route, Routes } from "react-router";
import Launch from "./pages/Launch";
import Preview from "./pages/Preview";
import Terminal from "./pages/Terminal";

export default function App() {
  return (
    <ConfigProvider
      theme={{
        algorithm: antdTheme.darkAlgorithm,
        token: {
          colorPrimary: "#6366f1",
          colorInfo: "#22d3ee",
          colorBgBase: "#07090d",
          colorTextBase: "#eef1f7",
          borderRadius: 10,
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
        },
      }}
    >
      <AntApp>
        <div className="app-bg" />
        <HashRouter>
          <Routes>
            <Route path="/" element={<Launch />} />
            <Route path="/terminal" element={<Terminal />} />
            <Route path="/preview" element={<Preview />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </HashRouter>
      </AntApp>
    </ConfigProvider>
  );
}
