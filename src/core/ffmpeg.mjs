/**
 * Running ffmpeg: one queue, one timeout policy, one place where a failure becomes a sentence.
 *
 * Three things make this module worth having rather than calling `spawn` at each site:
 *
 * 1. **Concurrency is bounded.** Two encodes at once is where a desktop stops making progress on
 *    both; four makes every one of them slower and can drop frames during a capture. Every call
 *    goes through one queue, and the queue is reported so a status call can show it.
 * 2. **A timeout kills and says so.** Nothing here can run forever: a capture that overruns its own
 *    duration is hung, not slow. A timed-out process is killed and reported as `timedOut`, and the
 *    caller decides whether the partial file is deleted (the capture tools do).
 * 3. **Streaming is first class.** Frame-by-frame analysis of a one-hour recording cannot buffer
 *    its pixels, so `onStdoutChunk` hands raw bytes to the caller as they arrive and nothing is
 *    accumulated — which is also how a live capture would be measured.
 *
 * Arguments are always an **array**. There is no shell anywhere in this plugin, so a window title
 * containing `&` or a path containing a space is not a quoting problem.
 *
 * @module dsh-screen-recorder/core/ffmpeg
 */
import { spawn } from 'node:child_process'
import { requireTool } from './env.mjs'

/** Default per-process timeout. Ten minutes covers a long capture or a long analysis pass. */
export const DEFAULT_TIMEOUT_MS = 600000

/** How much stdout is buffered before the call is refused. Raw frames add up fast. */
export const DEFAULT_STDOUT_LIMIT = 256 * 1024 * 1024

/** Raised when ffmpeg, ffprobe or a capture input fails in a way the caller must act on. */
export class MediaError extends Error {
  /**
   * @param {string} message - what failed, in a sentence the caller can act on.
   * @param {object} [details] - the process facts that came with it.
   */
  constructor(message, details = {}) {
    super(message)
    this.name = 'MediaError'
    Object.assign(this, details)
  }
}

/** How many ffmpeg processes may run at once. */
let limit = 2

/** How many are running now. */
let active = 0

/** Callers waiting for a slot, oldest first. */
const waiting = []

/**
 * Set the concurrency limit.
 *
 * @param {number} value - how many processes may run at once; must be a positive integer.
 * @returns {void}
 * @throws {TypeError} when the value is not a positive integer.
 */
export function setMaxConcurrent(value) {
  if (!Number.isInteger(value) || value < 1) throw new TypeError('maxConcurrent 必须是正整数')
  limit = value
  // A raised limit may let queued callers through immediately.
  while (active < limit && waiting.length > 0) {
    active += 1
    waiting.shift()()
  }
}

/**
 * The queue's current state, for a report that has to be checkable.
 * @returns {{limit: number, active: number, waiting: number}} the state.
 */
export function concurrencyState() {
  return { limit, active, waiting: waiting.length }
}

/**
 * Wait for a slot in the queue.
 * @returns {Promise<void>} resolves when the slot is held by the caller.
 */
function acquire() {
  if (active < limit) {
    active += 1
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    waiting.push(resolve)
  })
}

/** Give a slot back, and let the next caller through. @returns {void} */
function release() {
  active -= 1
  const next = waiting.shift()
  if (next !== undefined && active < limit) {
    active += 1
    next()
  }
}

/**
 * The last few lines of stderr, which is where ffmpeg puts the one sentence that explains itself.
 *
 * @param {string} stderr - the full collected stderr.
 * @param {number} [lines] - how many lines to keep.
 * @returns {string} the tail, trimmed.
 */
export function stderrTail(stderr, lines = 6) {
  const kept = String(stderr)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '')
    .slice(-lines)
  return kept.join('\n')
}

/**
 * Run one process to completion under the queue, with a timeout and optional streaming.
 *
 * @param {string} binary - absolute path to the executable.
 * @param {string[]} args - the argument array, exactly as the process should receive it.
 * @param {object} [options] - the call.
 * @param {object} [options.config] - normalized plugin config, used to resolve paths.
 * @param {number} [options.timeoutMs] - give up after this long. Default {@link DEFAULT_TIMEOUT_MS}.
 * @param {(chunk: Buffer) => void} [options.onStdoutChunk] - stream stdout instead of buffering it.
 * @param {number} [options.stdoutLimit] - refuse to buffer more than this. Ignored when streaming.
 * @param {number[]} [options.tolerateExitCodes] - exit codes that are not failures.
 * @param {string} [options.label] - what to call this run in an error message.
 * @param {string} [options.cwd] - working directory for the process.
 * @param {AbortSignal} [options.signal] - caller cancellation.
 * @returns {Promise<{code: number, stdout: Buffer, stderr: string, elapsedMs: number, timedOut: boolean}>} the outcome.
 * @throws {MediaError} when the process fails, times out, or writes too much.
 */
export function runProcess(binary, args, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS
  const stdoutLimit = Number.isFinite(options.stdoutLimit) ? options.stdoutLimit : DEFAULT_STDOUT_LIMIT
  const tolerate = Array.isArray(options.tolerateExitCodes) ? options.tolerateExitCodes : []
  const label = typeof options.label === 'string' && options.label !== '' ? options.label : binary
  const streaming = typeof options.onStdoutChunk === 'function'
  const started = Date.now()

  return acquire().then(
    () =>
      new Promise((resolve, reject) => {
        let child
        try {
          child = spawn(binary, args, {
            windowsHide: true,
            cwd: typeof options.cwd === 'string' && options.cwd !== '' ? options.cwd : undefined,
            stdio: ['ignore', 'pipe', 'pipe'],
          })
        } catch (error) {
          release()
          reject(new MediaError(`${label} 无法启动：${error instanceof Error ? error.message : String(error)}`, { cause: error }))
          return
        }

        const chunks = []
        let buffered = 0
        let stderr = ''
        let settled = false
        let timedOut = false

        const timer = setTimeout(() => {
          timedOut = true
          child.kill()
        }, timeoutMs)

        const onAbort = () => {
          child.kill()
        }
        if (options.signal !== undefined) options.signal.addEventListener('abort', onAbort, { once: true })

        const finish = (fn) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (options.signal !== undefined) options.signal.removeEventListener('abort', onAbort)
          release()
          fn()
        }

        child.stdout.on('data', (chunk) => {
          if (streaming) {
            try {
              options.onStdoutChunk(chunk)
            } catch (error) {
              child.kill()
              finish(() =>
                reject(
                  new MediaError(`${label} 的 stdout 处理失败：${error instanceof Error ? error.message : String(error)}`, { cause: error }),
                ),
              )
            }
            return
          }
          buffered += chunk.length
          if (buffered > stdoutLimit) {
            child.kill()
            finish(() => reject(new MediaError(`${label} 的输出超过 ${stdoutLimit} 字节上限，已中止。`)))
            return
          }
          chunks.push(chunk)
        })

        child.stderr.on('data', (chunk) => {
          stderr += chunk.toString('utf8')
          // A process that chats forever would otherwise grow this without bound.
          if (stderr.length > 4 << 20) stderr = stderr.slice(-(2 << 20))
        })

        child.on('error', (error) => {
          finish(() =>
            reject(new MediaError(`${label} 启动失败：${error.message}`, { cause: error, elapsedMs: Date.now() - started })),
          )
        })

        child.on('close', (code) => {
          const elapsedMs = Date.now() - started
          if (timedOut) {
            finish(() =>
              reject(
                new MediaError(`${label} 超过 ${timeoutMs}ms 仍未结束，已杀掉。`, {
                  code,
                  stderr,
                  elapsedMs,
                  timedOut: true,
                }),
              ),
            )
            return
          }
          if (code !== 0 && !tolerate.includes(code)) {
            finish(() =>
              reject(
                new MediaError(`${label} 退出码 ${code}：\n${stderrTail(stderr)}`, { code, stderr, elapsedMs, timedOut: false }),
              ),
            )
            return
          }
          finish(() => resolve({ code, stdout: Buffer.concat(chunks), stderr, elapsedMs, timedOut: false }))
        })
      }),
  )
}

/**
 * Resolve the ffmpeg this plugin will run.
 *
 * @param {object} config - normalized plugin config.
 * @returns {{path: string, source: string, label: string}} the binary.
 * @throws {import('./env.mjs').FfmpegNotFound} when nothing on this machine can answer.
 */
export function requireFfmpeg(config = {}) {
  return requireTool('ffmpeg', config)
}

/**
 * Resolve the ffprobe this plugin will run.
 *
 * @param {object} config - normalized plugin config.
 * @returns {{path: string, source: string, label: string}} the binary.
 * @throws {import('./env.mjs').FfmpegNotFound} when nothing on this machine can answer.
 */
export function requireFfprobe(config = {}) {
  return requireTool('ffprobe', config)
}

/**
 * Run ffmpeg with an argument array.
 *
 * `-nostdin` and `-hide_banner` are prepended: the first stops a capture from stealing the parent's
 * standard input (which on Windows can silently end a recording), the second keeps the version
 * banner out of every captured stderr tail.
 *
 * @param {string[]} args - the ffmpeg arguments, one array entry each.
 * @param {object} [options] - as {@link runProcess}, plus `tolerateExitCodes`.
 * @returns {Promise<{code: number, stdout: Buffer, stderr: string, elapsedMs: number, timedOut: boolean}>} the outcome.
 * @throws {MediaError} when ffmpeg fails.
 */
export function runFfmpeg(args, options = {}) {
  const binary = requireFfmpeg(options.config ?? {})
  return runProcess(binary.path, ['-nostdin', '-hide_banner', ...args], {
    ...options,
    label: typeof options.label === 'string' && options.label !== '' ? options.label : 'ffmpeg',
  })
}

/**
 * Run ffprobe with an argument array.
 *
 * @param {string[]} args - the ffprobe arguments.
 * @param {object} [options] - as {@link runProcess}.
 * @returns {Promise<{code: number, stdout: Buffer, stderr: string, elapsedMs: number, timedOut: boolean}>} the outcome.
 * @throws {MediaError} when ffprobe fails.
 */
export function runFfprobe(args, options = {}) {
  const binary = requireFfprobe(options.config ?? {})
  return runProcess(binary.path, ['-hide_banner', ...args], {
    ...options,
    label: typeof options.label === 'string' && options.label !== '' ? options.label : 'ffprobe',
  })
}
