import { CopyOutlined } from "@ant-design/icons";
import { App as AntApp, Select } from "antd";
import { useEffect, useRef, useState } from "react";
import AppModal from "../AppModal";
import { semverCompare } from "../../lib/envReq";
import { useAppStore } from "../../store/useAppStore";

/** npm 版本信息（@deepseek-ai/dsh 的 packument 摘要，AboutSettings 查询后传入） */
export interface DshNpmInfo {
  /** dist-tags.latest */
  latest: string;
  /** 全部 dist-tags（latest/next/alpha…）：alpha 等预发布通道不体现在 latest 里，
   *  单列成下拉快捷项才能被「切换版本」够到 */
  tags: Record<string, string>;
  /** 全部版本号（semver 降序） */
  versions: string[];
}

/** npm 版本查询状态：checking（查询中）/ ok / error（失败可重试） */
export type DshNpmState = "checking" | "ok" | "error";

interface Props {
  open: boolean;
  onClose: () => void;
  /** 当前已安装版本（用于「当前已装」标注与完成文案） */
  currentVersion: string | null;
  npmInfo: DshNpmInfo | null;
  npmState: DshNpmState;
  /** npm 版本列表获取失败后的重试 */
  onRetryFetch: () => void;
}

/**
 * dsh CLI 更新弹框：展示完整的卸载/重装命令（可复制），安装命令的目标版本
 * 从 npm 版本列表下拉选择（默认 @latest）；「立即更新」在应用内自动执行——
 * 先停止正在运行的服务，Rust 侧依次跑两条 pnpm 命令（dsh://dsh-update-log 流式
 * 回显），完成后刷新环境状态并重启服务（更新前在跑时）。
 */
export default function DshUpdateModal({
  open,
  onClose,
  currentVersion,
  npmInfo,
  npmState,
  onRetryFetch,
}: Props) {
  const { message } = AntApp.useApp();
  const dshUpdate = useAppStore((s) => s.dshUpdate);
  const dshUpdateLogs = useAppStore((s) => s.dshUpdateLogs);
  const dshVersion = useAppStore((s) => s.dshVersion);
  const startDshUpdate = useAppStore((s) => s.startDshUpdate);
  // 目标版本：dist-tag 或具体版本号；每次打开重置回 @latest
  const [target, setTarget] = useState("latest");

  const running = dshUpdate?.running ?? false;
  const finished = !running && dshUpdate !== null && dshUpdate.exitCode !== null;
  const success = finished && dshUpdate.exitCode === 0;

  // 每次打开重置版本选择；查询完成前没有版本列表可选
  useEffect(() => {
    if (open) setTarget("latest");
  }, [open]);

  // 日志自动滚动到底（最新一行变化时）
  const bodyRef = useRef<HTMLDivElement>(null);
  const lastLogId = dshUpdateLogs.at(-1)?.id;
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastLogId]);

  // 完成瞬间弹一次结果提示（running → false 转变）
  const prevRunning = useRef(false);
  useEffect(() => {
    if (prevRunning.current && !running && dshUpdate) {
      if (dshUpdate.exitCode === 0) {
        message.success(`dsh CLI 已更新到 v${dshVersion ?? dshUpdate.target}`);
      } else {
        message.error(`dsh CLI 更新失败（退出码 ${dshUpdate.exitCode}）`);
      }
    }
    prevRunning.current = running;
  }, [running, dshUpdate, dshVersion, message]);

  const uninstallCmd = "pnpm remove -g @deepseek-ai/dsh";
  const installCmd = `pnpm add -g @deepseek-ai/dsh@${target}`;

  const copyCmd = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      message.success("已复制到剪贴板");
    } catch {
      message.error("复制失败，请手动选择文本复制");
    }
  };

  const options = [
    {
      value: "latest",
      label: npmInfo ? `@latest（npm 最新 v${npmInfo.latest}）` : "@latest",
    },
    // 其余 dist-tag（next/alpha…）：预发布通道的快捷入口，安装命令直接用 @tag
    ...Object.entries(npmInfo?.tags ?? {})
      .filter(([tag]) => tag !== "latest")
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([tag, v]) => ({
        value: tag,
        label: `@${tag}（v${v}）`,
      })),
    ...(npmInfo?.versions ?? []).map((v) => ({
      value: v,
      label:
        v +
        (npmInfo && v === npmInfo.latest ? "（latest）" : "") +
        (v === currentVersion ? "（当前已装）" : ""),
    })),
  ];

  const sameVersion = currentVersion != null && target === currentVersion;

  const cmdRow = (label: string, cmd: string) => (
    <div className="dsh-update-cmd">
      <div className="dsh-update-cmd-head">
        <span>{label}</span>
        <button className="pm-btn pm-btn-sm" type="button" onClick={() => void copyCmd(cmd)}>
          <CopyOutlined style={{ fontSize: 12 }} />
          复制
        </button>
      </div>
      <code className="dsh-update-cmd-text">{cmd}</code>
    </div>
  );

  return (
    <AppModal
      open={open}
      title="更新 dsh CLI"
      width={640}
      onCancel={running ? undefined : onClose}
      closable={!running}
      maskClosable={!running}
      keyboard={!running}
      footer={
        <div className="dsh-update-foot">
          <span className="settings-desc">
            {running
              ? "正在更新，完成后将自动刷新版本显示…"
              : "「立即更新」在应用内自动执行以上两条命令（先停止服务，完成后重启）；也可复制命令在终端手动执行。"}
          </span>
          <div className="dsh-update-foot-btns">
            <button className="pm-btn" type="button" disabled={running} onClick={onClose}>
              {finished ? "关闭" : "取消"}
            </button>
            <button
              className="pm-btn primary"
              type="button"
              disabled={running || npmState !== "ok"}
              onClick={() => void startDshUpdate(target)}
            >
              {running ? "更新中…" : "立即更新"}
            </button>
          </div>
        </div>
      }
    >
      <div className="dsh-update-body">
        <div className="dsh-update-row">
          <span className="dsh-update-label">当前版本</span>
          <code className="about-update-strong">{currentVersion ?? "未知"}</code>
          {npmState === "ok" && npmInfo && (
            <span className="about-update-muted">
              npm 最新 v{npmInfo.latest}
              {currentVersion != null &&
                npmInfo.latest &&
                ((semverCompare(currentVersion, npmInfo.latest) ?? 0) < 0
                  ? "（有更新）"
                  : "（已是最新）")}
            </span>
          )}
          {npmState === "checking" && <span className="about-update-muted">npm 版本查询中…</span>}
          {npmState === "error" && (
            <>
              <span className="about-update-muted">npm 版本查询失败</span>
              <button className="pm-btn pm-btn-sm" type="button" onClick={onRetryFetch}>
                重试
              </button>
            </>
          )}
        </div>

        <div className="dsh-update-row">
          <span className="dsh-update-label">目标版本</span>
          <Select
            value={target}
            onChange={(v) => setTarget(v)}
            options={options}
            disabled={running || npmState !== "ok"}
            style={{ width: 320 }}
            size="small"
            showSearch
            optionFilterProp="label"
          />
          {sameVersion && !running && (
            <span className="about-update-muted">
              与当前版本一致：将卸载后重装同一版本（可用于修复损坏的安装）
            </span>
          )}
        </div>

        {cmdRow("① 卸载", uninstallCmd)}
        {cmdRow("② 重新安装", installCmd)}

        {dshUpdate && (
          <div className="term-window dsh-update-term">
            <div className={`term-progress${running ? " active" : ""}`} />
            <div className="term-body" ref={bodyRef}>
              {dshUpdateLogs.length === 0 ? (
                <div className="term-empty">等待输出…</div>
              ) : (
                dshUpdateLogs.map((l) => (
                  <div key={l.id} className="term-line">
                    {l.text}
                  </div>
                ))
              )}
              {running ? (
                <div className="term-line">
                  正在执行，请稍候…
                  <span className="term-cursor" />
                </div>
              ) : finished ? (
                <div className="term-line">
                  {success
                    ? `更新完成${dshVersion ? `：当前 v${dshVersion}` : ""}${dshUpdate.wasRunning ? "，服务已重启" : ""}`
                    : `更新失败（退出码 ${dshUpdate.exitCode}），可重试或在终端手动执行`}
                </div>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </AppModal>
  );
}
