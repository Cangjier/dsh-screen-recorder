/**
 * 把画面上的文字读出来：能用同级 dsh-ocr 就用它，用不了才退回 Windows 自带的识别。
 *
 * 录屏本身不产生文字，只产生像素；一份「可检索的录屏」需要的却是画面里写了什么。这个模块就是
 * 那一步：给它一帧、一段视频的某一秒、或画面里的一小块区域，它还回一行行文字，以及每一行在
 * **源帧坐标系**里的方框——调用方拿这个方框去点、去比对、去建索引。
 *
 * 两个提供者，按顺序试，结果里永远写着最后是谁读的：
 *
 * 1. **同级 dsh-ocr**（首选）：它的离线引擎（PP-OCR / RapidOCR）对小字和中英混排明显更准，而且
 *    对装了这套插件的人来说已经在磁盘上了。按**路径**动态 import，不按包名——`link:` 装进来的
 *    插件解析到的是它自己的目录，不是 profile 的 `node_modules`。
 * 2. **Windows 自带的识别**（兜底）：经由 `src/bin/winrt-ocr.ps1`，零安装、Windows 上一定存在，
 *    但小字更容易读错。所以结果里写清楚是谁读的，而不是把差别藏起来。
 *
 * ## provider 是硬边界，不是偏好
 *
 * - `off`     —— 一个字都不读：`ocrStatus` 报 `available: false`，`ocrImage` 立刻抛 `OcrError`。
 * - `sibling` —— 只许用同级 dsh-ocr。它不在、或里面没装引擎，就**大声失败**，绝不偷偷换引擎：
 *                读出来的东西来自哪个引擎，是调用方必须能预知的事。
 * - `winrt`   —— 只许用 Windows 识别；连同级 dsh-ocr 都不会去 import。
 * - `auto`    —— 先同级，失败再 Windows。**只有这一档允许回退。**
 *
 * ## 坐标契约
 *
 * 每一行的 `box` 都是**源帧像素**坐标，整数；`center` 是它的中心点。降采样过的读取要靠
 * {@link scaleFactor} 乘回去，裁剪过的读取要加上偏移，这两件事都在 {@link mapLines} 里做，
 * 于是「读的是哪张图」和「框在哪」之间的关系只有一处算术。
 *
 * ## `src/bin/winrt-ocr.ps1` 的 JSON 契约（稳定，不要改形状）
 *
 * 成功：`{ ok: true, language, lineCount, elapsedMs, scale, sourceWidth, sourceHeight, note,
 *          lines: [{ text, confidence, x, y, width, height }] }`
 * 失败：`{ ok: false, error }`（脚本自己 catch，stdout 上只有这一个对象，**不是** PowerShell 栈；
 *       退出码是 2，让 shell 那边也判断得出来。）
 *
 * `note` 只在「要的语言没装、退到了系统语言」时非 null：读出来的字可能是另一种语言的模型读的，
 * 那是调用方有权知道的事。`confidence` 在 Windows 这条路上恒为 `null`：`Windows.Media.Ocr` 不提供
 * 逐行置信度，编一个出来比诚实地说「没有」更糟。`minConfidence` 对 `null` 一律放行。
 *
 * ## 文件编码：`winrt-ocr.ps1` 必须是 UTF-8 **with BOM**
 *
 * Windows PowerShell 5.1 读没有 BOM 的 `.ps1` 会按 GBK 解，脚本里的中文与它输出的中文一起变乱码——
 * 本插件的仓库 copy 因此带 BOM，行尾是 CRLF（`.gitattributes` 对 `*.ps1` 的要求）。
 * 注意：`dsh-ffmpeg/src/bin/winrt-ocr.ps1`（本文件的蓝本）**没有** BOM，别照抄它的字节。
 *
 * ## 放大（`-Scale`）放在哪做，以及为什么
 *
 * - **不裁剪**（整帧）：识别器直接读原文件，放大交给识别器自己做（脚本的 `-Scale`、同级插件的
 *   `scale`）。这样不为了放大而把整帧重新编码一遍，脚本也会把方框除回去。
 * - **要裁剪**（`region`）：裁剪本来就得让 ffmpeg 碰一遍像素，所以**裁剪和放大合成一次 ffmpeg
 *   调用**、尺寸由本模块算好（和 `image.mjs` 的 `readPixels` 同一个做法）。这时方框是放大后
 *   的裁剪图坐标，靠 {@link scaleFactor} 除回来，再加区域原点。
 *
 * 两种情况下 `-Scale` 都不会被重复施加：交给脚本的裁剪图已经放大过了，所以传 `-Scale 1`。
 *
 * @module dsh-screen-recorder/core/ocr
 */
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { PLUGIN_ROOT, siblingRoots } from './env.mjs'
import { runFfmpeg } from './ffmpeg.mjs'
import { readPixels, scaleFactor } from './image.mjs'

const run = promisify(execFile)

/** 允许的提供者取值。 */
export const OCR_PROVIDERS = ['auto', 'sibling', 'winrt', 'off']

/** 本插件自带的 Windows 识别脚本。 */
export const WINRT_SCRIPT = fileURLToPath(new URL('../bin/winrt-ocr.ps1', import.meta.url))

/** 裁剪出来的临时帧放在这里；`tmp/` 是 gitignore 的。 */
export const OCR_TMP_DIR = join(PLUGIN_ROOT, 'tmp', 'ocr')

/** `scale: "auto"` 想把长边放大到多少像素。与同级 dsh-ocr 的取值一致。 */
export const AUTO_TARGET_LONG_SIDE = 1000

/** 放大倍数的上限。超过 3 倍只是把像素变大，不增加信息。 */
export const MAX_SCALE = 3

/** 只为拿画幅尺寸而读像素时用的长边——这里要的是尺寸，不是像素。 */
export const GEOMETRY_MAX_SIDE = 64

/** 没有同级引擎时给出的下一步。 */
export const INSTALL_HINT = '在同级 dsh-ocr 里运行 text_setup {action:"install"}：离线引擎约 73MB，读小字和中英混排会准很多。'

/** 识别语言：调用方用的短名，和识别器要的 BCP-47 标签。 */
export const OCR_LANGUAGES = {
  ch: 'zh-Hans-CN',
  'zh-cn': 'zh-Hans-CN',
  'zh-hans': 'zh-Hans-CN',
  cht: 'zh-Hant-TW',
  'zh-tw': 'zh-Hant-TW',
  'zh-hant': 'zh-Hant-TW',
  en: 'en-US',
  eng: 'en-US',
  japan: 'ja-JP',
  ja: 'ja-JP',
  korean: 'ko-KR',
  ko: 'ko-KR',
  cyrillic: 'ru-RU',
  ru: 'ru-RU',
}

/** 读文字这一步失败时抛的东西。 */
export class OcrError extends Error {
  /**
   * @param {string} message - 一句能照着动作的话。
   * @param {object} [details] - 需要跟着错误一起给出去的事实。
   */
  constructor(message, details = {}) {
    super(message)
    this.name = 'OcrError'
    Object.assign(this, details)
  }
}

/**
 * 把短语言名变成识别器认的 BCP-47 标签。
 *
 * @param {string|undefined} language - `ch`、`en`，或已经是标签的值。
 * @returns {string} 语言标签；说不清时给 `zh-Hans-CN`。
 */
export function languageTag(language) {
  if (typeof language !== 'string' || language.trim() === '') return 'zh-Hans-CN'
  const key = language.trim().toLowerCase()
  if (OCR_LANGUAGES[key] !== undefined) return OCR_LANGUAGES[key]
  return /^[a-z]{2}(-[a-z0-9]+)*$/i.test(language.trim()) ? language.trim() : 'zh-Hans-CN'
}

/**
 * 把配置里写的提供者收敛成四档之一。
 *
 * 认不出来的值当作 `auto`：配置写错一个字母就让整个插件不能读字，是比回退更糟的结果。
 *
 * @param {string|undefined} value - `config.ocr.provider`。
 * @returns {'auto'|'sibling'|'winrt'|'off'} 四档之一。
 */
export function normaliseProvider(value) {
  return OCR_PROVIDERS.includes(value) ? value : 'auto'
}

/**
 * 所有可能放着 `dsh-ocr` 的目录，越靠前越优先。
 *
 * @param {object} [config] - 规范化后的插件配置。
 * @returns {string[]} 绝对目录，已去重、已去掉尾部分隔符。
 */
export function siblingOcrRoots(config = {}) {
  const candidates = []
  const configured = config?.ocr?.pluginPath
  if (typeof configured === 'string' && configured.trim() !== '') candidates.push(configured.trim())
  for (const root of siblingRoots()) candidates.push(join(root, 'dsh-ocr'))
  return [...new Set(candidates.map((entry) => entry.replace(/[\\/]+$/, '')))]
}

/**
 * 加载同级插件的确定性内核——它在那儿才加载。
 *
 * @param {object} [config] - 规范化后的插件配置。
 * @returns {Promise<{module: object, root: string, corePath: string}|null>} 加载到的模块，或 null。
 */
export async function loadSiblingOcr(config = {}) {
  return (await siblingLookup(config)).module
}

/**
 * 找一次同级模块，并把「为什么没找到」一起带回来。
 *
 * 一个 import 不进来的同级 checkout 就等于不存在——那是它的问题，不是本插件的问题，半装的同级
 * 插件不能把读文字这件事一起拖下去。但「checkout 不在」和「checkout 在、import 挂了」是两件不同
 * 的事：前者用户没法做什么，后者是一条能修的错误，所以这里把后者记下来，让报告说清楚是哪一种。
 *
 * @param {object} [config] - 规范化后的插件配置。
 * @returns {Promise<{module: {module: object, root: string, corePath: string}|null, failure: {root: string, corePath: string, message: string}|null}>} 结果与原因。
 */
async function findSiblingOcr(config = {}) {
  let failure = null
  for (const root of siblingOcrRoots(config)) {
    const corePath = join(root, 'src', 'core', 'index.mjs')
    if (!existsSync(corePath)) continue
    try {
      const module = await import(pathToFileURL(corePath).href)
      if (typeof module.recogniseImage !== 'function') continue
      if (typeof module.resolveOcrEngine !== 'function') continue
      return { module: { module, root, corePath }, failure: null }
    } catch (error) {
      failure = { root, corePath, message: error instanceof Error ? error.message : String(error) }
    }
  }
  return { module: null, failure }
}

/** 同级模块的 import 缓存，按候选根目录分组，于是同一个目录只 import 一次。 */
const siblingCache = new Map()

/**
 * 取（并缓存）同级模块的查找结果。
 *
 * 缓存的是 **promise**：两个并发调用同时来找引擎，也只会 import 一次。缓存按候选根目录分组，
 * 于是换了 `ocr.pluginPath` 的调用不会被第一次的结果骗到。
 *
 * @param {object} [config] - 规范化后的插件配置。
 * @returns {Promise<{module: {module: object, root: string, corePath: string}|null, failure: {root: string, corePath: string, message: string}|null}>} 结果与原因。
 */
function siblingLookup(config = {}) {
  const key = siblingOcrRoots(config).join('\u0000')
  if (!siblingCache.has(key)) {
    // 缓存的 promise 永不 reject：一个被拒绝的 promise 会让之后每一次调用都跟着失败。
    siblingCache.set(key, findSiblingOcr(config).catch(() => ({ module: null, failure: null })))
  }
  return siblingCache.get(key)
}

/**
 * 忘掉缓存过的同级模块查找。给测试用，也给「刚装完引擎」的进程用。
 *
 * @returns {void}
 */
export function resetOcrCache() {
  siblingCache.clear()
}

/**
 * 问同级 dsh-ocr 要一个引擎描述符。
 *
 * @param {{module: object, root: string}} sibling - {@link loadSiblingOcr} 的结果。
 * @returns {{kind: string, label: string|null, source: string|null, executable: string|null}|null} 引擎，或 null。
 */
function siblingEngine(sibling) {
  if (sibling === null) return null
  try {
    const engine = sibling.module.resolveOcrEngine({})
    if (engine === null || engine === undefined) return null
    return {
      kind: engine.kind ?? 'unknown',
      label: engine.label ?? null,
      source: engine.source ?? null,
      executable: engine.executable ?? null,
    }
  } catch {
    // 同级插件自己说「配置指向的引擎没了」时也走这里：对调用方来说就是「这个提供者不可用」。
    return null
  }
}

/**
 * Windows 自带识别在这台机器上能不能用（只查平台与脚本在不在，不启动任何进程）。
 *
 * @returns {{available: boolean, reason: string|null}} 可用性。
 */
function winrtState() {
  if (process.platform !== 'win32') {
    return { available: false, reason: '这台机器不是 Windows，没有 Windows 自带的文字识别。' }
  }
  if (!existsSync(WINRT_SCRIPT)) {
    return { available: false, reason: `本插件的 Windows 识别脚本不在了：${WINRT_SCRIPT}` }
  }
  return { available: true, reason: null }
}

/**
 * 现在到底能不能读字，以及是谁读。
 *
 * 只查事实，不启动识别进程：同级 dsh-ocr 的模块 import 一次（会缓存），引擎描述符是同步解析的，
 * Windows 一侧只看平台和脚本在不在。
 *
 * @param {object} [config] - 规范化后的插件配置，读 `config.ocr`。
 * @returns {Promise<{available: boolean, provider: 'sibling'|'winrt'|null, engine: string|null, language: string, reason: string|null, installHint: string|null, roots: string[], requested: string, platform: string, script: string, sibling: object, winrt: object, notes: string[]}>} 可用性报告。
 */
export async function ocrStatus(config = {}) {
  const ocr = config?.ocr ?? {}
  const requested = normaliseProvider(ocr.provider)
  const language = languageTag(ocr.language)
  const roots = siblingOcrRoots(config)
  const notes = []
  const winrt = winrtState()
  const base = {
    requested,
    language,
    roots,
    platform: process.platform,
    script: WINRT_SCRIPT,
    winrt: { available: winrt.available, reason: winrt.reason },
    installHint: null,
    notes,
  }

  if (requested === 'off') {
    return { ...base, available: false, provider: null, engine: null, reason: '配置里关掉了文字识别', sibling: { present: false, root: null, engine: null } }
  }

  // provider: 'winrt' 连同级都不去看——这是这一档的全部意义。
  let sibling = null
  let engine = null
  let failure = null
  if (requested !== 'winrt') {
    const lookup = await siblingLookup(config)
    sibling = lookup.module
    failure = lookup.failure
    engine = siblingEngine(sibling)
    if (sibling === null) {
      notes.push(`找过的 dsh-ocr 位置：${roots.join(' / ')}`)
      if (failure !== null) notes.push(`${failure.root} 是有的，但它的 src/core/index.mjs import 不进来：${failure.message}`)
    } else if (engine === null) notes.push(`同级 dsh-ocr 在 ${sibling.root}，但里面没有装离线引擎。`)
  }
  const siblingReport = {
    present: sibling !== null,
    root: sibling?.root ?? null,
    engine,
  }

  if (requested === 'sibling') {
    if (engine !== null) {
      return { ...base, available: true, provider: 'sibling', engine: `dsh-ocr:${engine.kind}${engine.source === null ? '' : `@${engine.source}`}`, reason: null, installHint: null, sibling: siblingReport }
    }
    const reason = sibling === null
      ? `配置要求用同级 dsh-ocr，但 ${roots.join(' / ')} 里都没有可加载的 dsh-ocr。${failure === null ? '' : `（${failure.root} 在，但 import 失败：${failure.message}）`}`
      : `同级 dsh-ocr 在 ${sibling.root}，但里面没有可用的离线引擎。`
    return { ...base, available: false, provider: null, engine: null, reason, installHint: INSTALL_HINT, sibling: siblingReport }
  }

  if (requested === 'winrt') {
    if (winrt.available) {
      return { ...base, available: true, provider: 'winrt', engine: `windows-ocr:${language}`, reason: null, installHint: null, sibling: siblingReport }
    }
    notes.push('配置明确要求 Windows 自带识别，所以没有找同级 dsh-ocr。')
    return { ...base, available: false, provider: null, engine: null, reason: winrt.reason, installHint: INSTALL_HINT, sibling: siblingReport }
  }

  // auto：唯一允许回退的一档。
  if (engine !== null) {
    return { ...base, available: true, provider: 'sibling', engine: `dsh-ocr:${engine.kind}${engine.source === null ? '' : `@${engine.source}`}`, reason: null, installHint: null, sibling: siblingReport }
  }
  if (winrt.available) {
    notes.push(
      sibling === null
        ? '没有找到同级 dsh-ocr，用 Windows 自带识别（小字更容易读错）。'
        : '同级 dsh-ocr 没有可用引擎，用 Windows 自带识别（小字更容易读错）。',
    )
    return { ...base, available: true, provider: 'winrt', engine: `windows-ocr:${language}`, reason: null, installHint: INSTALL_HINT, sibling: siblingReport }
  }

  notes.push('同级 dsh-ocr 不可用，Windows 自带识别也不可用。')
  return { ...base, available: false, provider: null, engine: null, reason: `${winrt.reason ?? '没有可用的文字识别。'}`, installHint: INSTALL_HINT, sibling: siblingReport }
}

/**
 * 一行识别结果来自哪个矩形（读取图自己的像素坐标）。
 *
 * 认两种形状：识别器直接给的 `x/y/width/height`，和 dsh-ocr 给的 `box: [[x, y], ...]` 多边形。
 *
 * @param {object} line - 识别器给出的一行。
 * @returns {{x: number, y: number, width: number, height: number}|null} 矩形，或 null。
 */
function rectangleOf(line) {
  const numbers = [line?.x, line?.y, line?.width, line?.height]
  if (numbers.every((value) => Number.isFinite(value))) {
    return { x: Number(line.x), y: Number(line.y), width: Number(line.width), height: Number(line.height) }
  }
  const points = polygonOf(line)
  if (points !== null) {
    const xs = points.map((point) => point[0])
    const ys = points.map((point) => point[1])
    const x = Math.min(...xs)
    const y = Math.min(...ys)
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
  }
  const box = line?.box
  if (box !== null && typeof box === 'object' && !Array.isArray(box) && Number.isFinite(box.x) && Number.isFinite(box.y)) {
    return { x: Number(box.x), y: Number(box.y), width: Number(box.width ?? 0), height: Number(box.height ?? 0) }
  }
  return null
}

/**
 * 一行识别结果的多边形，如果识别器给了的话。
 *
 * @param {object} line - 识别器给出的一行。
 * @returns {number[][]|null} `[[x, y], ...]`，或 null。
 */
function polygonOf(line) {
  const box = line?.box
  if (!Array.isArray(box) || box.length < 3) return null
  const points = []
  for (const point of box) {
    if (!Array.isArray(point) || point.length < 2) return null
    const x = Number(point[0])
    const y = Number(point[1])
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    points.push([x, y])
  }
  return points
}

/**
 * 一行的置信度，规整到 0..1，或者诚实地给 null。
 *
 * @param {object} line - 识别器给出的一行。
 * @returns {number|null} 0..1，或 null（识别器没有提供时）。
 */
function confidenceOf(line) {
  const raw = line?.confidence ?? line?.score
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  return Number(Math.min(1, Math.max(0, raw)).toFixed(4))
}

/**
 * 两个矩形有没有交集（相接也算，免得零宽的一行被丢掉）。
 *
 * @param {{x: number, y: number, width: number, height: number}} box - 待判定的框。
 * @param {{x: number, y: number, width: number, height: number}} region - 区域。
 * @returns {boolean} 有交集为 true。
 */
function intersects(box, region) {
  const left = Math.max(box.x, region.x)
  const right = Math.min(box.x + box.width, region.x + region.width)
  const top = Math.max(box.y, region.y)
  const bottom = Math.min(box.y + box.height, region.y + region.height)
  return right >= left && bottom >= top
}

/**
 * 把识别器给出的框从「它读的那张图」映射回源帧，并按区域与置信度筛掉不该留的行。
 *
 * 纯函数，不碰磁盘也不碰配置，所以这段算术可以单独测。映射规则只有一条：
 * `源坐标 = 读取坐标 × factor + offset`。`factor` 用 {@link scaleFactor} 求（读取图比源小就乘大，
 * 放大过就乘小），`offset` 是裁剪区域在源帧里的原点。
 *
 * @param {object[]} lines - 识别器给出的行，`{ text, confidence|score, x, y, width, height, box? }`。
 * @param {object} [options] - 映射方式。
 * @param {number} [options.factor] - 读取坐标乘多少才回到源帧坐标。默认 1。
 * @param {number} [options.offsetX] - 裁剪区域原点的 x。默认 0。
 * @param {number} [options.offsetY] - 裁剪区域原点的 y。默认 0。
 * @param {{x: number, y: number, width: number, height: number}|null} [options.region] - 只保留与它相交的行。
 * @param {number|null} [options.minConfidence] - 低于它就丢掉；`confidence` 是 null 的行一律放行。
 * @returns {{text: string, confidence: number|null, box: {x: number, y: number, width: number, height: number}, center: {x: number, y: number}, polygon?: number[][]}[]} 源帧坐标下的行，按从上到下、从左到右排序。
 */
export function mapLines(lines, options = {}) {
  const factor = Number.isFinite(options.factor) && options.factor > 0 ? options.factor : 1
  const offsetX = Number.isFinite(options.offsetX) ? options.offsetX : 0
  const offsetY = Number.isFinite(options.offsetY) ? options.offsetY : 0
  const region = options.region ?? null
  const minConfidence = Number.isFinite(options.minConfidence) ? options.minConfidence : null

  const mapped = []
  for (const line of Array.isArray(lines) ? lines : []) {
    const text = typeof line?.text === 'string' ? line.text : ''
    if (text.trim() === '') continue

    const confidence = confidenceOf(line)
    if (minConfidence !== null && confidence !== null && confidence < minConfidence) continue

    const rectangle = rectangleOf(line)
    if (rectangle === null) continue

    const box = {
      x: Math.round(rectangle.x * factor + offsetX),
      y: Math.round(rectangle.y * factor + offsetY),
      width: Math.round(rectangle.width * factor),
      height: Math.round(rectangle.height * factor),
    }
    if (region !== null && !intersects(box, region)) continue

    const entry = {
      text,
      confidence,
      box,
      center: { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) },
    }
    const polygon = polygonOf(line)
    if (polygon !== null) {
      // 多边形是旋转标签唯一能放准点击位置的东西，所以它跟着矩形一起映射，而不是丢掉。
      entry.polygon = polygon.map((point) => [
        Math.round(point[0] * factor + offsetX),
        Math.round(point[1] * factor + offsetY),
      ])
    }
    mapped.push(entry)
  }

  mapped.sort((left, right) => left.box.y - right.box.y || left.box.x - right.box.x)
  return mapped
}

/**
 * 放大倍数：整数 1–3。
 *
 * `auto` 想把长边推到 {@link AUTO_TARGET_LONG_SIDE}，但脚本的参数是整数，所以这里就取整——
 * 一个 900px 宽的图不会被放大，一个 400px 的会被放大一倍。
 *
 * @param {number|string|undefined} requested - 调用方要的倍数，或 `'auto'`。
 * @param {{width: number, height: number}|null} [dimensions] - 判 `auto` 用的尺寸。
 * @returns {number} 1、2 或 3。
 */
export function resolveScale(requested, dimensions = null) {
  if (requested === 'auto') {
    const long = Math.max(Number(dimensions?.width ?? 0), Number(dimensions?.height ?? 0))
    if (!(long > 0)) return 1
    return Math.min(MAX_SCALE, Math.max(1, Math.round(AUTO_TARGET_LONG_SIDE / long)))
  }
  if (!Number.isFinite(requested)) return 1
  return Math.min(MAX_SCALE, Math.max(1, Math.round(Number(requested))))
}

/**
 * 把调用方给的裁剪区域收敛成一个合法的矩形。
 *
 * 形状不认识就抛错：区域写错了却当成「整帧」去读，返回的框会整体偏掉，而那种错误没人看得出来。
 *
 * @param {object|string|null|undefined} region - `{x, y, width, height}` 或 `"x,y,width,height"`。
 * @returns {{x: number, y: number, width: number, height: number}|null} 规整后的区域，没给就是 null。
 * @throws {OcrError} 形状不对，或宽高不是正数时。
 */
export function parseRegion(region) {
  if (region === undefined || region === null) return null
  let raw = region
  if (typeof region === 'string') {
    const parts = region.split(',').map((entry) => Number(entry.trim()))
    if (parts.length !== 4) throw new OcrError(`区域要写成 "x,y,width,height"，收到的是 "${region}"`)
    raw = { x: parts[0], y: parts[1], width: parts[2], height: parts[3] }
  }
  const x = Number(raw?.x ?? 0)
  const y = Number(raw?.y ?? 0)
  const width = Number(raw?.width)
  const height = Number(raw?.height)
  if (![x, y, width, height].every((value) => Number.isFinite(value))) {
    throw new OcrError(`区域里的 x/y/width/height 必须都是数字：${JSON.stringify(region)}`)
  }
  if (!(width > 0) || !(height > 0)) {
    throw new OcrError(`区域的宽高必须是正数：${width}x${height}`)
  }
  return { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)), width: Math.round(width), height: Math.round(height) }
}

/**
 * 偶数的至少 2 的整数。裁剪尺寸取偶数，免得 ffmpeg 在色度子采样上挑剔。
 *
 * @param {number} value - 任意正数。
 * @returns {number} 偶数。
 */
function even(value) {
  return Math.max(2, Math.round(value / 2) * 2)
}

/**
 * 问一下画幅尺寸。
 *
 * 这里**只要尺寸**，所以长边压到 {@link GEOMETRY_MAX_SIDE}：真正要认识的那张图由识别器自己读，
 * 本模块不把像素搬来搬去。读不出来不是错误——`auto` 放大按 1 处理，并在 notes 里说明。
 *
 * @param {string} input - 图片或视频。
 * @param {object} call - `{ at, config }`。
 * @returns {Promise<{width: number, height: number}|null>} 源画幅尺寸，或 null。
 */
async function frameSize(input, call) {
  try {
    const read = await readPixels({ input, at: call.at, config: call.config, maxSide: GEOMETRY_MAX_SIDE })
    return { width: read.sourceWidth, height: read.sourceHeight }
  } catch {
    return null
  }
}

/**
 * 裁一块区域出来（需要的话同时放大），作为识别器真正要读的图。
 *
 * 裁剪和放大合成一次 ffmpeg 调用，尺寸在这里算好、显式传给 ffmpeg，和 `image.mjs` 的做法一致：
 * 让 ffmpeg 自己取整，返回的框就会以没人看得出来的方式偏掉。
 *
 * @param {object} request - `{ input, region, scale, at, config }`。
 * @returns {Promise<{path: string, region: object, factor: number, elapsedMs: number}>} 临时图、生效的区域，和把框乘回源帧的倍数。
 * @throws {import('./ffmpeg.mjs').MediaError} ffmpeg 失败时。
 */
async function cropForOcr(request) {
  const region = {
    x: request.region.x,
    y: request.region.y,
    width: even(request.region.width),
    height: even(request.region.height),
  }
  const readWidth = even(region.width * request.scale)
  const readHeight = even(region.height * request.scale)
  const target = join(OCR_TMP_DIR, `crop-${randomBytes(4).toString('hex')}.png`)
  mkdirSync(OCR_TMP_DIR, { recursive: true })

  const filter = readWidth === region.width && readHeight === region.height
    ? `crop=${region.width}:${region.height}:${region.x}:${region.y}`
    : `crop=${region.width}:${region.height}:${region.x}:${region.y},scale=${readWidth}:${readHeight}`

  const args = []
  if (Number.isFinite(request.at) && request.at > 0) args.push('-ss', Number(request.at).toFixed(3))
  args.push('-i', request.input, '-vf', filter, '-frames:v', '1', '-update', '1', target)
  const started = Date.now()
  await runFfmpeg(args, { config: request.config, timeoutMs: 120_000, label: 'OCR 裁剪区域' })

  return {
    path: target,
    region,
    // 裁剪图比区域大就乘小，比区域小就乘大——方向由 scaleFactor 决定，这里不另立一套规则。
    factor: scaleFactor({
      sourceWidth: region.width,
      sourceHeight: region.height,
      readWidth,
      readHeight,
    }),
    elapsedMs: Date.now() - started,
  }
}

/**
 * 从后往前找 stdout 里最后一行 JSON 并解析。
 *
 * @param {string|Buffer|undefined} stdout - 子进程的输出。
 * @returns {object|null} 解析出来的对象，或 null。
 */
function parseJsonLine(stdout) {
  if (stdout === undefined || stdout === null) return null
  const text = Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout)
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (!line.startsWith('{')) continue
    try {
      return JSON.parse(line)
    } catch {
      // 不是 JSON 的行就继续往前找：脚本只保证最后一行是。
    }
  }
  return null
}

/**
 * 跑一次 `src/bin/winrt-ocr.ps1`，拿到它那份 JSON。
 *
 * 脚本自己 catch 一切，失败时 stdout 上是一个 `{ ok: false, error }` 对象并以非零码退出。所以这里
 * **先看 stdout、再看退出码**：把 PowerShell 的栈错误原样抛给调用方，等于把「脚本坏了」和
 * 「这张图没有文字」混成一件事。
 *
 * @param {object} request - `{ input, language, scale }`。
 * @returns {Promise<object>} 脚本的 JSON 对象（`ok: true`）。
 * @throws {OcrError} 脚本报错、输出不是 JSON、或进程根本起不来时。
 */
async function runWinrt(request) {
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WINRT_SCRIPT, '-Path', request.input, '-Language', request.language]
  if (request.scale > 1) args.push('-Scale', String(request.scale))

  let stdout = ''
  try {
    const result = await run('powershell.exe', args, { timeout: 180_000, windowsHide: true, maxBuffer: 32 << 20 })
    stdout = result.stdout
  } catch (error) {
    const reported = parseJsonLine(error?.stdout)
    if (reported !== null && reported.ok === false) throw new OcrError(`Windows 识别失败：${reported.error}`)
    const detail = typeof error?.stderr === 'string' && error.stderr.trim() !== ''
      ? error.stderr.trim().split('\n').slice(-4).join('\n')
      : String(error?.message ?? error)
    throw new OcrError(`Windows 识别失败（脚本没能给出 JSON 结果）：${detail}`)
  }

  const parsed = parseJsonLine(stdout)
  if (parsed === null) {
    throw new OcrError(`Windows 识别的输出不是 JSON：${String(stdout).trim().slice(-300)}`)
  }
  if (parsed.ok !== true) {
    throw new OcrError(`Windows 识别失败：${parsed.error ?? '脚本没有说明原因'}`)
  }
  // 一行结果被序列化成对象而不是数组，是会静默丢掉唯一一行的那类差异；这里补齐，不留这个口子。
  if (parsed.lines !== undefined && parsed.lines !== null && !Array.isArray(parsed.lines)) parsed.lines = [parsed.lines]
  return parsed
}

/**
 * 读一张图、或一段视频的某一秒。
 *
 * 提供者按 `config.ocr.provider`（可用 `options.provider` 覆盖）选：`sibling` 只走同级、`winrt`
 * 只走 Windows、`auto` 先同级后 Windows、`off` 直接抛错。返回的每一行都在**源帧像素**坐标下。
 *
 * @param {string} path - 要读的图片或视频。
 * @param {object} [options] - 这次调用。
 * @param {object} [options.config] - 规范化后的插件配置。
 * @param {string} [options.provider] - 覆盖配置里的提供者，用于「这次就指定用谁」。
 * @param {string} [options.language] - 语言短名或标签；默认用配置里的。
 * @param {number|'auto'} [options.scale] - 放大倍数 1–3，或 `'auto'`。
 * @param {number} [options.at] - 视频的第几秒；图片忽略。
 * @param {object|string} [options.region] - 只读这一块，`{x, y, width, height}` 或 `"x,y,w,h"`。
 * @param {number} [options.minConfidence] - 丢掉置信度低于它的行；没有置信度的行一律保留。
 * @returns {Promise<{engine: string, provider: 'sibling'|'winrt', language: string, text: string, lines: object[], lineCount: number, elapsedMs: number, notes: string[], scale: number}>} 这一次的读数。
 * @throws {OcrError} 输入不存在、提供者不可用、或读不出来时。
 */
export async function ocrImage(path, options = {}) {
  const config = options.config ?? {}
  const ocr = config?.ocr ?? {}
  const requested = normaliseProvider(options.provider ?? ocr.provider)
  const language = languageTag(options.language ?? ocr.language)
  const minConfidence = Number.isFinite(options.minConfidence) ? Number(options.minConfidence) : null
  const at = Number.isFinite(options.at) ? Number(options.at) : undefined
  const notes = []
  const started = Date.now()

  if (requested === 'off') {
    throw new OcrError('配置里关掉了文字识别（ocr.provider = "off"）：这一步不读任何文字。')
  }
  if (typeof path !== 'string' || path.trim() === '' || !existsSync(path)) {
    throw new OcrError(`要识别的文件不存在：${path}`)
  }

  const region = parseRegion(options.region)
  const requestedScale = options.scale ?? ocr.scale ?? 1

  // ---------------------------------------------------------------- 选提供者
  const winrt = winrtState()
  let sibling = null
  let engine = null
  let failure = null
  if (requested !== 'winrt') {
    const lookup = await siblingLookup(config)
    sibling = lookup.module
    failure = lookup.failure
    engine = siblingEngine(sibling)
  }

  if (requested === 'sibling' && (sibling === null || engine === null)) {
    const roots = siblingOcrRoots(config)
    const reason = sibling === null
      ? `配置要求用同级 dsh-ocr，但 ${roots.join(' / ')} 里都没有可加载的 dsh-ocr。${failure === null ? '' : `（${failure.root} 在，但 import 失败：${failure.message}）`}`
      : `同级 dsh-ocr 在 ${sibling.root}，但里面没有可用的离线引擎。`
    throw new OcrError(`${reason}\n${INSTALL_HINT}`, { provider: 'sibling', roots })
  }
  if (requested === 'winrt' && !winrt.available) {
    throw new OcrError(`配置要求用 Windows 自带识别，但它不可用：${winrt.reason}`, { provider: 'winrt' })
  }

  const chosen = requested === 'sibling' || (requested === 'auto' && engine !== null) ? 'sibling' : 'winrt'
  if (requested === 'auto' && chosen === 'winrt') {
    notes.push(
      sibling === null
        ? '没有找到同级 dsh-ocr，用 Windows 自带识别（小字更容易读错）。'
        : '同级 dsh-ocr 没有可用引擎，用 Windows 自带识别（小字更容易读错）。',
    )
  }
  if (chosen === 'winrt' && !winrt.available) {
    throw new OcrError(`没有可用的文字识别：${winrt.reason}\n${INSTALL_HINT}`, { provider: null })
  }

  // ---------------------------------------------------------------- 放大倍数
  let scale
  if (requestedScale === 'auto') {
    let dimensions = region === null ? null : { width: region.width, height: region.height }
    if (dimensions === null) {
      dimensions = await frameSize(path, { at, config })
      if (dimensions === null) {
        notes.push('读不出画幅尺寸，scale:"auto" 按 1 处理。')
        dimensions = { width: 0, height: 0 }
      }
    }
    scale = resolveScale('auto', dimensions)
  } else {
    scale = resolveScale(requestedScale)
  }

  // ---------------------------------------------------------------- 同级 dsh-ocr
  if (chosen === 'sibling') {
    let reading
    try {
      reading = await sibling.module.recogniseImage(path, {
        // 同级插件用它自己的配置与自己的 ffmpeg：本插件的 config 形状对它没有意义。
        config: {},
        region: region ?? undefined,
        scale,
        language,
        minScore: minConfidence ?? undefined,
      })
    } catch (error) {
      // 同级插件抛的是它自己的错误类；对调用方来说这只是「这一步没读成」，所以换成 OcrError，
      // 但把它说的话原样带上——那句话通常就是修法（比如去装引擎）。
      throw new OcrError(`同级 dsh-ocr 读不了这张图：${error instanceof Error ? error.message : String(error)}`, {
        provider: 'sibling',
        cause: error,
      })
    }
    // 同级插件已经自己裁剪、并把偏移与倍数除回源帧了，所以这里只做规整与筛选：再乘一次就偏了。
    const lines = mapLines(reading?.lines ?? [], { factor: 1, minConfidence })
    return {
      engine: `dsh-ocr:${reading?.engine ?? engine.kind}${engine.source === null ? '' : `@${engine.source}`}`,
      provider: 'sibling',
      language,
      text: lines.map((line) => line.text).join('\n'),
      lines,
      lineCount: lines.length,
      elapsedMs: Date.now() - started,
      notes,
      scale,
    }
  }

  // ---------------------------------------------------------------- Windows 自带识别
  notes.push('Windows 自带识别：小字与中英混排容易读错，只当线索，不要当精确数据。')
  notes.push('Windows 的识别器不提供逐行置信度，confidence 一律是 null。')
  notes.push('Windows 把汉字拆成一个字一个词，识别出的中文里会多出空格；拿去做匹配前先去空白。')

  let input = path
  let factor = 1
  let offsetX = 0
  let offsetY = 0
  let scriptScale = scale
  let temporary = null

  if (region !== null) {
    try {
      const crop = await cropForOcr({ input: path, region, scale, at, config })
      input = crop.path
      temporary = crop.path
      factor = crop.factor
      offsetX = crop.region.x
      offsetY = crop.region.y
      // 放大已经在 ffmpeg 那一步做过了，再让脚本放一次就是两次。
      scriptScale = 1
    } catch (error) {
      notes.push(`裁剪区域失败（${error instanceof Error ? error.message.split('\n')[0] : String(error)}），改为整帧识别再按区域过滤。`)
    }
  }

  try {
    const parsed = await runWinrt({ input, language, scale: scriptScale })
    // 裁剪成功时 region 过滤是多余的（框本来就在区域里），裁剪失败时它是唯一的把关——
    // 两种情况共用同一行，因为一行算术好过两条分支。
    const lines = mapLines(parsed.lines ?? [], { factor, offsetX, offsetY, region, minConfidence })
    return {
      engine: `windows-ocr:${parsed.language ?? language}`,
      provider: 'winrt',
      language,
      text: lines.map((line) => line.text).join('\n'),
      lines,
      lineCount: lines.length,
      elapsedMs: Date.now() - started,
      notes,
      // 两条 Windows 路径的放大倍数都是这个整数：要么脚本做的，要么上面那次裁剪做的。
      scale,
    }
  } finally {
    if (temporary !== null) {
      rmSync(temporary, { force: true })
      try {
        // 空的临时目录留着没有意义；非空（并发调用正用着）就当没这回事。
        rmSync(dirname(temporary), { recursive: false })
      } catch {
        // 见上。
      }
    }
  }
}
