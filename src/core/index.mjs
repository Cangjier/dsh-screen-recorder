/**
 * The public core of `dsh-screen-recorder`.
 *
 * Everything a tool handler needs, re-exported in one place, so the tools never reach into the
 * folder's internals and the module boundaries stay visible. The pieces:
 *
 * - `home.mjs` / `env.mjs` — where this plugin and its shared assets are, and which ffmpeg answers.
 * - `ffmpeg.mjs` — the one queue every process goes through.
 * - `caps.mjs` — what this build of ffmpeg can actually do, before a capture starts.
 * - `record.mjs` / `container.mjs` — planning a capture, and measuring what it wrote.
 * - `probe.mjs` / `image.mjs` — what a file is, and how its pixels are read.
 * - `timeline.mjs` / `segmentation.mjs` — the timeline, and the appearance regions of a frame.
 * - `ocr.mjs` / `vision.mjs` / `asr.mjs` — text, objects and speech.
 * - `structure.mjs` / `analysis.mjs` — the fusion, and the naming rules it uses.
 * - `install.mjs` / `vision-install.mjs` — provisioning ffmpeg and the detector.
 *
 * @module dsh-screen-recorder/core
 */
export { PLUGIN_ROOT, SHARED_ROOT, SHARED_FFMPEG_BIN, SHARED_YOLO_DIR, SHARED_RUNTIME_DIR, sharedHomeState } from './home.mjs'
export { requireTool, resolveCwd, resolveTool, siblingRoots, vendoredState, versionOf } from './env.mjs'
export { MediaError, concurrencyState, runFfmpeg, runFfprobe, setMaxConcurrent, stderrTail } from './ffmpeg.mjs'
export { capabilities, checkNeeds, resetCapabilityCache } from './caps.mjs'
export { ContainerError, containerFor } from './container.mjs'
export { MAX_RECORD_SECONDS, audioPlan, capture, measureCapture, screenPlan } from './record.mjs'
export { probeMedia } from './probe.mjs'
export { fitInside, readPixels, scaleFactor } from './image.mjs'
export { detectScenes } from './timeline.mjs'
export { APPEARANCE_CLASSES, classifyTiles, segmentImage } from './segmentation.mjs'
export { OcrError, ocrImage, ocrStatus, resetOcrCache } from './ocr.mjs'
export {
  COCO_CLASSES,
  DETECTOR_MODEL,
  decodeDetections,
  detectFrame,
  detectFrames,
  detectorState,
  disposeDetector,
  nonMaxSuppression,
  resolveRuntime,
  runtimeInstallHint,
} from './vision.mjs'
export { adoptRuntime, detectorBytes, detectorInstallState, installDetector, removeDetector } from './vision-install.mjs'
export { asrState, mergeIntervals, parseSilences, speechIntervals, transcribeIntervals } from './asr.mjs'
export { ANALYSIS_DEFAULTS, ASR_DEFAULTS, DETECTOR_DEFAULTS, OCR_DEFAULTS, assignToSegments, classifySegment, extractKeywords, groupKinds } from './analysis.mjs'
export { STRUCTURE_VERSION, analyzeRecording, resolveSettings } from './structure.mjs'
export { DEFAULT_SOURCE, FFMPEG_SOURCES, installFfmpeg, installState } from './install.mjs'
