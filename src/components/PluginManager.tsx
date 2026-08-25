import { ClusterOutlined } from "@ant-design/icons";
import { App as AntApp, Badge, Input, Modal, Tooltip } from "antd";
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

/**
 * 插件管理：标题栏入口 + 大尺寸插件市场弹框。
 * 市场视图：GitHub/NPM 双源搜索、排序、分页、安装/更新/卸载；
 * 终端视图：流式展示 `dsh plugin` 操作日志，支持终止与后台运行。
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

  useEffect(() => {
    if (!initialized) void init();
  }, [initialized, init]);

  // 搜索防抖
  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(queryInput);
      setPage(1);
    }, 400);
    return () => clearTimeout(t);
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

  const switchSource = (s: MarketSource) => {
    setSource(s);
    setSort(s === "github" ? "stars" : "weekly");
    setPage(1);
    setQuery("");
    setQueryInput("");
  };

  /** 行内操作按钮组（市场行 / 已安装 tab 行共用） */
  const renderActions = (name: string, spec: string, installedHere: boolean) => (
    <div className="mk-actions">
      {!installedHere ? (
        <button
          className="pm-btn pm-btn-sm primary"
          type="button"
          disabled={running}
          onClick={() => confirmOp("add", spec)}
        >
          安装
        </button>
      ) : null}
      {installedHere && isOutdated(name) ? (
        <button
          className="pm-btn pm-btn-sm"
          type="button"
          disabled={running}
          onClick={() => confirmOp("update", name)}
        >
          更新
        </button>
      ) : null}
      {installedHere ? (
        <button
          className="pm-btn pm-btn-sm danger"
          type="button"
          disabled={running}
          onClick={() => confirmOp("remove", name)}
        >
          卸载
        </button>
      ) : null}
    </div>
  );

  const sortChips: Array<{ key: MarketSort; label: string; disabledIn: MarketSource[] }> = [
    { key: "weekly", label: "周下载", disabledIn: ["github"] },
    { key: "stars", label: "Stars", disabledIn: ["npm"] },
    { key: "date", label: "发布日期", disabledIn: [] },
  ];

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
            onClick={() => {
              setTabMode("all");
              setPage(1);
            }}
          >
            所有插件({formatCount(tabMode === "all" ? market?.total : market?.total)})
          </button>
          <button
            type="button"
            className={tabMode === "installed" ? "active" : ""}
            onClick={() => {
              setTabMode("installed");
              void refreshPluginVersions();
            }}
          >
            已安装({plugins.length})
          </button>
        </div>
        <div className="pm-seg mk-sort">
          {sortChips.map((c) => (
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

      <div className={`mk-table${marketLoading ? " loading" : ""}`}>
        <div className="mk-head mk-grid">
          <span>#</span>
          <span />
          <span>插件名称</span>
          <span>作者</span>
          <span>周/月下载</span>
          <span>版本</span>
          <span>Stars</span>
          <span>发布日期</span>
          <span className="mk-right">操作</span>
        </div>

        {tabMode === "installed" ? (
          plugins.length === 0 ? (
            <div className="mk-empty">本机尚未安装任何插件</div>
          ) : (
            plugins.map((p, i) => {
              const info = pluginVers[p];
              return (
                <div key={p} className="mk-row mk-grid">
                  <span className="mk-num">{i + 1}</span>
                  <Avatar url={null} name={p} />
                  <span className="mk-name" title={p}>
                    {p}
                    {info?.current ? <span className="plugin-ver">{info.current}</span> : null}
                    {isOutdated(p) && info?.latest ? (
                      <span className="plugin-ver new">→ {info.latest}</span>
                    ) : null}
                  </span>
                  <span className="mk-author">本机</span>
                  <span className="mk-num muted">—</span>
                  <span className="mk-num">
                    {info?.latest ? `最新 ${info.latest}` : info?.current ?? "—"}
                  </span>
                  <span className="mk-num muted">—</span>
                  <span className="mk-num muted">—</span>
                  {renderActions(p, p, true)}
                </div>
              );
            })
          )
        ) : marketError ? (
          <div className="mk-empty mk-error">{marketError}</div>
        ) : !market || market.items.length === 0 ? (
          <div className="mk-empty">{marketLoading ? "加载中…" : "无匹配插件"}</div>
        ) : (
          market.items.map((it, idx) => {
            const installed = installedSet.has(it.name);
            return (
              <div key={it.key} className="mk-row mk-grid">
                <span className="mk-num">{(page - 1) * pageSizeOf(source) + idx + 1}</span>
                <Avatar url={it.avatarUrl} name={it.author} />
                <span className="mk-name" title={it.name}>
                  {it.name}
                </span>
                <span className="mk-author" title={it.author}>
                  {it.author}
                </span>
                <span className="mk-num">
                  {formatCount(it.weekly)} / {formatCount(it.monthly)}
                </span>
                <span className="mk-num">
                  {it.version ?? "—"}
                  {installed && pluginVers[it.name]?.current ? (
                    <span className="plugin-ver">(已装 v{pluginVers[it.name]?.current})</span>
                  ) : null}
                </span>
                <span className="mk-num">{it.stars === null ? "—" : `★ ${formatCount(it.stars)}`}</span>
                <span className="mk-num">{formatDate(it.releasedAt)}</span>
                {renderActions(it.name, it.spec, installed)}
              </div>
            );
          })
        )}

        {marketLoading ? (
          <div className="mk-loading-overlay">
            <span className="spinner-ring" />
          </div>
        ) : null}
      </div>

      {tabMode === "all" ? (
        <div className="mk-pager">
          <button
            className="pm-btn pm-btn-sm"
            type="button"
            disabled={page <= 1 || marketLoading}
            onClick={() => setPage((p) => p - 1)}
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
            onClick={() => setPage((p) => p + 1)}
          >
            下一页 ▶
          </button>
        </div>
      ) : null}
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
                    终止安装
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
        {view === "market" ? marketBody : terminalBody}
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
