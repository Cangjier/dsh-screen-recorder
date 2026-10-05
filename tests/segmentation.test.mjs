/**
 * `segmentation.mjs` 的测试：合成像素，不碰 ffmpeg。
 *
 * 每一帧都由测试自己画出来（纯色、棋盘、渐变、条纹），所以断言可以精确到统计量本身 ——
 * 一个标签如果不等于阈值算出来的那个，测试会指着数字说话，而不是指着一张截图。
 *
 * @module dsh-screen-recorder/tests/segmentation
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  APPEARANCE_CLASSES,
  DEFAULT_MAX_SIDE,
  DEFAULT_THRESHOLDS,
  DEFAULT_TILE_SIZE,
  analysisFrameSize,
  classifyTiles,
  parseProbeStreamSize,
  probeAnalysisSize,
  segmentImage,
} from '../src/core/segmentation.mjs'

/**
 * 画一帧 RGB24。
 * @param {number} width - 宽。
 * @param {number} height - 高。
 * @param {(x: number, y: number) => [number, number, number]} paint - 每个像素的颜色。
 * @returns {Uint8Array} 像素缓冲。
 */
function rgbFrame(width, height, paint) {
  const data = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = paint(x, y)
      const offset = (y * width + x) * 3
      data[offset] = r
      data[offset + 1] = g
      data[offset + 2] = b
    }
  }
  return data
}

/**
 * 画一帧灰度。
 * @param {number} width - 宽。
 * @param {number} height - 高。
 * @param {(x: number, y: number) => number} paint - 每个像素的亮度。
 * @returns {Uint8Array} 像素缓冲。
 */
function grayFrame(width, height, paint) {
  const data = new Uint8Array(width * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) data[y * width + x] = paint(x, y)
  }
  return data
}

/** 一帧纯色 RGB。 */
function solidRgb(width, height, value) {
  return rgbFrame(width, height, () => [value, value, value])
}

/** 各标签占比的整数单位之和：最大余额法之后必须正好是 10000。 */
function shareUnits(shares) {
  return APPEARANCE_CLASSES.reduce((sum, label) => sum + Math.round(shares[label] * 10000), 0)
}

test('导出的常量：词汇表、阈值表与默认值都是冻结的，且阈值是实测值', () => {
  assert.deepEqual([...APPEARANCE_CLASSES], ['text', 'picture', 'texture', 'flat', 'dark'])
  assert.ok(Object.isFrozen(APPEARANCE_CLASSES))
  assert.ok(Object.isFrozen(DEFAULT_THRESHOLDS))
  assert.deepEqual({ ...DEFAULT_THRESHOLDS }, {
    flatStd: 4,
    darkLuma: 48,
    edgeGradient: 24,
    textEdgeDensity: 0.09,
    textSaturation: 0.22,
    pictureSaturation: 0.18,
    pictureStd: 12,
    textureEdgeDensity: 0.025,
  })
  assert.equal(DEFAULT_TILE_SIZE, 16)
  assert.equal(DEFAULT_MAX_SIDE, 320)
  assert.equal(typeof segmentImage, 'function')
  assert.equal(typeof probeAnalysisSize, 'function')
})

test('纯灰一帧：全部 flat，占比加起来是 1，四块瓦片并成一个矩形', () => {
  const result = classifyTiles(solidRgb(32, 32, 128), { width: 32, height: 32, tileSize: 16 })
  assert.equal(result.tileColumns, 2)
  assert.equal(result.tileRows, 2)
  assert.equal(result.tiles.length, 4)
  for (const tile of result.tiles) {
    assert.equal(tile.label, 'flat')
    assert.equal(tile.luma, 128)
    assert.equal(tile.std, 0)
    assert.equal(tile.edgeDensity, 0)
    assert.equal(tile.saturation, 0)
  }
  assert.deepEqual(result.shares, { text: 0, picture: 0, texture: 0, flat: 1, dark: 0 })
  assert.equal(shareUnits(result.shares), 10000)
  assert.deepEqual(result.blocks, [
    { label: 'flat', x: 0, y: 0, width: 32, height: 32, tiles: 4, areaRatio: 1 },
  ])
})

test('暗与平的界：std 决定"平不平"，luma 决定"平的是黑还是亮"', () => {
  const black = classifyTiles(solidRgb(16, 16, 0), { width: 16, height: 16, tileSize: 16 })
  assert.equal(black.tiles[0].label, 'dark')
  assert.deepEqual(black.shares, { text: 0, picture: 0, texture: 0, flat: 0, dark: 1 })

  const darkGrey = classifyTiles(solidRgb(16, 16, 40), { width: 16, height: 16, tileSize: 16 })
  assert.equal(darkGrey.tiles[0].label, 'dark')
  const grey = classifyTiles(solidRgb(16, 16, 60), { width: 16, height: 16, tileSize: 16 })
  assert.equal(grey.tiles[0].label, 'flat')
})

test('棋盘：边缘密且不彩色 → text，边缘密度就是可复算的那个数', () => {
  const frame = rgbFrame(16, 16, (x, y) => ((x + y) % 2 === 0 ? [255, 255, 255] : [0, 0, 0]))
  const result = classifyTiles(frame, { width: 16, height: 16, tileSize: 16 })
  const tile = result.tiles[0]
  assert.equal(tile.label, 'text')
  assert.equal(tile.saturation, 0)
  // (15×16 条右比较 + 16×15 条下比较) 全部越界，除以 16×16×2。
  assert.equal(tile.edgeDensity, 0.9375)
  assert.deepEqual(result.shares, { text: 1, picture: 0, texture: 0, flat: 0, dark: 0 })
})

test('彩色渐变：亮度标准差不大，靠饱和度判成 picture', () => {
  const frame = rgbFrame(64, 16, (x) => [120 + 2 * x, 60, 60])
  const result = classifyTiles(frame, { width: 64, height: 16, tileSize: 64 })
  const tile = result.tiles[0]
  assert.equal(tile.label, 'picture')
  assert.ok(tile.saturation > DEFAULT_THRESHOLDS.pictureSaturation)
  // 标准差没到 pictureStd：这条 picture 只可能来自饱和度那条路径。
  assert.ok(tile.std >= DEFAULT_THRESHOLDS.flatStd)
  assert.ok(tile.std < DEFAULT_THRESHOLDS.pictureStd)
  assert.equal(tile.edgeDensity, 0)
  // 把标准差那条路径关掉，结论不变，证明它走的确实是饱和度。
  assert.equal(classifyTiles(frame, { width: 64, height: 16, tileSize: 64, thresholds: { pictureStd: 1000 } }).tiles[0].label, 'picture')
})

test('灰度平滑渐变：没有饱和度，靠"标准差大 + 边缘不密"判成 picture', () => {
  const frame = grayFrame(64, 16, (x) => Math.round(x * 4))
  const result = classifyTiles(frame, { width: 64, height: 16, tileSize: 64, channels: 1 })
  const tile = result.tiles[0]
  assert.equal(tile.edgeDensity, 0)
  assert.ok(tile.std >= DEFAULT_THRESHOLDS.pictureStd)
  assert.equal(tile.label, 'picture')
  // 关掉这条路，它就只能回到 texture —— 说明 picture 是这条路判出来的。
  const strict = classifyTiles(frame, { width: 64, height: 16, tileSize: 64, channels: 1, thresholds: { pictureStd: 1000 } })
  assert.equal(strict.tiles[0].label, 'texture')
})

test('灰条纹：有结构但不密、不彩色、也不够"照片" → texture', () => {
  const frame = grayFrame(16, 16, (x) => (x % 4 < 2 ? 120 : 140))
  const result = classifyTiles(frame, { width: 16, height: 16, tileSize: 16, channels: 1 })
  const tile = result.tiles[0]
  // 相邻差 20 小于 edgeGradient 24，所以一条边都不算。
  assert.equal(tile.edgeDensity, 0)
  assert.ok(tile.std >= DEFAULT_THRESHOLDS.flatStd)
  assert.ok(tile.std < DEFAULT_THRESHOLDS.pictureStd)
  assert.equal(tile.label, 'texture')
})

test('三种标签各占一块：占比按最大余额法取整，相加正好是 1', () => {
  const frame = rgbFrame(48, 16, (x, y) => {
    if (x < 16) return [128, 128, 128]
    if (x < 32) return [0, 0, 0]
    return (x + y) % 2 === 0 ? [255, 255, 255] : [0, 0, 0]
  })
  const result = classifyTiles(frame, { width: 48, height: 16, tileSize: 16 })
  assert.equal(result.tileColumns, 3)
  assert.deepEqual(result.tiles.map((tile) => tile.label), ['flat', 'dark', 'text'])
  assert.equal(shareUnits(result.shares), 10000)
  // 三等分：余下的那 1e-4 按 APPEARANCE_CLASSES 的顺序补给 text。
  assert.deepEqual(result.shares, { text: 0.3334, picture: 0, texture: 0, flat: 0.3333, dark: 0.3333 })
  assert.deepEqual(result.blocks.map((block) => block.label), ['flat', 'dark', 'text'])
  for (const block of result.blocks) {
    assert.equal(block.width, 16)
    assert.equal(block.height, 16)
    assert.equal(block.tiles, 1)
    assert.equal(block.areaRatio, 0.3333)
  }
})

test('右/下边缘的瓦片被裁短而不是补空：瓦片面积加起来就是整帧', () => {
  const result = classifyTiles(solidRgb(40, 20, 200), { width: 40, height: 20, tileSize: 16 })
  assert.equal(result.tileColumns, 2)
  assert.equal(result.tileRows, 1)
  assert.deepEqual(result.tiles.map((tile) => [tile.x, tile.y, tile.width, tile.height]), [
    [0, 0, 16, 20],
    [16, 0, 24, 20],
  ])
  const area = result.tiles.reduce((sum, tile) => sum + tile.width * tile.height, 0)
  assert.equal(area, 40 * 20)
  assert.equal(shareUnits(result.shares), 10000)
  assert.deepEqual(result.blocks, [
    { label: 'flat', x: 0, y: 0, width: 40, height: 20, tiles: 2, areaRatio: 1 },
  ])
})

test('瓦片比画面还大：退化成覆盖全帧的一块瓦片，而不是抛错', () => {
  const frame = solidRgb(16, 16, 128)
  for (const tileSize of [1000, 16, 0, undefined, -4, Number.NaN]) {
    const result = classifyTiles(frame, { width: 16, height: 16, tileSize })
    assert.equal(result.tiles.length, 1, `tileSize=${tileSize}`)
    assert.equal(result.tileColumns, 1)
    assert.equal(result.tileRows, 1)
    assert.deepEqual(
      [result.tiles[0].x, result.tiles[0].y, result.tiles[0].width, result.tiles[0].height],
      [0, 0, 16, 16],
    )
    assert.equal(result.tiles[0].label, 'flat')
    assert.equal(result.blocks.length, 1)
    // 没给 tileSize 时用的是默认值 16。
    if (tileSize === undefined) assert.equal(result.tileSize, DEFAULT_TILE_SIZE)
  }
})

test('灰度输入（channels: 1）：饱和度恒为 0，标签只由亮度分布与边缘决定', () => {
  const flat = classifyTiles(grayFrame(8, 8, () => 90), { width: 8, height: 8, tileSize: 8, channels: 1 })
  assert.equal(flat.tiles[0].label, 'flat')
  assert.equal(flat.tiles[0].saturation, 0)
  assert.equal(flat.tiles[0].luma, 90)

  const checker = classifyTiles(grayFrame(8, 8, (x, y) => ((x + y) % 2 === 0 ? 255 : 0)), {
    width: 8,
    height: 8,
    tileSize: 8,
    channels: 1,
  })
  assert.equal(checker.tiles[0].label, 'text')
  assert.equal(checker.tiles[0].edgeDensity, 0.875)
})

test('参数不对就抛 TypeError：宽高必须是正整数，像素缓冲必须够一整帧', () => {
  const frame = solidRgb(8, 8, 0)
  assert.throws(() => classifyTiles(frame, { height: 8 }), TypeError)
  assert.throws(() => classifyTiles(frame, { width: 0, height: 8 }), TypeError)
  assert.throws(() => classifyTiles(frame, { width: 8, height: -1 }), TypeError)
  assert.throws(() => classifyTiles(frame, { width: 100, height: 100 }), TypeError)
  assert.throws(() => classifyTiles('not pixels', { width: 8, height: 8 }), TypeError)
  // 比一整帧长的缓冲是允许的：调用方可能把整段 stream 交进来。
  const longer = classifyTiles(new Uint8Array(8 * 8 * 3 + 99), { width: 8, height: 8 })
  assert.equal(longer.tiles.length, 1)
})

test('确定性：同一帧、同一阈值，两次调用完全一样', () => {
  const frame = rgbFrame(32, 32, (x, y) => [(x * 8) % 256, (y * 8) % 256, (x * y) % 256])
  const first = classifyTiles(frame, { width: 32, height: 32, tileSize: 8 })
  const second = classifyTiles(frame, { width: 32, height: 32, tileSize: 8 })
  assert.deepEqual(first, second)
  assert.equal(first.tileColumns * first.tileRows, first.tiles.length)
  assert.equal(shareUnits(first.shares), 10000)
})

test('analysisFrameSize：长边不超上限、两边都是偶数、从不放大', () => {
  assert.deepEqual(analysisFrameSize(1920, 1080, 320), { width: 320, height: 180 })
  assert.deepEqual(analysisFrameSize(640, 480, 320), { width: 320, height: 240 })
  assert.deepEqual(analysisFrameSize(1080, 1920, 320), { width: 180, height: 320 })
  assert.deepEqual(analysisFrameSize(100, 50, 320), { width: 100, height: 50 })
  assert.deepEqual(analysisFrameSize(101, 51, 320), { width: 100, height: 50 })
  assert.deepEqual(analysisFrameSize(1, 1, 320), { width: 2, height: 2 })
  assert.deepEqual(analysisFrameSize(4000, 2000), { width: 320, height: 160 })
  assert.deepEqual(analysisFrameSize(4000, 2000, Number.NaN), { width: 320, height: 160 })
  assert.deepEqual(analysisFrameSize(1921, 1081, 321), { width: 320, height: 180 })
  assert.throws(() => analysisFrameSize(0, 10), TypeError)
  assert.throws(() => analysisFrameSize(10, Number.NaN), TypeError)
})

test('parseProbeStreamSize：读得出宽高，读不出就报 MediaError', () => {
  assert.deepEqual(parseProbeStreamSize('{"streams":[{"width":1920,"height":1080}]}'), { width: 1920, height: 1080 })
  assert.deepEqual(
    parseProbeStreamSize(Buffer.from('{"streams":[{"width":"640","height":"480"}]}')),
    { width: 640, height: 480 },
  )
  for (const bad of ['not json', '{}', '{"streams":[]}', '{"streams":[{"codec_type":"audio"}]}']) {
    assert.throws(
      () => parseProbeStreamSize(bad),
      (error) => error.name === 'MediaError',
      `应当拒绝：${bad}`,
    )
  }
})
