import { App as AntApp, Popconfirm } from "antd";
import { CopyOutlined, DeleteOutlined, ReloadOutlined } from "@ant-design/icons";
import { useCallback, useEffect, useRef, useState } from "react";
import AppModal from "../AppModal";
import { MARK } from "../../lib/logFormat";
import { api, tauri, type LogSessionMeta } from "../../lib/tauri";
import { useAppStore } from "../../store/useAppStore";

/** 会话状态 → 徽标文案与样式类 */
const STATUS_META: Record<string, { label: string; cls: string }> = {
  active: { label: "进行中", cls: "active" },
  success: { label: "成功", cls: "success" },
  error: { label: "失败", cls: "error" },
  closed: { label: "已结束", cls: "closed" },
};

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

  const [sessions, setSessions] = useState<LogSessionMeta[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<LogSessionMeta | null>(null);
  const [detailLines, setDetailLines] = useState<Array<{ time: string; stream: string; text: string }> | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (!tauri) return;
    setLoading(true);
    setError(null);
    try {
      setSessions(await api.logSessions());
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
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
          lines: logs.length,
        },
      ];

  // 详情是否实时：桌面端当前活动会话 / 预览模式伪会话
  const isLive = detail !== null && (tauri ? detail.id === logSessionId : true);

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

  return (
    <>
      <div className="settings-nav">
        <span className="settings-nav-title">日志管理</span>
        <div className="settings-nav-actions">
          {tauri ? (
            <>
              <button className="pm-btn" type="button" disabled={loading} onClick={() => void load()}>
                <ReloadOutlined style={{ fontSize: 12 }} />
                {loading ? "加载中…" : "刷新"}
              </button>
              <Popconfirm
                title="清空日志"
                description="确定要删除全部日志记录吗？此操作不可恢复。"
                okText="清空"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                onConfirm={() => void handleClear()}
              >
                <button className="pm-btn danger" type="button">
                  <DeleteOutlined style={{ fontSize: 12 }} />
                  清空日志
                </button>
              </Popconfirm>
            </>
          ) : null}
        </div>
      </div>

      <div className="settings-body">
        {error ? (
          <div className="log-error">
            <span>加载日志失败：{error}</span>
            <button className="pm-btn" type="button" onClick={() => void load()}>
              重试
            </button>
          </div>
        ) : !tauri ? (
          <div className="settings-card">
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
          </div>
        ) : sessions === null ? (
          <div className="log-empty">
            <span className="mk-op-spinner" />
            <span>正在加载日志…</span>
          </div>
        ) : displaySessions.length === 0 ? (
          <div className="log-empty">暂无日志记录（启动或重启服务后自动生成）</div>
        ) : (
          <div className="log-sessions">
            {displaySessions.map((s) => {
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

      <AppModal
        open={detail !== null}
        title={detail ? `${detail.title} · ${formatTs(detail.started_at)}` : ""}
        width={880}
        onCancel={() => setDetail(null)}
        footer={
          <div className="log-detail-footer">
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
              <div className="term-empty">{isLive ? "等待输出…" : "该会话暂无日志输出"}</div>
            ) : (
              detailRows.map((l) => (
                <div key={l.key} className={`term-line ${l.stream}`}>
                  <span className="t-time">{l.time}</span>
                  <span className="t-mark">{MARK[l.stream] ?? "·"}</span>
                  <span className="t-text">{l.text}</span>
                </div>
              ))
            )}
            {isLive && detailRows.length > 0 ? (
              <div className="term-line system">
                <span className="t-time">{"·".repeat(8)}</span>
                <span className="t-mark">◆</span>
                <span className="t-text">
                  实时输出中…
                  <span className="term-cursor" />
                </span>
              </div>
            ) : null}
          </div>
        </div>
      </AppModal>
    </>
  );
}
