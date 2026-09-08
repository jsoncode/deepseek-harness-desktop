/**
 * 模型提供方域名目录（设置页「模型代理」的候选行）。
 *
 * 来源：宿主内置的 pi-ai 提供方目录（`@earendil-works/pi-ai/dist/providers/*.js`
 * 里各 provider 的 `baseUrl`），以及 `dsh-llm-deepseek` 的默认端点
 * `https://api.deepseek.com`。这里只保留「按域名启用代理」需要的三项信息：
 * 提供方标识、展示名、端点域名。
 *
 * 注意：这只是候选清单。用户实际配置的提供方以 `$DSH_HOME/settings.yaml`
 * 为准（由 `discoverModelProxyHosts` 读出），代理实际见过的域名也会被补充进来。
 */
export interface ModelProvider {
  /** 提供方标识（pi-ai 目录里的 provider id） */
  id: string;
  /** 展示名 */
  label: string;
  /** 端点域名 */
  host: string;
}

/** 常见提供方端点目录（按展示名排序前的原始顺序：主流 → 国内 → 网关） */
export const MODEL_PROVIDERS: ModelProvider[] = [
  { id: "openai", label: "OpenAI", host: "api.openai.com" },
  { id: "anthropic", label: "Anthropic Claude", host: "api.anthropic.com" },
  { id: "google", label: "Google Gemini", host: "generativelanguage.googleapis.com" },
  { id: "deepseek", label: "DeepSeek", host: "api.deepseek.com" },
  { id: "openrouter", label: "OpenRouter", host: "openrouter.ai" },
  { id: "xai", label: "xAI Grok", host: "api.x.ai" },
  { id: "mistral", label: "Mistral", host: "api.mistral.ai" },
  { id: "groq", label: "Groq", host: "api.groq.com" },
  { id: "moonshotai-cn", label: "Moonshot 月之暗面（国内）", host: "api.moonshot.cn" },
  { id: "moonshotai", label: "Moonshot（国际）", host: "api.moonshot.ai" },
  { id: "kimi-coding", label: "Kimi Coding", host: "api.kimi.com" },
  { id: "zai", label: "Z.ai", host: "api.z.ai" },
  { id: "zhipu-cn", label: "智谱 BigModel", host: "open.bigmodel.cn" },
  { id: "minimax", label: "MiniMax（国际）", host: "api.minimax.io" },
  { id: "minimax-cn", label: "MiniMax（国内）", host: "api.minimaxi.com" },
  { id: "xiaomi", label: "小米 MiMo", host: "api.xiaomimimo.com" },
  { id: "together", label: "Together AI", host: "api.together.ai" },
  { id: "fireworks", label: "Fireworks AI", host: "api.fireworks.ai" },
  { id: "cerebras", label: "Cerebras", host: "api.cerebras.ai" },
  { id: "baseten", label: "Baseten", host: "inference.baseten.co" },
  { id: "nvidia", label: "NVIDIA NIM", host: "integrate.api.nvidia.com" },
  { id: "huggingface", label: "Hugging Face", host: "router.huggingface.co" },
  { id: "vercel-ai-gateway", label: "Vercel AI Gateway", host: "ai-gateway.vercel.sh" },
  {
    id: "github-copilot",
    label: "GitHub Copilot",
    host: "api.individual.githubcopilot.com",
  },
  { id: "openai-codex", label: "ChatGPT Codex", host: "chatgpt.com" },
  { id: "ant-ling", label: "蚂蚁百灵", host: "api.ant-ling.com" },
  {
    id: "qwen-token-plan-cn",
    label: "通义千问 Token Plan（北京）",
    host: "token-plan.cn-beijing.maas.aliyuncs.com",
  },
];

/** 按域名查目录项（未收录返回 undefined） */
export function findModelProvider(host: string): ModelProvider | undefined {
  const target = host.trim().toLowerCase();
  return MODEL_PROVIDERS.find((p) => p.host === target);
}
