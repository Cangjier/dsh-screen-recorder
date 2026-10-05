/**
 * Containers and codecs: a small, explicit table instead of a guess from the extension.
 *
 * A capture writes exactly two things — an H.264 screen recording and, when asked, an AAC audio
 * track — so this module covers the handful of containers people actually name and refuses the rest
 * with a sentence that says what is supported. Guessing (`.txt` → mp4?) is how a recording ends up
 * in a file nothing can open.
 *
 * Every choice is reported in the plan's `notes`, because "which codec did it pick for me" is a
 * question the caller should never have to answer by probing the result.
 *
 * @module dsh-screen-recorder/core/container
 */
import { extname } from 'node:path'

/** Raised when a container cannot hold what the caller asked for. */
export class ContainerError extends Error {
  /**
   * @param {string} message - what is wrong and what is supported.
   */
  constructor(message) {
    super(message)
    this.name = 'ContainerError'
  }
}

/**
 * The containers this plugin writes.
 *
 * `video` and `audio` are the default codec settings per container; `muxer` is what ffmpeg is told
 * to write. A container that cannot hold video (`audio: null`) or audio (`video: null`) is how the
 * capture tools know a `.wav` screen recording is a mistake before the machine starts recording.
 */
export const CONTAINERS = Object.freeze({
  mp4: { extensions: ['.mp4', '.m4v'], muxer: 'mp4', video: { codec: 'libx264', crf: 20, preset: 'veryfast', pixFmt: 'yuv420p' }, audio: { codec: 'aac', bitrate: '160k' } },
  mov: { extensions: ['.mov'], muxer: 'mov', video: { codec: 'libx264', crf: 20, preset: 'veryfast', pixFmt: 'yuv420p' }, audio: { codec: 'aac', bitrate: '160k' } },
  mkv: { extensions: ['.mkv'], muxer: 'matroska', video: { codec: 'libx264', crf: 20, preset: 'veryfast', pixFmt: 'yuv420p' }, audio: { codec: 'aac', bitrate: '160k' } },
  webm: { extensions: ['.webm'], muxer: 'webm', video: { codec: 'libvpx-vp9', crf: 32, pixFmt: 'yuv420p' }, audio: { codec: 'libopus', bitrate: '128k' } },
  wav: { extensions: ['.wav'], muxer: 'wav', video: null, audio: { codec: 'pcm_s16le', sampleRate: 48000, channels: 1 } },
  m4a: { extensions: ['.m4a'], muxer: 'ipod', video: null, audio: { codec: 'aac', bitrate: '160k', sampleRate: 48000, channels: 1 } },
  mp3: { extensions: ['.mp3'], muxer: 'mp3', video: null, audio: { codec: 'libmp3lame', bitrate: '192k', sampleRate: 48000, channels: 1 } },
})

/**
 * Which container a path names.
 *
 * @param {string} path - the output path.
 * @returns {{name: string, muxer: string, video: object|null, audio: object|null, extension: string}} the container.
 * @throws {ContainerError} when the extension is not one this plugin writes.
 */
export function containerFor(path) {
  const extension = extname(String(path)).toLowerCase()
  for (const [name, entry] of Object.entries(CONTAINERS)) {
    if (entry.extensions.includes(extension)) return { name, ...entry, extension }
  }
  const supported = Object.values(CONTAINERS).flatMap((entry) => entry.extensions).join(' / ')
  throw new ContainerError(`不认识的输出扩展名 ${extension === '' ? '(空)' : extension}：本插件会写 ${supported}。`)
}

/**
 * Build the video encoder arguments for one container.
 *
 * @param {object} settings - requested settings; anything omitted comes from the container.
 * @param {object} container - the result of {@link containerFor}.
 * @returns {{args: string[], notes: string[]}} the arguments and what was chosen.
 * @throws {ContainerError} when a video container was asked for and the container holds no video.
 */
export function videoArguments(settings, container) {
  if (container.video === null) throw new ContainerError(`${container.extension} 是音频容器，装不了画面。`)
  const merged = { ...container.video, ...prune(settings) }
  const args = ['-c:v', merged.codec]
  const notes = [`视频：${merged.codec}${merged.crf !== undefined ? ` crf ${merged.crf}` : ''}${merged.preset !== undefined ? ` ${merged.preset}` : ''}`]

  if (merged.bitrate !== undefined) {
    args.push('-b:v', String(merged.bitrate))
    notes.push(`视频码率上限 ${merged.bitrate}`)
  } else if (merged.crf !== undefined) {
    args.push('-crf', String(merged.crf))
  }
  if (merged.preset !== undefined) args.push('-preset', String(merged.preset))
  if (merged.pixFmt !== undefined) args.push('-pix_fmt', String(merged.pixFmt))
  if (merged.fps !== undefined) args.push('-r', String(merged.fps))
  if (merged.scale !== undefined) args.push('-vf', `scale=${merged.scale}`)
  return { args, notes }
}

/**
 * Build the audio encoder arguments for one container.
 *
 * @param {object} settings - requested settings; anything omitted comes from the container.
 * @param {object} container - the result of {@link containerFor}.
 * @returns {{args: string[], notes: string[]}} the arguments and what was chosen.
 * @throws {ContainerError} when the container holds no audio.
 */
export function audioArguments(settings, container) {
  if (container.audio === null) throw new ContainerError(`${container.extension} 装不了音频。`)
  const merged = { ...container.audio, ...prune(settings) }
  const args = ['-c:a', merged.codec]
  const notes = [`音频：${merged.codec}${merged.bitrate !== undefined ? ` ${merged.bitrate}` : ''}`]
  if (merged.bitrate !== undefined) args.push('-b:a', String(merged.bitrate))
  if (merged.sampleRate !== undefined) args.push('-ar', String(merged.sampleRate))
  if (merged.channels !== undefined) args.push('-ac', String(merged.channels))
  return { args, notes }
}

/**
 * Drop keys whose value is undefined, null or an empty string, so a caller can pass a settings object
 * with holes in it and still get the container's defaults.
 *
 * @param {object|undefined} settings - the requested settings.
 * @returns {object} the settings that were actually given.
 */
function prune(settings) {
  const out = {}
  for (const [key, value] of Object.entries(settings ?? {})) {
    if (value === undefined || value === null || value === '') continue
    out[key] = value
  }
  return out
}

/**
 * Whether a container needs `+faststart` so a player can start before the whole file arrives.
 *
 * @param {object} container - the result of {@link containerFor}.
 * @returns {boolean} true for the ISO base media family.
 */
export function needsFaststart(container) {
  return ['mp4', 'mov', 'ipod'].includes(container.muxer)
}
