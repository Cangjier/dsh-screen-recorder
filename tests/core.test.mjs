/**
 * The pure half of the plugin, tested without ffmpeg, a network or a recording.
 *
 * Everything here is a function of its arguments, which is the point: the cut arithmetic, the
 * appearance thresholds, the box decode and the naming rules are where this plugin can be wrong in a
 * way nobody notices, so they are the parts that must be checkable in half a second.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { classifySegment, extractKeywords, groupKinds, textEvidence, textWithin } from '../src/core/analysis.mjs'
import { containerFor, videoArguments } from '../src/core/container.mjs'
import { parseDevices } from '../src/core/devices.mjs'
import { parseList } from '../src/core/caps.mjs'
import { fitInside, scaleFactor } from '../src/core/image.mjs'
import { parseRate, rotationOf } from '../src/core/probe.mjs'
import { escapeOptionValue, screenPlan } from '../src/core/record.mjs'
import { mergeIntervals, parseSilences, planCuts, speechIntervals } from '../src/core/asr.mjs'
import { renderChapters, resolveSettings } from '../src/core/structure.mjs'
import {
  buildInputTensor,
  decodeDetections,
  floatToHalf,
  halfToFloat,
  iou,
  letterbox,
  nonMaxSuppression,
} from '../src/core/vision.mjs'

test('containerFor：认识扩展名，不认识的扩展名带着支持列表拒绝', () => {
  assert.equal(containerFor('a.mp4').muxer, 'mp4')
  assert.equal(containerFor('a.MKV').muxer, 'matroska')
  assert.equal(containerFor('a.wav').video, null)
  assert.throws(() => containerFor('a.txt'), /不认识的输出扩展名/)
})

test('videoArguments：音频容器装不了画面，默认值来自容器', () => {
  assert.throws(() => videoArguments({}, containerFor('a.wav')), /装不了画面/)
  const { args, notes } = videoArguments({}, containerFor('a.mp4'))
  assert.deepEqual(args.slice(0, 2), ['-c:v', 'libx264'])
  assert.ok(args.includes('-crf'))
  assert.ok(notes[0].includes('libx264'))
})

test('screenPlan：必须给秒数、给 fps 上限、window 与 region 互斥', () => {
  assert.throws(() => screenPlan({ out: 'a.mp4', seconds: 0 }), /正数的秒数/)
  assert.throws(() => screenPlan({ out: 'a.mp4', seconds: 5, fps: 120 }), /帧率必须在 0–60/)
  assert.throws(() => screenPlan({ out: 'a.mp4', seconds: 5, window: 'w', region: { width: 10, height: 10 } }), /只能选一个/)
  assert.throws(() => screenPlan({ out: 'a.wav', seconds: 5 }), /视频容器/)
})

test('screenPlan：整屏录制默认 15fps、画鼠标、无音频，并给出 -an', () => {
  const plan = screenPlan({ out: 'a.mp4', seconds: 3 })
  assert.ok(plan.args.includes('gdigrab'))
  assert.deepEqual(plan.args.slice(plan.args.indexOf('-framerate'), plan.args.indexOf('-framerate') + 2), ['-framerate', '15'])
  assert.ok(plan.args.includes('-draw_mouse'))
  assert.ok(plan.args.includes('-an'))
  assert.equal(plan.expectedDurationSec, 3)
  assert.equal(plan.timeoutMs, 3000 + 60_000)
  assert.ok(plan.notes.some((note) => note.includes('没有声音')))
})

test('screenPlan：窗口名与音频设备名里的冒号被转义', () => {
  const plan = screenPlan({ out: 'a.mp4', seconds: 1, window: 'C:\\x:y', audioDevice: 'Mic: 1' })
  assert.ok(plan.args.includes('title=C\\:\\\\x\\:y'))
  assert.ok(plan.args.includes('audio=Mic\\: 1'))
  assert.equal(escapeOptionValue('a:b\\c'), 'a\\:b\\\\c')
})

test('analysis：命令行与代码的证据来自模式，不来自模型', () => {
  const shell = textEvidence('PS C:\\Users\\me> npm run build\nnpm ERR! code ELIFECYCLE')
  assert.ok(shell.shellHits >= 2)
  const code = textEvidence('function f() {\n  return 1;\n}\nimport x from "y"')
  assert.ok(code.codeHits >= 2)
})

test('analysis：classifySegment 按优先级给出类别，并总是带理由', () => {
  const terminal = classifySegment({ appearance: { dark: 0.6, text: 0.2 }, text: 'PS C:\\> npm test\n> error' })
  assert.equal(terminal.kind, 'terminal')
  assert.ok(terminal.reason.length > 0)

  const picture = classifySegment({ appearance: { picture: 0.8 } })
  assert.equal(picture.kind, 'picture')

  const presenter = classifySegment({ appearance: { text: 0 }, objects: [{ label: 'person', score: 0.9 }] })
  assert.equal(presenter.kind, 'presenter')

  const idle = classifySegment({ appearance: { flat: 1 }, motion: 0.1 })
  assert.equal(idle.kind, 'idle')

  const fallback = classifySegment({ appearance: { texture: 0.6, picture: 0.2 }, motion: 3 })
  assert.equal(fallback.kind, 'desktop')
  assert.ok(fallback.reason.length > 0)

  const document = classifySegment({ appearance: { flat: 0.7, text: 0.1 }, text: '标题一\n标题二\n标题三' })
  assert.equal(document.kind, 'document')
})

test('analysis：groupKinds 按时间轴顺序收集编号', () => {
  const groups = groupKinds([
    { index: 1, kind: 'text' },
    { index: 2, kind: 'picture' },
    { index: 3, kind: 'text' },
  ])
  assert.deepEqual(groups, { text: [1, 3], picture: [2] })
})

test('analysis：extractKeywords 数词频、丢停用词、中英分治', () => {
  const keywords = extractKeywords('npm run build. the build failed. 开始 开始演示 演示')
  const counts = new Map(keywords.map((entry) => [entry.term, entry.count]))
  assert.equal(counts.get('build'), 2)
  assert.equal(counts.get('演示'), 2)
  assert.equal(counts.get('开始'), 2)
  assert.ok(!counts.has('the'))
  // 并列时按词的字典序，因此只断言"前两名是 count 2 的那些"，不断言并列词的先后。
  assert.equal(keywords[0].count, 2)
  assert.equal(keywords.filter((entry) => entry.count === 2).length, 3)
})

test('analysis：textWithin 只取真正重叠的部分，并用中点规则避免重复', () => {
  const intervals = [
    { start: 0, end: 2, text: '甲' },
    { start: 2, end: 4, text: '乙' },
    { start: 10, end: 12, text: '丙' },
  ]
  const within = textWithin(intervals, 1, 3)
  assert.equal(within.text, '甲 乙')
  assert.equal(within.overlapSeconds, 2)
  // 0.2 秒以下的重叠不算：切点上的一个词不该被抄到两边。
  assert.equal(textWithin(intervals, 4.1, 6).text, '')
})

test('vision：letterbox 与 buildInputTensor 把画面放进正方形并归一化', () => {
  const geometry = letterbox(2, 1, 4)
  assert.deepEqual(geometry, { padX: 1, padY: 1, side: 4 })
  const pixels = Buffer.from([255, 0, 0, 0, 255, 0])
  const tensor = buildInputTensor(pixels, { ...geometry, width: 2, height: 1 })
  assert.equal(tensor.length, 48)
  const plane = 16
  assert.equal(tensor[1 * 4 + 1], 1)
  assert.equal(tensor[plane + 1 * 4 + 1], 0)
  assert.equal(tensor[2 * plane + 1 * 4 + 1], 0)
  assert.equal(tensor[1 * 4 + 2], 0)
  assert.equal(tensor[plane + 1 * 4 + 2], 1)
  // 补边处是 0：letterbox 的黑边不该被当成内容。
  assert.equal(tensor[0], 0)
})

test('vision：float16 编解码往返，零与一精确', () => {
  assert.equal(halfToFloat(floatToHalf(0)), 0)
  assert.equal(halfToFloat(floatToHalf(1)), 1)
  assert.ok(Math.abs(halfToFloat(floatToHalf(0.5)) - 0.5) < 1e-3)
  assert.equal(halfToFloat(0x7c00), Infinity)
})

test('vision：decodeDetections 读 v8 的 [1,4+nc,N] 布局', () => {
  const rows = 3
  const channels = 84
  const data = new Float32Array(channels * rows)
  const put = (channel, row, value) => {
    data[channel * rows + row] = value
  }
  // 第 0 行：一个人，中心 (320,320)，100x100，分数 0.9
  put(0, 0, 320)
  put(1, 0, 320)
  put(2, 0, 100)
  put(3, 0, 100)
  put(4 + 0, 0, 0.9)
  put(4 + 2, 0, 0.05)
  const decoded = decodeDetections({
    data,
    dims: [1, channels, rows],
    padX: 0,
    padY: 0,
    factor: 1,
    sourceWidth: 640,
    sourceHeight: 640,
    minScore: 0.25,
  })
  assert.equal(decoded.layout, 'channel-major')
  assert.equal(decoded.classCount, 80)
  assert.equal(decoded.objects.length, 1)
  assert.equal(decoded.objects[0].label, 'person')
  assert.deepEqual(decoded.objects[0].box, { x: 270, y: 270, width: 100, height: 100 })
  assert.deepEqual(decoded.objects[0].center, { x: 320, y: 320 })
})

test('vision：decodeDetections 读 v5 的 [1,N,5+nc] 布局并乘上 objectness', () => {
  const rows = 2
  const channels = 85
  const data = new Float32Array(rows * channels)
  const put = (row, channel, value) => {
    data[row * channels + channel] = value
  }
  put(1, 0, 100)
  put(1, 1, 100)
  put(1, 2, 40)
  put(1, 3, 20)
  put(1, 4, 0.5)
  put(1, 5 + 2, 0.8)
  const decoded = decodeDetections({
    data,
    dims: [1, rows, channels],
    padX: 0,
    padY: 0,
    factor: 2,
    sourceWidth: 1280,
    sourceHeight: 1280,
    minScore: 0.25,
  })
  assert.equal(decoded.layout, 'row-major')
  assert.equal(decoded.objects.length, 1)
  assert.equal(decoded.objects[0].label, 'car')
  assert.ok(Math.abs(decoded.objects[0].score - 0.4) < 1e-6)
  assert.deepEqual(decoded.objects[0].box, { x: 160, y: 180, width: 80, height: 40 })
})

test('vision：letterbox 的补边与缩放系数被折回源像素', () => {
  const rows = 1
  const channels = 84
  const data = new Float32Array(channels * rows)
  data[0] = 330
  data[1] = 330
  data[2] = 100
  data[3] = 100
  data[4] = 0.9
  const decoded = decodeDetections({
    data,
    dims: [1, channels, rows],
    padX: 10,
    padY: 20,
    factor: 2,
    sourceWidth: 1280,
    sourceHeight: 1280,
    minScore: 0.25,
  })
  // (330 - 50 - 10) * 2 = 540；(330 - 50 - 20) * 2 = 520
  assert.deepEqual(decoded.objects[0].box, { x: 540, y: 520, width: 200, height: 200 })
})

test('vision：框被裁进画面，不会报出画面外的坐标', () => {
  const channels = 84
  const data = new Float32Array(channels)
  data[0] = 5
  data[1] = 5
  data[2] = 100
  data[3] = 100
  data[4] = 0.9
  const decoded = decodeDetections({ data, dims: [1, channels, 1], padX: 0, padY: 0, factor: 1, sourceWidth: 640, sourceHeight: 640 })
  assert.deepEqual(decoded.objects[0].box, { x: 0, y: 0, width: 55, height: 55 })
})

test('vision：NMS 只压同类，IoU 算术正确', () => {
  const a = { x: 0, y: 0, width: 10, height: 10 }
  const b = { x: 5, y: 0, width: 10, height: 10 }
  assert.ok(Math.abs(iou(a, b) - 50 / 150) < 1e-9)
  // 0.33 的重叠不该被压掉：阈值是 0.45。
  assert.equal(nonMaxSuppression([{ classId: 0, score: 0.9, box: a }, { classId: 0, score: 0.8, box: b }], 0.45).length, 2)
  // 几乎重合的同类框只留分数高的那个；不同类的框互不干扰。
  const nearly = { x: 1, y: 0, width: 10, height: 10 }
  const kept = nonMaxSuppression(
    [
      { classId: 0, score: 0.9, box: a },
      { classId: 0, score: 0.8, box: nearly },
      { classId: 1, score: 0.7, box: nearly },
    ],
    0.45,
  )
  assert.equal(kept.length, 2)
  assert.deepEqual(kept.map((entry) => entry.classId), [0, 1])
  assert.deepEqual(kept.map((entry) => entry.score), [0.9, 0.7])
})

test('asr：silencedetect 的输出解析成区间', () => {
  const stderr = '[silencedetect @ 0x1] silence_start: 1.5\n[silencedetect @ 0x1] silence_end: 2.5 | silence_duration: 1\n'
  assert.deepEqual(parseSilences(stderr), [{ start: 1.5, end: 2.5 }])
})

test('asr：speechIntervals 取停顿之间的部分，太短的丢掉', () => {
  const intervals = speechIntervals({
    durationSec: 10,
    silences: [
      { start: 2, end: 3 },
      { start: 6, end: 8 },
    ],
  })
  assert.deepEqual(
    intervals.map((entry) => [entry.start, entry.end]),
    [
      [0, 2],
      [3, 6],
      [8, 10],
    ],
  )
  const tiny = speechIntervals({ durationSec: 1, silences: [{ start: 0.5, end: 0.95 }], minSpeechSec: 0.25 })
  // 0–0.5 保留；0.95–1 只有 0.05 秒，丢掉。
  assert.deepEqual(tiny.map((entry) => entry.start), [0])
})

test('asr：过长的一段会被切开，而不是整段交给识别器', () => {
  const intervals = speechIntervals({ durationSec: 30, silences: [], maxIntervalSec: 10 })
  assert.equal(intervals.length, 3)
  assert.equal(intervals[2].end, 30)
})

test('asr：mergeIntervals 把请求数压到上限内，且不制造超长请求', () => {
  const many = Array.from({ length: 10 }, (_, index) => ({ start: index * 2, end: index * 2 + 1, seconds: 1 }))
  const merged = mergeIntervals(many, { maxIntervals: 3, maxSeconds: 100 })
  assert.ok(merged.intervals.length <= 3)
  assert.equal(merged.intervals[0].start, 0)
  assert.equal(merged.intervals[merged.intervals.length - 1].end, 19)
  const capped = mergeIntervals([{ start: 0, end: 100, seconds: 100 }], { maxIntervals: 5, maxSeconds: 30 })
  assert.deepEqual(capped.intervals.map((entry) => entry.seconds), [30, 30, 30, 10])
})

test('asr：planCuts 优先切在停顿上，找不到就按字节上限硬切', () => {
  const maxBytes = 32000 * 10
  const withPause = planCuts({ totalSeconds: 25, silences: [{ start: 9, end: 9.5 }], maxBytes })
  assert.deepEqual(withPause.cuts, [9, 19])
  assert.equal(withPause.forced, 1)
  const noPause = planCuts({ totalSeconds: 25, silences: [], maxBytes })
  assert.deepEqual(noPause.cuts, [10, 20])
  assert.equal(noPause.forced, 2)
})

test('probe：帧率与旋转的解析', () => {
  assert.equal(parseRate('30000/1001'), 29.97003)
  assert.equal(parseRate('0/0'), null)
  assert.equal(parseRate(undefined), null)
  assert.equal(rotationOf({ tags: { rotate: '90' } }), 90)
  assert.equal(rotationOf({ side_data_list: [{ rotation: -90 }] }), 90)
  assert.equal(rotationOf({}), 0)
})

test('image：fitInside 保持比例、尺寸为偶数、不放大', () => {
  assert.deepEqual(fitInside(1920, 1080, 320), { width: 320, height: 180, scaled: true })
  assert.deepEqual(fitInside(100, 50, 320), { width: 100, height: 50, scaled: false })
  assert.equal(fitInside(101, 51, 320).width % 2, 0)
  assert.equal(scaleFactor({ sourceWidth: 1920, sourceHeight: 1080, readWidth: 320, readHeight: 180 }), 6)
})

test('caps：ffmpeg 的列表行被解析成名字', () => {
  const encoders = ' V....D libx264              H.264\n A....D aac                  AAC\n------\n'
  assert.deepEqual(parseList(encoders).sort(), ['aac', 'libx264'])
  const devices = ' D  dshow           DirectShow capture\n  E  gdigrab         GDI API Windows frame grabber\n'
  assert.deepEqual(parseList(devices).sort(), ['dshow', 'gdigrab'])
})

test('devices：DirectShow 设备名、类型与替代名', () => {
  const text =
    '[dshow @ 1] "HD WebCam" (video)\n' +
    '[dshow @ 1]   Alternative name "@device_pnp_\\\\?\\usb#vid"\n' +
    '[dshow @ 1] "Microphone (USB Audio Device)" (audio)\n'
  const devices = parseDevices(text)
  assert.equal(devices.length, 2)
  assert.deepEqual(devices[0].name, 'HD WebCam')
  assert.equal(devices[0].kind, 'video')
  assert.equal(devices[0].alternative, '@device_pnp_\\\\?\\usb#vid')
  assert.equal(devices[1].kind, 'audio')
})

test('structure：resolveSettings 让调用参数盖过配置，配置盖过默认值', () => {
  const settings = resolveSettings({ analysis: { fps: 8, maxSide: 640 } }, { fps: 2 })
  assert.equal(settings.fps, 2)
  assert.equal(settings.maxSide, 640)
  assert.equal(settings.tileSize, 16)
  assert.equal(settings.detector.minScore, undefined)
})

test('structure：renderChapters 写出 ffmetadata 的毫秒时间轴', () => {
  const text = renderChapters([{ id: 's001', start: 0, end: 1.5, kind: 'text', kindLabel: '以文字为主' }])
  assert.ok(text.startsWith(';FFMETADATA1'))
  assert.ok(text.includes('START=0'))
  assert.ok(text.includes('END=1500'))
  assert.ok(text.includes('title=s001 以文字为主'))
})
