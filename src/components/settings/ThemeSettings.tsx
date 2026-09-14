import { Segmented } from "antd";
import {
  CheckOutlined,
  DesktopOutlined,
  MoonOutlined,
  SunOutlined,
} from "@ant-design/icons";
import { useThemeStore, type EffectiveTheme, type ThemeMode } from "../../store/useThemeStore";

/** 三种模式的元信息：图标 + 名称 + 一句话说明（说明文案在卡片里逐条展示） */
const MODE_META: Record<
  ThemeMode,
  { label: string; icon: React.ReactNode; desc: string }
> = {
  system: {
    label: "跟随系统",
    icon: <DesktopOutlined />,
    desc: "随操作系统外观自动切换，适合开启了系统自动夜间模式",
  },
  light: {
    label: "浅色",
    icon: <SunOutlined />,
    desc: "始终使用浅色外观，不受系统影响",
  },
  dark: {
    label: "深色",
    icon: <MoonOutlined />,
    desc: "始终使用深色外观，不受系统影响",
  },
};

const MODE_ORDER: ThemeMode[] = ["system", "light", "dark"];

/**
 * 主题设置（设置页区块）：三种模式的卡片式选择，每张卡带一个迷你界面预览图，
 * 卡片下方逐条列出说明；末尾保留一行 Segmented 作为紧凑快捷切换。
 *
 * 用自绘卡片而不是 antd Segmented：Segmented 只能表达「选中了哪一项」，
 * 无法表达每项长什么样；主题恰好是最需要「所见即所得」的设置项，故换成带预览的卡片。
 * （Segmented 与卡片共享同一个 store，天然双向同步。）
 *
 * 不再回显「当前生效」：选择本身就是用户的意图，而预览图已经在卡片里回答了
 * 「选完之后长什么样」；再单独开一块播报生效明暗属于重复信息。
 */
export default function ThemeSettings() {
  const mode = useThemeStore((s) => s.mode);
  const setMode = useThemeStore((s) => s.setMode);

  return (
    <>
      <div className="settings-body">
        <div className="settings-card">
          <div className="settings-card-title">外观主题</div>
          <p className="settings-desc">
            选择应用的显示外观。预览图仅示意明暗，实际配色以应用当前主题为准。
          </p>

          <div className="theme-grid" role="radiogroup" aria-label="外观主题">
            {MODE_ORDER.map((m) => {
              const meta = MODE_META[m];
              const selected = m === mode;
              return (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className={`theme-option${selected ? " active" : ""}`}
                  onClick={() => setMode(m)}
                >
                  <span className="theme-option-check">
                    {selected ? <CheckOutlined /> : null}
                  </span>
                  <ThemePreview variant={previewOf(m)} />
                  <span className="theme-option-label">
                    {meta.icon}
                    {meta.label}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="theme-option-rows">
            {MODE_ORDER.map((m) => (
              <div key={m} className="theme-option-row">
                <span className="theme-option-row-icon">{MODE_META[m].icon}</span>
                <span className="theme-option-row-name">{MODE_META[m].label}</span>
                <span className="theme-option-row-desc">{MODE_META[m].desc}</span>
              </div>
            ))}
          </div>

          <div className="settings-row theme-quick-switch">
            <span>快捷切换</span>
            <Segmented<ThemeMode>
              value={mode}
              onChange={(v) => setMode(v)}
              options={MODE_ORDER.map((m) => ({
                value: m,
                label: (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    {MODE_META[m].icon}
                    {MODE_META[m].label}
                  </span>
                ),
              }))}
            />
          </div>
        </div>
      </div>
    </>
  );
}

/** 卡片预览要画哪种明暗：手动模式画自己；system 画「明暗对比」示意 */
function previewOf(m: ThemeMode): EffectiveTheme | "split" {
  return m === "light" || m === "dark" ? m : "split";
}

/**
 * 迷你界面示意图：侧栏 + 两行内容块，靠 class 切换明暗配色（配色写在 CSS 里）。
 *
 * variant：
 * - light / dark：单一明暗，对应手动固定模式；
 * - split：左暗右亮的斜切对比，专门用于「跟随系统」——用一张图同时表达
 *   「会变成暗色」和「会变成亮色」，比画成当前生效的单色更能说明「自动切换」。
 */
function ThemePreview({ variant }: { variant: EffectiveTheme | "split" }) {
  if (variant === "split") return <SplitPreview />;
  return (
    <span className={`theme-preview ${variant}`} aria-hidden="true">
      <span className="theme-preview-side" />
      <span className="theme-preview-main">
        <span className="theme-preview-bar" />
        <span className="theme-preview-line" />
        <span className="theme-preview-line short" />
      </span>
    </span>
  );
}

/**
 * 「跟随系统」专用预览：斜切把卡片分成左暗右亮两块。
 *
 * 实现要点：外框只负责裁切与描边（overflow:hidden），内层两个绝对定位色块
 * 分别铺满整块，再用 `clip-path` 沿对角线切开——这样分界线是干净的斜线，
 * 而不是靠渐变糊出来的过渡（渐变在左右两端会发灰，黑白对比会被削弱）。
 * 切角固定用 px 而非百分比，保证卡片在不同宽度下斜线角度一致、不随宽度拉伸变形。
 */
function SplitPreview() {
  return (
    <span className="theme-preview split" aria-hidden="true">
      <span className="theme-preview-half dark" />
      <span className="theme-preview-half light" />
      {/* 斜线上的迷你界面元素：左半（暗色区）用亮色块，右半（亮色区）用暗色块，
          让两块区域都像「有个界面」而不是纯色卡 */}
      <span className="theme-preview-ink">
        <span className="theme-preview-bar" />
        <span className="theme-preview-line" />
        <span className="theme-preview-line short" />
      </span>
    </span>
  );
}
