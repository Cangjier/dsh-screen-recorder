/**
 * The defaults every action shares, and the four pure functions that turn measurements into words.
 *
 * This module is deliberately free of ffmpeg, of the disk and of the clock: everything here is a
 * function of its arguments, which is what makes the naming rules reviewable and testable. The
 * plugin's other half executes and measures; *this* is the only place where a number becomes a
 * label, so it is written as an explicit table rather than as a chain of `if`s buried in a handler.
 *
 * The labels are claims about **appearance**, not about meaning:
 *
 * - `kind` says which evidence fired — a dark screen whose text is full of shell prompts, a frame
 *   mostly covered by photographic content, a person in front of the camera. It does not say what
 *   the recording was *about*, and DSH is expected to read the structure and decide that.
 * - Every label carries the numbers that produced it, so a wrong label can be argued with.
 *
 * @module dsh-screen-recorder/core/analysis
 */

/** Defaults for the timeline and region analysis. Mirrored in `cordis.patch.yml` so an operator can move them. */
export const ANALYSIS_DEFAULTS = Object.freeze({
  /** Mean absolute luma difference (0–255) that opens a new segment. */
  sceneThreshold: 8,
  /** Shortest segment worth keeping on its own. */
  minSegmentSec: 1,
  /** Longest segment before a cadence cut. */
  maxSegmentSec: 30,
  /** Segments shorter than this merge into the previous one. */
  mergeShortSec: 0.7,
  /** Analysis cadence: how many frames per second the timeline is measured at. */
  fps: 4,
  /** Long side of the analysis frame, in pixels. */
  maxSide: 320,
  /** How many segments get a still. */
  maxKeyframes: 120,
  /** Hard cap on reported segments. */
  maxSegments: 400,
  /** How many segments get read for text. */
  ocrMaxFrames: 60,
  /** How many segments get an object-detection pass. */
  detectMaxFrames: 40,
  /** Tile side, in pixels, of the appearance segmentation. */
  tileSize: 16,
})

/** Defaults for text recognition. */
export const OCR_DEFAULTS = Object.freeze({
  provider: 'auto',
  language: 'ch',
  scale: 'auto',
})

/** Defaults for the YOLO detector. */
export const DETECTOR_DEFAULTS = Object.freeze({
  minScore: 0.35,
  iou: 0.45,
  maxSide: 640,
  threads: 1,
})

/** Defaults for speech to text. */
export const ASR_DEFAULTS = Object.freeze({
  enabled: true,
  language: null,
  maxAudioBytes: 4 * 1024 * 1024,
  maxIntervals: 60,
})

/**
 * The naming rules, in priority order — the first rule whose `when` holds gives the segment its kind.
 *
 * Each rule reads only the evidence a segment carries: the appearance shares of its keyframe, the
 * text recognised on it, and the objects detected in it. Thresholds are data, so a test can move
 * them and a reviewer can disagree with a number instead of with the code.
 */
export const KIND_RULES = Object.freeze([
  {
    kind: 'terminal',
    label: '终端 / 命令行',
    when: (e) => e.text.shellHits >= 3 && e.appearance.dark >= 0.15,
  },
  {
    kind: 'code',
    label: '代码编辑器',
    when: (e) => e.text.codeHits >= 4 && e.appearance.text >= 0.08,
  },
  {
    kind: 'presenter',
    label: '有人出镜',
    when: (e) => e.objects.personShare >= 0.25 && e.appearance.text < 0.1,
  },
  {
    kind: 'picture',
    label: '以图像 / 视频为主',
    when: (e) => e.appearance.picture >= 0.45,
  },
  {
    kind: 'text',
    label: '以文字为主',
    when: (e) => e.appearance.text >= 0.16 || e.text.lineCount >= 12,
  },
  {
    kind: 'document',
    label: '文档 / 列表页',
    when: (e) => e.appearance.text + e.appearance.flat >= 0.6 && e.text.lineCount >= 3,
  },
  {
    kind: 'idle',
    label: '几乎没有变化',
    when: (e) => e.motion < 0.35 && e.text.lineCount === 0 && e.objects.count === 0,
  },
])

/** The label given to a segment no rule claimed. */
export const FALLBACK_KIND = Object.freeze({ kind: 'desktop', label: '桌面 / 界面' })

/**
 * Count the shell-ish, code-ish and punctuation evidence in a block of recognised text.
 *
 * These are counts of **tokens that appear**, not a language model's opinion: `PS C:\>` and
 * `Traceback (most recent call last)` are things a terminal prints, and it is cheaper and more
 * honest to say so than to classify the screen with a model.
 *
 * @param {string} text - the recognised text, lines joined by newlines.
 * @returns {{shellHits: number, codeHits: number, charCount: number, lineCount: number}} the counts.
 */
export function textEvidence(text) {
  const source = typeof text === 'string' ? text : ''
  const lines = source.split('\n').filter((line) => line.trim() !== '')
  const shellPatterns = [
    /(^|\s)(PS\s+[A-Za-z]:\\|C:\\[^ ]*>|>|\$|#)\s*$/m,
    /(^|\s)(npm|pnpm|yarn|git|node|python|pip|cargo|go|dotnet|docker|kubectl)\s+[\w-]+/,
    /\b(error|warning|failed|exception|traceback|permission denied)\b/i,
    /\b(npm ERR!|ELIFECYCLE|ENOENT|EPERM)\b/,
  ]
  const codePatterns = [
    /[{};]\s*$/m,
    /\b(function|const|let|var|class|import|export|def|return|async|await|public|private|void)\b/,
    /=>|===|!==|::|\+\+|-->/,
    /^\s*(if|for|while|switch|try|catch)\s*[({]/m,
  ]
  let shellHits = 0
  let codeHits = 0
  for (const pattern of shellPatterns) if (pattern.test(source)) shellHits += 1
  for (const pattern of codePatterns) if (pattern.test(source)) codeHits += 1
  // Every line that looks like a prompt counts once more: a terminal session is repetitive by nature.
  for (const line of lines) {
    if (/^\s*(PS\s+[A-Za-z]:\\|C:\\[^ ]*>|\$|>|#)\s/.test(line)) shellHits += 1
    if (/[{};]\s*$/.test(line) || /^\s{2,}\S/.test(line)) codeHits += 1
  }
  return { shellHits, codeHits, charCount: source.length, lineCount: lines.length }
}

/**
 * Turn one segment's measurements into a kind, with the evidence that produced it.
 *
 * @param {object} evidence - what the segment carries.
 * @param {object} [evidence.appearance] - appearance shares, each 0..1.
 * @param {string} [evidence.text] - the recognised text for this segment.
 * @param {{label: string, score: number}[]} [evidence.objects] - detected objects.
 * @param {number} [evidence.motion] - mean frame difference inside the segment.
 * @returns {{kind: string, label: string, reason: string, evidence: object}} the verdict, always with a reason.
 */
export function classifySegment(evidence = {}) {
  const appearance = {
    text: share(evidence.appearance?.text),
    picture: share(evidence.appearance?.picture),
    texture: share(evidence.appearance?.texture),
    flat: share(evidence.appearance?.flat),
    dark: share(evidence.appearance?.dark),
  }
  const text = textEvidence(evidence.text ?? '')
  const objects = Array.isArray(evidence.objects) ? evidence.objects : []
  const personScore = objects.filter((entry) => entry.label === 'person').reduce((best, entry) => Math.max(best, Number(entry.score) || 0), 0)
  const facts = {
    appearance,
    text,
    objects: { count: objects.length, personShare: personScore },
    motion: Number.isFinite(evidence.motion) ? Number(evidence.motion) : 0,
  }

  for (const rule of KIND_RULES) {
    if (rule.when(facts)) {
      return {
        kind: rule.kind,
        label: rule.label,
        reason: reasonFor(rule.kind, facts),
        evidence: facts,
      }
    }
  }
  return { kind: FALLBACK_KIND.kind, label: FALLBACK_KIND.label, reason: reasonFor('desktop', facts), evidence: facts }
}

/**
 * One sentence naming the numbers that produced a kind.
 *
 * @param {string} kind - the chosen kind.
 * @param {object} facts - the evidence.
 * @returns {string} a Chinese sentence.
 */
function reasonFor(kind, facts) {
  const shares = `文字 ${pct(facts.appearance.text)}、图像 ${pct(facts.appearance.picture)}、暗色 ${pct(facts.appearance.dark)}`
  switch (kind) {
    case 'terminal':
      return `${facts.text.shellHits} 处像命令行输出，且画面 ${pct(facts.appearance.dark)} 是暗色（${shares}）。`
    case 'code':
      return `${facts.text.codeHits} 处像代码，文字占比 ${pct(facts.appearance.text)}。`
    case 'presenter':
      return `检出 person，最高置信度 ${facts.objects.personShare.toFixed(2)}，画面几乎没有文字（${pct(facts.appearance.text)}）。`
    case 'picture':
      return `图像/视频区域占 ${pct(facts.appearance.picture)}，超过判定线。`
    case 'text':
      return `文字区域占 ${pct(facts.appearance.text)}（或识别出 ${facts.text.lineCount} 行）。`
    case 'document':
      return `文字加纯色占 ${pct(facts.appearance.text + facts.appearance.flat)}，识别出 ${facts.text.lineCount} 行。`
    case 'idle':
      return `段内平均帧差 ${facts.motion.toFixed(2)}，没有文字也没有检出物体。`
    default:
      return `没有规则命中：${shares}，识别 ${facts.text.lineCount} 行，帧差 ${facts.motion.toFixed(2)}。`
  }
}

/**
 * Coerce a value into a 0..1 share.
 * @param {*} value - the raw value.
 * @returns {number} the share.
 */
function share(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return 0
  return number > 1 ? 1 : number
}

/**
 * A share as a percentage string, for a reason sentence.
 * @param {number} value - the share.
 * @returns {string} for example `"23.4%"`.
 */
function pct(value) {
  return `${(share(value) * 100).toFixed(1)}%`
}

/** Words that carry no information about what a screen is showing. */
export const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were', 'have', 'has', 'had',
  'not', 'but', 'you', 'your', 'our', 'its', 'it', 'is', 'be', 'to', 'of', 'in', 'on', 'at', 'as',
  'by', 'or', 'an', 'a', 'if', 'then', 'else', 'when', 'will', 'can', 'may', 'all', 'any', 'one',
  'two', 'new', 'use', 'used', 'using', 'get', 'set', 'out', 'http', 'https', 'www', 'com', 'true',
  'false', 'null', 'undefined', 'the', '的', '了', '是', '在', '和', '与', '或', '也', '就', '都',
  '而', '及', '等', '中', '上', '下', '个', '这', '那', '我', '你', '他', '它', '们', '有', '无',
])

/**
 * Rank the terms a recording's text is made of, from counts.
 *
 * Latin runs of two or more characters and CJK bigrams are counted after lower-casing; stop words are
 * dropped. The result is a term list, not an understanding — "what was this recording about" is a
 * question for DSH, and this is the raw material for it.
 *
 * @param {string|string[]} text - the recognised text, or one entry per segment.
 * @param {object} [options] - the call.
 * @param {number} [options.limit] - how many terms to keep. Default 40.
 * @param {number} [options.minCount] - drop terms seen fewer times. Default 1.
 * @returns {{term: string, count: number}[]} ranked terms, most frequent first.
 */
export function extractKeywords(text, options = {}) {
  const limit = Number.isFinite(options.limit) ? options.limit : 40
  const minCount = Number.isFinite(options.minCount) ? options.minCount : 1
  const source = Array.isArray(text) ? text.join('\n') : String(text ?? '')
  const counts = new Map()

  for (const match of source.matchAll(/[A-Za-z][A-Za-z0-9_+#.-]{1,}/g)) {
    const term = match[0].toLowerCase().replace(/[.-]+$/, '')
    if (term.length < 2 || STOP_WORDS.has(term) || /^\d+$/.test(term)) continue
    counts.set(term, (counts.get(term) ?? 0) + 1)
  }
  for (const match of source.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const run = match[0]
    for (let index = 0; index + 2 <= run.length; index += 1) {
      const term = run.slice(index, index + 2)
      if (STOP_WORDS.has(term)) continue
      counts.set(term, (counts.get(term) ?? 0) + 1)
    }
  }

  return [...counts.entries()]
    .filter(([, count]) => count >= minCount)
    .map(([term, count]) => ({ term, count }))
    .sort((a, b) => (b.count - a.count) || a.term.localeCompare(b.term))
    .slice(0, limit)
}

/**
 * Attach timed items to the segment that contains them.
 *
 * An item is placed on the segment containing its **midpoint**, which is the rule that keeps one
 * spoken sentence from being copied onto both sides of a cut. Items that fall outside every segment
 * are reported as unplaced rather than dropped, because a missing line is a bug the reader cannot
 * see and a listed one is not.
 *
 * @param {{start: number, end: number}[]} items - timed items, in any order.
 * @param {{start: number, end: number}[]} segments - the timeline.
 * @returns {{placed: {item: object, segmentIndex: number}[], unplaced: object[]}} the assignment.
 */
export function assignToSegments(items, segments) {
  const placed = []
  const unplaced = []
  for (const item of Array.isArray(items) ? items : []) {
    const midpoint = (Number(item.start) + Number(item.end)) / 2
    let index = -1
    for (let position = 0; position < segments.length; position += 1) {
      const segment = segments[position]
      if (midpoint >= segment.start && midpoint < segment.end) {
        index = position
        break
      }
    }
    if (index < 0 && segments.length > 0 && midpoint >= segments[segments.length - 1].end) index = segments.length - 1
    if (index < 0) unplaced.push(item)
    else placed.push({ item, segmentIndex: index })
  }
  return { placed, unplaced }
}

/**
 * Group segment indices by their kind.
 *
 * @param {{index: number, kind: string}[]} segments - classified segments.
 * @returns {Record<string, number[]>} kind to the segment indices carrying it, in timeline order.
 */
export function groupKinds(segments) {
  const groups = {}
  for (const segment of Array.isArray(segments) ? segments : []) {
    const kind = typeof segment.kind === 'string' && segment.kind !== '' ? segment.kind : FALLBACK_KIND.kind
    if (groups[kind] === undefined) groups[kind] = []
    groups[kind].push(segment.index)
  }
  return groups
}

/**
 * Reduce a list of intervals to the ones that overlap a range, and the text they carry.
 *
 * @param {{start: number, end: number, text?: string}[]} intervals - timed intervals.
 * @param {number} start - range start, in seconds.
 * @param {number} end - range end, in seconds.
 * @param {number} [minOverlapSeconds] - ignore overlaps shorter than this. Default 0.
 * @returns {{overlapSeconds: number, text: string}} the total overlap and the joined text.
 */
export function textWithin(intervals, start, end, minOverlapSeconds = 0) {
  let overlap = 0
  const parts = []
  for (const interval of Array.isArray(intervals) ? intervals : []) {
    const from = Math.max(start, Number(interval.start))
    const to = Math.min(end, Number(interval.end))
    const seconds = to - from
    if (!Number.isFinite(seconds) || seconds <= minOverlapSeconds) continue
    overlap += seconds
    if (typeof interval.text === 'string' && interval.text.trim() !== '') parts.push(interval.text.trim())
  }
  return { overlapSeconds: Number(overlap.toFixed(4)), text: parts.join(' ') }
}
