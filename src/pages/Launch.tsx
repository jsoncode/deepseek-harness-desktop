import { useEffect } from "react";
import { useNavigate } from "react-router";
import logo from "../assets/logo.svg";
import { useAppStore } from "../store/useAppStore";

/**
 * 启动封面（cover）：只在「未启动」时出现的门面页 —— logo + 标题 + 启动按钮。
 *
 * **纯展示，不参与启动流程**：这里不检测环境、不判断依赖、不安装、也不调用
 * startFlow / installEnvAndStart。整条「检测环境 →（缺失才安装）→ 启动」的链路
 * 全部属于服务状态页（/loading），封面点按钮只是带着「用户要启动」的意图把控制权
 * 交过去（location.state.start），由状态页决定走启动链还是安装链。
 *
 * 这带来两个好处：
 *   1. 启动/安装的展示与状态只有 /loading 一处来源，不会两页各写一份导致不同步；
 *   2. 封面可以被替换成任何静态图/宣传页，而不牵动启动逻辑。
 *
 * 只在未启动时出现：已启动 → 预览页；启动中/安装中 → 状态页。
 */
export default function Launch() {
  const navigate = useNavigate();
  const phase = useAppStore((s) => s.phase);

  // 封面不是「已启动」该待的地方：状态本身的探测由 App 壳层的 init 负责，
  // 这里只按结果分流。
  useEffect(() => {
    if (phase === "running") {
      navigate("/preview", { replace: true });
    } else if (phase === "installing" || phase === "starting") {
      navigate("/loading", { replace: true });
    }
  }, [phase, navigate]);

  return (
    <div className="page launch">
      <div className="launch-logo-wrap">
        <div className="launch-logo">
          <img src={logo} alt="Harness Logo" draggable={false} />
        </div>
      </div>

      <h1 className="launch-title">DeepSeek Harness Desktop</h1>

      <div className="launch-actions">
        <button
          className="btn-primary"
          type="button"
          onClick={() => navigate("/loading", { state: { start: true } })}
          style={{ minWidth: 220 }}
        >
          <span className="btn-shine" />
          启动应用
        </button>
      </div>
    </div>
  );
}
