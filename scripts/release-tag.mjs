#!/usr/bin/env node
/**
 * One-shot release tagging: sync version → commit → tag vX.Y.Z → push to GitHub.
 * Pushing a `v*` tag triggers the Release workflow in .github/workflows/release.yml.
 *
 * Usage:
 *   node scripts/release-tag.mjs              # auto-bump patch (0.1.0 → 0.1.1)
 *   node scripts/release-tag.mjs 0.2.0        # explicit version (v prefix optional)
 *   node scripts/release-tag.mjs patch|minor|major
 *   node scripts/release-tag.mjs --tag-only   # tag current version without bumping
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function fail(msg) {
  console.error(`[release-tag] ${msg}`)
  process.exit(1)
}

/** Run a git command in the repo root; exits with the message on failure. */
function git(args, { allowFail = false } = {}) {
  const res = spawnSync('git', args, { cwd: root, stdio: 'pipe', encoding: 'utf8' })
  if (res.error) fail(`Failed to run git: ${res.error.message}`)
  if (res.status !== 0) {
    if (allowFail) return null
    fail(`git ${args.join(' ')} failed:\n${res.stderr.trim()}`)
  }
  return res.stdout.trim()
}

const currentVersion = JSON.parse(
  readFileSync(join(root, 'package.json'), 'utf8'),
).version

/**
 * Desktop toast after a successful push (best-effort — never fails the
 * release). Windows: NotifyIcon balloon via PowerShell; macOS: osascript;
 * Linux: notify-send.
 */
function notify(title, message) {
  try {
    if (process.platform === 'win32') {
      const ps = [
        'Add-Type -AssemblyName System.Windows.Forms',
        'Add-Type -AssemblyName System.Drawing',
        '$n = New-Object System.Windows.Forms.NotifyIcon',
        '$n.Icon = [System.Drawing.SystemIcons]::Information',
        '$n.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info',
        `$n.BalloonTipTitle = '${title.replace(/'/g, "''")}'`,
        `$n.BalloonTipText = '${message.replace(/'/g, "''")}'`,
        '$n.Visible = $true',
        '$n.ShowBalloonTip(5000)',
        'Start-Sleep -Seconds 6',
        '$n.Dispose()',
      ].join('; ')
      spawnSync(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps],
        { cwd: root, stdio: 'ignore', timeout: 15000 },
      )
    } else if (process.platform === 'darwin') {
      spawnSync(
        'osascript',
        [
          '-e',
          `display notification "${message.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"`,
        ],
        { stdio: 'ignore', timeout: 15000 },
      )
    } else {
      spawnSync('notify-send', [title, message], {
        stdio: 'ignore',
        timeout: 15000,
      })
    }
  } catch {
    // Ignore — a failed toast must never block the release.
  }
}

function bump(v, kind) {
  // Strip any pre-release/build suffix first: "0.1.0-rc.1" would otherwise
  // produce NaN in the patch position.
  const core = v.replace(/[.-].*$/, '')
  const [maj, min, pat] = core.split('.').map(Number)
  if (kind === 'major') return `${maj + 1}.0.0`
  if (kind === 'minor') return `${maj}.${min + 1}.0`
  return `${maj}.${min}.${pat + 1}`
}

const raw = (process.argv[2] || '').trim()
let version
let tagOnly = false

if (raw === '--tag-only') {
  tagOnly = true
  version = currentVersion
} else if (!raw) {
  version = bump(currentVersion, 'patch')
} else if (raw === 'patch' || raw === 'minor' || raw === 'major') {
  version = bump(currentVersion, raw)
} else {
  version = raw.replace(/^v/i, '')
}

if (!/^\d+\.\d+\.\d+([.-][\w.-]+)?$/.test(version)) {
  fail(`Invalid version: ${raw}`)
}

const tag = `v${version}`

// Guard: working tree must be clean unless we're only tagging.
const dirty = git(['status', '--porcelain'])
if (dirty && !tagOnly) {
  fail('Working tree has uncommitted changes. Commit or stash them first.')
}

// Guard: refuse to overwrite an existing local tag.
const existing = git(['tag', '--list', tag])
if (existing === tag) {
  fail(`Tag ${tag} already exists. Delete it first or pick another version.`)
}

if (!tagOnly && version !== currentVersion) {
  console.log(`[release-tag] Syncing version ${currentVersion} → ${version}`)
  const sync = spawnSync(process.execPath, [join(root, 'scripts/sync-version.mjs'), version], {
    cwd: root,
    stdio: 'inherit',
  })
  if (sync.status !== 0) fail('Version sync failed')

  // 同步脚本同时更新了 Cargo.lock 根 crate 版本，一并提交
  git(['add', 'package.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock'])
  git(['commit', '-m', `chore: release ${tag}`])
}

console.log(`[release-tag] Creating tag ${tag}`)
git(['tag', '-a', tag, '-m', `Release ${tag}`])

const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
console.log(`[release-tag] Pushing ${branch} and ${tag} to origin`)
if (!tagOnly) git(['push', 'origin', branch])
git(['push', 'origin', tag])

console.log(`[release-tag] Done — ${tag} pushed. GitHub Release workflow is running.`)
notify(
  'Harness Launcher 发布成功',
  `v${version} 已推送，GitHub Release 工作流正在构建…`,
)
