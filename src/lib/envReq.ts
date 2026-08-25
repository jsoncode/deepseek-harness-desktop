// ---------------------------------------------------------------------------
// 运行环境要求与版本判定（启动页 / 状态机共用）
// ---------------------------------------------------------------------------

/** 环境要求：Node.js ≥ 22.19 */
export const MIN_NODE_MAJOR = 22;
export const MIN_NODE_MINOR = 19;

export function parseNodeVersion(v: string | null): { major: number; minor: number } | null {
  if (!v) return null;
  const m = /^(\d+)\.(\d+)/.exec(v);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]) };
}

export function meetsNodeRequirement(version: string | null): boolean {
  const parsed = parseNodeVersion(version);
  if (!parsed) return false;
  return (
    parsed.major > MIN_NODE_MAJOR ||
    (parsed.major === MIN_NODE_MAJOR && parsed.minor >= MIN_NODE_MINOR)
  );
}
