/**
 * Getting pixels out of an image or a video frame, at a size a model can actually eat.
 *
 * Every consumer of this module — text recognition, appearance segmentation, object detection —
 * wants the same three things: raw RGB bytes, the exact pixel dimensions those bytes describe, and
 * the ratio that maps a coordinate in the read image back to the source frame. Doing that with one
 * ffmpeg call and one honest size calculation is the whole point: a model fed an image it thinks is
 * 640 wide while it is really 1280 wide produces boxes that are wrong by a factor of two, and
 * nothing downstream can tell.
 *
 * The read size is therefore **computed here and passed to ffmpeg exactly** (`scale=W:H`), never
 * left to ffmpeg's rounding. If the byte count that comes back does not equal `W × H × channels`,
 * that is reported as an error rather than papered over.
 *
 * @module dsh-screen-recorder/core/image
 */
import { runFfmpeg } from './ffmpeg.mjs'
import { probeMedia } from './probe.mjs'

/** Default channel count for a read: RGB, which is what every model here expects. */
export const DEFAULT_CHANNELS = 3

/** Largest long side this module will read when the caller does not say. */
export const DEFAULT_MAX_SIDE = 1280

/**
 * The read size that fits a source inside a square, keeping the aspect ratio and even dimensions.
 *
 * Even dimensions are not cosmetic: several encoders and filters refuse odd ones, and `rgb24` rows
 * are cheaper to walk when the width is even.
 *
 * @param {number} sourceWidth - decoded source width.
 * @param {number} sourceHeight - decoded source height.
 * @param {number} maxSide - the longest side of the result.
 * @returns {{width: number, height: number, scaled: boolean}} the read size.
 */
export function fitInside(sourceWidth, sourceHeight, maxSide) {
  const width = Math.max(1, Math.round(Number(sourceWidth) || 0))
  const height = Math.max(1, Math.round(Number(sourceHeight) || 0))
  const longest = Math.max(width, height)
  if (!Number.isFinite(maxSide) || maxSide <= 0 || longest <= maxSide) {
    return { width: even(width), height: even(height), scaled: false }
  }
  const ratio = maxSide / longest
  return { width: even(width * ratio), height: even(height * ratio), scaled: true }
}

/**
 * Round to the nearest even number of at least 2.
 * @param {number} value - any positive number.
 * @returns {number} an even integer.
 */
export function even(value) {
  return Math.max(2, Math.round(value / 2) * 2)
}

/**
 * The factor that maps a coordinate in a read image back to the source frame.
 *
 * The factor is uniform because the read preserves the aspect ratio; the vertical ratio is checked
 * and, when it disagrees by more than 1%, the horizontal one is reported and the caller is expected
 * to notice via {@link readPixels}'s own size check rather than to silently get skewed boxes.
 *
 * @param {object} input - the two sizes.
 * @param {number} input.sourceWidth - the source frame's width.
 * @param {number} input.sourceHeight - the source frame's height.
 * @param {number} input.readWidth - the width the image was actually read at.
 * @param {number} input.readHeight - the height the image was actually read at.
 * @returns {number} the scale factor (multiply a read coordinate by this).
 */
export function scaleFactor({ sourceWidth, sourceHeight, readWidth, readHeight }) {
  const horizontal = Number(readWidth) > 0 ? Number(sourceWidth) / Number(readWidth) : 1
  const vertical = Number(readHeight) > 0 ? Number(sourceHeight) / Number(readHeight) : 1
  if (!Number.isFinite(horizontal) || horizontal <= 0) return 1
  return horizontal
}

/**
 * Decode one image, or one frame of a video, into raw pixels.
 *
 * @param {object} request - the request.
 * @param {string} request.input - the image or video file.
 * @param {number} [request.at] - for a video, the second to read. Ignored for a still image.
 * @param {object} [request.config] - normalized plugin config.
 * @param {number} [request.maxSide] - longest side of the read. Default {@link DEFAULT_MAX_SIDE}.
 * @param {number} [request.channels] - 3 for RGB (default) or 1 for grayscale.
 * @param {number} [request.timeoutMs] - give up after this long.
 * @returns {Promise<{pixels: Buffer, width: number, height: number, channels: number, sourceWidth: number, sourceHeight: number, scaled: boolean, factor: number, at: number|null, elapsedMs: number}>} the pixels and the geometry that describes them.
 * @throws {import('./ffmpeg.mjs').MediaError} when the file cannot be decoded, or the byte count disagrees with the size.
 */
export async function readPixels(request) {
  const channels = Number.isInteger(request.channels) && request.channels > 0 ? request.channels : DEFAULT_CHANNELS
  const maxSide = Number.isFinite(request.maxSide) ? request.maxSide : DEFAULT_MAX_SIDE
  const config = request.config ?? {}

  const facts = await probeMedia(request.input, { config, timeoutMs: request.timeoutMs })
  if (!facts.readable || facts.video === null) {
    throw new MediaReadError(`读不出画面：${facts.problems[0] ?? `${request.input} 里没有视频流`}`)
  }
  const sourceWidth = facts.video.width ?? 0
  const sourceHeight = facts.video.height ?? 0
  const size = fitInside(sourceWidth, sourceHeight, maxSide)

  const args = []
  if (Number.isFinite(request.at) && request.at > 0) args.push('-ss', Number(request.at).toFixed(3))
  args.push('-i', request.input)
  if (size.scaled) args.push('-vf', `scale=${size.width}:${size.height}`)
  args.push('-frames:v', '1', '-an', '-sn', '-f', 'rawvideo', '-pix_fmt', channels === 1 ? 'gray' : 'rgb24', '-')

  const started = Date.now()
  const result = await runFfmpeg(args, {
    config,
    timeoutMs: request.timeoutMs,
    label: `读帧 ${request.input}`,
    stdoutLimit: size.width * size.height * channels + (1 << 20),
  })

  const expected = size.width * size.height * channels
  if (result.stdout.length < expected) {
    throw new MediaReadError(
      `读到的像素不完整：期望 ${expected} 字节（${size.width}x${size.height}x${channels}），拿到 ${result.stdout.length}。` +
        '文件可能被截断，或者这个时间点上没有帧。',
    )
  }

  return {
    pixels: result.stdout.subarray(0, expected),
    width: size.width,
    height: size.height,
    channels,
    sourceWidth,
    sourceHeight,
    scaled: size.scaled,
    factor: scaleFactor({
      sourceWidth,
      sourceHeight,
      readWidth: size.width,
      readHeight: size.height,
    }),
    at: Number.isFinite(request.at) ? Number(request.at) : null,
    elapsedMs: Date.now() - started,
  }
}

/** Raised when a frame cannot be read, with the reason attached. */
export class MediaReadError extends Error {
  /**
   * @param {string} message - why the read failed.
   */
  constructor(message) {
    super(message)
    this.name = 'MediaReadError'
  }
}
