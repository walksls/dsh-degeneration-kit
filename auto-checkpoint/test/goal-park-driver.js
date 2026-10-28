/**
 * Dev-only goal/park driver — the regression test for the "handed-off session
 * keeps working" bug (observed in the wild on 2026-09-17, session 9073b0c0:
 * after the handoff the old session ran 20 more minutes of real work in the
 * same workspace as its own successor, until the user stopped it by hand).
 *
 * Scenario reproduced here:
 *   1. the source session arms a goal, so the goal-round-driver queues one
 *      `<goal_round>` every time the session goes quiescent;
 *   2. the token threshold is crossed, the model writes the checkpoint file,
 *      and the plugin hands off — creating a child session that continues in
 *      the same workspace;
 *   3. the first goal round then lands on the old (parked) session.
 *
 * Verdict fields (the caller compares them across plugin revisions):
 *   source.goalPhaseAfter    → 'paused' with the fix | 'active' without it
 *   source.goalRounds        → 0 with the fix | ≥ 1 without it
 *   source.turns.length      → 1 with the fix | ≥ 2 without it
 *   source.stepsAfterTurn1   → 0 with the fix | > 0 without it (real work!)
 *   children.length          → 1 in both cases: the handoff itself must work
 *
 * Run:
 *   DSH_HOME=<mirror without auto-checkpoint.json> CP_PLUGIN=<plugin entry> \
 *   node <dsh>/lib/bin.js --profile headless --patch test/goal-park.patch.yml "<task>"
 */

import { randomUUID } from 'node:crypto'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'goal-park-driver'
export const inject = ['agentDefaultModel', 'agents', 'sessions', 'goals']

const TASK = '任务：把 "goal park probe ok" 写进 probe.txt（一行即可），然后结束。'
const OBJECTIVE = '回归测试目标：验证交棒后旧会话不再自行续跑（goal-park 场景）。'
const MAX_GOAL_ROUNDS = Number(process.env.CP_MAX_GOAL_ROUNDS ?? 3)
const WAIT_HANDOFF_MS = Number(process.env.CP_WAIT_HANDOFF_MS ?? 150000)
const SETTLE_MS = Number(process.env.CP_SETTLE_MS ?? 45000)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const clock = (t) => new Date(t).toISOString().slice(11, 23)

async function run(ctx) {
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const sessions = ctx.get('sessions')
  const goals = ctx.goals
  const selection = ctx.get('agentDefaultModel').currentSelection()

  const report = {
    pluginEntry: process.env.CP_PLUGIN ?? 'dsh-auto-checkpoint (linked package)',
    workspace: process.cwd(),
    source: {
      sessionId: null,
      goalCreated: null,
      goalPhaseAfter: null,
      goalActivationAfter: null,
      goalRounds: 0,
      turns: [],
      stepsAfterTurn1: 0,
      toolCallsAfterTurn1: 0,
    },
    handoffObserved: false,
    children: [],
    childPrompts: [],
    controllerNotes: [],
    timeline: [],
    // Permission inheritance: the source is widened to full access before the
    // run, so the child either keeps the default knobs or inherits them.
    preset: { mounted: false, source: null, child: null },
  }

  const presets = ctx.get('permissionPresets')

  let sourceId = null
  const byTurn = new Map()

  ctx.on('session/event', (session, event) => {
    if (session.id !== sourceId) return
    const at = clock(event.time)
    switch (event.type) {
      case 'turn/start': {
        const entry = { turn: event.data.turn, at, steps: 0, toolCalls: 0, endReason: null }
        report.source.turns.push(entry)
        byTurn.set(event.data.turn, entry)
        report.timeline.push(`${at} turn ${event.data.turn} start`)
        break
      }
      case 'step/start': {
        const entry = byTurn.get(event.data.turn)
        if (entry !== undefined) entry.steps += 1
        break
      }
      case 'tool/call': {
        const entry = byTurn.get(event.data.turn)
        if (entry !== undefined) entry.toolCalls += 1
        break
      }
      case 'turn/end': {
        const entry = byTurn.get(event.data.turn)
        const reason = JSON.stringify(event.data.reason)
        if (entry !== undefined) entry.endReason = event.data.reason
        report.timeline.push(`${at} turn ${event.data.turn} end ${reason}`)
        break
      }
      case 'user/message': {
        const source = event.data?.source ?? {}
        if (source.kind === 'goal') {
          report.source.goalRounds += 1
          report.timeline.push(`${at} GOAL ROUND injected (round ${source.round ?? '?'})`)
        } else if (source.kind === 'user') {
          report.timeline.push(`${at} human message`)
        }
        break
      }
      default:
        break
    }
  })

  // Mock session controller: hand off exactly once, then refuse. Bounding the
  // chain keeps this regression test to one hop and one workspace.
  let hop = 0
  ctx.provide('sessionController', {
    create: async (request) => {
      if (hop >= 1) {
        report.controllerNotes.push('create() refused: chain bounded to one hop')
        throw new Error('goal-park-driver: relay chain bounded to one hop')
      }
      hop += 1
      const sessionId = `session-child-${randomUUID()}`
      report.children.push({ sessionId, cwd: request?.cwd ?? null, agentPreset: request?.agentPreset ?? null })
      await agents.create({
        sessionId,
        meta: {
          cwd: request?.cwd ?? process.cwd(),
          ...(request?.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }),
        },
        agentOptions: { provider: selection.provider, model: selection.model },
        setup: (agentCtx) => {
          installModelSelection(agentCtx, { current: selection, assembled: undefined })
        },
      })
      return { sessionId }
    },
    prompt: async (request) => {
      const child = ctx.get('agents').get(request.sessionId)
      const text = (request?.content ?? [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('')
      report.childPrompts.push({ sessionId: request?.sessionId, text: text.slice(0, 140) })
      if (child !== undefined) {
        child.followup(createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        }))
      }
      return { accepted: true }
    },
    cancel: async () => ({ accepted: true }),
  })

  sourceId = `session-${randomUUID()}`
  report.source.sessionId = sourceId
  const { agent } = await agents.create({
    sessionId: sourceId,
    meta: { cwd: process.cwd() },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: (agentCtx) => {
      installModelSelection(agentCtx, { current: selection, assembled: undefined })
    },
  })
  await agent.whenIdle()

  // Widen the source session exactly like a user picking "full access" in the
  // GUI, so the handoff has something to inherit (the child otherwise starts
  // from the profile default).
  if (typeof presets?.set === 'function' && typeof presets?.current === 'function') {
    report.preset.mounted = true
    presets.set(agent.session, 'danger-full-access')
    report.preset.source = presets.current(agent.session)
  }

  // Arm the goal BEFORE the task: this is what makes the round driver queue an
  // automatic continuation the moment the handed-off turn closes.
  const goal = goals.create(agent, { objective: OBJECTIVE, maxGoalRounds: MAX_GOAL_ROUNDS })
  report.source.goalCreated = { id: goal.id, phase: goal.phase, activation: goal.activation, maxGoalRounds: goal.maxGoalRounds }

  agent.followup(createUserMessage({
    content: [{ type: 'text', text: TASK }],
    source: { kind: 'user' },
  }))

  const deadline = Date.now() + WAIT_HANDOFF_MS
  while (report.children.length === 0 && Date.now() < deadline) await sleep(1000)
  report.handoffObserved = report.children.length > 0
  if (!report.handoffObserved) report.controllerNotes.push(`no handoff within ${WAIT_HANDOFF_MS} ms`)

  // Let any post-handoff continuation show itself.
  await sleep(SETTLE_MS)

  const after = goals.get(agent)
  report.source.goalPhaseAfter = after?.phase ?? null
  report.source.goalActivationAfter = after?.activation ?? null
  report.source.stepsAfterTurn1 = report.source.turns.slice(1).reduce((sum, t) => sum + t.steps, 0)
  report.source.toolCallsAfterTurn1 = report.source.turns.slice(1).reduce((sum, t) => sum + t.toolCalls, 0)

  const childId = report.children[0]?.sessionId
  if (report.preset.mounted && childId !== undefined) {
    const childSession = ctx.get('sessions')?.get?.(childId)
    report.preset.child = childSession === undefined ? null : presets.current(childSession)
  }

  process.stdout.write(`goal-park-driver: report ${JSON.stringify(report, null, 2)}\n`)
  for (const live of agents.list?.() ?? []) await sessions.flush(live.session).catch(() => {})
  await sessions.flush(agent.session).catch(() => {})
  ctx.get('appExit')?.(0)
}

export function apply(ctx) {
  run(ctx).catch((error) => {
    process.stderr.write(`goal-park-driver: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    ctx.get('appExit')?.(1)
  })
}
