/**
 * Building the model-facing `screen_*` tools from the registry.
 *
 * Three rules shape everything here:
 *
 * 1. **Every schema is resident on every turn.** So the surface is five tools with an `action`
 *    dispatcher rather than twenty flat ones, and every description is generated from
 *    `registry.mjs` rather than written beside it — a sentence that appears twice is charged twice.
 * 2. **Documentation coverage is checked at load time.** An action with no registry entry, or a
 *    registry entry with no handler, fails registration loudly instead of shipping an
 *    under-documented schema that nobody notices.
 * 3. **A tool executes; it does not decide.** Nothing here judges whether a recording is good,
 *    whether a segment boundary is meaningful, or what the recording was about.
 *
 * @module dsh-screen-recorder/tools/shared
 */
import { lookupTool } from './registry.mjs'

/** Render any tool result as one pretty-printed JSON text block. */
export const TEXT_OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render(_args, value) {
    return [{ type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value, null, 2) }]
  },
}

/** Shared `cwd` property: every path-taking tool resolves relative paths against it. */
export const CWD_PROPERTY = {
  type: 'string',
  description:
    'Working directory that relative paths resolve against. Left out, it is the harness process\u2019s working directory — for the desktop app that is the profile directory, not your project — so pass an absolute path (or this argument) when it matters. Every result reports the absolute path actually written.',
}

/** Shared `force` property. */
export const FORCE_PROPERTY = {
  type: 'boolean',
  description: 'Redo the work even when the result already exists. For an install this is the only way out of a half-unpacked directory, which would otherwise look installed and fail on every use.',
}

/** Shared `timeoutMs` property. */
export const TIMEOUT_PROPERTY = {
  type: 'number',
  description: 'Give up after this many milliseconds and kill the process. A partial output is deleted, so a timeout never leaves a file that looks finished.',
}

/**
 * Make a value survive `JSON.parse(JSON.stringify(value))` unchanged.
 *
 * A tool result crosses a JSON boundary, and three ordinary JavaScript values do not survive it:
 * `undefined` (the key vanishes), `NaN`/`Infinity` (they become `null`), and `-0` (it becomes `0`).
 * The harness refuses such a result outright — "value is not lossless JSON" — so the conversion
 * happens once, here, rather than being remembered at every return statement in five tools.
 *
 * An absent measurement becomes `null`, which is what this plugin says everywhere else: "no value"
 * is reported as `null`, never as a zero and never by dropping the key.
 *
 * @param {*} value - any handler result.
 * @returns {*} the same data with every JSON-hostile leaf replaced.
 */
export function toLosslessJson(value) {
  if (value === undefined) return null
  if (value === null) return null
  const type = typeof value
  if (type === 'number') {
    if (!Number.isFinite(value)) return null
    return Object.is(value, -0) ? 0 : value
  }
  if (type === 'string' || type === 'boolean') return value
  if (type === 'bigint') return value.toString()
  if (type === 'function' || type === 'symbol') return null
  if (Array.isArray(value)) return value.map((entry) => toLosslessJson(entry))
  if (value instanceof Date) return value.toISOString()
  if (type === 'object') {
    // Only plain-ish objects are walked. Anything else (a typed array, a Map, a class instance) is
    // passed through untouched, so a handler that returns one fails loudly instead of having its
    // shape quietly rewritten into something that no longer means what it said.
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return value
    const out = {}
    for (const [key, entry] of Object.entries(value)) out[key] = toLosslessJson(entry)
    return out
  }
  return value
}

/**
 * The error type for a request this plugin refuses.
 *
 * Thrown errors surface as tool failures, so the message has to be actionable: what was refused,
 * what was expected, and what to do instead.
 */
export class ScreenPluginError extends Error {
  /**
   * @param {string} message - the refusal.
   */
  constructor(message) {
    super(message)
    this.name = 'ScreenPluginError'
  }
}

/**
 * One decision-grade line for an action, used as the `action` enum description.
 *
 * It is built by priority and bounded, because it is paid for on every turn: what the action does,
 * then what it requires — the thing a first call gets wrong — then the mistake it prevents or when
 * to reach for it, whichever is shorter. Everything else is one `screen_guide` call away.
 *
 * @param {string} action - the action name.
 * @param {object} entry - its registry entry.
 * @returns {string} one line of prose.
 */
export function describeAction(action, entry) {
  const BUDGET = 260
  let line = `${action} — ${entry.summary}`
  if (Array.isArray(entry.required) && entry.required.length > 0) line += ` Requires: ${entry.required.join(', ')}.`
  const optional = [
    entry.avoid !== undefined && entry.avoid.length <= 120 ? ` Avoid: ${entry.avoid}` : null,
    entry.use !== undefined ? ` Use: ${entry.use}` : null,
  ]
  for (const clause of optional) {
    if (clause !== null && line.length + clause.length <= BUDGET) line += clause
  }
  return line
}

/**
 * Build a tool's description from its registry entry.
 *
 * @param {string} name - the tool name.
 * @param {object} entry - its registry entry.
 * @param {string[]} actions - the declared action list, in dispatch order.
 * @returns {string} the model-facing description.
 */
export function describeTool(name, entry, actions) {
  return [
    entry.purpose,
    `Actions: ${actions.join(', ')}.`,
    `Needs: ${entry.needs.join(' ')}`,
    `Next: ${entry.next.join(' ')}`,
    `Full detail: screen_guide {action:"tool", tool:"${name}"}.`,
  ].join('\n')
}

/**
 * Build one family tool.
 *
 * @param {object} spec - the family definition.
 * @param {string} spec.name - the tool name, for example `screen_record`.
 * @param {string[]} spec.actions - every legal `action` value, in dispatch order.
 * @param {object} spec.extraProperties - additional JSON Schema properties.
 * @param {Record<string, (args: object, context: object) => Promise<object>>} spec.handlers - one implementation per action.
 * @returns {object} a raw tool definition suitable for `ctx.tools.register`.
 * @throws {Error} when the registry and this declaration disagree.
 */
export function defineFamilyTool(spec) {
  const actions = [...spec.actions]
  const entry = lookupTool(spec.name)
  if (entry === undefined) {
    throw new Error(`dsh-screen-recorder: no registry entry for tool ${spec.name}; add it to src/tools/registry.mjs`)
  }

  const documented = Object.keys(entry.actions)
  for (const action of actions) {
    if (entry.actions[action] === undefined) {
      throw new Error(`dsh-screen-recorder: ${spec.name}.${action} is not documented in src/tools/registry.mjs`)
    }
    if (typeof spec.handlers[action] !== 'function') {
      throw new Error(`dsh-screen-recorder: ${spec.name}.${action} is declared but has no handler`)
    }
  }
  for (const action of documented) {
    if (!actions.includes(action)) {
      throw new Error(`dsh-screen-recorder: ${spec.name}.${action} is documented in the registry but not declared here`)
    }
  }

  return {
    name: spec.name,
    description: describeTool(spec.name, entry, actions),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: actions,
          description: actions.map((action) => describeAction(action, entry.actions[action])).join('\n'),
        },
        ...spec.extraProperties,
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, context) {
      // Dispatch through the declared list, not the handler table: a handler belonging to a sibling
      // tool must be unreachable from this one, or the split surface would be cosmetic.
      const handler = actions.includes(args?.action) ? spec.handlers[args.action] : undefined
      if (handler === undefined) {
        throw new ScreenPluginError(
          `${spec.name}: unknown action ${JSON.stringify(args?.action)}; expected one of ${actions.join(', ')}`,
        )
      }
      const safeContext = {
        cwd: typeof context?.cwd === 'string' && context.cwd !== '' ? context.cwd : process.cwd(),
        ...context,
      }
      // Every result crosses a JSON boundary, and the boundary is not lossless on its own; see
      // {@link toLosslessJson}.
      return toLosslessJson(await handler(args ?? {}, safeContext))
    },
  }
}

/**
 * Require a string argument.
 *
 * @param {object} args - the tool arguments.
 * @param {string} key - the field name.
 * @param {string} [where] - the call name, for the message.
 * @returns {string} the value.
 * @throws {ScreenPluginError} when it is missing or not a string.
 */
export function requireString(args, key, where = '') {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ScreenPluginError(`${where}${where === '' ? '' : ' '}需要 ${key}：一个非空字符串。`)
  }
  return value
}

/**
 * Require a positive number argument.
 *
 * @param {object} args - the tool arguments.
 * @param {string} key - the field name.
 * @param {string} [where] - the call name.
 * @returns {number} the value.
 * @throws {ScreenPluginError} when it is missing or not positive.
 */
export function requirePositiveNumber(args, key, where = '') {
  const value = Number(args[key])
  if (!Number.isFinite(value) || value <= 0) {
    throw new ScreenPluginError(`${where}${where === '' ? '' : ' '}需要 ${key}：一个正数。`)
  }
  return value
}

/**
 * Read an optional boolean, rejecting a non-boolean instead of coercing it.
 *
 * `"false"` being truthy in JavaScript is exactly the kind of quiet surprise that turns a request
 * into the opposite of itself, so a wrong type is refused.
 *
 * @param {object} args - the tool arguments.
 * @param {string} key - the field name.
 * @param {boolean|undefined} fallback - the value used when absent.
 * @param {string} where - the call name.
 * @returns {boolean|undefined} the value.
 * @throws {ScreenPluginError} when it is present and not a boolean.
 */
export function optionalBoolean(args, key, fallback, where) {
  const value = args[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') throw new ScreenPluginError(`${where}: "${key}" 必须是布尔值，收到 ${JSON.stringify(value)}。`)
  return value
}

/**
 * Read one of a fixed set of strings.
 *
 * @param {object} args - the tool arguments.
 * @param {string} key - the field name.
 * @param {string[]} allowed - the legal values.
 * @param {string} fallback - the value used when absent.
 * @param {string} where - the call name.
 * @returns {string} the value.
 * @throws {ScreenPluginError} when it is present and not one of the legal values.
 */
export function optionalEnum(args, key, allowed, fallback, where) {
  const value = args[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new ScreenPluginError(`${where}: "${key}" 只能是 ${allowed.join(' / ')}；收到 ${JSON.stringify(value)}。`)
  }
  return value
}

/**
 * Read an object argument, refusing anything else.
 *
 * @param {object} args - the tool arguments.
 * @param {string} key - the field name.
 * @param {string} where - the call name.
 * @returns {object|undefined} the value.
 * @throws {ScreenPluginError} when it is present and not an object.
 */
export function optionalObject(args, key, where) {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ScreenPluginError(`${where}: "${key}" 必须是一个对象，收到 ${JSON.stringify(value)}。`)
  }
  return value
}

/**
 * Read a list of numbers.
 *
 * @param {object} args - the tool arguments.
 * @param {string} key - the field name.
 * @param {string} where - the call name.
 * @returns {number[]|undefined} the value.
 * @throws {ScreenPluginError} when it is present and not an array of finite numbers.
 */
export function optionalNumberArray(args, key, where) {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.some((entry) => !Number.isFinite(Number(entry)))) {
    throw new ScreenPluginError(`${where}: "${key}" 必须是数字数组。`)
  }
  return value.map(Number)
}

/**
 * Read a number inside a range.
 *
 * @param {object} args - the tool arguments.
 * @param {string} key - the field name.
 * @param {number} min - the smallest legal value.
 * @param {number} max - the largest legal value.
 * @param {string} where - the call name.
 * @returns {number|undefined} the value.
 * @throws {ScreenPluginError} when it is present and outside the range.
 */
export function optionalNumberInRange(args, key, min, max, where) {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  const number = Number(value)
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new ScreenPluginError(`${where}: "${key}" 必须在 ${min}–${max} 之间；收到 ${JSON.stringify(value)}。`)
  }
  return number
}
