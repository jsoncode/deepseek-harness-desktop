import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { App as AntApp } from "antd";
import { Button, Popconfirm, Space, Tag, Typography } from "antd";
import {
  ArrowLeftOutlined,
  DeleteOutlined,
  FolderOpenOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SoundOutlined,
} from "@ant-design/icons";
import { dirOf } from "../components/voice/TtsSynthWorkbench";
import { api, type VoiceHistoryEntry } from "../lib/tauri";

const { Text } = Typography;

/** 来源 → 标签（与 Rust tts.rs 的 source 字段对应） */
const SOURCE_META: Record<VoiceHistoryEntry["source"], { label: string; color: string }> = {
  notify: { label: "通知播报", color: "blue" },
  test: { label: "试听", color: "cyan" },
  studio: { label: "长文本合成", color: "purple" },
};

/** unix 毫秒 → 本地时间字符串 */
function formatTs(tsMs: number): string {
  return new Date(tsMs).toLocaleString("zh-CN", { hour12: false });
}

/** 文件路径 → 文件名（供 meta 行展示；无分隔符时原样返回） */
function baseName(p: string) {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i >= 0 ? p.slice(i + 1) : p;
}

/**
 * 语音生成历史页（语音合成工具窗口 /tts-studio/history）：记录所有生成过的
 * 语音——通知播报、试听与长文本合成导出（Rust 侧 history.jsonl，LRU 200 条）。
 * 支持播放预览（rodio 原生播放，与通知同通道）、删除（无其他引用时连 WAV 一起删）、
 * 打开所在文件夹；文件已被缓存上限清理的条目标记「文件已缺失」并禁用播放。
 */
export default function TtsHistory() {
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const [items, setItems] = useState<VoiceHistoryEntry[] | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await api.ttsHistoryList();
      setItems(list);
    } catch (e) {
      setItems([]);
      message.error(`加载历史失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }, [message]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onPlay = async (item: VoiceHistoryEntry) => {
    if (playingId) return;
    setPlayingId(item.id);
    try {
      // 命令在整段播放结束后才返回（rodio sleep_until_end）
      await api.ttsPlayFile(item.path);
    } catch (e) {
      message.error(`播放失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPlayingId(null);
    }
  };

  const onOpenFolder = async (item: VoiceHistoryEntry) => {
    try {
      await api.ttsOpenPath(dirOf(item.path));
    } catch (e) {
      message.error(`打开文件夹失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const onDelete = async (item: VoiceHistoryEntry) => {
    if (deletingId) return;
    setDeletingId(item.id);
    try {
      await api.ttsHistoryDelete(item.id);
      message.success("已删除该条记录");
      await refresh();
    } catch (e) {
      message.error(`删除失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <>
      <div className="settings-nav">
        <span className="settings-nav-title">语音生成历史</span>
        <div className="settings-nav-actions">
          <Button size="small" icon={<ArrowLeftOutlined />} onClick={() => navigate("/tts-studio")}>
            返回合成
          </Button>
          <Button size="small" icon={<ReloadOutlined />} loading={items === null} onClick={() => void refresh()}>
            刷新
          </Button>
        </div>
      </div>
      <div className="settings-body">
        <p className="settings-desc">
          记录所有生成过的语音（通知播报 / 试听 / 长文本合成导出，最多保留 200 条）。
          删除记录时，若无其他记录引用同一音频文件会一并删除 WAV 文件；被缓存上限
          自动清理过的条目会标记「文件已缺失」。
        </p>
        {items === null ? (
          <div className="settings-card">
            <Text type="secondary">正在加载历史记录…</Text>
          </div>
        ) : items.length === 0 ? (
          <div className="settings-card">
            <Text type="secondary">
              还没有生成记录：配置好语音后，通知播报、试听与长文本合成的每一段音频都会出现在这里。
            </Text>
          </div>
        ) : (
          <div className="tts-hist-list">
            {items.map((item) => {
              const meta = SOURCE_META[item.source] ?? { label: item.source, color: "default" };
              const playing = playingId === item.id;
              const busy = playingId !== null;
              return (
                <div className="tts-hist-item" key={item.id}>
                  <div className="tts-hist-main">
                    <div className="tts-hist-head">
                      <Space size={6} wrap>
                        <Tag color={meta.color} style={{ marginInlineEnd: 0 }}>
                          {meta.label}
                        </Tag>
                        {item.source === "studio" && item.chunks > 1 && (
                          <Tag style={{ marginInlineEnd: 0 }}>{item.chunks} 段</Tag>
                        )}
                        {!item.exists && (
                          <Tag color="warning" style={{ marginInlineEnd: 0 }}>
                            文件已缺失
                          </Tag>
                        )}
                      </Space>
                      <Text type="secondary" className="tts-hist-time">
                        {formatTs(item.tsMs)}
                      </Text>
                    </div>
                    <div className="tts-hist-text" title={item.text}>
                      {item.text}
                    </div>
                    <Text type="secondary" className="tts-hist-file" title={item.path}>
                      {baseName(item.path)}
                    </Text>
                  </div>
                  <div className="tts-hist-actions">
                    <Button
                      size="small"
                      type="primary"
                      ghost
                      icon={<PlayCircleOutlined />}
                      loading={playing}
                      disabled={busy || !item.exists}
                      onClick={() => void onPlay(item)}
                    >
                      播放
                    </Button>
                    <Button
                      size="small"
                      icon={<FolderOpenOutlined />}
                      disabled={!item.exists}
                      onClick={() => void onOpenFolder(item)}
                    >
                      打开文件夹
                    </Button>
                    <Popconfirm
                      title="删除这条记录？"
                      description="无其他记录引用同一文件时，WAV 音频会一并删除。"
                      okText="删除"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                      placement="topRight"
                      onConfirm={() => void onDelete(item)}
                    >
                      <Button size="small" danger ghost icon={<DeleteOutlined />} loading={deletingId === item.id}>
                        删除
                      </Button>
                    </Popconfirm>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {items !== null && items.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 12 }}>
            <SoundOutlined style={{ color: "var(--text-3)" }} />
            <Text type="secondary" style={{ fontSize: 12 }}>
              共 {items.length} 条 · 最新在上 · 播放走 rodio 原生输出，窗口失焦照常出声
            </Text>
          </div>
        )}
      </div>
    </>
  );
}
