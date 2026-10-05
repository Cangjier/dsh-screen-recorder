/**
 * `screen_setup` — provisioning ffmpeg and the object detector.
 *
 * @module dsh-screen-recorder/tools/setup
 */
import { FFMPEG_SOURCES, installFfmpeg, installState } from '../core/install.mjs'
import { resetToolCache } from '../core/env.mjs'
import { resetCapabilityCache } from '../core/caps.mjs'
import { detectorInstallState, installDetector, removeDetector } from '../core/vision-install.mjs'
import { SHARED_YOLO_DIR } from '../core/home.mjs'
import { FORCE_PROPERTY, ScreenPluginError, defineFamilyTool, optionalBoolean, optionalEnum } from './shared.mjs'

/** Every action `screen_setup` dispatches. */
export const SETUP_ACTIONS = ['install_ffmpeg', 'install_detector', 'remove_detector']

/**
 * Build the `screen_setup` tool.
 *
 * @param {object} config - normalized plugin config.
 * @param {object} logger - the host plugin's logger.
 * @returns {object} a raw tool definition.
 */
export function createSetupTool(config, logger) {
  const where = 'screen_setup'

  return defineFamilyTool({
    name: 'screen_setup',
    actions: SETUP_ACTIONS,
    extraProperties: {
      source: {
        type: 'string',
        enum: Object.keys(FFMPEG_SOURCES),
        description: `install_ffmpeg: which build to fetch. Default "gyan-release" — version-pinned with an enforced SHA-256. "btbn-latest" follows a moving tag and can only record its digest.`,
      },
      allowDigestMismatch: {
        type: 'boolean',
        description: 'install_ffmpeg: accept a download whose SHA-256 differs from the pinned one. Only after confirming the archive really was republished upstream.',
      },
      force: FORCE_PROPERTY,
      archive: {
        type: 'string',
        description: 'install_ffmpeg / install_detector: use this local file instead of downloading. The pinned digest is still checked, so a local file is never an unverified one. Resolved against the process working directory, not "cwd".',
      },
    },
    handlers: {
      /**
       * Install the shared ffmpeg build.
       * @param {object} args - the tool arguments.
       * @returns {Promise<object>} what was installed.
       */
      async install_ffmpeg(args) {
        const source = optionalEnum(args, 'source', Object.keys(FFMPEG_SOURCES), undefined, `${where} install_ffmpeg`)
        const force = optionalBoolean(args, 'force', false, `${where} install_ffmpeg`)
        const allowDigestMismatch = optionalBoolean(args, 'allowDigestMismatch', false, `${where} install_ffmpeg`)
        const archive = typeof args.archive === 'string' && args.archive !== '' ? args.archive : undefined

        logger.info(`dsh-screen-recorder: 开始安装 ffmpeg（source=${source ?? 'default'}, force=${force}）`)
        const result = await installFfmpeg({
          source,
          force,
          archive,
          allowDigestMismatch,
          onProgress: (message) => logger.info(`dsh-screen-recorder: ${message}`),
        })
        // A newly unpacked binary must be found by the next call in this same process.
        resetToolCache()
        resetCapabilityCache()
        const state = installState(config)
        return {
          ...result,
          state,
          notes: [
            result.installed === true ? `ffmpeg 已装进 ${state.binDir}` : (result.reason ?? '已经有可执行文件，没有重新下载。'),
            '这份构建由全家族共用：dsh-ffmpeg / dsh-video-audio / dsh-ocr 都会找到同一份。',
          ],
        }
      },

      /**
       * Install the pinned YOLO detector model.
       * @param {object} args - the tool arguments.
       * @returns {Promise<object>} what was installed and what is still missing.
       */
      async install_detector(args) {
        const force = optionalBoolean(args, 'force', false, `${where} install_detector`)
        const archive = typeof args.archive === 'string' && args.archive !== '' ? args.archive : undefined
        logger.info(`dsh-screen-recorder: 开始安装检测模型（force=${force}）`)
        const result = await installDetector({
          force,
          archive,
          config,
          onProgress: (message) => logger.info(`dsh-screen-recorder: ${message}`),
        })
        logger.info(`dsh-screen-recorder: 检测模型安装结果 available=${result.available}`)
        return { ...result, state: (await detectorInstallState(config)).state }
      },

      /**
       * Delete the installed detector model.
       * @returns {Promise<object>} what was removed.
       */
      async remove_detector() {
        const result = removeDetector()
        return {
          ...result,
          directory: SHARED_YOLO_DIR,
          state: (await detectorInstallState(config)).state,
          notes: [
            result.note,
            '想恢复：screen_setup {action:"install_detector"}（12.8 MB，摘要校验）。',
          ],
        }
      },
    },
  })
}

/** Re-exported for the tool index, so a missing export is a load-time error rather than a runtime one. */
export { ScreenPluginError }
