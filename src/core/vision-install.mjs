/**
 * Provisioning the object detector, and saying honestly what could not be provisioned.
 *
 * Two things are needed to run YOLO, and they are owned differently:
 *
 * 1. **The model** — 12.8 MB, pinned here by SHA-256 and installed into
 *    `~/.dsh-plugins/models/yolo`. The digest is enforced: a download that does not match is
 *    deleted, and a file that is already there is verified rather than trusted. The licence is
 *    recorded beside it, because the weights are AGPL-3.0 even though this plugin is MIT, and a
 *    reader deserves to see that in the same breath as the provenance.
 * 2. **The runtime** — the ONNX WASM backend, 13 MB, owned by `dsh-video-audio` and shared by every
 *    model in the family. This installer will not fetch a second copy. It will, when it can, take a
 *    complete copy out of a sibling checkout's `vendor/audio` tree, because that is the same 13 MB;
 *    when it cannot, it says which plugin to install it from instead of leaving a user staring at
 *    "detection unavailable".
 *
 * @module dsh-screen-recorder/core/vision-install
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { siblingRoots } from './env.mjs'
import { SHARED_RUNTIME_DIR, SHARED_YOLO_DIR } from './home.mjs'
import { InstallError, downloadToFile } from './download.mjs'
import { sha256File } from './net.mjs'
import { DETECTOR_MODEL, detectorState, disposeDetector, resolveDetectorModel, resolveRuntime, runtimeInstallHint } from './vision.mjs'

/** The runtime packages a complete shared install must contain. */
export const RUNTIME_PACKAGES = ['onnxruntime-web', 'flatbuffers', 'long', 'protobufjs', 'guid-typescript']

/**
 * What is on disk right now, including a digest check of the model.
 *
 * @param {object} [config] - normalized plugin config.
 * @returns {Promise<{state: object, verified: boolean|null, actualSha256: string|null, actualBytes: number|null}>} the state.
 */
export async function detectorInstallState(config = {}) {
  const state = detectorState(config)
  if (!state.modelPath || !existsSync(state.modelPath)) {
    return { state, verified: null, actualSha256: null, actualBytes: null }
  }
  const actualBytes = statSync(state.modelPath).size
  const actualSha256 = await sha256File(state.modelPath)
  // A model the operator pointed at themselves is reported, not judged: only the pinned file has a
  // digest this plugin can hold it to.
  const verified = state.modelSource === 'config' ? null : actualSha256 === DETECTOR_MODEL.sha256
  return { state, verified, actualSha256, actualBytes }
}

/**
 * A sibling checkout whose `vendor/audio` holds a complete runtime, if there is one.
 *
 * @returns {{dir: string, packages: string[]}|null} the candidate and which packages it has.
 */
export function runtimeAdoptionCandidate() {
  for (const candidate of runtimeCandidatesWithSource()) {
    if (candidate.source === 'home') continue
    const nodeModules = join(candidate.dir, 'runtime', 'node_modules')
    if (!existsSync(nodeModules)) continue
    const packages = RUNTIME_PACKAGES.filter((name) => existsSync(join(nodeModules, name)))
    if (packages.length === RUNTIME_PACKAGES.length) return { dir: candidate.dir, packages }
  }
  return null
}

/**
 * Every runtime root, with where it came from. Kept local so the installer can walk the same list
 * the inference module resolves against.
 * @returns {{dir: string, source: string}[]} candidates, nearest first.
 */
function runtimeCandidatesWithSource() {
  const candidates = []
  const fromEnv = process.env.DSH_AUDIO_VENDOR
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') candidates.push({ dir: fromEnv.trim(), source: 'env' })
  candidates.push({ dir: SHARED_RUNTIME_DIR, source: 'home' })
  for (const root of siblingRoots()) {
    for (const name of ['dsh-video-audio', 'video-factory']) {
      candidates.push({ dir: join(root, name, 'vendor', 'audio'), source: 'sibling' })
    }
  }
  return candidates
}

/**
 * Copy a complete runtime tree into the shared home.
 *
 * A move would be worse than a copy here: the sibling that owns the tree may itself still be using
 * it, and this is 13 MB, not 200.
 *
 * @param {object} candidate - the result of {@link runtimeAdoptionCandidate}.
 * @param {(message: string) => void} [onProgress] - progress messages.
 * @returns {{adopted: boolean, from: string|null, packages: string[]}} what happened.
 */
export function adoptRuntime(candidate, onProgress = () => {}) {
  if (candidate === null) return { adopted: false, from: null, packages: [] }
  const target = join(SHARED_RUNTIME_DIR, 'node_modules')
  mkdirSync(target, { recursive: true })
  const copied = []
  for (const name of candidate.packages) {
    const source = join(candidate.dir, 'runtime', 'node_modules', name)
    const destination = join(target, name)
    try {
      cpSync(source, destination, { recursive: true, force: true })
      copied.push(name)
    } catch (error) {
      onProgress(`复制 ${name} 失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  onProgress(`从 ${candidate.dir} 复制了 ${copied.length} 个运行时包到 ${SHARED_RUNTIME_DIR}`)
  return { adopted: copied.length === candidate.packages.length, from: candidate.dir, packages: copied }
}

/**
 * Install the detector model, and get the runtime into place if it can be had.
 *
 * @param {object} [options] - the call.
 * @param {boolean} [options.force] - reinstall even when a verified copy exists.
 * @param {string} [options.archive] - a local `.onnx` to use instead of downloading. Its digest is still checked.
 * @param {object} [options.config] - normalized plugin config.
 * @param {(message: string) => void} [options.onProgress] - progress messages.
 * @returns {Promise<object>} what was installed, what was verified, and what is still missing.
 * @throws {InstallError} when a download or a digest check fails.
 */
export async function installDetector(options = {}) {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {}
  const config = options.config ?? {}
  const target = join(SHARED_YOLO_DIR, DETECTOR_MODEL.file)

  if (typeof options.archive === 'string' && options.archive !== '') {
    const source = join(options.archive)
    if (!existsSync(source)) throw new InstallError(`archive 指向的文件不存在：${source}`)
    onProgress(`使用本地文件 ${source}`)
    const digest = await sha256File(source)
    if (digest !== DETECTOR_MODEL.sha256) {
      throw new InstallError(
        `本地文件的 sha256 与锁定值不一致：\n  期望 ${DETECTOR_MODEL.sha256}\n  实际 ${digest}\n` +
          '要么换一份文件，要么先用 config.detector.modelPath 指向它（那样就不校验摘要）。',
      )
    }
    mkdirSync(SHARED_YOLO_DIR, { recursive: true })
    cpSync(source, target, { force: true })
    return finish({ installed: true, bytes: statSync(target).size, digest, onProgress, config })
  }

  const current = await detectorInstallState(config)
  if (options.force !== true && current.state.modelSource !== 'config' && current.verified === true && runtimeReady()) {
    onProgress(`检测模型已就位且摘要一致，跳过下载：${current.state.modelPath}`)
    return finish({ installed: false, skipped: true, bytes: current.actualBytes, digest: current.actualSha256, onProgress, config })
  }

  mkdirSync(SHARED_YOLO_DIR, { recursive: true })
  const scratch = join(SHARED_YOLO_DIR, '.download')
  mkdirSync(scratch, { recursive: true })
  const archive = join(scratch, `${DETECTOR_MODEL.name}.onnx`)

  onProgress(`下载 ${DETECTOR_MODEL.label}（约 ${(DETECTOR_MODEL.bytes / 1e6).toFixed(1)} MB）`)
  const downloaded = await downloadToFile({
    url: DETECTOR_MODEL.url,
    target: archive,
    timeoutMs: 30 * 60 * 1000,
    onProgress: (event) => {
      if (typeof event?.received === 'number' && typeof event?.total === 'number' && event.total > 0) {
        onProgress(`已下载 ${(event.received / 1e6).toFixed(1)}/${(event.total / 1e6).toFixed(1)} MB`)
      }
    },
  })
  if (downloaded.via === 'curl') {
    onProgress(`fetch 走不通（${downloaded.firstError ?? '网络错误'}），改用 curl${downloaded.proxy === null ? '' : ` + 代理 ${downloaded.proxy.server}（${downloaded.proxy.source}）`} 下载成功`)
  }

  const digest = await sha256File(archive)
  if (digest !== DETECTOR_MODEL.sha256) {
    rmSync(archive, { force: true })
    throw new InstallError(
      `下载到的模型 sha256 与锁定值不一致，已删除：\n  期望 ${DETECTOR_MODEL.sha256}\n  实际 ${digest}\n` +
        '上游重新发布过就换一个 pin，否则这一份不能信。',
    )
  }

  cpSync(archive, target, { force: true })
  rmSync(archive, { force: true })
  onProgress(`已写入 ${target}`)
  return finish({ installed: true, bytes: statSync(target).size, digest, onProgress, config })
}

/**
 * Whether the shared runtime holds every package the WASM backend loads.
 * @returns {boolean} true when it does.
 */
function runtimeReady() {
  const runtime = resolveRuntime()
  if (runtime.source === 'missing') return false
  return RUNTIME_PACKAGES.every((name) => existsSync(join(SHARED_RUNTIME_DIR, 'node_modules', name)))
}

/**
 * Write the manifest, drop the cached session, and report the resulting state.
 *
 * @param {object} request - the outcome so far.
 * @returns {object} the install report.
 */
function finish(request) {
  const { onProgress, config } = request
  const model = resolveDetectorModel(config)
  writeManifest({ bytes: request.bytes, digest: request.digest })

  let runtime = { adopted: false, from: null, packages: [] }
  if (!runtimeReady()) {
    const candidate = runtimeAdoptionCandidate()
    if (candidate !== null) {
      onProgress('共享目录里没有推理运行时；发现同级检出一份，直接复制过来（不再下载一遍 13 MB）')
      runtime = adoptRuntime(candidate, onProgress)
    }
  }

  disposeDetector()
  const state = detectorState(config)
  const notes = []
  notes.push(request.skipped === true ? '模型本来就在位，这次没有重新下载。' : `模型已写到 ${state.modelPath}`)
  if (state.available) notes.push('模型与推理运行时都就位，目标检测可用。')
  else if (state.missing.includes('runtime')) notes.push(runtimeInstallHint())
  else notes.push(state.reason ?? '目标检测仍不可用，原因见 reason。')

  return {
    installed: request.installed === true,
    skipped: request.skipped === true,
    modelPath: state.modelPath,
    bytes: request.bytes ?? null,
    sha256: request.digest ?? null,
    verified: request.digest === null || request.digest === DETECTOR_MODEL.sha256,
    license: DETECTOR_MODEL.license,
    provenance: DETECTOR_MODEL.provenance,
    runtime: { ...state.runtime, ...runtime, complete: runtimeReady() },
    available: state.available,
    missing: state.missing,
    notes,
  }
}

/**
 * Record what was installed, where it came from and under what licence.
 *
 * The manifest is written even when the model was already present: a machine that installed the
 * file by hand previously has no record, and the record is the point.
 *
 * @param {{bytes: number|null, digest: string|null}} what - the installed file's facts.
 * @returns {string} the manifest path.
 */
function writeManifest(what) {
  const manifest = {
    name: DETECTOR_MODEL.name,
    label: DETECTOR_MODEL.label,
    file: DETECTOR_MODEL.file,
    url: DETECTOR_MODEL.url,
    license: DETECTOR_MODEL.license,
    provenance: DETECTOR_MODEL.provenance,
    input: DETECTOR_MODEL.input,
    output: DETECTOR_MODEL.output,
    classes: DETECTOR_MODEL.classes,
    expectedBytes: DETECTOR_MODEL.bytes,
    expectedSha256: DETECTOR_MODEL.sha256,
    actualBytes: what.bytes,
    actualSha256: what.digest,
    installedAt: new Date().toISOString(),
    installedBy: 'dsh-screen-recorder screen_setup',
  }
  const path = join(SHARED_YOLO_DIR, 'SOURCE.json')
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return path
}

/**
 * Delete the installed detector model.
 *
 * Only this plugin's own directory goes: the shared ONNX runtime under `lib/onnxruntime-web`
 * belongs to `dsh-video-audio`, and removing it here would break matting and audio event detection.
 *
 * @returns {{removed: boolean, directory: string, note: string}} what happened.
 */
export function removeDetector() {
  const existed = existsSync(SHARED_YOLO_DIR)
  if (existed) rmSync(SHARED_YOLO_DIR, { recursive: true, force: true })
  disposeDetector()
  return {
    removed: existed,
    directory: SHARED_YOLO_DIR,
    note: existed
      ? `已删除 ${SHARED_YOLO_DIR}（共享运行时 ${SHARED_RUNTIME_DIR} 保留：抠像与音频事件检测还在用它）。`
      : '本来就没有安装。',
  }
}

/** How big the installed model directory is, for the status report. @returns {number} bytes. */
export function detectorBytes() {
  if (!existsSync(SHARED_YOLO_DIR)) return 0
  let total = 0
  for (const entry of readdirSync(SHARED_YOLO_DIR)) {
    try {
      total += statSync(join(SHARED_YOLO_DIR, entry)).size
    } catch {
      // A file that vanished mid-listing simply does not count.
    }
  }
  return total
}
