/**
 * Getting a file onto this machine, including the case that breaks first: a proxy Node does not know
 * about.
 *
 * `fetch` is the fast path and needs nothing else installed. It is also the path that fails, with a
 * bare "fetch failed", on the very common Windows setup where the machine reaches the internet
 * through a local proxy configured in the system settings — Node's fetch does **not** read those
 * settings, deliberately and by default, while PowerShell and every browser do. The result is a
 * machine where `Invoke-WebRequest` downloads a model happily and an installer that cannot.
 *
 * So there is a second path: `curl.exe`, which ships with Windows 10 and later, is told the proxy
 * explicitly, and is only reached after `fetch` has failed. The proxy itself is read from the
 * environment first (where an operator would put it) and then from the WinINET registry, which is
 * where the "Proxy server" checkbox in Windows settings actually writes.
 *
 * Nothing here verifies a digest: verification belongs to the caller, which knows which digest it
 * pinned. This module's whole job is to make the bytes arrive, and to say **how** they arrived.
 *
 * @module dsh-screen-recorder/core/download
 */
import { spawnSync } from 'node:child_process'
import { existsSync, renameSync, rmSync, statSync } from 'node:fs'
import { InstallError, downloadFile, proxyVariables, sha256File } from './net.mjs'

/** curl is part of Windows; this is the name it is on PATH under. */
export const CURL_EXE = 'curl.exe'

/** Cache of the resolved proxy, so the registry is read at most once per process. */
let proxyCache = null

/**
 * The proxy Windows itself is configured to use, if any.
 *
 * Read through `reg.exe` rather than a Node library because the settings live in the registry and a
 * `reg query` is one cheap process. Every failure mode (no `reg`, no key, the setting off) means the
 * same thing: no proxy to offer, and the caller proceeds without one.
 *
 * @returns {{server: string, source: 'registry'}|null} the proxy, or null.
 */
export function systemProxy() {
  if (proxyCache !== null) return proxyCache
  proxyCache = null
  if (process.platform !== 'win32') return proxyCache
  try {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
    const enable = spawnSync('reg.exe', ['query', key, '/v', 'ProxyEnable'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
    if (enable.status !== 0 || !/ProxyEnable\s+REG_DWORD\s+0x1/i.test(enable.stdout ?? '')) return proxyCache
    const server = spawnSync('reg.exe', ['query', key, '/v', 'ProxyServer'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
    const match = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(server.stdout ?? '')
    if (server.status !== 0 || match === null) return proxyCache
    proxyCache = { server: withScheme(match[1]), source: 'registry' }
  } catch {
    proxyCache = null
  }
  return proxyCache
}

/**
 * Give a bare `host:port` the scheme curl and Node both need.
 *
 * @param {string} value - the registry's spelling, for example `127.0.0.1:7897`.
 * @returns {string} a URL, for example `http://127.0.0.1:7897`.
 */
function withScheme(value) {
  const trimmed = String(value).trim()
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed
  // A per-protocol list is a legal registry value; the first entry is the one that matters here.
  const first = trimmed.split(';')[0].trim()
  if (first.includes('=')) {
    const [, afterEquals] = first.split('=')
    return withScheme(afterEquals ?? '')
  }
  return `http://${first}`
}

/**
 * The proxy to try, environment first.
 *
 * @returns {{server: string, source: 'env'|'registry'}|null} the proxy, or null when there is none.
 */
export function proxyFor() {
  const fromEnv = proxyVariables()
  if (fromEnv.length > 0) {
    const value = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy
    if (typeof value === 'string' && value.trim() !== '') return { server: withScheme(value), source: 'env' }
  }
  return systemProxy()
}

/**
 * Forget the cached proxy. For tests, and after a settings change. @returns {void}
 */
export function resetProxyCache() {
  proxyCache = null
}

/**
 * Run curl, with the proxy if there is one.
 *
 * `-C -` makes curl resume a partial file rather than restart it, which matters on the two-hundred-
 * megabyte ffmpeg archive; `--fail` keeps an HTML error page from being saved as if it were a build.
 *
 * @param {object} request - the download.
 * @returns {{ok: boolean, status: number|null, stderr: string}} the outcome.
 */
function curlDownload(request) {
  const part = `${request.target}.part`
  const args = ['-L', '--fail', '--silent', '--show-error', '--retry', '2', '--connect-timeout', '20']
  if (request.proxy !== null) args.push('--proxy', request.proxy.server)
  if (existsSync(part) && statSync(part).size > 0) args.push('-C', '-')
  args.push('-o', part, request.url)
  const result = spawnSync(CURL_EXE, args, { encoding: 'utf8', windowsHide: true, timeout: request.timeoutMs ?? 30 * 60 * 1000 })
  return { ok: result.status === 0, status: result.status, stderr: `${result.stderr ?? ''}${result.error === undefined ? '' : String(result.error)}`.trim() }
}

/**
 * Download a file, by whichever path this machine can actually use.
 *
 * @param {object} request - the download.
 * @param {string} request.url - what to fetch.
 * @param {string} request.target - where to write it. A `.part` file is used and renamed on success.
 * @param {(progress: {received: number, total: number|null, bytesPerSecond: number}) => void} [request.onProgress] - fetch-path progress.
 * @param {number} [request.timeoutMs] - give up after this long.
 * @param {boolean} [request.allowCurl] - use the curl fallback. Default true.
 * @returns {Promise<{path: string, bytes: number, sha256: string, via: 'fetch'|'curl', proxy: object|null, firstError: string|null}>} what arrived, and how.
 * @throws {InstallError} when neither path works.
 */
export async function downloadToFile(request) {
  const target = request.target
  const proxy = proxyFor()
  const part = `${target}.part`
  let firstError = null

  try {
    const result = await downloadFile({ url: request.url, target, onProgress: request.onProgress, timeoutMs: request.timeoutMs })
    return { path: target, bytes: result.bytes ?? statSync(target).size, sha256: result.sha256 ?? (await sha256File(target)), via: 'fetch', proxy: null, firstError: null }
  } catch (error) {
    firstError = error instanceof Error ? error.message.split('\n')[0] : String(error)
  }

  if (request.allowCurl === false) throw new InstallError(`${firstError}\n地址：${request.url}`)

  // The fetch path is the one that knows about proxies; the curl path is the one that can be told.
  const available = spawnSync(CURL_EXE, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
  if (available.status !== 0) {
    throw new InstallError(
      `下载失败：${firstError}\n地址：${request.url}\n` +
        `这台机器上没有可用的 ${CURL_EXE}，无法走第二条路。` +
        (proxy === null ? '' : `系统代理是 ${proxy.server}（${proxy.source}），把它写进 HTTPS_PROXY 再试。`) +
        '\n也可以下载好之后用 "archive" 参数传本地文件。',
    )
  }

  const viaCurl = curlDownload({ url: request.url, target, proxy, timeoutMs: request.timeoutMs })
  if (!viaCurl.ok || !existsSync(part) || statSync(part).size === 0) {
    throw new InstallError(
      `下载失败：fetch 与 curl 都没成功。\n地址：${request.url}\n` +
        `fetch：${firstError}\ncurl：退出码 ${viaCurl.status}${viaCurl.stderr === '' ? '' : ` ${viaCurl.stderr.split('\n')[0]}`}\n` +
        (proxy === null
          ? '没有检测到系统代理；如果这台机器必须走代理，请设置 HTTPS_PROXY。'
          : `试过的代理：${proxy.server}（${proxy.source}）。`) +
        '\n也可以下载好之后用 "archive" 参数传本地文件。',
    )
  }

  rmSync(target, { force: true })
  renameSync(part, target)
  return { path: target, bytes: statSync(target).size, sha256: await sha256File(target), via: 'curl', proxy, firstError }
}

/** Re-exported so a caller can name the same error type the downloader throws. */
export { InstallError }
