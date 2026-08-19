// 轻量内联 SVG 图标集（避免额外依赖）

interface IconProps {
  size?: number;
  color?: string;
}

function base(size: number) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
}

export function ArrowLeftIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M19 12H5" />
      <path d="m12 19-7-7 7-7" />
    </svg>
  );
}

export function RestartIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M12 2v10" />
      <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
    </svg>
  );
}

export function RefreshIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M3 12a9 9 0 0 1 15.36-6.36L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15.36 6.36L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  );
}

export function ExternalIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  );
}

export function CopyIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </svg>
  );
}

export function StopIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect width="14" height="14" x="5" y="5" rx="2" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function PlayIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M6 4v16l14-8z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function HomeIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M9 22V12h6v10" />
    </svg>
  );
}

export function MinusIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M5 12h14" />
    </svg>
  );
}

export function MaximizeIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="5" y="5" width="14" height="14" rx="1" />
    </svg>
  );
}

export function RestoreIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="3.5" y="7.5" width="13" height="13" rx="1" />
      <path d="M7.5 7.5V4.5A1.5 1.5 0 0 1 9 3h10.5A1.5 1.5 0 0 1 21 4.5V15a1.5 1.5 0 0 1-1.5 1.5H16.5" />
    </svg>
  );
}

export function CloseIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
    </svg>
  );
}

export function SunIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

export function MoonIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

export function SystemIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}
