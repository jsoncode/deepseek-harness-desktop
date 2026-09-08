import { ReloadOutlined } from "@ant-design/icons";
import { App as AntApp } from "antd";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { meetsNodeRequirement, pnpmMajorOf } from "../lib/envReq";
import { tauri } from "../lib/tauri";
import { useAppStore } from "../store/useAppStore";

/**
 * 服务状态页（原启动过渡页）：启动检查页已移除，本页是唯一的服务级状态页。
 * 应用打开后自动完成「检测环境 →（缺失才安装）→ 启动」，各阶段全屏 loading；
 * 服务就绪（running）即刻进入预览页，失败/被手动停止时在本页给出启动入口。
 * 文案不出现「重启」字样——启动与重启共用本页，进度由阶段文案表达。
 */

/** 自动启动标记：应用打开后的自动启动链只执行一次
 *  （本组件随导航反复重挂载，模块级标记防重复触发） */
let autoStarted = false;

/** 按当前环境状态选择启动链：环境缺失/损坏（node/pnpm/dsh 或 pnpm 11）走一键
 *  安装链，否则走常规启动链。自动启动与手动启动/重试共用同一判定。
 *  node 按「路径在 + 版本可读时达标」判定：版本读取偶发超时不等于未安装，
 *  不能据此走安装分支在好机器上重装 node；版本可读且低于要求才需要装 LTS。 */
function startChain() {
  const s = useAppStore.getState();
  // dsh 已安装但读不出版本 = 安装损坏（与后端完整性校验一致）→ 走一键安装链重装；
  // 正常安装的 dsh 走常规启动链（启动链绝不自动重装/更新，避免覆盖现有版本）
  const nodeOk =
    Boolean(s.nodePath) && (!s.nodeVersion || meetsNodeRequirement(s.nodeVersion));
  const needsInstall = !(
    nodeOk &&
    Boolean(s.pnpmPath) &&
    s.dshInstalled &&
    Boolean(s.dshVersion) &&
    pnpmMajorOf(s.pnpmVersion) < 11
  );
  void (needsInstall ? s.installEnvAndStart() : s.startFlow());
}

export default function Loading() {
  const navigate = useNavigate();
  const location = useLocation();
  const { message } = AntApp.useApp();
  const phase = useAppStore((s) => s.phase);

  // 是否由重启链路进入（重启会先 stop() 停掉旧实例）：决定 stopped 阶段的提示文案
  const fromRestart = Boolean((location.state as { restart?: boolean } | null)?.restart);

  // 是否已经历过忙碌阶段（installing/starting）：
  // 重启链路会先短暂经过 stopped（停止旧服务），不能据此判定失败
  const seenBusy = useRef(false);
  const done = useRef(false);
  // 重启的第一步必然是 stop()，其带来的第一个 stopped 不算失败：
  // 从「启动中」直接点重启时页面会带着 starting 挂载，随后先经过 stopped，
  // 若按 stopped 一律判定失败会闪一下「启动失败」
  const stopSeen = useRef(false);
  // 手动启动点击后的本地忙碌态：startFlow 开日志会话期间 phase 尚未变化，
  // 给按钮即时反馈
  const [starting, setStarting] = useState(false);

  // 服务就绪 → 立即进入预览页（只执行一次）
  useEffect(() => {
    if (done.current) return;
    if (phase === "running") {
      done.current = true;
      message.success("服务已启动");
      navigate("/preview", { replace: true });
    }
  }, [phase, navigate, message]);

  const firstStop = phase === "stopped" && !stopSeen.current;
  if (phase === "stopped") stopSeen.current = true;
  const failed = phase === "error" || (seenBusy.current && phase === "stopped" && !firstStop);
  if (phase === "installing" || phase === "starting") seenBusy.current = true;

  // 服务被手动停止（非重启链路、也未经历过启动流程）→ 展示停止态与启动入口；
  // 自动启动不在此触发——用户刚明确停止过服务，不应违背其意图自动拉起
  const stoppedIdle = phase === "stopped" && !seenBusy.current && !fromRestart;

  // 应用打开后的自动启动（一次性）：先完成环境检测初始化，服务已在运行/
  // 启动中则交给上方 phase 联动跳转，否则按环境状态自动续接启动链。
  // 浏览器预览模式无后端，仅初始化为空闲态（避免误报启动失败）
  useEffect(() => {
    if (autoStarted) return;
    autoStarted = true;
    if (!tauri) {
      void useAppStore.getState().init();
      return;
    }
    void useAppStore
      .getState()
      .init()
      .then(() => {
        const s = useAppStore.getState();
        if (s.phase === "running" || s.phase === "starting" || s.phase === "installing") return;
        startChain();
      });
  }, []);

  // 手动启动/重试：环境依赖缺失（node/pnpm/dsh 或 pnpm 11）时走一键安装链，
  // 否则走常规启动链（停止态与失败态共用）
  const startNow = () => {
    if (starting) return;
    seenBusy.current = false;
    setStarting(true);
    startChain();
    // phase 变化（installing/starting/running）后由上方联动接管，忙碌态随即失效
    setTimeout(() => setStarting(false), 1500);
  };

  const title = "正在启动服务…";
  let sub = "正在准备启动";
  if (phase === "stopped") {
    sub = fromRestart ? "正在停止当前服务实例" : "服务当前未运行";
  } else if (phase === "checking") {
    sub = "正在检测运行环境";
  } else if (phase === "installing") {
    sub = "正在安装依赖与插件（首次或变更后会较久）";
  } else if (phase === "starting") {
    sub = "正在启动本地服务 dsh web";
  }

  if (!tauri) {
    return (
      <div className="page loading">
        <h1 className="loading-title">浏览器预览模式</h1>
        <div className="loading-sub">仅界面预览，启动/停止等服务操作需在桌面应用内使用</div>
      </div>
    );
  }

  return (
    <div className="page loading">
      {failed ? (
        <>
          <div className="loading-fail">✗</div>
          <h1 className="loading-title">启动失败</h1>
          <div className="loading-sub">请查看日志管理定位原因</div>
          <div className="loading-actions">
            <button className="btn-secondary loading-btn" type="button" onClick={startNow} disabled={starting}>
              <ReloadOutlined style={{ fontSize: 14 }} /> {starting ? "启动中…" : "重试"}
            </button>
            <button className="btn-secondary loading-btn" type="button" onClick={() => navigate("/settings?section=logs")}>
              查看日志
            </button>
          </div>
        </>
      ) : stoppedIdle ? (
        <>
          <div className="loading-stopped">○</div>
          <h1 className="loading-title">服务已停止</h1>
          <div className="loading-sub">点击「启动服务」重新启动本地服务</div>
          <div className="loading-actions">
            <button className="btn-secondary loading-btn" type="button" onClick={startNow} disabled={starting}>
              <ReloadOutlined style={{ fontSize: 14 }} /> {starting ? "启动中…" : "启动服务"}
            </button>
            <button className="btn-secondary loading-btn" type="button" onClick={() => navigate("/settings?section=logs")}>
              查看日志
            </button>
          </div>
        </>
      ) : (
        <>
          <span className="spinner-ring loading-spinner" />
          <h1 className="loading-title">{title}</h1>
          <div className="loading-sub">{sub}</div>
        </>
      )}
    </div>
  );
}
