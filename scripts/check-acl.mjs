#!/usr/bin/env node
/**
 * 构建前置自检：`#[tauri::command]` 注册表 ↔ 应用 ACL 放行清单 一致性校验。
 *
 * 背景：src-tauri/permissions 下存在自定义权限后，Tauri 判定"应用已定义 ACL"，
 * 本地窗口的 invoke 也走严格校验——未登记的的命令一律返回
 * `<cmd> not allowed. Command found`。前端若没有逐个 catch，表现就是
 * 「点了按钮没反应」（弹框停留、无报错），极难定位。
 *
 * 这里在构建前把三份清单对齐：
 *   ① lib.rs `generate_handler![]` 里注册的命令（唯一事实来源）
 *   ② permissions/app-commands/default.toml 的 commands.allow（本地窗口放行）
 *   ③ permissions/preview-bridge/default.toml 的 commands.allow（远程预览子 webview 专用）
 * 规则：注册的命令必须恰好出现在 ①/②/③ 之一里，且 ②③ 不得出现未注册的命令。
 *
 * 退出码：0 = 一致；1 = 不一致（阻止构建，并在输出里列出差异与修法）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const libRs = join(root, 'src-tauri', 'src', 'lib.rs')
const appAcl = join(root, 'src-tauri', 'permissions', 'app-commands', 'default.toml')
const bridgeAcl = join(root, 'src-tauri', 'permissions', 'preview-bridge', 'default.toml')

function fail(msg) {
  console.error('[check-acl] ✗ ' + msg)
  process.exit(1)
}

function readOrFail(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch (e) {
    fail(`读取失败 ${path}: ${e.message}`)
  }
}

/** 解析 generate_handler![ ... ] 里的 `模块::命令` 列表 */
function parseHandlers(src) {
  const m = src.match(/generate_handler!\s*\[([\s\S]*?)\]/)
  if (!m) fail('lib.rs 里找不到 generate_handler![...]')
  const names = [...m[1].matchAll(/\b(\w+)::(\w+)\b/g)].map((x) => x[2])
  if (names.length === 0) fail('generate_handler![...] 解析出 0 个命令')
  return new Set(names)
}

/** 解析 toml 里 commands.allow = [ "a", "b" ] */
function parseAllow(path) {
  const src = readOrFail(path)
  const m = src.match(/commands\.allow\s*=\s*\[([\s\S]*?)\]/)
  if (!m) fail(`${path} 里找不到 commands.allow = [...]`)
  return new Set([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]))
}

const handlers = parseHandlers(readOrFail(libRs))
const localAllowed = parseAllow(appAcl)
const bridgeAllowed = parseAllow(bridgeAcl)

const declared = new Set([...localAllowed, ...bridgeAllowed])
const unregistered = [...declared].filter((c) => !handlers.has(c)).sort()
const unlisted = [...handlers].filter((c) => !declared.has(c)).sort()

if (unregistered.length || unlisted.length) {
  console.error('')
  console.error('[check-acl] ✗ 命令注册表与 ACL 放行清单不一致：')
  if (unlisted.length) {
    console.error('[check-acl]   已注册但未放行（invoke 会被拒绝，表现为「点按钮没反应」）:')
    for (const c of unlisted) console.error(`[check-acl]     ${c}`)
    console.error(`[check-acl]   → 在 src-tauri/permissions/app-commands/default.toml 的 commands.allow 追加`)
  }
  if (unregistered.length) {
    console.error('[check-acl]   ACL 放行但未在 lib.rs 注册（死条目，或命令已被删除）:')
    for (const c of unregistered) console.error(`[check-acl]     ${c}`)
    console.error('[check-acl]   → 从对应 permissions/*/default.toml 移除，或在 lib.rs 补上 #[tauri::command] 注册')
  }
  console.error('')
  process.exit(1)
}

console.log(`[check-acl] ✓ 命令 ACL 一致（注册 ${handlers.size} 个：本地窗口 ${localAllowed.size} + 预览桥接 ${bridgeAllowed.size}）`)
