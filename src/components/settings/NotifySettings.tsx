import { BellOutlined, SoundOutlined, DownloadOutlined, FolderOpenOutlined, DesktopOutlined } from "@ant-design/icons";
import { Segmented, Switch, Button, Progress } from "antd";
import { useNotifyStore, type NotifyStyle } from "../../store/useNotifyStore";
import { useTtsModelStore, type InferenceDevice } from "../../store/useTtsModelStore";

/**
 * 通知管理（设置页区块）：原底部导航条 NotifyToggle 的完整形态——
 * 总开关 + 消息样式（可点击/不可点击）切换，说明 dsh 会话事件通知的触发场景。
 * 新增：语音播报开关 + 模型配置区域（参考 Audio8_TTS 项目的小尺寸模型 CPU 推理方案）
 */
export default function NotifySettings() {
  const mode = useNotifyStore((s) => s.mode);
  const toggle = useNotifyStore((s) => s.toggle);
  const style = useNotifyStore((s) => s.style);
  const setStyle = useNotifyStore((s) => s.setStyle);
  const voiceEnabled = useNotifyStore((s) => s.voiceEnabled);
  const toggleVoice = useNotifyStore((s) => s.toggleVoice);
  const on = mode === "on";

  // TTS 模型状态
  const modelPath = useTtsModelStore((s) => s.modelPath);
  const modelStatus = useTtsModelStore((s) => s.status);
  const modelProgress = useTtsModelStore((s) => s.progress);
  const modelError = useTtsModelStore((s) => s.error);
  const inferenceDevice = useTtsModelStore((s) => s.inferenceDevice);
  const setInferenceDevice = useTtsModelStore((s) => s.setInferenceDevice);
  const startDownload = useTtsModelStore((s) => s.startDownload);
  const selectLocalModel = useTtsModelStore((s) => s.selectLocalModel);

  const isDownloading = modelStatus === "downloading";
  const isReady = modelStatus === "ready";

  return (
    <>
      <div className="settings-nav">
        <span className="settings-nav-title">通知管理</span>
      </div>
      <div className="settings-body">
        <div className="settings-card">
          <div className="settings-card-title">系统推送</div>
          <p className="settings-desc">
            dsh 会话事件（任务清单更新、对话结束等）发生时，是否弹出操作系统通知。
            关闭后事件仍会被记录，只是不再打扰你；开关状态会同步到后端推送线程。
          </p>
          <div className="settings-row">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <BellOutlined style={{ color: "var(--text-2)" }} />
              系统通知
            </span>
            <Switch checked={on} onChange={() => toggle()} />
          </div>
          <p className="settings-desc">
            消息样式决定通知的外观：可点击样式带「打开对话」按钮，点击直达对应会话的
            对话框；不可点击样式为原有外观，仅展示提醒。
          </p>
          <div className="settings-row">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <BellOutlined style={{ color: "var(--text-2)" }} />
              消息样式
            </span>
            <Segmented<NotifyStyle>
              options={[
                { label: "可点击", value: "clickable" },
                { label: "不可点击", value: "plain" },
              ]}
              value={style}
              onChange={(v) => setStyle(v)}
            />
          </div>
        </div>

        {/* 语音播报设置卡片 */}
        <div className="settings-card">
          <div className="settings-card-title">语音播报</div>
          <p className="settings-desc">
            启用后，系统通知内容将通过 TTS（文字转语音）引擎朗读。参考 Audio8_TTS
            项目，使用小尺寸 ONNX 模型在 CPU 上进行推理，适合低配电脑使用。
          </p>
          <div className="settings-row">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <SoundOutlined style={{ color: "var(--text-2)" }} />
              语音播报
            </span>
            <Switch checked={voiceEnabled} onChange={() => toggleVoice()} />
          </div>

          {/* 模型配置区域：仅在语音播报开启时显示 */}
          {voiceEnabled && (
            <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--border-1)" }}>
              <div className="settings-card-title" style={{ fontSize: 14 }}>
                模型配置
              </div>
              <p className="settings-desc">
                推荐使用 Audio8_TTS 的小尺寸模型（如 audio8-TTS-0.1B-ONNX-INT8），
                参数量小、INT8 量化，适合 CPU 推理。模型文件将下载到本地缓存目录。
              </p>

              {/* 模型状态展示 */}
              <div style={{ marginTop: 12 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                  <span>模型状态</span>
                  <span style={{ color: "var(--text-3)", fontSize: 12 }}>
                    {modelStatus === "not_downloaded" && "未下载"}
                    {modelStatus === "downloading" && "下载中..."}
                    {modelStatus === "ready" && "已就绪"}
                    {modelStatus === "error" && "错误"}
                  </span>
                </div>
                <Progress
                  percent={modelProgress}
                  size="small"
                  status={modelStatus === "error" ? "exception" : modelStatus === "ready" ? "success" : "active"}
                />
                {modelPath && (
                  <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-3)", wordBreak: "break-all" }}>
                    {modelPath}
                  </div>
                )}
                {modelError && (
                  <div
                    style={{
                      marginTop: 4,
                      fontSize: 12,
                      color: "#ff4d4f",
                      userSelect: "text",
                      cursor: "text",
                      padding: "8px",
                      backgroundColor: "rgba(255, 77, 79, 0.1)",
                      borderRadius: "4px",
                      border: "1px solid rgba(255, 77, 79, 0.3)",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                    }}
                    title="可选择文本并复制 (Ctrl+C)"
                  >
                    {modelError}
                  </div>
                )}
              </div>

              <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
                <Button
                  icon={<DownloadOutlined />}
                  size="small"
                  loading={isDownloading}
                  disabled={isDownloading || isReady}
                  onClick={() => startDownload()}
                >
                  下载模型 (0.1B INT8)
                </Button>
                {isDownloading && (
                  <Button size="small" danger onClick={() => useTtsModelStore.getState().cancelDownload()}>
                    停止
                  </Button>
                )}
                <Button
                  icon={<FolderOpenOutlined />}
                  size="small"
                  disabled={isDownloading}
                  onClick={() => selectLocalModel()}
                >
                  选择本地模型目录
                </Button>
              </div>

              {/* 推理设备选择 */}
              <div style={{ marginTop: 16 }}>
                <div className="settings-row">
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                    <DesktopOutlined style={{ color: "var(--text-2)" }} />
                    推理设备
                  </span>
                  <Segmented<InferenceDevice>
                    options={[
                      { label: "CPU", value: 0 },
                      { label: "GPU", value: 1 },
                    ]}
                    value={inferenceDevice}
                    onChange={(v) => setInferenceDevice(v)}
                  />
                </div>
                <p className="settings-desc" style={{ marginTop: 4, fontSize: 12 }}>
                  CPU：兼容性好，适合低配电脑；GPU：需 CUDA/DirectML 支持，速度更快
                </p>
              </div>

              {/* 语音测试区域 */}
              <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--border-1)" }}>
                <div className="settings-card-title" style={{ fontSize: 14 }}>
                  语音测试
                </div>
                <p className="settings-desc">
                  输入文字测试当前模型的语音播报效果。确保已配置模型目录后才能正常试听。
                </p>
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <input
                    type="text"
                    placeholder="输入要测试的文字..."
                    style={{
                      flex: 1,
                      padding: "4px 8px",
                      border: "1px solid var(--border-1)",
                      borderRadius: 4,
                      fontSize: 13,
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && e.currentTarget.value.trim()) {
                        useTtsModelStore.getState().testSpeak(e.currentTarget.value.trim());
                        e.currentTarget.value = "";
                      }
                    }}
                  />
                  <Button
                    size="small"
                    onClick={(e) => {
                      const input = (e.currentTarget.parentElement?.querySelector("input") as HTMLInputElement);
                      if (input && input.value.trim()) {
                        useTtsModelStore.getState().testSpeak(input.value.trim());
                        input.value = "";
                      }
                    }}
                  >
                    测试
                  </Button>
                </div>
              </div>

              <p className="settings-desc" style={{ marginTop: 8, fontSize: 12 }}>
                模型来源：Hugging Face - Audio8/audio8-TTS-0.1B-ONNX-INT8
                <br />
                推理后端：ONNX Runtime (CPU/GPU)
                <br />
                <span style={{ color: "var(--text-3)" }}>
                  注意：模型为完整目录，包含多个 .onnx 文件及配置文件
                </span>
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
