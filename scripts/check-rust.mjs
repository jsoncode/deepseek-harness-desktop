#!/usr/bin/env node
/**
 * 构建前置环境自检（Rust 工具链 / MSVC 链接器）。
 *
 * 背景：换设备后常见报错 `failed to run 'cargo metadata' ... program not found`，
 * 根因是这台机器没装 Rust 工具链。本脚本在 tauri build 之前先行检测，
 * 缺什么就直接给出可执行的中文指引，避免在 tauri 那层才暴露出晦涩报错。
 *
 * 退出码：0 = 通过；1 = 缺 Rust 工具链（阻止构建）；MSVC 缺失仅告警，不阻断。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const isWin = process.platform === 'win32'
const cargoBin = isWin ? 'cargo.exe' : 'cargo'
const rustcBin = isWin ? 'rustc.exe' : 'rustc'

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 30_000 })
  return { ok: r.status === 0 && !r.error, out: (r.stdout ?? '').trim() }
}

function fail(msg) {
  console.error('[check-rust] ' + msg)
  process.exit(1)
}

// ---- 1. 在 PATH 中找 cargo / rustc ----
const cargoOnPath = run('cargo', ['--version'])
const rustcOnPath = run('rustc', ['--version'])

// ---- 2. 常见安装位置兜底探测（不在 PATH 时的诊断） ----
const probes = []
const home = homedir()
const cargoHome = process.env.CARGO_HOME || join(home, '.cargo')
const rustupHome = process.env.RUSTUP_HOME || join(home, '.rustup')
probes.push(join(cargoHome, 'bin', cargoBin), join(cargoHome, 'bin', rustcBin))
const toolchains = join(rustupHome, 'toolchains')
if (existsSync(toolchains)) {
  for (const tc of readdirSync(toolchains)) {
    probes.push(join(toolchains, tc, 'bin', cargoBin), join(toolchains, tc, 'bin', rustcBin))
  }
}
const found = {}
for (const p of probes) {
  const key = p.endsWith(cargoBin) ? 'cargo' : 'rustc'
  if (!found[key] && existsSync(p)) found[key] = p
}

const cargoOk = cargoOnPath.ok || found.cargo
const rustcOk = rustcOnPath.ok || found.rustc

if (!cargoOk || !rustcOk) {
  console.error('')
  console.error('[check-rust] ✗ 未检测到可用的 Rust 工具链（cargo/rustc），无法执行 tauri build。')
  console.error('[check-rust]   这是换新设备/新环境后最常见的报错来源（cargo metadata: program not found）。')
  console.error('')
  if (cargoOnPath.out || rustcOnPath.out) console.error('[check-rust]   当前版本: ' + [cargoOnPath.out, rustcOnPath.out].filter(Boolean).join(' / '))
  if (found.cargo || found.rustc) {
    console.error('[check-rust]   已找到安装但不在 PATH 中:')
    if (found.cargo) console.error('[check-rust]     cargo: ' + found.cargo)
    if (found.rustc) console.error('[check-rust]     rustc: ' + found.rustc)
    console.error('[check-rust]   请把 ' + join(cargoHome, 'bin') + ' 加入系统 PATH（或重开终端后重试）。')
  } else {
    console.error('[check-rust]   修复（任选其一）:')
    if (isWin) {
      console.error('[check-rust]     1) winget install Rustlang.Rustup --silent --accept-package-agreements --accept-source-agreements')
      console.error('[check-rust]        然后重开终端执行: rustup default stable')
    }
    console.error('[check-rust]     2) 从 https://rustup.rs 下载 rustup-init 并运行（默认选项即可）')
    console.error('[check-rust]        安装完成后重开终端，验证: cargo --version && rustc --version')
  }
  console.error('')
  process.exit(1)
}

console.log('[check-rust] ✓ Rust 工具链: ' + (cargoOnPath.out || rustcOnPath.out))

// ---- 3. Windows 下软检查 MSVC 链接器（缺失仅告警） ----
if (isWin) {
  const vswhere = join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
  let hasMsvc = false
  if (existsSync(vswhere)) {
    const r = spawnSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'displayName'], { encoding: 'utf8' })
    hasMsvc = r.status === 0 && (r.stdout ?? '').trim().length > 0
  }
  if (!hasMsvc) {
    console.warn('[check-rust] ⚠ 未检测到 MSVC C++ 构建工具（link.exe）。Windows 上 Rust 默认使用 MSVC 链接器，')
    console.warn('[check-rust]   缺它会在编译末期报 linker 相关错误。请安装 Visual Studio Build Tools 并勾选')
    console.warn('[check-rust]   “使用 C++ 的桌面开发” 工作负载: https://visualstudio.microsoft.com/zh-hans/downloads/')
  } else {
    console.log('[check-rust] ✓ MSVC C++ 构建工具已就绪')
  }
}

console.log('[check-rust] 环境自检通过。')
