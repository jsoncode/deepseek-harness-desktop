#!/usr/bin/env node
/**
 * 发布产物重命名：把 tauri 的产物名换成**统一的发布名**，并在其中插入平台标记，
 * 让同一 Release 下的资产一眼可辨。
 *
 *   DeepSeek Harness Desktop_1.0.2_x64-setup.exe   →  dhd_1.0.2_windows_x64-setup.exe
 *   DeepSeek Harness Desktop_1.0.2_aarch64.dmg     →  dhd_1.0.2_macos_arm64.dmg
 *   DeepSeek Harness Desktop_1.0.2_arm64.pkg       →  dhd_1.0.2_macos_arm64.pkg
 *   DeepSeek Harness Desktop_1.0.2_amd64.deb       →  dhd_1.0.2_linux_glibc2.35_amd64.deb
 *   DeepSeek Harness Desktop-1.0.2-1.x86_64.rpm    →  dhd_1.0.2_linux_glibc2.35_x86_64.rpm
 *   DeepSeek Harness Desktop_1.0.2_amd64.AppImage  →  dhd_1.0.2_linux_glibc2.35_x86_64.AppImage
 *
 * 统一目标格式：`{name}_{version}_{platform}[_{compat}]_{arch}{-setup}.{ext}`
 *   - name 默认 `dhd`（见 --name）：发布名要短、且**不含空格**——带空格时 GitHub 会把
 *     空格替换成 `.`，于是下载页的名字和本地产物名对不上，命令行里还得到处加引号；
 *   - platform ∈ windows | macos | linux；
 *   - compat 可选（见 --compat）：Linux 用它标明**兼容下限**，即这批产物构建在哪个 ABI
 *     基线上。构建机是 ubuntu-22.04 → glibc 2.35，产物可在 glibc ≥ 2.35 的发行版上运行。
 *     没有这个 token 时用户只看到「linux_amd64」，无从判断自己的系统够不够，于是
 *     RHEL 9（glibc 2.34）、openSUSE Leap 15（2.31）这类低于基线的系统要下载后才发现
 *     跑不起来；
 *   - arch 归一化：macOS 的 aarch64/x86_64 → arm64/x64（与 .pkg 对齐），Windows 保持
 *     Tauri 的 x64/arm64；Linux 见 normalizeArch —— deb 用 Debian 的 `amd64`（dpkg 认
 *     这个名字），rpm / AppImage 用通用的 `x86_64`；
 *   - rpm 原有的 `-{release}.` 段（如 `-1.`）被丢弃，只保留 arch。
 *
 * 注意：**只改产物文件名**，不动 tauri.conf.json 的 productName —— 安装后的应用名、
 * .app、窗口标题、卸载项仍然叫 DeepSeek Harness Desktop。
 *
 * 为什么不用 Tauri 的产物名：tauri-bundler 把名字写死在打包器里，没有模板配置项，
 * 所以只能在 build 之后、上传之前改名。
 *
 * Usage（在 CI 里由 release.yml 调用，也可本地用 --dry-run 预演）：
 *   node scripts/tag-release-assets.mjs --platform linux --version 1.0.2 --compat glibc2.35 \
 *     [--name dhd] [--github-output files] [--dry-run] <dir|file>...
 *
 * 输出：改名后的路径按行打印到 stdout（供 CI 日志查看）；给了 --github-output NAME
 * 时额外把同一份列表按 GitHub Actions 的多行 output 语法写进 $GITHUB_OUTPUT。
 *
 * 退出码：参数错误、找不到任何产物、或某条文件名不符合预期时为 1 —— 宁可让发版失败，
 * 也不能把没带平台标记的安装包静默发出去。
 */
import { appendFileSync, existsSync, readdirSync, renameSync, statSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'

/** 只认这些扩展名，避免误伤 bundle 目录里的其他文件（如 rpm 的中间产物目录）。 */
const BUNDLE_EXTS = new Set(['.exe', '.dmg', '.pkg', '.deb', '.rpm', '.appimage'])

const PLATFORMS = new Set(['windows', 'macos', 'linux'])

/** 默认发布名前缀：短、无空格、无歧义。 */
const DEFAULT_ASSET_NAME = 'dhd'

/**
 * 各平台的 arch 归一化表。
 * macOS 必须归一：dmg 来自 tauri（aarch64/x86_64），pkg 由 workflow 的 pkgbuild 生成
 * （matrix.arch 是 arm64/x64），不归一就会出现 `aarch64.dmg` 与 `arm64.pkg` 并存。
 * Linux 的单值归一在 normalizeArch 里按「包类型」再做一次（deb 要 amd64，rpm 要 x86_64），
 * 这里只把各种写法收敛成规范形。
 */
const ARCH_ALIASES = {
  windows: { x64: 'x64', x86_64: 'x64', arm64: 'arm64', aarch64: 'arm64', i686: 'x86', i386: 'x86' },
  macos: { aarch64: 'arm64', arm64: 'arm64', x86_64: 'x64', x64: 'x64' },
  linux: { amd64: 'amd64', x86_64: 'amd64', x64: 'amd64', arm64: 'arm64', aarch64: 'arm64' },
}

/**
 * Linux 按**包类型**选架构名（`rest` 是 arch 之后的后缀，如 `.deb` / `.rpm` / `.AppImage`）：
 *   - .deb 必须用 Debian 的架构名 `amd64`——dpkg 系工具按这个名字解析文件名；
 *   - .rpm 与 .AppImage 用通用的 `x86_64`（RPM 的既定词汇；AppImage 不属于任何发行版，
 *     用通用的 x86_64 比 Debian 专有的 amd64 更贴切）。
 * 归一表已把 x86_64 归到 amd64，所以这里只需把非 deb 的 amd64 换回 x86_64。
 */
function linuxArch(arch, rest) {
  if (rest.toLowerCase().endsWith('.deb')) return arch
  return arch === 'amd64' ? 'x86_64' : arch
}

function fail(msg) {
  console.error(`[tag-release-assets] ${msg}`)
  process.exit(1)
}

function usage() {
  console.error(
    [
      'Usage: node scripts/tag-release-assets.mjs --platform <windows|macos|linux> --version <x.y.z>',
      `         [--compat <token>] [--name <${DEFAULT_ASSET_NAME}>] [--github-output <name>] [--dry-run] <dir|file>...`,
    ].join('\n'),
  )
  process.exit(1)
}

function parseArgs(argv) {
  if (argv.length === 0) usage()
  const opts = {
    platform: '',
    version: '',
    compat: '',
    name: DEFAULT_ASSET_NAME,
    githubOutput: '',
    dryRun: false,
    targets: [],
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (
      arg === '--platform' ||
      arg === '--version' ||
      arg === '--compat' ||
      arg === '--name' ||
      arg === '--github-output'
    ) {
      const value = argv[i + 1]
      if (!value || value.startsWith('--')) fail(`${arg} needs a value`)
      i += 1
      if (arg === '--platform') opts.platform = value
      else if (arg === '--version') opts.version = value.replace(/^v/i, '')
      else if (arg === '--compat') opts.compat = value
      else if (arg === '--name') opts.name = value
      else opts.githubOutput = value
    } else if (arg === '--dry-run') {
      opts.dryRun = true
    } else if (arg.startsWith('--')) {
      fail(`unknown flag ${arg}`)
    } else {
      opts.targets.push(arg)
    }
  }
  if (!PLATFORMS.has(opts.platform)) {
    fail(`--platform must be one of ${[...PLATFORMS].join(' | ')} (got ${opts.platform || '<empty>'})`)
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(opts.name)) {
    // 发布名必须无空格（GitHub 会把空格换成 `.`），且不含路径分隔符
    fail(`--name must be a lowercase token without spaces (got ${opts.name || '<empty>'})`)
  }
  // 兼容下限 token：小写字母数字加点（如 glibc2.35），同样是文件名安全字符
  if (opts.compat && !/^[a-z0-9][a-z0-9._-]*$/.test(opts.compat)) {
    fail(`--compat must be a lowercase token without spaces (got ${opts.compat})`)
  }
  if (!/^\d+\.\d+\.\d+(?:[-.+][\w.-]+)?$/.test(opts.version)) {
    fail(`--version must look like 1.2.3 (got ${opts.version || '<empty>'})`)
  }
  if (opts.targets.length === 0) fail('at least one <dir|file> target is required')
  return opts
}

/** 展开 target：目录取其中扩展名匹配的文件（不递归），文件按原样收下。 */
function collectFiles(targets) {
  const files = []
  for (const target of targets) {
    const abs = resolve(target)
    if (!existsSync(abs)) fail(`target does not exist: ${target}`)
    const stat = statSync(abs)
    if (stat.isDirectory()) {
      const found = readdirSync(abs)
        .filter((name) => BUNDLE_EXTS.has(extname(name).toLowerCase()))
        .map((name) => join(abs, name))
        .filter((p) => statSync(p).isFile())
        .sort()
      if (found.length === 0) fail(`no bundle artifact found in ${target}`)
      files.push(...found)
    } else {
      files.push(abs)
    }
  }
  return files
}

/**
 * 拆解 Tauri 的产物名，返回 `{ product, arch, rest }`。
 * `version` 由调用方给定，因此不用猜版本号长什么样，只按它切分。
 * 支持的分隔风格：`_`（nsis/dmg/pkg/deb/AppImage）与 `-`（rpm）。
 */
function parseBundleName(name, version) {
  // lastIndexOf：万一产品名本身含版本串，也不会切错位置（真正的那次是最后一次）。
  const at = name.lastIndexOf(version)
  if (at <= 0) return null
  const sep = name[at - 1]
  if (sep !== '_' && sep !== '-') return null

  const product = name.slice(0, at - 1)
  const afterVersion = name.slice(at + version.length)
  // 版本后面必须紧跟分隔符，否则是 `1.0.2` 命中 `1.0.20` 这种前缀误匹配。
  if (!/^[-_]/.test(afterVersion)) return null
  let tail = afterVersion.replace(/^[-_]/, '')

  // rpm：`{product}-{version}-{release}.{arch}.rpm` —— 丢掉 release 段
  const rpmRelease = tail.match(/^\d+\.(.+)$/)
  if (rpmRelease) tail = rpmRelease[1]

  let arch
  let rest
  const nsis = tail.match(/^([^-]+)-setup\.exe$/i)
  if (nsis) {
    // nsis：`{product}_{version}_{arch}-setup.exe`
    arch = nsis[1]
    rest = '-setup.exe'
  } else {
    const dot = tail.indexOf('.')
    if (dot <= 0) return null
    arch = tail.slice(0, dot)
    rest = tail.slice(dot)
  }
  if (!product || !arch) return null
  return { product, arch, rest }
}

function normalizeArch(platform, arch) {
  return ARCH_ALIASES[platform][arch] ?? arch
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const files = collectFiles(opts.targets)
  const renamed = []

  for (const file of files) {
    const name = basename(file)
    // 幂等：重跑/重试时不要生成 `dhd_1.0.2_windows_windows_x64-setup.exe`。
    // 两个判据任一命中即视为已改过名：带平台标记，或已经是发布名开头。
    if (name.startsWith(`${opts.name}_`) || name.includes(`_${opts.platform}_`)) {
      console.error(`[tag-release-assets] skip (already renamed): ${name}`)
      renamed.push(file)
      continue
    }

    const parsed = parseBundleName(name, opts.version)
    if (!parsed) {
      fail(
        `cannot parse "${name}" — expected Tauri bundle naming with version ${opts.version} ` +
          '(e.g. "DeepSeek Harness Desktop_1.0.2_x64-setup.exe", "...-1.0.2-1.x86_64.rpm")',
      )
    }

    // 产品名换成发布名（默认 dhd）：短、无空格。原始 productName 只用于校验，
    // 不进产物名——装了应用的人看到的仍是 DeepSeek Harness Desktop。
    let arch = normalizeArch(opts.platform, parsed.arch)
    if (opts.platform === 'linux') arch = linuxArch(arch, parsed.rest)
    // 可选兼容下限 token（Linux 用）：插在平台与架构之间
    const compat = opts.compat ? `_${opts.compat}` : ''
    const target = `${opts.name}_${opts.version}_${opts.platform}${compat}_${arch}${parsed.rest}`
    const targetPath = join(dirname(file), target)

    if (target === name) {
      renamed.push(file)
      continue
    }
    if (!opts.dryRun) renameSync(file, targetPath)
    console.log(`${opts.dryRun ? '[dry-run] ' : ''}${name} → ${target}`)
    renamed.push(targetPath)
  }

  if (renamed.length === 0) fail('nothing renamed')

  const out = renamed.map((p) => (isAbsolute(p) ? p : resolve(p)))
  console.log('[tag-release-assets] assets:')
  for (const p of out) console.log(`  ${p}`)

  if (opts.githubOutput) {
    const target = process.env.GITHUB_OUTPUT
    if (!target) fail('--github-output given but $GITHUB_OUTPUT is not set')
    const delimiter = `__DSH_ASSETS_${process.pid}__`
    appendFileSync(target, `${opts.githubOutput}<<${delimiter}\n${out.join('\n')}\n${delimiter}\n`)
  }
}

main()
