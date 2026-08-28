import { HomeOutlined, ReloadOutlined } from "@ant-design/icons";
import { App as AntApp } from "antd";
import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router";
import { meetsNodeRequirement, pnpmMajorOf } from "../lib/envReq";
import { tauri } from "../lib/tauri";
import { useAppStore } from "../store/useAppStore";

/**
 * 启动过渡页（通用 loading）：所有启动/重启服务操作统一进入本页，
 * 全屏展示各阶段（检测环境 → 安装依赖 → 启动服务）的 loading；
 * 服务就绪（running）即刻进入预览页，失败则给出重试入口。
 * 文案不出现「重启」字样——启动与重启共用本页，进度由阶段文案表达。
 */
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

  // 重试：环境依赖缺失（node/pnpm/dsh 或 pnpm 11）时走一键安装链，否则走常规启动链
  const retry = () => {
    seenBusy.current = false;
    if (!tauri) {
      navigate("/");
      return;
    }
    const s = useAppStore.getState();
    const needsInstall =
      !(
        meetsNodeRequirement(s.nodeVersion) &&
        Boolean(s.pnpmPath) &&
        s.dshInstalled &&
        pnpmMajorOf(s.pnpmVersion) < 11
      );
    void (needsInstall ? s.installEnvAndStart() : s.startFlow());
  };

  const title = "正在启动服务…";
  let sub = "正在准备启动";
  if (phase === "stopped") {
    sub = fromRestart ? "正在停止当前服务实例" : "正在准备启动";
  } else if (phase === "checking") {
    sub = "正在检测运行环境";
  } else if (phase === "installing") {
    sub = "正在安装依赖与插件（首次或变更后会较久）";
  } else if (phase === "starting") {
    sub = "正在启动本地服务 dsh web";
  }

  return (
    <div className="page loading">
      {failed ? (
        <>
          <div className="loading-fail">✗</div>
          <h1 className="loading-title">启动失败</h1>
          <div className="loading-sub">请查看日志管理定位原因</div>
          <div className="loading-actions">
            <button className="btn-secondary loading-btn" type="button" onClick={retry}>
              <ReloadOutlined style={{ fontSize: 14 }} /> 重试
            </button>
            <button className="btn-secondary loading-btn" type="button" onClick={() => navigate("/settings?section=logs")}>
              查看日志
            </button>
            <button className="btn-secondary loading-btn" type="button" onClick={() => navigate("/")}>
              <HomeOutlined style={{ fontSize: 14 }} /> 返回启动页
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
