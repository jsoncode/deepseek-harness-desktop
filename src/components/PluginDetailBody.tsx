/**
 * 插件详情弹框内容区。
 *
 * 从 PluginManagerPanel 拆出，原因是它自带一套异步状态机（README 拉取）：
 * 拆成独立组件后，`key` 绑定插件地址即可让「切换插件 → 状态归零 → 重新拉取」
 * 自然发生，无需在父层写 reset effect。
 */

import { useEffect, useState } from "react";
import Markdown from "./Markdown";
import { api, tauri } from "../lib/tauri";
import { fetchReadme, formatCount, formatDate, type ReadmeResult } from "../lib/pluginMarket";

/** 详情弹框所需的最小行数据（与 PluginManagerPanel 的 MkRow 结构对齐） */
export interface DetailRow {
  name: string;
  spec: string;
  author: string;
  avatarUrl: string | null;
  description: string | null;
  weekly: number | null;
  monthly: number | null;
  stars: number | null;
  latest: string | null;
  releasedAt: string | null;
  installedHere: boolean;
  current: string | null;
  self: boolean;
  repoUrl: string | null;
  issuesUrl: string | null;
}

/** 首字母渐变圆标头像（远程头像加载失败时的回退）。表格头像列与详情弹框共用 */
export function Avatar({ url, name }: { url: string | null; name: string }) {
  const [failed, setFailed] = useState(false);
  if (!url || failed) {
    return <span className="mk-avatar mk-avatar-fallback">{(name[0] ?? "?").toUpperCase()}</span>;
  }
  return (
    <img
      className="mk-avatar"
      src={url}
      alt={name}
      loading="lazy"
      onError={() => setFailed(true)}
      draggable={false}
    />
  );
}

/** 外链统一交回系统浏览器打开，避免 WebView 内跳走丢失应用上下文 */
function openExternal(e: React.MouseEvent, href: string) {
  e.preventDefault();
  if (tauri) {
    void api.openInBrowser(href).catch(() => window.open(href, "_blank", "noopener"));
  } else {
    window.open(href, "_blank", "noopener");
  }
}

/** 从仓库地址取 owner 名（用于「作者」兜底的 @handle 展示） */
function ownerOf(repoUrl: string | null): string | null {
  const m = repoUrl ? /^https?:\/\/github\.com\/([^/]+)\//i.exec(repoUrl) : null;
  return m ? m[1] : null;
}

export default function PluginDetailBody({
  row,
  outdatedTo,
}: {
  row: DetailRow;
  /** 存在可更新版本时传入目标版本号，用于顶部徽标 */
  outdatedTo: string | null;
}) {
  const [readme, setReadme] = useState<ReadmeResult | null>(null);
  const [readmeOpen, setReadmeOpen] = useState(false);

  // 打开详情即预取 README（缓存命中时瞬时返回），但不默认展开——
  // 详情首屏优先呈现版本/依赖等决策信息，README 交给用户按需展开
  useEffect(() => {
    if (!row.repoUrl) {
      setReadme(null);
      return;
    }
    let alive = true;
    void fetchReadme(row.repoUrl).then((r) => {
      if (alive) setReadme(r);
    });
    return () => {
      alive = false;
    };
  }, [row.repoUrl]);

  const owner = ownerOf(row.repoUrl);
  const hasRepo = !!row.repoUrl && !row.self;
  const loading = row.repoUrl !== null && readme === null;

  return (
    <div className="pm-detail-body">
      <div className="pm-detail-head">
        <Avatar url={row.avatarUrl} name={row.author} />
        <div className="pm-detail-title">
          <div className="pm-detail-name">
            <span className="mk-name">{row.name}</span>
            {row.self ? (
              <span className="pm-detail-badge self">本应用</span>
            ) : row.installedHere ? (
              <span className="pm-detail-badge installed">已安装</span>
            ) : (
              <span className="pm-detail-badge">未安装</span>
            )}
            {row.installedHere && outdatedTo ? (
              <span className="pm-detail-badge update">可更新 → v{outdatedTo}</span>
            ) : null}
          </div>

          {/* 作者 + 仓库/Issues 入口：有 GitHub 地址时给出可点击的外链 */}
          <div className="pm-detail-meta">
            {row.author && row.author !== "—" ? (
              <span className="mk-author">
                作者
                {owner ? (
                  <a
                    className="pm-detail-author-link"
                    href={`https://github.com/${owner}`}
                    onClick={(e) => openExternal(e, `https://github.com/${owner}`)}
                  >
                    @{owner}
                  </a>
                ) : (
                  <> @{row.author}</>
                )}
              </span>
            ) : null}
            <span className="pm-detail-spec">{row.spec}</span>
          </div>

          {hasRepo ? (
            <div className="pm-detail-links">
              <a
                className="pm-detail-link"
                href={row.repoUrl!}
                onClick={(e) => openExternal(e, row.repoUrl!)}
              >
                源码仓库
              </a>
              {row.issuesUrl ? (
                <a
                  className="pm-detail-link"
                  href={row.issuesUrl}
                  onClick={(e) => openExternal(e, row.issuesUrl!)}
                >
                  Issues 反馈
                </a>
              ) : null}
            </div>
          ) : null}

          <div className="pm-detail-versions">
            {row.installedHere && row.current ? (
              <span className="pm-detail-version">
                本机版本 <b>v{row.current}</b>
              </span>
            ) : null}
            {row.latest ? (
              <span className="pm-detail-version">
                最新版本 <b>v{row.latest}</b>
              </span>
            ) : null}
            {!row.installedHere && !row.latest ? (
              <span className="pm-detail-version muted">版本信息暂不可用</span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="pm-detail-stats">
        {row.weekly !== null ? (
          <span className="pm-detail-stat">
            周下载 <b>{formatCount(row.weekly)}</b>
          </span>
        ) : null}
        {row.monthly !== null ? (
          <span className="pm-detail-stat">
            月下载 <b>{formatCount(row.monthly)}</b>
          </span>
        ) : null}
        {row.stars !== null ? (
          <span className="pm-detail-stat">
            Stars <b>★ {formatCount(row.stars)}</b>
          </span>
        ) : null}
        {row.releasedAt ? (
          <span className="pm-detail-stat">
            更新于 <b>{formatDate(row.releasedAt)}</b>
          </span>
        ) : null}
      </div>

      <div className="pm-detail-desc">
        {row.description ? row.description : <span className="mk-desc-empty">暂无描述</span>}
      </div>

      {/* 自身包提示：替代普通插件的免责声明，说明为什么不在这里安装 */}
      {row.self ? (
        <div className="pm-detail-self-note">
          该条目是本应用的宿主运行时（dsh CLI / 桌面壳仓库），
          属于应用本身而非第三方插件——在插件市场安装它只会注入重复或过期的宿主。
          请点击「去更新 dsh CLI」，在「关于本应用」中选择版本更新。
        </div>
      ) : (
        <div className="pm-detail-disclaimer">
          以上插件均来自开源社区、由第三方作者维护。本软件不参与插件开发，
          也未对插件内容做安全审查或作出任何承诺——请自行评估风险，
          确认信任来源后再决定是否安装。
        </div>
      )}

      {/* README 区块：仅在有 GitHub 仓库时出现（已安装列表无仓库元数据） */}
      {hasRepo ? (
        <div className="pm-readme">
          <button
            className="pm-readme-toggle"
            type="button"
            aria-expanded={readmeOpen}
            onClick={() => setReadmeOpen((v) => !v)}
          >
            <span className={`pm-readme-caret${readmeOpen ? " open" : ""}`}>▸</span>
            <span>项目说明（README）</span>
            {loading ? <span className="pm-readme-hint">加载中…</span> : null}
            {readme?.state === "ok" ? (
              <span className="pm-readme-hint">{formatCount(readme.markdown.length)} 字符</span>
            ) : null}
          </button>

          {readmeOpen ? (
            <div className="pm-readme-panel">
              {loading ? (
                <div className="pm-readme-state">正在读取 README…</div>
              ) : readme?.state === "ok" ? (
                <Markdown text={readme.markdown} />
              ) : readme?.state === "empty" ? (
                <div className="pm-readme-state">该仓库没有提供 README</div>
              ) : (
                <div className="pm-readme-state error">
                  {readme?.state === "error" ? readme.message : "README 加载失败"}
                </div>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
