import { ApiOutlined } from "@ant-design/icons";
import { Button, Input, InputNumber, Segmented, Typography } from "antd";
import AntApp from "antd/es/app";
import { useEffect, useState } from "react";
import { api, type ProxyConfig, type ProxyKind } from "../../lib/tauri";

const { Text } = Typography;

const KIND_OPTIONS: { label: string; value: ProxyKind }[] = [
  { label: "直接连接", value: "direct" },
  { label: "HTTP", value: "http" },
  { label: "HTTPS", value: "https" },
  { label: "SOCKS4", value: "socks4" },
  { label: "SOCKS5", value: "socks5" },
];

const DEFAULT_CONFIG: ProxyConfig = { kind: "direct", host: "", port: null };

/**
 * 代理设置（设置页区块）：为「安装 node / 安装 pnpm / 安装 dsh / 插件安装」
 * 配置临时代理。保存后仅以环境变量形式注入安装类子进程（HTTP(S)_PROXY、
 * ALL_PROXY、npm_config_* 等），不修改系统代理、.npmrc 等任何本机配置。
 */
export default function ProxySettings() {
  const { message } = AntApp.useApp();
  const [config, setConfig] = useState<ProxyConfig>(DEFAULT_CONFIG);
  const [saving, setSaving] = useState(false);
  const isDirect = config.kind === "direct";

  useEffect(() => {
    api
      .getProxyConfig()
      .then((cfg) => setConfig(cfg))
      .catch(() => setConfig(DEFAULT_CONFIG));
  }, []);

  const save = async () => {
    if (!isDirect) {
      if (!config.host.trim()) {
        message.warning("请填写代理服务器地址（IP 或域名）");
        return;
      }
      if (!config.port || config.port < 1 || config.port > 65535) {
        message.warning("请填写 1-65535 之间的代理端口");
        return;
      }
    }
    setSaving(true);
    try {
      await api.setProxyConfig({
        kind: config.kind,
        host: config.host.trim(),
        port: isDirect ? null : config.port,
      });
      message.success(
        isDirect
          ? "已保存：安装将直接连接（不使用代理）"
          : "已保存：后续安装 node/pnpm/dsh 与插件时将走该代理",
      );
    } catch (e) {
      message.error(String(e instanceof Error ? e.message : e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="settings-nav">
        <span className="settings-nav-title">代理设置</span>
      </div>
      <div className="settings-body">
        <div className="settings-card">
          <div className="settings-card-title">安装代理</div>
          <p className="settings-desc">
            仅对应用内执行的安装操作生效：安装 Node.js / pnpm / dsh、安装与更新插件。
            以临时环境变量注入安装进程，不会改动系统代理、npm/pnpm 配置文件，安装结束即失效。
          </p>
          <div className="settings-row">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <ApiOutlined style={{ color: "var(--text-2)" }} />
              代理类型
            </span>
            <Segmented<ProxyKind>
              options={KIND_OPTIONS}
              value={config.kind}
              onChange={(kind) => setConfig((c) => ({ ...c, kind }))}
            />
          </div>
          <p className="settings-desc">
            选择非「直接连接」的类型后，请填写代理服务器地址与端口。
          </p>
          <div className="settings-row">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <ApiOutlined style={{ color: "var(--text-2)" }} />
              服务器地址
            </span>
            <Input
              style={{ width: 240 }}
              placeholder="IP 或域名，如 127.0.0.1"
              disabled={isDirect}
              value={config.host}
              onChange={(e) => setConfig((c) => ({ ...c, host: e.target.value }))}
            />
          </div>
          <div className="settings-row">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <ApiOutlined style={{ color: "var(--text-2)" }} />
              代理端口
            </span>
            <InputNumber
              style={{ width: 160 }}
              placeholder="1-65535"
              min={1}
              max={65535}
              precision={0}
              disabled={isDirect}
              value={config.port}
              onChange={(v) => setConfig((c) => ({ ...c, port: v ?? null }))}
            />
          </div>
          <p className="settings-desc">
            <Text type="secondary" style={{ fontSize: 12 }}>
              提示：npm/pnpm 仅支持 http/https 代理；选择 SOCKS4/SOCKS5 时，不支持
              socks 的安装工具可能无法加速或失败，此时建议改用代理软件提供的 http 端口。
            </Text>
          </p>
          <Button type="primary" loading={saving} onClick={() => void save()}>
            保存
          </Button>
        </div>
      </div>
    </>
  );
}
