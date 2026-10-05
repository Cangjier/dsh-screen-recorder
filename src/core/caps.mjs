/**
 * What this build of ffmpeg can actually do — asked before a capture starts, not after it fails.
 *
 * A missing `gdigrab` or `dshow` is discovered here in milliseconds, instead of after a 30-second
 * recording that produced nothing and a file nobody can open. The answers are cached per executable,
 * because the encoder list of a build does not change while it sits on disk.
 *
 * The one thing worth knowing about the implementation: ffmpeg prints these lists to **stdout** and
 * exits **0**, but `-devices` on some builds writes a line to stderr as well. Both are parsed, and
 * the report says which build answered, so "gdigrab is missing" is a claim about a named binary.
 *
 * @module dsh-screen-recorder/core/caps
 */
import { requireFfmpeg, runFfmpeg } from './ffmpeg.mjs'

/** Cache of capability reports, keyed by the executable path. */
const cache = new Map()

/**
 * Parse the rows of an ffmpeg list (`-encoders`, `-filters`, `-devices`).
 *
 * The formats differ slightly but each row puts the identifier in the second column; a header line
 * and the legend at the bottom are skipped by shape rather than by position.
 *
 * @param {string} text - the command's output.
 * @returns {string[]} the identifiers found, in order.
 */
export function parseList(text) {
  const names = []
  for (const line of String(text).split('\n')) {
    const trimmed = line.trimEnd()
    if (trimmed === '' || trimmed.startsWith('Encoders:') || trimmed.startsWith('Filters:') || trimmed.startsWith('Devices:')) continue
    if (/^-+$/.test(trimmed.trim())) continue
    const match = /^\s*[A-Z.]{1,6}\s+(\S+)/.exec(trimmed)
    if (match !== null) {
      names.push(match[1])
      continue
    }
    // `-devices` rows carry no flags column: ` D  dshow           DirectShow capture`.
    const device = /^\s*[A-Z]{1,3}\s{2,}(\S+)/.exec(trimmed)
    if (device !== null) names.push(device[1])
  }
  return [...new Set(names)]
}

/**
 * Report what the resolved ffmpeg build supports.
 *
 * @param {object} [config] - normalized plugin config.
 * @param {object} [options] - the call.
 * @param {boolean} [options.refresh] - ignore the cache.
 * @returns {Promise<object>} the capability report.
 * @throws {import('./env.mjs').FfmpegNotFound} when no ffmpeg exists at all.
 */
export async function capabilities(config = {}, options = {}) {
  const binary = requireFfmpeg(config)
  const cached = cache.get(binary.path)
  if (cached !== undefined && options.refresh !== true) return cached

  const report = {
    path: binary.path,
    source: binary.source,
    label: binary.label,
    encoders: [],
    filters: [],
    devices: [],
    capture: { gdigrab: false, dshow: false },
    problems: [],
  }

  const ask = async (args, key) => {
    try {
      const result = await runFfmpeg(args, { config, timeoutMs: 30_000, label: `ffmpeg ${args.join(' ')}` })
      const names = parseList(result.stdout.toString('utf8'))
      report[key] = names
      return names
    } catch (error) {
      report.problems.push(`ffmpeg ${args.join(' ')} 失败：${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
      return []
    }
  }

  await ask(['-encoders'], 'encoders')
  await ask(['-filters'], 'filters')
  const devices = await ask(['-devices'], 'devices')
  report.capture.gdigrab = devices.includes('gdigrab')
  report.capture.dshow = devices.includes('dshow')

  // A build that can capture is the whole point of this plugin; say so once, here.
  if (!report.capture.gdigrab) report.problems.push('这份构建没有 gdigrab：屏幕录制不可用。')
  if (!report.capture.dshow) report.problems.push('这份构建没有 dshow：麦克风与系统声音录制不可用。')

  cache.set(binary.path, report)
  return report
}

/** Forget the cached capability reports. For tests, and after installing a new build. @returns {void} */
export function resetCapabilityCache() {
  cache.clear()
}

/**
 * Check a report against what one action needs.
 *
 * @param {object} report - the result of {@link capabilities}.
 * @param {object} needs - what is required.
 * @param {'gdigrab'|'dshow'} [needs.capture] - a capture device that must be present.
 * @param {string[]} [needs.encoders] - encoder names that must be present.
 * @param {string[]} [needs.filters] - filter names that must be present.
 * @returns {{ok: boolean, missing: string[]}} the verdict.
 */
export function checkNeeds(report, needs = {}) {
  const missing = []
  if (needs.capture !== undefined && report.capture?.[needs.capture] !== true) missing.push(needs.capture)
  for (const encoder of needs.encoders ?? []) {
    if (!report.encoders.includes(encoder)) missing.push(encoder)
  }
  for (const filter of needs.filters ?? []) {
    if (!report.filters.includes(filter)) missing.push(filter)
  }
  return { ok: missing.length === 0, missing }
}
