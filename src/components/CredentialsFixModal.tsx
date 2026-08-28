import { App as AntApp, Modal } from "antd";
import { useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../lib/tauri";
import { useAppStore } from "../store/useAppStore";

/**
 * 凭据配置文件格式兼容弹框：启动 dsh 服务前由 store.ensureCredentialsCompat 检测到
 * `$DSH_HOME/.credentials.yaml` 与当前 dsh 版本不兼容时弹出。
 *
 * 展示打码后的文件内容（机密值不经过前端，由 Rust 侧打码后下发）与最新格式模板；
 * 用户确认 → 调用 fix_credentials 重写为最新规范格式（凭据值完整保留）→ 继续启动；
 * 暂不处理 → 中止本次启动，回到启动页。
 */
export default function CredentialsFixModal() {
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const issue = useAppStore((s) => s.credentialsIssue);
  const resolveCredentialsConfirm = useAppStore((s) => s.resolveCredentialsConfirm);
  const appendLog = useAppStore((s) => s.appendLog);
  const [fixing, setFixing] = useState(false);
  const [fixError, setFixError] = useState<string | null>(null);

  const handleOk = async () => {
    if (!issue) return;
    setFixing(true);
    setFixError(null);
    try {
      const summary = await api.fixCredentials();
      appendLog("success", `✅ ${summary}`);
      message.success("凭据配置文件已更新为最新格式");
      resolveCredentialsConfirm(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setFixError(msg);
      appendLog("error", `❌ 凭据配置文件修复失败：${msg}`);
    } finally {
      setFixing(false);
    }
  };

  const handleCancel = () => {
    if (fixing) return;
    resolveCredentialsConfirm(false);
    // 取消修复 → 中止本次启动，回到启动页（避免停留在 loading 转圈页）
    navigate("/");
  };

  return (
    <Modal
      open={Boolean(issue)}
      title="检测到凭据配置文件格式兼容问题"
      okText="更新并继续启动"
      cancelText="暂不处理"
      confirmLoading={fixing}
      onOk={handleOk}
      onCancel={handleCancel}
      maskClosable={false}
      width={680}
      centered
    >
      {issue ? (
        <div className="cred-fix-content">
          <p className="cred-fix-ask">
            在启动 dsh 服务前，检测到凭据配置文件与当前 dsh 版本不兼容，
            dsh 将无法正常加载该文件（原因：
            <b>{issue.reason}</b>）。
            <br />
            是否将其更新为最新格式？原有凭据值将完整保留。
          </p>
          <p className="cred-fix-path">{issue.path}</p>
          <div className="cred-fix-section">当前文件内容（值已打码）</div>
          <pre className="cred-fix-code">{issue.masked_content}</pre>
          <div className="cred-fix-section">最新格式模板</div>
          <pre className="cred-fix-code">{issue.template}</pre>
          {fixError ? <p className="cred-fix-error">{fixError}</p> : null}
        </div>
      ) : null}
    </Modal>
  );
}
