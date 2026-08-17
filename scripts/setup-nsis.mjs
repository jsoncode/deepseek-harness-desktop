#!/usr/bin/env node
/**
 * Offline NSIS toolchain setup for Windows bundling.
 *
 * Tauri normally downloads nsis-3.11.zip and nsis_tauri_utils.dll from GitHub
 * before creating the NSIS installer. This script checks whether the local
 * tauri tools cache is already complete; if not, it deploys the files that
 * were manually placed in ./libs, so the build never touches the network.
 *
 * Expected layout (mirrors tauri-bundler internals):
 *   %LOCALAPPDATA%\tauri\
 *     └── NSIS\                                  ← extracted nsis-3.11.zip
 *           └── Plugins\x86-unicode\additional\nsis_tauri_utils.dll
 *
 * Usage: node scripts/setup-nsis.mjs
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// Must match tauri-bundler (crates/tauri-bundler/src/bundle/windows/nsis/mod.rs)
const NSIS_ZIP = 'nsis-3.11.zip'
const NSIS_ZIP_SHA1 = 'ef7ff767e5cbd9edd22add3a32c9b8f4500bb10d'
const NSIS_ZIP_TOP_DIR = 'nsis-3.11'
const NSIS_UTILS_DLL = 'nsis_tauri_utils.dll'
const NSIS_UTILS_SHA1 = '75197fee3c6a814fe035788d1c34ead39349b860'

// Files tauri requires inside NSIS\ (missing any → tauri recreates the dir)
const REQUIRED_FILES = [
  'makensis.exe',
  'Bin/makensis.exe',
  'Stubs/lzma-x86-unicode',
  'Stubs/lzma_solid-x86-unicode',
  'Plugins/x86-unicode/additional/nsis_tauri_utils.dll',
  'Include/MUI2.nsh',
  'Include/FileFunc.nsh',
  'Include/x64.nsh',
  'Include/nsDialogs.nsh',
  'Include/WinMessages.nsh',
  'Include/Win/COM.nsh',
  'Include/Win/Propkey.nsh',
  'Include/Win/RestartManager.nsh',
]

function fail(msg) {
  console.error(`[setup-nsis] ${msg}`)
  process.exit(1)
}

function sha1(file) {
  return createHash('sha1').update(readFileSync(file)).digest('hex')
}

if (process.platform !== 'win32') {
  console.log('[setup-nsis] Not Windows — skipping NSIS setup.')
  process.exit(0)
}

const toolsPath = join(process.env.LOCALAPPDATA ?? '', 'tauri')
const nsisPath = join(toolsPath, 'NSIS')
const dllTarget = join(nsisPath, 'Plugins', 'x86-unicode', 'additional', NSIS_UTILS_DLL)
const libZip = join(root, 'libs', NSIS_ZIP)
const libDll = join(root, 'libs', NSIS_UTILS_DLL)

// 1. Cache already complete? → nothing to do.
if (existsSync(nsisPath)) {
  const missing = REQUIRED_FILES.filter((p) => !existsSync(join(nsisPath, p)))
  if (missing.length === 0 && sha1(dllTarget) === NSIS_UTILS_SHA1) {
    console.log(`[setup-nsis] NSIS cache complete at ${nsisPath} — no download needed.`)
    process.exit(0)
  }
  console.warn(
    `[setup-nsis] NSIS cache incomplete (missing: ${missing.join(', ') || 'hash mismatch'}), redeploying…`,
  )
  rmSync(nsisPath, { recursive: true, force: true })
}

// 2. Deploy from ./libs.
const hasZip = existsSync(libZip)
const hasDll = existsSync(libDll)
if (!hasZip || !hasDll) {
  fail(
    `Missing local files: ${[!hasZip && `libs/${NSIS_ZIP}`, !hasDll && `libs/${NSIS_UTILS_DLL}`]
      .filter(Boolean)
      .join(', ')}. ` +
      'Download them from https://github.com/tauri-apps/binary-releases/releases and ' +
      'https://github.com/tauri-apps/nsis-tauri-utils/releases, otherwise tauri will try the network.',
  )
}

const zipHash = sha1(libZip)
if (zipHash !== NSIS_ZIP_SHA1) {
  // Hard-fail: deploying a mismatched NSIS silently breaks "never touch the
  // network" and produces unreproducible installers.
  fail(
    `libs/${NSIS_ZIP} SHA1 mismatch (${zipHash} ≠ ${NSIS_ZIP_SHA1}). ` +
      'Re-download from https://github.com/tauri-apps/binary-releases/releases.',
  )
}
const dllHash = sha1(libDll)
if (dllHash !== NSIS_UTILS_SHA1) {
  fail(
    `libs/${NSIS_UTILS_DLL} SHA1 mismatch (${dllHash} ≠ ${NSIS_UTILS_SHA1}). ` +
      'Re-download from https://github.com/tauri-apps/nsis-tauri-utils/releases, ' +
      'otherwise tauri silently redownloads it at build time (breaking offline).',
  )
}

mkdirSync(toolsPath, { recursive: true })
console.log(`[setup-nsis] Extracting libs/${NSIS_ZIP} → ${toolsPath}`)
// Windows 10+ ships bsdtar, which handles zip extraction.
const unzip = spawnSync('tar', ['-xf', libZip, '-C', toolsPath], { stdio: 'inherit' })
if (unzip.status !== 0) fail(`Failed to extract ${NSIS_ZIP}`)

const extracted = join(toolsPath, NSIS_ZIP_TOP_DIR)
if (!existsSync(extracted)) fail(`Expected ${extracted} after extraction — zip layout changed?`)
renameSync(extracted, nsisPath)

mkdirSync(dirname(dllTarget), { recursive: true })
copyFileSync(libDll, dllTarget)

console.log('[setup-nsis] Done — tauri build will use the local NSIS, no download needed.')
