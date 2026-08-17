import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { useAppStore } from "./store/useAppStore";
import "./styles/global.css";

// DEV 调试钩子：可通过 WebView2 CDP 读取/驱动应用状态
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__store = useAppStore;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
