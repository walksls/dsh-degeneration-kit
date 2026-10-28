/**
 * Deterministic regression test for the park gate and the handoff goal pause.
 *
 * No model, no DSH boot: a fake cordis context captures the plugin's hooks and
 * feeds them synthetic `agent/pre-step` payloads, so the decisions under test
 * are exercised exactly as the agent loop would call them.
 *
 * The bug it pins down (observed in the wild 2026-09-17): a session-scoped goal
 * makes the goal-round-driver queue one `<goal_round>` per quiescence. The old
 * park gate only looked at `step`, so that injected round was read as "the user
 * is back": the handed-off session was promoted to 'resumed' and kept working
 * in the same workspace as its own successor (20 minutes of concurrent edits,
 * stopped by hand).
 *
 * Usage:
 *   node test/park-gate.test.mjs [pluginIndexPath]
 *
 * The optional path lets the same suite run against a pre-fix snapshot:
 *   node test/park-gate.test.mjs /root/4/.dsh-scratch/before/index.js
 * — every case below fails there, which is what makes this a regression test
 * rather than a description of current behaviour.
 */

import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginPath = resolve(process.argv[2] ?? join(here, '..', 'index.js'))

// The plugin resolves its runtime config file at import time. Point DSH_HOME at
// an empty directory so a real ~/.dsh/auto-checkpoint.json can never override
// the config this test passes in.
const home = await mkdtemp(join(tmpdir(), 'cp-park-gate-home-'))
process.env.DSH_HOME = home

const results = []
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ name, ok, actual, expected })
  return ok
}

/** Fake context: captures hooks, serves the services the plugin reads. */
function makeContext({ order, goals, controller, totalTokens, presets, sessions, projections, defaultModel }) {
  const handlers = new Map()
  const injected = []
  return {
    handlers,
    injected,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    on(name, handler) { handlers.set(name, handler) },
    inject(names, callback) { injected.push(names) },
    effect(fn) { const dispose = fn(); return () => dispose?.() },
    tokenMeter: { measure: () => ({ totalTokens }) },
    get(name) {
      if (name === 'goals') return goals
      if (name === 'sessionController') return controller
      if (name === 'permissionPresets') return presets
      if (name === 'sessions') return sessions
      if (name === 'sessionProjections') return projections
      if (name === 'agentDefaultModel') return defaultModel
      return undefined
    },
  }
}

/**
 * Stand-in projection registry. `stateOf` hands back projection STATE —
 * `{lastUsed, pending}` — never the wire view (`{lastUsed, next}`): a session
 * the user switched has the selection pending, one running on what it last used
 * has it in `lastUsed`. `agentPreset` stays unregistered so the plugin keeps
 * falling back to the session header, as it does in headless.
 */
function makeProjections(state) {
  return {
    stateOf: (_session, key) => (key === 'modelSelection' ? state : undefined),
  }
}

/** Stand-in session registry: the plugin only needs `get(id)`. */
function makeSessions() {
  const known = new Map()
  return {
    known,
    get: (sessionId) => {
      if (!known.has(sessionId)) known.set(sessionId, { id: sessionId, header: {} })
      return known.get(sessionId)
    },
  }
}

/** Stand-in permission-preset service: records what the handoff hands down. */
function makePresets(order, parentPreset) {
  const applied = []
  return {
    applied,
    current: (session) => (String(session?.id ?? '').startsWith('session-child') ? 'workspace-write' : parentPreset),
    set: (session, name) => {
      order.push('presets.set')
      applied.push({ sessionId: session?.id, name })
      return { name }
    },
  }
}

function makeGoals(order) {
  const goal = { id: 'goal-park-1', revision: 1, phase: 'active', activation: 'armed', objective: 'test goal' }
  const pauses = []
  return {
    pauses,
    goal,
    get() { order.push('goals.get'); return { ...goal } },
    pause(_agent, ref) {
      order.push('goals.pause')
      pauses.push(ref)
      goal.phase = 'paused'
      goal.activation = 'disarmed'
      return { ...goal }
    },
  }
}

function makeController(order, { selectModel } = {}) {
  const creates = []
  const prompts = []
  const modelSelections = []
  return {
    creates,
    prompts,
    modelSelections,
    create: async (request) => {
      order.push('create')
      creates.push(request)
      return { sessionId: 'session-child0001' }
    },
    prompt: async (request) => {
      order.push('prompt')
      prompts.push(request)
      return { accepted: true }
    },
    // The real controller validates the selection through llm.resolveCallConfig
    // and installs it for the child's next request; the stand-in records it and
    // can be told to fail, which is how the "handoff survives" case is driven.
    selectModel: async (request) => {
      order.push('selectModel')
      if (selectModel === 'throw') throw new Error('model unavailable')
      modelSelections.push(request)
      return { selected: { provider: request.provider, model: request.model } }
    },
    cancel: async () => ({ accepted: true }),
  }
}

const human = () => ({ id: 'm-human', role: 'user', content: [{ type: 'text', text: '继续' }], source: { kind: 'user', rpcId: 'ui-1234' } })
const goalRound = () => ({ id: 'm-goal', role: 'user', content: [{ type: 'text', text: '<goal_round>…' }], source: { kind: 'goal', goalId: 'goal-park-1', revision: 1, round: 2 } })
const jobNotice = () => ({ id: 'm-job', role: 'user', content: [{ type: 'text', text: 'background job done' }], source: { kind: 'plugin', plugin: 'tool-jobs' } })
const ownPrompt = () => ({ id: 'm-ac', role: 'user', content: [{ type: 'text', text: '这是新会话…' }], source: { kind: 'user', rpcId: 'auto-checkpoint-abc' } })

const signal = { aborted: false }
const enter = async () => ({ kind: 'enter', messages: [] })

async function main() {
  const workdir = await mkdtemp(join(tmpdir(), 'cp-park-gate-ws-'))
  const order = []
  const goals = makeGoals(order)
  const controller = makeController(order)
  const presets = makePresets(order, 'danger-full-access')
  const sessions = makeSessions()
  // The parent sits on a model that is NOT the deployment default, so the
  // handoff has something to hand down.
  const projections = makeProjections({ lastUsed: null, pending: { provider: 'api2', model: '[Cloud]DeepSeek-V4.1-Flash', reasoningEffort: 'max' } })
  const defaultModel = { currentSelection: () => ({ provider: 'api2', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' }) }
  const ctx = makeContext({ order, goals, controller, totalTokens: 5_000_000, presets, sessions, projections, defaultModel })

  const plugin = await import(pluginPath)
  plugin.apply(ctx, { triggerTokens: 1, checkpointPath: 'checkpoint-{{session}}.md', autoNewSession: true, remindEverySteps: 1 })

  const preStep = ctx.handlers.get('agent/pre-step')
  if (preStep === undefined) throw new Error('plugin did not register agent/pre-step')

  const sessionId = 'session-source0001'
  const agent = {
    id: 'agent-source',
    session: { id: sessionId, header: { cwd: workdir, agentPreset: 'loli-mom' } },
    whenIdle: async () => {},
  }
  const call = (payload) => preStep({ agent, signal, ...payload }, enter)

  // --- walk the state machine into 'parked' -------------------------------
  const first = await call({ step: 1, turn: 1, messages: [human()] })
  const asked = (first.messages ?? []).some((m) => m.source?.kind === 'plugin' && m.source?.plugin === plugin.name)
  check('threshold crossing injects the checkpoint request', asked, true)

  await mkdir(workdir, { recursive: true })
  await writeFile(join(workdir, 'checkpoint-source00.md'), '# checkpoint\nstate\n', 'utf8')

  const confirm = await call({ step: 2, turn: 1, messages: [] })
  check('confirmed checkpoint rejects the step (handoff starts)', confirm, { kind: 'reject' })

  for (let i = 0; i < 50 && controller.prompts.length === 0; i += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  check('handoff created exactly one child', controller.creates.length, 1)
  check('child inherits the workspace', controller.creates[0]?.cwd, workdir)
  check('child is fed the continue prompt', (controller.prompts[0]?.content?.[0]?.text ?? '').includes('checkpoint-source00.md'), true)

  // --- the fix: pause the old session's armed goal, before creating ------
  check('armed goal is paused on the handed-off session', goals.pauses, [{ id: 'goal-park-1', revision: 1 }])
  check('goal pause lands before the child is created',
    goals.pauses.length === 1 && order.indexOf('goals.pause') < order.indexOf('create'), true)

  // --- the fix: the parent's permission preset is handed down ------------
  check('child inherits the parent permission preset',
    presets.applied, [{ sessionId: 'session-child0001', name: 'danger-full-access' }])
  check('preset is handed down before the continue prompt',
    presets.applied.length === 1 && order.indexOf('presets.set') < order.indexOf('prompt'), true)

  // --- the fix: the parent's model selection is handed down too ----------
  check('child inherits the parent model selection',
    controller.modelSelections,
    [{ sessionId: 'session-child0001', provider: 'api2', model: '[Cloud]DeepSeek-V4.1-Flash', reasoningEffort: 'max' }])
  check('model is handed down before the continue prompt',
    controller.modelSelections.length === 1 && order.indexOf('selectModel') < order.indexOf('prompt'), true)

  // --- the fix: only a genuine human message reopens a parked session ----
  const roundWhileParked = await call({ step: 1, turn: 2, messages: [goalRound()] })
  check('parked session rejects an injected goal round', roundWhileParked, { kind: 'reject' })

  const jobWhileParked = await call({ step: 1, turn: 3, messages: [jobNotice()] })
  check('parked session rejects a background-job notice', jobWhileParked, { kind: 'reject' })

  const ownWhileParked = await call({ step: 1, turn: 4, messages: [ownPrompt()] })
  check('parked session rejects this plugin\u2019s own continue prompt', ownWhileParked, { kind: 'reject' })

  const humanBack = await call({ step: 1, turn: 5, messages: [human()] })
  check('parked session lets a human message through', humanBack.kind, 'enter')

  const afterHuman = await call({ step: 2, turn: 5, messages: [] })
  check('a human message promotes the session back to free use', afterHuman.kind, 'enter')

  // --- handoff-pending must also reject automatic injections -------------
  const order2 = []
  const goals2 = makeGoals(order2)
  const controller2 = makeController(order2)
  const ctx2 = makeContext({ order: order2, goals: goals2, controller: controller2, totalTokens: 5_000_000 })
  const fresh = await import(`${pluginPath}?pending=1`)
  fresh.apply(ctx2, { triggerTokens: 1, checkpointPath: 'checkpoint-{{session}}.md', autoNewSession: true, remindEverySteps: 1 })
  const preStep2 = ctx2.handlers.get('agent/pre-step')
  const workdir2 = await mkdtemp(join(tmpdir(), 'cp-park-gate-ws2-'))
  const agent2 = {
    id: 'agent-source-2',
    session: { id: 'session-source0002', header: { cwd: workdir2 } },
    whenIdle: async () => new Promise((resolve) => setTimeout(resolve, 30)),
  }
  const call2 = (payload) => preStep2({ agent: agent2, signal, ...payload }, enter)
  await call2({ step: 1, turn: 1, messages: [human()] })
  await writeFile(join(workdir2, 'checkpoint-source00.md'), '# checkpoint\n', 'utf8')
  await call2({ step: 2, turn: 1, messages: [] })
  const pendingRound = await call2({ step: 1, turn: 2, messages: [goalRound()] })
  check('handoff-pending rejects an injected goal round', pendingRound, { kind: 'reject' })

  // --- a `custom` parent preset is reported, never guessed at -------------
  const order3 = []
  const controller3 = makeController(order3)
  const presets3 = makePresets(order3, 'custom')
  const ctx3 = makeContext({
    order: order3,
    goals: makeGoals(order3),
    controller: controller3,
    totalTokens: 5_000_000,
    presets: presets3,
    sessions: makeSessions(),
  })
  const third = await import(`${pluginPath}?custom=1`)
  third.apply(ctx3, { triggerTokens: 1, checkpointPath: 'checkpoint-{{session}}.md', autoNewSession: true, remindEverySteps: 1 })
  const workdir3 = await mkdtemp(join(tmpdir(), 'cp-park-gate-ws3-'))
  const agent3 = {
    id: 'agent-source-3',
    session: { id: 'session-source0003', header: { cwd: workdir3 } },
    whenIdle: async () => {},
  }
  const call3 = (payload) => ctx3.handlers.get('agent/pre-step')({ agent: agent3, signal, ...payload }, enter)
  await call3({ step: 1, turn: 1, messages: [human()] })
  await writeFile(join(workdir3, 'checkpoint-source00.md'), '# checkpoint\n', 'utf8')
  await call3({ step: 2, turn: 1, messages: [] })
  for (let i = 0; i < 50 && controller3.prompts.length === 0; i += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  check('a custom parent preset is not guessed at (no preset applied)', presets3.applied, [])
  check('a custom parent preset still hands off', controller3.prompts.length, 1)

  // --- a parent already on the deployment default: nothing to hand down ---
  // `selectModel` also saves the selection as the deployment default, so the
  // handoff must not re-save a selection the child is created with anyway.
  const order4 = []
  const controller4 = makeController(order4)
  const sameSelection = { provider: 'api2', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' }
  const ctx4 = makeContext({
    order: order4,
    goals: makeGoals(order4),
    controller: controller4,
    totalTokens: 5_000_000,
    presets: makePresets(order4, 'workspace-write'),
    sessions: makeSessions(),
    projections: makeProjections({ lastUsed: { ...sameSelection }, pending: null }),
    defaultModel: { currentSelection: () => ({ ...sameSelection }) },
  })
  const fourth = await import(`${pluginPath}?defaultmodel=1`)
  fourth.apply(ctx4, { triggerTokens: 1, checkpointPath: 'checkpoint-{{session}}.md', autoNewSession: true, remindEverySteps: 1 })
  const workdir4 = await mkdtemp(join(tmpdir(), 'cp-park-gate-ws4-'))
  const agent4 = {
    id: 'agent-source-4',
    session: { id: 'session-source0004', header: { cwd: workdir4 } },
    whenIdle: async () => {},
  }
  const call4 = (payload) => ctx4.handlers.get('agent/pre-step')({ agent: agent4, signal, ...payload }, enter)
  await call4({ step: 1, turn: 1, messages: [human()] })
  await writeFile(join(workdir4, 'checkpoint-source00.md'), '# checkpoint\n', 'utf8')
  await call4({ step: 2, turn: 1, messages: [] })
  for (let i = 0; i < 50 && controller4.prompts.length === 0; i += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  check('a parent on the default model is not written to', controller4.modelSelections, [])
  check('a parent on the default model still hands off', controller4.prompts.length, 1)

  // --- an unavailable model must not break the handoff --------------------
  const order5 = []
  const controller5 = makeController(order5, { selectModel: 'throw' })
  const ctx5 = makeContext({
    order: order5,
    goals: makeGoals(order5),
    controller: controller5,
    totalTokens: 5_000_000,
    presets: makePresets(order5, 'workspace-write'),
    sessions: makeSessions(),
    projections: makeProjections({ lastUsed: { provider: 'api2', model: 'gone-model' }, pending: null }),
    defaultModel: { currentSelection: () => ({ provider: 'api2', model: 'deepseek-v4.1-flash' }) },
  })
  const fifth = await import(`${pluginPath}?modelfail=1`)
  fifth.apply(ctx5, { triggerTokens: 1, checkpointPath: 'checkpoint-{{session}}.md', autoNewSession: true, remindEverySteps: 1 })
  const workdir5 = await mkdtemp(join(tmpdir(), 'cp-park-gate-ws5-'))
  const agent5 = {
    id: 'agent-source-5',
    session: { id: 'session-source0005', header: { cwd: workdir5 } },
    whenIdle: async () => {},
  }
  const call5 = (payload) => ctx5.handlers.get('agent/pre-step')({ agent: agent5, signal, ...payload }, enter)
  await call5({ step: 1, turn: 1, messages: [human()] })
  await writeFile(join(workdir5, 'checkpoint-source00.md'), '# checkpoint\n', 'utf8')
  await call5({ step: 2, turn: 1, messages: [] })
  for (let i = 0; i < 50 && controller5.prompts.length === 0; i += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  check('an unavailable model does not break the handoff', [controller5.creates.length, controller5.prompts.length], [1, 1])

  // --- the fix: a web restart must not re-arm a handed-off session --------
  // The phase machine used to be memory-only, so every restart dropped the park
  // flag: the handed-off session came back 'watching', an injected goal round
  // was admitted, and it worked on beside its own successor. (Measured
  // 2026-09-17: after the 22:38 restart the plugin had no state for the parked
  // session at all — `/state?sessionId=…` did not even know it.) The same
  // $DSH_HOME plus a second module instance stands in for that restart.
  const stateFile = join(home, 'auto-checkpoint-state.json')
  const readStateFile = async () => {
    try {
      return JSON.parse(await readFile(stateFile, 'utf8'))
    } catch {
      return undefined
    }
  }
  const order6 = []
  const controller6 = makeController(order6)
  const ctx6 = makeContext({
    order: order6,
    goals: makeGoals(order6),
    controller: controller6,
    totalTokens: 5_000_000,
    presets: makePresets(order6, 'danger-full-access'),
    sessions: makeSessions(),
  })
  const sixth = await import(`${pluginPath}?restartbefore=1`)
  sixth.apply(ctx6, { triggerTokens: 1, checkpointPath: 'checkpoint-{{session}}.md', autoNewSession: true, remindEverySteps: 1 })
  const workdir6 = await mkdtemp(join(tmpdir(), 'cp-park-gate-ws6-'))
  const agent6 = {
    id: 'agent-restart',
    session: { id: 'session-restart001', header: { cwd: workdir6 } },
    whenIdle: async () => {},
  }
  const call6 = (payload) => ctx6.handlers.get('agent/pre-step')({ agent: agent6, signal, ...payload }, enter)
  await call6({ step: 1, turn: 1, messages: [human()] })
  await writeFile(join(workdir6, 'checkpoint-restart0.md'), '# checkpoint\nstate\n', 'utf8')
  await call6({ step: 2, turn: 1, messages: [] })

  // The park flag reaches disk from inside `handoff`, which is fired with
  // `void` — poll for it instead of racing a real file write.
  let parkedOnDisk
  for (let i = 0; i < 200; i += 1) {
    parkedOnDisk = await readStateFile()
    if (parkedOnDisk?.['agent-restart']?.phase === 'parked') break
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  check('the handoff writes the park flag to disk', parkedOnDisk?.['agent-restart']?.phase, 'parked')

  // A web that has just booted: same $DSH_HOME, no memory of the handoff.
  const order7 = []
  const reborn = await import(`${pluginPath}?restartafter=1`)
  const ctx7 = makeContext({
    order: order7,
    goals: makeGoals(order7),
    controller: makeController(order7),
    totalTokens: 5_000_000,
    sessions: makeSessions(),
  })
  reborn.apply(ctx7, { triggerTokens: 1, checkpointPath: 'checkpoint-{{session}}.md', autoNewSession: true, remindEverySteps: 1 })
  const callAfterRestart = (payload) => ctx7.handlers.get('agent/pre-step')({ agent: agent6, signal, ...payload }, enter)
  const goalAfterRestart = await callAfterRestart({ step: 1, turn: 2, messages: [goalRound()] })
  check('after a restart the handed-off session still rejects an injected goal round', goalAfterRestart, { kind: 'reject' })
  const humanAfterRestart = await callAfterRestart({ step: 1, turn: 3, messages: [human()] })
  check('after a restart a human message still reopens it', humanAfterRestart.kind, 'enter')
  check('reopening it clears the quarantine entry', (await readStateFile())?.['agent-restart'], undefined)

  await rm(home, { recursive: true, force: true })
  await rm(workdir, { recursive: true, force: true })
  await rm(workdir2, { recursive: true, force: true })
  await rm(workdir3, { recursive: true, force: true })
  await rm(workdir4, { recursive: true, force: true })
  await rm(workdir5, { recursive: true, force: true })
  await rm(workdir6, { recursive: true, force: true })

  const failed = results.filter((r) => !r.ok)
  process.stdout.write(`park-gate: ${results.length - failed.length}/${results.length} passed against ${pluginPath}\n`)
  for (const r of results) {
    process.stdout.write(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n        actual   ${JSON.stringify(r.actual)}\n        expected ${JSON.stringify(r.expected)}`}\n`)
  }
  process.exitCode = failed.length === 0 ? 0 : 1
}

main().catch((error) => {
  process.stderr.write(`park-gate: ${error?.stack ?? error}\n`)
  process.exitCode = 1
})
