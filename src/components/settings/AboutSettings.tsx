import { GithubOutlined, SyncOutlined } from "@ant-design/icons";
import { App as AntApp } from "antd";
import { useEffect, useState } from "react";
import logo from "../../assets/logo.svg";
import { api, tauri } from "../../lib/tauri";

/** GitHub 仓库（与 .github/workflows/release.yml 发布源一致） */
const REPO = "jsoncode/deepseek-harness-desktop";
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASE_PAGE = `https://github.com/${REPO}/releases/latest`;
const REPO_PAGE = `https://github.com/${REPO}`;

interface GitHubRelease {
  tag_name?: string;
  name?: string;
  published_at?: string;
  html_url?: string;
  body?: string | null;
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
      <div className="settings-nav">
        <span className="settings-nav-title">关于本应用</span>
        <div className="settings-nav-actions">
          <button
            className="pm-btn"
            type="button"
            disabled={checking}
            onClick={() => void check()}
          >
            <SyncOutlined style={{ fontSize: 12 }} />
            {checking ? "检查中…" : "检查更新"}
          </button>
        </div>
      </div>
      <div className="settings-body">
        <div className="settings-card">
          <div className="about-app-head">
            <div className="about-app-logo">
              <img src={logo} alt="Harness" draggable={false} />
            </div>
            <div>
              <div className="about-app-name">DeepSeek Harness Desktop</div>
              <div className="about-app-meta">
                本地 DeepSeek Harness 网页服务的轻量桌面壳
              </div>
            </div>
          </div>
          <div className="settings-row">
            <span>当前版本</span>
            <span className="about-app-version">{__APP_VERSION__}</span>
          </div>
          <div className="settings-row">
            <span>开源仓库</span>
            <button className="pm-btn" type="button" onClick={() => openUrl(REPO_PAGE)}>
              <GithubOutlined style={{ fontSize: 13 }} />
              github.com/{REPO}
            </button>
          </div>
        </div>

        <div className="settings-card">
          <div className="settings-card-title">版本更新</div>
          <p className="settings-desc">
            通过 GitHub Releases 检查最新版本。发现新版本后，可前往 Release 页面查看更新说明并下载安装包。
          </p>
          <div className="about-update-box">
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
                <span>点击右上角「检查更新」查看是否有新版本。</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
