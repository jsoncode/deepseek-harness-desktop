import { App as AntApp } from "antd";
import { CopyOutlined, DeleteOutlined, ReloadOutlined } from "@ant-design/icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AppModal from "../AppModal";
import SlidingSeg from "../SlidingSeg";
import { api, nativeConfirm, tauri, type LogSessionMeta } from "../../lib/tauri";
import { useAppStore } from "../../store/useAppStore";

/** 会话状态 → 徽标文案与样式类 */
const STATUS_META: Record<string, { label: string; cls: string }> = {
  active: { label: "进行中", cls: "active" },
  success: { label: "成功", cls: "success" },
  error: { label: "失败", cls: "error" },
  closed: { label: "已结束", cls: "closed" },
};

/**
 * 进行中会话的自动刷新间隔：日志行数/时长/状态都是随时间变化的值，
 * 轮询间隔取 2s——与详情弹框跟随活动会话的轮询（pollRemoteActive）同节奏，
 * 单个会话文件只有几十 KB，读取开销可忽略。
 */
const AUTO_REFRESH_MS = 2000;

/** unix 秒 → 本地时间字符串 */
function formatTs(ts: number): string {
  return new Date(ts * 1000).toLocaleString("zh-CN", { hour12: false });
}

/** 会话时长（未结束按当前时间计） */
function formatDuration(start: number, end: number | null): string {
  const secs = Math.max(0, Math.round((end ?? Date.now() / 1000) - start));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

interface DetailRow {
  key: string;
  time: string;
  stream: string;
  text: string;
}

/**
 * 会话在列表中显示为「进行中」：磁盘 header 仍是 active。
 * 注意不能只看 status——应用崩溃/强杀会留下 status=active 的僵尸会话，
 * 因此这里只用于判断是否值得继续轮询（僵尸会话由启动时的 finalize_active
 * 收敛为 closed，之后轮询自然停止）。
 */
function isActiveSession(s: LogSessionMeta): boolean {
  return s.status === "active";
}

/**
 * 日志管理（设置页区块）：列出每次服务启动/重启产生的日志会话记录，
 * 点击记录弹框查看完整日志输出；支持刷新、清空与复制。
 * - 桌面端：会话列表/内容由 Rust 侧落盘（logs/*.jsonl），应用重启后历史可查；
 *   当前活动会话（id 与 store.logSessionId 一致）实时展示内存日志
 * - 浏览器预览模式：仅展示「当前会话」伪记录，内容直接读内存日志
 */
export default function LogManagerSettings() {
  const { message } = AntApp.useApp();
  const logs = useAppStore((s) => s.logs);
  const logSessionId = useAppStore((s) => s.logSessionId);
  // 进行中的操作（驱动自动刷新）：插件操作 / dsh CLI 更新的会话由 Rust 侧落盘，
  // 状态变化不经过本组件，只能靠这两个运行标记知道「还会有新日志写进来」
  const pluginOpRunning = useAppStore((s) => s.pluginOp?.running ?? false);
  const dshUpdateRunning = useAppStore((s) => s.dshUpdate?.running ?? false);
  const envInstallTool = useAppStore((s) => s.envInstallTool);
  const phase = useAppStore((s) => s.phase);

  const [sessions, setSessions] = useState<LogSessionMeta[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<LogSessionMeta | null>(null);
  const [detailLines, setDetailLines] = useState<Array<{ time: string; stream: string; text: string }> | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  /** 日志类型筛选：all=全部 / service=服务日志 / plugin=插件操作日志 */
  const [kindFilter, setKindFilter] = useState<"all" | "service" | "plugin" | "env">("all");
  const bodyRef = useRef<HTMLDivElement>(null);
  /** 列表是否已成功加载过：首次加载才展示整页 spinner，之后刷新保持列表可见 */
  const loadedOnceRef = useRef(false);

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!tauri) return;
    const silent = opts?.silent ?? false;
    // 首次加载（无数据可展示）不静默：否则界面空白、用户以为坏了
    const showSpinner = !silent || !loadedOnceRef.current;
    if (showSpinner) setLoading(true);
    setError(null);
    try {
      const list = await api.logSessions();
      setSessions(list);
      loadedOnceRef.current = true;
    } catch (e) {
      // 静默刷新失败不覆盖已有列表与错误态：轮询下一轮会重试，
      // 闪一下错误条反而干扰阅读
      if (!silent) setError(String(e instanceof Error ? e.message : e));
    } finally {
      if (showSpinner) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 浏览器预览模式：伪会话（当前会话，直接读内存日志）
  const displaySessions: LogSessionMeta[] = tauri
    ? (sessions ?? [])
    : [
        {
          id: "preview",
          title: "当前会话（浏览器预览）",
          started_at: Math.floor(Date.now() / 1000),
          ended_at: null,
          status: "active",
          kind: "service",
          lines: logs.length,
        },
      ];

  // 类型筛选只作用于桌面端会话列表（预览模式仅一条伪会话）
  const visibleSessions = tauri
    ? displaySessions.filter((s) => kindFilter === "all" || s.kind === kindFilter)
    : displaySessions;

  // ---- 进行中会话的自动刷新 ----
  // 列表里的「进行中」只来自磁盘 header 的 active；但行数、时长、以及操作结束时的
  // 状态落定都不会主动推给本组件，所以需要轮询。判定口径：
  //   1) 列表中确实还有 active 会话（未经过滤，避免筛选掉活动会话后停止刷新）；
  //   2) 且当前确实有在跑的工作——活动日志会话 / 插件操作 / dsh CLI 更新 / 环境安装。
  // 第 2 条用于收敛僵尸会话：崩溃残留的 active 文件在启动时已被后端 finalize 为
  // closed，若仍出现（极端情况），没有在跑的工作就不再轮询，避免永久空转。
  const hasActiveSession = useMemo(
    () => displaySessions.some(isActiveSession),
    [displaySessions],
  );
  const localWorkInFlight =
    Boolean(logSessionId) ||
    pluginOpRunning ||
    dshUpdateRunning ||
    envInstallTool !== null ||
    phase === "installing" ||
    phase === "starting";
  const autoRefresh = tauri && hasActiveSession && localWorkInFlight;

  useEffect(() => {
    if (!autoRefresh) return;
    const tick = () => {
      // 页面不可见时跳过：后台标签页轮询无意义，还会和详情轮询叠加
      if (document.visibilityState !== "visible") return;
      void load({ silent: true });
    };
    const timer = setInterval(tick, AUTO_REFRESH_MS);
    // 回到前台立刻补一次，避免看到「离开那段时间」的陈旧行数
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [autoRefresh, load]);

  // 操作结束时立即刷新一次（不等下一个轮询周期）：插件操作 / dsh CLI 更新完成后
  // 会话状态会从 active 落到 success/error，行数也是最终值——事件驱动比轮询更跟手。
  // 这些事件在设置窗口同样接线（见 useAppStore.wireEvents），因此非主窗口也生效。
  // 只在 true → false 的转变时触发（挂载时不重复拉，首屏已由初始化 effect 负责）。
  const prevBusyRef = useRef(pluginOpRunning || dshUpdateRunning);
  useEffect(() => {
    const busy = pluginOpRunning || dshUpdateRunning;
    const wasBusy = prevBusyRef.current;
    prevBusyRef.current = busy;
    if (!tauri || busy || !wasBusy) return;
    void load({ silent: true });
  }, [pluginOpRunning, dshUpdateRunning, load]);

  // 详情是否实时：桌面端当前活动会话 / 预览模式伪会话
  const isLive = detail !== null && (tauri ? detail.id === logSessionId : true);

  // 详情里展示的会话状态以「最新列表」为准：detail 是打开时的快照，操作结束后
  // 磁盘 header 已落到 success/error，快照却还停在 active——不跟随会让弹框底部的
  // 「实时输出中…」永远不消失。列表里找不到该会话（被清空等）时退回快照。
  const detailLive = useMemo(() => {
    if (!detail) return null;
    const fresh = displaySessions.find((s) => s.id === detail.id);
    return fresh ?? detail;
  }, [detail, displaySessions]);

  // 非本窗口实时流的活动会话（独立设置窗口内 logSessionId 不在本窗口）：
  // detail 打开期间轮询磁盘会话内容，兜底「实时输出」观感；主窗口的内存实时流不受影响
  const detailId = detail?.id ?? null;
  // 跟随最新状态：会话落终态后自动停止轮询（尾部「实时输出中…」随之消失）
  const pollRemoteActive = Boolean(
    tauri && detailLive !== null && detailLive.status === "active" && detailId !== logSessionId,
  );

  // 会话是否曾处于「跟随中」：用于区分「刚结束要补拉终态」与「打开的就是历史会话」——
  // 后者 openDetail 已拉过内容，这里不必再拉一次（否则每次打开历史会话都多一次请求）
  const wasPollingRef = useRef(false);
  useEffect(() => {
    if (detailId === null) {
      wasPollingRef.current = false;
      return;
    }
    // 实时内存流（本窗口活动会话）：内容来自 store.logs，无需轮询
    if (detailId === logSessionId) {
      wasPollingRef.current = false;
      return;
    }
    if (!pollRemoteActive) {
      // 只在「跟随中 → 已结束」的转变时补拉最终内容，避免停在上一次轮询的中间态；
      // 直接打开的历史会话（从未跟随）不重复请求
      if (wasPollingRef.current) {
        wasPollingRef.current = false;
        void api
          .logContent(detailId)
          .then(setDetailLines)
          .catch(() => undefined);
      }
      return;
    }
    wasPollingRef.current = true;
    let alive = true;
    const timer = setInterval(() => {
      void api
        .logContent(detailId)
        .then((lines) => {
          if (alive) setDetailLines(lines);
        })
        .catch(() => undefined);
    }, AUTO_REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [pollRemoteActive, detailId, logSessionId]);

  // 展示口径的「实时」：本窗口内存流，或经轮询跟随的活动会话
  const isTailing = isLive || pollRemoteActive;

  const detailRows: DetailRow[] = isLive
    ? logs.map((l) => ({ key: String(l.id), time: l.time, stream: l.stream, text: l.text }))
    : (detailLines ?? []).map((l, i) => ({ key: String(i), time: l.time, stream: l.stream, text: l.text }));

  const openDetail = async (s: LogSessionMeta) => {
    setDetail(s);
    setDetailLines(null);
    if (!tauri || s.id === logSessionId) return; // 实时会话：直接订阅 store.logs
    setDetailLoading(true);
    try {
      setDetailLines(await api.logContent(s.id));
    } catch (e) {
      setDetailLines([]);
      message.error(`读取日志失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDetailLoading(false);
    }
  };

  // 自动滚动到底部（实时会话依赖最后一条日志 id，达到内存上限后 length 恒定仍触发）
  const lastKey = detailRows.at(-1)?.key;
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastKey, detail]);

  const copyDetail = async () => {
    const text = detailRows.map((r) => r.text).join("\n");
    if (!text) {
      message.info("暂无日志内容");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      message.success("日志已复制到剪贴板");
    } catch {
      message.error("复制失败");
    }
  };

  const handleClear = async () => {
    try {
      await api.logClear();
      setSessions([]);
      setDetail(null);
      message.success("日志已清空");
    } catch (e) {
      message.error(`清空失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const statusOf = (s: LogSessionMeta) => STATUS_META[s.status] ?? { label: "已结束", cls: "closed" };
  const linesOf = (s: LogSessionMeta) =>
    s.status === "active" && s.id === logSessionId ? logs.length : s.lines;

  const KIND_LABELS: Record<typeof kindFilter, string> = {
    all: "日志",
    service: "服务日志",
    plugin: "插件日志",
    env: "环境日志",
  };

  return (
    <>
      <div className="settings-body">
        {/* 整块日志区收进同一张卡片：工具栏（筛选左对齐、刷新/清空贴右）在卡片顶部，
            会话列表紧随其下。原先工具栏独立在卡片之外、列表再套一层卡片，视觉上
            是「浮在内容外的操作条」，与卡片内的内容脱节。 */}
        <div className="settings-card log-card">
          {tauri ? (
            <div className="log-toolbar">
              <SlidingSeg
                value={kindFilter}
                options={[
                  { key: "all", label: "全部" },
                  { key: "service", label: "服务日志" },
                  { key: "plugin", label: "插件日志" },
                  { key: "env", label: "环境日志" },
                ]}
                onChange={setKindFilter}
              />
              {/* 自动刷新提示：有进行中的会话时列表在后台静默轮询，明确告知用户
                  行数/时长/状态是自己变的，不是需要手动点刷新 */}
              {autoRefresh ? (
                <span
                  className="log-live-hint"
                  title={`进行中的会话每 ${AUTO_REFRESH_MS / 1000}s 自动更新`}
                >
                  <span className="log-live-dot" />
                  自动更新中
                </span>
              ) : null}
              <div className="log-toolbar-actions">
                <button
                  className="pm-btn"
                  type="button"
                  disabled={loading}
                  onClick={() => void load()}
                >
                  <ReloadOutlined style={{ fontSize: 12 }} />
                  {loading ? "加载中…" : "刷新"}
                </button>
                <button
                  className="pm-btn danger"
                  type="button"
                  onClick={() => {
                    // 原生确认框替代 Popconfirm（确认交互全应用统一走原生对话框）
                    void nativeConfirm(
                      "确定要删除全部日志记录吗？此操作不可恢复。",
                      "清空日志",
                      "清空",
                    ).then((ok) => {
                      if (ok) void handleClear();
                    });
                  }}
                >
                  <DeleteOutlined style={{ fontSize: 12 }} />
                  清空日志
                </button>
              </div>
            </div>
          ) : null}

          {error ? (
            <div className="log-error">
              <span>加载日志失败：{error}</span>
              <button className="pm-btn" type="button" onClick={() => void load()}>
                重试
              </button>
            </div>
          ) : !tauri ? (
            <>
              <div className="settings-card-title">浏览器预览模式</div>
              <p className="settings-desc">
                日志记录需在桌面应用内使用（每次启动/重启服务保存为独立会话）。此处仅展示当前会话的实时日志。
              </p>
              <div className="log-sessions">
                {displaySessions.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className="log-session-row"
                    onClick={() => void openDetail(s)}
                  >
                    <span className="log-status-dot active" />
                    <span className="log-session-title">{s.title}</span>
                    <span className="log-session-meta">
                      <span>{formatTs(s.started_at)}</span>
                      <span className="log-session-sep">·</span>
                      <span>—</span>
                    </span>
                    <span className="log-session-lines">{logs.length} 行</span>
                    <span className="log-badge active">进行中</span>
                  </button>
                ))}
              </div>
            </>
          ) : sessions === null ? (
            <div className="log-empty">
              <span className="mk-op-spinner" />
              <span>正在加载日志…</span>
            </div>
          ) : visibleSessions.length === 0 ? (
            <div className="log-empty">
              {displaySessions.length > 0
                ? `暂无${KIND_LABELS[kindFilter]}记录`
                : "暂无日志记录（启动服务或执行插件操作后自动生成）"}
            </div>
          ) : (
            <div className="log-sessions">
              {visibleSessions.map((s) => {
                const meta = statusOf(s);
                return (
                  <button
                    key={s.id}
                    type="button"
                    className="log-session-row"
                    onClick={() => void openDetail(s)}
                  >
                    <span className={`log-status-dot ${meta.cls}`} />
                    <span className="log-session-title">{s.title}</span>
                    <span className="log-session-meta">
                      <span>{formatTs(s.started_at)}</span>
                      <span className="log-session-sep">·</span>
                      {/* 进行中不显示秒级计时：轮询间隔 2s，数字会抖动乱跳，
                          交给右侧状态徽标表达「还在跑」；结束后才落真实耗时 */}
                      <span>{s.ended_at ? formatDuration(s.started_at, s.ended_at) : "—"}</span>
                    </span>
                    <span className="log-session-lines">{linesOf(s)} 行</span>
                    <span className={`log-badge ${meta.cls}`}>{meta.label}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <AppModal
        open={detail !== null}
        title={
          detailLive ? (
            <span className="log-detail-title">
              <span>{`${detailLive.title} · ${formatTs(detailLive.started_at)}`}</span>
              {/* 状态随会话变化自动更新：操作结束后由「进行中」落到成功/失败，无需重开弹框 */}
              <span className={`log-badge ${statusOf(detailLive).cls}`}>
                {statusOf(detailLive).label}
              </span>
            </span>
          ) : (
            ""
          )
        }
        width={880}
        onCancel={() => setDetail(null)}
        footer={
          <div className="log-detail-footer">
            <span className="log-detail-foot-meta">
              {detailLive ? (
                <>
                  <span>{linesOf(detailLive)} 行</span>
                  <span className="log-session-sep">·</span>
                  <span>
                    {detailLive.ended_at
                      ? `耗时 ${formatDuration(detailLive.started_at, detailLive.ended_at)}`
                      : "计时中…"}
                  </span>
                </>
              ) : null}
            </span>
            <button className="pm-btn" type="button" onClick={() => void copyDetail()}>
              <CopyOutlined style={{ fontSize: 13 }} />
              复制日志
            </button>
            <button className="pm-btn primary" type="button" onClick={() => setDetail(null)}>
              关闭
            </button>
          </div>
        }
        styles={{ body: { padding: 0 } }}
      >
        <div className="term-window log-detail-window">
          <div className={`term-progress${detailLoading ? " active" : ""}`} />
          <div className="term-body" ref={bodyRef}>
            {detailLoading ? (
              <div className="term-empty">正在读取日志…</div>
            ) : detailRows.length === 0 ? (
              <div className="term-empty">{isTailing ? "等待输出…" : "该会话暂无日志输出"}</div>
            ) : (
              detailRows.map((l) => (
                <div key={l.key} className="term-line">
                  {l.text}
                </div>
              ))
            )}
            {isTailing && detailRows.length > 0 ? (
              <div className="term-line">
                实时输出中…
                <span className="term-cursor" />
              </div>
            ) : null}
          </div>
        </div>
      </AppModal>
    </>
  );
}
