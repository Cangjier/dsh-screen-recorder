/**
 * `screen_env` — facts about this machine as a recording target.
 *
 * @module dsh-screen-recorder/tools/env
 */
import { capabilities } from '../core/caps.mjs'
import { listDevices } from '../core/devices.mjs'
import { resolveTool, versionOf, vendoredState } from '../core/env.mjs'
import { concurrencyState } from '../core/ffmpeg.mjs'
import { SHARED_FFMPEG_DIR, SHARED_RUNTIME_DIR, sharedHomeState } from '../core/home.mjs'
import { asrState } from '../core/asr.mjs'
import { ocrStatus } from '../core/ocr.mjs'
import { detectorState } from '../core/vision.mjs'
import { CWD_PROPERTY, defineFamilyTool } from './shared.mjs'

/** Every action `screen_env` dispatches. */
export const ENV_ACTIONS = ['probe', 'devices', 'components']

/**
 * Build the `screen_env` tool.
 *
 * @param {object} config - normalized plugin config.
 * @param {object} logger - the host plugin's logger.
 * @param {() => object} locate - resolves the host's optional services at call time.
 * @returns {object} a raw tool definition.
 */
export function createEnvTool(config, logger, locate) {
  const where = 'screen_env'

  return defineFamilyTool({
    name: 'screen_env',
    actions: ENV_ACTIONS,
    extraProperties: { cwd: CWD_PROPERTY },
    handlers: {
      /**
       * Everything about this machine that decides whether a recording can happen.
       * @returns {Promise<object>} the report.
       */
      async probe() {
        const ffmpeg = resolveTool('ffmpeg', config)
        const ffprobe = resolveTool('ffprobe', config)
        const report = {
          platform: process.platform,
          ffmpeg: ffmpeg === null ? null : { ...ffmpeg, version: await versionOf(ffmpeg.path) },
          ffprobe: ffprobe === null ? null : { ...ffprobe, version: await versionOf(ffprobe.path) },
          shared: { ...sharedHomeState(), ffmpegDir: SHARED_FFMPEG_DIR, runtimeDir: SHARED_RUNTIME_DIR },
          vendored: vendoredState(),
          concurrency: concurrencyState(),
          capture: null,
          encoders: [],
          filters: [],
          devices: [],
          components: null,
          problems: [],
          notes: [],
        }

        if (ffmpeg === null) {
          report.problems.push('没有找到 ffmpeg：录屏、抽帧、分析全都无法执行。运行 screen_setup {action:"install_ffmpeg"}。')
          return report
        }

        const caps = await capabilities(config)
        report.capture = caps.capture
        report.encoders = caps.encoders
        report.filters = caps.filters
        report.devices = caps.devices
        report.problems = [...caps.problems]

        const components = await componentsOf(config, locate)
        report.components = components

        const wanted = ['libx264', 'aac', 'libvpx-vp9', 'libopus', 'libmp3lame']
        const missingEncoders = wanted.filter((name) => !caps.encoders.includes(name))
        if (missingEncoders.length > 0) {
          report.notes.push(`这份构建没有这些编码器：${missingEncoders.join(', ')}；只有写到对应容器时才会受影响。`)
        }
        const wantedFilters = ['scale', 'tile', 'fps', 'silencedetect']
        const missingFilters = wantedFilters.filter((name) => !caps.filters.includes(name))
        if (missingFilters.length > 0) report.problems.push(`这份构建没有这些滤镜：${missingFilters.join(', ')}；抽帧、联系表或语音切分会失败。`)
        report.notes.push('录制上限 3600 秒一次；录完一定会解码数帧，ok 才代表真的录到了要求的长度。')
        return report
      },

      /**
       * The DirectShow devices, verbatim.
       * @returns {Promise<object>} the device list.
       */
      async devices(args) {
        const listed = await listDevices(config, { timeoutMs: Number.isFinite(args.timeoutMs) ? args.timeoutMs : undefined })
        logger.info(`dsh-screen-recorder: ${where} 列出 ${listed.devices.length} 个 DirectShow 设备`)
        return {
          ...listed,
          count: listed.devices.length,
          hint: '把 audio 里的名字原样传给 screen_record {action:"screen", audioDevice}，或 screen_record {action:"microphone", device}。',
        }
      },

      /**
       * Whether each optional reader is installed, with the reason and the hint when it is not.
       * @returns {Promise<object>} the component report.
       */
      async components() {
        return componentsOf(config, locate)
      },
    },
  })
}

/**
 * The state of the four optional pieces, gathered in one place.
 *
 * @param {object} config - normalized plugin config.
 * @param {() => object} locate - resolves the host's services at call time.
 * @returns {Promise<object>} the report.
 */
async function componentsOf(config, locate) {
  const ocr = await safe(() => ocrStatus(config))
  const detector = await safe(() => detectorState(config))
  const asr = await safe(() => asrState({ service: locate?.().speechToText }))
  const ffmpeg = resolveTool('ffmpeg', config)
  return {
    ffmpeg: ffmpeg === null ? { available: false, reason: '没有找到 ffmpeg', installHint: 'screen_setup {action:"install_ffmpeg"}' } : { available: true, path: ffmpeg.path, source: ffmpeg.label },
    ocr,
    detector: detector === null ? { available: false, reason: '检测不可用' } : { ...detector, installHint: detector.installHint },
    asr,
    note: '四件事互相独立：文字识别、目标检测、语音转文字任一不可用，时间轴与区域分割照常工作，结构里会写明哪一节缺了原因。',
  }
}

/**
 * Run a probe that is allowed to fail.
 *
 * A component report must never take the whole call down: "the recogniser is broken" is a fact worth
 * reporting, and an exception here would turn it into a failed tool call instead.
 *
 * @param {() => Promise<object>} thunk - the probe.
 * @returns {Promise<object>} its result, or a failure report.
 */
async function safe(thunk) {
  try {
    return await thunk()
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message.split('\n')[0] : String(error) }
  }
}
