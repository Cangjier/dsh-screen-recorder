/**
 * The plugin's own plumbing: five tools register, their schemas are documented, and their handlers
 * refuse what the registry says they refuse.
 *
 * No ffmpeg, no network, no capture: this file answers "does the plugin mount, and does the surface
 * it publishes agree with the surface it documents", which is the failure that otherwise only shows
 * up as an under-documented tool nobody notices.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeConfig } from '../index.mjs'
import { TOOL_NAMES, registerTools, toolDefinitions } from '../src/tools/index.mjs'
import { ACTION_ARGUMENTS, TOOL_ORDER, TOOL_REGISTRY, lookupAction, lookupTool } from '../src/tools/registry.mjs'
import { toLosslessJson } from '../src/tools/shared.mjs'

/**
 * A context that records what was registered, and a logger that keeps what was said.
 * @returns {{ctx: object, logger: object, registered: object[], lines: string[]}} the fake host.
 */
function fakeContext() {
  const registered = []
  const lines = []
  const logger = {
    info: (message) => lines.push(`info ${message}`),
    warn: (message) => lines.push(`warn ${message}`),
    error: (message) => lines.push(`error ${message}`),
  }
  const ctx = {
    tools: { register: (definition) => registered.push(definition) },
    cwd: process.cwd(),
    get: () => undefined,
  }
  return { ctx, logger, registered, lines }
}

test('注册：五个工具全部注册，且每个都带描述、schema 和 execute', () => {
  const { ctx, logger, registered } = fakeContext()
  const outcome = registerTools(ctx, normalizeConfig({}), logger, () => ({}))
  assert.deepEqual(outcome.failed, [])
  assert.deepEqual(outcome.registered, TOOL_ORDER)
  assert.deepEqual(TOOL_NAMES, TOOL_ORDER)
  assert.equal(registered.length, 5)
  for (const definition of registered) {
    assert.equal(typeof definition.description, 'string')
    assert.ok(definition.description.length > 80, `${definition.name} 的描述太短`)
    assert.ok(definition.description.includes(`screen_guide {action:"tool", tool:"${definition.name}"}`))
    assert.equal(definition.parameters.type, 'object')
    assert.deepEqual(definition.parameters.required, ['action'])
    assert.equal(definition.parameters.additionalProperties, false)
    assert.equal(typeof definition.execute, 'function')
    // Every action appears in the enum, with a description written for it.
    const enumValues = definition.parameters.properties.action.enum
    assert.ok(enumValues.length >= 2)
    for (const action of enumValues) {
      assert.ok(definition.parameters.properties.action.description.includes(`${action} — `), `${definition.name}.${action} 没有一行描述`)
    }
  }
})

test('注册：注册表是唯一的真相，工具集与它一一对应', () => {
  for (const name of TOOL_ORDER) {
    const entry = TOOL_REGISTRY[name]
    assert.ok(entry.purpose.length > 40, `${name} 缺 purpose`)
    assert.ok(Array.isArray(entry.needs) && entry.needs.length > 0, `${name} 缺 needs`)
    assert.ok(Array.isArray(entry.next) && entry.next.length > 0, `${name} 缺 next`)
    for (const [action, detail] of Object.entries(entry.actions)) {
      assert.ok(detail.summary.length > 10, `${name}.${action} 缺 summary`)
      assert.ok(typeof detail.returns === 'string' && detail.returns.length > 10, `${name}.${action} 缺 returns`)
      assert.ok(detail.example !== undefined, `${name}.${action} 缺 example`)
      assert.equal(detail.example.action, action)
      assert.ok(ACTION_ARGUMENTS[action] !== undefined, `${name}.${action} 没有列参数`)
    }
  }
  // Nothing documented without a tool, nothing listed without an action.
  for (const action of Object.keys(ACTION_ARGUMENTS)) {
    assert.notEqual(lookupAction(action), null, `${action} 列在 ACTION_ARGUMENTS 里但没有工具实现`)
  }
})

test('schema：每个 action 的参数都在 properties 里声明过', () => {
  const { ctx, logger } = fakeContext()
  const definitions = toolDefinitions(normalizeConfig({}), logger, () => ({}))
  const byName = new Map(definitions.map((definition) => [definition.name, definition]))
  for (const [tool, entry] of Object.entries(TOOL_REGISTRY)) {
    const definition = byName.get(tool)
    const properties = definition.parameters.properties
    for (const [action, detail] of Object.entries(entry.actions)) {
      for (const argument of detail.required ?? []) {
        assert.ok(properties[argument] !== undefined, `${tool}.${action} 要求 ${argument}，但 schema 里没有`)
      }
      for (const argument of ACTION_ARGUMENTS[action] ?? []) {
        assert.ok(properties[argument] !== undefined, `${tool}.${action} 的 ${argument} 没有写进 schema`)
      }
    }
  }
  void ctx
})

test('execute：未知 action 立刻拒绝，并列出可选项', async () => {
  const { ctx, logger, registered } = fakeContext()
  registerTools(ctx, normalizeConfig({}), logger, () => ({}))
  const record = registered.find((definition) => definition.name === 'screen_record')
  await assert.rejects(() => record.execute({ action: 'nope' }, { cwd: process.cwd() }), /unknown action "nope"; expected one of screen, microphone/)
})

test('execute：screen 缺 out 或 seconds 时给出中文的可执行信息', async () => {
  const { ctx, logger, registered } = fakeContext()
  registerTools(ctx, normalizeConfig({}), logger, () => ({}))
  const record = registered.find((definition) => definition.name === 'screen_record')
  await assert.rejects(() => record.execute({ action: 'screen', seconds: 5 }, { cwd: process.cwd() }), /需要 out/)
  await assert.rejects(() => record.execute({ action: 'screen', out: 'x.mp4' }, { cwd: process.cwd() }), /需要 seconds/)
})

test('execute：analyze 对不存在的文件立刻失败，不去解码', async () => {
  const { ctx, logger, registered } = fakeContext()
  registerTools(ctx, normalizeConfig({}), logger, () => ({}))
  const analyze = registered.find((definition) => definition.name === 'screen_analyze')
  await assert.rejects(
    () => analyze.execute({ action: 'scenes', input: 'definitely-not-here-12345.mp4' }, { cwd: process.cwd() }),
    /文件不存在/,
  )
})

test('guide：overview 列出五个工具，tool / action 找不到时给出可选项', async () => {
  const { ctx, logger, registered } = fakeContext()
  registerTools(ctx, normalizeConfig({}), logger, () => ({}))
  const guide = registered.find((definition) => definition.name === 'screen_guide')

  const overview = await guide.execute({ action: 'overview' }, { cwd: process.cwd() })
  assert.equal(overview.tools.length, 5)
  assert.deepEqual(overview.tools.map((tool) => tool.name), TOOL_ORDER)

  const tool = await guide.execute({ action: 'tool', tool: 'screen_analyze' }, { cwd: process.cwd() })
  assert.equal(tool.tool, 'screen_analyze')
  assert.ok(tool.actions.length >= 5)
  assert.ok(tool.actions.every((entry) => Array.isArray(entry.arguments)))

  const action = await guide.execute({ action: 'action', actionName: 'analyze' }, { cwd: process.cwd() })
  assert.equal(action.tool, 'screen_analyze')
  assert.deepEqual(action.required, ['input'])
  assert.ok(action.pitfalls.length > 0)

  await assert.rejects(() => guide.execute({ action: 'tool', tool: 'nope' }, { cwd: process.cwd() }), /没有这个工具/)
  await assert.rejects(() => guide.execute({ action: 'action', actionName: 'nope' }, { cwd: process.cwd() }), /没有这个 action/)

  const playbooks = await guide.execute({ action: 'playbook' }, { cwd: process.cwd() })
  assert.ok(playbooks.jobs.length >= 4)
  const recipe = await guide.execute({ action: 'playbook', job: 'record-and-understand' }, { cwd: process.cwd() })
  assert.ok(recipe.steps.length >= 3)
  const rules = await guide.execute({ action: 'rules' }, { cwd: process.cwd() })
  assert.ok(rules.rules.length >= 5)
})

test('config：非法配置在注册前就被拒绝，且每条信息都点名字段', () => {
  assert.throws(() => normalizeConfig({ maxConcurrent: 99 }), /config.maxConcurrent/)
  assert.throws(() => normalizeConfig({ ocr: { provider: 'maybe' } }), /config.ocr.provider/)
  assert.throws(() => normalizeConfig({ detector: { minScore: 3 } }), /config.detector.minScore/)
  assert.throws(() => normalizeConfig({ asr: { enabled: 'yes' } }), /config.asr.enabled/)
  const config = normalizeConfig({})
  assert.equal(config.maxConcurrent, 2)
  assert.equal(config.analysis.fps, 4)
  assert.equal(config.ocr.provider, 'auto')
  assert.equal(config.ocr.scale, 'auto')
  assert.equal(config.detector.maxSide, 640)
  assert.equal(config.asr.maxIntervals, 60)
  assert.equal(config.asr.language, null)
})

test('lookupTool / lookupAction：查不到就是 undefined / null，不抛', () => {
  assert.equal(lookupTool('nope'), undefined)
  assert.equal(lookupAction('nope'), null)
  assert.equal(lookupAction('analyze').tool, 'screen_analyze')
})

test('apply：真实挂载路径注册五个工具，并说明用的是哪份 ffmpeg', async () => {
  const { apply } = await import('../index.mjs')
  const registered = []
  const lines = []
  let injected = null
  const ctx = {
    logger: {
      info: (message) => lines.push(`info ${message}`),
      warn: (message) => lines.push(`warn ${message}`),
      error: (message) => lines.push(`error ${message}`),
    },
    inject: (services, callback) => {
      injected = services
      callback({ tools: { register: (definition) => registered.push(definition) }, get: () => undefined })
    },
  }
  apply(ctx, {})
  assert.deepEqual(injected, ['tools'])
  assert.deepEqual(
    registered.map((definition) => definition.name),
    TOOL_ORDER,
  )
  // The activation line is the one fact an operator needs: which ffmpeg, and from where.
  const ffmpegLine = lines.find((line) => line.includes('ffmpeg =') || line.includes('没有找到 ffmpeg'))
  assert.ok(ffmpegLine !== undefined, `没有报告 ffmpeg 来源：${lines.join(' | ')}`)
})

test('apply：配置非法时不注册任何工具，并且报出字段名', async () => {
  const { apply } = await import('../index.mjs')
  const registered = []
  const lines = []
  const ctx = {
    logger: { info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) },
    inject: (_services, callback) => callback({ tools: { register: (definition) => registered.push(definition) }, get: () => undefined }),
  }
  apply(ctx, { maxConcurrent: 99 })
  assert.equal(registered.length, 0)
  assert.ok(lines.some((line) => line.includes('config.maxConcurrent')))
  assert.ok(lines.some((line) => line.includes('没有注册任何工具') || line.includes('配置无效')))
})

test('toLosslessJson：undefined / NaN / -0 被替换成 JSON 能活下来的值', () => {
  const converted = toLosslessJson({ a: undefined, b: NaN, c: -0, d: [1, Infinity], e: { f: 2 } })
  assert.deepEqual(converted, { a: null, b: null, c: 0, d: [1, null], e: { f: 2 } })
  assert.equal(JSON.stringify(converted).includes('null'), true)
})
