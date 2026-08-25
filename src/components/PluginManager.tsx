import { ClusterOutlined } from "@ant-design/icons";
import { App as AntApp, Badge, Input, Modal, Table, Tooltip } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useEffect, useRef, useState } from "react";
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

/** 表格行数据（市场行与已安装行统一） */
interface MkRow {
  key: string;
  seq: number;
  name: string;
  spec: string;
  author: string;
  avatarUrl: string | null;
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
  const bodyRef = useRef<HTMLDivElement>(null);
  const prevRunningRef = useRef<boolean>(false);

  // ---- 市场状态 ----
  const [source, setSource] = useState<MarketSource>("npm");
  const [tabMode, setTabMode] = useState<"all" | "installed">("all");
  const [queryInput, setQueryInput] = useState("");
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

  // 搜索防抖（提交时内容区渐隐过渡）
  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(queryInput);
      setPage(1);
      bumpPane("mk-fade");
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryInput]);

  // 市场数据拉取（仅市场视图 + 所有插件 tab）
  useEffect(() => {
    if (!open || view !== "market" || tabMode !== "all") return;
    let alive = true;
    setMarketLoading(true);
    setMarketError(null);
    fetchMarketPage(source, page, query, sort)
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
  }, [open, view, tabMode, source, query, sort, page]);

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
    setQuery("");
    setQueryInput("");
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
        setView("terminal");
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
    setAddOpen(false);
    setName("");
    setView("terminal");
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
      title: "#",
      key: "seq",
      width: 48,
      render: (_, r) => <span className="mk-num">{r.seq}</span>,
    },
    {
      title: "",
      key: "avatar",
      width: 52,
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
      width: 156,
      render: renderActions,
    },
  ];

  // ---- 数据源组装 ----
  const allRows: MkRow[] = (market?.items ?? []).map((it, idx) => ({
    key: it.key,
    seq: (page - 1) * pageSizeOf(source) + idx + 1,
    name: it.name,
    spec: it.spec,
    author: it.author,
    avatarUrl: it.avatarUrl,
    weekly: it.weekly,
    monthly: it.monthly,
    stars: it.stars,
    latest: it.version,
    releasedAt: it.releasedAt,
    installedHere: installedSet.has(it.name),
    current: pluginVers[it.name]?.current ?? null,
  }));

  const installedRows: MkRow[] = plugins.map((p, idx) => ({
    key: p,
    seq: idx + 1,
    name: p,
    spec: p,
    author: "本机",
    avatarUrl: null,
    weekly: null,
    monthly: null,
    stars: null,
    latest: pluginVers[p]?.latest ?? null,
    releasedAt: null,
    installedHere: true,
    current: pluginVers[p]?.current ?? null,
  }));

  const rows = tabMode === "all" ? allRows : installedRows;

  const marketBody = (
    <div className="mk-wrap">
      <div className="mk-toolbar">
        <Input
          className="mk-search"
          placeholder="搜索插件…"
          allowClear
          value={queryInput}
          onChange={(e) => setQueryInput(e.target.value)}
        />
        <div className="pm-seg">
          <button
            type="button"
            className={tabMode === "all" ? "active" : ""}
            onClick={() => switchTab("all")}
          >
            所有插件({formatCount(tabMode === "all" ? market?.total : market?.total)})
          </button>
          <button
            type="button"
            className={tabMode === "installed" ? "active" : ""}
            onClick={() => switchTab("installed")}
          >
            已安装({plugins.length})
          </button>
        </div>
        <div className="pm-seg mk-sort">
          {(
            [
              { key: "weekly", label: "周下载", disabledIn: ["github"] },
              { key: "stars", label: "Stars", disabledIn: ["npm"] },
              { key: "date", label: "发布日期", disabledIn: [] },
            ] as Array<{ key: MarketSort; label: string; disabledIn: MarketSource[] }>
          ).map((c) => (
            <button
              key={c.key}
              type="button"
              title={c.disabledIn.includes(source) ? "当前插件源不支持该排序" : undefined}
              className={
                (sort === c.key && tabMode === "all" ? "active" : "") +
                (c.disabledIn.includes(source) ? " disabled" : "")
              }
              disabled={c.disabledIn.includes(source)}
              onClick={() => {
                setSort(c.key);
                setPage(1);
                bumpPane("mk-fade");
              }}
            >
              {c.label}
            </button>
          ))}
        </div>
        <button className="pm-btn pm-btn-sm" type="button" onClick={() => setAddOpen(true)}>
          手动安装
        </button>
      </div>

      {marketError ? <div className="mk-error">{marketError}</div> : null}

      {/* 穿梭动画面板：tab/源/翻页/搜索变化时按方向滑入 */}
      <div key={paneAnim.n} className={`mk-pane ${paneAnim.cls}`}>
        <Table
          className="mk-ant-table"
          size="small"
          rowKey="key"
          columns={columns}
          dataSource={rows}
          loading={marketLoading && tabMode === "all"}
          pagination={false}
          sticky
          scroll={{ x: 1010 }}
          locale={{
            emptyText: tabMode === "installed" ? "本机尚未安装任何插件" : "无匹配插件",
          }}
        />

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
        ) : null}
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

      <Modal
        open={open}
        className={`plugin-manager-modal${view === "market" ? " mk-market" : ""}`}
        onCancel={() => setOpen(false)}
        width={1080}
        title={
          view === "terminal" ? (
            `正在${OP_VERB[pluginOp?.kind ?? "add"]} · ${pluginOp?.name ?? ""}`
          ) : (
            <div className="pm-title-row">
              <span>插件管理</span>
              <div className="pm-seg">
                <button
                  type="button"
                  className={source === "github" ? "active" : ""}
                  onClick={() => switchSource("github")}
                >
                  GitHub
                </button>
                <button
                  type="button"
                  className={source === "npm" ? "active" : ""}
                  onClick={() => switchSource("npm")}
                >
                  NPM
                </button>
              </div>
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
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button className="pm-btn primary" type="button" onClick={() => setOpen(false)}>
                关闭
              </button>
            </div>
          )
        }
      >
        {/* 视图切换上浮缩放过渡 */}
        <div key={view} className="mk-view-enter">{view === "market" ? marketBody : terminalBody}</div>
      </Modal>

      {/* 手动安装输入弹框 */}
      <Modal
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
      </Modal>
    </>
  );
}
