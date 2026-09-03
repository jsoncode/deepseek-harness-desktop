import { create } from "zustand";
import { api } from "../lib/tauri";

export type ModelStatus = "not_downloaded" | "downloading" | "ready" | "error";

/** 推理设备：0 = CPU，1 = GPU */
export type InferenceDevice = 0 | 1;

const STORAGE_KEY = "hl.tts.model.path";
const STATUS_KEY = "hl.tts.model.status";
const DEVICE_KEY = "hl.tts.inference.device";

interface TtsModelState {
  /** 模型目录路径（本地绝对路径，包含 model.onnx 及所有配置文件） */
  modelPath: string | null;
  /** 模型状态 */
  status: ModelStatus;
  /** 下载进度 0-100 */
  progress: number;
  /** 错误信息 */
  error: string | null;
  /** 推理设备：0 = CPU，1 = GPU */
  inferenceDevice: InferenceDevice;

  /** 设置模型目录路径 */
  setModelPath: (path: string) => void;
  /** 设置状态 */
  setStatus: (status: ModelStatus) => void;
  /** 设置进度 */
  setProgress: (progress: number) => void;
  /** 设置错误 */
  setError: (error: string | null) => void;
  /** 设置推理设备 */
  setInferenceDevice: (device: InferenceDevice) => void;
  /** 重置为初始状态 */
  reset: () => void;
  /** 开始下载模型（调用后端或前端 HTTP 下载） */
  startDownload: () => Promise<void>;
  /** 取消下载 */
  cancelDownload: () => Promise<void>;
  /** 测试语音播报 */
  testSpeak: (text: string) => Promise<void>;
  /** 选择本地模型文件 */
  selectLocalModel: () => Promise<void>;
}

function loadModelPath(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function loadStatus(): ModelStatus {
  try {
    const v = localStorage.getItem(STATUS_KEY);
    if (v === "not_downloaded" || v === "downloading" || v === "ready" || v === "error") {
      return v;
    }
  } catch {
    /* ignore */
  }
  return "not_downloaded";
}

function loadDevice(): InferenceDevice {
  try {
    const v = localStorage.getItem(DEVICE_KEY);
    if (v === "0" || v === "1") return parseInt(v, 10) as InferenceDevice;
  } catch {
    /* ignore */
  }
  return 0; // 默认 CPU
}

/** 同步设备选择到 Rust 后端 */
function syncDevice(device: InferenceDevice) {
  void api.setTtsInferenceDevice(device).catch(() => undefined);
}

export const useTtsModelStore = create<TtsModelState>((set, get) => {
  const initialPath = loadModelPath();
  const initialStatus = loadStatus();
  const initialDevice = loadDevice();
  syncDevice(initialDevice);

  return {
    modelPath: initialPath,
    status: initialStatus,
    progress: initialStatus === "ready" ? 100 : 0,
    error: null,
    inferenceDevice: initialDevice,

    setModelPath: (path: string) => {
      try {
        localStorage.setItem(STORAGE_KEY, path);
      } catch {
        /* ignore */
      }
      set({ modelPath: path, status: "ready", progress: 100, error: null });
      try {
        localStorage.setItem(STATUS_KEY, "ready");
      } catch {
        /* ignore */
      }
    },

    setStatus: (status: ModelStatus) => {
      try {
        localStorage.setItem(STATUS_KEY, status);
      } catch {
        /* ignore */
      }
      set({ status });
    },

    setProgress: (progress: number) => {
      set({ progress: Math.max(0, Math.min(100, progress)) });
    },

    setError: (error: string | null) => {
      set({ error, status: error ? "error" : get().status });
    },

    setInferenceDevice: (device: InferenceDevice) => {
      try {
        localStorage.setItem(DEVICE_KEY, String(device));
      } catch {
        /* ignore */
      }
      set({ inferenceDevice: device });
      syncDevice(device);
    },

    reset: () => {
      try {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(STATUS_KEY);
      } catch {
        /* ignore */
      }
      set({ modelPath: null, status: "not_downloaded", progress: 0, error: null });
    },

    startDownload: async () => {
      const { setStatus, setProgress, setError, setModelPath } = get();
      setStatus("downloading");
      setProgress(0);
      setError(null);

      try {
        // 调用后端下载命令
        const modelPath = await api.downloadTtsModel();
        setModelPath(modelPath);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // 直接显示后端返回的友好错误提示（包含手动下载指引）
        setError(msg);
        setStatus("error");
        setProgress(0);
      }
    },

    cancelDownload: async () => {
      try {
        await api.cancelTtsDownload();
        set({ status: "not_downloaded", progress: 0, error: null });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        set({ error: `取消失败: ${msg}` });
      }
    },

    testSpeak: async (text: string) => {
      try {
        // 传递当前配置的模型目录路径
        const modelDir = get().modelPath;
        await api.testTtsSpeak(text, modelDir);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        set({ error: `语音测试失败: ${msg}` });
      }
    },

    selectLocalModel: async () => {
      try {
        // 选择模型目录（而非单个文件）
        const path = await api.selectTtsModelDir();
        if (path) {
          get().setModelPath(path);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        get().setError(`选择目录失败: ${msg}`);
      }
    },
  };
});
