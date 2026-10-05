/**
 * 时间轴：一次解码，把录屏切成「屏幕上换了一件事」的若干段。
 *
 * 为什么是一个流式状态机，而不是一个滤镜图或一次全量读帧：一段一小时的录屏，按默认节奏也有
 * 一万四千帧。把帧留下来再统一算分，等于把录像读进内存；这里只保留**上一帧**和**当前段的累加
 * 器**，内存与录像长度无关。因此 `detectScenes` 用 `runFfmpeg` 的 `onStdoutChunk` 边解边判，
 * 再把切点交给纯函数 `mergeSegments` 收尾。
 *
 * 判定只有三条规则，按顺序：
 *
 * 1. 帧间平均绝对亮度差 ≥ `sceneThreshold`，且当前段已经满 `minSegmentSec` → 在这里开一段新的；
 * 2. 当前段超过 `maxSegmentSec` → 按 `cadence` 断开（静止一小时也必须能被人指着说「从这到那」）；
 * 3. 不到 `minSegmentSec` 的段不被允许结束：它继续长，把后面的帧吃进来，于是不会出现一个
 *    「自己成段」的碎段。
 *
 * `reason` 说的是**这一段为什么开始**，四种取值各有各的实测依据：
 *
 * - `start`：文件（或分析范围）的第一段，`sceneScore` 恒为 0；
 * - `scene_change`：一帧之间的变化越过 `sceneThreshold`，屏幕确实换了一件事；
 * - `motion`：同样越过了 `sceneThreshold`，但**本段内**此前已经连续 `motionRunFrames` 帧都超过
 *   `motionThreshold`（= `sceneThreshold / 3`）。屏幕一直在动，这个越线只是运动的波峰，把它叫
 *   `scene_change` 会高估「换了一件事」。代价写在明处：真正发生在剧烈动画里的硬切也会被记成
 *   `motion` —— 宁可说「一直在动」，不要谎称「一次切换」；
 * - `cadence`：为了可导航而断开，不是屏幕变了。
 *
 * 数值一律保留 4 位小数，并且**判定用的是取整后的同一个数**：报告里的 `sceneScore` 与当时参与
 * 比较的那个值不可能不一致，`mergeSegments` 也就没有第二套算术。
 *
 * 本模块不写任何文件：`detectScenes` 只回报数据，产物归调用方。
 *
 * @module dsh-screen-recorder/core/timeline
 */
import { existsSync } from 'node:fs'
import { MediaError, runFfmpeg } from './ffmpeg.mjs'
import { DEFAULT_MAX_SIDE, probeAnalysisSize } from './segmentation.mjs'

/** 时间轴的默认值。与 `src/core/analysis.mjs` 的 `ANALYSIS_DEFAULTS`、`cordis.patch.yml` 镜像。 */
export const TIMELINE_DEFAULTS = Object.freeze({
  /** 打开新一段的帧间平均绝对亮度差（0–255）。 */
  sceneThreshold: 8,
  /** 一段短于此值就不允许被切开，只能继续长。 */
  minSegmentSec: 1,
  /** 一段长于此值就按 cadence 断开。 */
  maxSegmentSec: 30,
  /** 短于此值的段并入前一段（报告的粒度问题，与切点是否合法无关）。 */
  mergeShortSec: 0.7,
  /** 分析节奏：每秒取几帧。 */
  fps: 4,
  /** 分析帧的长边像素数。 */
  maxSide: DEFAULT_MAX_SIDE,
  /** 报告的分段数硬上限。 */
  maxSegments: 400,
  /** 运动阈值相对切点阈值的比例。 */
  motionThresholdRatio: 1 / 3,
  /** 连续多少帧超过运动阈值，才把一次越线记成 motion 而不是 scene_change。 */
  motionRunFrames: 3,
})

/** 一段可能以哪些理由开始。没有 `end`：最后一段不是因为「结束」才成为一段。 */
export const SEGMENT_REASONS = Object.freeze(['start', 'scene_change', 'motion', 'cadence'])

/** 进度回调的节流粒度：每分析这么多秒的素材回调一次。 */
export const PROGRESS_EVERY_SEC = 2

/** `notes` 最多几句：报告长度是契约的一部分。 */
export const MAX_NOTES = 4

/**
 * 四舍五入到 4 位小数。
 * @param {number} value - 原始数值。
 * @returns {number} 报告与判定共用的那个数。
 */
function round4(value) {
  return Math.round(value * 10000) / 10000
}

/**
 * 取一个有限数，否则用默认值。
 * @param {*} value - 候选值。
 * @param {number} fallback - 默认值。
 * @returns {number} 结果。
 */
function numberOr(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

/**
 * 取一个不小于下限的有限数。
 * @param {*} value - 候选值。
 * @param {number} fallback - 默认值。
 * @param {number} min - 下限。
 * @returns {number} 结果。
 */
function clampedOr(value, fallback, min) {
  return Math.max(min, numberOr(value, fallback))
}

/**
 * 两个灰度帧之间的平均绝对亮度差 —— 判定切点的唯一数值。
 *
 * 单通道，逐字节比较：分析帧已经被解码成 gray，所以这里不需要再做色彩空间转换，也不应该做 ——
 * 一个只由亮度决定的切点，反过来可以用两帧灰度图直接复算。
 *
 * @param {Uint8Array} previous - 上一帧，`宽 × 高` 字节。
 * @param {Uint8Array} current - 这一帧，同样大小。
 * @returns {number} 0–255 的平均绝对差，4 位小数。
 */
export function lumaDifference(previous, current) {
  const length = Math.min(previous.length, current.length)
  if (length === 0) return 0
  let sum = 0
  for (let offset = 0; offset < length; offset += 1) {
    const difference = current[offset] - previous[offset]
    sum += difference < 0 ? -difference : difference
  }
  return round4(sum / length)
}

/**
 * 把 stdout 的字节流重新拼成一个个完整的帧。
 *
 * 单独一个类，是因为「一个帧被拆在两次 chunk 之间」是这个解码方式唯一的、也最容易写错的地方：
 * 剩下的半个帧必须留到下一次，且**只**在够一整帧时才交出去。补上这个纯粹的拼装器，
 * 就能不碰 ffmpeg 直接测它。
 */
export class FrameSplitter {
  /** @type {number} */
  #frameBytes
  /** @type {Buffer} */
  #remainder

  /**
   * @param {number} frameBytes - 一个完整帧的字节数，必须为正整数。
   */
  constructor(frameBytes) {
    if (!Number.isInteger(frameBytes) || frameBytes <= 0) {
      throw new TypeError(`FrameSplitter 需要正整数 frameBytes，收到 ${JSON.stringify(frameBytes)}`)
    }
    this.#frameBytes = frameBytes
    this.#remainder = Buffer.alloc(0)
  }

  /** @returns {number} 一个完整帧的字节数。 */
  get frameBytes() {
    return this.#frameBytes
  }

  /** @returns {number} 还没凑成一帧、被留到下一次的字节数。 */
  get remainderBytes() {
    return this.#remainder.length
  }

  /**
   * 喂一段字节，取出其中所有完整帧。
   *
   * 返回的是底层缓冲的视图，不再复制一遍：分析只读它一次，复制只会让一小时的素材多走一遍内存。
   *
   * @param {Buffer|Uint8Array} chunk - 从 stdout 收到的字节。
   * @returns {Uint8Array[]} 这次凑齐的完整帧，按顺序。
   */
  push(chunk) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    const pending = this.#remainder.length === 0 ? buffer : Buffer.concat([this.#remainder, buffer])
    const frames = []
    let offset = 0
    while (offset + this.#frameBytes <= pending.length) {
      frames.push(pending.subarray(offset, offset + this.#frameBytes))
      offset += this.#frameBytes
    }
    // 剩下的不足一帧：留着。整段都已交出时换成空缓冲，避免因为一个视图而拖住整个 chunk。
    this.#remainder = offset === pending.length ? Buffer.alloc(0) : pending.subarray(offset)
    return frames
  }
}

/**
 * 逐帧读取切点的状态机。
 *
 * 只保留当前段的累加器，所以无论录屏多久，占用的内存都一样。`push` 返回刚刚闭合的那一段
 * （没有闭合就返回 null），`finish` 把最后一段按给定的结束时间封口。
 */
export class SegmentBuilder {
  /**
   * @param {object} [options] - 阈值。
   * @param {number} [options.sceneThreshold] - 切点阈值。
   * @param {number} [options.minSegmentSec] - 最短段；不到就不许结束。
   * @param {number} [options.maxSegmentSec] - 最长段；到了就按 cadence 断开。
   * @param {number} [options.motionThreshold] - 运动阈值；默认 `sceneThreshold / 3`。
   * @param {number} [options.motionRunFrames] - 连续多少帧超过运动阈值才算 motion。
   */
  constructor(options = {}) {
    this.sceneThreshold = clampedOr(options.sceneThreshold, TIMELINE_DEFAULTS.sceneThreshold, 0)
    this.minSegmentSec = clampedOr(options.minSegmentSec, TIMELINE_DEFAULTS.minSegmentSec, 0)
    this.maxSegmentSec = clampedOr(options.maxSegmentSec, TIMELINE_DEFAULTS.maxSegmentSec, 0)
    this.motionThreshold = clampedOr(
      options.motionThreshold,
      round4(this.sceneThreshold * TIMELINE_DEFAULTS.motionThresholdRatio),
      0,
    )
    this.motionRunFrames = Math.max(1, Math.floor(clampedOr(options.motionRunFrames, TIMELINE_DEFAULTS.motionRunFrames, 1)))
    /** @type {object[]} 已经闭合的原始段。 */
    this.segments = []
    /** @type {object|null} 当前打开的一段。 */
    this.open = null
    /** @type {number} 已经喂进来的帧数。 */
    this.frames = 0
    /** @type {number} 本段内连续超过运动阈值的帧数。 */
    this.motionRun = 0
  }

  /**
   * 喂一帧。
   *
   * `difference` 是**这一帧相对上一帧**的平均绝对亮度差：它要么成为新一段的 `sceneScore`，
   * 要么作为运动被当前段记录；它永远不会同时算进两段。第一帧传 0。
   *
   * @param {number} timeSec - 这一帧的时间。
   * @param {number} difference - 与上一帧的平均绝对亮度差。
   * @returns {object|null} 刚刚闭合的原始段，若有。
   */
  push(timeSec, difference) {
    const time = numberOr(timeSec, 0)
    const change = numberOr(difference, 0)
    this.frames += 1

    if (this.open === null) {
      this.open = this.#open(time, 'start', 0)
      this.motionRun = change >= this.motionThreshold ? 1 : 0
      return null
    }

    // 规则 1：越线且当前段已经够长，才允许结束它。两条都要满足，顺序也有意义。
    if (change >= this.sceneThreshold && time - this.open.start >= this.minSegmentSec) {
      const reason = this.motionRun >= this.motionRunFrames ? 'motion' : 'scene_change'
      const closed = this.#close(time)
      this.open = this.#open(time, reason, change)
      this.motionRun = change >= this.motionThreshold ? 1 : 0
      return closed
    }

    // 规则 3：没被切开，这一帧的变化就是本段的运动证据。
    this.#observe(change)
    this.motionRun = change >= this.motionThreshold ? this.motionRun + 1 : 0

    // 规则 2：一段不能无限长，否则一段静止一小时的东西没人能导航。
    if (time - this.open.start >= this.maxSegmentSec) {
      const closed = this.#close(time)
      this.open = this.#open(time, 'cadence', change)
      this.motionRun = change >= this.motionThreshold ? 1 : 0
      return closed
    }
    return null
  }

  /**
   * 按给定的结束时间封口，交出全部原始段。
   *
   * @param {number} endSec - 文件或分析范围的结束时间。
   * @returns {object[]} 原始段，按时间排序、首尾相接。
   */
  finish(endSec) {
    if (this.open !== null) {
      const end = Math.max(numberOr(endSec, this.open.start), this.open.start)
      this.#close(end)
      this.open = null
    }
    return [...this.segments]
  }

  /**
   * 开一段。
   * @param {number} start - 开始时间。
   * @param {string} reason - 为什么开始。
   * @param {number} sceneScore - 开启它的那个帧差。
   * @returns {object} 累加器。
   */
  #open(start, reason, sceneScore) {
    return { start, reason, sceneScore, diffSum: 0, samples: 0, diffMax: 0 }
  }

  /**
   * 记一次段内运动。
   * @param {number} change - 这一帧的变化量。
   * @returns {void}
   */
  #observe(change) {
    this.open.diffSum += change
    this.open.samples += 1
    if (change > this.open.diffMax) this.open.diffMax = change
  }

  /**
   * 闭合当前段并记录下来。
   *
   * 记录发生在这里而不是交给调用方，是因为「调用方忘了收」看起来和「录屏里只有一段」一模一样，
   * 而这种 bug 没人能从结果里看出来。
   *
   * @param {number} end - 结束时间。
   * @returns {object} 闭合的原始段。
   */
  #close(end) {
    const closed = { ...this.open, end: Math.max(end, this.open.start) }
    this.segments.push(closed)
    return closed
  }
}

/**
 * 把原始段合并成对外的时间轴 —— 只做合并，从不发明切点。
 *
 * 合并有两个方向，各有各的理由，都写在这里因为方向不同最容易读错：
 *
 * - **向后长**（`minSegmentSec`）：一段不到最短长度就不允许结束，于是它把紧接着的那一段吃进来，
 *   并保留自己的起点与理由。这正是 `SegmentBuilder` 在流式判定里做的事，这里只是把同一条规则
 *   再对一份「已经切好的」清单应用一次 —— 否则一份外部传入的切点清单能造出协议不允许的碎段。
 * - **并入前一段**（`max(minSegmentSec, mergeShortSec)`）：一段短到这个下限，就并进前一段，保留
 *   前一段的起点与理由。取两者较大者，是因为两条规则都要成立：不到 `minSegmentSec` 的段本来
 *   就不该单独存在（向后长是它的正常归宿，但一份外部清单里它后面可能已经没有帧可吃，于是只能
 *   并给前一段），而不到 `mergeShortSec` 的段不值得单独报出。于是除第一段外，没有任何一段短于
 *   这个下限 —— 唯一的例外是下面那条 `maxSegmentSec` 拦截。
 *
 * `maxSegmentSec` 在这里不是用来切分的（没有帧数据就没法切，硬切等于编造一个边界），而是用来
 * **拦住合并**：如果并进来会让前一段超过 cadence 上限，那么这段短段就保留下来。
 *
 * `maxSegments` 到顶时，保留前 `maxSegments - 1` 段，**其余全部并进最后一段**：时间轴仍然覆盖
 * 整段录屏，不会因为封顶而悄悄丢掉尾巴。调用方若要知道上限是否生效，比较自己的原始段数与
 * `maxSegments` 即可（原始段数 > 上限 ⇔ 封顶生效）。
 *
 * @param {object[]} rawSegments - 原始段，含 `{start, end, reason, sceneScore, diffSum, samples}`。
 * @param {object} [options] - `{minSegmentSec, mergeShortSec, maxSegmentSec, maxSegments}`。
 * @returns {object[]} 最终分段，1 起编号，时间与运动都保留 4 位小数；另带 `mergedCount` 与
 *   `samples`，让调用方能核对每一段是几段并出来的、用了多少帧的运动证据。
 */
export function mergeSegments(rawSegments, options = {}) {
  const minSegmentSec = clampedOr(options.minSegmentSec, TIMELINE_DEFAULTS.minSegmentSec, 0)
  const mergeShortSec = clampedOr(options.mergeShortSec, TIMELINE_DEFAULTS.mergeShortSec, 0)
  const maxSegmentSec = clampedOr(options.maxSegmentSec, TIMELINE_DEFAULTS.maxSegmentSec, 0)
  const maxSegments = Math.max(1, Math.floor(clampedOr(options.maxSegments, TIMELINE_DEFAULTS.maxSegments, 1)))
  const floor = Math.max(minSegmentSec, mergeShortSec)

  const ordered = (Array.isArray(rawSegments) ? rawSegments : [])
    .filter((segment) => segment !== null && typeof segment === 'object')
    .map((segment) => ({
      start: numberOr(segment.start, 0),
      end: numberOr(segment.end, 0),
      reason: typeof segment.reason === 'string' && segment.reason !== '' ? segment.reason : 'start',
      sceneScore: numberOr(segment.sceneScore, 0),
      diffSum: numberOr(segment.diffSum, 0),
      samples: Math.max(0, Math.floor(numberOr(segment.samples, 0))),
      mergedCount: Math.max(1, Math.floor(numberOr(segment.mergedCount, 1))),
    }))
    .filter((segment) => segment.end > segment.start)

  // 第一遍：不到 minSegmentSec 的段不被允许结束，向后吞下紧接着的那一段。
  const grown = []
  let current = null
  for (const segment of ordered) {
    if (current === null) {
      current = segment
      continue
    }
    if (current.end - current.start < minSegmentSec) {
      current = pool(current, segment)
      continue
    }
    grown.push(current)
    current = segment
  }
  if (current !== null) grown.push(current)

  // 第二遍：短于下限（minSegmentSec 与 mergeShortSec 取大）的段并进前一段 —— 但绝不因此把关口推过 maxSegmentSec。
  const kept = []
  for (const segment of grown) {
    const previous = kept[kept.length - 1]
    const length = segment.end - segment.start
    const merged = previous === undefined ? null : previous.end - previous.start + length
    if (previous !== undefined && length < floor && merged <= maxSegmentSec) {
      kept[kept.length - 1] = pool(previous, segment)
      continue
    }
    kept.push(segment)
  }

  // 第三遍：封顶，剩下的并进最后一段，尾巴不丢。
  const capped = kept.length <= maxSegments
    ? kept
    : [...kept.slice(0, maxSegments - 1), kept.slice(maxSegments - 1).reduce((base, segment) => pool(base, segment))]

  return capped.map((segment, index) => ({
    index: index + 1,
    start: round4(segment.start),
    end: round4(segment.end),
    seconds: round4(segment.end - segment.start),
    reason: segment.reason,
    sceneScore: round4(segment.sceneScore),
    motion: segment.samples > 0 ? round4(segment.diffSum / segment.samples) : 0,
    mergedCount: segment.mergedCount,
    samples: segment.samples,
  }))
}

/**
 * 把一段并进另一段：起点与理由归 `base`，时间、运动与计数累加。
 *
 * @param {object} base - 保留起点与理由的那一段。
 * @param {object} extra - 被并进来的那一段。
 * @returns {object} 合并后的段。
 */
function pool(base, extra) {
  return {
    start: base.start,
    end: Math.max(base.end, extra.end),
    reason: base.reason,
    sceneScore: base.sceneScore,
    diffSum: base.diffSum + extra.diffSum,
    samples: base.samples + extra.samples,
    mergedCount: base.mergedCount + extra.mergedCount,
  }
}

/**
 * 分析一段录屏，回答「屏幕上有几件事、各从第几秒到第几秒」。
 *
 * 只解码一遍，只按小尺寸解码，不写任何文件。时间戳是**源文件里的绝对时间**：给了 `startSec`
 * 时第一帧的时间就是 `startSec`，而 `durationSec` 是这次实际分析到的长度。
 *
 * 与格式说明的一处偏差，写在这里因为它是刻意的：解码用的是
 * `scale=<偶数宽>:<偶数高>`，而不是 `scale=<maxSide>:-2`。原始帧没有帧头，只有知道每帧的字节数
 * 才能把 stdout 重新拼成帧，而 `-2` 让高度由源画面决定，调用方事先无法知道 —— 所以先探测一次
 * 源尺寸，再显式给出两个偶数。长边不会被放大：源比 `maxSide` 小时按原样分析。
 *
 * @param {object} request - 这次分析。
 * @param {string} request.input - 要分析的视频路径。
 * @param {object} [request.config] - 归一化后的插件配置，原样交给 ffmpeg 层。
 * @param {number} [request.fps] - 分析节奏，每秒取几帧。
 * @param {number} [request.maxSide] - 分析帧长边像素数。
 * @param {number} [request.sceneThreshold] - 切点阈值。
 * @param {number} [request.minSegmentSec] - 最短段。
 * @param {number} [request.maxSegmentSec] - 最长段。
 * @param {number} [request.mergeShortSec] - 短于此值的段并入前一段。
 * @param {number} [request.maxSegments] - 分段数上限。
 * @param {number} [request.motionThreshold] - 运动阈值；默认 `sceneThreshold / 3`。
 * @param {number} [request.motionRunFrames] - 连续多少帧超过运动阈值才算 motion。
 * @param {number} [request.startSec] - 从第几秒开始分析。
 * @param {number} [request.durationSec] - 最多分析多少秒；0 或省略表示到文件结束。
 * @param {number} [request.timeoutMs] - 解码的截止时间；长素材需要显式给大一点。
 * @param {(progress: {frames: number, durationSec: number, elapsedMs: number}) => void} [request.onProgress] - 进度观察者；它抛出的异常会被忽略，因为观察者不该打断解码。
 * @returns {Promise<object>} 分段、帧尺寸、帧数与 notes。
 * @throws {MediaError} 输入不存在、没有视频流、ffmpeg 失败或超时。
 */
export async function detectScenes(request = {}) {
  const started = Date.now()
  const input = typeof request.input === 'string' ? request.input : ''
  if (input === '') throw new MediaError('detectScenes 需要一个 input 路径')
  if (!existsSync(input)) throw new MediaError(`要分析的输入文件不存在：${input}`)

  const config = request.config ?? {}
  const fps = clampedOr(request.fps, TIMELINE_DEFAULTS.fps, 0.01)
  const maxSide = Math.max(2, Math.floor(clampedOr(request.maxSide, TIMELINE_DEFAULTS.maxSide, 2)))
  const sceneThreshold = clampedOr(request.sceneThreshold, TIMELINE_DEFAULTS.sceneThreshold, 0)
  const minSegmentSec = clampedOr(request.minSegmentSec, TIMELINE_DEFAULTS.minSegmentSec, 0)
  const maxSegmentSec = clampedOr(request.maxSegmentSec, TIMELINE_DEFAULTS.maxSegmentSec, 0)
  const mergeShortSec = clampedOr(request.mergeShortSec, TIMELINE_DEFAULTS.mergeShortSec, 0)
  const maxSegments = Math.max(1, Math.floor(clampedOr(request.maxSegments, TIMELINE_DEFAULTS.maxSegments, 1)))
  const motionRunFrames = Math.max(1, Math.floor(clampedOr(request.motionRunFrames, TIMELINE_DEFAULTS.motionRunFrames, 1)))
  const motionThreshold = clampedOr(
    request.motionThreshold,
    round4(sceneThreshold * TIMELINE_DEFAULTS.motionThresholdRatio),
    0,
  )
  const startSec = Math.max(0, numberOr(request.startSec, 0))
  const durationSec = Math.max(0, numberOr(request.durationSec, 0))
  const onProgress = typeof request.onProgress === 'function' ? request.onProgress : null

  const frame = await probeAnalysisSize(input, { config, maxSide })
  const args = ['-v', 'error']
  if (startSec > 0) args.push('-ss', String(startSec))
  if (durationSec > 0) args.push('-t', String(durationSec))
  args.push(
    '-i', input,
    '-an', '-sn', '-dn',
    '-vf', `fps=${fps},scale=${frame.width}:${frame.height}:flags=bilinear`,
    '-pix_fmt', 'gray',
    '-f', 'rawvideo', '-',
  )

  const splitter = new FrameSplitter(frame.width * frame.height)
  const builder = new SegmentBuilder({ sceneThreshold, minSegmentSec, maxSegmentSec, motionThreshold, motionRunFrames })
  const progressEvery = Math.max(1, Math.round(fps * PROGRESS_EVERY_SEC))
  let previous = null
  let frames = 0

  const handleFrame = (buffer) => {
    // 第一帧没有上一帧可比，帧差记为 0：它开的那一段就是 'start'，不是任何阈值判出来的。
    const difference = previous === null ? 0 : lumaDifference(previous, buffer)
    previous = buffer
    builder.push(startSec + frames / fps, difference)
    frames += 1
    if (onProgress !== null && frames % progressEvery === 0) {
      emitProgress(onProgress, { frames, durationSec: round4(frames / fps), elapsedMs: Date.now() - started })
    }
  }

  await runFfmpeg(args, {
    config,
    label: `timeline ${input}`,
    ...(Number.isFinite(request.timeoutMs) ? { timeoutMs: request.timeoutMs } : {}),
    onStdoutChunk: (chunk) => {
      for (const frameBuffer of splitter.push(chunk)) handleFrame(frameBuffer)
    },
  })

  const analysedSec = round4(frames / fps)
  const raw = builder.finish(startSec + analysedSec)
  const merged = mergeSegments(raw, { minSegmentSec, mergeShortSec, maxSegmentSec, maxSegments })
  if (onProgress !== null) emitProgress(onProgress, { frames, durationSec: analysedSec, elapsedMs: Date.now() - started })

  return {
    input,
    durationSec: analysedSec,
    fps,
    maxSide,
    frameWidth: frame.width,
    frameHeight: frame.height,
    framesAnalysed: frames,
    segments: merged.map(({ index, start, end, seconds, reason, sceneScore, motion }) => ({
      index,
      start,
      end,
      seconds,
      reason,
      sceneScore,
      motion,
    })),
    notes: buildNotes({
      frames,
      analysedSec,
      startSec,
      minSegmentSec,
      leftoverBytes: splitter.remainderBytes,
      rawCount: raw.length,
      maxSegments,
    }),
    elapsedMs: Date.now() - started,
  }
}

/**
 * 把一段进度交给观察者，观察者出错不算解码出错。
 * @param {Function} onProgress - 观察者。
 * @param {object} progress - 进度。
 * @returns {void}
 */
function emitProgress(onProgress, progress) {
  try {
    onProgress(progress)
  } catch {
    // 进度是观察，不是契约的一部分：它抛异常不能把一次已经跑完的解码变成失败。
  }
}

/**
 * 写 notes：只说这次**测到了什么**，至多 {@link MAX_NOTES} 句。
 * @param {object} facts - 这次分析的实测数字。
 * @returns {string[]} 中文短句。
 */
function buildNotes(facts) {
  const notes = []
  if (facts.frames === 0) notes.push('没有解码到任何帧：输入可能没有视频流，或 -ss/-t 指定的范围落在文件之外。')
  if (facts.leftoverBytes > 0) notes.push(`末尾 ${facts.leftoverBytes} 字节不足一帧，已忽略：最后一帧不完整。`)
  if (facts.rawCount > facts.maxSegments) {
    notes.push(`原始分段 ${facts.rawCount} 段超过上限 ${facts.maxSegments}，尾部已并入最后一段。`)
  }
  if (facts.startSec > 0) notes.push(`从 ${facts.startSec}s 开始分析，共 ${facts.frames} 帧、${facts.analysedSec}s。`)
  if (facts.frames > 0 && facts.analysedSec < facts.minSegmentSec) {
    notes.push(`分析范围只有 ${facts.analysedSec}s，短于最短分段 ${facts.minSegmentSec}s，只会有一段。`)
  }
  return notes.slice(0, MAX_NOTES)
}
