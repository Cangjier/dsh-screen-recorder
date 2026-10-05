/**
 * The shared plugin home: one directory for the static dependencies every plugin in this family
 * borrows.
 *
 * This plugin is independent — it can be cloned and installed on its own — but it must not keep a
 * second copy of assets its siblings already own. So discovery reads the same three places the rest
 * of the family reads, in the same order, and each asset keeps its own `SOURCE.json`:
 *
 * ```
 * ~/.dsh-plugins/
 *   ffmpeg/bin/            ffmpeg.exe, ffprobe.exe, ffplay.exe (shared by the whole family)
 *   ocr/<source>/          the offline OCR engine (dsh-ocr installs it)
 *   models/yolo/           the YOLOv8n ONNX detector this plugin installs
 *   models/u2netp/         the matting model (video-factory)
 *   lib/onnxruntime-web/   the ONNX WASM runtime, shared by every model that runs here
 * ```
 *
 * **Resolution is not an env var.** The root is derived from **the home directory** — one per user,
 * so two users on one machine cannot see or overwrite each other's 200 MB, and a machine that moves
 * keeps working. `DSH_PLUGIN_HOME` overrides it for the machine whose home directory is not where
 * the assets should go.
 *
 * Nothing here writes anything; the installers own that, and every state report names which rule
 * answered.
 *
 * This module is deliberately self-contained and duplicated in each plugin: the packages are
 * independent, and a plugin installed on its own must not need a checkout of the others to find its
 * own binaries.
 *
 * @module dsh-screen-recorder/core/home
 */
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

/** This plugin's package root, resolved from this module so a `link:` install still works. */
export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The directory name every plugin in this family shares. */
export const HOME_DIR_NAME = '.dsh-plugins'

/** Environment variable that overrides where the shared root is, for one machine. */
export const HOME_ENV = 'DSH_PLUGIN_HOME'

/** The absolute path of the shared root. The single place the layout is named. */
export const SHARED_ROOT = resolve(
  process.env[HOME_ENV]?.trim() ? process.env[HOME_ENV].trim() : join(homedir(), HOME_DIR_NAME),
)

/**
 * A path below the shared root.
 * @param {...string} parts - path segments below the root.
 * @returns {string} the absolute path.
 */
export function sharedPath(...parts) {
  return join(SHARED_ROOT, ...parts)
}

/** The shared ffmpeg directory: holds `bin/` and a `SOURCE.json`. */
export const SHARED_FFMPEG_DIR = sharedPath('ffmpeg')

/** The shared ffmpeg binary directory: what discovery runs, and what an install writes. */
export const SHARED_FFMPEG_BIN = sharedPath('ffmpeg', 'bin')

/** The shared OCR engine directory. Owned by `dsh-ocr`, read by this plugin. */
export const SHARED_OCR_DIR = sharedPath('ocr')

/** The shared models directory. */
export const SHARED_MODELS_DIR = sharedPath('models')

/** The shared YOLO detector directory: what this plugin installs. */
export const SHARED_YOLO_DIR = sharedPath('models', 'yolo')

/** The shared matting model directory. */
export const SHARED_MATTE_DIR = sharedPath('models', 'u2netp')

/** The shared library directory. The ONNX WASM runtime lives here. */
export const SHARED_LIB_DIR = sharedPath('lib')

/** The shared ONNX WASM runtime directory. */
export const SHARED_RUNTIME_DIR = sharedPath('lib', 'onnxruntime-web')

/**
 * The executable name for one ffmpeg-family tool on this platform.
 *
 * Only Windows carries this family today — every installer here downloads a `win64` build, and every
 * capture input is `gdigrab`/`dshow` — so on any other platform the name is one nothing will match,
 * which is what a non-Windows host should conclude from a directory of `.exe` files.
 *
 * @param {'ffmpeg'|'ffprobe'|'ffplay'} stem - which binary.
 * @returns {string} the file name.
 */
export function binaryName(stem) {
  return process.platform === 'win32' ? `${stem}.exe` : stem
}

/**
 * Where the shared root came from, for a report that has to be checkable.
 *
 * @returns {{sharedRoot: string, source: 'env'|'home', envVar: string, homeDir: string}} the root and the rule that produced it.
 */
export function sharedHomeState() {
  const fromEnv = typeof process.env[HOME_ENV] === 'string' && process.env[HOME_ENV].trim() !== ''
  return {
    sharedRoot: SHARED_ROOT,
    source: fromEnv ? 'env' : 'home',
    envVar: HOME_ENV,
    homeDir: homedir(),
  }
}
