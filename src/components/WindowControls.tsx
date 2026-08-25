import { Tooltip } from "antd";
import { BorderOutlined, CloseOutlined, MinusOutlined, SwitcherOutlined } from "@ant-design/icons";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import { tauri } from "../lib/tauri";

export default function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  // 浏览器预览（非 Tauri）时 getCurrentWindow 会读 undefined 的 __TAURI_INTERNALS__ 抛错，
  // 这里只在桌面运行时内取窗口句柄；预览模式下按钮渲染但点击无操作
  const win = tauri ? getCurrentWindow() : null;

  useEffect(() => {
    if (!win) return;
    let unlisten: (() => void) | undefined;
    let alive = true;

    const syncMaximized = () => {
      void win
        .isMaximized()
        .then((v) => {
          if (alive) setMaximized(v);
        })
        .catch(() => undefined);
    };

    syncMaximized();
    void win
      .onResized(syncMaximized)
      .then((fn) => {
        if (alive) unlisten = fn;
        else fn();
      })
      .catch(() => undefined);

    return () => {
      alive = false;
      unlisten?.();
    };
  }, [win]);

  return (
    <div className="window-controls">
      <Tooltip title="最小化">
        <button
          type="button"
          className="win-btn"
          aria-label="最小化"
          onClick={() => void win?.minimize()}
        >
          <MinusOutlined style={{ fontSize: 14 }} />
        </button>
      </Tooltip>
      {/* id="win-maximize"：Windows 11 上 snap-layout 插件在此处放置原生 HTMAXBUTTON 命中区，
          悬停触发系统磁吸布局预览，点击走原生最大化/还原；onClick 仅作为非 Windows 兜底 */}
      <Tooltip title={maximized ? "还原" : "最大化"}>
        <button
          type="button"
          id="win-maximize"
          className="win-btn"
          aria-label={maximized ? "还原" : "最大化"}
          onClick={() => void win?.toggleMaximize()}
        >
          {maximized ? (
            <SwitcherOutlined style={{ fontSize: 14 }} />
          ) : (
            <BorderOutlined style={{ fontSize: 14 }} />
          )}
        </button>
      </Tooltip>
      <Tooltip title="关闭">
        <button
          type="button"
          className="win-btn win-btn-close"
          aria-label="关闭"
          onClick={() => void win?.close()}
        >
          <CloseOutlined style={{ fontSize: 14 }} />
        </button>
      </Tooltip>
    </div>
  );
}
