import { App as AntApp, Modal } from "antd";
import { useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../lib/tauri";
import { useAppStore } from "../store/useAppStore";

/**
 * 凭据配置文件格式兼容弹框：dsh web 启动失败且日志出现凭据格式错误签名时，
 * 由 store 监听流程触发（`store.promptCredentialsFix`）。
 *
 * 展示打码后的文件内容（机密值不经过前端，由 Rust 侧打码后下发）与最新格式模板
 * （refs 用大括号包裹）；用户确认 → 调用 fix_credentials 重写为最新格式
 * （凭据值完整保留）→ 自动重新启动服务；暂不处理 → 停留在错误页，可手动重试。
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
    // 取消修复 → 回到启动页（错误态带「重新启动」入口，可稍后重试）
    navigate("/");
  };

  return (
    <Modal
      open={Boolean(issue)}
      title="dsh 启动失败：凭据配置文件格式兼容问题"
      okText="更新并重新启动"
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
            dsh web 启动失败，原因是凭据配置文件与当前 dsh 版本格式不兼容，无法加载
            （原因：<b>{issue.reason}</b>）。
            <br />
            是否将其更新为最新格式并重新启动服务？原有凭据值将完整保留。
          </p>
          <p className="cred-fix-path">{issue.path ?? "（无法定位凭据文件）"}</p>
          <div className="cred-fix-section">当前文件内容（值已打码）</div>
          <pre className="cred-fix-code">
            {issue.masked_content ?? "（无法读取文件内容，请手动检查）"}
          </pre>
          <div className="cred-fix-section">最新格式模板</div>
          <pre className="cred-fix-code">{issue.template ?? "（模板暂不可用）"}</pre>
          {fixError ? <p className="cred-fix-error">{fixError}</p> : null}
        </div>
      ) : null}
    </Modal>
  );
}
