/**
 * The `dsh-screen-recorder` Host plugin: record the screen, then read the recording back as
 * structured semantics.
 *
 * The plugin is a plain ESM module with no harness import, so a profile can install it without a
 * build step and without a dependency edge on the harness packages it composes with. It validates
 * its own config, because validating through the Loader would require the dependency this module
 * exists to avoid.
 *
 * Division of labour, which the rest of the code depends on:
 *   DSH decides what is wanted — how long to record, which window matters, whether the structure
 *   reads right, what to do next.
 *   This plugin executes and measures: same input, same output, and every artifact is re-measured
 *   before it is called done.
 *
 * @module dsh-screen-recorder
 */
import { registerTools } from './src/tools/index.mjs'
import { ANALYSIS_DEFAULTS, ASR_DEFAULTS, DETECTOR_DEFAULTS, OCR_DEFAULTS } from './src/core/analysis.mjs'
import { DEFAULT_TIMEOUT_MS, setMaxConcurrent } from './src/core/ffmpeg.mjs'
import { PLUGIN_ROOT, SHARED_FFMPEG_BIN } from './src/core/home.mjs'
import { resolveTool } from './src/core/env.mjs'

/** Stable Cordis plugin name. */
export const name = 'dsh-screen-recorder'

/** Services required before tools can be registered. */
export const inject = ['tools']

/** Default concurrency: two encodes, which is where a desktop stops making progress on both. */
export const DEFAULT_MAX_CONCURRENT = 2

/**
 * Read an optional string field, allowing null to mean "use the default".
 * @param {object} raw - the raw config object.
 * @param {string} key - the field name.
 * @param {string|null} fallback - the value used when the field is absent or null.
 * @param {string} where - the path used in the error message.
 * @returns {string|null} the resolved value.
 * @throws {TypeError} when the field is present and not a string.
 */
function optionalString(raw, key, fallback, where) {
  const value = raw[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') throw new TypeError(`dsh-screen-recorder: ${where} must be a string or null`)
  return value
}

/**
 * Read an optional number inside a range.
 * @param {object} raw - the raw config object.
 * @param {string} key - the field name.
 * @param {number} fallback - the value used when the field is absent.
 * @param {number} min - the smallest legal value.
 * @param {number} max - the largest legal value.
 * @param {string} where - the path used in the error message.
 * @returns {number} the resolved value.
 * @throws {TypeError} when the field is present and outside the range.
 */
function optionalNumber(raw, key, fallback, min, max, where) {
  const value = raw[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new TypeError(`dsh-screen-recorder: ${where} must be a number between ${min} and ${max}`)
  }
  return value
}

/**
 * Read an optional positive integer.
 * @param {object} raw - the raw config object.
 * @param {string} key - the field name.
 * @param {number} fallback - the value used when the field is absent.
 * @param {string} where - the path used in the error message.
 * @returns {number} the resolved value.
 * @throws {TypeError} when the field is present and not a positive integer.
 */
function optionalCount(raw, key, fallback, where) {
  const value = optionalNumber(raw, key, fallback, 1, 100000, where)
  return Math.floor(value)
}

/**
 * Read an optional enumeration.
 * @param {object} raw - the raw config object.
 * @param {string} key - the field name.
 * @param {string} fallback - the value used when the field is absent.
 * @param {string[]} allowed - the legal values.
 * @param {string} where - the path used in the error message.
 * @returns {string} the resolved value.
 * @throws {TypeError} when the field is present and not one of the legal values.
 */
function optionalEnum(raw, key, fallback, allowed, where) {
  const value = optionalString(raw, key, fallback, where)
  if (!allowed.includes(value)) {
    throw new TypeError(`dsh-screen-recorder: ${where} must be one of ${allowed.join(', ')}; got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Read an optional boolean.
 * @param {object} raw - the raw config object.
 * @param {string} key - the field name.
 * @param {boolean} fallback - the value used when the field is absent.
 * @param {string} where - the path used in the error message.
 * @returns {boolean} the resolved value.
 * @throws {TypeError} when the field is present and not a boolean.
 */
function optionalBoolean(raw, key, fallback, where) {
  const value = raw[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') throw new TypeError(`dsh-screen-recorder: ${where} must be a boolean`)
  return value
}

/**
 * Validate and normalize the row's config.
 *
 * Misconfiguration fails loud here, at activation, rather than surfacing later as a confusing tool
 * error. Nothing is required: with an empty config the plugin still works, using whatever ffmpeg it
 * can find.
 *
 * @param {object} [raw] - the row's `config`.
 * @returns {object} the normalized config.
 * @throws {TypeError} when a field has the wrong type or an impossible value.
 */
export function normalizeConfig(raw) {
  const config = raw ?? {}
  const analysis = config.analysis ?? {}
  const ocr = config.ocr ?? {}
  const detector = config.detector ?? {}
  const asr = config.asr ?? {}

  const maxConcurrent = optionalNumber(config, 'maxConcurrent', DEFAULT_MAX_CONCURRENT, 1, 8, 'config.maxConcurrent')

  return {
    projectRoot: optionalString(config, 'projectRoot', null, 'config.projectRoot'),
    ffmpegPath: optionalString(config, 'ffmpegPath', null, 'config.ffmpegPath'),
    ffprobePath: optionalString(config, 'ffprobePath', null, 'config.ffprobePath'),
    maxConcurrent: Math.floor(maxConcurrent),
    defaultTimeoutMs: optionalNumber(config, 'defaultTimeoutMs', DEFAULT_TIMEOUT_MS, 1000, 24 * 3600 * 1000, 'config.defaultTimeoutMs'),
    analysis: {
      // The defaults live in the core module so the guide, the schema descriptions and the
      // behaviour all read from one place; this only lets an operator move them.
      sceneThreshold: optionalNumber(analysis, 'sceneThreshold', ANALYSIS_DEFAULTS.sceneThreshold, 0.1, 255, 'config.analysis.sceneThreshold'),
      minSegmentSec: optionalNumber(analysis, 'minSegmentSec', ANALYSIS_DEFAULTS.minSegmentSec, 0.1, 600, 'config.analysis.minSegmentSec'),
      maxSegmentSec: optionalNumber(analysis, 'maxSegmentSec', ANALYSIS_DEFAULTS.maxSegmentSec, 1, 3600, 'config.analysis.maxSegmentSec'),
      mergeShortSec: optionalNumber(analysis, 'mergeShortSec', ANALYSIS_DEFAULTS.mergeShortSec, 0, 60, 'config.analysis.mergeShortSec'),
      fps: optionalNumber(analysis, 'fps', ANALYSIS_DEFAULTS.fps, 0.5, 30, 'config.analysis.fps'),
      maxSide: optionalCount(analysis, 'maxSide', ANALYSIS_DEFAULTS.maxSide, 'config.analysis.maxSide'),
      maxKeyframes: optionalCount(analysis, 'maxKeyframes', ANALYSIS_DEFAULTS.maxKeyframes, 'config.analysis.maxKeyframes'),
      maxSegments: optionalCount(analysis, 'maxSegments', ANALYSIS_DEFAULTS.maxSegments, 'config.analysis.maxSegments'),
      ocrMaxFrames: optionalCount(analysis, 'ocrMaxFrames', ANALYSIS_DEFAULTS.ocrMaxFrames, 'config.analysis.ocrMaxFrames'),
      detectMaxFrames: optionalCount(analysis, 'detectMaxFrames', ANALYSIS_DEFAULTS.detectMaxFrames, 'config.analysis.detectMaxFrames'),
      tileSize: optionalCount(analysis, 'tileSize', ANALYSIS_DEFAULTS.tileSize, 'config.analysis.tileSize'),
    },
    ocr: {
      provider: optionalEnum(ocr, 'provider', OCR_DEFAULTS.provider, ['auto', 'sibling', 'winrt', 'off'], 'config.ocr.provider'),
      language: optionalString(ocr, 'language', OCR_DEFAULTS.language, 'config.ocr.language'),
      pluginPath: optionalString(ocr, 'pluginPath', null, 'config.ocr.pluginPath'),
      scale: ocr.scale === undefined || ocr.scale === null
        ? OCR_DEFAULTS.scale
        : ocr.scale === 'auto'
          ? 'auto'
          : optionalNumber(ocr, 'scale', OCR_DEFAULTS.scale, 1, 3, 'config.ocr.scale'),
    },
    detector: {
      modelPath: optionalString(detector, 'modelPath', null, 'config.detector.modelPath'),
      minScore: optionalNumber(detector, 'minScore', DETECTOR_DEFAULTS.minScore, 0.01, 0.99, 'config.detector.minScore'),
      iou: optionalNumber(detector, 'iou', DETECTOR_DEFAULTS.iou, 0.05, 0.95, 'config.detector.iou'),
      maxSide: optionalCount(detector, 'maxSide', DETECTOR_DEFAULTS.maxSide, 'config.detector.maxSide'),
      threads: optionalCount(detector, 'threads', DETECTOR_DEFAULTS.threads, 'config.detector.threads'),
    },
    asr: {
      enabled: optionalBoolean(asr, 'enabled', ASR_DEFAULTS.enabled, 'config.asr.enabled'),
      language: optionalString(asr, 'language', ASR_DEFAULTS.language, 'config.asr.language'),
      maxAudioBytes: optionalCount(asr, 'maxAudioBytes', ASR_DEFAULTS.maxAudioBytes, 'config.asr.maxAudioBytes'),
      maxIntervals: optionalCount(asr, 'maxIntervals', ASR_DEFAULTS.maxIntervals, 'config.asr.maxIntervals'),
    },
  }
}

/**
 * Mount the tools.
 *
 * Registration is wrapped so a failure to reach the `tools` service is logged clearly instead of
 * looking like a silent no-op: a plugin that loads but exposes nothing is the hardest kind of
 * failure to notice.
 *
 * @param {object} ctx - the plugin context.
 * @param {object} rawConfig - the row's config.
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  let config
  try {
    config = normalizeConfig(rawConfig)
  } catch (error) {
    ctx.logger.error(`dsh-screen-recorder: 配置无效，插件未注册任何工具：${error.message}`)
    return
  }

  setMaxConcurrent(config.maxConcurrent)

  ctx.inject(['tools'], (toolsCtx) => {
    // Transcription is the one optional capability that lives in the Host rather than on disk, so
    // it is looked up per call rather than captured here: the voice-input bundle can be enabled or
    // disabled while this plugin stays mounted.
    const locate = () => ({ speechToText: typeof toolsCtx.get === 'function' ? toolsCtx.get('speechToText') : undefined })

    const outcome = registerTools(toolsCtx, config, ctx.logger, locate)
    if (outcome.registered.length === 0) {
      ctx.logger.error('dsh-screen-recorder: 没有注册任何工具，插件实际上不可用')
      return
    }
    // Say out loud which ffmpeg this machine will use, and whether it is there at all. It costs a
    // few stat() calls and starts nothing: a missing ffmpeg is worth a warning, because every
    // working action would otherwise fail one at a time with the same cause.
    try {
      const ffmpeg = resolveTool('ffmpeg', config)
      const ffprobe = resolveTool('ffprobe', config)
      if (ffmpeg === null) {
        ctx.logger.warn(
          `dsh-screen-recorder: 没有找到 ffmpeg。按顺序找过配置、环境变量、共享目录 ${SHARED_FFMPEG_BIN}、` +
            '本插件 vendor、同级插件与 PATH；运行 screen_setup {action:"install_ffmpeg"} 可以装一份固定的构建。',
        )
      } else {
        const line =
          `dsh-screen-recorder: ffmpeg = ${ffmpeg.path}（来源：${ffmpeg.label}）` +
          (ffprobe === null ? '；但没有找到 ffprobe，探测类工具会失败' : `；ffprobe = ${ffprobe.path}`) +
          `；插件根目录 ${PLUGIN_ROOT}`
        if (ffprobe === null) ctx.logger.warn(line)
        else ctx.logger.info(line)
      }
    } catch (error) {
      ctx.logger.warn(`dsh-screen-recorder: 环境检查失败：${error instanceof Error ? error.message : String(error)}`)
    }
  })
}
