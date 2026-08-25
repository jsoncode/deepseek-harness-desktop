import { CaretRightFilled, HomeOutlined, StopOutlined } from "@ant-design/icons";
import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { tauri } from "../lib/tauri";
import { useAppStore } from "../store/useAppStore";

/** 日志行前缀符号（终端页与插件操作终端共用） */
export const MARK: Record<string, string> = {
  system: "◆",
  stdout: "│",
  stderr: "⚠",
  success: "✓",
  error: "✗",
};

const STATUS_TEXT: Record<string, string> = {
  checking: "检测中",
  idle: "就绪",
  installing: "安装依赖",
  starting: "启动服务",
  running: "运行中",
  error: "启动失败",
  stopped: "已停止",
};

export default function Terminal() {
  const navigate = useNavigate();
  const bodyRef = useRef<HTMLDivElement>(null);
  const { phase, logs, initialized, init, startFlow, stop, reset } = useAppStore();

  // 进入页面仅同步应用状态；不再自动启动服务（启动由用户在启动页手动点击触发）
  useEffect(() => {
    if (!initialized) void init();
  }, [initialized, init]);

  // 仅当本页参与的启动流程（starting → running）才自动进入预览页；
  // 进入页面时服务已在运行（phase=running）则不跳转，避免打断查看日志
  const prevPhase = useRef(phase);
  useEffect(() => {
    const prev = prevPhase.current;
    prevPhase.current = phase;
    if (phase === "running" && prev === "starting") {
      // url 事件在服务探活成功后才发出，就绪即跳转，不再人为停留
      navigate("/preview");
    }
  }, [phase, navigate]);

  // 自动滚动到底部（依赖最后一条日志 id：日志达到上限后 length 恒定，length 不再触发）
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs.at(-1)?.id]);

  const busy = phase === "installing" || phase === "starting";
  const statusClass =
    phase === "running"
      ? "term-status running success"
      : phase === "error"
        ? "term-status error"
        : "term-status";

  return (
    <div className="page term">
      <div className="term-header">
        <div className="term-dots">
          <i />
          <i />
          <i />
        </div>
        <div className="term-title">
          harness — terminal
          <small>dsh web · 模拟终端</small>
        </div>
        <div className={statusClass}>
          <span className="dot" />
          {STATUS_TEXT[phase] ?? "未知"}
        </div>
      </div>

      <div className="term-window">
        <div className={`term-progress${busy ? " active" : ""}`} />
        <div className="term-body" ref={bodyRef}>
          {logs.length === 0 ? (
            <div className="term-empty">
              {tauri ? "等待输出…" : "浏览器预览模式：启动/停止服务需在桌面应用内操作"}
            </div>
          ) : (
            logs.map((l) => (
              <div key={l.id} className={`term-line ${l.stream}`}>
                <span className="t-time">{l.time}</span>
                <span className="t-mark">{MARK[l.stream] ?? "·"}</span>
                <span className="t-text">{l.text}</span>
              </div>
            ))
          )}
          {busy ? (
            <div className="term-line system">
              <span className="t-time">{"·".repeat(8)}</span>
              <span className="t-mark">◆</span>
              <span className="t-text">
                {phase === "installing" ? "正在安装，请稍候…" : "正在等待服务就绪…"}
                <span className="term-cursor" />
              </span>
            </div>
          ) : null}
        </div>
      </div>

      <div className="term-actions">
        {phase === "running" ? (
          <>
            <button className="btn-secondary" onClick={() => navigate("/preview")}>
              <CaretRightFilled style={{ fontSize: 14 }} /> 打开应用
            </button>
            <button
              className="btn-secondary"
              onClick={() => {
                void stop();
                navigate("/");
              }}
              style={{ color: "var(--danger)", borderColor: "rgba(248,113,113,.35)" }}
            >
              <StopOutlined style={{ fontSize: 14 }} /> 停止服务
            </button>
          </>
        ) : null}
        {phase === "error" ? (
          <button
            className="btn-primary"
            onClick={() => {
              reset();
              void startFlow();
            }}
            style={{ minWidth: 180 }}
          >
            <CaretRightFilled style={{ fontSize: 15 }} /> 重试
          </button>
        ) : null}
        {phase === "stopped" ? (
          <button
            className="btn-primary"
            onClick={() => {
              reset();
              void startFlow();
            }}
            style={{ minWidth: 180 }}
          >
            <CaretRightFilled style={{ fontSize: 15 }} /> 重新启动
          </button>
        ) : null}
        <button className="btn-secondary" onClick={() => navigate("/")}>
          <HomeOutlined style={{ fontSize: 14 }} /> 返回启动页
        </button>
      </div>
    </div>
  );
}
