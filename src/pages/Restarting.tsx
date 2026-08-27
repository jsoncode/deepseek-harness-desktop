import { HomeOutlined, ReloadOutlined } from "@ant-design/icons";
import { App as AntApp } from "antd";
import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { useAppStore } from "../store/useAppStore";

/**
 * 重启过渡页：点击「重启服务」后立即接管全屏，
 * 展示重启各阶段（停止 → 安装依赖 → 启动服务）的 loading；
 * 服务就绪（running）即刻进入预览页，失败则给出重试入口。
 */
export default function Restarting() {
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const phase = useAppStore((s) => s.phase);

  // 是否已经历过忙碌阶段（installing/starting）：
  // 重启链路会先短暂经过 stopped（停止旧服务），不能据此判定失败
  const seenBusy = useRef(false);
  const done = useRef(false);
  // 重启的第一步必然是 stop()，其带来的第一个 stopped 不算失败：
  // 从「启动中」直接点重启时页面会带着 starting 挂载，随后先经过 stopped，
  // 若按 stopped 一律判定失败会闪一下「重启失败」
  const stopSeen = useRef(false);

  // 服务就绪 → 立即进入预览页（只执行一次）
  useEffect(() => {
    if (done.current) return;
    if (phase === "running") {
      done.current = true;
      message.success("服务已重新启动");
      navigate("/preview", { replace: true });
    }
  }, [phase, navigate, message]);

  const firstStop = phase === "stopped" && !stopSeen.current;
  if (phase === "stopped") stopSeen.current = true;
  const failed = phase === "error" || (seenBusy.current && phase === "stopped" && !firstStop);
  if (phase === "installing" || phase === "starting") seenBusy.current = true;

  const retry = () => {
    seenBusy.current = false;
    void useAppStore.getState().startFlow();
  };

  const title = "正在重启服务…";
  let sub = "正在停止当前服务实例";
  if (phase === "checking") {
    sub = "正在检测运行环境";
  } else if (phase === "installing") {
    sub = "正在安装依赖与插件（首次或变更后会较久）";
  } else if (phase === "starting") {
    sub = "正在启动本地服务 dsh web";
  }

  return (
    <div className="page restarting">
      {failed ? (
        <>
          <div className="restarting-fail">✗</div>
          <h1 className="restarting-title">重启失败</h1>
          <div className="restarting-sub">请查看终端日志定位原因</div>
          <div className="restarting-actions">
            <button className="btn-secondary restarting-btn" type="button" onClick={retry}>
              <ReloadOutlined style={{ fontSize: 14 }} /> 重试
            </button>
            <button className="btn-secondary restarting-btn" type="button" onClick={() => navigate("/")}>
              <HomeOutlined style={{ fontSize: 14 }} /> 返回启动页
            </button>
          </div>
        </>
      ) : (
        <>
          <span className="spinner-ring restarting-spinner" />
          <h1 className="restarting-title">{title}</h1>
          <div className="restarting-sub">{sub}</div>
        </>
      )}
    </div>
  );
}