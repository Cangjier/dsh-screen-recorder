/**
 * Object detection with YOLO, on the ONNX WASM runtime the family already shares.
 *
 * Three separate jobs live here, and it is worth keeping them apart:
 *
 * 1. **Finding the pieces** — the model and the runtime are two independently installable things,
 *    and either can be missing. Discovery reports which one is missing and where it looked, because
 *    "detection does not work" with no reason is the least useful sentence a tool can return.
 * 2. **Running the network** — one session, loaded once, on the shared `onnxruntime-web` WASM
 *    backend. The image never goes near an image decoder: ffmpeg hands over raw RGB, the letterbox
 *    arithmetic here produces the tensor, and the same arithmetic maps the boxes back.
 * 3. **Decoding the answer** — YOLO exports come in two tensor layouts (v8's `[1, 4+nc, N]` and
 *    v5's `[1, N, 5+nc]`) and two dtypes (`float32`, and the `float16` exports that are half the
 *    size). Both are accepted and both are decoded to the same shape, because the export an operator
 *    happens to have should not decide whether this works.
 *
 * The decoded boxes are always in **source-frame pixels**: the read size, the letterbox padding and
 * the model's own input side are folded back in here, so no caller ever has to know any of them.
 *
 * @module dsh-screen-recorder/core/vision
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PLUGIN_ROOT, SHARED_RUNTIME_DIR, SHARED_YOLO_DIR, SHARED_MODELS_DIR, sharedPath } from './home.mjs'
import { readPixels } from './image.mjs'

/** Environment variable that names a shared `vendor/audio` directory outright. */
export const AUDIO_DIR_ENV = 'DSH_AUDIO_VENDOR'

/** This plugin's own `vendor/audio`, the oldest runtime layout. */
export const AUDIO_VENDOR_DIR = join(PLUGIN_ROOT, 'vendor', 'audio')

/**
 * The detector this plugin installs, with everything needed to check it after the fact.
 *
 * The digest is the reason this is a table and not a URL in an installer: it is checked on every
 * install, and a machine that already has the file is verified against it rather than trusted.
 */
export const DETECTOR_MODEL = Object.freeze({
  name: 'yolov8n',
  file: 'yolov8n.onnx',
  label: 'YOLOv8n（COCO 80 类目标检测，ONNX）',
  url: 'https://huggingface.co/mobilint/YOLOv8n/resolve/main/yolov8n.onnx',
  bytes: 12_816_851,
  sha256: '7c535d68ea6e1ab58525e8e9d5b880a6424b3bb0f47276639aa037e394b70e72',
  license: 'AGPL-3.0（模型上游为 Ultralytics YOLOv8，AGPL-3.0）',
  provenance: [
    'Ultralytics YOLOv8n — 在 COCO 上训练的 80 类检测器，上游许可是 AGPL-3.0',
    'mobilint/YOLOv8n — ONNX 导出，权重仅由本插件按需下载，不随插件分发',
    '本插件自身是 MIT；模型许可是模型自己的事，SOURCE.json 里记着来源与摘要',
  ],
  input: 'float32 [1,3,640,640]，RGB 分通道，归一化到 0..1',
  output: 'float32 [1,84,8400]：4 个框参数（cx,cy,w,h）+ 80 类分数，无 objectness',
  classes: 80,
  confidenceFloor: 0.25,
})

/** The 80 COCO class names, in the order the model emits them. */
export const COCO_CLASSES = Object.freeze([
  'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat', 'traffic light',
  'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat', 'dog', 'horse', 'sheep', 'cow',
  'elephant', 'bear', 'zebra', 'giraffe', 'backpack', 'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee',
  'skis', 'snowboard', 'sports ball', 'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket', 'bottle',
  'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple', 'sandwich', 'orange',
  'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair', 'couch', 'potted plant', 'bed',
  'dining table', 'toilet', 'tv', 'laptop', 'mouse', 'remote', 'keyboard', 'cell phone', 'microwave', 'oven',
  'toaster', 'sink', 'refrigerator', 'book', 'clock', 'vase', 'scissors', 'teddy bear', 'hair drier', 'toothbrush',
])

/**
 * Where the ONNX WASM runtime can be, in preference order.
 *
 * The runtime is owned by `dsh-video-audio` now, and borrowed by every model in the family; the
 * older `vendor/audio` layouts stay readable so a machine that installed one keeps working.
 *
 * @returns {{dir: string, source: 'env'|'home'|'sibling'|'vendor'}[]} candidates, nearest first.
 */
export function runtimeCandidates() {
  const candidates = []
  const fromEnv = process.env[AUDIO_DIR_ENV]
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') candidates.push({ dir: resolve(fromEnv.trim()), source: 'env' })
  candidates.push({ dir: SHARED_RUNTIME_DIR, source: 'home' })
  for (const root of [resolve(PLUGIN_ROOT, '..'), resolve(PLUGIN_ROOT, '..', '..')]) {
    candidates.push({ dir: join(root, 'dsh-video-audio', 'vendor', 'audio'), source: 'sibling' })
    candidates.push({ dir: join(root, 'video-factory', 'vendor', 'audio'), source: 'sibling' })
  }
  candidates.push({ dir: AUDIO_VENDOR_DIR, source: 'vendor' })
  return candidates
}

/**
 * The directory holding `onnxruntime-web`, given one runtime root.
 *
 * Two layouts are in the wild: the shared home keeps npm's own shape under
 * `lib/onnxruntime-web/node_modules/onnxruntime-web`, while a `vendor/audio` tree keeps the same
 * shape under `runtime/`.
 *
 * @param {string} root - a runtime root.
 * @returns {string} the package directory, whether or not it exists.
 */
function packageDirIn(root) {
  return resolve(root) === resolve(SHARED_RUNTIME_DIR)
    ? join(SHARED_RUNTIME_DIR, 'node_modules', 'onnxruntime-web')
    : join(root, 'runtime', 'node_modules', 'onnxruntime-web')
}

/**
 * Resolve the three files the WASM backend loads.
 *
 * @returns {{dir: string, source: 'env'|'home'|'sibling'|'vendor'|'missing', packageDir: string, entry: string, binary: string, loader: string}} the resolved paths; the tails are filled in even when nothing exists, so an error can name the path that was expected.
 */
export function resolveRuntime() {
  for (const candidate of runtimeCandidates()) {
    const packageDir = packageDirIn(candidate.dir)
    const entry = join(packageDir, 'dist', 'ort.wasm.mjs')
    const binary = join(packageDir, 'dist', 'ort-wasm-simd-threaded.wasm')
    const loader = join(packageDir, 'dist', 'ort-wasm-simd-threaded.mjs')
    if (existsSync(entry) && existsSync(binary)) {
      return { dir: candidate.dir, source: candidate.source, packageDir, entry, binary, loader }
    }
  }
  const packageDir = packageDirIn(SHARED_RUNTIME_DIR)
  return {
    dir: SHARED_RUNTIME_DIR,
    source: 'missing',
    packageDir,
    entry: join(packageDir, 'dist', 'ort.wasm.mjs'),
    binary: join(packageDir, 'dist', 'ort-wasm-simd-threaded.wasm'),
    loader: join(packageDir, 'dist', 'ort-wasm-simd-threaded.mjs'),
  }
}

/**
 * The sentence to give a caller when the runtime is missing.
 * @returns {string} a Chinese, actionable sentence.
 */
export function runtimeInstallHint() {
  return (
    '推理运行时（onnxruntime-web WASM）尚未安装：它由独立插件 dsh-video-audio 提供，' +
    '在该插件里运行 audio_setup {action:"install"} 即可装进共享目录 ' +
    `${SHARED_RUNTIME_DIR}（抠像、音频事件检测与目标检测共用这一份）。`
  )
}

/**
 * Where the detector model is, and whether it is really there.
 *
 * @param {object} [config] - normalized plugin config.
 * @returns {{path: string, source: 'config'|'home'|'vendor'|'sibling', exists: boolean, bytes: number|null}} the resolution.
 */
export function resolveDetectorModel(config = {}) {
  const configured = config?.detector?.modelPath
  if (typeof configured === 'string' && configured.trim() !== '') {
    const path = resolve(configured.trim())
    return { path, source: 'config', exists: existsSync(path), bytes: sizeOf(path) }
  }
  const candidates = [
    { path: join(SHARED_YOLO_DIR, DETECTOR_MODEL.file), source: 'home' },
    { path: join(PLUGIN_ROOT, 'vendor', 'models', DETECTOR_MODEL.file), source: 'vendor' },
  ]
  for (const root of [resolve(PLUGIN_ROOT, '..'), resolve(PLUGIN_ROOT, '..', '..')]) {
    candidates.push({ path: join(root, 'dsh-screen-recorder', 'vendor', 'models', DETECTOR_MODEL.file), source: 'sibling' })
  }
  for (const candidate of candidates) {
    if (existsSync(candidate.path)) return { ...candidate, exists: true, bytes: sizeOf(candidate.path) }
  }
  return { ...candidates[0], exists: false, bytes: null }
}

/**
 * The size of a file, or null.
 * @param {string} path - the file.
 * @returns {number|null} bytes.
 */
function sizeOf(path) {
  try {
    return statSync(path).size
  } catch {
    return null
  }
}

/**
 * Whether detection can run right now, and what is missing when it cannot.
 *
 * @param {object} [config] - normalized plugin config.
 * @returns {{available: boolean, modelPath: string, modelSource: string, modelBytes: number|null, runtime: object, missing: string[], reason: string|null, installHint: string|null, classes: number}} the state.
 */
export function detectorState(config = {}) {
  const runtime = resolveRuntime()
  const model = resolveDetectorModel(config)
  const missing = []
  if (!model.exists) missing.push('model')
  if (runtime.source === 'missing') missing.push('runtime')
  const reason =
    missing.length === 0
      ? null
      : missing.includes('runtime') && !missing.includes('model')
        ? runtimeInstallHint()
        : missing.includes('model') && !missing.includes('runtime')
          ? `目标检测模型尚未安装：运行 screen_setup {action:"install_detector"} 把它装进 ${SHARED_YOLO_DIR}。`
          : `${runtimeInstallHint()} 另外模型也还没装：screen_setup {action:"install_detector"}。`
  return {
    available: missing.length === 0,
    modelPath: model.path,
    modelSource: model.source,
    modelBytes: model.bytes,
    expectedBytes: DETECTOR_MODEL.bytes,
    runtime: { dir: runtime.dir, source: runtime.source, entry: runtime.entry },
    missing,
    reason,
    installHint: missing.length === 0 ? null : 'screen_setup {action:"install_detector"}',
    classes: DETECTOR_MODEL.classes,
  }
}

/** Cached inference session. The value is a promise so concurrent calls share one load. */
let sessionPromise = null

/**
 * Load (once) the ONNX session for the detector.
 *
 * @param {object} [config] - normalized plugin config.
 * @returns {Promise<{session: object, ort: object, inputName: string, inputType: string, side: number, outputName: string}>} the session and its input contract.
 * @throws {VisionError} when the model or the runtime is not available.
 */
export async function loadDetector(config = {}) {
  if (sessionPromise !== null) return sessionPromise

  sessionPromise = (async () => {
    const state = detectorState(config)
    if (!state.available) throw new VisionError(state.reason ?? '目标检测不可用')

    // Resolved here, not captured at import: the runtime may be installed after this process
    // started, and the paths must name wherever it actually is.
    const runtime = resolveRuntime()
    const ort = await import(pathToFileURL(runtime.entry).href)
    const threads = Number(config?.detector?.threads) > 0 ? Number(config.detector.threads) : 1
    ort.env.wasm.numThreads = threads
    ort.env.wasm.proxy = false
    ort.env.wasm.wasmPaths = {
      wasm: pathToFileURL(runtime.binary).href,
      // The threaded loader must be named explicitly: it is resolved relative to the document by
      // default, and this process has no document.
      mjs: pathToFileURL(join(runtime.packageDir, 'dist', 'ort-wasm-simd-threaded.mjs')).href,
    }

    const session = await ort.InferenceSession.create(readFileSync(state.modelPath), {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    })
    const input = session.inputMetadata?.[0] ?? { name: session.inputNames[0], shape: [], type: 'float32' }
    const dims = Array.isArray(input.shape) ? input.shape : []
    const side = Number(dims[dims.length - 1])
    if (!Number.isFinite(side) || side <= 0) throw new VisionError(`模型的输入形状无法解析：${JSON.stringify(dims)}`)
    return { session, ort, inputName: input.name, inputType: input.type ?? 'float32', side, outputName: session.outputNames[0] }
  })()

  try {
    return await sessionPromise
  } catch (error) {
    sessionPromise = null
    throw error
  }
}

/** Release the cached session. Useful in tests, and after an install. @returns {void} */
export function disposeDetector() {
  sessionPromise = null
}

/**
 * Decode a half-precision float, as the `float16` ONNX exports store their numbers.
 *
 * @param {number} h - the 16-bit pattern.
 * @returns {number} the value.
 */
export function halfToFloat(h) {
  const sign = (h & 0x8000) >> 15
  const exponent = (h & 0x7c00) >> 10
  const mantissa = h & 0x03ff
  if (exponent === 0) return (sign ? -1 : 1) * 2 ** -14 * (mantissa / 1024)
  if (exponent === 31) return mantissa ? NaN : (sign ? -Infinity : Infinity)
  return (sign ? -1 : 1) * 2 ** (exponent - 15) * (1 + mantissa / 1024)
}

/**
 * Encode a float as half precision, for a model whose input is `float16`.
 *
 * @param {number} value - the value, expected in 0..1.
 * @returns {number} the 16-bit pattern.
 */
export function floatToHalf(value) {
  const buffer = new Float32Array(1)
  const view = new Int32Array(buffer.buffer)
  buffer[0] = value
  const bits = view[0]
  const sign = (bits >> 16) & 0x8000
  let exponent = ((bits >> 23) & 0xff) - 127 + 15
  const mantissa = bits & 0x7fffff
  if (((bits >> 23) & 0xff) === 255) return sign | 0x7c00
  if (exponent <= 0) return sign
  if (exponent >= 31) return sign | 0x7c00
  exponent = (exponent << 10) | (mantissa >> 13)
  return sign | exponent
}

/**
 * Letterbox geometry: how a read image of `readWidth × readHeight` sits inside a square input.
 *
 * @param {number} readWidth - the read image's width.
 * @param {number} readHeight - the read image's height.
 * @param {number} side - the model's square input side.
 * @returns {{padX: number, padY: number, side: number}} where the image starts inside the square.
 */
export function letterbox(readWidth, readHeight, side) {
  return {
    padX: Math.max(0, Math.floor((side - readWidth) / 2)),
    padY: Math.max(0, Math.floor((side - readHeight) / 2)),
    side,
  }
}

/**
 * Build the model's input tensor from raw RGB pixels, letterboxed and normalised.
 *
 * @param {Buffer|Uint8Array} pixels - RGB24 bytes, `width * height * 3` long.
 * @param {object} geometry - the geometry.
 * @param {number} geometry.width - the read image width.
 * @param {number} geometry.height - the read image height.
 * @param {number} geometry.side - the square input side.
 * @param {number} geometry.padX - horizontal padding.
 * @param {number} geometry.padY - vertical padding.
 * @param {'float32'|'float16'} [geometry.type] - the tensor's dtype.
 * @returns {Float32Array|Uint16Array} the CHW tensor, in 0..1.
 */
export function buildInputTensor(pixels, geometry) {
  const { width, height, side, padX, padY, type = 'float32' } = geometry
  const plane = side * side
  const data = type === 'float16' ? new Uint16Array(3 * plane) : new Float32Array(3 * plane)
  const put = type === 'float16' ? floatToHalf : (value) => value
  for (let y = 0; y < height; y += 1) {
    const targetRow = (y + padY) * side
    for (let x = 0; x < width; x += 1) {
      const source = (y * width + x) * 3
      const target = targetRow + x + padX
      data[target] = put(pixels[source] / 255)
      data[plane + target] = put(pixels[source + 1] / 255)
      data[2 * plane + target] = put(pixels[source + 2] / 255)
    }
  }
  return data
}

/**
 * Read one element of a model output, whichever dtype it is.
 *
 * @param {Float32Array|Uint16Array|number[]} data - the raw output.
 * @param {number} index - the element index.
 * @param {string} type - the tensor's dtype.
 * @returns {number} the value.
 */
function elementAt(data, index, type) {
  const raw = data[index]
  if (type !== 'float16') return Number(raw)
  return halfToFloat(raw)
}

/**
 * Intersection over union of two boxes.
 *
 * @param {{x: number, y: number, width: number, height: number}} a - the first box.
 * @param {{x: number, y: number, width: number, height: number}} b - the second box.
 * @returns {number} the ratio, 0 when they do not overlap.
 */
export function iou(a, b) {
  const x1 = Math.max(a.x, b.x)
  const y1 = Math.max(a.y, b.y)
  const x2 = Math.min(a.x + a.width, b.x + b.width)
  const y2 = Math.min(a.y + a.height, b.y + b.height)
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  if (intersection <= 0) return 0
  const union = a.width * a.height + b.width * b.height - intersection
  return union <= 0 ? 0 : intersection / union
}

/**
 * Keep the best box of each class, dropping the ones it overlaps.
 *
 * @param {{classId: number, score: number}[]} candidates - detections, best first.
 * @param {number} threshold - IoU above which a lower-scoring box of the same class is dropped.
 * @param {number} [maxDetections] - stop after this many survivors.
 * @returns {object[]} the survivors, in the order they were considered.
 */
export function nonMaxSuppression(candidates, threshold, maxDetections = 50) {
  const kept = []
  for (const candidate of candidates) {
    let dropped = false
    for (const survivor of kept) {
      if (survivor.classId !== candidate.classId) continue
      if (iou(survivor.box, candidate.box) > threshold) {
        dropped = true
        break
      }
    }
    if (dropped) continue
    kept.push(candidate)
    if (kept.length >= maxDetections) break
  }
  return kept
}

/**
 * Decide which of the two trailing dimensions carries the channels.
 *
 * The plausible channel range is `5…1024`: a YOLO head emits `4+nc` or `5+nc` values per box, so a
 * real detector has at least 5 and never thousands. The axis in that range is the channel axis. When
 * both are in range — only possible for a toy tensor — the smaller one is taken as the channels,
 * which is the convention every export follows.
 *
 * @param {number[]} dims - the output tensor's dimensions.
 * @returns {{channelMajor: boolean, reason: string}} the layout and why it was chosen.
 * @throws {VisionError} when the shape is not a YOLO output.
 */
export function decideLayout(dims) {
  if (!Array.isArray(dims) || dims.length !== 3 || !dims.every((value) => Number.isFinite(value) && value > 0)) {
    throw new VisionError(`不是 YOLO 的输出张量：dims=${JSON.stringify(dims)}`)
  }
  const [, first, second] = dims
  const plausible = (value) => value >= 5 && value <= 1024
  if (plausible(first) && !plausible(second)) return { channelMajor: true, reason: `dims[1]=${first} 在通道范围内` }
  if (plausible(second) && !plausible(first)) return { channelMajor: false, reason: `dims[2]=${second} 在通道范围内` }
  if (plausible(first) && plausible(second)) {
    return first < second
      ? { channelMajor: true, reason: '两个维度都在通道范围内，取较小的一个作为通道' }
      : { channelMajor: false, reason: '两个维度都在通道范围内，取较小的一个作为通道' }
  }
  throw new VisionError(`输出张量的两个维度都不像通道数：dims=${JSON.stringify(dims)}`)
}

/**
 * Decode a YOLO output tensor into boxes in **source-frame pixels**.
 *
 * Both layouts are accepted: `[1, 4+nc, N]` (v8 and later, channel-major) and `[1, N, 5+nc]` (v5,
 * row-major, with an objectness term). The layout is decided from the tensor's own dimensions, so a
 * caller never has to say which export it has.
 *
 * @param {object} request - the decode.
 * @param {Float32Array|Uint16Array|number[]} request.data - the raw output.
 * @param {number[]} request.dims - the output tensor's dimensions.
 * @param {string} [request.type] - the tensor's dtype.
 * @param {number} request.padX - the letterbox's horizontal padding, in input pixels.
 * @param {number} request.padY - the letterbox's vertical padding.
 * @param {number} request.factor - source pixels per read pixel.
 * @param {number} request.sourceWidth - the source frame's width.
 * @param {number} request.sourceHeight - the source frame's height.
 * @param {number} [request.minScore] - drop detections below this. Default 0.35.
 * @param {number} [request.iou] - NMS IoU threshold. Default 0.45.
 * @param {number} [request.maxDetections] - keep at most this many. Default 50.
 * @param {string[]} [request.labels] - class names; defaults to COCO when the tensor has 80 classes.
 * @returns {{objects: object[], candidates: number, layout: string, classCount: number}} the detections, in source pixels.
 * @throws {VisionError} when the tensor shape is not a YOLO output.
 */
export function decodeDetections(request) {
  const dims = Array.isArray(request.dims) ? request.dims.map(Number) : []
  if (dims.length < 2) throw new VisionError(`不是 YOLO 的输出张量：dims=${JSON.stringify(dims)}`)
  const type = request.type ?? 'float32'
  const minScore = Number.isFinite(request.minScore) ? request.minScore : 0.35
  const iouThreshold = Number.isFinite(request.iou) ? request.iou : 0.45
  const maxDetections = Number.isFinite(request.maxDetections) ? request.maxDetections : 50
  const { data } = request

  // YOLO exports differ in which axis carries the channels. The channel count is always small (5+nc
  // or 4+nc, so 5…1004 for any real detector) while the row count is the number of candidate boxes,
  // usually in the thousands — so the axis that falls in the plausible channel range is the channel
  // axis, and the other one is the rows. Deciding by "which is smaller" instead breaks on a tensor
  // with few rows, which is exactly what a unit test or a tiny export produces.
  const layout = decideLayout(dims)
  const channelMajor = layout.channelMajor
  const channels = channelMajor ? dims[1] : dims[2]
  const rows = channelMajor ? dims[2] : dims[1]
  const hasObjectness = !channelMajor || channels === 85 || channels === 6
  const classCount = hasObjectness ? channels - 5 : channels - 4
  if (classCount < 1) throw new VisionError(`输出里没有类别维度：channels=${channels}`)
  const labels = Array.isArray(request.labels) && request.labels.length === classCount ? request.labels : classCount === COCO_CLASSES.length ? COCO_CLASSES : null

  const value = (row, channel) => (channelMajor ? elementAt(data, channel * rows + row, type) : elementAt(data, row * channels + channel, type))

  const candidates = []
  for (let row = 0; row < rows; row += 1) {
    let bestClass = -1
    let bestScore = 0
    const offset = hasObjectness ? 5 : 4
    for (let index = 0; index < classCount; index += 1) {
      const score = value(row, offset + index)
      if (score > bestScore) {
        bestScore = score
        bestClass = index
      }
    }
    const confidence = hasObjectness ? value(row, 4) * bestScore : bestScore
    if (confidence < minScore || bestClass < 0) continue
    const cx = value(row, 0)
    const cy = value(row, 1)
    const width = value(row, 2)
    const height = value(row, 3)
    // Back out of the letterbox: subtract the padding, then scale to source pixels.
    const left = (cx - width / 2 - request.padX) * request.factor
    const top = (cy - height / 2 - request.padY) * request.factor
    const boxWidth = width * request.factor
    const boxHeight = height * request.factor
    candidates.push({
      classId: bestClass,
      label: labels === null ? `class_${bestClass}` : labels[bestClass],
      score: Number(confidence.toFixed(4)),
      box: clampBox(
        { x: left, y: top, width: boxWidth, height: boxHeight },
        request.sourceWidth,
        request.sourceHeight,
      ),
    })
  }

  candidates.sort((a, b) => b.score - a.score)
  const kept = nonMaxSuppression(candidates, iouThreshold, maxDetections)
  return {
    objects: kept.map((entry) => ({
      ...entry,
      center: { x: Math.round(entry.box.x + entry.box.width / 2), y: Math.round(entry.box.y + entry.box.height / 2) },
    })),
    candidates: candidates.length,
    layout: channelMajor ? 'channel-major' : 'row-major',
    layoutReason: layout.reason,
    classCount,
  }
}

/**
 * Clip a box to the frame and round it, so every reported box is inside the picture it came from.
 *
 * @param {{x: number, y: number, width: number, height: number}} box - the raw box.
 * @param {number} frameWidth - the frame's width.
 * @param {number} frameHeight - the frame's height.
 * @returns {{x: number, y: number, width: number, height: number}} integers inside the frame.
 */
function clampBox(box, frameWidth, frameHeight) {
  const left = Math.max(0, Math.min(box.x, frameWidth))
  const top = Math.max(0, Math.min(box.y, frameHeight))
  const right = Math.max(left, Math.min(box.x + box.width, frameWidth))
  const bottom = Math.max(top, Math.min(box.y + box.height, frameHeight))
  return { x: Math.round(left), y: Math.round(top), width: Math.round(right - left), height: Math.round(bottom - top) }
}

/**
 * Detect objects in one image, or one frame of a video.
 *
 * @param {object} request - the request.
 * @param {string} request.input - the image or video.
 * @param {number} [request.at] - for a video, the second to read.
 * @param {object} [request.config] - normalized plugin config.
 * @param {number} [request.minScore] - confidence floor. Defaults to the config's, then 0.35.
 * @param {number} [request.iou] - NMS threshold. Defaults to the config's, then 0.45.
 * @param {number} [request.maxSide] - the model's input side; defaults to the model's own.
 * @param {number} [request.maxDetections] - default 50.
 * @param {(event: object) => void} [request.onProgress] - progress events.
 * @returns {Promise<object>} the detections and how they were produced.
 * @throws {VisionError} when detection is unavailable.
 */
export async function detectFrame(request) {
  const config = request.config ?? {}
  const loaded = await loadDetector(config)
  const side = Number.isFinite(request.maxSide) ? Math.round(request.maxSide) : loaded.side
  const started = Date.now()
  request.onProgress?.({ phase: 'reading', at: request.at ?? null })

  const read = await readPixels({ input: request.input, at: request.at, config, maxSide: side, channels: 3 })
  const geometry = letterbox(read.width, read.height, side)
  const tensor = buildInputTensor(read.pixels, { ...geometry, width: read.width, height: read.height, type: loaded.inputType })
  const shape = [1, 3, side, side]
  const feeds = { [loaded.inputName]: new loaded.ort.Tensor(loaded.inputType ?? 'float32', tensor, shape) }

  request.onProgress?.({ phase: 'detecting', at: request.at ?? null })
  const inferenceStarted = Date.now()
  const output = await loaded.session.run(feeds)
  const inferenceMs = Date.now() - inferenceStarted
  const result = output[loaded.outputName]
  const decoded = decodeDetections({
    data: result.data,
    dims: result.dims,
    type: result.type,
    padX: geometry.padX,
    padY: geometry.padY,
    factor: read.factor,
    sourceWidth: read.sourceWidth,
    sourceHeight: read.sourceHeight,
    minScore: Number.isFinite(request.minScore) ? request.minScore : config.detector?.minScore,
    iou: Number.isFinite(request.iou) ? request.iou : config.detector?.iou,
    maxDetections: request.maxDetections,
  })

  return {
    input: request.input,
    at: read.at,
    frame: { width: read.sourceWidth, height: read.sourceHeight },
    readSize: { width: read.width, height: read.height },
    modelSize: side,
    objects: decoded.objects,
    candidates: decoded.candidates,
    layout: decoded.layout,
    classCount: decoded.classCount,
    inferenceMs,
    elapsedMs: Date.now() - started,
  }
}

/**
 * Detect objects across several moments of one recording.
 *
 * Frames are read one at a time on purpose: the WASM backend is single-threaded here, so running
 * them concurrently would only make each one slower while using more memory.
 *
 * @param {object} request - the request.
 * @param {string} request.input - the recording.
 * @param {number[]} request.times - the seconds to sample, in order.
 * @param {object} [request.config] - normalized plugin config.
 * @param {number} [request.minScore] - confidence floor.
 * @param {number} [request.iou] - NMS threshold.
 * @param {number} [request.maxDetections] - per frame.
 * @param {(event: object) => void} [request.onProgress] - progress events.
 * @returns {Promise<{frames: object[], counts: Record<string, number>, model: object, elapsedMs: number}>} the detections and a per-class count.
 */
export async function detectFrames(request) {
  const times = Array.isArray(request.times) ? request.times.filter((value) => Number.isFinite(value)) : []
  const started = Date.now()
  const frames = []
  const counts = {}
  for (const [index, at] of times.entries()) {
    request.onProgress?.({ phase: 'detect-frame', index: index + 1, total: times.length, at })
    const frame = await detectFrame({ ...request, at, onProgress: undefined })
    frames.push({ at, objects: frame.objects, inferenceMs: frame.inferenceMs })
    for (const object of frame.objects) counts[object.label] = (counts[object.label] ?? 0) + 1
  }
  const sorted = Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])))
  return {
    frames,
    counts: sorted,
    model: {
      name: DETECTOR_MODEL.name,
      path: resolveDetectorModel(request.config ?? {}).path,
      classes: DETECTOR_MODEL.classes,
      license: DETECTOR_MODEL.license,
    },
    elapsedMs: Date.now() - started,
  }
}

/** Raised when detection cannot run, or a model output cannot be read. */
export class VisionError extends Error {
  /**
   * @param {string} message - what failed and what to do about it.
   */
  constructor(message) {
    super(message)
    this.name = 'VisionError'
  }
}

/** Where a detector model would be installed. Re-exported for the installer and the report. */
export const DETECTOR_INSTALL_DIR = SHARED_YOLO_DIR

/** The models directory, re-exported so a report can name it without importing home itself. */
export const MODELS_DIR = SHARED_MODELS_DIR

/** Re-exported so a caller can name the scratch layout the shared home uses. */
export { sharedPath }
