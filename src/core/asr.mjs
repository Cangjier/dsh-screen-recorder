/**
 * Speech to text, through the recogniser the Host already has.
 *
 * The recogniser is not this plugin's to own: DSH publishes a `speechToText` service with a local
 * SenseVoice provider behind it, and this module is the adapter between a screen recording and that
 * service. Two host constraints shape all of it:
 *
 * 1. **The input must be canonical 16 kHz mono PCM16 WAV.** The host validates the header and
 *    rejects anything else, so the conversion is not optional — and neither is the header repair
 *    below, because ffmpeg leaves the `data` chunk's size at a placeholder when it writes to a path.
 * 2. **One request carries at most 4 MB** (about 131 seconds). Longer material must be split, and
 *    split at a natural pause, because cutting by byte offset lands mid-word.
 *
 * What this module adds to the sibling implementation is *alignment*: a screen recording is worth
 * transcribing because the words can be attached to a moment on the timeline. So instead of one
 * long transcript, the audio is cut into **speech intervals** found by `silencedetect`, each interval
 * is transcribed on its own, and every interval comes back with the `start`/`end` it covers. A
 * sentence therefore lands on the segment where it was actually said.
 *
 * @module dsh-screen-recorder/core/asr
 */
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runFfmpeg } from './ffmpeg.mjs'

/** Sample rate the host requires. */
export const SAMPLE_RATE = 16_000

/** Bytes per second of 16 kHz mono PCM16 audio. */
export const BYTES_PER_SECOND = SAMPLE_RATE * 2

/** The host's default per-request cap. */
export const DEFAULT_MAX_AUDIO_BYTES = 4 * 1024 * 1024

/** How much quieter than the peak a region must be to count as silence, in dB. */
export const SILENCE_NOISE_DB = -35

/** How long a quiet stretch must last to be a usable cut point, in seconds. */
export const SILENCE_MIN_SECONDS = 0.35

/** Speech shorter than this is treated as a click or a cough, not a sentence. */
export const MIN_SPEECH_SECONDS = 0.25

/** Silence longer than this ends a speech interval even if the level never fully drops. */
export const MAX_INTERVAL_SECONDS = 25

/** Raised when audio cannot be prepared or transcribed. */
export class TranscribeError extends Error {
  /**
   * @param {string} message - what failed and what to do about it.
   */
  constructor(message) {
    super(message)
    this.name = 'TranscribeError'
  }
}

/**
 * Whether the Host is offering a recogniser right now.
 *
 * @param {object} request - the call.
 * @param {object} [request.service] - the host's `speechToText` service, when one is published.
 * @returns {{available: boolean, provider: string|null, reason: string|null, installHint: string|null}} the state.
 */
export function asrState(request = {}) {
  const service = request.service
  if (service === undefined || service === null) {
    return {
      available: false,
      provider: null,
      reason: '宿主没有提供 speechToText 服务，语音转文字不可用。',
      installHint:
        '在「设置 → 插件管理」里启用 @deepseek-ai/dsh-experimental-voice-input-bundle，然后重启 DSH。' +
        '结构里的其它部分（时间轴、文字、区域、物体）不依赖它。',
    }
  }
  return { available: true, provider: 'host:speechToText', reason: null, installHint: null }
}

/**
 * Rewrite a WAV's length fields so they agree with the file, by walking its chunks.
 *
 * The layout is not the textbook 44-byte header: ffmpeg inserts a `LIST` chunk holding metadata
 * before `data`, and writing a size into a fixed offset therefore lands inside a chunk identifier and
 * destroys the file. The `data` chunk is located by walking the chunk list instead.
 *
 * @param {string} path - a canonical 16 kHz mono PCM16 WAV to repair in place.
 * @returns {{dataOffset: number, dataBytes: number, headerBytes: number}} what was found.
 * @throws {TranscribeError} when the file is not a usable WAV.
 */
export function repairWavHeader(path) {
  const total = statSync(path).size
  const head = Buffer.alloc(Math.min(total, 4096))
  const handle = openSync(path, 'r+')
  try {
    const read = readSync(handle, head, 0, head.length, 0)
    if (read < 12) throw new TranscribeError(`WAV 头不完整：${path}`)
    if (head.subarray(0, 4).toString('ascii') !== 'RIFF' || head.subarray(8, 12).toString('ascii') !== 'WAVE') {
      throw new TranscribeError(`不是 WAV 文件：${path}`)
    }

    let cursor = 12
    let dataOffset = -1
    while (cursor + 8 <= read) {
      const id = head.subarray(cursor, cursor + 4).toString('ascii')
      const size = head.readUInt32LE(cursor + 4)
      if (id === 'data') {
        dataOffset = cursor + 8
        break
      }
      // Chunks are word-aligned, so an odd size carries one byte of padding.
      cursor += 8 + size + (size % 2)
    }
    if (dataOffset < 0) throw new TranscribeError(`WAV 里没有 data chunk：${path}`)

    const dataBytes = total - dataOffset
    if (dataBytes <= 0) throw new TranscribeError(`WAV 没有音频数据：${path}`)

    const field = Buffer.alloc(4)
    field.writeUInt32LE(total - 8, 0)
    writeSync(handle, field, 0, 4, 4)
    field.writeUInt32LE(dataBytes, 0)
    writeSync(handle, field, 0, 4, dataOffset - 4)
    return { dataOffset, dataBytes, headerBytes: dataOffset }
  } finally {
    closeSync(handle)
  }
}

/**
 * Convert any media file to canonical 16 kHz mono PCM16 WAV.
 *
 * @param {string} source - the media file.
 * @param {string} target - destination `.wav` path.
 * @param {object} [options] - conversion options.
 * @param {object} [options.config] - normalized plugin config.
 * @returns {Promise<{path: string, seconds: number, bytes: number}>} what was written.
 * @throws {TranscribeError} when conversion fails.
 */
export async function toCanonicalWav(source, target, options = {}) {
  try {
    await runFfmpeg(['-i', source, '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-c:a', 'pcm_s16le', '-f', 'wav', target], {
      config: options.config ?? {},
      timeoutMs: 30 * 60 * 1000,
      label: '音频转 16k 单声道',
    })
  } catch (error) {
    throw new TranscribeError(
      `音频转换失败（${source}）：${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
    )
  }
  const repaired = repairWavHeader(target)
  const bytes = statSync(target).size
  return { path: target, seconds: repaired.dataBytes / BYTES_PER_SECOND, bytes }
}

/**
 * Parse ffmpeg's `silencedetect` output into silence intervals.
 *
 * @param {string} stderr - ffmpeg's standard error for a silencedetect run.
 * @returns {{start: number, end: number|null}[]} detected silences, in order.
 */
export function parseSilences(stderr) {
  const silences = []
  for (const line of String(stderr).split('\n')) {
    const start = /silence_start:\s*(-?[\d.]+)/.exec(line)
    if (start !== null) {
      silences.push({ start: Number(start[1]), end: null })
      continue
    }
    const end = /silence_end:\s*(-?[\d.]+)/.exec(line)
    if (end !== null && silences.length > 0) silences[silences.length - 1].end = Number(end[1])
  }
  return silences.filter((entry) => entry.start >= 0)
}

/**
 * Turn silences into the speech intervals between them.
 *
 * This is what makes a transcript alignable: each interval is a stretch where someone was talking,
 * bounded by pauses, so the recogniser is never handed a cut that lands in the middle of a word —
 * and the text it returns can be attached to those exact seconds.
 *
 * @param {object} request - the intervals' source.
 * @param {number} request.durationSec - the audio's length.
 * @param {{start: number, end: number|null}[]} request.silences - detected pauses.
 * @param {number} [request.minSpeechSec] - drop intervals shorter than this. Default 0.25.
 * @param {number} [request.maxIntervalSec] - force a cut inside an interval longer than this. Default 25.
 * @returns {{start: number, end: number, seconds: number}[]} the speech intervals, in order.
 */
export function speechIntervals(request) {
  const duration = Number(request.durationSec)
  if (!Number.isFinite(duration) || duration <= 0) return []
  const minSpeech = Number.isFinite(request.minSpeechSec) ? request.minSpeechSec : MIN_SPEECH_SECONDS
  const maxInterval = Number.isFinite(request.maxIntervalSec) ? request.maxIntervalSec : MAX_INTERVAL_SECONDS

  const silences = (Array.isArray(request.silences) ? request.silences : [])
    .filter((entry) => Number.isFinite(entry.start))
    .map((entry) => ({
      start: Math.max(0, Number(entry.start)),
      end: Math.min(duration, Number.isFinite(entry.end) ? Number(entry.end) : duration),
    }))
    .filter((entry) => entry.end > entry.start)
    .sort((a, b) => a.start - b.start)

  const intervals = []
  let cursor = 0
  const push = (start, end) => {
    // A long stretch with no pause in it still has to be cut somewhere: a recogniser handed three
    // minutes at once simply refuses.
    let from = start
    while (end - from > maxInterval) {
      const to = from + maxInterval
      intervals.push({ start: round(from), end: round(to), seconds: round(to - from) })
      from = to
    }
    if (end - from >= minSpeech) intervals.push({ start: round(from), end: round(end), seconds: round(end - from) })
  }

  for (const silence of silences) {
    if (silence.start > cursor) push(cursor, silence.start)
    cursor = Math.max(cursor, silence.end)
  }
  if (cursor < duration) push(cursor, duration)
  return intervals.filter((entry, index, all) => index === 0 || entry.start >= all[index - 1].end - 1e-6)
}

/**
 * Round to four decimals, which is finer than a frame at any sane frame rate.
 * @param {number} value - the seconds.
 * @returns {number} the rounded value.
 */
function round(value) {
  return Number(value.toFixed(4))
}

/**
 * Choose cut points so that every resulting piece fits the byte budget.
 *
 * @param {object} input - the request.
 * @param {number} input.totalSeconds - the full audio length.
 * @param {{start: number, end: number|null}[]} input.silences - detected pauses.
 * @param {number} input.maxBytes - the per-request byte budget.
 * @param {number} [input.leadSeconds] - how far back from the limit to look for a pause.
 * @returns {{cuts: number[], forced: number}} cut points in seconds, and how many were forced.
 */
export function planCuts({ totalSeconds, silences, maxBytes, leadSeconds = 25 }) {
  const maxSeconds = maxBytes / BYTES_PER_SECOND
  const cuts = []
  let forced = 0
  let cursor = 0

  while (totalSeconds - cursor > maxSeconds) {
    const limit = cursor + maxSeconds
    const window = limit - leadSeconds
    const candidates = silences
      .map((silence) => silence.start)
      .filter((start) => start > cursor + maxSeconds * 0.25 && start <= limit && start >= window)
    if (candidates.length > 0) {
      const chosen = Math.max(...candidates)
      cuts.push(chosen)
      cursor = chosen
    } else {
      cuts.push(limit)
      cursor = limit
      forced += 1
    }
  }
  return { cuts, forced }
}

/**
 * Find the pauses in a recording's audio.
 *
 * @param {string} wav - a canonical 16 kHz mono PCM16 WAV.
 * @param {object} [config] - normalized plugin config.
 * @returns {Promise<{silences: {start: number, end: number|null}[], stderr: string}>} the pauses.
 */
async function detectSilencesIn(wav, config) {
  // `silencedetect` only reports to stderr, and a nonzero exit is normal when the input is quiet
  // enough to contain no speech at all.
  try {
    const probe = await runFfmpeg(
      ['-i', wav, '-af', `silencedetect=noise=${SILENCE_NOISE_DB}dB:d=${SILENCE_MIN_SECONDS}`, '-f', 'null', '-'],
      { config, timeoutMs: 30 * 60 * 1000, label: 'silencedetect', tolerateExitCodes: [0, 1] },
    )
    return { silences: parseSilences(probe.stderr), stderr: probe.stderr }
  } catch (error) {
    const stderr = error instanceof Error && 'stderr' in error ? String(error.stderr) : ''
    return { silences: parseSilences(stderr), stderr }
  }
}

/**
 * Extract a time range to its own WAV file.
 *
 * The range is re-encoded rather than stream-copied. Copying PCM cannot be done from an arbitrary
 * offset: the container is re-muxed while the header still describes the whole original, so the
 * piece arrives with a header that disagrees with its own data length and the recogniser reads it as
 * a fraction of a second long.
 *
 * @param {string} source - canonical WAV to cut from.
 * @param {number} from - start offset in seconds.
 * @param {number} to - end offset in seconds.
 * @param {string} target - destination path.
 * @param {object} [config] - normalized plugin config.
 * @returns {Promise<void>} resolves when written.
 */
async function cutRange(source, from, to, target, config) {
  await runFfmpeg(
    ['-ss', from.toFixed(3), '-i', source, '-t', (to - from).toFixed(3), '-ac', '1', '-ar', String(SAMPLE_RATE), '-c:a', 'pcm_s16le', '-f', 'wav', target],
    { config, timeoutMs: 10 * 60 * 1000, label: '切音频区间' },
  )
  repairWavHeader(target)
}

/**
 * Merge neighbouring intervals until there are few enough of them to be worth transcribing.
 *
 * A ten-minute narration can contain a hundred short pauses, and one recogniser request per pause
 * would spend more time in process overhead than in inference. Merging keeps the words — the text of
 * a merged interval still covers exactly the seconds it spans — at the cost of a coarser boundary,
 * which is reported rather than hidden.
 *
 * @param {{start: number, end: number, seconds: number}[]} intervals - the speech intervals.
 * @param {object} limits - the budgets.
 * @param {number} limits.maxIntervals - how many requests are acceptable.
 * @param {number} limits.maxSeconds - the longest a single request may be.
 * @returns {{intervals: {start: number, end: number, seconds: number, merged: number}[], dropped: number}} the plan.
 */
export function mergeIntervals(intervals, limits) {
  const maxIntervals = Math.max(1, Math.floor(limits.maxIntervals))
  const maxSeconds = Math.max(1, Number(limits.maxSeconds))
  const source = Array.isArray(intervals) ? [...intervals] : []

  // First pass: an interval longer than one request can carry is cut, not merged.
  const split = []
  for (const interval of source) {
    let from = interval.start
    while (interval.end - from > maxSeconds) {
      split.push({ start: from, end: from + maxSeconds, seconds: maxSeconds, merged: 1 })
      from += maxSeconds
    }
    if (interval.end - from > 0.01) split.push({ start: from, end: interval.end, seconds: interval.end - from, merged: 1 })
  }

  // Second pass: while there are too many, merge the closest pair.
  const merged = [...split]
  while (merged.length > maxIntervals) {
    let bestIndex = 0
    let bestCost = Infinity
    for (let index = 0; index + 1 < merged.length; index += 1) {
      const gap = merged[index + 1].start - merged[index].end
      const cost = gap + (merged[index].seconds + merged[index + 1].seconds) * 0.01
      if (cost < bestCost) {
        bestCost = cost
        bestIndex = index
      }
    }
    const left = merged[bestIndex]
    const right = merged[bestIndex + 1]
    const combined = { start: left.start, end: right.end, seconds: right.end - left.start, merged: left.merged + right.merged }
    if (combined.seconds > maxSeconds) {
      // Cannot merge these two without exceeding the request budget: stop rather than send a request
      // the host will refuse.
      break
    }
    merged.splice(bestIndex, 2, combined)
  }

  return { intervals: merged.map((entry) => ({ ...entry, seconds: round(entry.seconds), start: round(entry.start), end: round(entry.end) })), dropped: 0 }
}

/**
 * Transcribe a recording, interval by interval, so every sentence knows when it was said.
 *
 * @param {object} request - the request.
 * @param {string} request.source - the media file (video or audio).
 * @param {object} request.service - the host's `speechToText` service.
 * @param {string} [request.language] - a language hint; omit for automatic detection.
 * @param {number} [request.maxAudioBytes] - per-request byte budget. Defaults to 4 MB.
 * @param {number} [request.maxIntervals] - how many requests to spend at most.
 * @param {object} [request.config] - normalized plugin config.
 * @param {(event: object) => void} [request.onProgress] - progress events.
 * @param {AbortSignal} [request.signal] - caller cancellation.
 * @returns {Promise<object>} the intervals with their text, plus how it was obtained.
 * @throws {TranscribeError} when the recogniser is unavailable or the audio is unusable.
 */
export async function transcribeIntervals(request) {
  const state = asrState({ service: request.service })
  if (!state.available) throw new TranscribeError(`${state.reason}${state.installHint === null ? '' : ` ${state.installHint}`}`)

  const maxBytes = Number.isFinite(request.maxAudioBytes) ? request.maxAudioBytes : DEFAULT_MAX_AUDIO_BYTES
  const maxSeconds = maxBytes / BYTES_PER_SECOND
  const maxIntervals = Number.isFinite(request.maxIntervals) ? request.maxIntervals : 60
  const scratch = mkdtempSync(join(tmpdir(), 'dsr-asr-'))
  const full = join(scratch, 'full.wav')
  const started = Date.now()

  try {
    request.onProgress?.({ phase: 'converting' })
    const converted = await toCanonicalWav(request.source, full, { config: request.config })
    if (converted.seconds <= 0) throw new TranscribeError(`音频是空的：${request.source}`)

    request.onProgress?.({ phase: 'detecting-silence', seconds: Number(converted.seconds.toFixed(2)) })
    const { silences } = await detectSilencesIn(full, request.config)
    const found = speechIntervals({ durationSec: converted.seconds, silences })
    const plan = mergeIntervals(found, { maxIntervals, maxSeconds })

    const intervals = []
    let inferenceSeconds = 0
    for (const [index, interval] of plan.intervals.entries()) {
      const piece = join(scratch, `part-${String(index).padStart(4, '0')}.wav`)
      request.onProgress?.({ phase: 'transcribing', index: index + 1, total: plan.intervals.length, start: interval.start, end: interval.end })
      await cutRange(full, interval.start, interval.end, piece, request.config)
      const audio = new Uint8Array(readFileSync(piece))
      const spec = request.service.resolve({
        audio,
        ...(request.language === undefined || request.language === null || request.language === '' ? {} : { language: request.language }),
      })
      const transcript = await request.service.transcribe(spec, request.signal ?? new AbortController().signal)
      inferenceSeconds += Number(transcript.inferenceSeconds) || 0
      intervals.push({
        id: `a${String(index + 1).padStart(3, '0')}`,
        start: interval.start,
        end: interval.end,
        seconds: interval.seconds,
        merged: interval.merged,
        text: String(transcript.text ?? '').trim(),
        inferenceSeconds: Number(transcript.inferenceSeconds) || 0,
      })
      rmSync(piece, { force: true })
    }

    const notes = []
    if (plan.intervals.length < found.length) {
      notes.push(
        `检测到 ${found.length} 段语音，为了把识别请求控制在 ${maxIntervals} 次以内，合并成了 ${plan.intervals.length} 段：` +
          '文字仍然对，但边界比真实停顿粗。',
      )
    }
    if (found.length === 0) notes.push('整段录音没有检出语音：要么一直是静音，要么声音太轻（阈值为 -35 dB）。')

    return {
      source: request.source,
      provider: state.provider,
      language: request.language ?? null,
      durationSec: round(converted.seconds),
      text: intervals.map((interval) => interval.text).filter((text) => text !== '').join('\n'),
      intervals,
      detectedIntervals: found.length,
      requestedIntervals: plan.intervals.length,
      silenceCount: silences.length,
      inferenceSeconds: Number(inferenceSeconds.toFixed(3)),
      elapsedMs: Date.now() - started,
      notes,
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
