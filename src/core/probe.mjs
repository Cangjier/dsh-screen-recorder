/**
 * What a media file actually is — and the two problems worth noticing before anyone analyses it.
 *
 * Every answer here comes from ffprobe, and every field is reported as `null` when ffprobe did not
 * say. Nothing is guessed from a file extension: a `.mp4` that is a truncated capture is exactly the
 * case this module exists to catch, and an extension would have called it fine.
 *
 * The two derived facts that matter to the rest of the plugin:
 *
 * - **`durationSec`** is the container's declared length, not what a decode produced. Whether the
 *   two disagree is `ffmpeg_probe`-style work; a capture is measured after it is written instead
 *   (see `record.mjs`).
 * - **`video.width`/`video.height` are the *decoded* dimensions**, with any rotation the container
 *   carries already applied. Every coordinate this plugin reports is in that space, so a frame read
 *   at a smaller size can be scaled back by a plain ratio.
 *
 * @module dsh-screen-recorder/core/probe
 */
import { existsSync, statSync } from 'node:fs'
import { runFfprobe } from './ffmpeg.mjs'

/** Standard container/stream fields this module asks ffprobe for. */
const PROBE_ARGS = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams']

/**
 * Parse ffprobe's `r_frame_rate` (or `avg_frame_rate`) into a number.
 *
 * @param {string|undefined} value - a ratio such as `"30000/1001"`, or `"0/0"` when unknown.
 * @returns {number|null} frames per second, or null when it cannot be known.
 */
export function parseRate(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  const [top, bottom] = value.split('/')
  const numerator = Number(top)
  const denominator = bottom === undefined ? 1 : Number(bottom)
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null
  const rate = numerator / denominator
  return rate > 0 ? Number(rate.toFixed(6)) : null
}

/**
 * Rotation of a video stream, in degrees clockwise, as the container reports it.
 *
 * Two spellings are in the wild: a `rotate` tag on the stream, and a `displaymatrix` side datum with
 * a rotation. Both are read; a missing one means 0.
 *
 * @param {object} stream - one ffprobe stream object.
 * @returns {number} 0, 90, 180 or 270.
 */
export function rotationOf(stream) {
  const tagged = Number(stream?.tags?.rotate)
  if (Number.isFinite(tagged) && tagged !== 0) return ((Math.round(tagged) % 360) + 360) % 360
  const side = Array.isArray(stream?.side_data_list) ? stream.side_data_list : []
  for (const entry of side) {
    const rotation = Number(entry?.rotation)
    if (Number.isFinite(rotation) && rotation !== 0) return ((Math.round(-rotation) % 360) + 360) % 360
  }
  return 0
}

/**
 * Whether a video stream's frame rate is a constant one.
 *
 * @param {object} stream - one ffprobe stream object.
 * @returns {boolean|null} true when the two rates agree, null when ffprobe did not say.
 */
export function isConstantRate(stream) {
  const real = parseRate(stream?.r_frame_rate)
  const average = parseRate(stream?.avg_frame_rate)
  if (real === null || average === null) return null
  return Math.abs(real - average) < Math.max(0.01, real * 0.01)
}

/**
 * Probe one file.
 *
 * A file that ffprobe cannot read is not an exception here: it is a report whose `problems` explains
 * what is wrong, because a caller asking "what is this?" wants an answer, not a stack trace. The one
 * case that throws is a missing ffprobe, which no amount of retrying fixes.
 *
 * @param {string} path - the media file.
 * @param {object} [options] - the call.
 * @param {object} [options.config] - normalized plugin config.
 * @param {number} [options.timeoutMs] - give up after this long.
 * @returns {Promise<object>} the facts, with `problems` listing everything questionable.
 * @throws {import('./env.mjs').FfmpegNotFound} when ffprobe is not on this machine.
 */
export async function probeMedia(path, options = {}) {
  const problems = []
  if (!existsSync(path)) {
    return {
      path,
      exists: false,
      readable: false,
      sizeBytes: null,
      container: null,
      durationSec: null,
      bitrate: null,
      video: null,
      audio: null,
      streams: [],
      problems: [`文件不存在：${path}`],
    }
  }

  let payload = null
  let stderr = ''
  try {
    const result = await runFfprobe(['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path], {
      config: options.config ?? {},
      timeoutMs: options.timeoutMs,
      label: 'ffprobe',
    })
    payload = JSON.parse(result.stdout.toString('utf8'))
    stderr = result.stderr
  } catch (error) {
    stderr = error instanceof Error ? error.message : String(error)
  }

  if (payload === null) {
    problems.push(`ffprobe 读不了这个文件：${String(stderr).split('\n')[0]}`)
    return {
      path,
      exists: true,
      readable: false,
      sizeBytes: safeSize(path),
      container: null,
      durationSec: null,
      bitrate: null,
      video: null,
      audio: null,
      streams: [],
      problems,
    }
  }

  const streams = Array.isArray(payload.streams) ? payload.streams : []
  const format = payload.format ?? {}
  const videoStream = streams.find((stream) => stream.codec_type === 'video') ?? null
  const audioStream = streams.find((stream) => stream.codec_type === 'audio') ?? null
  const durationSec = numberOrNull(format.duration)

  if (streams.length === 0) problems.push('这个容器里没有任何流。')
  if (durationSec === null) problems.push('容器没有声明时长：录屏中途被打断时常见。')
  if (durationSec !== null && durationSec <= 0) problems.push(`容器声明的时长是 ${durationSec}s。`)

  let video = null
  if (videoStream !== null) {
    const rotation = rotationOf(videoStream)
    const codedWidth = numberOrNull(videoStream.width)
    const codedHeight = numberOrNull(videoStream.height)
    const swapped = rotation === 90 || rotation === 270
    const constant = isConstantRate(videoStream)
    video = {
      codec: videoStream.codec_name ?? null,
      profile: videoStream.profile ?? null,
      // Decoded dimensions: ffmpeg applies the container's rotation while decoding, and every
      // coordinate this plugin reports lives in that space.
      width: swapped ? codedHeight : codedWidth,
      height: swapped ? codedWidth : codedHeight,
      codedWidth,
      codedHeight,
      rotation,
      fps: parseRate(videoStream.avg_frame_rate) ?? parseRate(videoStream.r_frame_rate),
      rFps: parseRate(videoStream.r_frame_rate),
      constantRate: constant,
      pixelFormat: videoStream.pix_fmt ?? null,
      frameCount: numberOrNull(videoStream.nb_frames),
      durationSec: numberOrNull(videoStream.duration) ?? durationSec,
    }
    if (constant === false) problems.push('这个视频不是恒定帧率：按时间轴取帧的位置会比预期漂移。')
    if (video.width === null || video.height === null) problems.push('视频流没有宽度/高度。')
  }

  const audio = audioStream === null
    ? null
    : {
        codec: audioStream.codec_name ?? null,
        sampleRate: numberOrNull(audioStream.sample_rate),
        channels: numberOrNull(audioStream.channels),
        bitrate: numberOrNull(audioStream.bit_rate),
        durationSec: numberOrNull(audioStream.duration) ?? durationSec,
      }

  return {
    path,
    exists: true,
    readable: true,
    sizeBytes: safeSize(path),
    container: format.format_name ?? null,
    durationSec,
    bitrate: numberOrNull(format.bit_rate),
    video,
    audio,
    streams: streams.map((stream) => ({
      index: stream.index,
      type: stream.codec_type ?? null,
      codec: stream.codec_name ?? null,
    })),
    problems,
  }
}

/**
 * Read a number from an ffprobe field, which is a string when it is present at all.
 * @param {*} value - the raw field.
 * @returns {number|null} the number, or null.
 */
function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

/**
 * The size of a file, or null when it cannot be read.
 * @param {string} path - the file.
 * @returns {number|null} bytes.
 */
function safeSize(path) {
  try {
    return statSync(path).size
  } catch {
    return null
  }
}

/** Re-exported so callers do not have to know how the probe builds its argument list. */
export { PROBE_ARGS }
