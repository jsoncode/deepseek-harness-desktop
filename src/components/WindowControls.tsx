import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import { CloseIcon, MaximizeIcon, MinusIcon, RestoreIcon } from "./icons";

export default function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
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
  }, []);

  const win = getCurrentWindow();

  return (
    <div className="window-controls">
      <button
        type="button"
        className="win-btn"
        title="最小化"
        aria-label="最小化"
        onClick={() => void win.minimize()}
      >
        <MinusIcon size={14} />
      </button>
      <button
        type="button"
        className="win-btn"
        title={maximized ? "还原" : "最大化"}
        aria-label={maximized ? "还原" : "最大化"}
        onClick={() => void win.toggleMaximize()}
      >
        {maximized ? <RestoreIcon size={14} /> : <MaximizeIcon size={14} />}
      </button>
      <button
        type="button"
        className="win-btn win-btn-close"
        title="关闭"
        aria-label="关闭"
        onClick={() => void win.close()}
      >
        <CloseIcon size={14} />
      </button>
    </div>
  );
}
