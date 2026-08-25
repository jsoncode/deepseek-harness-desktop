import { ClusterOutlined, SearchOutlined } from "@ant-design/icons";
import { App as AntApp, Badge, Input, Table, Tooltip } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import AppModal from "./AppModal";
import { api, tauri } from "../lib/tauri";
import { useAppStore, type PluginOpKind } from "../store/useAppStore";
import {
  fetchMarketPage,
  formatCount,
  formatDate,
  pageSizeOf,
  type MarketPage,
  type MarketSort,
  type MarketSource,
} from "../lib/pluginMarket";
import { MARK } from "../pages/Terminal";

const OP_VERB: Record<PluginOpKind, string> = {
  add: "安装",
  update: "更新",
  remove: "卸载",
};

/** 首字母渐变圆标头像（远程头像加载失败时的回退） */
function Avatar({ url, name }: { url: string | null; name: string }) {
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

/**
 * 插件名模糊匹配（忽略大小写）：除直接小写包含外，还归一化 -/_/. 与空白分隔符后比较，
 * 因此 dsh_jenkins、DshJenkins、dsh-jenkins 均可互相命中。
 */
function nameMatches(name: string, rawQuery: string): boolean {
  const q = rawQuery.trim();
  if (!q) return true;
  if (name.toLowerCase().includes(q.toLowerCase())) return true;
  const normalize = (s: string) => s.toLowerCase().replace(/[-_.\s]/g, "");
  return normalize(name).includes(normalize(q));
}

/**
 * 滑块式分段选择：active 指示块在选项之间平滑穿梭滑动（替代变色胶囊）。
 * 测量目标按钮 offsetLeft/offsetWidth 驱动 thumb 位移；窗口尺寸变化时自动校正。
 */
function SlidingSeg<T extends string>({
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

  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
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

/** 表格行数据（市场行与已安装行统一） */
interface MkRow {
  key: string;
  name: string;
  spec: string;
  author: string;
  avatarUrl: string | null;
  description: string | null;
  weekly: number | null;
  monthly: number | null;
  stars: number | null;
  /** 最新可用版本；本地链接包为 null */
  latest: string | null;
  releasedAt: string | null;
  installedHere: boolean;
  current: string | null;
}

/**
 * 插件管理：标题栏入口 + 大尺寸插件市场弹框。
 * 市场视图：GitHub/NPM 双源搜索、排序、分页（antd Table，固定操作列）、安装/更新/卸载；
 * 终端视图：流式展示 `dsh plugin` 操作日志，支持终止与后台运行。
 * 视图/tab/翻页切换带方向感穿梭动画。
 */
export default function PluginManager() {
  const { modal, message } = AntApp.useApp();
  const plugins = useAppStore((s) => s.plugins);
  const serviceRunning = useAppStore((s) => s.serviceRunning);
  const initialized = useAppStore((s) => s.initialized);
  const init = useAppStore((s) => s.init);
  const refreshStatus = useAppStore((s) => s.refreshStatus);
  const pluginOp = useAppStore((s) => s.pluginOp);
  const pluginOpLogs = useAppStore((s) => s.pluginOpLogs);
  const startPluginOp = useAppStore((s) => s.startPluginOp);
  const pluginVers = useAppStore((s) => s.pluginVers);
  const refreshPluginVersions = useAppStore((s) => s.refreshPluginVersions);

  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"market" | "terminal">("market");
  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState("");
  /** 「查看」小弹框当前展示的插件行 */
  const [descRow, setDescRow] = useState<MkRow | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const prevRunningRef = useRef<boolean>(false);

  // ---- 市场状态 ----
  const [source, setSource] = useState<MarketSource>("npm");
  const [tabMode, setTabMode] = useState<"all" | "installed">("all");
  /** 本地搜索词：只作用于前端名称过滤，不参与接口请求 */
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<MarketSort>("weekly");
  const [page, setPage] = useState(1);
  const [market, setMarket] = useState<MarketPage | null>(null);
  const [marketLoading, setMarketLoading] = useState(false);
  const [marketError, setMarketError] = useState<string | null>(null);
  /** 内容区穿梭动画：n 变化触发重挂载，cls 决定入场方向 */
  const [paneAnim, setPaneAnim] = useState<{ n: number; cls: string }>({ n: 0, cls: "" });
  const bumpPane = (cls: string) => setPaneAnim((p) => ({ n: p.n + 1, cls }));

  useEffect(() => {
    if (!initialized) void init();
  }, [initialized, init]);

  // 本地搜索即时过滤（无网络请求），无需防抖

  // 市场数据拉取（仅市场视图 + 所有插件 tab）。
  // 接口恒定使用 keywords:dsh-plugin / topic:dsh-plugin 全集，与搜索词完全解耦，
  // 因此依赖里不含 query —— 输入搜索词不会触发任何网络请求。
  useEffect(() => {
    if (!open || view !== "market" || tabMode !== "all") return;
    let alive = true;
    setMarketLoading(true);
    setMarketError(null);
    fetchMarketPage(source, page, sort)
      .then((p) => {
        if (alive) setMarket(p);
      })
      .catch((e) => {
        if (alive) setMarketError(String(e instanceof Error ? e.message : e));
      })
      .finally(() => {
        if (alive) setMarketLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, view, tabMode, source, sort, page]);

  // 终端自动滚动到底部
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [pluginOpLogs.at(-1)?.id]);

  // 完成监听：running → false 转变时提示并刷新列表与版本信息（无论弹框是否打开）
  useEffect(() => {
    const running = pluginOp?.running ?? false;
    if (prevRunningRef.current && !running && pluginOp) {
      message.info("插件已变更，请稍后刷新页面或重启服务");
      void refreshStatus();
      void refreshPluginVersions();
    }
    prevRunningRef.current = running;
  }, [pluginOp?.running, pluginOp, message, refreshStatus, refreshPluginVersions]);

  if (!tauri) return null;

  const running = pluginOp?.running ?? false;
  const totalPages = Math.max(1, Math.ceil((market?.total ?? 0) / pageSizeOf(source)));
  const installedSet = new Set(plugins);

  const isOutdated = (n: string) => {
    const c = pluginVers[n]?.current;
    const l = pluginVers[n]?.latest;
    return !!c && !!l && c !== l;
  };

  const openManager = () => {
    setOpen(true);
    setView(pluginOp?.running ? "terminal" : "market");
    void refreshPluginVersions();
  };

  /** 带方向感的穿梭切换 */
  const switchTab = (mode: "all" | "installed") => {
    if (tabMode === mode) return;
    bumpPane(mode === "installed" ? "mk-from-right" : "mk-from-left");
    setTabMode(mode);
    setPage(1);
    if (mode === "installed") void refreshPluginVersions();
  };

  const switchSource = (s: MarketSource) => {
    if (source === s) return;
    bumpPane(s === "npm" ? "mk-from-right" : "mk-from-left");
    setSource(s);
    setSort(s === "github" ? "stars" : "weekly");
    setPage(1);
  };

  const confirmOp = (kind: PluginOpKind, target: string) => {
    const verb = OP_VERB[kind];
    modal.confirm({
      title: `${verb}插件`,
      content: `${serviceRunning ? "服务正在运行中，" : ""}确认要${verb} ${target} 吗？`,
      okText: verb,
      okButtonProps: kind === "update" ? undefined : { danger: true },
      cancelText: "取消",
      onOk: () => {
        // 不切到终端视图：保持插件管理弹框打开在插件列表，操作后台执行，
        // 弹框顶部显示进行中横幅，可点"查看日志"进入终端视图
        return startPluginOp(kind, target);
      },
    });
  };

  const submitAdd = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      message.warning("请输入插件名称");
      return;
    }
    // 仅关闭手动安装输入弹框；插件管理主弹框保持打开，操作在后台执行
    setAddOpen(false);
    setName("");
    void startPluginOp("add", trimmed);
  };

  const cancelOpConfirm = () => {
    modal.confirm({
      title: "终止操作",
      content: "确定要终止当前的插件操作吗？未完成的变更将被丢弃。",
      okText: "终止",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        try {
          await api.cancelPluginOp();
        } catch (e) {
          message.error(String(e instanceof Error ? e.message : e));
        }
      },
    });
  };

  /** 行内操作按钮组（固定列渲染） */
  const renderActions = (_: unknown, r: MkRow) => (
    <div className="mk-actions">
      <button
        className="pm-btn pm-btn-sm"
        type="button"
        onClick={() => setDescRow(r)}
      >
        查看
      </button>
      {!r.installedHere ? (
        <button
          className="pm-btn pm-btn-sm primary"
          type="button"
          disabled={running}
          onClick={() => confirmOp("add", r.spec)}
        >
          安装
        </button>
      ) : null}
      {r.installedHere && isOutdated(r.name) ? (
        <button
          className="pm-btn pm-btn-sm"
          type="button"
          disabled={running}
          onClick={() => confirmOp("update", r.name)}
        >
          更新
        </button>
      ) : null}
      {r.installedHere ? (
        <button
          className="pm-btn pm-btn-sm danger"
          type="button"
          disabled={running}
          onClick={() => confirmOp("remove", r.name)}
        >
          卸载
        </button>
      ) : null}
    </div>
  );

  const columns: ColumnsType<MkRow> = [
    {
      title: "",
      key: "avatar",
      width: 64,
      render: (_, r) => <Avatar url={r.avatarUrl} name={r.author} />,
    },
    {
      title: "插件名称",
      dataIndex: "name",
      ellipsis: true,
      render: (_, r) => (
        <span className="mk-name" title={r.name}>
          {r.name}
          {r.installedHere && r.current ? (
            <span className="plugin-ver">(本机 v{r.current})</span>
          ) : null}
          {isOutdated(r.name) && pluginVers[r.name]?.latest ? (
            <span className="plugin-ver new">→ {pluginVers[r.name]?.latest}</span>
          ) : null}
        </span>
      ),
    },
    {
      title: "作者",
      dataIndex: "author",
      width: 120,
      ellipsis: true,
      render: (v: string) => <span className="mk-author">{v}</span>,
    },
    {
      title: "周/月下载",
      key: "downloads",
      width: 122,
      render: (_, r) => (
        <span className={`mk-num${r.weekly === null ? " muted" : ""}`}>
          {r.weekly === null ? "—" : `${formatCount(r.weekly)} / ${formatCount(r.monthly)}`}
        </span>
      ),
    },
    {
      title: "版本",
      key: "ver",
      width: 170,
      render: (_, r) => (
        <span className={`mk-num${r.latest === null ? " muted" : ""}`}>{r.latest ?? "—"}</span>
      ),
    },
    {
      title: "Stars",
      key: "stars",
      width: 84,
      render: (_, r) => (
        <span className={`mk-num${r.stars === null ? " muted" : ""}`}>
          {r.stars === null ? "—" : `★ ${formatCount(r.stars)}`}
        </span>
      ),
    },
    {
      title: "发布日期",
      key: "date",
      width: 98,
      render: (_, r) => (
        <span className={`mk-num${r.releasedAt ? "" : " muted"}`}>{formatDate(r.releasedAt)}</span>
      ),
    },
    {
      title: "操作",
      key: "actions",
      fixed: "right",
      width: 200,
      render: renderActions,
    },
  ];

  // ---- 数据源组装 ----
  const allRows: MkRow[] = (market?.items ?? []).map((it) => ({
    key: it.key,
    name: it.name,
    spec: it.spec,
    author: it.author,
    avatarUrl: it.avatarUrl,
    description: it.description,
    weekly: it.weekly,
    monthly: it.monthly,
    stars: it.stars,
    latest: it.version,
    releasedAt: it.releasedAt,
    installedHere: installedSet.has(it.name),
    current: pluginVers[it.name]?.current ?? null,
  }));

  // 已安装 tab：本地名称模糊过滤
  const visibleInstalled = plugins.filter((p) => nameMatches(p, query));
  const installedRows: MkRow[] = visibleInstalled.map((p) => ({
    key: p,
    name: p,
    spec: p,
    author: "本机",
    avatarUrl: null,
    description: null,
    weekly: null,
    monthly: null,
    stars: null,
    latest: pluginVers[p]?.latest ?? null,
    releasedAt: null,
    installedHere: true,
    current: pluginVers[p]?.current ?? null,
  }));

  // 所有插件 tab：对当前页结果再做一次名称模糊兜底（所见即名称命中）
  const rows =
    tabMode === "all"
      ? query.trim()
        ? allRows.filter((r) => nameMatches(r.name, query) || nameMatches(r.spec, query))
        : allRows
      : installedRows;

  const marketBody = (
    <div className="mk-wrap">
      {/* 顶部固定区：进行中横幅 + 搜索工具栏 + 加载/错误提示，不随表格滚动 */}
      <div className="mk-sticky">
        {running && pluginOp ? (
          <div className="mk-op-banner">
            <span className="mk-op-spinner" />
            <span>
              正在{OP_VERB[pluginOp.kind]} <b>{pluginOp.name}</b>…
            </span>
            <button className="pm-btn pm-btn-sm" type="button" onClick={() => setView("terminal")}>
              查看日志
            </button>
          </div>
        ) : null}
        {/* 工具栏两行：第一行 搜索(flex)+手动安装；第二行 视图tab(左)+排序(右，仅所有插件) */}
        <div className="mk-toolbar">
          <div className="mk-row">
            <Input
              className="mk-search"
              placeholder="按插件名称模糊搜索（忽略大小写）"
              allowClear
              prefix={<SearchOutlined style={{ color: "var(--text-3)" }} />}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button className="pm-btn pm-btn-sm mk-add-btn" type="button" onClick={() => setAddOpen(true)}>
              手动安装
            </button>
          </div>
          <div className="mk-row">
            <SlidingSeg
              value={tabMode}
              options={[
                {
                  key: "all",
                  label: "所有插件(" + formatCount(tabMode === "all" ? market?.total : visibleInstalled.length) + ")",
                },
                { key: "installed", label: "已安装(" + visibleInstalled.length + ")" },
              ]}
              onChange={switchTab}
            />
            {tabMode === "all" ? (
              <SlidingSeg
                className="mk-row-sort"
                value={sort}
                options={[
                  { key: "weekly", label: "周下载" },
                  { key: "stars", label: "Stars" },
                  { key: "date", label: "发布日期" },
                ]}
                getDisabled={(k) =>
                  k === "weekly" ? source !== "npm" : k === "stars" ? source !== "github" : false
                }
                getTitle={(k) =>
                  k === "weekly" && source !== "npm"
                    ? "NPM 源不支持该排序"
                    : k === "stars" && source !== "github"
                      ? "GitHub 源不支持该排序"
                      : undefined
                }
                onChange={(k) => {
                  setSort(k);
                  setPage(1);
                  bumpPane("mk-fade");
                }}
              />
            ) : null}
          </div>
        </div>
        {marketLoading && tabMode === "all" ? (
          <div className="mk-loading">
            <span className="spinner-ring" /> 正在加载插件…
          </div>
        ) : null}
        {marketError ? <div className="mk-error">{marketError}</div> : null}
      </div>

      {/* 穿梭动画面板：tab/源/翻页/搜索变化时按方向滑入 */}
      <div key={paneAnim.n} className={`mk-pane ${paneAnim.cls}`}>
        <Table
          className="mk-ant-table"
          size="small"
          rowKey="key"
          columns={columns}
          dataSource={rows}
          pagination={false}
          scroll={{ x: 1010 }}
          locale={{
            emptyText:
              tabMode === "installed"
                ? query.trim()
                  ? "没有匹配的已安装插件"
                  : "本机尚未安装任何插件"
                : query.trim()
                  ? "当前页无名称匹配的插件，可尝试翻页或更换关键词"
                  : "无匹配插件",
          }}
        />
      </div>
    </div>
  );

  const terminalBody = (
    <div className="term-window plugin-term">
      <div className={`term-progress${running ? " active" : ""}`} />
      <div className="term-body" ref={bodyRef}>
        {pluginOpLogs.length === 0 ? (
          <div className="term-empty">等待输出…</div>
        ) : (
          pluginOpLogs.map((l) => (
            <div key={l.id} className={`term-line ${l.stream}`}>
              <span className="t-time">{l.time}</span>
              <span className="t-mark">{MARK[l.stream] ?? "·"}</span>
              <span className="t-text">{l.text}</span>
            </div>
          ))
        )}
        {running ? (
          <div className="term-line system">
            <span className="t-time">{"·".repeat(8)}</span>
            <span className="t-mark">◆</span>
            <span className="t-text">
              正在执行，请稍候…
              <span className="term-cursor" />
            </span>
          </div>
        ) : (
          <div className={`term-line ${(pluginOp?.exitCode ?? -1) === 0 ? "success" : "error"}`}>
            <span className="t-time">{""}</span>
            <span className="t-mark">{(pluginOp?.exitCode ?? -1) === 0 ? "✓" : "✗"}</span>
            <span className="t-text">
              {(pluginOp?.exitCode ?? -1) === 0
                ? "操作完成"
                : `操作失败（退出码 ${pluginOp?.exitCode ?? "?"}）`}
            </span>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <>
      <Tooltip title="插件管理">
        <button className="icon-btn" type="button" aria-label="插件管理" onClick={openManager}>
          <Badge dot={running} color="red">
            <ClusterOutlined />
          </Badge>
        </button>
      </Tooltip>

      <AppModal
        open={open}
        className={`plugin-manager-modal${view === "market" ? " mk-market" : ""}`}
        onCancel={() => setOpen(false)}
        width="90vw"
        styles={{
          // 固定弹框高度 80vh：header/footer 固定，body 不滚动，内部面板自行滚动
          container: { height: "80vh" },
          body: { overflowY: "hidden", display: "flex", flexDirection: "column" },
        }}
        title={
          view === "terminal" ? (
            `正在${OP_VERB[pluginOp?.kind ?? "add"]} · ${pluginOp?.name ?? ""}`
          ) : (
            <div className="pm-title-row">
              <span>插件管理</span>
              <SlidingSeg
                value={source}
                options={[
                  { key: "github", label: "GitHub" },
                  { key: "npm", label: "NPM" },
                ]}
                onChange={(s) => switchSource(s)}
              />
            </div>
          )
        }
        footer={
          view === "terminal" ? (
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              {running ? (
                <>
                  <button className="pm-btn danger" type="button" onClick={cancelOpConfirm}>
                    终止操作
                  </button>
                  <button className="pm-btn" type="button" onClick={() => setOpen(false)}>
                    后台运行
                  </button>
                </>
              ) : (
                <button className="pm-btn primary" type="button" onClick={() => setOpen(false)}>
                  关闭
                </button>
              )}
            </div>
          ) : (
            <div className="mk-footer">
              {/* 分页固定在 footer 左侧；已安装 tab 无分页 */}
              {tabMode === "all" ? (
                <div className="mk-pager">
                  <button
                    className="pm-btn pm-btn-sm"
                    type="button"
                    disabled={page <= 1 || marketLoading}
                    onClick={() => {
                      setPage((p) => p - 1);
                      bumpPane("mk-from-left");
                    }}
                  >
                    ◀ 上一页
                  </button>
                  <span className="mk-pager-info">
                    第 {page} / {totalPages} 页 · 共 {formatCount(market?.total)} 个
                  </span>
                  <button
                    className="pm-btn pm-btn-sm"
                    type="button"
                    disabled={page >= totalPages || marketLoading}
                    onClick={() => {
                      setPage((p) => p + 1);
                      bumpPane("mk-from-right");
                    }}
                  >
                    下一页 ▶
                  </button>
                </div>
              ) : (
                <span />
              )}
              <button className="pm-btn primary" type="button" onClick={() => setOpen(false)}>
                关闭
              </button>
            </div>
          )
        }
      >
        {/* 视图切换上浮缩放过渡 */}
        <div key={view} className="mk-view-enter">{view === "market" ? marketBody : terminalBody}</div>
      </AppModal>

      {/* 插件介绍小弹框 */}
      <AppModal
        open={descRow !== null}
        className="pm-desc-modal"
        title={descRow ? `插件介绍 · ${descRow.name}` : "插件介绍"}
        footer={null}
        width={560}
        onCancel={() => setDescRow(null)}
      >
        {descRow ? (
          <div className="pm-desc-body">
            <div className="pm-desc-meta">
              <Avatar url={descRow.avatarUrl} name={descRow.author} />
              <span className="mk-name">{descRow.name}</span>
              {descRow.latest ? <span className="plugin-ver">v{descRow.latest}</span> : null}
              {descRow.installedHere && descRow.current ? (
                <span className="plugin-ver">(本机 v{descRow.current})</span>
              ) : null}
            </div>
            <div className="pm-desc-text">
              {descRow.description ? (
                descRow.description
              ) : (
                <span className="mk-desc-empty">暂无介绍</span>
              )}
            </div>
          </div>
        ) : null}
      </AppModal>

      {/* 手动安装输入弹框 */}
      <AppModal
        open={addOpen}
        className="plugin-manager-modal"
        title="手动安装插件"
        okText="保存并安装"
        cancelText="取消"
        width={440}
        onCancel={() => setAddOpen(false)}
        onOk={submitAdd}
      >
        <Input
          placeholder="请输入插件名称"
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onPressEnter={submitAdd}
        />
        <div className="plugin-add-hint">
          将执行 dsh plugin --profile web add {'{'}规格{'}'}；支持包名、name@version 或 github:user/repo
        </div>
      </AppModal>
    </>
  );
}
