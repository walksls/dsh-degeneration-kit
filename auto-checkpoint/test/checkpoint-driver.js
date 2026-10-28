/**
 * Dev-only checkpoint driver: boots a real headless agent with the
 * auto-checkpoint plugin, then drives a REAL relay chain — each handoff
 * creates an actual child agent (not a stub) and feeds it the continue
 * prompt, so the driver can observe whether the chain keeps going:
 *
 *   session A crosses the threshold → writes checkpoint-<a>.md
 *     → handoff creates session B, feeds "read checkpoint-<a>.md, continue"
 *       → session B crosses the threshold → writes checkpoint-<b>.md
 *         → handoff creates session C …
 *
 * Report answers: did棒1 write its own file? did棒2 get created and read it?
 * did棒2 write its own (non-overwriting) file? did the chain reach棒N?
 *
 * Run:
 *   dsh --profile headless --patch test/cp.patch.yml "<task>"
 */

import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'checkpoint-driver'
export const inject = ['agentDefaultModel', 'agents', 'sessions']

/** How many relay hops this run should observe before exiting. */
const MAX_HOPS = Number(process.env.CP_MAX_HOPS ?? 3)

const REPORT = {
  chain: [],        // one entry per session, in creation order
  prompts: [],      // continue prompts handed to children
  checkpointFiles: [],
  createRequests: [], // raw create() requests — proves cwd/preset inheritance
}

/** Real session controller: creates a real agent and feeds the continue prompt. */
function makeController(ctx, agents, selection) {
  return {
    create: async (request) => {
      const sessionId = `session-child-${randomUUID()}`
      REPORT.createRequests.push({ cwd: request?.cwd, agentPreset: request?.agentPreset ?? null })
      const { agent } = await agents.create({
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
      REPORT.chain.push({ sessionId, role: 'child', preset: request?.agentPreset ?? null, createdAt: Date.now() })
      return { sessionId }
    },
    prompt: async (request) => {
      const agent = ctx.get('agents').get(request.sessionId)
      const text = (request?.content ?? [])
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('')
      REPORT.prompts.push({ sessionId: request?.sessionId, text: text.slice(0, 120) })
      if (agent) {
        agent.followup(createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        }))
      }
      return { accepted: true }
    },
    cancel: async () => ({ accepted: true }),
  }
}

async function run(ctx) {
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  const selection = defaultModel.currentSelection()

  ctx.provide('sessionController', makeController(ctx, agents, selection))

  const firstId = `session-${randomUUID()}`
  // Mark the source session with a preset, exactly like a window opened in
  // "loli-mom" mode. Headless mounts no agentPresets projection, so the
  // plugin's header fallback is the path under test here; web reads the
  // projection first and falls back to the same header.
  const SOURCE_PRESET = process.env.CP_PRESET ?? 'loli-mom'
  const { agent } = await agents.create({
    sessionId: firstId,
    meta: { cwd: process.cwd(), agentPreset: SOURCE_PRESET },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: (agentCtx) => {
      installModelSelection(agentCtx, { current: selection, assembled: undefined })
    },
  })
  REPORT.chain.push({
    sessionId: firstId,
    role: 'first',
    preset: agent.session?.header?.agentPreset ?? null,
    createdAt: Date.now(),
  })
  await agent.whenIdle()

  agent.followup(createUserMessage({
    content: [{ type: 'text', text: '任务：把"relay hop ok"写入 hello.txt，然后结束。' }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()

  // Give the fire-and-forget handoff chain time to advance hop by hop.
  for (let i = 0; i < MAX_HOPS; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20000))
    const children = REPORT.chain.filter((e) => e.role === 'child').length
    if (children >= MAX_HOPS) break
    const live = agents.list?.() ?? []
    for (const a of live) await a.whenIdle?.().catch(() => {})
  }

  REPORT.checkpointFiles = (await readdir(process.cwd()).catch(() => []))
    .filter((f) => f.startsWith('checkpoint'))
    .sort()

  process.stdout.write(`checkpoint-driver: report ${JSON.stringify(REPORT, null, 2)}\n`)
  for (const a of agents.list?.() ?? []) {
    await sessions.flush(a.session).catch(() => {})
  }
  await sessions.flush(agent.session).catch(() => {})
  ctx.get('appExit')?.(0)
}

export function apply(ctx) {
  run(ctx).catch((error) => {
    process.stderr.write(`checkpoint-driver: ${error instanceof Error ? error.message : String(error)}\n`)
    ctx.get('appExit')?.(1)
  })
}
