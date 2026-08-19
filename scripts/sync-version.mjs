#!/usr/bin/env node
/**
 * Sync app version across package.json, src-tauri/tauri.conf.json, Cargo.toml
 * AND the Cargo.lock root crate.
 * All files are validated before anything is written, so a failure can never
 * leave the repo in a half-updated state.
 *
 * Usage: node scripts/sync-version.mjs 0.1.0
 *        node scripts/sync-version.mjs v0.1.0
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const raw = (process.argv[2] || '').trim()
if (!raw) {
  console.error('Usage: node scripts/sync-version.mjs <version>')
  process.exit(1)
}

const version = raw.replace(/^v/i, '')
if (!/^\d+\.\d+\.\d+([.-][\w.-]+)?$/.test(version)) {
  console.error(`Invalid version: ${raw}`)
  process.exit(1)
}

const packagePath = join(root, 'package.json')
const tauriConfPath = join(root, 'src-tauri/tauri.conf.json')
const cargoPath = join(root, 'src-tauri/Cargo.toml')
const cargoLockPath = join(root, 'src-tauri/Cargo.lock')

/** Replace `version = "x"` inside the [package] section only. */
function replaceCargoPackageVersion(cargoText, version) {
  const lines = cargoText.split('\n')
  let inPackage = false
  let replaced = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*\[[^\]]+\]\s*$/.test(line)) {
      inPackage = line.trim() === '[package]'
      continue
    }
    if (inPackage && /^\s*version\s*=\s*"[^"]+"\s*$/.test(line)) {
      lines[i] = line.replace(/"[^"]+"/, `"${version}"`)
      replaced = true
      break
    }
  }
  if (!replaced) {
    throw new Error('Failed to find version in Cargo.toml [package] section')
  }
  return lines.join('\n')
}

/** Update the root crate version in Cargo.lock (keeps `--locked` builds working). */
function replaceCargoLockRootVersion(lockText, version) {
  const nameLine = /^\s*name\s*=\s*"deepseek-harness-desktop"\s*$/m
  const nameIdx = lockText.search(nameLine)
  if (nameIdx === -1) {
    throw new Error('Failed to find root crate in Cargo.lock')
  }
  const before = lockText.slice(0, nameIdx)
  const after = lockText.slice(nameIdx)
  const versionLine = /^(?<indent>\s*)version\s*=\s*"[^"]+"\s*$/m
  const vm = after.match(versionLine)
  if (!vm) {
    throw new Error('Failed to find version for root crate in Cargo.lock')
  }
  const indent = vm.groups?.indent ?? ''
  return before + after.replace(versionLine, `${indent}version = "${version}"`)
}

// ── Phase 1: read + validate everything in memory (nothing written yet) ──
const pkg = JSON.parse(readFileSync(packagePath, 'utf8'))
const tauriConf = JSON.parse(readFileSync(tauriConfPath, 'utf8'))
const cargoText = readFileSync(cargoPath, 'utf8')
const lockText = readFileSync(cargoLockPath, 'utf8')

const nextCargo = replaceCargoPackageVersion(cargoText, version)
const nextLock = replaceCargoLockRootVersion(lockText, version)
const nextPkg = `${JSON.stringify({ ...pkg, version }, null, 2)}\n`
const nextTauri = `${JSON.stringify({ ...tauriConf, version }, null, 2)}\n`

// ── Phase 2: write all four files ──
writeFileSync(packagePath, nextPkg, 'utf8')
writeFileSync(tauriConfPath, nextTauri, 'utf8')
writeFileSync(cargoPath, nextCargo, 'utf8')
writeFileSync(cargoLockPath, nextLock, 'utf8')

console.log(`Synced version → ${version} (package.json, tauri.conf.json, Cargo.toml, Cargo.lock)`)
