/**
 * `screen_analyze` — reading a recording back as structure.
 *
 * @module dsh-screen-recorder/tools/analyze
 */
import { existsSync } from 'node:fs'
import { ensureDir, resolveCwd } from '../core/env.mjs'
import { MediaError } from '../core/ffmpeg.mjs'
import { probeMedia } from '../core/probe.mjs'
import { segmentImage } from '../core/segmentation.mjs'
import { analyzeRecording } from '../core/structure.mjs'
import { detectScenes } from '../core/timeline.mjs'
import { transcribeIntervals } from '../core/asr.mjs'
import { detectFrame } from '../core/vision.mjs'
import {
  CWD_PROPERTY,
  ScreenPluginError,
  TIMEOUT_PROPERTY,
  defineFamilyTool,
  optionalBoolean,
  optionalEnum,
  optionalNumberArray,
  optionalNumberInRange,
  requireString,
} from './shared.mjs'

/** Every action `screen_analyze` dispatches. */
export const ANALYZE_ACTIONS = ['analyze', 'scenes', 'regions', 'detect', 'transcribe']

/**
 * Build the `screen_analyze` tool.
 *
 * @param {object} config - normalized plugin config.
 * @param {object} logger - the host plugin's logger.
 * @param {() => object} locate - resolves the host's optional services at call time.
 * @returns {object} a raw tool definition.
 */
export function createAnalyzeTool(config, logger, locate) {
  const where = 'screen_analyze'

  /**
   * Resolve one input path, and refuse a file that is not there before anything else happens.
   * @param {object} args - the tool arguments.
   * @param {object} context - the tool context.
   * @returns {string} the absolute input path.
   * @throws {ScreenPluginError} when the file does not exist.
   */
  const inputOf = (args, context) => {
    const input = resolveCwd(config, requireString(args, 'input', where))
    if (!existsSync(input)) throw new ScreenPluginError(`${where}: 文件不存在 ${input}`)
    return input
  }

  /**
   * The config this call runs with, with the per-call overrides folded in.
   * @param {object} args - the tool arguments.
   * @returns {object} a config clone.
   */
  const configFor = (args) => {
    if (typeof args.language !== 'string' || args.language === '') return config
    return { ...config, asr: { ...config.asr, language: args.language } }
  }

  /**
   * Turn progress events into log lines, which is what makes a long analysis observable.
   * @param {string} action - the action name, for the prefix.
   * @returns {(event: object) => void} the callback.
   */
  const progress = (action) => (event) => {
    if (event?.phase === undefined) return
    const detail = [
      event.index !== undefined ? `${event.index}/${event.total ?? '?'}` : null,
      event.id ?? null,
      event.at !== undefined && event.at !== null ? `@${event.at}s` : null,
      event.seconds !== undefined ? `${event.seconds}s` : null,
    ].filter((part) => part !== null)
    logger.info(`dsh-screen-recorder: ${action} ${event.phase}${detail.length > 0 ? ` ${detail.join(' ')}` : ''}`)
  }

  /**
   * The analysis settings this call overrides, as the core module expects them.
   * @param {object} args - the tool arguments.
   * @returns {object} the overrides.
   */
  const overrides = (args) => ({
    fps: Number.isFinite(args.fps) ? args.fps : undefined,
    maxSide: Number.isFinite(args.maxSide) ? args.maxSide : undefined,
    sceneThreshold: Number.isFinite(args.sceneThreshold) ? args.sceneThreshold : undefined,
    minSegmentSec: Number.isFinite(args.minSegmentSec) ? args.minSegmentSec : undefined,
    maxSegmentSec: Number.isFinite(args.maxSegmentSec) ? args.maxSegmentSec : undefined,
    mergeShortSec: Number.isFinite(args.mergeShortSec) ? args.mergeShortSec : undefined,
    maxSegments: Number.isFinite(args.maxSegments) ? args.maxSegments : undefined,
    maxKeyframes: Number.isFinite(args.maxKeyframes) ? args.maxKeyframes : undefined,
    ocrMaxFrames: Number.isFinite(args.ocrMaxFrames) ? args.ocrMaxFrames : undefined,
    detectMaxFrames: Number.isFinite(args.detectMaxFrames) ? args.detectMaxFrames : undefined,
    tileSize: Number.isFinite(args.tileSize) ? args.tileSize : undefined,
  })

  return defineFamilyTool({
    name: 'screen_analyze',
    actions: ANALYZE_ACTIONS,
    extraProperties: {
      input: { type: 'string', description: 'The recording to read. Required by every action; a file that does not exist is refused before anything else happens.' },
      outDir: { type: 'string', description: 'analyze: where the structure, keyframes, contact sheet and delivery video go. Defaults to "<input stem>.structure" beside the input.' },
      at: { type: 'number', description: 'regions: the second of the video to segment. Omit to treat the input as a still image.' },
      times: { type: 'array', items: { type: 'number' }, description: 'detect: the exact seconds to run the detector on. Omit to sample maxFrames moments evenly across the recording.' },
      maxFrames: { type: 'number', description: 'detect: how many moments to sample when "times" is not given. Default 8.' },
      minScore: { type: 'number', description: 'detect: confidence floor, 0.01–0.99. Defaults to the config\u2019s detector.minScore (0.35).' },
      iou: { type: 'number', description: 'detect: NMS IoU threshold, 0.05–0.95. Defaults to the config\u2019s detector.iou (0.45).' },
      fps: { type: 'number', description: 'analyze / scenes: the cadence the timeline is measured at. Default 4; higher finds shorter events and decodes more.' },
      maxSide: { type: 'number', description: 'analyze / scenes / regions: long side of the analysis frame in pixels. Default 320 for the timeline — smaller is faster and catches less.' },
      sceneThreshold: { type: 'number', description: 'analyze / scenes: mean absolute luma difference (0–255) that counts as a cut. Default 8; a full-screen switch is usually above 40.' },
      minSegmentSec: { type: 'number', description: 'analyze / scenes: shortest segment worth keeping on its own. Default 1.' },
      maxSegmentSec: { type: 'number', description: 'analyze / scenes: longest segment before a cadence cut. Default 30.' },
      mergeShortSec: { type: 'number', description: 'analyze / scenes: segments shorter than this merge into the previous one. Default 0.7.' },
      maxSegments: { type: 'number', description: 'analyze / scenes: hard cap on reported segments. Default 400.' },
      maxKeyframes: { type: 'number', description: 'analyze: how many segments get a still, and therefore how many can be read. Default 120.' },
      ocrMaxFrames: { type: 'number', description: 'analyze: how many of those stills get read for text. Default 60.' },
      detectMaxFrames: { type: 'number', description: 'analyze: how many stills get an object-detection pass, spread across the recording. Default 40; each costs roughly a second.' },
      tileSize: { type: 'number', description: 'analyze / regions: tile side in pixels of the appearance segmentation. Default 16; smaller is finer and slower.' },
      startSec: { type: 'number', description: 'scenes: start the analysis here instead of at 0, for walking a long recording in pieces.' },
      durationSec: { type: 'number', description: 'scenes: analyse at most this many seconds from startSec.' },
      ocr: { type: 'boolean', description: 'analyze: read text off the stills. Default true; false skips OCR entirely and the structure says so.' },
      detect: { type: 'boolean', description: 'analyze: run the object detector. Default true; false skips it and the structure says so.' },
      transcribe: { type: 'boolean', description: 'analyze / transcribe: speech to text. Default true for analyze; the standalone transcribe action always does it.' },
      language: { type: 'string', description: 'analyze / transcribe: recogniser language hint (zh, en, yue, ja, ko, or auto). Overrides config.asr.language for this call.' },
      keywords: { type: 'boolean', description: 'analyze: rank terms from the recognised text. Default true; the terms come from counts, not from a model.' },
      contactSheet: { type: 'boolean', description: 'analyze: build one montage JPEG from the keyframes. Default true.' },
      delivery: { type: 'string', enum: ['copy', 'encode', 'none'], description: 'analyze: "copy" (default) remuxes the recording into the output directory without re-encoding, "encode" normalises it to H.264/AAC, "none" writes no video.' },
      maxAudioBytes: { type: 'number', description: 'transcribe: the per-request audio budget in bytes. Default the host\u2019s 4 MB, which is about 131 seconds.' },
      maxIntervals: { type: 'number', description: 'transcribe: how many recogniser requests may be spent at most. Default 60; beyond that, neighbouring speech intervals are merged and the result says so.' },
      timeoutMs: TIMEOUT_PROPERTY,
      cwd: CWD_PROPERTY,
    },
    handlers: {
      /**
       * The whole pipeline over one recording.
       * @param {object} args - the tool arguments.
       * @param {object} context - the tool context.
       * @returns {Promise<object>} the structure document.
       */
      async analyze(args, context) {
        const input = inputOf(args, context)
        const outDir = typeof args.outDir === 'string' && args.outDir !== '' ? resolveCwd(config, args.outDir) : undefined
        if (outDir !== undefined) ensureDir(outDir)
        logger.info(`dsh-screen-recorder: 开始结构化分析 ${input}`)
        const document = await analyzeRecording({
          input,
          outDir,
          config: configFor(args),
          options: overrides(args),
          service: locate().speechToText ?? context.speechToText ?? null,
          ocr: optionalBoolean(args, 'ocr', true, `${where} analyze`),
          detect: optionalBoolean(args, 'detect', true, `${where} analyze`),
          transcribe: optionalBoolean(args, 'transcribe', true, `${where} analyze`),
          keywords: optionalBoolean(args, 'keywords', true, `${where} analyze`),
          contactSheet: optionalBoolean(args, 'contactSheet', true, `${where} analyze`),
          delivery: optionalEnum(args, 'delivery', ['copy', 'encode', 'none'], 'copy', `${where} analyze`),
          onProgress: progress('analyze'),
        })
        logger.info(
          `dsh-screen-recorder: 分析完成：${document.summary.segmentCount} 段、${document.text.lineCount} 行文字、` +
            `${Object.keys(document.objects.counts).length} 类物体、${document.speech.intervalCount} 段语音`,
        )
        return document
      },

      /**
       * Only the timeline.
       * @param {object} args - the tool arguments.
       * @param {object} context - the tool context.
       * @returns {Promise<object>} the segments.
       */
      async scenes(args, context) {
        const input = inputOf(args, context)
        const settings = overrides(args)
        const result = await detectScenes({
          input,
          config,
          fps: settings.fps,
          maxSide: settings.maxSide,
          sceneThreshold: settings.sceneThreshold,
          minSegmentSec: settings.minSegmentSec,
          maxSegmentSec: settings.maxSegmentSec,
          mergeShortSec: settings.mergeShortSec,
          maxSegments: settings.maxSegments,
          startSec: Number.isFinite(args.startSec) ? args.startSec : undefined,
          durationSec: Number.isFinite(args.durationSec) ? args.durationSec : undefined,
          onProgress: progress('scenes'),
        })
        logger.info(`dsh-screen-recorder: 时间轴 ${result.segments.length} 段（解码 ${result.framesAnalysed} 帧）`)
        return result
      },

      /**
       * Segment one frame into appearance regions.
       * @param {object} args - the tool arguments.
       * @param {object} context - the tool context.
       * @returns {Promise<object>} the regions.
       */
      async regions(args, context) {
        const input = inputOf(args, context)
        return segmentImage({
          input,
          at: Number.isFinite(args.at) ? args.at : undefined,
          config,
          maxSide: Number.isFinite(args.maxSide) ? args.maxSide : 1280,
          tileSize: Number.isFinite(args.tileSize) ? args.tileSize : config.analysis.tileSize,
        })
      },

      /**
       * Run the detector on named moments, or on a sample of the recording.
       * @param {object} args - the tool arguments.
       * @param {object} context - the tool context.
       * @returns {Promise<object>} the detections.
       */
      async detect(args, context) {
        const input = inputOf(args, context)
        const minScore = optionalNumberInRange(args, 'minScore', 0.01, 0.99, `${where} detect`)
        const iou = optionalNumberInRange(args, 'iou', 0.05, 0.95, `${where} detect`)
        let times = optionalNumberArray(args, 'times', `${where} detect`)
        if (times === undefined) {
          const frames = Math.max(1, Math.round(Number.isFinite(args.maxFrames) ? args.maxFrames : 8))
          const facts = await probeMedia(input, { config })
          const duration = facts.durationSec ?? facts.video?.durationSec ?? 0
          if (!Number.isFinite(duration) || duration <= 0) throw new MediaError(`读不出时长，无法自动选点：${input}`)
          times = frames === 1
            ? [Number((duration / 2).toFixed(3))]
            : Array.from({ length: frames }, (_, index) => Number(((index * duration) / (frames - 1)).toFixed(3)))
        }
        logger.info(`dsh-screen-recorder: 目标检测 ${times.length} 个时间点`)
        const frames = []
        const counts = {}
        for (const [index, at] of times.entries()) {
          const frame = await detectFrame({ input, at, config, minScore, iou })
          frames.push({ at, objects: frame.objects, inferenceMs: frame.inferenceMs })
          for (const object of frame.objects) counts[object.label] = (counts[object.label] ?? 0) + 1
          logger.info(`dsh-screen-recorder: 目标检测 ${index + 1}/${times.length} @${at}s 检出 ${frame.objects.length} 个`)
        }
        return {
          input,
          frames,
          counts: Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
          model: { name: 'yolov8n', classes: 80 },
          notes: ['框的坐标是源视频像素，原点在左上角；模型读图时缩小过、还做过 letterbox 补边，这些都已经折回去了。'],
        }
      },

      /**
       * Speech to text over the recording's audio.
       * @param {object} args - the tool arguments.
       * @param {object} context - the tool context.
       * @returns {Promise<object>} the transcript and its intervals.
       */
      async transcribe(args, context) {
        const input = inputOf(args, context)
        const service = locate().speechToText ?? context.speechToText ?? null
        logger.info(`dsh-screen-recorder: 开始语音转文字 ${input}`)
        const result = await transcribeIntervals({
          source: input,
          service,
          language: typeof args.language === 'string' && args.language !== '' ? args.language : config.asr.language,
          maxAudioBytes: Number.isFinite(args.maxAudioBytes) ? args.maxAudioBytes : config.asr.maxAudioBytes,
          maxIntervals: Number.isFinite(args.maxIntervals) ? args.maxIntervals : config.asr.maxIntervals,
          config,
          onProgress: progress('transcribe'),
        })
        logger.info(`dsh-screen-recorder: 语音转文字完成：${result.intervals.length} 段，${result.text.length} 字`)
        return {
          ...result,
          available: true,
          note: '每一段都带它覆盖的秒数；要贴到时间轴上，按 start/end 与分段求交即可（analyze 就是这么做的）。',
        }
      },
    },
  })
}

/** Raised by the tool's own validation, re-exported so the index can assert the import. */
export { ScreenPluginError }
