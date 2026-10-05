/**
 * Environment facts: where this plugin lives, and which ffmpeg answers a call.
 *
 * Discovery is the part of a capture tool that decides whether the machine works, so it is written
 * as one ordered list rather than a heap of `if`s, and every answer carries the **source** that
 * produced it. "ffmpeg works here" is otherwise a fact nobody can check, and a machine with two
 * builds silently reports whichever one happened to be reached first.
 *
 * The order is: an explicit configured path, then the environment override, then **the shared
 * plugin home** (`~/.dsh-plugins/ffmpeg/bin`, where the family installs one build), then this
 * plugin's own `vendor/ffmpeg/bin`, then a sibling plugin's vendored build, then PATH. The shared
 * home comes first because it is one place for every plugin and survives a checkout being moved; the
 * `vendor/` directories stay as candidates for a machine that installed a build before the shared
 * home existed. Any found build beats PATH because it is what makes a capture reproducible across
 * machines.
 *
 * Nothing here runs a process except {@link versionOf}, which is called deliberately and cached.
 *
 * @module dsh-screen-recorder/core/env
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { PLUGIN_ROOT, SHARED_FFMPEG_BIN, SHARED_FFMPEG_DIR, binaryName, sharedHomeState } from './home.mjs'

const run = promisify(execFile)

export { PLUGIN_ROOT, sharedHomeState, binaryName }

/** Environment variable that names an ffmpeg executable outright. */
export const FFMPEG_ENV = 'DSH_FFMPEG'

/** Environment variable that names an ffprobe executable outright. */
export const FFPROBE_ENV = 'DSH_FFPROBE'

/** This plugin's own legacy build directory, still honoured when the shared home is empty. */
export const VENDOR_DIR = join(PLUGIN_ROOT, 'vendor', 'ffmpeg')

/** Where the binaries of the legacy build live. */
export const VENDOR_BIN_DIR = join(VENDOR_DIR, 'bin')

/** Where the family installs, and the first directory discovery looks in after config. */
export const SHARED_BIN_DIR = SHARED_FFMPEG_BIN

/** Sibling checkouts whose vendored ffmpeg is acceptable, nearest first. */
export const SIBLING_PLUGINS = ['dsh-ffmpeg', 'video-factory', 'dsh-video-audio', 'dsh-ocr']

/** Raised when no usable ffmpeg or ffprobe can be located. */
export class FfmpegNotFound extends Error {
  /**
   * @param {string} message - what is missing and what to do about it.
   */
  constructor(message) {
    super(message)
    this.name = 'FfmpegNotFound'
  }
}

/** Cache of resolved binaries, so discovery runs once per process. */
const resolved = new Map()

/**
 * Resolve the working directory for one request.
 *
 * A caller-supplied directory wins, then the configured project root, then the process's own
 * directory. Relative output paths are resolved against the result, so this is what decides where a
 * recording lands.
 *
 * @param {object} config - normalized plugin config.
 * @param {string} [requested] - a caller-supplied directory.
 * @returns {string} an absolute working directory.
 */
export function resolveCwd(config, requested) {
  if (typeof requested === 'string' && requested.trim() !== '') return resolve(requested)
  if (typeof config?.projectRoot === 'string' && config.projectRoot.trim() !== '') return resolve(config.projectRoot)
  return process.cwd()
}

/**
 * Every checkout that could hold a vendored ffmpeg or a sibling plugin, this one first.
 *
 * `..` and `..\..` are both searched because a plugin can be reached two ways: as a sibling
 * checkout of the others, or as a package inside a profile's `node_modules`, where the siblings
 * are linked one level up.
 *
 * @returns {string[]} absolute plugin roots.
 */
export function siblingRoots() {
  const roots = [resolve(PLUGIN_ROOT, '..'), resolve(PLUGIN_ROOT, '..', '..')]
  return [...new Set(roots)]
}

/**
 * The binaries this plugin could run, in preference order.
 *
 * @param {'ffmpeg'|'ffprobe'|'ffplay'} stem - which binary.
 * @param {object} [config] - normalized plugin config.
 * @returns {{path: string, source: 'config'|'env'|'home'|'vendor'|'sibling'|'path', label: string}[]} candidates that exist, best first.
 */
export function binaryCandidates(stem, config = {}) {
  const name = binaryName(stem)
  const found = []
  const push = (path, source, label) => {
    if (typeof path !== 'string' || path.trim() === '') return
    const absolute = resolve(path)
    if (found.some((entry) => entry.path.toLowerCase() === absolute.toLowerCase())) return
    if (!existsSync(absolute)) return
    found.push({ path: absolute, source, label })
  }

  const configured = stem === 'ffmpeg' ? config.ffmpegPath : config.ffprobePath
  push(configured ?? '', 'config', '配置里指定的路径')

  const fromEnv = process.env[stem === 'ffmpeg' ? FFMPEG_ENV : FFPROBE_ENV]
  push(fromEnv ?? '', 'env', `环境变量 ${stem === 'ffmpeg' ? FFMPEG_ENV : FFPROBE_ENV}`)

  push(join(SHARED_BIN_DIR, name), 'home', `共享目录 ${SHARED_FFMPEG_DIR}`)

  push(join(VENDOR_BIN_DIR, name), 'vendor', '本插件 vendor/ffmpeg/bin')

  for (const root of siblingRoots()) {
    for (const sibling of SIBLING_PLUGINS) {
      push(join(root, sibling, 'vendor', 'ffmpeg', 'bin', name), 'sibling', `${sibling}/vendor/ffmpeg/bin`)
    }
  }

  // PATH is walked by hand: `where`/`which` would be one more process to fail, and a missing
  // binary must stay a cheap answer rather than an exception in the middle of discovery.
  const separator = process.platform === 'win32' ? ';' : ':'
  for (const entry of (process.env.PATH ?? '').split(separator)) {
    const directory = entry.trim().replace(/^"|"$/g, '')
    if (directory === '') continue
    push(join(directory, name), 'path', 'PATH')
    if (found.some((candidate) => candidate.source === 'path')) break
  }

  return found
}

/**
 * Resolve one binary, or explain what is missing.
 *
 * @param {'ffmpeg'|'ffprobe'|'ffplay'} stem - which binary.
 * @param {object} [config] - normalized plugin config.
 * @returns {{path: string, source: string, label: string}|null} the winner, or null.
 */
export function resolveTool(stem, config = {}) {
  const key = `${stem}:${config.ffmpegPath ?? ''}:${config.ffprobePath ?? ''}`
  const cached = resolved.get(key)
  if (cached !== undefined) return cached

  const [winner] = binaryCandidates(stem, config)
  const answer = winner === undefined ? null : winner
  resolved.set(key, answer)
  return answer
}

/**
 * Resolve one binary or throw with an actionable message.
 *
 * @param {'ffmpeg'|'ffprobe'|'ffplay'} stem - which binary.
 * @param {object} [config] - normalized plugin config.
 * @returns {{path: string, source: string, label: string}} the winner.
 * @throws {FfmpegNotFound} when nothing on this machine can answer.
 */
export function requireTool(stem, config = {}) {
  const found = resolveTool(stem, config)
  if (found !== null) return found
  throw new FfmpegNotFound(
    `找不到 ${binaryName(stem)}，本插件无法执行这一步。\n` +
      `按顺序找过：配置里的 ${stem === 'ffmpeg' ? 'ffmpegPath' : 'ffprobePath'} → ${stem === 'ffmpeg' ? FFMPEG_ENV : FFPROBE_ENV} 环境变量 → ` +
      `共享目录 ${SHARED_BIN_DIR} → 本插件 ${VENDOR_BIN_DIR} → 同级插件的 vendor/ffmpeg/bin → PATH。\n` +
      `最省事的修法：screen_setup {action:"install_ffmpeg"}，把一份固定的构建装进共享目录 ${SHARED_FFMPEG_DIR}（全家共用一份）。`,
  )
}

/** Forget cached binary paths. Only useful after installing, and in tests. @returns {void} */
export function resetToolCache() {
  resolved.clear()
}

/**
 * Ask a binary for its version line, once.
 *
 * @param {string} binary - absolute path to an executable.
 * @returns {Promise<string|null>} the first non-empty line of `-version`, or null on failure.
 */
export async function versionOf(binary) {
  try {
    const { stdout, stderr } = await run(binary, ['-version'], { timeout: 20_000, windowsHide: true, maxBuffer: 4 << 20 })
    const line = `${stdout}${stderr}`.split('\n').find((entry) => entry.trim() !== '')
    return line === undefined ? null : line.trim()
  } catch {
    return null
  }
}

/**
 * Which directory this plugin's build is read from and installed into.
 *
 * The shared home when it holds a build, otherwise the legacy `vendor/ffmpeg` when that one does,
 * otherwise the shared home — the place an install is about to create.
 *
 * @returns {{directory: string, binDir: string, source: 'home'|'vendor'}} the resolved install location.
 */
export function installLocation() {
  if (existsSync(join(SHARED_BIN_DIR, binaryName('ffmpeg'))) || existsSync(join(SHARED_BIN_DIR, binaryName('ffprobe')))) {
    return { directory: SHARED_FFMPEG_DIR, binDir: SHARED_BIN_DIR, source: 'home' }
  }
  if (existsSync(join(VENDOR_BIN_DIR, binaryName('ffmpeg'))) || existsSync(join(VENDOR_BIN_DIR, binaryName('ffprobe')))) {
    return { directory: VENDOR_DIR, binDir: VENDOR_BIN_DIR, source: 'vendor' }
  }
  return { directory: SHARED_FFMPEG_DIR, binDir: SHARED_BIN_DIR, source: 'home' }
}

/**
 * What the installed build currently looks like, without running anything.
 *
 * @returns {{present: boolean, directory: string, binDir: string, location: 'home'|'vendor', files: {name: string, bytes: number}[], sizeBytes: number, source: object|null, shared: object}} the state.
 */
export function vendoredState() {
  const location = installLocation()
  const shared = sharedHomeState()
  const manifestPath = join(location.directory, 'SOURCE.json')
  let source = null
  if (existsSync(manifestPath)) {
    try {
      source = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch {
      // A record that cannot be parsed is reported as absent rather than taking the status call
      // down with it: the binaries are the fact that matters.
      source = null
    }
  }

  const base = { directory: location.directory, binDir: location.binDir, location: location.source, source, shared }
  if (!existsSync(location.binDir)) return { present: false, ...base, files: [], sizeBytes: 0 }

  const files = []
  let sizeBytes = 0
  for (const name of readdirSync(location.binDir)) {
    try {
      const stats = statSync(join(location.binDir, name))
      files.push({ name, bytes: stats.size })
      sizeBytes += stats.size
    } catch {
      // A file that vanished mid-listing simply does not count.
    }
  }
  return { present: files.length > 0, ...base, files, sizeBytes }
}

/**
 * Create a directory, and say nothing when it already exists.
 * @param {string} directory - absolute directory path.
 * @returns {string} the same path, for chaining.
 */
export function ensureDir(directory) {
  mkdirSync(directory, { recursive: true })
  return directory
}

/**
 * Turn a path into one Windows will accept past the 260-character limit.
 *
 * ffmpeg on Windows fails on long paths with an error that names a truncated file rather than the
 * length problem, so every path this plugin hands to ffmpeg goes through here. UNC paths and paths
 * that already carry the prefix are left alone.
 *
 * @param {string} path - an absolute or relative path.
 * @returns {string} a path ffmpeg can open.
 */
export function longPath(path) {
  if (process.platform !== 'win32') return path
  const absolute = resolve(path)
  if (absolute.startsWith('\\\\?\\')) return absolute
  if (absolute.startsWith('\\\\')) return `\\\\?\\UNC\\${absolute.slice(2)}`
  return absolute.length >= 240 ? `\\\\?\\${absolute}` : absolute
}
