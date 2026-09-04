import { SearchOutlined } from "@ant-design/icons";
import { App as AntApp, Input, Table } from "antd";
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
import { MARK } from "../lib/logFormat";

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

/** 小写化并去掉 -/_/. 与空白分隔符：dsh_jenkins / DshJenkins / dsh-jenkins 归一化后同形 */
function normalizeFuzzy(s: string): string {
  return s.toLowerCase().replace(/[-_.\s]/g, "");
}

/**
 * 插件名模糊匹配（忽略大小写）：除直接小写包含外，还按归一化分隔符后的形态比较，
 * 因此 dsh_jenkins、DshJenkins、dsh-jenkins 均可互相命中。
 */
function nameMatches(name: string, rawQuery: string): boolean {
  const q = rawQuery.trim();
  if (!q) return true;
  if (name.toLowerCase().includes(q.toLowerCase())) return true;
  const nq = normalizeFuzzy(q);
  // 归一化后为空（查询仅含分隔符）时跳过归一化比较，避免空串命中所有行
  if (!nq) return false;
  return normalizeFuzzy(name).includes(nq);
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
 * 插件管理面板（设置页内嵌）：原插件管理弹框去模态化，作为设置页的一个区块展示。
 * 面板自带头部（来源切换）/ 工具栏 / 表格（或操作终端）/ 底部操作条；
 * 插件详情与手动安装仍为弹框（覆盖层），插件操作后台执行、完成事件驱动列表刷新。
 */
export default function PluginManagerPanel() {
  const { modal, message } = AntApp.useApp();
  const plugins = useAppStore((s) => s.plugins);
  const initialized = useAppStore((s) => s.initialized);
  const init = useAppStore((s) => s.init);
  const refreshStatus = useAppStore((s) => s.refreshStatus);
  const pluginOp = useAppStore((s) => s.pluginOp);
  const pluginOpLogs = useAppStore((s) => s.pluginOpLogs);
  const startPluginOp = useAppStore((s) => s.startPluginOp);
  const pluginVers = useAppStore((s) => s.pluginVers);
  const refreshPluginVersions = useAppStore((s) => s.refreshPluginVersions);

  const [view, setView] = useState<"market" | "terminal">("market");
  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState("");
  /** 详情弹框当前展示的插件行 */
  const [detailRow, setDetailRow] = useState<MkRow | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const prevRunningRef = useRef<boolean>(false);

  // ---- 市场状态 ----
  const [source, setSource] = useState<MarketSource>("npm");
  const [tabMode, setTabMode] = useState<"all" | "installed">("all");
  /** 每个 tab 独立的关键词：选中哪个 tab 就用哪份关键词搜索，互不干扰 */
  const [queries, setQueries] = useState<{ all: string; installed: string }>({
    all: "",
    installed: "",
  });
  /** 【所有插件】tab 实际参与请求的搜索词（点击搜索按钮或回车提交）；变化即换词重搜 */
  const [submittedQuery, setSubmittedQuery] = useState("");
  /** 搜索序号：每次提交自增——相同关键词的重复提交也能强制重搜（如限流/失败后重试） */
  const [searchSeq, setSearchSeq] = useState(0);
  /** 当前 tab 生效的搜索关键词 */
  const query = queries[tabMode];
  const [sort, setSort] = useState<MarketSort>("weekly");
  const [page, setPage] = useState(1);
  /** 当前页市场数据（服务端分页返回） */
  const [market, setMarket] = useState<MarketPage | null>(null);
  const [marketLoading, setMarketLoading] = useState(false);
  const [marketError, setMarketError] = useState<string | null>(null);
  /** 内容区穿梭动画：n 变化触发重挂载，cls 决定入场方向 */
  const [paneAnim, setPaneAnim] = useState<{ n: number; cls: string }>({ n: 0, cls: "" });
  const bumpPane = (cls: string) => setPaneAnim((p) => ({ n: p.n + 1, cls }));

  useEffect(() => {
    if (!initialized) void init();
  }, [initialized, init]);

  // 面板挂载即拉取已安装插件的最新版本信息（弹框时代是打开时拉取）
  useEffect(() => {
    void refreshPluginVersions();
  }, [refreshPluginVersions]);

  // 提交搜索（仅【所有插件】tab 的服务端搜索）：只有点击搜索按钮或输入框回车才触发，
  // 同批把分页重置到第 1 页——避免逐字输入即发请求触发限流、旧页码越界搜不到。
  // searchSeq 自增让相同关键词的重复提交也能强制重搜（例如限流/失败后的重试）；
  // setSubmittedQuery/setPage/setSearchSeq 同批提交，只会触发一次请求。
  // 【已安装】tab 使用自己的关键词做本地即时过滤，不走此流程。
  const submitSearch = () => {
    if (tabMode !== "all") return;
    setSubmittedQuery(queries.all);
    setPage(1);
    setSearchSeq((n) => n + 1);
  };

  // 市场数据拉取（仅市场视图 + 所有插件 tab）：服务端关键词分页搜索。
  // 默认搜索词为 dsh-plugin 全集；仅提交搜索后换词重搜（由 submittedQuery / searchSeq 驱动）。
  // 加载态用 useApp 的 message 顶部提示（固定 key 避免叠加），完成即销毁；
  // alive 标志丢弃过期响应，快速连续搜索时只有最后一次生效。
  useEffect(() => {
    // 浏览器预览模式不拉市场数据（面板只展示占位提示）
    if (!tauri || view !== "market" || tabMode !== "all") return;
    let alive = true;
    setMarketLoading(true);
    setMarketError(null);
    message.open({
      key: "mk-market-loading",
      type: "loading",
      content: "正在搜索插件…",
      duration: 0,
    });
    fetchMarketPage(source, submittedQuery, page, sort)
      .then((p) => {
        if (alive) setMarket(p);
      })
      .catch((e) => {
        if (alive) setMarketError(String(e instanceof Error ? e.message : e));
      })
      .finally(() => {
        message.destroy("mk-market-loading");
        if (alive) setMarketLoading(false);
      });
    return () => {
      alive = false;
      message.destroy("mk-market-loading");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, tabMode, source, sort, page, submittedQuery, searchSeq]);

  // 终端自动滚动到底部
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [pluginOpLogs.at(-1)?.id]);

  // 完成监听：running → false 转变时提示并刷新列表与版本信息（无论面板是否挂载）
  useEffect(() => {
    const running = pluginOp?.running ?? false;
    if (prevRunningRef.current && !running && pluginOp) {
      message.info("插件已变更，请稍后刷新页面或重启服务");
      void refreshStatus();
      void refreshPluginVersions();
    }
    prevRunningRef.current = running;
  }, [pluginOp?.running, pluginOp, message, refreshStatus, refreshPluginVersions]);

  if (!tauri) {
    return (
      <>
        <div className="settings-nav">
          <span className="settings-nav-title">插件管理</span>
        </div>
        <div className="settings-body">
          <div className="mk-empty">浏览器预览模式：插件管理需在桌面应用内操作</div>
        </div>
      </>
    );
  }

  const running = pluginOp?.running ?? false;
  const installedSet = new Set(plugins);

  const isOutdated = (n: string) => {
    const c = pluginVers[n]?.current;
    const l = pluginVers[n]?.latest;
    return !!c && !!l && c !== l;
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

  const submitAdd = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      message.warning("请输入插件名称");
      return;
    }
    // 仅关闭手动安装输入弹框；插件管理面板保持打开，操作在后台执行
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
      {!r.installedHere ? (
        <button
          className="pm-btn pm-btn-sm primary"
          type="button"
          disabled={running}
          onClick={(e) => {
            // 不再弹确认框：先展示完整插件信息（详情弹框），安装动作在详情内直接执行；
            // 阻止冒泡避免同时触发行点击重复打开详情
            e.stopPropagation();
            setDetailRow(r);
          }}
        >
          {source === "github" ? "源码安装" : "一键安装"}
        </button>
      ) : null}
      {/* 已安装状态下：所有插件 tab 显示"已安装"占位；已安装 tab 显示更新/卸载 */}
      {r.installedHere && tabMode === "all" ? (
        <span className="pm-btn pm-btn-sm mk-installed-tag">已安装</span>
      ) : null}
      {r.installedHere && tabMode === "installed" && isOutdated(r.name) ? (
        <button
          className="pm-btn pm-btn-sm"
          type="button"
          disabled={running}
          onClick={(e) => {
            // 与安装一致：不弹确认框，先打开详情展示当前/最新版本，更新在详情内直接执行
            e.stopPropagation();
            setDetailRow(r);
          }}
        >
          更新
        </button>
      ) : null}
      {r.installedHere && tabMode === "installed" ? (
        <button
          className="pm-btn pm-btn-sm danger"
          type="button"
          disabled={running}
          onClick={(e) => {
            // 与安装/更新一致：不弹确认框，先打开详情展示插件信息，卸载在详情内直接执行
            e.stopPropagation();
            setDetailRow(r);
          }}
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
      width: 48,
      render: (_, r) => <Avatar url={r.avatarUrl} name={r.author} />,
    },
    {
      // 主 cell：插件名称/作者/版本 + 描述（上下布局）
      // 必须设固定 width：antd 在 scroll.x 下未设 width 的列会按内容撑宽，
      // 长描述会把表格撑破；固定列宽后描述在列宽内单行省略。
      // 给足宽度保证插件名完整展示不换行截断。
      title: "插件名称",
      key: "plugin",
      width: 440,
      render: (_, r) => (
        <div className="mk-plugin-cell">
          <div className="mk-plugin-head">
            <span className="mk-name" title={r.name}>
              {r.name}
            </span>
            {r.author && r.author !== "—" ? (
              <span className="mk-author" title={r.author}>
                @{r.author}
              </span>
            ) : null}
            {r.installedHere && r.current ? (
              <span className="plugin-ver">v{r.current}</span>
            ) : r.latest ? (
              <span className="plugin-ver">v{r.latest}</span>
            ) : null}
            {isOutdated(r.name) && pluginVers[r.name]?.latest ? (
              <span className="plugin-ver new">→ v{pluginVers[r.name]?.latest}</span>
            ) : null}
          </div>
          {/* 描述：单行省略 */}
          <div className="mk-desc">
            {r.description ? (
              r.description
            ) : (
              <span className="mk-desc-empty">暂无描述</span>
            )}
          </div>
        </div>
      ),
    },
    {
      // 指标列：NPM 源显示周下载，GitHub 源显示 Stars（标题随源切换）
      title: source === "github" ? "Stars" : "周下载",
      key: "metric",
      width: 110,
      render: (_, r) =>
        source === "github" ? (
          <span className={`mk-num${r.stars === null ? " muted" : ""}`}>
            {r.stars === null ? "—" : `★ ${formatCount(r.stars)}`}
          </span>
        ) : (
          <span className={`mk-num${r.weekly === null ? " muted" : ""}`}>
            {r.weekly === null ? "—" : formatCount(r.weekly)}
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
      // 操作列：表头与单元格统一右对齐，收窄宽度把空间让给插件名称列
      title: "操作",
      key: "actions",
      width: 124,
      align: "right",
      render: renderActions,
    },
  ];

  // ---- 数据源组装（服务端分页结果直接渲染；已安装 tab 保留本地模糊过滤）----
  const totalPages = Math.max(1, Math.ceil((market?.total ?? 0) / pageSizeOf(source)));
  const safePage = Math.min(page, totalPages);

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

  // 已安装 tab：本地名称模糊过滤（使用本 tab 独立的关键词）
  const visibleInstalled = plugins.filter((p) => nameMatches(p, queries.installed));
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

  const rows = tabMode === "all" ? allRows : installedRows;

  const marketBody = (
    <div className="mk-wrap">
      {/* 工具栏区域（固定）：进行中横幅 + 搜索工具栏 + 加载/错误提示，不随表格滚动 */}
      <div className="mk-toolbar-area">
        {running && pluginOp ? (
          <div className="mk-op-banner">
            <span className="mk-op-spinner" />
            <span>
              正在{OP_VERB[pluginOp.kind]} <b>{pluginOp.name}</b>…
            </span>
            <button
              className="pm-btn pm-btn-sm primary"
              type="button"
              onClick={() => setView("terminal")}
            >
              进入后台安装
            </button>
          </div>
        ) : null}
        {/* 工具栏两行：第一行 搜索框；第二行 视图tab(左) + 排序·手动安装(右) */}
        <div className="mk-toolbar">
          <div className="mk-row">
            <Input
              className="mk-search"
              placeholder="搜索插件：NPM 按 keywords 匹配包标签 · GitHub 关键词原样搜索；未输入时展示 dsh-plugin 全集"
              allowClear
              prefix={<SearchOutlined style={{ color: "var(--text-3)" }} />}
              value={query}
              onChange={(e) => {
                const v = e.target.value;
                setQueries((prev) => ({ ...prev, [tabMode]: v }));
              }}
              onPressEnter={submitSearch}
            />
            {/* 搜索按钮：与回车等价的唯一显式提交入口；输入过程不自动触发请求 */}
            <button
              className="pm-btn pm-btn-sm mk-search-btn"
              type="button"
              disabled={marketLoading}
              onClick={submitSearch}
            >
              搜索
            </button>
          </div>
          <div className="mk-row">
            <SlidingSeg
              value={tabMode}
              options={[
                {
                  key: "all",
                  label: "所有插件(" + formatCount(market?.total) + ")",
                },
                { key: "installed", label: "已安装(" + visibleInstalled.length + ")" },
              ]}
              onChange={switchTab}
            />
            <div className="mk-row-right">
              {/* 排序项随源动态展示：GitHub 无周下载、NPM 无 Stars */}
              {tabMode === "all" ? (
                <SlidingSeg
                  className="mk-row-sort"
                  value={sort}
                  options={[
                    ...(source === "npm" ? [{ key: "weekly" as MarketSort, label: "周下载" }] : []),
                    ...(source === "github"
                      ? [{ key: "stars" as MarketSort, label: "Stars" }]
                      : []),
                    { key: "date" as MarketSort, label: "发布日期" },
                  ]}
                  onChange={(k) => {
                    setSort(k);
                    setPage(1);
                    bumpPane("mk-fade");
                  }}
                />
              ) : null}
              <button className="pm-btn pm-btn-sm mk-add-btn" type="button" onClick={() => setAddOpen(true)}>
                手动安装
              </button>
            </div>
          </div>
        </div>
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
          scroll={{ x: 820 }}
          onRow={(r) => ({
            onClick: () => setDetailRow(r),
            title: "查看插件详情",
          })}
          locale={{
            emptyText:
              tabMode === "installed"
                ? query.trim()
                  ? "没有匹配的已安装插件"
                  : "本机尚未安装任何插件"
                : marketLoading
                  ? "正在搜索…"
                  : submittedQuery.trim()
                    ? "没有匹配的插件，可更换关键词重试"
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
      <div className="settings-nav">
        <span className="settings-nav-title">插件管理</span>
      </div>
      <div className="settings-body flush">
        {/* 复用 plugin-manager-modal 命名空间：其下的 .mk-* 样式（工具栏/表格/终端）原样生效 */}
        <div className="pm-panel plugin-manager-modal">
          {/* 面板头部：来源切换（GitHub / NPM） */}
          <div className="pm-panel-head">
            <SlidingSeg
              value={source}
              options={[
                { key: "github", label: "GitHub" },
                { key: "npm", label: "NPM" },
              ]}
              onChange={(s) => switchSource(s)}
            />
          </div>

          {/* 视图主体：市场列表 / 操作终端（上浮缩放过渡） */}
          <div key={view} className="mk-view-enter">
            {view === "market" ? marketBody : terminalBody}
          </div>

          {/* 面板底部：市场视图显示分页；终端视图显示操作按钮 */}
          <div className="pm-panel-foot">
            {view === "terminal" ? (
              <div className="pm-panel-foot-actions">
                <button
                  className="pm-btn"
                  type="button"
                  onClick={() => {
                    setView("market");
                    bumpPane("mk-from-left");
                  }}
                >
                  返回列表
                </button>
                {running ? (
                  <button className="pm-btn danger" type="button" onClick={cancelOpConfirm}>
                    终止操作
                  </button>
                ) : null}
              </div>
            ) : tabMode === "all" ? (
              <div className="mk-pager">
                <button
                  className="pm-btn pm-btn-sm"
                  type="button"
                  disabled={safePage <= 1 || marketLoading}
                  onClick={() => {
                    setPage((p) => p - 1);
                    bumpPane("mk-from-left");
                  }}
                >
                  ◀ 上一页
                </button>
                <span className="mk-pager-info">
                  第 {safePage} / {totalPages} 页 · 共 {formatCount(market?.total)} 个
                </span>
                <button
                  className="pm-btn pm-btn-sm"
                  type="button"
                  disabled={safePage >= totalPages || marketLoading}
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
          </div>
        </div>
      </div>

      {/* 插件详情弹框：点击插件行打开 */}
      <AppModal
        open={detailRow !== null}
        className="pm-detail-modal"
        title={detailRow ? detailRow.name : "插件详情"}
        width={560}
        onCancel={() => setDetailRow(null)}
        footer={
          detailRow ? (
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              {!detailRow.installedHere ? (
                <button
                  className="pm-btn primary"
                  type="button"
                  disabled={running}
                  onClick={() => {
                    const row = detailRow;
                    setDetailRow(null);
                    // 详情页已明确展示插件来源与版本信息，点击即安装（后台执行），不再二次确认
                    void startPluginOp("add", row.spec);
                  }}
                >
                  {source === "github" ? "源码安装" : "一键安装"}
                </button>
              ) : null}
              {detailRow.installedHere && isOutdated(detailRow.name) ? (
                <button
                  className="pm-btn"
                  type="button"
                  disabled={running}
                  onClick={() => {
                    const row = detailRow;
                    setDetailRow(null);
                    // 详情页已明确展示本机版本与最新版本，点击即更新（后台执行），不再二次确认
                    void startPluginOp("update", row.name);
                  }}
                >
                  更新
                </button>
              ) : null}
              {detailRow.installedHere ? (
                <button
                  className="pm-btn danger"
                  type="button"
                  disabled={running}
                  onClick={async () => {
                    const row = detailRow;
                    setDetailRow(null);
                    // 卸载只移除 bundles 并登记待清理依赖；dependencies 与
                    // node_modules 保持不动（服务运行中卸载不会崩溃），残留
                    // 依赖在下次启动 pnpm install 时统一清理
                    try {
                      await api.removePlugin(row.name);
                      message.success(`已移除插件 ${row.name}，残留依赖将在下次启动时清理`);
                      void refreshStatus();
                      void refreshPluginVersions();
                    } catch (e) {
                      message.error(`移除插件失败：${e instanceof Error ? e.message : String(e)}`);
                    }
                  }}
                >
                  卸载
                </button>
              ) : null}
              <button className="pm-btn" type="button" onClick={() => setDetailRow(null)}>
                关闭
              </button>
            </div>
          ) : null
        }
      >
        {detailRow ? (
          <div className="pm-detail-body">
            <div className="pm-detail-head">
              <Avatar url={detailRow.avatarUrl} name={detailRow.author} />
              <div className="pm-detail-title">
                <div className="pm-detail-name">
                  <span className="mk-name">{detailRow.name}</span>
                  {/* 安装状态徽标 */}
                  {detailRow.installedHere ? (
                    <span className="pm-detail-badge installed">已安装</span>
                  ) : (
                    <span className="pm-detail-badge">未安装</span>
                  )}
                  {/* 更新可用提示 */}
                  {detailRow.installedHere && isOutdated(detailRow.name) && pluginVers[detailRow.name]?.latest ? (
                    <span className="pm-detail-badge update">
                      可更新 → v{pluginVers[detailRow.name]?.latest}
                    </span>
                  ) : null}
                </div>
                <div className="pm-detail-meta">
                  {detailRow.author && detailRow.author !== "—" ? (
                    <span className="mk-author">作者：@{detailRow.author}</span>
                  ) : null}
                  <span className="pm-detail-spec">{detailRow.spec}</span>
                </div>
                <div className="pm-detail-versions">
                  {detailRow.installedHere && detailRow.current ? (
                    <span className="pm-detail-version">
                      本机版本 <b>v{detailRow.current}</b>
                    </span>
                  ) : null}
                  {detailRow.latest ? (
                    <span className="pm-detail-version">
                      最新版本 <b>v{detailRow.latest}</b>
                    </span>
                  ) : null}
                  {!detailRow.installedHere && !detailRow.latest ? (
                    <span className="pm-detail-version muted">版本信息暂不可用</span>
                  ) : null}
                </div>
              </div>
            </div>
            <div className="pm-detail-stats">
              {detailRow.weekly !== null ? (
                <span className="pm-detail-stat">
                  周下载 <b>{formatCount(detailRow.weekly)}</b>
                </span>
              ) : null}
              {detailRow.monthly !== null ? (
                <span className="pm-detail-stat">
                  月下载 <b>{formatCount(detailRow.monthly)}</b>
                </span>
              ) : null}
              {detailRow.stars !== null ? (
                <span className="pm-detail-stat">
                  Stars <b>★ {formatCount(detailRow.stars)}</b>
                </span>
              ) : null}
              {detailRow.releasedAt ? (
                <span className="pm-detail-stat">
                  更新于 <b>{formatDate(detailRow.releasedAt)}</b>
                </span>
              ) : null}
            </div>
            <div className="pm-detail-desc">
              {detailRow.description ? (
                detailRow.description
              ) : (
                <span className="mk-desc-empty">暂无描述</span>
              )}
            </div>
            {/* 免责声明 */}
            <div className="pm-detail-disclaimer">
              以上插件均来自开源社区、由第三方作者维护。本软件不参与插件开发，
              也未对插件内容做安全审查或作出任何承诺——请自行评估风险，
              确认信任来源后再决定是否安装。
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
