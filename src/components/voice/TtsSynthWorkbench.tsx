import { useEffect, useState } from "react";
import { App as AntApp } from "antd";
import {
  FolderOpenOutlined,
  PlayCircleOutlined,
  SaveOutlined,
  SoundOutlined,
} from "@ant-design/icons";
import { Button, Input, Progress, Space, Typography } from "antd";
import { save } from "@tauri-apps/plugin-dialog";
import { api, EVENTS, onEvent, type TtsSynthProgress } from "../../lib/tauri";

const { Text } = Typography;

/** 单段合成上限提示（与 Rust SYNTH_CHUNK_CHARS 一致，仅用于预估展示） */
const CHUNK_CHARS = 120;

/** 文件路径 → 所在目录（「打开文件夹」用；缺分隔符时原样返回） */
export function dirOf(p: string) {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i > 0 ? p.slice(0, i) : p;
}

export interface TtsSynthWorkbenchProps {
  /** 紧凑形态（弹框内使用）：输入框行数收窄，省去长说明文案 */
  compact?: boolean;
}

/**
 * 长文本合成工作台（共享组件）：输入大段文字，Rust 侧按句分段（≤120 字/段）
 * 逐段合成（每段独立吃缓存）后拼接导出 WAV，支持播放预览 / 另存为 / 打开所在文件夹。
 * 语音合成工具窗口（/tts-studio）与主窗口「语音合成」弹框共用本组件；
 * 合成由 Rust 后端执行，弹框关闭后任务继续，重开可见最新分段进度。
 */
export default function TtsSynthWorkbench({ compact = false }: TtsSynthWorkbenchProps) {
  const { message } = AntApp.useApp();
  const [text, setText] = useState("");
  const [synthesizing, setSynthesizing] = useState(false);
  const [progress, setProgress] = useState<TtsSynthProgress | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [exporting, setExporting] = useState(false);

  // 分段进度（Rust tts.rs 每完成一段 emit 一次）
  useEffect(() => {
    let unbind: (() => void) | undefined;
    void onEvent<TtsSynthProgress>(EVENTS.ttsSynthProgress, (p) => {
      setProgress(p);
    }).then((u) => {
      unbind = u;
    });
    return () => unbind?.();
  }, []);

  const trimmed = text.trim();
  const estChunks = trimmed ? Math.max(1, Math.ceil(trimmed.length / CHUNK_CHARS)) : 0;

  const runSynth = async () => {
    if (synthesizing) return;
    if (!trimmed) {
      message.warning("请输入要合成的文本");
      return;
    }
    setSynthesizing(true);
    setProgress(null);
    setResult(null);
    try {
      const out = await api.ttsSynthesize(trimmed);
      setResult(out);
      message.success("合成完成");
    } catch (e) {
      message.error(`合成失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSynthesizing(false);
      setProgress(null);
    }
  };

  const onPlay = async () => {
    if (!result || playing) return;
    setPlaying(true);
    try {
      // 命令在整段播放结束后才返回（rodio sleep_until_end）
      await api.ttsPlayFile(result);
    } catch (e) {
      message.error(`播放失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPlaying(false);
    }
  };

  const onExport = async () => {
    if (!result || exporting) return;
    setExporting(true);
    try {
      const dest = await save({
        title: "导出 WAV 音频",
        defaultPath: "tts-导出.wav",
        filters: [{ name: "WAV 音频", extensions: ["wav"] }],
      });
      if (!dest) return;
      await api.ttsExportWav(result, dest);
      message.success(`已导出到 ${dest}`);
    } catch (e) {
      message.error(`导出失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExporting(false);
    }
  };

  const onOpenFolder = async () => {
    if (!result) return;
    try {
      await api.ttsOpenPath(dirOf(result));
    } catch (e) {
      message.error(`打开文件夹失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const synthBusy = synthesizing || playing || exporting;

  return (
    <div className="settings-card">
      <div className="settings-card-title">长文本合成</div>
      {!compact && (
        <p className="settings-desc">
          输入一大段文字，按句子边界分段（每段 ≤{CHUNK_CHARS} 字）逐段合成后自动拼接成
          一条完整音频。每段独立缓存：改几个字重新合成时，未变化的段落直接复用。
        </p>
      )}
      <Input.TextArea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="输入要合成的文本，支持多段落与中英混排…"
        autoSize={{ minRows: compact ? 4 : 6, maxRows: compact ? 10 : 14 }}
        maxLength={20000}
        showCount
        disabled={synthBusy}
      />
      <Space style={{ marginTop: 10 }} wrap>
        <Button
          type="primary"
          icon={<SoundOutlined />}
          loading={synthesizing}
          disabled={synthBusy || !trimmed}
          onClick={() => void runSynth()}
        >
          开始合成
        </Button>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {trimmed
            ? `约 ${trimmed.length} 字 · 预计分 ${estChunks} 段`
            : "首次合成需加载模型（约 1~2 分钟），之后常驻"}
        </Text>
      </Space>
      {synthesizing && (
        <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
          <Progress
            percent={progress ? Math.round((progress.current / progress.total) * 100) : 0}
            size="small"
            format={() => (progress ? `${progress.current}/${progress.total} 段` : "准备中…")}
          />
          {!progress && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              首段通常最慢（模型加载），后续段落会明显加快
            </Text>
          )}
        </div>
      )}
      {result && !synthesizing && (
        <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
          <Text type="secondary" style={{ fontSize: 12, wordBreak: "break-all" }}>
            已生成：{result}
          </Text>
          <Space wrap>
            <Button size="small" icon={<PlayCircleOutlined />} loading={playing} onClick={() => void onPlay()}>
              播放预览
            </Button>
            <Button size="small" icon={<SaveOutlined />} loading={exporting} onClick={() => void onExport()}>
              导出 WAV
            </Button>
            <Button size="small" icon={<FolderOpenOutlined />} onClick={() => void onOpenFolder()}>
              打开文件夹
            </Button>
          </Space>
        </div>
      )}
    </div>
  );
}
