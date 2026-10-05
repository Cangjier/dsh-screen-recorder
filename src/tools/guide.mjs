/**
 * `screen_guide` — the plugin's own reference, read on demand.
 *
 * Nothing here measures anything: it renders `registry.mjs` and the playbooks beside it. That is
 * deliberate — the schema the model sees every turn and the long-form answer are built from the same
 * table, so the two cannot disagree.
 *
 * @module dsh-screen-recorder/tools/guide
 */
import { ACTION_ARGUMENTS, PLAYBOOKS, RULES, TOOL_ORDER, TOOL_REGISTRY, lookupAction, lookupTool } from './registry.mjs'
import { ScreenPluginError, defineFamilyTool } from './shared.mjs'

/** Every action `screen_guide` dispatches. */
export const GUIDE_ACTIONS = ['overview', 'playbook', 'rules', 'tool', 'action']

/** What each tool needs before it can work, in one line, for the overview page. */
const COST = {
  screen_env: '几乎不花钱：几条 ffmpeg 列表命令，结果按可执行文件缓存。',
  screen_setup: '要网络；ffmpeg 约 200 MB，检测模型 12.8 MB。重复调用不会重复下载。',
  screen_record: '实时：录 N 秒就花 N 秒，之后还要解码数帧（大约再花录制时长的十分之一）。',
  screen_analyze: '主要开销是解码一遍素材 + 每次关键帧的 OCR，以及每帧约 1 秒的 YOLO；语音转文字按音频长度走。',
  screen_guide: '不花钱：纯计算。',
}

/**
 * Build the `screen_guide` tool.
 *
 * @returns {object} a raw tool definition.
 */
export function createGuideTool() {
  const where = 'screen_guide'

  return defineFamilyTool({
    name: 'screen_guide',
    actions: GUIDE_ACTIONS,
    extraProperties: {
      job: {
        type: 'string',
        enum: Object.keys(PLAYBOOKS),
        description: 'playbook: which recipe to expand. Omit to list the recipes and what each is for.',
      },
      tool: {
        type: 'string',
        enum: TOOL_ORDER,
        description: 'tool: which tool to describe in full.',
      },
      actionName: {
        type: 'string',
        description: 'action: the action to describe in full, for example "analyze" or "screen". It goes here, not in "action" — "action" selects this reference action.',
      },
    },
    handlers: {
      /**
       * Every tool and action, one line each.
       * @returns {Promise<object>} the overview.
       */
      async overview() {
        return {
          plugin: 'dsh-screen-recorder',
          tools: TOOL_ORDER.map((name) => ({
            name,
            purpose: TOOL_REGISTRY[name].purpose,
            actions: Object.keys(TOOL_REGISTRY[name].actions),
            cost: COST[name],
          })),
          order: [
            '1. screen_env {action:"probe"} —— 先确认这台机器能录（gdigrab/dshow）以及各个识别组件装没装。',
            '2. screen_record {action:"screen"} —— 录一段固定长度的画面（要旁白就同时录麦）。',
            '3. screen_analyze {action:"scenes"} —— 先只看时间轴，确认分段粒度。',
            '4. screen_analyze {action:"analyze"} —— 完整跑一遍，拿 structure.json + 关键帧 + 联系表 + 交付视频。',
          ],
          note: '每个 action 的完整参数、返回形状与坑：screen_guide {action:"action", actionName:"..."}。',
        }
      },

      /**
       * One recipe, or the list of them.
       * @param {object} args - the tool arguments.
       * @returns {Promise<object>} the recipe.
       */
      async playbook(args) {
        const job = typeof args.job === 'string' && args.job !== '' ? args.job : null
        if (job === null) {
          return {
            jobs: Object.entries(PLAYBOOKS).map(([id, entry]) => ({ job: id, title: entry.title, when: entry.when })),
            note: '传 job 拿完整步骤：screen_guide {action:"playbook", job:"record-and-understand"}。',
          }
        }
        const entry = PLAYBOOKS[job]
        if (entry === undefined) throw new ScreenPluginError(`${where}: 没有这个 job ${JSON.stringify(job)}；可选 ${Object.keys(PLAYBOOKS).join(', ')}。`)
        return { job, ...entry }
      },

      /**
       * The rules that apply to every job.
       * @returns {Promise<object>} the rules.
       */
      async rules() {
        return {
          rules: RULES,
          neighbours: [
            { owner: 'dsh-ffmpeg', fact: '转码、裁剪、拼接、抽帧做封面、烧字幕、以及通用的媒体探测都归它；本插件只做录屏与结构化。' },
            { owner: 'dsh-ocr', fact: '只读文字与坐标时用它；本插件优先借用它的离线引擎，借不到就退回 Windows 自带识别。' },
            { owner: 'dsh-video-audio', fact: '音频测量、降噪、事件检测归它；它同时拥有本插件推理所依赖的 ONNX WASM 运行时。' },
            { owner: 'video-factory', fact: '成片、旁白、字幕与素材编排归它；本插件的交付视频只是一份便于播放的副本。' },
            { owner: 'dsh-computer-use', fact: '要操作鼠标键盘、或按屏幕上的文字点击，用它；本插件的文字是录下来的，不是拿来点的。' },
          ],
        }
      },

      /**
       * One tool in full.
       * @param {object} args - the tool arguments.
       * @returns {Promise<object>} the tool.
       */
      async tool(args) {
        const name = typeof args.tool === 'string' && args.tool !== '' ? args.tool : ''
        const entry = lookupTool(name)
        if (entry === undefined) {
          throw new ScreenPluginError(`${where}: 没有这个工具 ${JSON.stringify(name)}；可选 ${TOOL_ORDER.join(', ')}。`)
        }
        return {
          tool: name,
          purpose: entry.purpose,
          needs: entry.needs,
          next: entry.next,
          cost: COST[name],
          actions: Object.entries(entry.actions).map(([action, detail]) => ({
            action,
            summary: detail.summary,
            required: detail.required ?? [],
            arguments: ACTION_ARGUMENTS[action] ?? [],
            returns: detail.returns,
            use: detail.use ?? null,
            avoid: detail.avoid ?? null,
            example: detail.example,
          })),
        }
      },

      /**
       * One action in full.
       * @param {object} args - the tool arguments.
       * @returns {Promise<object>} the action.
       */
      async action(args) {
        const name = typeof args.actionName === 'string' && args.actionName !== '' ? args.actionName : ''
        const found = lookupAction(name)
        if (found === null) {
          const all = TOOL_ORDER.flatMap((tool) => Object.keys(TOOL_REGISTRY[tool].actions))
          throw new ScreenPluginError(`${where}: 没有这个 action ${JSON.stringify(name)}；可选 ${all.join(', ')}。`)
        }
        const detail = found.entry
        return {
          tool: found.tool,
          action: name,
          summary: detail.summary,
          required: detail.required ?? [],
          arguments: ACTION_ARGUMENTS[name] ?? [],
          returns: detail.returns,
          use: detail.use ?? null,
          avoid: detail.avoid ?? null,
          example: detail.example,
          pitfalls: pitfallsFor(name),
        }
      },
    },
  })
}

/**
 * The mistakes that keep happening, per action.
 *
 * Kept beside the guide rather than in the registry because these are the answers to "why did that
 * not work", not part of what an action is.
 *
 * @param {string} action - the action name.
 * @returns {string[]} short Chinese sentences; empty when there is nothing worth warning about.
 */
function pitfallsFor(action) {
  const shared = {
    analyze: [
      'outDir 里会写 keyframes/、联系表、章节文件与交付视频；先把目录定下来，免得产物散在工作目录里。',
      '长录屏先跑 scenes 看分段，再决定 maxKeyframes / detectMaxFrames：YOLO 每帧约一秒，是唯一明显花钱的一步。',
      'warnings 里写着哪一节没跑成（没装模型、没有语音服务、某段抽帧失败），不要把它当噪音。',
    ],
    scenes: [
      'sceneThreshold 是 0–255 的平均亮度差：8 是默认，整屏切换通常 40 以上，画面里小范围变化可能只有 1–2。',
      'fps 决定时间轴的分辨率：4 意味着两次测量之间 0.25 秒内的变化看不见。',
    ],
    regions: [
      '返回的是外观类别（文字密、图像、纹理、纯色、暗），不是"按钮/标题"这种 UI 语义。',
      'tileSize 大于画面时整体退化成一块，不会报错。',
    ],
    detect: [
      '模型没装会直接失败并给出安装提示；screen_env {action:"components"} 可以先看。',
      '框坐标是源视频像素，不是模型输入（640）的像素；缩放与 letterbox 都已经折回去了。',
    ],
    transcribe: [
      '需要宿主提供 speechToText 服务；没有时失败信息里写着要启用哪个 bundle。',
      '识别请求按检测到的停顿切分，并把数量压到 maxIntervals 以内；被合并过会在 notes 里说明。',
    ],
    screen: [
      '必须给 seconds：这个工具没有"录到我说停"的模式。',
      'window 与 region 互斥；抓窗口时窗口一关就结束，测量会把短录报告出来。',
      '没写 audioDevice 就没有声音，后面 transcribe 自然是空的。',
    ],
    microphone: [
      'device 必须与 screen_env {action:"devices"} 报的名字一字不差。',
      '设备被会议软件占用时录不到声音：测量里 audio 会是 null。',
    ],
    install_ffmpeg: [
      '装完会在同一次进程里立刻生效（插件清了缓存）。',
      '本地 archive 也要过 sha256 校验；不想校验就用配置里的 ffmpegPath 直接指。',
    ],
    install_detector: [
      '只装模型（12.8 MB）；共享推理运行时由 dsh-video-audio 拥有，插件会尝试从同级检出复制而不重下。',
      '权重是 AGPL-3.0：插件只按需下载，不随仓库分发。',
    ],
    probe: ['它只读不写：不会安装、不会录制、不会改变任何东西。'],
    devices: ['列设备时 ffmpeg 故意返回非零退出码并写在 stderr，这里已按正常结果解析。'],
    components: ['四件事互相独立：OCR、YOLO、语音任一不可用，时间轴与区域分割照常工作。'],
  }
  return shared[action] ?? []
}
