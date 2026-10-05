/**
 * Provisioning a private ffmpeg, so a machine that has none can still work.
 *
 * This plugin does not *need* its own build — a sibling checkout's, `DSH_FFMPEG`, or PATH all
 * work, and a fresh clone usually finds one of them. The installer exists for the machine where
 * none of those is true, and for the operator who wants the build to stop changing under them.
 *
 * That second motive is why the default source is a **version-pinned** archive with a published
 * SHA-256 that is enforced. A `latest` build is convenient and unverifiable: the bytes legitimately
 * change, so a digest can only be recorded, never checked. Both are offered, and the answer always
 * says which one was installed and whether its digest was proven or merely noted.
 *
 * The extractor is deliberately narrow: only the entries whose base name is one of the wanted
 * executables are written, paths that are absolute or contain `..` are refused, and methods other
 * than stored/deflated are refused rather than guessed at. A hostile or malformed archive
 * therefore cannot write outside the vendor directory.
 *
 * @module dsh-screen-recorder/core/install
 */
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SHARED_FFMPEG_BIN, SHARED_FFMPEG_DIR } from './home.mjs'
import { resetToolCache, resolveTool, vendoredState } from './env.mjs'
import { InstallError, sha256File } from './net.mjs'
// The download goes through this plugin's own downloader rather than net.mjs's fetch directly:
// it adds the curl-plus-proxy second path that a Windows machine behind a local proxy needs.
import { downloadToFile as downloadFile } from './download.mjs'

/** The executables taken out of an archive. */
export const WANTED_BINARIES = ['ffmpeg.exe', 'ffprobe.exe', 'ffplay.exe']

/**
 * Known builds.
 *
 * `gyan-release` is first because it is version-pinned and publishes a digest: installing it twice
 * on two machines produces the same executables, and a download that does not match the digest is
 * refused instead of run. `btbn-latest` is the newest BtbN GPL build — useful when a newer codec is
 * needed, but its bytes move, so its digest is only recorded.
 */
export const FFMPEG_SOURCES = {
  'gyan-release': {
    id: 'gyan-release',
    label: 'gyan.dev 9.0.2 essentials（版本固定，校验 SHA-256）',
    version: '9.0.2-essentials',
    url: 'https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip',
    sha256: '60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba',
    enforced: true,
    notes: ['静态构建，含 libx264 / libx265 / libvpx / gdigrab / dshow。'],
  },
  'btbn-latest': {
    id: 'btbn-latest',
    label: 'BtbN master latest win64-gpl（最新，仅记录摘要）',
    version: 'latest',
    url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
    sha256: null,
    enforced: false,
    notes: ['tag 是 latest，字节会变，所以只记录摘要、不强制校验。'],
  },
}

/** The source used when the caller names none. */
export const DEFAULT_SOURCE = 'gyan-release'

/**
 * Find the end-of-central-directory record in a zip file.
 *
 * Scanned from the end because an archive comment makes the offset variable. Signature `PK\x05\x06`.
 *
 * @param {Buffer} buffer - the whole archive.
 * @returns {{centralOffset: number, centralSize: number, entryCount: number}|null} the record.
 */
export function findEndOfCentralDirectory(buffer) {
  const minimumOffset = Math.max(0, buffer.length - 66_000)
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== 0x06054b50) continue
    return {
      entryCount: buffer.readUInt16LE(offset + 10),
      centralSize: buffer.readUInt32LE(offset + 12),
      centralOffset: buffer.readUInt32LE(offset + 16),
    }
  }
  return null
}

/**
 * Extract the wanted executables from a zip archive.
 *
 * @param {string} archivePath - the archive.
 * @param {string} targetDir - where the executables are written.
 * @param {object} [options] - extraction options.
 * @param {string[]} [options.wanted] - base names to take. Default {@link WANTED_BINARIES}.
 * @param {(message: string) => void} [options.onProgress] - progress notes.
 * @returns {Promise<string[]>} the file names written, in archive order.
 * @throws {InstallError} when the archive is unreadable, unsafe, or holds none of the wanted files.
 */
export async function extractBinaries(archivePath, targetDir, options = {}) {
  const wanted = options.wanted ?? WANTED_BINARIES
  const buffer = await readFile(archivePath)
  const eocd = findEndOfCentralDirectory(buffer)
  if (eocd === null) throw new InstallError(`不是有效的 zip 文件：${archivePath}`)

  const { inflateRawSync } = await import('node:zlib')
  mkdirSync(targetDir, { recursive: true })

  const written = []
  let offset = eocd.centralOffset
  for (let index = 0; index < eocd.entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const uncompressedSize = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    offset += 46 + nameLength + extraLength + commentLength

    const base = name.split('/').pop()
    if (!wanted.includes(base)) continue
    // Only the base name is used, but a name that could escape the destination means the archive
    // is not the one that was expected, so it is refused rather than normalized.
    if (name.startsWith('/') || name.includes('..') || name.includes('\\')) {
      throw new InstallError(`压缩包里的路径不可信：${name}`)
    }
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new InstallError(`压缩包结构损坏（本地头缺失）：${name}`)
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const raw = buffer.subarray(dataStart, dataStart + compressedSize)

    let contents
    if (method === 0) contents = raw
    else if (method === 8) contents = inflateRawSync(raw)
    else throw new InstallError(`不支持的压缩方式 ${method}：${name}`)
    if (contents.length !== uncompressedSize) {
      throw new InstallError(`解压后大小不符（${contents.length} != ${uncompressedSize}）：${name}，压缩包可能已损坏。`)
    }

    writeFileSync(join(targetDir, base), contents)
    written.push(base)
    options.onProgress?.(`解压 ${base}（${(contents.length / 1024 / 1024).toFixed(1)} MB）`)
  }

  if (written.length === 0) {
    throw new InstallError(`压缩包里没有 ${wanted.join(' / ')}；下载到的可能是错误的构建。`)
  }
  return written
}

/**
 * Install a build into this plugin's vendor directory.
 *
 * @param {object} [options] - install options.
 * @param {string} [options.source] - a key of {@link FFMPEG_SOURCES}.
 * @param {boolean} [options.force] - reinstall even when a build is present.
 * @param {string} [options.archive] - use this local zip instead of downloading.
 * @param {boolean} [options.allowDigestMismatch] - accept a download whose digest differs from the pinned one.
 * @param {(message: string) => void} [options.onProgress] - progress notes.
 * @returns {Promise<object>} what was installed, and whether the digest was proven.
 * @throws {InstallError} when the source is unknown, the download fails, or verification fails.
 */
export async function installFfmpeg(options = {}) {
  const state = vendoredState()
  if (state.present && options.force !== true) {
    return {
      installed: false,
      reason: `${state.directory} 里已经有可执行文件，没有重新下载；要覆盖请传 force:true。`,
      vendor: state,
      digest: { verified: state.source?.verified ?? null, sha256: state.source?.sha256 ?? null },
    }
  }

  const sourceId = typeof options.source === 'string' && options.source !== '' ? options.source : DEFAULT_SOURCE
  const source = FFMPEG_SOURCES[sourceId]
  if (source === undefined) {
    throw new InstallError(`未知的 source ${JSON.stringify(sourceId)}；可选：${Object.keys(FFMPEG_SOURCES).join(', ')}。`)
  }

  // One shared build for the whole family: this is the only place a copy is written, and a
  // sibling plugin reading the same directory is the point rather than a collision.
  const targetDir = SHARED_FFMPEG_DIR
  const targetBinDir = SHARED_FFMPEG_BIN
  mkdirSync(targetDir, { recursive: true })
  const scratch = join(targetDir, 'download.zip')
  let archivePath = scratch
  let bytes = null
  let digest = null
  let usedUrl = source.url

  if (typeof options.archive === 'string' && options.archive !== '') {
    if (!existsSync(options.archive)) throw new InstallError(`指定的本地压缩包不存在：${options.archive}`)
    archivePath = options.archive
    usedUrl = `file:${options.archive}`
    bytes = statSync(archivePath).size
    digest = await sha256File(archivePath)
    options.onProgress?.(`使用本地压缩包 ${archivePath}（${(bytes / 1024 / 1024).toFixed(1)} MB）`)
  } else {
    options.onProgress?.(`下载 ${source.label}`)
    options.onProgress?.(usedUrl)
    const download = await downloadFile({
      url: source.url,
      target: scratch,
      onProgress: (progress) => {
        if (options.onProgress === undefined) return
        const total = progress.total === null ? '?' : (progress.total / 1024 / 1024).toFixed(1)
        options.onProgress(
          `已下载 ${(progress.received / 1024 / 1024).toFixed(1)} / ${total} MB（${(progress.bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s）`,
        )
      },
    })
    bytes = download.bytes
    digest = download.sha256
    if (download.resumedFrom > 0) options.onProgress?.(`续传自 ${(download.resumedFrom / 1024 / 1024).toFixed(1)} MB`)
  }

  // The digest is checked before anything is unpacked, so a truncated or substituted archive never
  // reaches the extractor.
  let verified = null
  if (source.sha256 !== null) {
    verified = digest === source.sha256
    if (!verified && options.allowDigestMismatch !== true) {
      rmSync(scratch, { force: true })
      throw new InstallError(
        `${source.label} 的 SHA-256 与固定值不符，已拒绝安装。\n` +
          `期望：${source.sha256}\n实际：${digest}\n` +
          `上游重新打包过、或者下载被中间人改过。确认来源可信后可以传 allowDigestMismatch:true 继续，或改用 source:"btbn-latest"。`,
      )
    }
    options.onProgress?.(verified ? `SHA-256 校验通过：${digest}` : `SHA-256 不符但被明确接受：${digest}`)
  } else {
    options.onProgress?.(`该来源不提供固定摘要，仅记录：${digest}`)
  }

  rmSync(targetBinDir, { recursive: true, force: true })
  const files = await extractBinaries(archivePath, targetBinDir, { onProgress: options.onProgress })
  if (archivePath === scratch) rmSync(scratch, { force: true })

  const record = {
    source: source.id,
    label: source.label,
    version: source.version,
    url: usedUrl,
    bytes,
    sha256: digest,
    pinnedSha256: source.sha256,
    verified,
    files,
    installedAt: new Date().toISOString(),
    notes: source.notes,
    ownedBy: 'dsh-screen-recorder',
    sharedWith: ['dsh-video-audio', 'video-factory', 'dsh-ocr', 'dsh-tts', 'dsh-computer-use'],
  }
  writeFileSync(join(targetDir, 'SOURCE.json'), `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8' })
  resetToolCache()

  return { installed: true, ...record, vendor: vendoredState() }
}

/**
 * Delete this plugin's private build from the shared home.
 *
 * The whole shared `ffmpeg/` tree goes, because it belongs to this plugin: the other five read it
 * and none of them install it. Removing the shared build therefore breaks all six until one of
 * them reinstalls it, which is what the caller is asking for.
 *
 * @returns {{removed: boolean, directory: string}} whether anything was there.
 */
export function removeFfmpeg() {
  const existed = existsSync(SHARED_FFMPEG_DIR)
  if (existed) rmSync(SHARED_FFMPEG_DIR, { recursive: true, force: true })
  resetToolCache()
  return { removed: existed, directory: SHARED_FFMPEG_DIR }
}

/**
 * What an install would do right now, without doing it.
 *
 * @param {object} [options] - `{ source, ffmpegPath, ffprobePath }`.
 * @returns {object} the state of the private build, the known sources, and the binary that would answer.
 */
export function installState(options = {}) {
  const state = vendoredState()
  return {
    vendor: state,
    shared: state.shared,
    resolved: {
      ffmpeg: resolveTool('ffmpeg', options),
      ffprobe: resolveTool('ffprobe', options),
    },
    sources: Object.values(FFMPEG_SOURCES).map((source) => ({
      id: source.id,
      label: source.label,
      url: source.url,
      pinnedSha256: source.sha256,
      enforced: source.enforced,
    })),
    defaultSource: DEFAULT_SOURCE,
    wanted: WANTED_BINARIES,
    scratchBudgetBytes: 260 * 1024 * 1024,
    note: '解压只需要 ffmpeg.exe / ffprobe.exe / ffplay.exe，压缩包本身解压后会删掉。',
  }
}
