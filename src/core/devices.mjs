/**
 * The capture devices this machine reports, by the exact name ffmpeg will accept.
 *
 * DirectShow names are the single most common cause of a recording that produces no sound: the name
 * ffmpeg wants is the device's own, including the parentheses and the language, and a name that
 * differs by one character is refused. So this module does not summarise or normalise — it lists.
 *
 * The command is unusual: `ffmpeg -list_devices` **prints to stderr and exits non-zero on purpose**,
 * which is why the exit code is tolerated here rather than treated as a failure. A caller who does
 * not know that reads the empty stdout and concludes there are no devices.
 *
 * @module dsh-screen-recorder/core/devices
 */
import { runFfmpeg } from './ffmpeg.mjs'

/**
 * Parse ffmpeg's DirectShow device listing.
 *
 * Each device is one quoted name followed by `(video)` or `(audio)`; the "Alternative name" lines
 * that follow belong to the device above them and are recorded as `alternative`, because a machine
 * with two identical microphones can only be told apart by that string.
 *
 * @param {string} text - ffmpeg's stderr for a `-list_devices` run.
 * @returns {{name: string, kind: 'video'|'audio', alternative: string|null}[]} the devices, in the order reported.
 */
export function parseDevices(text) {
  const devices = []
  for (const line of String(text).split('\n')) {
    const device = /"([^"]+)"\s*\((video|audio)\)/.exec(line)
    if (device !== null) {
      devices.push({ name: device[1], kind: device[2], alternative: null })
      continue
    }
    const alternative = /Alternative name\s+"([^"]+)"/.exec(line)
    if (alternative !== null && devices.length > 0) devices[devices.length - 1].alternative = alternative[1]
  }
  return devices
}

/**
 * List the DirectShow capture devices on this machine.
 *
 * @param {object} [config] - normalized plugin config.
 * @param {object} [options] - the call.
 * @param {number} [options.timeoutMs] - give up after this long.
 * @returns {Promise<{devices: object[], video: string[], audio: string[], notes: string[]}>} the devices.
 * @throws {import('./env.mjs').FfmpegNotFound} when there is no ffmpeg to ask.
 * @throws {import('./ffmpeg.mjs').MediaError} when the build has no dshow at all.
 */
export async function listDevices(config = {}, options = {}) {
  const result = await runFfmpeg(['-f', 'dshow', '-list_devices', 'true', '-i', 'dummy'], {
    config,
    timeoutMs: options.timeoutMs ?? 60_000,
    label: 'ffmpeg -list_devices',
    // Listing devices is the one thing ffmpeg does successfully by failing.
    tolerateExitCodes: [0, 1],
  })
  const devices = parseDevices(result.stderr)
  const notes = []
  if (devices.length === 0) {
    notes.push('没有列出任何 DirectShow 设备：要么这台机器确实没有采集设备，要么这份 ffmpeg 不带 dshow。')
  }
  const audio = devices.filter((device) => device.kind === 'audio')
  if (audio.length > 0) {
    notes.push('音频设备名必须一字不差地传给 screen_record；括号与语言都算在内。')
  }
  return {
    devices,
    video: devices.filter((device) => device.kind === 'video').map((device) => device.name),
    audio: audio.map((device) => device.name),
    notes,
  }
}
