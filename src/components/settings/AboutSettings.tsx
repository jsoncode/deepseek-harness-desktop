import { GithubOutlined, InfoCircleOutlined, SyncOutlined } from "@ant-design/icons";
import { App as AntApp } from "antd";
import { useEffect, useRef, useState, type ReactNode } from "react";
import logo from "../../assets/logo.svg";
import { meetsNodeRequirement, pnpmMajorOf, semverCompare } from "../../lib/envReq";
import { api, tauri } from "../../lib/tauri";
import { useAppStore } from "../../store/useAppStore";
import { useUiStore } from "../../store/useUiStore";
import DshUpdateModal, { type DshNpmInfo, type DshNpmState } from "./DshUpdateModal";

/** GitHub 仓库（与 .github/workflows/release.yml 发布源一致） */
const REPO = "jsoncode/deepseek-harness-desktop";
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASE_PAGE = `https://github.com/${REPO}/releases/latest`;
/** 仓库主页：作者与仓库合并后的唯一入口 */
const REPO_PAGE = `https://github.com/${REPO}`;
/** 作者名（取自仓库 owner），作为仓库入口按钮的文案 */
const AUTHOR = REPO.split("/")[0];

/** @deepseek-ai/dsh 的 npm packument（版本检测：dist-tags.latest + 全部版本号） */
const DSH_NPM_PACKUMENT = "https://registry.npmjs.org/@deepseek-ai/dsh";

interface GitHubRelease {
  tag_name?: string;
  name?: string;
  published_at?: string;
  html_url?: string;
  body?: string | null;
}

interface EnvRow {
  name: string;
  state: "ok" | "bad" | "warn" | "loading";
  detail: ReactNode;
}

/**
 * 系统环境（设置页区块）：Node.js / pnpm / dsh CLI 的本机检测详情。
 * 启动检查页已移除后环境结果收敛到此处；进入区块或启动/安装链结束后自动检测，
 * 也可手动重新检测。缺失/异常项不在此修复——启动应用时会按需自动安装/降级/重装。
 */
function SystemEnvCard() {
  const nodePath = useAppStore((s) => s.nodePath);
  const nodeVersion = useAppStore((s) => s.nodeVersion);
  const pnpmPath = useAppStore((s) => s.pnpmPath);
  const pnpmVersion = useAppStore((s) => s.pnpmVersion);
  const dshInstalled = useAppStore((s) => s.dshInstalled);
  const dshVersion = useAppStore((s) => s.dshVersion);
  const phase = useAppStore((s) => s.phase);
  const refreshStatus = useAppStore((s) => s.refreshStatus);
  // 逐项检测完成标记：false = 该项仍在检测中（行内显示 loading）
  const envCheckDone = useAppStore((s) => s.envCheckDone);
  const [refreshing, setRefreshing] = useState(false);
  // npm 上 @deepseek-ai/dsh 的版本信息（驱动 dsh 行的更新检测与更新弹框）
  const [npmInfo, setNpmInfo] = useState<DshNpmInfo | null>(null);
  const [npmState, setNpmState] = useState<DshNpmState>("checking");
  const [updateOpen, setUpdateOpen] = useState(false);
  /** 是否由插件市场的「本应用」条目引流而来：展示上下文提示 */
  const [redirectedFromMarket, setRedirectedFromMarket] = useState(false);

  const checkNpm = async () => {
    setNpmState("checking");
    try {
      setNpmInfo(await fetchDshNpmInfo());
      setNpmState("ok");
    } catch {
      setNpmState("error");
    }
  };

  // 进入区块 / phase 每次落定（启动、安装链结束）时自动检测：
  // 安装链内的 pullStatusFields 不刷新检查行，链路结束后在此补一次
  useEffect(() => {
    if (phase === "checking" || phase === "installing" || phase === "starting") return;
    // 更新进行中的中间态不可信（卸载后/重装前 dsh 短暂缺失）：跳过，结束后由
    // 更新完成回调统一刷新
    if (useAppStore.getState().dshUpdate?.running) return;
    void refreshStatus();
  }, [phase, refreshStatus]);

  // 进入区块即查一次 npm 最新版本（与 GitHub 检查同节奏；失败静默，行内可重试）
  useEffect(() => {
    void checkNpm();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 外部意图：插件管理里搜到本应用自身（dsh CLI）时，不就地安装，改为跳到本页
  // 并打开 dsh CLI 更新弹框。按 seq 去重，同一个意图只消费一次。
  const settingsIntent = useUiStore((s) => s.settingsIntent);
  const clearSettingsIntent = useUiStore((s) => s.clearSettingsIntent);
  const consumedIntentRef = useRef(0);
  useEffect(() => {
    if (!settingsIntent || settingsIntent.action !== "dsh-update") return;
    if (settingsIntent.seq === consumedIntentRef.current) return;
    consumedIntentRef.current = settingsIntent.seq;
    clearSettingsIntent();
    setRedirectedFromMarket(true);
    setUpdateOpen(true);
  }, [settingsIntent, clearSettingsIntent]);

  const recheck = async () => {
    setRefreshing(true);
    try {
      await refreshStatus();
      void checkNpm();
    } finally {
      setRefreshing(false);
    }
  };

  // 启动/安装进行中后端会跳过重测（refreshStatus 内部保护），按钮一并禁用
  const busy = phase === "installing" || phase === "starting";

  // ---- 环境检查行（与启动链判定一致：缺失/损坏项由启动流程自动修复）----
  const envRows: EnvRow[] = [];
  if (!tauri) {
    envRows.push({
      name: "运行环境",
      state: "warn",
      detail: "浏览器预览模式：环境检查需在桌面应用内进行",
    });
  } else {
    if (!envCheckDone.node) {
      envRows.push({ name: "Node.js", state: "loading", detail: <span>检测中…</span> });
    } else if (meetsNodeRequirement(nodeVersion)) {
      envRows.push({ name: "Node.js", state: "ok", detail: <>已安装 v{nodeVersion}</> });
    } else if (!nodePath) {
      envRows.push({
        name: "Node.js",
        state: "bad",
        detail: <>未检测到 · 启动应用时将自动安装 LTS 版本（≥ 22.19：Windows 走 winget / macOS 走 Homebrew）</>,
      });
    } else if (!nodeVersion) {
      envRows.push({
        name: "Node.js",
        state: "bad",
        detail: <>已找到 Node 但无法读取版本 · 启动应用时将自动重新安装修复</>,
      });
    } else {
      envRows.push({
        name: "Node.js",
        state: "bad",
        detail: <>当前 v{nodeVersion}，低于要求的 22.19 · 启动应用时将自动安装 LTS 版本</>,
      });
    }

    const pnpm11 = pnpmMajorOf(pnpmVersion) >= 11;
    envRows.push(
      !envCheckDone.pnpm
        ? { name: "pnpm", state: "loading", detail: <span>检测中…</span> }
        : pnpmPath
          ? {
              name: "pnpm",
              state: pnpm11 ? "warn" : "ok",
              detail: pnpmVersion ? (
                <span>
                  已安装 v{pnpmVersion}
                  {pnpm11 ? (
                    <span className="env-warn-text">（dsh 不支持 pnpm 11，启动时将自动降级到 pnpm 10）</span>
                  ) : null}
                </span>
              ) : (
                <span>已安装</span>
              ),
            }
          : {
              name: "pnpm",
              state: "bad",
              detail: <span>未检测到 · 启动应用时将自动全局安装 pnpm@10（dsh 不支持 pnpm 11）</span>,
            },
    );

    // dsh 已安装但读不出版本 = 安装损坏，启动链会按需自动重装
    const dshBroken = dshInstalled && !dshVersion;
    // npm 有更新（当前 < dist-tags.latest；任一侧无法解析按无更新处理）
    const dshOutdated =
      dshVersion != null && npmInfo != null && (semverCompare(dshVersion, npmInfo.latest) ?? 0) < 0;
    envRows.push(
      !envCheckDone.dsh
        ? { name: "dsh CLI", state: "loading", detail: <span>检测中…</span> }
        : dshInstalled
          ? {
              name: "dsh CLI",
              state: dshBroken ? "warn" : "ok",
              detail: dshVersion ? (
                <span className="dsh-update-inline">
                  已安装 v{dshVersion}
                  {/* 常驻入口：落后 latest 时叫「更新」；已是最新也保留「切换版本」——
                      alpha/next 等预发布通道不在 latest 里，只能从这里切换。
                      npm 最新版等详情收进更新弹框，行内不再展示（避免行文案过密） */}
                  <button
                    className={"pm-btn pm-btn-sm dsh-update-btn" + (dshOutdated ? " primary" : "")}
                    type="button"
                    onClick={() => setUpdateOpen(true)}
                  >
                    {dshOutdated ? "更新" : "切换版本"}
                  </button>
                </span>
              ) : (
                <span>已安装但无法读取版本（可能已损坏）· 启动应用时将自动重新全局安装</span>
              ),
            }
          : {
              name: "dsh CLI",
              state: "warn",
              detail: <span>未安装 · 启动应用时将自动全局安装 @deepseek-ai/dsh</span>,
            },
    );
  }

  // 环境行的状态完全由 ✓/○/✗ 标记与文案表达（不再用子卡片描边强调）

  return (
    <>
      {/* 平铺分区标题：应用信息卡片内的轻量行（带顶部分隔线），不再是独立子卡片 */}
      <div className="about-section-head">
        <span>系统环境</span>
        <button
          className="pm-btn pm-btn-sm"
          type="button"
          disabled={refreshing || busy}
          onClick={() => void recheck()}
        >
          <SyncOutlined style={{ fontSize: 12 }} spin={refreshing} />
          {refreshing ? "检测中…" : "重新检测"}
        </button>
      </div>
      <div className="about-env-list">
        {envRows.map((r) => (
          <div key={r.name} className="env-row">
            <span className={"env-mark " + r.state}>
              {r.state === "ok" ? "✓" : r.state === "warn" ? "○" : r.state === "bad" ? "✗" : <span className="env-spinner" />}
            </span>
            <span className="env-name">{r.name}</span>
            <span className={"env-detail" + (r.state === "loading" ? " loading" : "")}>{r.detail}</span>
          </div>
        ))}
      </div>
      {/* 插件市场引流说明：在插件管理里搜到本应用自身时改跳到这里更新 dsh CLI */}
      {redirectedFromMarket ? (
        <div className="about-update-callout">
          <InfoCircleOutlined style={{ fontSize: 13, marginTop: 2 }} />
          <span>
            dsh CLI 是本应用的宿主运行时，<b>不从插件市场安装</b>——
            请在上方 dsh CLI 行的弹框中选择版本更新（也可复制命令在终端手动执行）。
          </span>
        </div>
      ) : null}
      <DshUpdateModal
        open={updateOpen}
        onClose={() => setUpdateOpen(false)}
        currentVersion={dshVersion}
        npmInfo={npmInfo}
        npmState={npmState}
        onRetryFetch={() => void checkNpm()}
      />
    </>
  );
}

/** 检查状态：未检查 / 检查中 / 已是最新 / 发现新版本 / 检查失败 */
type CheckState = "idle" | "checking" | "latest" | "outdated" | "error";

function stripV(v: string): string {
  return v.replace(/^v/i, "");
}

/** 数字比较两个版本号（忽略 v 前缀与预发布后缀）；a > b 返回正数 */
function compareVersions(a: string, b: string): number {
  const pa = stripV(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = stripV(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/** ISO → YYYY-MM-DD */
function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().slice(0, 10);
}

/**
 * 拉取 GitHub 最新 Release：桌面端经 Rust 代理（打包版 CSP 拦截前端直连外网），
 * 浏览器预览模式走原生 fetch（api.github.com 允许跨域）。
 */
async function fetchLatestRelease(): Promise<GitHubRelease> {
  if (tauri) {
    const text = await api.httpGetJson(RELEASE_API);
    return JSON.parse(text) as GitHubRelease;
  }
  const res = await fetch(RELEASE_API);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as GitHubRelease;
}

/** 从 npm packument 提取 dist-tags、dist-tags.latest 与全部版本号（semver 降序） */
async function fetchDshNpmInfo(): Promise<DshNpmInfo> {
  const text = tauri
    ? await api.httpGetJson(DSH_NPM_PACKUMENT)
    : await (await fetch(DSH_NPM_PACKUMENT)).text();
  const doc = JSON.parse(text) as {
    "dist-tags"?: Record<string, string>;
    versions?: Record<string, unknown>;
  };
  const latest = doc["dist-tags"]?.latest ?? "";
  if (!latest) throw new Error("packument 缺少 dist-tags.latest");
  const versions = Object.keys(doc.versions ?? {}).filter((v) => /^\d/.test(v));
  versions.sort((a, b) => semverCompare(b, a) ?? 0);
  return { latest, tags: doc["dist-tags"] ?? {}, versions };
}

/**
 * 关于本应用（设置页区块）：展示应用版本信息，并通过 GitHub Releases API
 * 检查是否有新版本；发现新版本时提供跳转到 Release 页面的入口。
 */
export default function AboutSettings() {
  const { message } = AntApp.useApp();
  const [state, setState] = useState<CheckState>("idle");
  const [release, setRelease] = useState<GitHubRelease | null>(null);
  const [error, setError] = useState<string | null>(null);

  const check = async () => {
    setState("checking");
    setError(null);
    try {
      const r = await fetchLatestRelease();
      setRelease(r);
      const latest = r.tag_name ?? "";
      if (!latest) throw new Error("未能获取最新版本号");
      // 远端 tag（vX.Y.Z）与本地编译期版本号比较
      setState(compareVersions(latest, __APP_VERSION__) > 0 ? "outdated" : "latest");
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setState("error");
    }
  };

  // 进入本区块即自动检查一次；导航条上的按钮可随时手动重查
  useEffect(() => {
    void check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openUrl = (url: string) => {
    if (!tauri) {
      window.open(url, "_blank");
      return;
    }
    void api.openInBrowser(url).catch((e) =>
      message.error(String(e instanceof Error ? e.message : e)),
    );
  };

  const checking = state === "checking";
  const releaseUrl = release?.html_url ?? RELEASE_PAGE;

  return (
    <>
      <div className="settings-body">
        <div className="settings-card">
          {/* 头部：直接沿用启动封面的品牌视觉（玻璃瓷片 logo + 渐变标题 + 级联入场），
              把原来的「小 logo + 名称 + 三行信息」压成居中的 hero + 一行 chips */}
          <div className="about-hero">
            <div className="about-hero-logo-wrap">
              <div className="about-hero-logo">
                <img src={logo} alt="Harness" draggable={false} />
              </div>
            </div>
            <h1 className="about-hero-title">DeepSeek Harness Desktop</h1>
            <div className="about-hero-sub">本地 DeepSeek Harness 网页服务的轻量桌面壳</div>
            <div className="about-hero-chips">
              <span className="about-app-version">{__APP_VERSION__}</span>
              {/* 作者与仓库合成一个入口：GitHub 图标 + 作者名，点了直接进仓库。
                  仓库地址收进原生 title（与 BottomBar 一致——预览页上的原生子
                  webview 会挡住 antd Tooltip，这里也统一不用浮层） */}
              <button
                className="pm-btn pm-btn-sm"
                type="button"
                title={`github.com/${REPO}`}
                onClick={() => openUrl(REPO_PAGE)}
              >
                <GithubOutlined style={{ fontSize: 12 }} />
                {AUTHOR}
              </button>
            </div>
          </div>

          {/* 系统环境：Node.js / pnpm / dsh CLI 检测结果（启动检查页已移除，收敛至此） */}
          <SystemEnvCard />

          {/* 版本更新（平铺分区标题） */}
          <div className="about-section-head">
            <span>版本更新</span>
            {/* 检查入口随所属模块走（原在右上角设置导航条上）：查的是本应用的
                GitHub Release，放这里语义更贴切，样式与「系统环境 · 重新检测」一致 */}
            <button
              className="pm-btn pm-btn-sm"
              type="button"
              disabled={checking}
              onClick={() => void check()}
            >
              <SyncOutlined style={{ fontSize: 12 }} spin={checking} />
              {checking ? "检查中…" : "检查更新"}
            </button>
          </div>
          <p className="settings-desc">
            通过 GitHub Releases 检查最新版本。发现新版本后，可前往 Release 页面查看更新说明并下载安装包。
          </p>
          {checking ? (
            <div className="about-update-status">
              <span className="mk-op-spinner" />
              <span>正在检查更新…</span>
            </div>
          ) : state === "latest" ? (
            <div className="about-update-status">
              <span className="about-update-dot ok" />
              <span>
                当前已是最新版本 <b className="about-update-strong">{__APP_VERSION__}</b>
                {release?.published_at ? (
                  <span className="about-update-muted">（发布于 {formatDate(release.published_at)}）</span>
                ) : null}
              </span>
            </div>
          ) : state === "outdated" && release ? (
            <div className="about-update-status">
              <span className="about-update-dot warn" />
              <span>
                发现新版本 <b className="about-update-strong">{release.tag_name}</b>
                {release.published_at ? (
                  <span className="about-update-muted">（发布于 {formatDate(release.published_at)}）</span>
                ) : null}
              </span>
              <button className="pm-btn primary pm-btn-sm" type="button" onClick={() => openUrl(releaseUrl)}>
                查看更新
              </button>
            </div>
          ) : state === "error" ? (
            <div className="about-update-status">
              <span className="about-update-dot bad" />
              <span>
                检查更新失败：<span className="about-update-muted">{error}</span>
              </span>
              <button className="pm-btn pm-btn-sm" type="button" onClick={() => void check()}>
                重试
              </button>
            </div>
          ) : (
            <div className="about-update-status">
              <span className="about-update-dot" />
              <span>点击「检查更新」查看是否有新版本。</span>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
