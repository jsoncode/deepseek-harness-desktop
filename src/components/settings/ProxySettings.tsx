import { ApiOutlined, DeleteOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import {
  Button,
  Empty,
  Input,
  InputNumber,
  Segmented,
  Select,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import AntApp from "antd/es/app";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  tauri,
  type DiscoveredHost,
  type ModelProxyRule,
  type ModelProxyStatus,
  type ProxyConfig,
  type ProxyKind,
} from "../../lib/tauri";
import { MODEL_PROVIDERS, findModelProvider } from "../../lib/modelProviders";

const { Text } = Typography;

const KIND_OPTIONS: { label: string; value: ProxyKind }[] = [
  { label: "直接连接", value: "direct" },
  { label: "HTTP", value: "http" },
  { label: "HTTPS", value: "https" },
  { label: "SOCKS4", value: "socks4" },
  { label: "SOCKS5", value: "socks5" },
];

const DEFAULT_CONFIG: ProxyConfig = { kind: "direct", host: "", port: null };

/** 域名规范化（与 Rust `model_proxy::normalize_host` 同义，用于前端去重/校验） */
function normalizeHost(raw: string): string {
  const trimmed = raw.trim().replace(/\.+$/, "");
  const noWildcard = trimmed.replace(/^\*\./, "").replace(/^\./, "");
  const singleColon = /^([^:]+):\d+$/.exec(noWildcard);
  return (singleColon ? singleColon[1] : noWildcard).trim().toLowerCase();
}

/** 时间戳 → HH:MM:SS */
function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
}

/**
 * 代理设置（设置页区块），两张卡片：
 *
 * 1. 「安装代理」：为「安装 node / pnpm / dsh、插件安装」配置临时代理，仅注入安装类子进程。
 * 2. 「模型代理（按提供方）」：按提供方域名决定宿主模型请求走代理还是直连。宿主自身的
 *    出站代理是「每进程一个答案」的全局 dispatcher，没有按域名的入口，所以这里在壳内
 *    起一个 loopback 路由代理，启动 `dsh web` 时把 HTTP(S)_PROXY 指向它，由它逐条判定
 *    去向（见 src-tauri/src/model_proxy.rs）。规则改动即时生效；启用/停用需要重启服务，
 *    因为环境变量只在进程 spawn 时注入一次。
 */
export default function ProxySettings() {
  const { message, modal } = AntApp.useApp();
  const [config, setConfig] = useState<ProxyConfig>(DEFAULT_CONFIG);
  const [saving, setSaving] = useState(false);
  const isDirect = config.kind === "direct";

  const [status, setStatus] = useState<ModelProxyStatus | null>(null);
  const [discovered, setDiscovered] = useState<DiscoveredHost[]>([]);
  const [newHost, setNewHost] = useState("");
  const [busy, setBusy] = useState(false);
  /** 轮询定时器（仅在有请求日志时保持，避免设置页闲置时空转） */
  const timerRef = useRef<number | null>(null);

  const refresh = useCallback(async (withDiscovery = true) => {
    if (!tauri) return;
    try {
      const next = await api.getModelProxyStatus();
      setStatus(next);
      if (withDiscovery) setDiscovered(await api.discoverModelProxyHosts());
    } catch {
      // 设置页读取失败不打扰用户：下一次轮询再试
    }
  }, []);

  useEffect(() => {
    api
      .getProxyConfig()
      .then((cfg) => setConfig(cfg))
      .catch(() => setConfig(DEFAULT_CONFIG));
    void refresh();
  }, [refresh]);

  // 请求日志轮询：仅在路由代理运行时开启（1.5s 一次，开销可忽略）
  useEffect(() => {
    const running = Boolean(status?.running);
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (!running || !tauri) return;
    timerRef.current = window.setInterval(() => void refresh(), 1500);
    return () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [status?.running, refresh]);

  const saveInstallProxy = async () => {
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
      // 模型代理的上游就取自这份配置，保存后立即刷新状态
      await refresh();
    } catch (e) {
      message.error(String(e instanceof Error ? e.message : e));
    } finally {
      setSaving(false);
    }
  };

  /** 写回规则表（开关 / 增删都走这里）。启用状态发生变化时弹框提醒需要重启 */
  const saveRules = async (rules: ModelProxyRule[]) => {
    const before = status?.restartRequired ?? false;
    setBusy(true);
    try {
      const next = await api.setModelProxyConfig({ rules });
      setStatus(next);
      // 只在「刚变成需要重启」时弹一次：连续切换开关不会反复打扰
      if (next.restartRequired && !before) promptRestart(next.injected);
    } catch (e) {
      message.error(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  /**
   * 重启提醒弹框：环境变量只在宿主进程 spawn 时注入一次，所以「启用 / 停用模型代理」
   * 必须重启服务才生效（单条规则的热更新不需要）。确认后只发请求，实际重启由主窗口
   * 执行（见 ServiceRestartHandler）——设置窗口不该自己跑一套启动状态机。
   */
  const promptRestart = (injected: boolean) => {
    modal.confirm({
      title: injected ? "需要重启服务才能停用模型代理" : "需要重启服务才能启用模型代理",
      content: (
        <div>
          <p style={{ margin: "0 0 8px" }}>
            宿主的代理环境变量只在启动时读取一次，因此
            <b>{injected ? "停用" : "启用"}</b>
            需要重启服务后才会作用到宿主进程。
          </p>
          <p style={{ margin: 0, color: "var(--text-3)", fontSize: 12.5 }}>
            单条提供方规则的开关是即时生效的，无需重启。
            重启会中断当前正在进行的对话。
          </p>
        </div>
      ),
      okText: "立即重启",
      cancelText: "稍后",
      width: 460,
      onOk: async () => {
        await api.requestServiceRestart();
        message.success("已请求重启服务，稍后可在主窗口查看进度");
      },
    });
  };

  const rules = status?.rules ?? [];

  const toggleRule = (host: string, enabled: boolean) =>
    void saveRules(rules.map((r) => (r.host === host ? { ...r, enabled } : r)));

  const removeRule = (host: string) =>
    void saveRules(rules.filter((r) => r.host !== host));

  const addRule = () => {
    const host = normalizeHost(newHost);
    if (!host) {
      message.warning("请填写提供方域名，如 api.openai.com");
      return;
    }
    if (rules.some((r) => r.host === host)) {
      message.info(`${host} 已在列表中`);
      setNewHost("");
      return;
    }
    setNewHost("");
    void saveRules([...rules, { host, enabled: true }]);
  };

  const restartService = () => promptRestart(status?.injected ?? false);

  /** 每行的最近请求统计（域名 → 次数 / 最近时间） */
  const usage = useMemo(() => {
    const map = new Map<string, { hits: number; last: number }>();
    for (const req of status?.requests ?? []) {
      const cur = map.get(req.host);
      if (cur) {
        cur.hits += 1;
        cur.last = Math.max(cur.last, req.ts);
      } else {
        map.set(req.host, { hits: 1, last: req.ts });
      }
    }
    return map;
  }, [status?.requests]);

  /** 「添加提供方」下拉：目录 + 实测发现，排除已在规则里的 */
  const addOptions = useMemo(() => {
    const existing = new Set(rules.map((r) => r.host));
    const seen = new Set<string>();
    const options: { label: string; value: string }[] = [];
    for (const d of discovered) {
      if (existing.has(d.host) || seen.has(d.host)) continue;
      seen.add(d.host);
      options.push({
        label: `${findModelProvider(d.host)?.label ?? d.host}（${d.host}）· 已发现`,
        value: d.host,
      });
    }
    for (const p of MODEL_PROVIDERS) {
      if (existing.has(p.host) || seen.has(p.host)) continue;
      seen.add(p.host);
      options.push({ label: `${p.label}（${p.host}）`, value: p.host });
    }
    return options;
  }, [discovered, rules]);

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
          <Button type="primary" loading={saving} onClick={() => void saveInstallProxy()}>
            保存
          </Button>
        </div>

        <div className="settings-card">
          <div className="settings-card-title">
            模型代理（按提供方）
            <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
              仅对宿主（dsh web）的模型请求生效
            </Text>
          </div>
          <p className="settings-desc">
            宿主的模型请求统一由它自己的全局网络策略发出，没有按域名的配置入口。
            这里在应用内起一个只监听 127.0.0.1 的路由代理，启动服务时把宿主指向它，
            再由它逐条决定：命中下方规则的域名走上面的「安装代理」，
            其余域名保持原样（沿用系统里已有的代理环境变量，没有则直连）。
            只做隧道转发，不解密 TLS，因此只能看到域名与去向。
          </p>
          <p className="settings-desc">
            <Text type="secondary" style={{ fontSize: 12 }}>
              <Tag color={status?.running ? "green" : "default"}>
                {status?.running ? `运行中 :${status.port}` : "未运行"}
              </Tag>
              {status?.injected ? (
                <Tag color="blue">宿主已接入</Tag>
              ) : (
                <Tag>宿主未接入</Tag>
              )}
              {status?.upstream ? (
                <span>
                  命中规则走 <Text code>{status.upstream}</Text>
                </span>
              ) : (
                <span>暂无可用的代理地址</span>
              )}
              {status?.fallback ? (
                <span>
                  ；其余走 <Text code>{status.fallback}</Text>
                </span>
              ) : (
                <span>；其余直连</span>
              )}
            </Text>
          </p>
          {status?.reason ? (
            <p className="settings-desc">
              <Text type="warning" style={{ fontSize: 12 }}>
                {status.reason}
              </Text>
            </p>
          ) : null}
          {status?.restartRequired ? (
            <p className="settings-desc">
              <Text type="warning" style={{ fontSize: 12 }}>
                启用状态已改变，需要重启服务后才会作用到宿主进程。
              </Text>{" "}
              <Button size="small" onClick={restartService}>
                重启服务
              </Button>
            </p>
          ) : null}

          <Table<ModelProxyRule>
            size="small"
            rowKey="host"
            style={{ marginTop: 8 }}
            pagination={false}
            loading={busy}
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="尚未启用任何提供方；在下方添加域名即可"
                />
              ),
            }}
            dataSource={rules}
            columns={[
              {
                title: "提供方",
                dataIndex: "host",
                render: (host: string) => {
                  const provider = findModelProvider(host);
                  return (
                    <span>
                      {provider ? (
                        <>
                          {provider.label}{" "}
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            {host}
                          </Text>
                        </>
                      ) : (
                        <Text code>{host}</Text>
                      )}
                    </span>
                  );
                },
              },
              {
                title: "最近请求",
                width: 190,
                render: (_: unknown, row: ModelProxyRule) => {
                  const stat = usage.get(row.host);
                  if (!stat) {
                    return (
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        暂无
                      </Text>
                    );
                  }
                  return (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {formatTime(stat.last)} · {stat.hits} 次
                    </Text>
                  );
                },
              },
              {
                title: "启用代理",
                width: 110,
                render: (_: unknown, row: ModelProxyRule) => (
                  <Tooltip title={row.enabled ? "该提供方的请求走「安装代理」" : "保持原样（直连或系统代理）"}>
                    <Switch
                      checked={row.enabled}
                      loading={busy}
                      onChange={(checked) => toggleRule(row.host, checked)}
                    />
                  </Tooltip>
                ),
              },
              {
                title: "",
                width: 48,
                render: (_: unknown, row: ModelProxyRule) => (
                  <Button
                    type="text"
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() => removeRule(row.host)}
                  />
                ),
              },
            ]}
          />

          <div className="settings-row" style={{ marginTop: 12, gap: 8 }}>
            <Select
              style={{ width: 340 }}
              showSearch
              placeholder="选择提供方，或直接输入域名"
              value={null}
              searchValue={newHost}
              onSearch={setNewHost}
              onChange={(value: string) => setNewHost(value)}
              options={addOptions}
              filterOption={(input, option) =>
                String(option?.value ?? "").includes(input.trim().toLowerCase()) ||
                String(option?.label ?? "").toLowerCase().includes(input.trim().toLowerCase())
              }
              notFoundContent={
                <Text type="secondary" style={{ fontSize: 12 }}>
                  未收录？直接输入域名后点「添加」
                </Text>
              }
            />
            <Button type="primary" icon={<PlusOutlined />} loading={busy} onClick={addRule}>
              添加
            </Button>
          </div>

          <div className="settings-card-title" style={{ marginTop: 20, fontSize: 13 }}>
            最近请求
            <Button
              type="link"
              size="small"
              icon={<ReloadOutlined />}
              onClick={() => void refresh()}
              style={{ marginLeft: 8 }}
            >
              刷新
            </Button>
            <Button
              type="link"
              size="small"
              onClick={async () => {
                await api.clearModelProxyLog();
                await refresh();
              }}
            >
              清空
            </Button>
          </div>
          <div style={{ maxHeight: 220, overflowY: "auto" }}>
            {(status?.requests ?? []).length === 0 ? (
              <Text type="secondary" style={{ fontSize: 12 }}>
                还没有观测到宿主的出站请求（仅在规则启用且服务已重启后开始记录）。
              </Text>
            ) : (
              <table className="settings-proxy-log">
                <tbody>
                  {(status?.requests ?? []).slice(0, 60).map((req, index) => (
                    <tr key={`${req.ts}-${req.host}-${index}`}>
                      <td style={{ width: 78 }}>{formatTime(req.ts)}</td>
                      <td>
                        <Text code style={{ fontSize: 12 }}>
                          {req.host}:{req.port}
                        </Text>
                      </td>
                      <td style={{ width: 64 }}>
                        <Tag color={req.via === "proxy" ? "blue" : "default"}>{req.via}</Tag>
                      </td>
                      <td>
                        {req.ok ? (
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            {req.upstream ?? "直连"}
                          </Text>
                        ) : (
                          <Text type="danger" style={{ fontSize: 12 }}>
                            {req.error ?? "失败"}
                          </Text>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
