/**
 * `screen_record` — capturing this machine, for a fixed number of seconds.
 *
 * @module dsh-screen-recorder/tools/record
 */
import { dirname } from 'node:path'
import { capabilities, checkNeeds } from '../core/caps.mjs'
import { ensureDir, resolveCwd } from '../core/env.mjs'
import { MAX_RECORD_SECONDS, audioPlan as audioRecordPlan, capture, screenPlan } from '../core/record.mjs'
import {
  CWD_PROPERTY,
  ScreenPluginError,
  TIMEOUT_PROPERTY,
  defineFamilyTool,
  optionalBoolean,
  optionalObject,
  requirePositiveNumber,
  requireString,
} from './shared.mjs'

/** Every action `screen_record` dispatches. */
export const RECORD_ACTIONS = ['screen', 'microphone']

/**
 * Build the `screen_record` tool.
 *
 * @param {object} config - normalized plugin config.
 * @param {object} logger - the host plugin's logger.
 * @returns {object} a raw tool definition.
 */
export function createRecordTool(config, logger) {
  const where = 'screen_record'

  /**
   * Check the build can capture this way before the machine starts capturing.
   *
   * A missing `gdigrab` is discovered here, in milliseconds, instead of after a 30-second recording
   * that produced nothing.
   *
   * @param {{capture: string, encoders?: string[]}} needs - what the capture requires.
   * @returns {Promise<void>}
   * @throws {ScreenPluginError} when the build cannot do it.
   */
  const preflight = async (needs) => {
    const report = await capabilities(config)
    const verdict = checkNeeds(report, needs)
    if (!verdict.ok) {
      throw new ScreenPluginError(
        `这份 ffmpeg 构建缺少 ${verdict.missing.join('、')}，无法采集。\n` +
          '用 screen_setup {action:"install_ffmpeg"} 换一份带 gdigrab / dshow 的完整构建。',
      )
    }
  }

  /**
   * Resolve one path against the call's working directory.
   * @param {string} value - the caller's path, or undefined.
   * @param {object} context - the tool context.
   * @returns {string} an absolute path.
   */
  const pathOf = (value, context) => resolveCwd(config, value ?? context.cwd)

  return defineFamilyTool({
    name: 'screen_record',
    actions: RECORD_ACTIONS,
    extraProperties: {
      out: { type: 'string', description: 'Where to write the recording. The extension picks the container: .mp4 for a screen recording, .wav / .m4a for audio.' },
      seconds: { type: 'number', description: `How long to capture, in seconds. Required, and capped at ${MAX_RECORD_SECONDS} (one hour).` },
      fps: { type: 'number', description: 'screen: capture cadence. Default 15, which is plenty for screen content and half the CPU of 30.' },
      window: { type: 'string', description: 'screen: capture this window by title instead of the whole desktop. The window must stay open, or the recording ends early.' },
      region: { type: 'object', additionalProperties: true, description: 'screen: capture only a rectangle, {x, y, width, height} in screen pixels. Cannot be combined with "window".' },
      drawMouse: { type: 'boolean', description: 'screen: draw the pointer into the recording. Default true — a demo without a cursor is hard to follow.' },
      audioDevice: { type: 'string', description: 'screen: also capture this DirectShow audio device. The name must match screen_env {action:"devices"} exactly.' },
      device: { type: 'string', description: 'microphone: the DirectShow capture device name, exactly as screen_env {action:"devices"} reports it.' },
      video: { type: 'object', additionalProperties: true, description: 'screen: encoder settings. Defaults to libx264 veryfast crf 20 yuv420p, the right trade for screen content.' },
      audio: { type: 'object', additionalProperties: true, description: 'Audio encoder settings. Defaults to aac 160k stereo for a screen recording, 48 kHz mono for a microphone.' },
      rtBufferMb: { type: 'number', description: 'DirectShow real-time buffer in MB. Default 128; raise it when samples are dropped.' },
      keepPartial: { type: 'boolean', description: 'Keep the file even when the capture failed outright. Default false: a two-second mp4 that plays is worse than no file, because the next call happily analyses it.' },
      timeoutMs: TIMEOUT_PROPERTY,
      cwd: CWD_PROPERTY,
    },
    handlers: {
      /**
       * Record the screen, a window or a region.
       * @param {object} args - the tool arguments.
       * @param {object} context - the tool context.
       * @returns {Promise<object>} what was written, and how long it really is.
       */
      async screen(args, context) {
        const out = pathOf(requireString(args, 'out', `${where} screen`), context)
        const seconds = requirePositiveNumber(args, 'seconds', `${where} screen`)
        if (seconds > MAX_RECORD_SECONDS) throw new ScreenPluginError(`${where} screen: 一次最多录 ${MAX_RECORD_SECONDS} 秒；收到 ${seconds}。`)
        const hasAudio = typeof args.audioDevice === 'string' && args.audioDevice !== ''
        await preflight({ capture: 'gdigrab', encoders: hasAudio ? ['libx264', 'aac'] : ['libx264'] })

        const plan = screenPlan({
          out,
          seconds,
          fps: Number.isFinite(args.fps) ? args.fps : undefined,
          window: typeof args.window === 'string' ? args.window : undefined,
          region: optionalObject(args, 'region', `${where} screen`),
          drawMouse: optionalBoolean(args, 'drawMouse', true, `${where} screen`),
          audioDevice: hasAudio ? args.audioDevice : undefined,
          video: optionalObject(args, 'video', `${where} screen`) ?? {},
          audio: optionalObject(args, 'audio', `${where} screen`) ?? {},
          rtBufferMb: Number.isFinite(args.rtBufferMb) ? args.rtBufferMb : undefined,
        })
        ensureDir(dirname(out))
        logger.info(`dsh-screen-recorder: 开始录屏 ${seconds}s → ${out}`)

        const result = await capture(plan, {
          config,
          timeoutMs: Number.isFinite(args.timeoutMs) ? args.timeoutMs : plan.timeoutMs,
          keepPartial: optionalBoolean(args, 'keepPartial', false, `${where} screen`),
        })
        logger.info(`dsh-screen-recorder: 录屏结束，实际时长 ${result.durationSec ?? '?'}s（要求 ${seconds}s），帧数 ${result.frames ?? '?'}`)

        const verdict = result.capture.failed
          ? '录制进程没有正常结束；上面的测量说明文件里到底有多少内容。'
          : result.ok
            ? '录制时长、帧数与音频都符合要求。'
            : '录制结果与要求不一致，看 notes 里的原因。'
        return {
          ...result,
          action: 'screen',
          out,
          notes: [...result.notes, verdict],
        }
      },

      /**
       * Record from a microphone or another DirectShow capture device.
       * @param {object} args - the tool arguments.
       * @param {object} context - the tool context.
       * @returns {Promise<object>} what was written.
       */
      async microphone(args, context) {
        const out = pathOf(requireString(args, 'out', `${where} microphone`), context)
        const seconds = requirePositiveNumber(args, 'seconds', `${where} microphone`)
        if (seconds > MAX_RECORD_SECONDS) throw new ScreenPluginError(`${where} microphone: 一次最多录 ${MAX_RECORD_SECONDS} 秒；收到 ${seconds}。`)
        const device = requireString(args, 'device', `${where} microphone`)
        await preflight({ capture: 'dshow', encoders: [] })

        const plan = audioRecordPlan({
          out,
          seconds,
          device,
          audio: optionalObject(args, 'audio', `${where} microphone`) ?? {},
          rtBufferMb: Number.isFinite(args.rtBufferMb) ? args.rtBufferMb : undefined,
        })
        ensureDir(dirname(out))
        logger.info(`dsh-screen-recorder: 开始录音 ${seconds}s（${device}）→ ${out}`)

        const result = await capture(plan, {
          config,
          timeoutMs: Number.isFinite(args.timeoutMs) ? args.timeoutMs : plan.timeoutMs,
          keepPartial: optionalBoolean(args, 'keepPartial', false, `${where} microphone`),
        })
        return { ...result, action: 'microphone', out }
      },
    },
  })
}
