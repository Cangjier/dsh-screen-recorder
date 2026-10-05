/**
 * Fetching one large file, over whatever network this machine has.
 *
 * Provisioning is the only thing in this plugin that touches the network, and a 100–200 MB
 * download is exactly the operation that fails halfway. So this module does three things the
 * obvious `fetch().arrayBuffer()` does not:
 *
 * 1. **It streams to disk and hashes as it goes**, so a 200 MB zip never has to fit in memory
 *    twice (once for the body, once for the hash).
 * 2. **It resumes.** The partial file is kept as `<target>.part`; a second attempt asks for the
 *    rest with a `Range` header, and if the server ignores the range and starts over, the file is
 *    truncated rather than appended to.
 * 3. **It reports progress**, because a silent multi-minute download reads as a hang.
 *
 * Node 24 can route `fetch` through the standard proxy variables when `NODE_USE_ENV_PROXY` is
 * set; on a machine whose only route out is a proxy, a download that ignores `HTTPS_PROXY` fails
 * with a DNS error that says nothing about the proxy. So the variable is set here, at load time,
 * before any request exists to be routed.
 *
 * @module dsh-screen-recorder/core/net
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, statSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'

/** Raised when a download or an archive cannot be trusted or cannot be completed. */
export class InstallError extends Error {
  /**
   * @param {string} message - what failed, in terms a caller can act on.
   */
  constructor(message) {
    super(message)
    this.name = 'InstallError'
  }
}

/** Proxy variables Node's environment proxy support understands. */
const PROXY_VARIABLES = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']

/**
 * Which proxy variables are set right now.
 * @returns {string[]} the variable names that carry a value.
 */
export function proxyVariables() {
  return PROXY_VARIABLES.filter((name) => typeof process.env[name] === 'string' && process.env[name].trim() !== '')
}

// Read at load time on purpose: the proxy agent is built when the first request is made, and a
// variable set afterwards would have no effect on it.
if (process.env.NODE_USE_ENV_PROXY === undefined && proxyVariables().length > 0) {
  process.env.NODE_USE_ENV_PROXY = '1'
}

/**
 * Hash a file, streaming it so size does not matter.
 * @param {string} path - the file.
 * @returns {Promise<string>} the lowercase hex SHA-256.
 */
export async function sha256File(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

/**
 * Ask a URL what it is, without downloading it.
 * @param {string} url - the URL.
 * @param {number} [timeoutMs] - deadline. Default 30 seconds.
 * @returns {Promise<{ok: boolean, status: number, contentLength: number|null, finalUrl: string, error: string|null}>} the answer.
 */
export async function probeUrl(url, timeoutMs = 30_000) {
  try {
    const response = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
    const length = response.headers.get('content-length')
    return {
      ok: response.ok,
      status: response.status,
      contentLength: length === null ? null : Number(length),
      finalUrl: response.url,
      error: null,
    }
  } catch (error) {
    return { ok: false, status: 0, contentLength: null, finalUrl: url, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Download one file to disk, resuming a previous partial attempt when the server allows it.
 *
 * @param {object} options - the download.
 * @param {string} options.url - what to fetch.
 * @param {string} options.target - where to write it.
 * @param {(progress: {received: number, total: number|null, bytesPerSecond: number}) => void} [options.onProgress] - progress, at most a few times a second.
 * @param {number} [options.timeoutMs] - per-attempt deadline. Default 30 minutes.
 * @param {number} [options.minIntervalMs] - how often to report. Default 1500.
 * @returns {Promise<{url: string, path: string, bytes: number, sha256: string, resumedFrom: number, elapsedMs: number}>} what was written.
 * @throws {InstallError} when the download cannot be completed or the server answers with an error.
 */
export async function downloadFile(options) {
  const { url, target, onProgress } = options
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 30 * 60 * 1000
  const minIntervalMs = Number.isFinite(options.minIntervalMs) ? options.minIntervalMs : 1500
  const part = `${target}.part`
  const resumedFrom = existsSync(part) ? statSync(part).size : 0

  const headers = { 'User-Agent': 'dsh-screen-recorder', Accept: '*/*' }
  if (resumedFrom > 0) headers.Range = `bytes=${resumedFrom}-`

  const started = Date.now()
  let response
  try {
    response = await fetch(url, { redirect: 'follow', headers, signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    throw new InstallError(
      `下载失败：${error instanceof Error ? error.message : String(error)}\n` +
        `地址：${url}` +
        (proxyVariables().length > 0 ? `\n检测到代理变量 ${proxyVariables().join(', ')}；若代理需要认证，请先设置好再重试。` : ''),
    )
  }

  if (!response.ok && response.status !== 206) {
    throw new InstallError(`下载失败：HTTP ${response.status} ${response.statusText}\n地址：${url}`)
  }
  if (response.body === null) throw new InstallError(`下载失败：响应没有内容\n地址：${url}`)

  // A 200 to a ranged request means the server ignored the range: start the file over rather than
  // appending a second copy of the beginning to the first.
  const appending = resumedFrom > 0 && response.status === 206
  const declared = response.headers.get('content-length')
  const total = declared === null ? null : Number(declared) + (appending ? resumedFrom : 0)

  const hash = createHash('sha256')
  if (appending) await pipeline(createReadStream(part), hash)

  let received = appending ? resumedFrom : 0
  let lastReport = 0
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length
      hash.update(chunk)
      const now = Date.now()
      if (onProgress !== undefined && now - lastReport >= minIntervalMs) {
        lastReport = now
        const elapsed = (now - started) / 1000
        onProgress({
          received,
          total,
          bytesPerSecond: elapsed > 0 ? Math.round((received - (appending ? resumedFrom : 0)) / elapsed) : 0,
        })
      }
      callback(null, chunk)
    },
  })

  await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(part, { flags: appending ? 'a' : 'w' }))
  const digest = hash.digest('hex')

  if (total !== null && received !== total) {
    throw new InstallError(`下载不完整：收到 ${received} 字节，期望 ${total} 字节。部分文件已保留，重试会接着下载。`)
  }

  // The `.part` name becomes the destination only once the bytes are whole: an interrupted
  // download must never look like a finished file. A rename is atomic on the same volume, which
  // is where the part file always is.
  await rename(part, target)

  return { url, path: target, bytes: received, sha256: digest, resumedFrom, elapsedMs: Date.now() - started }
}
