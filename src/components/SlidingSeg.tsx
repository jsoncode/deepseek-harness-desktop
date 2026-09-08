import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * 滑块式分段选择：active 指示块在选项之间平滑穿梭滑动（替代变色胶囊）。
 * 测量目标按钮 offsetLeft/offsetWidth 驱动 thumb 位移；窗口尺寸变化时自动校正。
 * （插件管理面板与日志管理共用；样式见 global.css 的 .pm-seg 系列）
 */
export default function SlidingSeg<T extends string>({
  value,
  options,
  onChange,
  getDisabled,
  getTitle,
  className = "",
}: {
  value: T;
  options: Array<{ key: T; label: ReactNode }>;
  onChange: (key: T) => void;
  getDisabled?: (key: T) => boolean;
  getTitle?: (key: T) => string | undefined;
  className?: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ left: number; width: number }>({ left: 0, width: 0 });

  const measure = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const el = wrap.querySelector<HTMLButtonElement>('button[data-seg="' + value + '"]');
    if (!el) return;
    setThumb({ left: el.offsetLeft, width: el.offsetWidth });
  }, [value]);

  // 值变化后先测量再绘制，避免 thumb 初始闪到原点
  useLayoutEffect(() => {
    measure();
  }, [measure]);

  // 选项文案变化（如「所有插件(N)」数量增减）或窗口尺寸变化都会改变按钮宽度，
  // 用 ResizeObserver 监听容器尺寸并重测指示块，避免文字跑出高亮胶囊之外
  useEffect(() => {
    const wrap = wrapRef.current;
    let ro: ResizeObserver | undefined;
    if (wrap && typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => measure());
      ro.observe(wrap);
    }
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure]);

  return (
    <div className={"pm-seg" + (className ? " " + className : "")} ref={wrapRef}>
      <span className="pm-seg-thumb" style={{ left: thumb.left, width: thumb.width }} />
      {options.map((o) => {
        const disabled = getDisabled?.(o.key) ?? false;
        return (
          <button
            key={o.key}
            type="button"
            data-seg={o.key}
            title={getTitle?.(o.key)}
            className={(value === o.key ? "active" : "") + (disabled ? " disabled" : "")}
            disabled={disabled}
            onClick={() => !disabled && onChange(o.key)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
