/**
 * 把一帧切成带外观标签的矩形 —— 没有模型，全部是阈值。
 *
 * 先说清楚这些标签是什么，因为读输出的人要拿它做判断：这是**外观类别**，逐瓦片测量、再合并成
 * 矩形。它们描述一块地方「看起来像什么」—— 细密高频的边缘、纯净的填充、色彩丰富的画面、
 * 有结构但不带颜色 —— 在一段录屏上这已经是大半信息。它们**不是**一个训练过的分割网络的输出，
 * 这里也不会猜某个矩形是按钮而不是段落。谁想用「按钮/段落」这种说法，那是 DSH 的判断，不是
 * 这个模块的测量。
 *
 * 一切都是像素缓冲上的纯函数，这正是「可复核」的来源：同一帧、同一张阈值表，在任何机器上给出
 * 同一组矩形。阈值表 {@link DEFAULT_THRESHOLDS} 是导出的冻结常量，所以一个标签可以被拿出来争论：
 * 数字就在那里，`screen_analyze` 读的也是同一张表。
 *
 * 判定顺序就是论证顺序，改顺序等于改结论：
 *
 * 1. `std < flatStd` → `dark`（`luma < darkLuma`）或 `flat`。**先判平**：一条黑边和一段密集
 *    代码可以有同样的平均亮度，除此之外毫无共同点；
 * 2. 边缘密且不彩色 → `text`。**先判结构再判颜色**：彩色文字也该被读成文字；
 * 3. 饱和度高，或亮度标准差大而边缘不密 → `picture`（照片、视频画面、彩色插图）。
 *    第二条路径是本插件补的：一张灰度照片没有饱和度，但它的亮度分布又宽又连续；
 * 4. 边缘密度超过 `textureEdgeDensity` 却不像文字也不像画面 → `texture`；剩下的（有结构但很安静）
 *    同样记成 `texture`，而不是硬塞进 `flat` —— 那等于宣称一个数字否认的均匀性。
 *
 * 两处与 dsh-ffmpeg 的同名模块刻意不同，写在这里免得被当成疏漏：
 *
 * - 这里**不丢弃**任何小矩形。dsh-ffmpeg 的表里还有一个 `minAreaRatio`（0.004）用来丢掉过小的
 *   区域；本模块把全部矩形交出去，过滤是调用方的判断。所以那张表在这里没有这个键；
 * - `shares` 是**像素面积**占比，且用最大余额法取整，保证相加恰好是 1（浮点表示下是 `1e-4` 的
 *   整数倍之和）。瓦片在右、下边缘可能被裁短，按面积算才不会把这一圈算多。
 *
 * @module dsh-screen-recorder/core/segmentation
 */
import { MediaError, runFfmpeg, runFfprobe } from './ffmpeg.mjs'

/** 词汇表。每个标签只说外观，不说意图。 */
export const APPEARANCE_CLASSES = Object.freeze(['text', 'picture', 'texture', 'flat', 'dark'])

/** 默认瓦片边长，单位是分析帧的像素。 */
export const DEFAULT_TILE_SIZE = 16

/** 分析帧长边的默认像素数；与 `ANALYSIS_DEFAULTS.maxSide` 镜像。 */
export const DEFAULT_MAX_SIDE = 320

/** 探测超时：读一个文件头不该等上一分钟。 */
export const PROBE_TIMEOUT_MS = 60000

/**
 * 阈值表，全部测在 0–255 的亮度尺度上。
 *
 * 除了 `pictureStd`，每个值都来自 `dsh-ffmpeg/src/core/segmentation.mjs` 的实测表；`pictureStd`
 * 是本插件补的（那张表没有「灰度照片」这条路径），它只影响「亮度分布很宽但没有彩色」的瓦片。
 */
export const DEFAULT_THRESHOLDS = Object.freeze({
  /** 亮度标准差低于此值的瓦片算「平的」。 */
  flatStd: 4,
  /** 平的瓦片平均亮度低于此值改判 dark。 */
  darkLuma: 48,
  /** 相邻像素亮度差超过此值算一条边。 */
  edgeGradient: 24,
  /** 低饱和瓦片的边缘像素占比超过此值算 text。 */
  textEdgeDensity: 0.09,
  /** 平均饱和度低于此值才可能算 text。 */
  textSaturation: 0.22,
  /** 平均饱和度高于此值算 picture。 */
  pictureSaturation: 0.18,
  /** 亮度标准差高于此值、且边缘不密（< textEdgeDensity）的瓦片算 picture。 */
  pictureStd: 12,
  /** 边缘像素占比超过此值、又不像文字的瓦片算 texture。 */
  textureEdgeDensity: 0.025,
})

/**
 * 四舍五入到 2 位小数。
 * @param {number} value - 原始数值。
 * @returns {number} 结果。
 */
function round2(value) {
  return Math.round(value * 100) / 100
}

/**
 * 四舍五入到 4 位小数。
 * @param {number} value - 原始数值。
 * @returns {number} 结果。
 */
function round4(value) {
  return Math.round(value * 10000) / 10000
}

/**
 * 取一个偶数，最小 2。
 * @param {number} value - 候选边长。
 * @returns {number} 偶数边长。
 */
function evenAtLeastTwo(value) {
  const rounded = Math.max(2, Math.round(value))
  return rounded % 2 === 0 ? rounded : rounded - 1
}

/**
 * 分析帧的实际像素尺寸：长边不超过 `maxSide`，两边都是偶数，且从不放大。
 *
 * 偶数不是审美要求：`rawvideo` 的帧没有帧头，调用方必须能从「长边像素数」直接算出每帧字节数，
 * 而奇数行在灰度采样时会被某些缩放路径改掉一位。从不放大则是因为分析帧只用来测量，把 100px 的
 * 画面拉成 320px 只会让边缘密度变成缩放算法的性质，而不是画面的性质。
 *
 * @param {number} sourceWidth - 源画面宽度。
 * @param {number} sourceHeight - 源画面高度。
 * @param {number} [maxSide] - 长边上限，默认 {@link DEFAULT_MAX_SIDE}。
 * @returns {{width: number, height: number}} 偶数尺寸。
 * @throws {TypeError} 源宽高不是正整数时。
 */
export function analysisFrameSize(sourceWidth, sourceHeight, maxSide = DEFAULT_MAX_SIDE) {
  const width = Math.round(Number(sourceWidth))
  const height = Math.round(Number(sourceHeight))
  if (!Number.isFinite(width) || width < 1 || !Number.isFinite(height) || height < 1) {
    throw new TypeError(
      `analysisFrameSize 需要正整数的源宽高，收到 ${JSON.stringify(sourceWidth)}×${JSON.stringify(sourceHeight)}`,
    )
  }
  const requested = Number(maxSide)
  const limit = Number.isFinite(requested) && requested >= 2 ? Math.floor(requested) : DEFAULT_MAX_SIDE
  const factor = Math.min(1, limit / Math.max(width, height))
  return { width: evenAtLeastTwo(width * factor), height: evenAtLeastTwo(height * factor) }
}

/**
 * 从 ffprobe 的 JSON 里读出视频流的宽高。
 *
 * 单独一个纯函数，是为了让「探测结果读不出来」这件事可以被直接测：一份 `{}`、一份坏 JSON、
 * 一份只有音频流的输出，都必须在解码之前就以 MediaError 结束，而不是等到解码出 0 字节。
 *
 * @param {string|Buffer} stdout - `ffprobe -of json` 的输出。
 * @returns {{width: number, height: number}} 源画面尺寸。
 * @throws {MediaError} 输出不是 JSON，或没有报出宽高时。
 */
export function parseProbeStreamSize(stdout) {
  let document
  try {
    document = JSON.parse(String(stdout))
  } catch (error) {
    throw new MediaError(`ffprobe 的输出不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
  const stream = Array.isArray(document?.streams) ? document.streams[0] : null
  const width = Math.floor(Number(stream?.width))
  const height = Math.floor(Number(stream?.height))
  if (!Number.isFinite(width) || width < 1 || !Number.isFinite(height) || height < 1) {
    throw new MediaError('ffprobe 没有报出视频流的宽高：输入可能没有视频流。')
  }
  return { width, height }
}

/**
 * 探测一次源尺寸，并算出本次分析要用的偶数帧尺寸。
 *
 * 时间轴和外观分割都从这一步开始，所以它只写一遍：两个模块必须对「每帧多少字节」有一致的答案，
 * 否则原始帧会被错位切开，而且错得很像一段真实的画面变化。
 *
 * @param {string} input - 要探测的文件。
 * @param {object} [options] - 这次探测。
 * @param {object} [options.config] - 归一化后的插件配置。
 * @param {number} [options.maxSide] - 分析帧长边上限。
 * @param {number} [options.timeoutMs] - 探测超时，默认 {@link PROBE_TIMEOUT_MS}。
 * @returns {Promise<{sourceWidth: number, sourceHeight: number, width: number, height: number}>} 源尺寸与分析尺寸。
 * @throws {MediaError} ffprobe 失败、超时，或输出里没有宽高。
 */
export async function probeAnalysisSize(input, options = {}) {
  const probe = await runFfprobe(
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', input],
    {
      config: options.config ?? {},
      label: `probe ${input}`,
      timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : PROBE_TIMEOUT_MS,
    },
  )
  const source = parseProbeStreamSize(probe.stdout)
  const frame = analysisFrameSize(source.width, source.height, options.maxSide)
  return { sourceWidth: source.width, sourceHeight: source.height, width: frame.width, height: frame.height }
}

/**
 * 给一块瓦片定一个外观标签。
 *
 * 读的是**取整后**的统计量（也就是报告里印出来的那几个数），所以任何一条标签都能用报告里的数字
 * 手工复算一遍 —— 一个无法用输出复核的分类器不值得信。
 *
 * @param {object} tile - `{luma, std, edgeDensity, saturation}`。
 * @param {object} limits - 阈值表。
 * @returns {string} {@link APPEARANCE_CLASSES} 中的一个。
 */
function classifyTile(tile, limits) {
  if (tile.std < limits.flatStd) return tile.luma < limits.darkLuma ? 'dark' : 'flat'
  if (tile.edgeDensity >= limits.textEdgeDensity && tile.saturation <= limits.textSaturation) return 'text'
  if (tile.saturation >= limits.pictureSaturation) return 'picture'
  if (tile.std >= limits.pictureStd && tile.edgeDensity < limits.textEdgeDensity) return 'picture'
  // 走到这里说明 `std >= flatStd`，也就是画面确实不平；有结构的记 texture，安静的也是 texture。
  return 'texture'
}

/**
 * 相邻同标签的瓦片合并成矩形，按阅读顺序（先上后下、先左后右）。
 *
 * 先沿行取等标签的连续段，再整体向下长，于是得到的是少数几个能读的矩形，而不是每块瓦片一个条目。
 * 已经被上面长下来的矩形占掉的瓦片不再重复认领：重叠的矩形会让面积加起来超过整帧。
 *
 * @param {object[]} tiles - 带 `label` 的瓦片，行优先排列。
 * @param {number} tileColumns - 列数。
 * @param {number} tileRows - 行数。
 * @param {number} width - 帧宽。
 * @param {number} height - 帧高。
 * @returns {object[]} 矩形块，含 `{label, x, y, width, height, tiles, areaRatio}`。
 */
function mergeBlocks(tiles, tileColumns, tileRows, width, height) {
  const at = (column, row) => tiles[row * tileColumns + column]
  const taken = new Set()
  const blocks = []

  for (let row = 0; row < tileRows; row += 1) {
    let column = 0
    while (column < tileColumns) {
      const start = at(column, row)
      if (start === undefined || taken.has(`${column}:${row}`)) {
        column += 1
        continue
      }
      let end = column
      while (end + 1 < tileColumns && at(end + 1, row)?.label === start.label && !taken.has(`${end + 1}:${row}`)) {
        end += 1
      }
      let bottom = row
      while (bottom + 1 < tileRows) {
        let same = true
        for (let c = column; c <= end; c += 1) {
          const tile = at(c, bottom + 1)
          if (tile === undefined || tile.label !== start.label || taken.has(`${c}:${bottom + 1}`)) {
            same = false
            break
          }
        }
        if (!same) break
        bottom += 1
      }

      let count = 0
      for (let r = row; r <= bottom; r += 1) {
        for (let c = column; c <= end; c += 1) {
          taken.add(`${c}:${r}`)
          count += 1
        }
      }
      const right = at(end, row)
      const low = at(column, bottom)
      const blockWidth = right.x + right.width - start.x
      const blockHeight = low.y + low.height - start.y
      blocks.push({
        label: start.label,
        x: start.x,
        y: start.y,
        width: blockWidth,
        height: blockHeight,
        tiles: count,
        areaRatio: round4((blockWidth * blockHeight) / (width * height)),
      })
      column = end + 1
    }
  }
  return blocks
}

/**
 * 按**像素面积**统计每个标签占整帧多少，并用最大余额法取整。
 *
 * 直接对每个占比取整，5 个值相加常常不是 1；把落下的 `1e-4` 补给小数部分最大的那个类别，
 * 相加就恰好是 1。平手时按 {@link APPEARANCE_CLASSES} 的顺序定，所以同一帧两次调用结果完全一样。
 *
 * @param {object[]} tiles - 带 `label`、`width`、`height` 的瓦片。
 * @returns {Record<string, number>} 每个标签的面积占比，4 位小数。
 */
function areaShares(tiles) {
  const areas = new Map(APPEARANCE_CLASSES.map((label) => [label, 0]))
  let total = 0
  for (const tile of tiles) {
    const area = tile.width * tile.height
    areas.set(tile.label, (areas.get(tile.label) ?? 0) + area)
    total += area
  }

  const raw = APPEARANCE_CLASSES.map((label) => (total === 0 ? 0 : (areas.get(label) ?? 0) / total))
  const units = raw.map((value) => Math.round(value * 10000))
  let left = 10000 - units.reduce((sum, value) => sum + value, 0)
  const byRemainder = APPEARANCE_CLASSES.map((label, index) => ({
    index,
    remainder: raw[index] * 10000 - Math.floor(raw[index] * 10000),
  })).sort((a, b) => b.remainder - a.remainder || a.index - b.index)

  // left 只会是 0、很小的正数或很小的负数：顺序按余额排，正数补给余额最大的，负数从余额最小的扣。
  const order = left >= 0 ? byRemainder : [...byRemainder].reverse()
  for (const entry of order) {
    if (left === 0) break
    if (left < 0 && units[entry.index] === 0) continue
    const step = left > 0 ? 1 : -1
    units[entry.index] += step
    left -= step
  }

  const shares = {}
  APPEARANCE_CLASSES.forEach((label, index) => {
    shares[label] = units[index] / 10000
  })
  return shares
}

/**
 * 把一帧的像素切成瓦片，逐块给外观标签，再把相邻同标签的瓦片并成矩形。
 *
 * 纯函数，不碰 ffmpeg、不碰磁盘、不看时钟：同样的像素与阈值给同样的矩形。瓦片边长大于画面时
 * 退化成**一整块覆盖全帧的瓦片**，而不是抛错 —— 一个 20×10 的画面配 16px 的瓦片是完全合法的
 * 一次调用，调用方不该因此失败。
 *
 * @param {Uint8Array} pixels - RGB24（`channels: 3`）或灰度（`channels: 1`）像素。
 * @param {object} options - 这一帧的几何。
 * @param {number} options.width - 帧宽。
 * @param {number} options.height - 帧高。
 * @param {number} [options.tileSize] - 瓦片边长，默认 {@link DEFAULT_TILE_SIZE}。
 * @param {1|3} [options.channels] - 每个像素几个字节，默认 3。
 * @param {object} [options.thresholds] - 覆盖 {@link DEFAULT_THRESHOLDS} 里的若干项。
 * @returns {object} 瓦片、占比与矩形块。
 * @throws {TypeError} 宽高不是正整数，或像素缓冲不够一整帧时。
 */
export function classifyTiles(pixels, options = {}) {
  const width = Math.floor(Number(options.width))
  const height = Math.floor(Number(options.height))
  if (!Number.isFinite(width) || width < 1 || !Number.isFinite(height) || height < 1) {
    throw new TypeError(
      `classifyTiles 需要正整数的 width/height，收到 ${JSON.stringify(options.width)}×${JSON.stringify(options.height)}`,
    )
  }
  const channels = Number(options.channels) === 1 ? 1 : 3
  const needed = width * height * channels
  if (!(pixels instanceof Uint8Array) || pixels.length < needed) {
    const got = pixels instanceof Uint8Array ? `${pixels.length} 字节` : String(typeof pixels)
    throw new TypeError(`classifyTiles 需要至少 ${needed} 字节的像素缓冲，收到 ${got}`)
  }
  const requested = Number(options.tileSize)
  const tileSize = Number.isFinite(requested) && requested >= 1 ? Math.max(1, Math.floor(requested)) : DEFAULT_TILE_SIZE
  const limits = { ...DEFAULT_THRESHOLDS, ...(options.thresholds ?? {}) }

  const tileColumns = Math.max(1, Math.floor(width / tileSize))
  const tileRows = Math.max(1, Math.floor(height / tileSize))
  const tiles = []

  for (let row = 0; row < tileRows; row += 1) {
    for (let column = 0; column < tileColumns; column += 1) {
      const x0 = column * tileSize
      const y0 = row * tileSize
      // 右、下边缘的瓦片被裁短而不是补空：部分瓦片是真实的瓦片，丢掉它会让画面留一条没被分类的
      // 带子，而声称的宽度比实际数过的像素多一个，又会让合并出来的矩形偏大、占比加起来超过 1。
      const x1 = column === tileColumns - 1 ? width : Math.min(width, x0 + tileSize)
      const y1 = row === tileRows - 1 ? height : Math.min(height, y0 + tileSize)

      let sum = 0
      let sumSquares = 0
      let saturation = 0
      let edges = 0
      let count = 0

      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const offset = (y * width + x) * channels
          const value = channels === 1
            ? pixels[offset]
            : 0.2126 * pixels[offset] + 0.7152 * pixels[offset + 1] + 0.0722 * pixels[offset + 2]
          sum += value
          sumSquares += value * value
          count += 1

          if (channels !== 1) {
            const r = pixels[offset]
            const g = pixels[offset + 1]
            const b = pixels[offset + 2]
            const max = Math.max(r, g, b)
            const min = Math.min(r, g, b)
            saturation += max === 0 ? 0 : (max - min) / max
          }
          if (x + 1 < width) {
            const right = offset + channels
            const rightValue = channels === 1
              ? pixels[right]
              : 0.2126 * pixels[right] + 0.7152 * pixels[right + 1] + 0.0722 * pixels[right + 2]
            if (Math.abs(rightValue - value) > limits.edgeGradient) edges += 1
          }
          if (y + 1 < height) {
            const below = offset + width * channels
            const belowValue = channels === 1
              ? pixels[below]
              : 0.2126 * pixels[below] + 0.7152 * pixels[below + 1] + 0.0722 * pixels[below + 2]
            if (Math.abs(belowValue - value) > limits.edgeGradient) edges += 1
          }
        }
      }

      const divisor = Math.max(1, count)
      const mean = sum / divisor
      const variance = Math.max(0, sumSquares / divisor - mean * mean)
      const tile = {
        column,
        row,
        x: x0,
        y: y0,
        width: x1 - x0,
        height: y1 - y0,
        luma: round2(mean),
        std: round2(Math.sqrt(variance)),
        edgeDensity: round4(edges / (divisor * 2)),
        saturation: round4(saturation / divisor),
      }
      tiles.push({ ...tile, label: classifyTile(tile, limits) })
    }
  }

  return {
    width,
    height,
    tileSize,
    tileColumns,
    tileRows,
    tiles,
    shares: areaShares(tiles),
    blocks: mergeBlocks(tiles, tileColumns, tileRows, width, height),
  }
}

/**
 * 解码**一帧**并做外观分割。
 *
 * 帧尺寸同样来自一次探测：`-frames:v 1` 交出的字节数本身就能说明尺寸，但要把它切成瓦片还得知道
 * 宽是多少，而原始帧没有帧头。默认按 rgb24 解码（和 `classifyTiles` 的 `channels: 3` 对应）；
 * 调用方明确要 `channels: 1` 时按 gray 解码，此时饱和度恒为 0，彩色的画面只能靠亮度标准差那条
 * 路径被读成 picture —— 这是选择灰度时要付的代价，写在明处。
 *
 * @param {object} request - 这次分割。
 * @param {string} request.input - 要取帧的视频或图片路径。
 * @param {number} [request.at] - 取第几秒的帧；省略或 0 表示第一帧。
 * @param {object} [request.config] - 归一化后的插件配置。
 * @param {number} [request.maxSide] - 分析帧长边上限。
 * @param {number} [request.tileSize] - 瓦片边长。
 * @param {1|3} [request.channels] - 解码通道数，默认 3。
 * @param {number} [request.timeoutMs] - 取帧的截止时间。
 * @returns {Promise<object>} {@link classifyTiles} 的结果，外加 `{input, at, elapsedMs}`。
 * @throws {MediaError} 输入不存在、探测失败、取不到帧，或帧不完整时。
 */
export async function segmentImage(request = {}) {
  const started = Date.now()
  const input = typeof request.input === 'string' ? request.input : ''
  if (input === '') throw new MediaError('segmentImage 需要一个 input 路径')

  const config = request.config ?? {}
  const at = Math.max(0, Number.isFinite(Number(request.at)) ? Number(request.at) : 0)
  const channels = Number(request.channels) === 1 ? 1 : 3
  const frame = await probeAnalysisSize(input, { config, maxSide: request.maxSide })

  const args = ['-v', 'error']
  if (at > 0) args.push('-ss', String(at))
  args.push(
    '-i', input,
    '-frames:v', '1',
    '-an', '-sn', '-dn',
    '-vf', `scale=${frame.width}:${frame.height}:flags=bilinear`,
    '-pix_fmt', channels === 1 ? 'gray' : 'rgb24',
    '-f', 'rawvideo', '-',
  )

  const run = await runFfmpeg(args, {
    config,
    label: `frame ${input}@${at}s`,
    ...(Number.isFinite(request.timeoutMs) ? { timeoutMs: request.timeoutMs } : {}),
  })

  const needed = frame.width * frame.height * channels
  if (run.stdout.length < needed) {
    throw new MediaError(
      `在 ${at}s 处没有解出完整的一帧：需要 ${needed} 字节，收到 ${run.stdout.length} 字节（可能超出了文件时长）。`,
      { code: run.code, elapsedMs: run.elapsedMs },
    )
  }

  return {
    ...classifyTiles(run.stdout, { width: frame.width, height: frame.height, tileSize: request.tileSize, channels }),
    input,
    at,
    elapsedMs: Date.now() - started,
  }
}
