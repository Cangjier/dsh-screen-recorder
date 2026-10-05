/**
 * Capturing the screen, a window, a region, or a microphone — and then measuring what was captured.
 *
 * Recording is the one operation whose input is the machine itself, which makes it the one that
 * fails in ways no argument validation can prevent: a window that closes mid-capture, a device that
 * is busy, a busy CPU that drops frames, a resolution the encoder refuses. So the plan here is
 * conservative on purpose —
 *
 * - a **fixed duration** is required, so a capture can never run forever;
 * - both capture inputs get a `thread_queue_size` and an `rtbufsize`, because the default queue is
 *   the usual cause of "it recorded 3 of the 10 seconds and then stalled";
 * - the dimensions are only forced when the caller forces them, since gdigrab refuses a `video_size`
 *   the desktop cannot satisfy;
 * - and the result is **measured**: the length actually written is compared with the length asked
 *   for, the frames are counted by decoding the file, and a short take is reported as a short take
 *   rather than as a success.
 *
 * The measurement is the half that makes this module worth having. `ffmpeg` exiting 0 means the
 * process ended, not that ten seconds of screen exist in the file.
 *
 * @module dsh-screen-recorder/core/record
 */
import { rmSync } from 'node:fs'
import { ContainerError, audioArguments, containerFor, needsFaststart, videoArguments } from './container.mjs'
import { longPath } from './env.mjs'
import { runFfmpeg, runFfprobe } from './ffmpeg.mjs'
import { probeMedia } from './probe.mjs'

/** Longest capture this plugin will plan, in seconds. */
export const MAX_RECORD_SECONDS = 3600

/** Default capture cadence. Screen content changes far slower than film, and 15 fps halves the CPU. */
export const DEFAULT_CAPTURE_FPS = 15

/** A take shorter than this fraction of the request is reported as short. */
export const SHORT_TAKE_RATIO = 0.9

/**
 * Escape a value that goes inside an ffmpeg option string.
 *
 * With an argument array there is no shell, but ffmpeg's own parser still treats `:` and `\`
 * specially inside `key=value` inputs, and a window title is exactly the kind of string that
 * contains them.
 *
 * @param {string} value - the raw value.
 * @returns {string} the escaped value.
 */
export function escapeOptionValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'")
}

/**
 * Plan a screen or window capture.
 *
 * @param {object} request - the request.
 * @param {string} request.out - the output file.
 * @param {number} request.seconds - how long to capture.
 * @param {number} [request.fps] - capture cadence. Default 15.
 * @param {{x?: number, y?: number, width: number, height: number}} [request.region] - capture this rectangle instead of the whole desktop.
 * @param {string} [request.window] - capture this window title instead of the desktop.
 * @param {boolean} [request.drawMouse] - draw the pointer. Default true; it is usually the point of a demo recording.
 * @param {string} [request.audioDevice] - a DirectShow audio device name, from `screen_env {action:"devices"}`.
 * @param {object} [request.video] - codec settings.
 * @param {object} [request.audio] - codec settings.
 * @param {number} [request.rtBufferMb] - DirectShow real-time buffer, in MB. Default 128.
 * @returns {{args: string[], out: string, notes: string[], expect: object, timeoutMs: number, expectedDurationSec: number}} the plan.
 * @throws {import('./container.mjs').ContainerError} when the output cannot hold a recording.
 * @throws {import('./ffmpeg.mjs').MediaError} when the request is not captureable.
 */
export function screenPlan(request) {
  const { out } = request
  const container = containerFor(out)
  if (container.video === null) throw new ContainerError(`屏幕录制要写视频容器；${out} 不是。`)
  const seconds = Number(request.seconds)
  if (!Number.isFinite(seconds) || seconds <= 0) throw new RecordError('屏幕录制必须给出正数的秒数（seconds）。')
  if (seconds > MAX_RECORD_SECONDS) {
    throw new RecordError(`一次最多录 ${MAX_RECORD_SECONDS} 秒（1 小时）；收到 ${seconds}。分成几段录，或者用更长的工具。`)
  }
  const fps = Number.isFinite(request.fps) ? request.fps : DEFAULT_CAPTURE_FPS
  if (fps <= 0 || fps > 60) throw new RecordError(`录制帧率必须在 0–60 之间；收到 ${request.fps}`)
  if (request.window !== undefined && request.region !== undefined) {
    throw new RecordError('window 与 region 只能选一个：抓窗口时不能同时指定矩形。')
  }

  const notes = []
  const args = []

  // The queue is raised on both inputs: gdigrab hands frames over while libx264 is still working,
  // and the default queue is small enough that a busy machine starts dropping instead of waiting.
  args.push('-thread_queue_size', '512')
  if (typeof request.window === 'string' && request.window !== '') {
    args.push('-f', 'gdigrab', '-framerate', String(fps), '-i', `title=${escapeOptionValue(request.window)}`)
    notes.push(`抓窗口「${request.window}」：窗口关掉或最小化，录制会提前结束。`)
  } else {
    args.push('-f', 'gdigrab', '-framerate', String(fps))
    if (request.region !== undefined && request.region !== null) {
      const { x = 0, y = 0, width, height } = request.region
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new RecordError('region 需要 width 与 height（正整数），x/y 可选，默认 0。')
      }
      args.push('-offset_x', String(Math.round(x)), '-offset_y', String(Math.round(y)), '-video_size', `${Math.round(width)}x${Math.round(height)}`)
      notes.push(`只录屏幕上的 ${Math.round(width)}x${Math.round(height)} @ (${Math.round(x)},${Math.round(y)})。`)
    } else {
      notes.push('录整个桌面（含所有显示器组成的虚拟桌面）。')
    }
    args.push('-draw_mouse', request.drawMouse === false ? '0' : '1')
    args.push('-i', 'desktop')
  }

  const hasAudio = typeof request.audioDevice === 'string' && request.audioDevice !== ''
  if (hasAudio) {
    const rtBufferMb = Number.isFinite(request.rtBufferMb) ? request.rtBufferMb : 128
    args.push('-thread_queue_size', '512', '-rtbufsize', `${rtBufferMb}M`, '-f', 'dshow', '-i', `audio=${escapeOptionValue(request.audioDevice)}`)
    notes.push(`同时录 ${request.audioDevice}；设备名要和 screen_env {action:"devices"} 报的完全一致。`)
  } else {
    notes.push('只录画面，没有声音。')
  }

  args.push('-t', String(seconds))
  const video = videoArguments({ codec: 'libx264', preset: 'veryfast', crf: 20, ...(request.video ?? {}) }, container)
  args.push(...video.args)
  notes.push(...video.notes)

  if (hasAudio) {
    const audio = audioArguments({ bitrate: '160k', ...(request.audio ?? {}) }, container)
    args.push(...audio.args)
    notes.push(...audio.notes)
  } else {
    args.push('-an')
  }

  if (needsFaststart(container)) args.push('-movflags', '+faststart')
  args.push(longPath(out))

  return {
    args,
    out,
    notes,
    expect: { video: true, audio: hasAudio },
    // A capture that overruns its own duration by a minute is hung, not slow.
    timeoutMs: Math.round(seconds * 1000) + 60_000,
    expectedDurationSec: seconds,
  }
}

/**
 * Plan an audio-only capture from a DirectShow device.
 *
 * @param {object} request - `{ out, seconds, device, sampleRate, channels, bitrate, codec, rtBufferMb }`.
 * @returns {{args: string[], out: string, notes: string[], expect: object, timeoutMs: number, expectedDurationSec: number}} the plan.
 * @throws {RecordError} when the request is not captureable.
 */
export function audioPlan(request) {
  const { out, device } = request
  const container = containerFor(out)
  if (container.audio === null) throw new RecordError(`${out} 不是音频容器。`)
  const seconds = Number(request.seconds)
  if (!Number.isFinite(seconds) || seconds <= 0) throw new RecordError('录音必须给出正数的秒数（seconds）。')
  if (seconds > MAX_RECORD_SECONDS) throw new RecordError(`一次最多录 ${MAX_RECORD_SECONDS} 秒；收到 ${seconds}。`)
  if (typeof device !== 'string' || device === '') {
    throw new RecordError('录音需要 device：先用 screen_env {action:"devices"} 看本机能录哪些设备。')
  }
  const rtBufferMb = Number.isFinite(request.rtBufferMb) ? request.rtBufferMb : 128
  const args = [
    '-thread_queue_size', '512',
    '-rtbufsize', `${rtBufferMb}M`,
    '-f', 'dshow',
    '-i', `audio=${escapeOptionValue(device)}`,
    '-t', String(seconds),
    '-map', '0:a:0',
  ]
  const audio = audioArguments({ sampleRate: 48000, channels: 1, bitrate: '160k', ...(request.audio ?? {}) }, container)
  args.push(...audio.args)
  args.push('-vn', longPath(out))

  return {
    args,
    out,
    notes: [
      `从「${device}」录 ${seconds} 秒。`,
      'DirectShow 的设备名区分中英文与括号，必须和列出来的一字不差。',
      '录不到声音时先看设备是否被别的程序独占（会议软件、录音机都会抢占）。',
    ],
    expect: { video: false, audio: true },
    timeoutMs: Math.round(seconds * 1000) + 60_000,
    expectedDurationSec: seconds,
  }
}

/**
 * Measure a capture by decoding it.
 *
 * Counting frames is what separates "the process exited 0" from "the file holds what was asked for".
 * The frame count comes from a real decode (`-count_frames`), not from the container's own claim,
 * so a capture that stopped early is visible even when its header was written optimistically.
 *
 * @param {object} request - the measurement.
 * @param {string} request.path - the file that was written.
 * @param {number} request.requestedSeconds - what was asked for.
 * @param {boolean} [request.expectAudio] - whether an audio track was requested.
 * @param {object} [request.config] - normalized plugin config.
 * @param {number} [request.timeoutMs] - give up after this long.
 * @returns {Promise<object>} the measurements and the notes they justify.
 */
export async function measureCapture(request) {
  const facts = await probeMedia(request.path, { config: request.config, timeoutMs: request.timeoutMs })
  const notes = []
  if (!facts.readable) {
    return {
      path: request.path,
      readable: false,
      durationSec: null,
      frames: null,
      audio: null,
      requestedSeconds: request.requestedSeconds,
      shortTake: null,
      ok: false,
      notes: [...facts.problems, '这次录制没有可读的结果，按失败处理。'],
    }
  }

  let frames = null
  try {
    const counted = await runFfprobe(
      ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'json', request.path],
      { config: request.config, timeoutMs: request.timeoutMs, label: 'ffprobe 数帧' },
    )
    const parsed = JSON.parse(counted.stdout.toString('utf8'))
    const raw = parsed?.streams?.[0]?.nb_read_frames
    frames = raw === undefined ? null : Number(raw)
    if (!Number.isFinite(frames)) frames = null
  } catch (error) {
    notes.push(`数帧失败（文件可能被截断）：${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  }

  const durationSec = facts.durationSec
  const shortTake = durationSec === null ? null : durationSec < request.requestedSeconds * SHORT_TAKE_RATIO
  const audioExpected = request.expectAudio === true
  const audioPresent = facts.audio !== null

  if (durationSec === null) notes.push('读不出时长：这次录制可能没有正常结束。')
  else if (shortTake) {
    notes.push(
      `实际只录到 ${durationSec.toFixed(2)}s，比要求的 ${request.requestedSeconds}s 短：` +
        '窗口被关掉、屏幕锁定、设备被占用，或者编码跟不上（降低 fps 或分辨率）。',
    )
  } else notes.push(`实际时长 ${durationSec.toFixed(2)}s，与要求的 ${request.requestedSeconds}s 一致。`)

  if (audioExpected && !audioPresent) notes.push('要求了声音，但文件里没有音频流：设备可能被别的程序独占。')
  if (!audioExpected && audioPresent) notes.push('没有要求声音，文件里却有音频流。')
  if (frames !== null && facts.video?.fps !== null && facts.video?.fps !== undefined) {
    const expectedFrames = Math.round((durationSec ?? 0) * facts.video.fps)
    if (expectedFrames > 0) {
      const ratio = frames / expectedFrames
      if (ratio < 0.9) notes.push(`解码出 ${frames} 帧，按时长与帧率应有约 ${expectedFrames} 帧：录制过程中掉帧了。`)
    }
  }

  return {
    path: request.path,
    readable: true,
    container: facts.container,
    sizeBytes: facts.sizeBytes,
    durationSec,
    requestedSeconds: request.requestedSeconds,
    video: facts.video,
    audio: facts.audio,
    frames,
    shortTake,
    ok: !shortTake && facts.readable && (!audioExpected || audioPresent) && (frames === null || frames > 0),
    notes,
  }
}

/**
 * Run a capture plan and measure what it wrote.
 *
 * This is the one function in the plugin that starts a capture. Deleting a failed take is deliberate:
 * a half-written mp4 that plays for two seconds is worse than no file, because the next call happily
 * analyses it.
 *
 * @param {object} plan - the result of {@link screenPlan} or {@link audioPlan}.
 * @param {object} options - the call.
 * @param {object} options.config - normalized plugin config.
 * @param {number} [options.timeoutMs] - overrides the plan's own timeout.
 * @param {boolean} [options.keepPartial] - keep the file even when the capture failed.
 * @param {(event: object) => void} [options.onProgress] - progress events.
 * @returns {Promise<object>} the measurement, plus `capture: {args, code, elapsedMs}` for the record.
 */
export async function capture(plan, options) {
  const started = Date.now()
  options.onProgress?.({ phase: 'capturing', out: plan.out, seconds: plan.expectedDurationSec })
  let process = null
  let failure = null
  try {
    process = await runFfmpeg(plan.args, {
      config: options.config,
      timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : plan.timeoutMs,
      label: '录屏',
    })
  } catch (error) {
    failure = error
  }

  const measured = await measureCapture({
    path: plan.out,
    requestedSeconds: plan.expectedDurationSec,
    expectAudio: plan.expect.video === false ? true : plan.expect.audio,
    config: options.config,
    timeoutMs: options.timeoutMs,
  })

  const elapsedMs = Date.now() - started
  if (failure !== null && measured.durationSec === null && options.keepPartial !== true) {
    removeQuietly(plan.out)
    throw failure
  }

  return {
    ...measured,
    // A take that measured well but whose process failed is still not a good take.
    ok: measured.ok && failure === null,
    plan: { args: plan.args, notes: plan.notes, expect: plan.expect },
    capture: { code: process?.code ?? null, elapsedMs, failed: failure !== null, error: failure === null ? null : String(failure.message).split('\n')[0] },
    notes: [...plan.notes, ...measured.notes],
  }
}

/**
 * Delete a file, and say nothing when it is not there.
 *
 * A half-written capture that plays for two seconds is worse than no file at all: the next call
 * happily analyses it and reports a two-second recording as the truth.
 *
 * @param {string} path - the file to remove.
 * @returns {void}
 */
function removeQuietly(path) {
  try {
    rmSync(path, { force: true })
  } catch {
    // A file that cannot be removed is not worth failing a capture over; the measurement already
    // says the take is bad.
  }
}

/** Raised when a capture cannot be planned. */
export class RecordError extends Error {
  /**
   * @param {string} message - what was refused and why.
   */
  constructor(message) {
    super(message)
    this.name = 'RecordError'
  }
}
