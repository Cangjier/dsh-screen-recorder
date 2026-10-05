/**
 * `timeline.mjs` 的测试：只测纯的、确定的东西。
 *
 * 一次 ffmpeg 都不跑：切点算术（`mergeSegments`）、流式状态机（`SegmentBuilder`）、原始帧拼装
 * （`FrameSplitter`）和帧差（`lumaDifference`）都是不依赖进程与磁盘的函数，所以它们必须能被
 * 直接测 —— 一个只能靠跑一遍真实视频才能验证的时间轴，等于没有回归测试。
 *
 * @module dsh-screen-recorder/tests/timeline
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  FrameSplitter,
  MAX_NOTES,
  PROGRESS_EVERY_SEC,
  SEGMENT_REASONS,
  SegmentBuilder,
  TIMELINE_DEFAULTS,
  detectScenes,
  lumaDifference,
  mergeSegments,
} from '../src/core/timeline.mjs'

/**
 * 造一个原始段，字段与 `SegmentBuilder` 交出的一致。
 * @param {object} fields - 覆盖默认值。
 * @returns {object} 原始段。
 */
function raw(fields) {
  return {
    start: 0,
    end: 1,
    reason: 'scene_change',
    sceneScore: 0,
    diffSum: 0,
    samples: 0,
    ...fields,
  }
}

test('TIMELINE_DEFAULTS 与 ANALYSIS_DEFAULTS 镜像，并且是冻结的', () => {
  assert.deepEqual({ ...TIMELINE_DEFAULTS }, {
    sceneThreshold: 8,
    minSegmentSec: 1,
    maxSegmentSec: 30,
    mergeShortSec: 0.7,
    fps: 4,
    maxSide: 320,
    maxSegments: 400,
    motionThresholdRatio: 1 / 3,
    motionRunFrames: 3,
  })
  assert.ok(Object.isFrozen(TIMELINE_DEFAULTS))
  assert.ok(Object.isFrozen(SEGMENT_REASONS))
  assert.deepEqual([...SEGMENT_REASONS], ['start', 'scene_change', 'motion', 'cadence'])
  assert.equal(SEGMENT_REASONS.includes('end'), false)
  assert.ok(PROGRESS_EVERY_SEC > 0)
  assert.equal(MAX_NOTES, 4)
  assert.equal(typeof detectScenes, 'function')
})

test('lumaDifference：同一帧是 0，黑白是 255，长度不等时按短的那个算', () => {
  assert.equal(lumaDifference(new Uint8Array([0, 10, 200]), new Uint8Array([0, 10, 200])), 0)
  assert.equal(lumaDifference(new Uint8Array([0, 0, 0, 0]), new Uint8Array([255, 255, 255, 255])), 255)
  // (10 + 50) / 2
  assert.equal(lumaDifference(new Uint8Array([0, 100]), new Uint8Array([10, 150])), 30)
  assert.equal(lumaDifference(new Uint8Array([0, 0, 0]), new Uint8Array([255])), 255)
  assert.equal(lumaDifference(new Uint8Array(0), new Uint8Array(0)), 0)
  // 1/3 保留 4 位小数
  assert.equal(lumaDifference(new Uint8Array([0, 0, 0]), new Uint8Array([1, 0, 0])), 0.3333)
  // 负方向也要算绝对值
  assert.equal(lumaDifference(new Uint8Array([200]), new Uint8Array([100])), 100)
})

test('FrameSplitter：跨 chunk 的半个帧留到下一次，半个帧永远不算一帧', () => {
  assert.throws(() => new FrameSplitter(0), TypeError)
  assert.throws(() => new FrameSplitter(1.5), TypeError)

  const splitter = new FrameSplitter(4)
  assert.equal(splitter.frameBytes, 4)
  const ten = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  const first = splitter.push(ten)
  assert.equal(first.length, 2)
  assert.deepEqual([...first[0]], [1, 2, 3, 4])
  assert.deepEqual([...first[1]], [5, 6, 7, 8])
  assert.equal(splitter.remainderBytes, 2)

  const second = splitter.push(Buffer.from([21, 22]))
  assert.equal(second.length, 1)
  // 上一次剩下的 [9, 10] 接上这一次的 [21, 22]。
  assert.deepEqual([...second[0]], [9, 10, 21, 22])
  assert.equal(second[0][0], 9)
  assert.equal(second[0][1], 10)
  assert.equal(splitter.remainderBytes, 0)

  // 一次只喂 3 字节，凑不齐就不交出来。
  const slow = new FrameSplitter(4)
  assert.equal(slow.push(new Uint8Array([1, 2, 3])).length, 0)
  assert.equal(slow.remainderBytes, 3)
  assert.equal(slow.push(new Uint8Array([4])).length, 1)
  assert.equal(slow.remainderBytes, 0)
  assert.equal(slow.push(new Uint8Array(0)).length, 0)

  // 一段正好 8 字节：两帧，没有剩余。
  const exact = new FrameSplitter(4)
  assert.equal(exact.push(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])).length, 2)
  assert.equal(exact.remainderBytes, 0)
})

test('SegmentBuilder：没有帧就没有段，单帧就是一段', () => {
  const empty = new SegmentBuilder()
  assert.deepEqual(empty.finish(10), [])

  const builder = new SegmentBuilder()
  assert.equal(builder.push(0, 0), null)
  const segments = builder.finish(0.25)
  assert.equal(segments.length, 1)
  assert.deepEqual(segments[0], { start: 0, reason: 'start', sceneScore: 0, diffSum: 0, samples: 0, diffMax: 0, end: 0.25 })
  // 一帧没有"段内帧差"可算，于是运动是 0 而不是 NaN。
  assert.deepEqual(mergeSegments(segments), [
    { index: 1, start: 0, end: 0.25, seconds: 0.25, reason: 'start', sceneScore: 0, motion: 0, mergedCount: 1, samples: 0 },
  ])
})

test('SegmentBuilder：越线且当前段已满 minSegmentSec 才切开', () => {
  const builder = new SegmentBuilder()
  for (const time of [0, 0.25, 0.5, 0.75]) assert.equal(builder.push(time, 0), null)
  const closed = builder.push(1, 50)
  assert.equal(closed.start, 0)
  assert.equal(closed.end, 1)
  assert.equal(closed.reason, 'start')
  // 越线的那一帧不算进上一段的运动，否则一段静止画面会因为结束它的那次切换而报成"高运动"。
  assert.equal(closed.samples, 3)
  assert.equal(closed.diffSum, 0)

  const segments = builder.finish(2)
  assert.equal(segments.length, 2)
  assert.equal(segments[1].reason, 'scene_change')
  assert.equal(segments[1].sceneScore, 50)
  assert.equal(segments[1].start, 1)

  const merged = mergeSegments(segments)
  assert.equal(merged.length, 2)
  assert.deepEqual(merged.map((segment) => segment.reason), ['start', 'scene_change'])
  assert.equal(merged[1].sceneScore, 50)
  assert.equal(merged[0].end, 1)
  assert.equal(merged[1].start, 1)
})

test('SegmentBuilder：不到 minSegmentSec 的段不许结束，它把后面的帧吃进来', () => {
  const builder = new SegmentBuilder()
  builder.push(0, 0)
  // 0.25s 处就已经越线，但这一段还不到 1s，于是这次越线不能成为切点。
  assert.equal(builder.push(0.25, 60), null)
  assert.equal(builder.push(0.5, 0), null)
  const segments = builder.finish(0.5)
  assert.equal(segments.length, 1)
  assert.equal(segments[0].reason, 'start')
  // 被吸收的那次变化成了本段的运动证据，而不是一个碎段。
  assert.equal(segments[0].samples, 2)
  assert.equal(segments[0].diffSum, 60)

  const merged = mergeSegments(segments, { minSegmentSec: 1 })
  assert.equal(merged.length, 1)
  assert.equal(merged[0].motion, 30)
})

test('SegmentBuilder：超过 maxSegmentSec 按 cadence 断开，新段从断开处起算', () => {
  const builder = new SegmentBuilder({ minSegmentSec: 1, maxSegmentSec: 2 })
  let closed = null
  for (let index = 0; index <= 8 && closed === null; index += 1) closed = builder.push(index * 0.25, 0)
  assert.equal(closed.start, 0)
  assert.equal(closed.end, 2)
  assert.equal(closed.samples, 8)
  const segments = builder.finish(2.5)
  assert.equal(segments.length, 2)
  assert.equal(segments[1].reason, 'cadence')
  assert.equal(segments[1].start, 2)
  assert.equal(segments[1].sceneScore, 0)
})

test('SegmentBuilder：本段内连续三帧超过运动阈值，越线记成 motion 而不是 scene_change', () => {
  const builder = new SegmentBuilder()
  builder.push(0, 0)
  for (const time of [0.25, 0.5, 0.75]) builder.push(time, 5)
  const closed = builder.push(1, 50)
  assert.equal(closed.end, 1)
  const segments = builder.finish(2)
  assert.equal(segments[1].reason, 'motion')
  assert.equal(segments[1].sceneScore, 50)
  assert.equal(mergeSegments(segments)[0].motion, 5)
})

test('SegmentBuilder：运动被打断（一帧回到阈值下）之后又越线，仍记成 scene_change', () => {
  const builder = new SegmentBuilder()
  builder.push(0, 0)
  builder.push(0.25, 5)
  builder.push(0.5, 5)
  builder.push(0.75, 0)
  builder.push(1, 50)
  assert.equal(builder.finish(2)[1].reason, 'scene_change')

  // 只有两帧超过运动阈值也不够：motionRunFrames 是 3。
  const two = new SegmentBuilder()
  two.push(0, 0)
  two.push(0.25, 5)
  two.push(0.5, 0)
  two.push(1, 50)
  assert.equal(two.finish(2)[1].reason, 'scene_change')

  // 阈值本身可以调：调成 2 帧就够。
  const eager = new SegmentBuilder({ motionRunFrames: 2 })
  eager.push(0, 0)
  eager.push(0.25, 5)
  eager.push(0.5, 5)
  eager.push(1, 50)
  assert.equal(eager.finish(2)[1].reason, 'motion')
})

test('SegmentBuilder：finish 的结束时间早于当前段起点时，按起点封口', () => {
  const builder = new SegmentBuilder()
  builder.push(5, 0)
  const segments = builder.finish(1)
  assert.equal(segments[0].start, 5)
  assert.equal(segments[0].end, 5)
  // 零长度的段不是一段，交出去时被过滤掉。
  assert.deepEqual(mergeSegments(segments), [])
})

test('mergeSegments：空输入与坏条目都不抛错', () => {
  assert.deepEqual(mergeSegments([]), [])
  assert.deepEqual(mergeSegments(undefined), [])
  assert.deepEqual(mergeSegments([null, 'x', {}, { start: 1, end: 1 }, { start: 3, end: 2 }]), [])
})

test('mergeSegments：都不短的时候一段不动，编号从 1 开始', () => {
  const merged = mergeSegments([
    raw({ start: 0, end: 2, reason: 'start' }),
    raw({ start: 2, end: 3, diffSum: 10, samples: 2 }),
    raw({ start: 3, end: 10, reason: 'cadence' }),
  ])
  assert.deepEqual(merged, [
    { index: 1, start: 0, end: 2, seconds: 2, reason: 'start', sceneScore: 0, motion: 0, mergedCount: 1, samples: 0 },
    { index: 2, start: 2, end: 3, seconds: 1, reason: 'scene_change', sceneScore: 0, motion: 5, mergedCount: 1, samples: 2 },
    { index: 3, start: 3, end: 10, seconds: 7, reason: 'cadence', sceneScore: 0, motion: 0, mergedCount: 1, samples: 0 },
  ])
})

test('mergeSegments：短段向后长，保留自己的起点与理由', () => {
  const merged = mergeSegments([
    raw({ start: 0, end: 2, reason: 'start' }),
    raw({ start: 2, end: 2.4, reason: 'scene_change' }),
    raw({ start: 2.4, end: 6, reason: 'cadence' }),
  ])
  assert.equal(merged.length, 2)
  assert.equal(merged[1].start, 2)
  assert.equal(merged[1].end, 6)
  assert.equal(merged[1].reason, 'scene_change')
  assert.equal(merged[1].mergedCount, 2)

  // 第一段自己太短时也一样向后长 —— 它没有前一段可以并。
  const single = mergeSegments([raw({ start: 0, end: 0.4 })])
  assert.equal(single.length, 1)
  assert.equal(single[0].end, 0.4)
  const grown = mergeSegments([raw({ start: 0, end: 0.4, reason: 'start' }), raw({ start: 0.4, end: 5 })])
  assert.equal(grown.length, 1)
  assert.equal(grown[0].reason, 'start')
  assert.equal(grown[0].end, 5)
})

test('mergeSegments：短于 mergeShortSec 的段并进前一段，保留前一段的起点与理由', () => {
  const merged = mergeSegments(
    [raw({ start: 0, end: 2, reason: 'start' }), raw({ start: 2, end: 2.8 }), raw({ start: 2.8, end: 5 })],
    { minSegmentSec: 0.5, mergeShortSec: 1 },
  )
  assert.equal(merged.length, 2)
  assert.equal(merged[0].start, 0)
  assert.equal(merged[0].end, 2.8)
  assert.equal(merged[0].reason, 'start')
  assert.equal(merged[0].mergedCount, 2)
  assert.equal(merged[1].start, 2.8)
})

test('mergeSegments：并入会让前一段超过 maxSegmentSec 时就不并，短段自己留着', () => {
  const merged = mergeSegments([raw({ start: 0, end: 2, reason: 'start' }), raw({ start: 2, end: 2.5 })], {
    minSegmentSec: 0.5,
    mergeShortSec: 1,
    maxSegmentSec: 2.2,
  })
  assert.equal(merged.length, 2)
  assert.equal(merged[0].end, 2)
  assert.equal(merged[1].start, 2)
  assert.equal(merged[1].seconds, 0.5)
})

test('mergeSegments：封顶时保留前 maxSegments-1 段，尾巴并进最后一段（时间不丢）', () => {
  const input = [
    raw({ start: 0, end: 1, reason: 'start' }),
    raw({ start: 1, end: 2, diffSum: 4, samples: 2 }),
    raw({ start: 2, end: 3, diffSum: 6, samples: 2 }),
    raw({ start: 3, end: 4, diffSum: 8, samples: 2 }),
  ]
  const merged = mergeSegments(input, { maxSegments: 2 })
  assert.equal(merged.length, 2)
  assert.deepEqual(merged.map((segment) => [segment.start, segment.end]), [[0, 1], [1, 4]])
  assert.equal(merged[1].mergedCount, 3)
  assert.equal(merged[1].samples, 6)
  // (4 + 6 + 8) / 6
  assert.equal(merged[1].motion, 3)

  const one = mergeSegments(input, { maxSegments: 1 })
  assert.equal(one.length, 1)
  assert.equal(one[0].start, 0)
  assert.equal(one[0].end, 4)
  assert.equal(one[0].reason, 'start')

  // 没到顶就一段不并。
  assert.equal(mergeSegments(input, { maxSegments: 4 }).length, 4)
})

test('mergeSegments：运动按帧数加权合并，时间保留 4 位小数', () => {
  const merged = mergeSegments([
    raw({ start: 0.12345678, end: 2.98765432, reason: 'start', diffSum: 10, samples: 2 }),
    raw({ start: 2.98765432, end: 3.28765432, diffSum: 9, samples: 3 }),
  ])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].start, 0.1235)
  assert.equal(merged[0].end, 3.2877)
  assert.equal(merged[0].seconds, 3.1642)
  // (10 + 9) / (2 + 3)
  assert.equal(merged[0].motion, 3.8)
})

test('detectScenes：不碰 ffmpeg 就能拒绝的输入，在探测之前就拒绝', async () => {
  await assert.rejects(() => detectScenes({}), /需要一个 input 路径/)
  await assert.rejects(
    () => detectScenes({ input: 'C:\\definitely\\not\\here\\nothing.mp4' }),
    /不存在/,
  )
})
