import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 期望固定的 dev server 端口，strictPort 保证 6089（dev UI；服务端口为 6088）
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 6089,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes("node_modules/react") || id.includes("node_modules/react-router")) {
            return "react";
          }
          if (id.includes("node_modules/antd")) {
            return "antd";
          }
          if (id.includes("node_modules/@tauri-apps")) {
            return "tauri";
          }
          return undefined;
        },
      },
    },
  },
});
