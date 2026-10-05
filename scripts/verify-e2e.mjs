/**
 * End-to-end verification, run by hand (not part of the test suite because it records the real
 * screen and needs the real ffmpeg).
 *
 * It drives the plugin through its own registered tools, exactly as the harness would, and prints
 * what each step measured. Run from the plugin root:
 *
 *   node tmp/verify-e2e.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeConfig } from '../index.mjs'
import { registerTools } from '../src/tools/index.mjs'
import { runFfmpeg } from '../src/core/ffmpeg.mjs'
import { toCanonicalWav } from '../src/core/asr.mjs'

const config = normalizeConfig({})
const out = join(process.cwd(), 'tmp', 'e2e')
mkdirSync(out, { recursive: true })

const registered = []
const logger = {
  info: (message) => console.log(`  · ${String(message).replace(/^dsh-screen-recorder: /, '')}`),
  warn: (message) => console.log(`  ! ${message}`),
  error: (message) => console.log(`  × ${message}`),
}
registerTools({ tools: { register: (definition) => registered.push(definition) }, cwd: process.cwd(), get: () => undefined }, config, logger, () => ({}))
const tool = (name) => registered.find((definition) => definition.name === name)

const show = (label, value) => console.log(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
const run = (name, args) => tool(name).execute({ ...args }, { cwd: process.cwd() })

/**
 * Run one step, and keep going when it fails: a verification run that stops at the first problem
 * reports one problem instead of all of them.
 * @param {string} title - the step's name.
 * @param {() => Promise<*>} body - the step.
 * @returns {Promise<*>} the step's value, or null.
 */
async function step(title, body) {
  console.log(`\n=== ${title} ===`)
  try {
    return await body()
  } catch (error) {
    console.log(`  × 这一步失败了：${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
    return null
  }
}

await step('0. screen_setup install_detector（真的下载 + sha256 校验）', async () => {
  const installed = await run('screen_setup', { action: 'install_detector' })
  show('  installed', installed.installed)
  show('  modelPath', installed.modelPath)
  show('  bytes', installed.bytes)
  show('  sha256', installed.sha256)
  show('  verified', installed.verified)
  show('  runtime', installed.runtime)
  show('  available', installed.available)
  show('  notes', installed.notes)
  return installed
})

await step('1. screen_env probe', async () => {
  const probe = await run('screen_env', { action: 'probe' })
  show('  ffmpeg', probe.ffmpeg?.path ?? null)
  show('  capture', probe.capture)
  show('  components', {
    ocr: probe.components.ocr.available ? probe.components.ocr.provider : probe.components.ocr.reason,
    detector: probe.components.detector.available,
    asr: probe.components.asr.available ? probe.components.asr.provider : 'unavailable（本脚本没有宿主服务）',
  })
  return probe
})

await step('2. screen_env devices', async () => {
  const devices = await run('screen_env', { action: 'devices' })
  show('  audio devices', devices.audio)
  show('  video devices', devices.video)
  return devices
})

const recorded = await step('3. screen_record screen（真录 6 秒桌面）', async () => {
  const result = await run('screen_record', { action: 'screen', out: join(out, 'demo.mp4'), seconds: 6, fps: 15 })
  show('  ok', result.ok)
  show('  durationSec', result.durationSec)
  show('  frames', result.frames)
  show('  video', result.video && { width: result.video.width, height: result.video.height, fps: result.video.fps })
  show('  plan.args', result.plan.args.join(' '))
  return result
})

await step('4. screen_analyze scenes', async () => {
  const scenes = await run('screen_analyze', { action: 'scenes', input: join(out, 'demo.mp4') })
  show('  framesAnalysed', scenes.framesAnalysed)
  show('  segments', scenes.segments.map((segment) => `${segment.index}:${segment.start}-${segment.end}(${segment.reason},${segment.sceneScore})`))
  return scenes
})

await step('5. screen_analyze regions', async () => {
  const regions = await run('screen_analyze', { action: 'regions', input: join(out, 'demo.mp4'), at: 2 })
  show('  size', `${regions.width}x${regions.height} tile=${regions.tileSize} tiles=${regions.tiles.length}`)
  show('  shares', regions.shares)
  show('  top blocks', regions.blocks.slice(0, 4).map((block) => `${block.label}@${block.x},${block.y} ${block.width}x${block.height}`))
  return regions
})

await step('6. screen_analyze detect', async () => {
  const detected = await run('screen_analyze', { action: 'detect', input: join(out, 'demo.mp4'), times: [1, 3, 5] })
  show('  counts', detected.counts)
  show('  frames', detected.frames.map((frame) => `${frame.at}s: ${frame.objects.map((object) => `${object.label}(${object.score})`).join(', ') || '（无）'}`))
  return detected
})

await step('7. screen_analyze analyze（没有宿主语音服务，应写明原因）', async () => {
  const structure = await run('screen_analyze', {
    action: 'analyze',
    input: join(out, 'demo.mp4'),
    outDir: join(out, 'structure'),
    maxKeyframes: 8,
    ocrMaxFrames: 8,
    detectMaxFrames: 4,
  })
  show('  summary', structure.summary)
  show('  text.engine', structure.text.engine)
  show('  text.lineCount', structure.text.lineCount)
  show('  text.keywords', structure.text.keywords.slice(0, 8))
  show('  objects.counts', structure.objects.counts)
  show('  speech', { available: structure.speech.available, reason: structure.speech.reason })
  show('  warnings', structure.warnings)
  show('  artifacts', structure.artifacts)
  console.log('  第一段：', JSON.stringify({
    id: structure.timeline.segments[0].id,
    kind: structure.timeline.segments[0].kind,
    reason: structure.timeline.segments[0].kindReason,
    appearances: structure.timeline.segments[0].appearances,
    text: (structure.timeline.segments[0].text ?? '').slice(0, 60),
    objects: structure.timeline.segments[0].objects,
  }, null, 2))
  return structure
})

await step('8. 语音转文字：真的音频 + 替身识别器，验证切分与对齐', async () => {
  // A synthetic soundtrack: three bursts of tone separated by real silence, so silencedetect has
  // something true to find.
  const withAudio = join(out, 'demo-audio.mp4')
  await runFfmpeg(
    ['-i', join(out, 'demo.mp4'), '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12', '-filter_complex',
      '[1:a]volume=0.6,volume=enable=\'between(t,0,2)+between(t,4,5.5)+between(t,8,11)\':volume=0[a]',
      '-map', '0:v', '-map', '[a]', '-shortest', '-c:v', 'copy', '-c:a', 'aac', '-y', withAudio],
    { config, timeoutMs: 120_000, label: '合成测试音轨' },
  )
  const calls = []
  const stub = {
    resolve: (spec) => spec,
    transcribe: async (spec) => {
      calls.push(spec.audio.length)
      return { text: `第 ${calls.length} 段语音`, audioSeconds: spec.audio.length / 32000, inferenceSeconds: 0.01 }
    },
  }
  const { transcribeIntervals } = await import('../src/core/asr.mjs')
  const aligned = await transcribeIntervals({ source: withAudio, service: stub, language: 'zh', config })
  show('  检测到的语音段', aligned.intervals.map((interval) => `${interval.id} ${interval.start}-${interval.end}s "${interval.text}"`))
  show('  识别请求数', calls.length)
  show('  每次请求的 wav 字节数', calls)
  show('  notes', aligned.notes)
  const wav = join(out, 'check.wav')
  const converted = await toCanonicalWav(withAudio, wav, { config })
  show('  规范化 wav', `${converted.seconds.toFixed(2)}s ${converted.bytes} bytes`)

  console.log('\n--- 用同一个替身跑完整结构 ---')
  const { analyzeRecording } = await import('../src/core/structure.mjs')
  const full = await analyzeRecording({
    input: withAudio,
    outDir: join(out, 'structure-audio'),
    config,
    service: stub,
    language: 'zh',
    options: { maxKeyframes: 6, ocrMaxFrames: 6, detectMaxFrames: 3 },
    delivery: 'copy',
  })
  show('  summary', full.summary)
  show('  speech', full.speech.intervals.map((interval) => `${interval.id} "${interval.text}"`))
  show('  段落上的语音', full.timeline.segments.filter((segment) => segment.speech !== null).map((segment) => `${segment.id}: ${segment.speech.text}`))
  show('  artifacts', full.artifacts)
  writeFileSync(join(out, 'verification-summary.json'), `${JSON.stringify({ structure: full.summary, warnings: full.warnings }, null, 2)}\n`)
  return full
})

console.log('\n完成。产物在', out)
