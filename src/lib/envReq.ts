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

/** pnpm 主版本号；无法解析时返回 0（视为未知，不触发 pnpm 11 处理） */
export function pnpmMajorOf(version: string | null | undefined): number {
  if (!version) return 0;
  const m = /^(\d+)/.exec(version.trim());
  return m ? Number(m[1]) : 0;
}

/** 解析 semver：主/次/补丁 + 可选预发布段（"0.1.5-rc.1" → core [0,1,5], pre ["rc","1"]） */
function parseSemver(v: string): { core: number[]; pre: string[] | null } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v.trim());
  if (!m) return null;
  return {
    core: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ? m[4].split(".") : null,
  };
}

/**
 * semver 比较（semver.org 规则）：a > b 返回正数。
 * 正式版 > 预发布；预发布段逐个比较——数值标识符按数值且小于字母标识符，
 * 前缀相同时更长者更新。任一侧无法解析返回 null（调用方按未知处理）。
 */
export function semverCompare(a: string, b: string): number | null {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) {
    if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  }
  if (!x.pre && !y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const xi = x.pre[i];
    const yi = y.pre[i];
    if (xi === undefined) return 1;
    if (yi === undefined) return -1;
    const xn = /^\d+$/.test(xi);
    const yn = /^\d+$/.test(yi);
    if (xn && yn) {
      const d = Number(xi) - Number(yi);
      if (d) return d;
    } else if (xn) {
      return -1;
    } else if (yn) {
      return 1;
    } else if (xi !== yi) {
      return xi < yi ? -1 : 1;
    }
  }
  return 0;
}
