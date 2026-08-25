import { ClusterOutlined } from "@ant-design/icons";
import { App as AntApp, Badge, Input, Modal, Tooltip } from "antd";
import { useEffect, useRef, useState } from "react";
import { api, tauri } from "../lib/tauri";
import { useAppStore, type PluginOpKind } from "../store/useAppStore";
import { MARK } from "../pages/Terminal";

const OP_VERB: Record<PluginOpKind, string> = {
  add: "新增",
  update: "更新",
  remove: "删除",
};

/**
 * 插件管理：标题栏入口按钮 + 双视图弹框。
 * 列表视图管理已有插件（更新/删除/新增），终端视图流式展示 `dsh plugin` 操作日志，
 * 支持终止与后台运行（后台时标题栏图标红点提示，重开默认回到终端视图）。
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
  const [view, setView] = useState<"list" | "terminal">("list");
  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);
  const prevRunningRef = useRef<boolean>(false);

  useEffect(() => {
    if (!initialized) void init();
  }, [initialized, init]);

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

  const openManager = () => {
    setOpen(true);
    setView(pluginOp?.running ? "terminal" : "list");
    void refreshPluginVersions();
  };

  if (!tauri) return null;

  const running = pluginOp?.running ?? false;

  const confirmOp = (kind: Exclude<PluginOpKind, "add">, pluginName: string) => {
    const verb = OP_VERB[kind];
    modal.confirm({
      title: `${verb}插件`,
      content: `${serviceRunning ? "服务正在运行中，" : ""}确认要${verb}插件 ${pluginName} 吗？`,
      okText: verb,
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: () => {
        setView("terminal");
        return startPluginOp(kind, pluginName);
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
      title: "终止安装",
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
        className="plugin-manager-modal"
        onCancel={() => setOpen(false)}
        title={
          view === "terminal"
            ? `正在${OP_VERB[pluginOp?.kind ?? "add"]}插件 · ${pluginOp?.name ?? ""}`
            : "插件管理"
        }
        width={view === "terminal" ? 860 : 560}
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
          ) : null
        }
      >
        {view === "list" ? (
          <div className="plugin-list">
            {pluginOp ? (
              <div className="plugin-op-banner" onClick={() => setView("terminal")} role="button">
                {running
                  ? "▸ 插件操作进行中，点击查看实时进度"
                  : "▸ 上次插件操作已完成，点击查看日志"}
              </div>
            ) : null}

            <div className="plugin-toolbar">
              <button
                className="pm-btn pm-btn-sm"
                type="button"
                disabled={running}
                onClick={() => setAddOpen(true)}
              >
                ＋ 新增插件
              </button>
            </div>

            {plugins.length === 0 ? (
              <div className="plugin-empty">暂无用户插件</div>
            ) : (
              plugins.map((p) => {
                const info = pluginVers[p];
                const outdated =
                  !!info?.current && !!info?.latest && info.current !== info.latest;
                return (
                  <div key={p} className="plugin-row">
                    <span className="plugin-name">
                      {p}
                      {info?.current ? <span className="plugin-ver">{info.current}</span> : null}
                      {outdated ? (
                        <span className="plugin-ver new">→ {info.latest}</span>
                      ) : null}
                    </span>
                    {outdated ? (
                      <button
                        className="pm-btn pm-btn-sm"
                        type="button"
                        disabled={running}
                        onClick={() => confirmOp("update", p)}
                      >
                        更新
                      </button>
                    ) : null}
                    <button
                      className="pm-btn pm-btn-sm danger"
                      type="button"
                      disabled={running}
                      onClick={() => confirmOp("remove", p)}
                    >
                      删除
                    </button>
                  </div>
                );
              })
            )}
          </div>
        ) : (
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
        )}
      </Modal>

      {/* 新增插件输入弹框 */}
      <Modal
        open={addOpen}
        className="plugin-manager-modal"
        title="新增插件"
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
        <div className="plugin-add-hint">将执行 dsh plugin --profile web add {'{'}插件名{'}'}</div>
      </Modal>
    </>
  );
}
