import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import { CloseIcon, MaximizeIcon, MinusIcon, RestoreIcon } from "./icons";
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
      <button
        type="button"
        className="win-btn"
        title="最小化"
        aria-label="最小化"
        onClick={() => void win?.minimize()}
      >
        <MinusIcon size={14} />
      </button>
      <button
        type="button"
        className="win-btn"
        title={maximized ? "还原" : "最大化"}
        aria-label={maximized ? "还原" : "最大化"}
        onClick={() => void win?.toggleMaximize()}
      >
        {maximized ? <RestoreIcon size={14} /> : <MaximizeIcon size={14} />}
      </button>
      <button
        type="button"
        className="win-btn win-btn-close"
        title="关闭"
        aria-label="关闭"
        onClick={() => void win?.close()}
      >
        <CloseIcon size={14} />
      </button>
    </div>
  );
}
