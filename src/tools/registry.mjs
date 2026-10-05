/**
 * The single source of documentation for every `screen_*` tool.
 *
 * The schema the model sees is generated from this file, and so is `screen_guide`. That is the point:
 * a sentence written here is paid for once on every turn (as the action enum's description) and can
 * be read in full on demand, and there is no second copy to drift out of step with the handlers. A
 * tool or an action that is declared in code but missing here **fails registration**, so an
 * undocumented capability cannot ship.
 *
 * Writing rules, in order of importance:
 * - `summary` is one clause: what the action does.
 * - `required` names the arguments a first call gets wrong.
 * - `avoid` names the mistake this action prevents, or the neighbour that does the job better.
 * - `returns` is the shape a caller can rely on, not an exhaustive dump.
 * - `example` must be runnable as written.
 *
 * @module dsh-screen-recorder/tools/registry
 */

/** Every tool, in presentation order, with every action documented. */
export const TOOL_REGISTRY = {
  screen_env: {
    purpose:
      'Facts about this machine as a recording target and about what can read a recording back: which ffmpeg will run, what that build can capture and encode, which DirectShow devices exist, and whether text recognition, object detection and speech recognition are installed. It measures and reports; it changes nothing.',
    needs: ['Windows with PowerShell 5.1 for nothing here — the ffmpeg probe is enough.', 'ffmpeg for probe and devices; components reports what is missing without needing it.'],
    next: ['screen_record to capture', 'screen_setup to install what components says is missing'],
    actions: {
      probe: {
        summary: 'which ffmpeg answers, and what this build can capture, encode and filter.',
        use: 'the first call on a new machine, and the first call after any "it recorded nothing" report.',
        returns:
          '{ ffmpeg{path,source,label}, encoders[], filters[], devices[], capture{gdigrab,dshow}, concurrency{limit,active,waiting}, components{}, problems[] }',
        example: { action: 'probe' },
      },
      devices: {
        summary: 'every DirectShow capture device this machine reports, video and audio, by exact name.',
        use: 'before screen_record with audioDevice or device: the name must match character for character.',
        returns: '{ devices[{name,kind}], video[], audio[], count, notes[] }',
        example: { action: 'devices' },
      },
      components: {
        summary: 'whether text recognition, object detection, the ONNX runtime and the host speech service are usable, each with the reason and the install hint.',
        use: 'to find out which half of screen_analyze will actually produce something before spending minutes on a long recording.',
        returns: '{ ffmpeg{}, ocr{available,engine,reason}, detector{available,modelPath,runtime,reason}, asr{available,provider,reason}, sharedHome{} }',
        example: { action: 'components' },
      },
    },
  },

  screen_setup: {
    purpose:
      'Provisioning: fetch the pinned ffmpeg build the whole plugin family shares, or the pinned YOLO detector model this plugin owns. Every download is checked against a recorded digest, and removing something says exactly what it left alone.',
    needs: ['the network for both installs; nothing to read a status'],
    next: ['screen_env {action:"components"} to confirm the install landed', 'screen_record to use ffmpeg'],
    actions: {
      install_ffmpeg: {
        summary: 'download a version-pinned ffmpeg build and unpack ffmpeg/ffprobe/ffplay into the shared plugin home.',
        avoid: 'it will not overwrite a build that is already there unless force:true, so it is safe to call blindly.',
        returns: '{ installed, skipped, version, binDir, binaries[{name,bytes}], digest{verified,sha256}, notes[] }',
        example: { action: 'install_ffmpeg' },
      },
      install_detector: {
        summary: 'download the pinned YOLOv8n ONNX detector into ~/.dsh-plugins/models/yolo, verify its SHA-256, and borrow the shared ONNX runtime if it is missing.',
        avoid: 'it never downloads a second copy of the 13 MB runtime: it copies a sibling checkout\'s copy when there is one, and otherwise names the plugin that owns it.',
        returns: '{ installed, skipped, modelPath, bytes, sha256, verified, license, runtime{dir,source,complete}, available, missing[], notes[] }',
        example: { action: 'install_detector' },
      },
      remove_detector: {
        summary: 'delete the installed detector model directory, leaving the shared ONNX runtime alone.',
        returns: '{ removed, directory, note }',
        example: { action: 'remove_detector' },
      },
    },
  },

  screen_record: {
    purpose:
      'Capture this machine for a fixed number of seconds: the whole desktop, one window, a rectangle of it, or a microphone — and then measure the file that was written, by decoding it, because ffmpeg exiting 0 does not mean ten seconds of screen exist.',
    needs: ['ffmpeg with gdigrab for the screen, dshow for audio', 'a positive seconds value: there is no "record until stopped"'],
    next: ['screen_analyze to turn the recording into structure', 'screen_record {action:"microphone"} when only sound is wanted'],
    actions: {
      screen: {
        summary: 'record the desktop, a window or a screen rectangle, optionally with a DirectShow audio device, for a fixed number of seconds.',
        required: ['out', 'seconds'],
        avoid: 'window and region cannot be combined; a window that closes ends the recording early, which the measurement will report.',
        returns: '{ ok, path, durationSec, requestedSeconds, shortTake, frames, video{}, audio{}, capture{code,elapsedMs,failed}, plan{args,notes}, notes[] }',
        example: { action: 'screen', out: 'tmp/demo.mp4', seconds: 12, fps: 15 },
      },
      microphone: {
        summary: 'record a fixed number of seconds from one DirectShow audio device.',
        required: ['out', 'seconds', 'device'],
        use: 'a voice-over, or the audio half of a screen recording that is easier to capture separately.',
        returns: '{ ok, path, durationSec, requestedSeconds, audio{}, capture{}, notes[] }',
        example: { action: 'microphone', out: 'tmp/voice.wav', seconds: 10, device: 'Microphone (USB Audio Device)' },
      },
    },
  },

  screen_analyze: {
    purpose:
      'Read a recording back as structure. One decode builds the timeline; each segment gets a still; the stills are then read for text (OCR), segmented into appearance regions, and passed through YOLO for objects; the audio is transcribed; and everything is fused into one JSON document with the evidence attached. Every part that could not run is reported with its reason instead of being silently omitted.',
    needs: ['ffmpeg', 'a recording that exists; the other three readers are optional and each says so when absent'],
    next: ['screen_guide {action:"action", actionName:"analyze"} for the document\'s shape', 'screen_env {action:"components"} when a section came back unavailable'],
    actions: {
      analyze: {
        summary: 'the whole pipeline over one recording: timeline + OCR + appearance regions + YOLO objects + speech, fused and written as structure.json.',
        required: ['input'],
        use: 'the reason this plugin exists: "what happened in this recording", as data.',
        returns:
          '{ input{}, summary{kinds,...}, timeline{segments[]}, text{lines[],keywords[]}, regions{}, objects{counts}, speech{intervals[]}, artifacts{structure,keyframes,contactSheet,delivery,chapters}, warnings[] }',
        example: { action: 'analyze', input: 'tmp/demo.mp4' },
      },
      scenes: {
        summary: 'only the timeline: decode once and report where the picture changes, with no stills, no recognition and no files written.',
        use: 'to see how a recording breaks up before paying for a full analysis.',
        avoid: 'it writes nothing, so the answer is data rather than artifacts.',
        returns: '{ segments[{index,start,end,seconds,reason,sceneScore,motion}], fps, frameWidth, frameHeight, framesAnalysed, notes[] }',
        example: { action: 'scenes', input: 'tmp/demo.mp4', sceneThreshold: 8 },
      },
      regions: {
        summary: 'segment one frame, or one second of a video, into labelled rectangles: text, picture, texture, flat, dark.',
        use: 'a layout question — "is this screen mostly text or mostly picture" — without running the whole pipeline.',
        avoid: 'these are appearance classes, not UI semantics: a tile labelled text is busy and thin-edged, not necessarily words.',
        returns: '{ width, height, tileSize, tiles[], shares{text,picture,texture,flat,dark}, blocks[] }',
        example: { action: 'regions', input: 'tmp/demo.mp4', at: 4.5 },
      },
      detect: {
        summary: 'run the YOLO detector on named moments, or on a sample of the recording, and return boxes in source pixels.',
        use: 'when only the objects matter, or to re-run detection after installing the model.',
        avoid: 'without the installed model it fails with the install hint; screen_env {action:"components"} says whether it is there.',
        returns: '{ frames[{at,objects[{label,score,box,center}],inferenceMs}], counts{}, model{}, elapsedMs }',
        example: { action: 'detect', input: 'tmp/demo.mp4', times: [1, 5, 9] },
      },
      transcribe: {
        summary: 'speech to text over a recording\'s audio, cut at detected pauses, each interval returned with the seconds it covers.',
        use: 'the words, with the timing that lets them be attached to the timeline.',
        avoid: 'it needs the host speech service; without it the call fails and names the bundle that provides one.',
        returns: '{ available, provider, durationSec, text, intervals[{id,start,end,text}], detectedIntervals, notes[] }',
        example: { action: 'transcribe', input: 'tmp/demo.mp4', language: 'zh' },
      },
    },
  },

  screen_guide: {
    purpose:
      'The full capability reference for this plugin, read on demand instead of sitting in every turn: what every action does, which arguments it requires, what it returns, what it costs, what it risks, and the order the actions are normally used in.',
    needs: ['nothing: pure computation over this file'],
    next: ['the action it described', 'screen_env {action:"probe"} to see the machine'],
    actions: {
      overview: {
        summary: 'the whole surface in one page: every tool, every action, one line each, plus what is cheap and what is not.',
        avoid: 'it is the longest answer here; when the action is already known, ask for that action.',
        returns: '{ tools[{name,purpose,actions[]}], costs, next }',
        example: { action: 'overview' },
      },
      playbook: {
        summary: 'the recommended order of actions for a named job, with the arguments each step needs and the mistakes that break it.',
        required: ['job'],
        returns: '{ job, steps[{action,args,why,pitfall}], notes[] }',
        example: { action: 'playbook', job: 'record-and-understand' },
      },
      rules: {
        summary: 'the rules that apply to every job: what this plugin refuses to decide, the determinism contract, the coordinate systems, and the failures that keep repeating.',
        use: 'before trusting a number, and before acting on a box.',
        returns: '{ rules[{title,body}], neighbours[] }',
        example: { action: 'rules' },
      },
      tool: {
        summary: 'one tool in full: its purpose, when to use it and when not to, every action with its arguments, returns, cost and pitfalls.',
        required: ['tool'],
        returns: '{ tool, purpose, needs[], next[], actions[] }',
        example: { action: 'tool', tool: 'screen_analyze' },
      },
      action: {
        summary: 'one action in full, including the arguments only that action uses and a runnable example.',
        required: ['actionName'],
        returns: '{ tool, action, summary, required[], optional[], returns, use, avoid, example, pitfalls[] }',
        example: { action: 'action', actionName: 'analyze' },
      },
    },
  },
}

/** Every tool name, in presentation order. */
export const TOOL_ORDER = Object.keys(TOOL_REGISTRY)

/**
 * Look one tool's entry up.
 * @param {string} name - the tool name.
 * @returns {object|undefined} its registry entry.
 */
export function lookupTool(name) {
  return TOOL_REGISTRY[name]
}

/**
 * Find which tool owns an action.
 * @param {string} actionName - the action name, for example `analyze`.
 * @returns {{tool: string, entry: object}|null} the owner, or null.
 */
export function lookupAction(actionName) {
  for (const [tool, entry] of Object.entries(TOOL_REGISTRY)) {
    if (entry.actions[actionName] !== undefined) return { tool, entry: entry.actions[actionName] }
  }
  return null
}

/**
 * The extra arguments each action accepts, beyond the shared `cwd` / `force` / `timeoutMs`.
 *
 * Kept here rather than in the schema builders so `screen_guide {action:"action"}` can list them
 * without reading five tool modules, and so a handler that reads an argument the registry does not
 * name is visible as exactly that.
 */
export const ACTION_ARGUMENTS = {
  probe: [],
  devices: [],
  components: [],
  install_ffmpeg: ['force', 'source', 'archive', 'allowDigestMismatch'],
  install_detector: ['force', 'archive'],
  remove_detector: [],
  screen: ['out', 'seconds', 'fps', 'window', 'region', 'drawMouse', 'audioDevice', 'video', 'audio', 'rtBufferMb', 'keepPartial'],
  microphone: ['out', 'seconds', 'device', 'audio', 'rtBufferMb', 'keepPartial'],
  analyze: ['input', 'outDir', 'fps', 'maxSide', 'sceneThreshold', 'minSegmentSec', 'maxSegmentSec', 'mergeShortSec', 'maxSegments', 'maxKeyframes', 'ocrMaxFrames', 'detectMaxFrames', 'tileSize', 'ocr', 'detect', 'transcribe', 'language', 'keywords', 'contactSheet', 'delivery'],
  scenes: ['input', 'fps', 'maxSide', 'sceneThreshold', 'minSegmentSec', 'maxSegmentSec', 'mergeShortSec', 'maxSegments', 'startSec', 'durationSec'],
  regions: ['input', 'at', 'tileSize', 'maxSide'],
  detect: ['input', 'times', 'maxFrames', 'minScore', 'iou', 'maxSide'],
  transcribe: ['input', 'language', 'maxAudioBytes', 'maxIntervals'],
  overview: [],
  playbook: ['job'],
  rules: [],
  tool: ['tool'],
  action: ['actionName'],
}

/** The rules that apply to every job, for `screen_guide {action:"rules"}`. */
export const RULES = [
  {
    title: '这个插件执行与测量，不判断',
    body:
      '它不会说一段录屏"重要"、一个分段"切得好"、识别出的文字"对不对"。它报数字、报证据、报路径。' +
      '哪一段值得看、结构读起来对不对、下一步做什么，都是 DSH 的判断。',
  },
  {
    title: '同一输入必得同一输出',
    body:
      '时间轴、区域分割、OCR、YOLO、语音转文字全部是确定性的：同样的文件、同样的参数，得到同样的结果。' +
      '唯一的例外是 YOLO 的浮点累加顺序在不同线程数下可能有末位差异，因此默认单线程。',
  },
  {
    title: '缺什么就说什么，不用零代替',
    body:
      '没装识别引擎、没装模型、没有音频轨、宿主没有语音服务——每一个都写成 null 加一句 reason，并进 warnings。' +
      '一个静悄悄少了一半的结构，和一个"什么都没发生"的录屏，读起来是一样的，那是最坏的失败。',
  },
  {
    title: '坐标永远是源视频像素',
    body:
      'OCR 的行框、区域的矩形、YOLO 的检测框，全部换算回源帧的像素坐标，原点在左上角，整数。' +
      '模型读图时缩小过、YOLO 还做过 letterbox 补边，这些都在插件内部折回去了；调用方不需要知道读过什么尺寸。',
  },
  {
    title: '录制必须给秒数，且一定有测量',
    body:
      '一次最多录 3600 秒。录完会解码整个文件数帧、比对时长、检查音频流，"进程退出码 0"不算成功。' +
      '时长明显短于要求时，结果的 ok 是 false，notes 会说明可能的原因（窗口被关、设备被占、编码跟不上）。',
  },
  {
    title: '模型是模型，许可是许可',
    body:
      '插件本体是 MIT。YOLOv8n 权重是 AGPL-3.0（上游 Ultralytics），只按需下载、不随插件分发，' +
      '来源与摘要记在 ~/.dsh-plugins/models/yolo/SOURCE.json。OCR 引擎属于 dsh-ocr，推理运行时属于 dsh-video-audio。',
  },
  {
    title: '训练/推理之外的一切都交给邻居',
    body:
      '转码、裁剪、拼接、混音、字幕、成片属于 dsh-ffmpeg 与 video-factory；音频测量与事件检测属于 dsh-video-audio；' +
      '只要文字与坐标属于 dsh-ocr。这个插件只做"录下来"和"读成结构"。',
  },
]

/** The recipes behind `screen_guide {action:"playbook"}`. */
export const PLAYBOOKS = {
  'record-and-understand': {
    title: '录一段，然后读懂它',
    when: '用户说"录一下我这个操作，然后告诉我发生了什么"。',
    steps: [
      { action: 'screen_env {action:"probe"}', why: '先确认这份 ffmpeg 能 gdigrab，以及录不录得到声音。', pitfall: '跳过这一步，就要等 30 秒录完才发现没有 gdigrab。' },
      { action: 'screen_record {action:"screen", out, seconds, audioDevice?}', why: '录一段固定长度的画面（需要旁白就同时录麦）。', pitfall: '不写 audioDevice 就没有声音，后面语音转文字自然也是空的。' },
      { action: 'screen_analyze {action:"scenes", input}', why: '先只看时间轴，确认分段粒度合适，几分钟的录屏这一步只要几秒。', pitfall: 'sceneThreshold 调大切得少、调大切得多；整屏切换通常在 40 以上。' },
      { action: 'screen_analyze {action:"analyze", input}', why: '完整跑一遍，拿到结构 JSON、关键帧、联系表与交付视频。', pitfall: '长录屏记得用 maxKeyframes / detectMaxFrames 控制 YOLO 的开销。' },
      { action: '读 structure.json', why: 'summary.kinds 给段落分类索引，segments[].text/objects/speech 给每一段的证据，text.keywords 给检索入口。', pitfall: 'warnings 里写着哪一部分没跑成，不要把它当噪音。' },
    ],
  },
  'capture-only': {
    title: '只要一段录屏',
    when: '用户要一个文件，不需要结构。',
    steps: [
      { action: 'screen_record {action:"screen", out, seconds}', why: '一次调用拿到 mp4 加测量结果。', pitfall: 'out 的扩展名决定容器：.mp4 是 H.264/AAC。' },
      { action: '看结果的 ok / durationSec / notes', why: '确认录到了要求的长度，而不是被窗口关闭截断。', pitfall: 'ok:false 时文件仍然保留（除非整段失败），可以决定要不要重录。' },
    ],
  },
  'find-the-objects': {
    title: '只看画面里有什么',
    when: '用户问"画面里出现过人吗""有没有某个物体"。',
    steps: [
      { action: 'screen_env {action:"components"}', why: '确认检测模型与推理运行时都在。', pitfall: '模型没装就直接 detect 会失败并给出安装提示。' },
      { action: 'screen_setup {action:"install_detector"}', why: '按需装模型（12.8 MB，sha256 校验）。', pitfall: '共享运行时由 dsh-video-audio 提供，插件会尝试从同级检出复制，不会再下一份。' },
      { action: 'screen_analyze {action:"detect", input, times}', why: '在指定时刻跑检测，拿到源像素坐标的框。', pitfall: 'times 是秒；不给就按 detectMaxFrames 均匀采样整段。' },
    ],
  },
  'text-and-speech': {
    title: '把说过的话和屏幕上的字都拿出来',
    when: '用户要一份可检索的记录：讲了什么、屏幕上写了什么。',
    steps: [
      { action: 'screen_env {action:"components"}', why: '确认 OCR 与宿主语音服务是否可用；两者互相独立。', pitfall: '没有 speechToText 服务时语音一节会写明要启用哪个 bundle。' },
      { action: 'screen_analyze {action:"transcribe", input}', why: '先只做语音，确认语种与切分合适。', pitfall: 'language 给错会明显降低准确率；自动判别对短音频不稳。' },
      { action: 'screen_analyze {action:"analyze", input, language}', why: '再跑完整流程，文字与语音都落在同一份结构里。', pitfall: 'text.lines 里每行都带 segmentId 与 at，可以直接定位到秒。' },
    ],
  },
  'diagnose-a-bad-recording': {
    title: '录屏看起来不对',
    when: '"录出来是黑的""只有三秒""没有声音"。',
    steps: [
      { action: 'screen_env {action:"probe"}', why: '先看这份构建到底支不支持 gdigrab/dshow，以及队列与并发状态。', pitfall: '缺 gdigrab 的构建在别的插件里可能能用，录屏一定不行。' },
      { action: 'screen_record {action:"screen", out, seconds, fps:15}', why: '用较低帧率重录一次，排除编码跟不上的可能。', pitfall: '高分辨率 + 30fps 在忙的机器上最容易掉帧。' },
      { action: 'screen_analyze {action:"scenes", input}', why: '如果时长对但内容不对，用时间轴看是不是中途画面就冻住了。', pitfall: 'sceneScore 一直是 0 说明画面没有变化，不是编码问题。' },
    ],
  },
}
