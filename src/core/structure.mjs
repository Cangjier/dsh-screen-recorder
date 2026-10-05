/**
 * Turning a recording into one structured document: the fusion of five measurements.
 *
 * This is the module the plugin exists for. Everything else captures, decodes, recognises or detects;
 * here those answers are put on one timeline and written out as a JSON document somebody can search,
 * diff and reason over:
 *
 * ```
 * 时间轴分段 ─┐
 * OCR 文字   ─┤
 * 区域语义    ─┼─→  structure.json
 * YOLO 物体   ─┤    关键帧 + 联系表 + 交付视频
 * 语音转文字  ─┘
 * ```
 *
 * Four rules shape it, and they are the reason this is a module and not a handler:
 *
 * 1. **Every claim carries its evidence.** A segment's `kind` comes with the shares, line counts and
 *    scores that produced it; a box comes with its score. Nothing here is a bare assertion.
 * 2. **Missing is reported, never faked.** No recogniser, no detector, no speech, no keyframe — each
 *    becomes a `null` plus a reason in `warnings`/`reason`, because a structure that silently omits
 *    half of itself reads exactly like a recording where nothing happened.
 * 3. **One decode per question.** The frames are decoded once for the timeline; stills are extracted
 *    from those keyframes and handed to OCR, segmentation and detection by path, so nothing decodes
 *    the same second three times.
 * 4. **The document is the product.** The delivery video, the contact sheet and the chapters are
 *    conveniences written beside it; if they fail, the structure is still returned and the failure is
 *    a warning.
 *
 * @module dsh-screen-recorder/core/structure
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, basename, extname } from 'node:path'
import { classifySegment, extractKeywords, groupKinds, textWithin } from './analysis.mjs'
import { asrState, transcribeIntervals } from './asr.mjs'
import { longPath, resolveCwd } from './env.mjs'
import { MediaError, runFfmpeg } from './ffmpeg.mjs'
import { fitInside } from './image.mjs'
import { ocrImage, ocrStatus } from './ocr.mjs'
import { probeMedia } from './probe.mjs'
import { detectFrame, detectorState } from './vision.mjs'
import { segmentImage } from './segmentation.mjs'
import { detectScenes } from './timeline.mjs'

/** Bumped whenever the document's shape changes, so a reader can tell two structures apart. */
export const STRUCTURE_VERSION = 1

/** The plugin's own name, recorded in every document. */
export const PLUGIN_NAME = 'dsh-screen-recorder'

/** Long side of an extracted still. Larger than the analysis frame because OCR needs the pixels. */
export const STILL_MAX_SIDE = 1920

/** How many stills go into the contact sheet: a 5×4 montage. */
export const CONTACT_SHEET_TILES = 20

/** Width of one tile in the contact sheet, so a full sheet stays under 2000 px on the long side. */
export const CONTACT_TILE_WIDTH = 384

/**
 * Analyze one recording and write the structure.
 *
 * @param {object} request - the request.
 * @param {string} request.input - the recording to read.
 * @param {string} [request.outDir] - where artifacts go. Defaults to `<input stem>.structure` beside the input.
 * @param {object} request.config - normalized plugin config.
 * @param {object} [request.options] - per-call overrides for the analysis settings.
 * @param {object|null} [request.service] - the host's `speechToText` service, when one is published.
 * @param {boolean} [request.ocr] - read text. Default true.
 * @param {boolean} [request.detect] - run the object detector. Default true.
 * @param {boolean} [request.transcribe] - transcribe the audio. Default true.
 * @param {'copy'|'encode'|'none'} [request.delivery] - what to write beside the structure. Default 'copy'.
 * @param {boolean} [request.contactSheet] - build one contact sheet. Default true.
 * @param {boolean} [request.keywords] - rank terms from the recognised text. Default true.
 * @param {(event: object) => void} [request.onProgress] - progress events.
 * @param {AbortSignal} [request.signal] - caller cancellation.
 * @returns {Promise<object>} the structure document, with the paths of what was written.
 * @throws {import('./ffmpeg.mjs').MediaError} when the input cannot be read at all.
 */
export async function analyzeRecording(request) {
  const config = request.config ?? {}
  const started = Date.now()
  const warnings = []
  const facts = await probeMedia(request.input, { config })
  if (!facts.readable || facts.video === null) {
    throw new MediaError(`读不了这段录屏：${facts.problems[0] ?? '没有视频流'}`)
  }
  const durationSec = facts.durationSec ?? facts.video.durationSec
  const settings = resolveSettings(config, request.options ?? {})
  const outDir = request.outDir ?? join(resolveCwd(config, undefined), `${basename(request.input, extname(request.input))}.structure`)
  const keyframeDir = join(outDir, 'keyframes')
  mkdirSync(keyframeDir, { recursive: true })

  // ---------------------------------------------------------------- 1. the timeline
  request.onProgress?.({ phase: 'timeline' })
  const scene = await detectScenes({
    input: request.input,
    config,
    fps: settings.fps,
    maxSide: settings.maxSide,
    sceneThreshold: settings.sceneThreshold,
    minSegmentSec: settings.minSegmentSec,
    maxSegmentSec: settings.maxSegmentSec,
    mergeShortSec: settings.mergeShortSec,
    maxSegments: settings.maxSegments,
    // Decoding an hour of screen at 4 fps takes minutes, not ten: the timeout scales with the
    // material so a long recording is not killed by the default that fits a short one.
    timeoutMs: Math.max(config.defaultTimeoutMs ?? 600_000, Math.round((durationSec ?? 0) * 3000) + 300_000),
    onProgress: request.onProgress,
  })
  const segments = scene.segments.map((segment) => ({
    id: `s${String(segment.index).padStart(3, '0')}`,
    index: segment.index,
    start: segment.start,
    end: segment.end,
    seconds: segment.seconds,
    reason: segment.reason,
    sceneScore: segment.sceneScore,
    motion: segment.motion,
  }))
  if (segments.length === 0) throw new MediaError('这段录屏没有解出任何画面：文件可能被截断，或者时长是 0。')

  // ---------------------------------------------------------------- 2. one still per segment
  request.onProgress?.({ phase: 'keyframes', total: Math.min(segments.length, settings.maxKeyframes) })
  const stills = await extractStills({
    input: request.input,
    segments,
    limit: settings.maxKeyframes,
    outDir: keyframeDir,
    config,
    sourceWidth: facts.video.width,
    sourceHeight: facts.video.height,
    onProgress: request.onProgress,
  })
  for (const segment of segments) {
    const still = stills.get(segment.index) ?? null
    segment.keyframe = still === null ? null : still.path
    segment.keyframeAt = still === null ? null : still.at
  }
  if (stills.size < segments.length) {
    warnings.push(`只抽了 ${stills.size} 张关键帧（共 ${segments.length} 段）：maxKeyframes 限制，或者抽帧失败。`)
  }

  // ---------------------------------------------------------------- 3. appearance segmentation
  request.onProgress?.({ phase: 'regions' })
  const regionReport = await runSegmentation({ segments, stills, config, settings, warnings })

  // ---------------------------------------------------------------- 4. text recognition
  const textReport = request.ocr === false
    ? { available: false, engine: null, reason: '这次调用关掉了文字识别（ocr:false）。', lines: [], bySegment: {} }
    : await runOcr({ segments, stills, config, settings, warnings, onProgress: request.onProgress })

  // ---------------------------------------------------------------- 5. object detection
  const objectReport = request.detect === false
    ? { available: false, model: null, reason: '这次调用关掉了目标检测（detect:false）。', frames: [], counts: {}, bySegment: {} }
    : await runDetection({ input: request.input, segments, stills, config, settings, warnings, onProgress: request.onProgress })

  // ---------------------------------------------------------------- 6. speech
  const speechReport = await runSpeech({
    input: request.input,
    facts,
    segments,
    service: request.service ?? null,
    config,
    settings,
    enabled: request.transcribe !== false,
    warnings,
    onProgress: request.onProgress,
    signal: request.signal,
  })

  // ---------------------------------------------------------------- 7. fuse
  request.onProgress?.({ phase: 'fusing' })
  for (const segment of segments) {
    const regions = regionReport.bySegment[segment.id] ?? null
    const text = textReport.bySegment[segment.id] ?? null
    const objects = objectReport.bySegment[segment.id] ?? []
    const speech = speechReport.bySegment[segment.id] ?? null
    segment.appearances = regions === null ? null : regions.shares
    segment.regionBlocks = regions === null ? null : regions.blocks
    segment.text = text === null ? null : text.text
    segment.textLines = text === null ? null : text.lines
    segment.objects = objects
    segment.speech = speech
    const verdict = classifySegment({
      appearance: regions?.shares,
      text: text?.text ?? '',
      objects,
      motion: segment.motion,
    })
    segment.kind = verdict.kind
    segment.kindLabel = verdict.label
    segment.kindReason = verdict.reason
    segment.kindEvidence = verdict.evidence
  }

  const keywordList = request.keywords === false ? [] : extractKeywords(Object.values(textReport.bySegment).map((entry) => entry.text))

  // ---------------------------------------------------------------- 8. artifacts
  request.onProgress?.({ phase: 'artifacts' })
  const artifacts = await writeArtifacts({
    input: request.input,
    outDir,
    keyframeDir,
    stills,
    segments,
    config,
    delivery: request.delivery ?? 'copy',
    contactSheet: request.contactSheet !== false,
    warnings,
  })

  const document = {
    plugin: PLUGIN_NAME,
    structureVersion: STRUCTURE_VERSION,
    generatedAt: new Date().toISOString(),
    input: {
      path: facts.path,
      container: facts.container,
      bytes: facts.sizeBytes,
      durationSec,
      width: facts.video.width,
      height: facts.video.height,
      fps: facts.video.fps,
      hasAudio: facts.audio !== null,
      audio: facts.audio,
      problems: facts.problems,
    },
    settings,
    summary: {
      segmentCount: segments.length,
      kinds: groupKinds(segments),
      textLines: textReport.lines.length,
      objects: Object.keys(objectReport.counts).length,
      speechIntervals: speechReport.intervals.length,
      durationSec,
    },
    timeline: {
      segmentCount: segments.length,
      analysisFps: scene.fps,
      analysisFrame: { width: scene.frameWidth, height: scene.frameHeight },
      framesAnalysed: scene.framesAnalysed,
      segments,
      notes: scene.notes,
    },
    text: {
      available: textReport.available,
      engine: textReport.engine ?? null,
      reason: textReport.reason ?? null,
      lineCount: textReport.lines.length,
      lines: textReport.lines,
      keywords: keywordList,
    },
    regions: {
      engine: regionReport.engine,
      tileSize: regionReport.tileSize,
      shares: regionReport.shares,
      frames: regionReport.frames,
      reason: regionReport.reason ?? null,
    },
    objects: {
      available: objectReport.available,
      model: objectReport.model,
      reason: objectReport.reason ?? null,
      frames: objectReport.frames,
      counts: objectReport.counts,
    },
    speech: {
      available: speechReport.available,
      provider: speechReport.provider ?? null,
      language: speechReport.language ?? null,
      reason: speechReport.reason ?? null,
      text: speechReport.text ?? '',
      intervalCount: speechReport.intervals.length,
      intervals: speechReport.intervals,
      notes: speechReport.notes ?? [],
    },
    artifacts,
    warnings,
    elapsedMs: Date.now() - started,
  }

  const structurePath = join(outDir, `${basename(request.input, extname(request.input))}.structure.json`)
  writeFileSync(structurePath, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  document.artifacts.structure = structurePath
  return document
}

/**
 * Merge the operator's config, this call's overrides and the code's defaults.
 *
 * @param {object} config - normalized plugin config.
 * @param {object} options - per-call overrides.
 * @returns {object} the settings the run actually uses.
 */
export function resolveSettings(config, options = {}) {
  const analysis = config.analysis ?? {}
  const pick = (key, fallback) => (Number.isFinite(options[key]) ? Number(options[key]) : Number.isFinite(analysis[key]) ? Number(analysis[key]) : fallback)
  return {
    fps: pick('fps', 4),
    maxSide: Math.round(pick('maxSide', 320)),
    sceneThreshold: pick('sceneThreshold', 8),
    minSegmentSec: pick('minSegmentSec', 1),
    maxSegmentSec: pick('maxSegmentSec', 30),
    mergeShortSec: pick('mergeShortSec', 0.7),
    maxSegments: Math.round(pick('maxSegments', 400)),
    maxKeyframes: Math.round(pick('maxKeyframes', 120)),
    ocrMaxFrames: Math.round(pick('ocrMaxFrames', 60)),
    detectMaxFrames: Math.round(pick('detectMaxFrames', 40)),
    tileSize: Math.round(pick('tileSize', 16)),
    detector: config.detector ?? {},
    ocr: config.ocr ?? {},
    asr: config.asr ?? {},
  }
}

/**
 * Extract one still per segment, from the segment's own midpoint.
 *
 * The stills are the shared input for text recognition, appearance segmentation and detection: one
 * decode per segment instead of three, and the three answers are guaranteed to describe the same
 * frame.
 *
 * @param {object} request - the request.
 * @returns {Promise<Map<number, {path: string, at: number}>>} segment index to its still.
 */
async function extractStills(request) {
  const stills = new Map()
  const limit = Math.min(request.limit, request.segments.length)
  // Stills are extracted at up to 1920 on the long side rather than the analysis frame's 320:
  // text recognition is the weakest link on a screen recording, and downscaling small UI text is
  // what makes it weaker. The source is never upscaled.
  const target = fitInside(request.sourceWidth ?? 1280, request.sourceHeight ?? 720, STILL_MAX_SIDE)
  for (const segment of request.segments.slice(0, limit)) {
    const at = Number(((segment.start + segment.end) / 2).toFixed(3))
    const path = join(request.outDir, `${segment.id}.jpg`)
    const args = [
      '-ss', at.toFixed(3),
      '-i', longPath(request.input),
      '-frames:v', '1',
      '-vf', `scale=${target.width}:${target.height}`,
      '-q:v', '3',
      '-y', longPath(path),
    ]
    try {
      await runFfmpeg(args, { config: request.config, timeoutMs: 120_000, label: `抽帧 ${segment.id}` })
      if (existsSync(path)) stills.set(segment.index, { path, at })
    } catch (error) {
      request.onProgress?.({ phase: 'keyframe-failed', id: segment.id, error: error instanceof Error ? error.message.split('\n')[0] : String(error) })
    }
  }
  return stills
}

/**
 * Segment each keyframe into appearance regions.
 * @param {object} request - the call.
 * @returns {Promise<object>} the per-segment regions and the mean shares.
 */
async function runSegmentation(request) {
  const bySegment = {}
  const frames = []
  const totals = { text: 0, picture: 0, texture: 0, flat: 0, dark: 0 }
  let counted = 0
  for (const segment of request.segments) {
    const still = request.stills.get(segment.index)
    if (still === undefined) continue
    try {
      const result = await segmentImage({ input: still.path, config: request.config, maxSide: 1280, tileSize: request.settings.tileSize })
      bySegment[segment.id] = { shares: result.shares, blocks: result.blocks.slice(0, 12), tiles: result.tiles.length }
      frames.push({ id: segment.id, at: still.at, shares: result.shares })
      for (const key of Object.keys(totals)) totals[key] += Number(result.shares[key]) || 0
      counted += 1
    } catch (error) {
      request.warnings.push(`区域分割失败（${segment.id}）：${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
    }
  }
  const shares = counted === 0
    ? null
    : Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, Number((value / counted).toFixed(4))]))
  return {
    engine: 'grid-appearance',
    tileSize: request.settings.tileSize,
    shares,
    frames,
    bySegment,
    reason: counted === 0 ? '没有任何关键帧可以分割（抽帧全部失败）。' : null,
  }
}

/**
 * Read the text on each keyframe.
 * @param {object} request - the call.
 * @returns {Promise<object>} the per-segment text and every line with its box.
 */
async function runOcr(request) {
  const status = await ocrStatus(request.config)
  if (!status.available) {
    return { available: false, engine: null, reason: status.reason, lines: [], bySegment: {} }
  }
  const bySegment = {}
  const lines = []
  const limit = Math.min(request.settings.ocrMaxFrames, request.segments.length)
  for (const segment of request.segments.slice(0, limit)) {
    const still = request.stills.get(segment.index)
    if (still === undefined) continue
    try {
      const result = await ocrImage(still.path, { config: request.config, scale: request.settings.ocr.scale, language: request.settings.ocr.language })
      bySegment[segment.id] = { text: result.text, lines: result.lines, engine: result.engine }
      for (const line of result.lines) lines.push({ segmentId: segment.id, at: still.at, ...line })
    } catch (error) {
      bySegment[segment.id] = { text: '', lines: [], engine: status.engine, error: error instanceof Error ? error.message.split('\n')[0] : String(error) }
      request.warnings.push(`文字识别失败（${segment.id}）：${bySegment[segment.id].error}`)
    }
  }
  return { available: true, engine: status.engine, provider: status.provider, reason: null, lines, bySegment }
}

/**
 * Run the object detector over a bounded number of keyframes.
 * @param {object} request - the call.
 * @returns {Promise<object>} the per-segment detections and a per-class count.
 */
async function runDetection(request) {
  const state = detectorState(request.config)
  if (!state.available) {
    return { available: false, model: null, reason: state.reason, frames: [], counts: {}, bySegment: {} }
  }
  const bySegment = {}
  const frames = []
  const counts = {}
  const limit = Math.min(request.settings.detectMaxFrames, request.segments.length)
  // Detection is the expensive step, so when there are more segments than the budget the sampled
  // ones are spread across the whole recording rather than taken from the beginning.
  const sampled = spread(request.segments.slice(0, request.segments.length), limit)
  for (const [index, segment] of sampled.entries()) {
    const still = request.stills.get(segment.index)
    if (still === undefined) continue
    request.onProgress?.({ phase: 'detect', index: index + 1, total: sampled.length, id: segment.id })
    try {
      const result = await detectFrame({
        input: still.path,
        config: request.config,
        minScore: request.settings.detector.minScore,
        iou: request.settings.detector.iou,
      })
      bySegment[segment.id] = result.objects
      frames.push({ id: segment.id, at: still.at, objects: result.objects, inferenceMs: result.inferenceMs })
      for (const object of result.objects) counts[object.label] = (counts[object.label] ?? 0) + 1
    } catch (error) {
      request.warnings.push(`目标检测失败（${segment.id}）：${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
      break
    }
  }
  const sorted = Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])))
  return {
    available: true,
    model: { name: 'yolov8n', classes: state.classes, path: state.modelPath },
    reason: null,
    frames,
    counts: sorted,
    bySegment,
  }
}

/**
 * Pick at most `limit` entries spread evenly across a list.
 *
 * @param {object[]} items - the list.
 * @param {number} limit - how many to keep.
 * @returns {object[]} the sample, in the original order.
 */
function spread(items, limit) {
  if (limit >= items.length) return [...items]
  if (limit <= 1) return items.length === 0 ? [] : [items[0]]
  const step = (items.length - 1) / (limit - 1)
  const picked = []
  for (let index = 0; index < limit; index += 1) picked.push(items[Math.round(index * step)])
  return [...new Set(picked)]
}

/**
 * Transcribe the recording's audio and attach each interval to its segment.
 * @param {object} request - the call.
 * @returns {Promise<object>} the transcript, its intervals, and the per-segment text.
 */
async function runSpeech(request) {
  const settings = request.settings
  const state = asrState({ service: request.service })
  if (request.enabled !== true) {
    return { available: false, reason: '这次调用关掉了语音转文字（transcribe:false）。', intervals: [], bySegment: {}, text: '' }
  }
  if (settings.asr.enabled === false) {
    return { available: false, reason: '配置里关掉了语音转文字（config.asr.enabled:false）。', intervals: [], bySegment: {}, text: '' }
  }
  if (request.facts.audio === null) {
    return { available: false, reason: '这段录屏没有音频轨，没有东西可以转写。', intervals: [], bySegment: {}, text: '' }
  }
  if (!state.available) {
    return { available: false, reason: state.reason, installHint: state.installHint, intervals: [], bySegment: {}, text: '', notes: [] }
  }

  try {
    const transcript = await transcribeIntervals({
      source: request.input,
      service: request.service,
      language: settings.asr.language,
      maxAudioBytes: settings.asr.maxAudioBytes,
      maxIntervals: settings.asr.maxIntervals,
      config: request.config,
      onProgress: request.onProgress,
      signal: request.signal,
    })
    const bySegment = {}
    for (const segment of request.segments) {
      // A segment's speech is every interval that overlaps it, reported with the overlap so a
      // sentence crossing a cut is visible as exactly that instead of being silently duplicated.
      const within = textWithin(transcript.intervals, segment.start, segment.end, 0.2)
      if (within.text !== '') bySegment[segment.id] = { text: within.text, overlapSeconds: within.overlapSeconds }
    }
    const placed = request.segments.filter((segment) => bySegment[segment.id] !== undefined).length
    if (transcript.intervals.length > 0 && placed === 0) {
      request.warnings.push('识别出了语音，但没有一段落在时间轴上：时间轴与音轨可能对不齐。')
    }
    return { ...transcript, available: true, reason: null, bySegment }
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error)
    request.warnings.push(`语音转文字失败：${message}`)
    return { available: false, reason: message, intervals: [], bySegment: {}, text: '', notes: [] }
  }
}

/**
 * Write the delivery video, the contact sheet and the chapters beside the structure.
 *
 * None of these is allowed to fail the analysis: each is attempted, and a failure becomes a warning,
 * because the structured document is the product and these are conveniences.
 *
 * @param {object} request - the call.
 * @returns {Promise<object>} the paths that were written.
 */
async function writeArtifacts(request) {
  const artifacts = { keyframes: request.keyframeDir, contactSheet: null, delivery: null, chapters: null }
  const stem = basename(request.input, extname(request.input))

  if (request.contactSheet && request.stills.size > 0) {
    const sheet = join(request.outDir, `${stem}.contact-sheet.jpg`)
    try {
      // Explicit inputs joined by `concat`, not a glob: a glob misses the sequence the moment one
      // extraction failed, and ffmpeg's glob expansion behaves differently per platform. The sheet
      // samples across the recording so a long one is represented rather than truncated.
      const chosen = spread([...request.stills.values()], Math.min(request.stills.size, CONTACT_SHEET_TILES)).map((still) => still.path)
      const inputs = chosen.flatMap((path) => ['-i', longPath(path)])
      // The stills are full-size (1920 wide) because OCR needs the pixels; a 5×4 montage of those is
      // 9600 px wide, which no viewer and no image tool will open. So the sheet is scaled down first
      // — the contact sheet is for finding the right second, not for reading the text on it.
      const filter =
        `${chosen.map((_, index) => `[${index}:v]`).join('')}concat=n=${chosen.length}:v=1:a=0,` +
        `scale=${CONTACT_TILE_WIDTH}:-2,tile=5x4:padding=4:color=white`
      await runFfmpeg([...inputs, '-filter_complex', filter, '-frames:v', '1', '-q:v', '4', '-y', longPath(sheet)], {
        config: request.config,
        timeoutMs: 180_000,
        label: '联系表',
      })
      if (existsSync(sheet)) artifacts.contactSheet = sheet
    } catch (error) {
      request.warnings.push(`联系表生成失败：${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
    }
  }

  if (request.delivery !== 'none') {
    const delivery = join(request.outDir, `${stem}.delivery.mp4`)
    try {
      const args = request.delivery === 'encode'
        ? ['-i', longPath(request.input), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-y', longPath(delivery)]
        : ['-i', longPath(request.input), '-c', 'copy', '-movflags', '+faststart', '-y', longPath(delivery)]
      await runFfmpeg(args, { config: request.config, timeoutMs: 60 * 60 * 1000, label: '交付视频' })
      if (existsSync(delivery)) artifacts.delivery = delivery
    } catch (error) {
      request.warnings.push(`交付视频写入失败：${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
    }
  }

  const chapterPath = join(request.outDir, `${stem}.chapters.txt`)
  try {
    writeFileSync(chapterPath, renderChapters(request.segments), 'utf8')
    artifacts.chapters = chapterPath
  } catch (error) {
    request.warnings.push(`章节文件写入失败：${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  }

  return artifacts
}

/**
 * Render the segments as an ffmetadata chapter list.
 *
 * A file rather than embedded metadata on purpose: chapter support differs between containers, and a
 * sidecar that always works beats an embedded field that silently does not.
 *
 * @param {object[]} segments - the classified segments.
 * @returns {string} the ffmetadata text.
 */
export function renderChapters(segments) {
  const lines = [';FFMETADATA1', '# 由 dsh-screen-recorder 生成：每个时间轴分段一个章节']
  for (const segment of segments) {
    lines.push(
      '[CHAPTER]',
      'TIMEBASE=1/1000',
      `START=${Math.round(segment.start * 1000)}`,
      `END=${Math.round(segment.end * 1000)}`,
      `title=${segment.id} ${segment.kindLabel ?? segment.kind ?? ''} ${segment.start.toFixed(2)}s-${segment.end.toFixed(2)}s`,
    )
  }
  return `${lines.join('\n')}\n`
}
