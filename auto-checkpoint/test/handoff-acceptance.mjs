#!/usr/bin/env node
/**
 * Dev-only: verdict on real (not simulated) checkpoint handoffs, read straight
 * from the persisted session logs. This is the "真机自然交棒" acceptance check
 * for the two 2026-09-17 fixes:
 *
 *   fix 1  a handed-off session must go quiet — no new turn, no goal round, and
 *          its armed goal must be paused;
 *   fix 2  the child session must inherit the parent's permission preset.
 *
 * It answers with the raw log facts only (no plugin logging is involved, since
 * plugin logs never reach web.log). Usage:
 *
 *   node test/handoff-acceptance.mjs                  # every handoff on disk
 *   node test/handoff-acceptance.mjs <parent> <child> # one pair (id prefixes ok)
 *
 * Exit code 0 = every applicable check passed, 1 = at least one failed.
 *
 * Pair discovery: the plugin prompts the child with a continue text naming the
 * checkpoint file `checkpoint-<parentShortId>.md`, and tags that prompt with
 * rpcId `auto-checkpoint-*`; both are read back from the child's own log.
 * Plugin children have `parentSession`/`isSeeded` absent (plain create()), which
 * distinguishes them from GUI forks (the controller's fork path sets both).
 */

import { execFileSync } from 'node:child_process'
import { readdirSync, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const SESSIONS = join(HOME, 'sessions')
const RPC_PREFIX = 'auto-checkpoint-'
const GOAL_PAUSE_WINDOW_MS = 5000
/** The fix applies the preset within milliseconds of create(); be generous. */
const INHERIT_WINDOW_MS = 10000

/** Local time, matching the session logs and everything else on this machine. */
const clock = (ms) => {
  if (ms === undefined || ms === null) return '?'
  const d = new Date(ms)
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return (
    `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:` +
    `${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
  )
}

function eventsOf(file) {
  const out = execFileSync('zstd', ['-dc', file], { maxBuffer: 1 << 30 })
  const events = []
  for (const line of out.toString('utf8').split('\n')) {
    const text = line.trim()
    if (text === '') continue
    try {
      events.push(JSON.parse(text))
    } catch {}
  }
  return events
}

function loadAll() {
  if (!existsSync(SESSIONS)) return []
  const found = []
  for (const dir of readdirSync(SESSIONS)) {
    const root = join(SESSIONS, dir)
    let names = []
    try {
      names = readdirSync(root)
    } catch {
      continue
    }
    for (const name of names) {
      const file = join(root, name, 'session.v3.jsonl.zstd')
      if (!existsSync(file) || !statSync(file).isFile()) continue
      let events
      try {
        events = eventsOf(file)
      } catch {
        continue
      }
      const header = events.find((e) => e.type === 'session')
      if (header === undefined) continue
      found.push({ id: header.id, file, header, events })
    }
  }
  return found
}

const textOf = (event) =>
  (event.data?.content ?? [])
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')

/**
 * The prompt this plugin sent to the child, or undefined.
 *
 * Two traps this must survive:
 *   1. a GUI fork copies the parent's log verbatim, tagged prompt included, so
 *      the rpcId prefix alone proves nothing — the prompt must also arrive at
 *      or after the session's own creation, and a fork carries `isSeeded`;
 *   2. an old prompt may name a grandparent's checkpoint file, so only the
 *      qualifying prompt may be used to name the parent.
 */
function handoffPromptOf(session) {
  if (session.header.isSeeded === true) return undefined
  const created = session.header.createdAt ?? 0
  return session.events.find(
    (e) =>
      e.type === 'user/message' &&
      typeof e.data?.source?.rpcId === 'string' &&
      e.data.source.rpcId.startsWith(RPC_PREFIX) &&
      typeof e.time === 'number' &&
      e.time >= created - 1000,
  )
}

function parentIdOf(child) {
  const prompt = handoffPromptOf(child)
  if (prompt === undefined) return null
  const match = /checkpoint-([0-9a-f]{8})\.md/.exec(textOf(prompt))
  return match === null ? null : match[1]
}

function resolve(prefix) {
  // Accept both the short id printed in the checkpoint names and the full one.
  const needle = prefix.startsWith('session-') ? prefix : `session-${prefix}`
  return all.filter((s) => s.id.startsWith(needle))
}

function check(pair) {
  const { parent, child } = pair
  const handoffAt = child.header.createdAt
  const lines = []
  let failed = false
  const verdict = (ok, label, detail) => {
    if (!ok) failed = true
    lines.push(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }

  // ---- fix 1: the old session goes quiet --------------------------------
  const after = parent.events.filter((e) => typeof e.time === 'number' && e.time > handoffAt)
  const turnsAfter = after.filter((e) => e.type === 'turn/start')
  const stepsAfter = after.filter((e) => e.type === 'step/start')
  const toolsAfter = after.filter((e) => e.type === 'tool/call')
  const last = parent.events[parent.events.length - 1]
  const maxTime = parent.events.reduce((max, e) => (typeof e.time === 'number' && e.time > max ? e.time : max), 0)
  const lastEnd = [...parent.events].reverse().find((e) => e.type === 'turn/end')
  const turns = parent.events.filter((e) => e.type === 'turn/start').length

  lines.push(
    `  parent: ${turns} turn(s); after the handoff: ${turnsAfter.length} turn / ` +
      `${stepsAfter.length} step / ${toolsAfter.length} tool call; last event ${last.type} @ ${clock(maxTime)}`,
  )
  verdict(
    turnsAfter.length === 0 && stepsAfter.length === 0,
    'old session stopped after the handoff',
    turnsAfter.length === 0 ? `quiet for the rest of its log` : `${turnsAfter.length} new turn(s)`,
  )
  // Informational: a handoff usually ends its turn 'blocked' (the park gate
  // rejects the confirming step), but a turn that closes naturally first is
  // 'completed' — neither is a defect, so this is not a verdict.
  lines.push(`  note: handoff turn ended '${lastEnd?.data?.reason?.kind ?? '?'}'`)

  // ---- fix 1: an armed goal is paused, no goal round is served ----------
  // The plugin pauses an armed goal and *then* creates the child, so the pause
  // lands milliseconds BEFORE the child's createdAt. Reading the phase "at or
  // before the handoff" therefore already shows 'paused' and silently skipped
  // the check on the 09-17 22:30 handoff, where the pause was real (-13ms).
  // So: look for the pause event in the ±window, and separately ask whether the
  // goal was still armed when that pause happened.
  const goalEvents = parent.events.filter((e) => e.type === 'goal/change')
  const goalPhaseBefore = (at, strict) =>
    goalEvents
      .filter((e) => e.data?.goal !== undefined && (strict ? e.time < at : e.time <= at))
      .reduce((phase, e) => e.data.goal.phase, null)
  const armedAtHandoff = goalPhaseBefore(handoffAt, false)
  const pauseNear = goalEvents
    .filter((e) => e.data?.operation === 'pause' && Math.abs(e.time - handoffAt) <= GOAL_PAUSE_WINDOW_MS)
    .pop()
  const phaseBeforePause = pauseNear === undefined ? null : goalPhaseBefore(pauseNear.time, true)
  const goalRoundsAfter = after.filter(
    (e) => e.type === 'user/message' && (e.data?.source?.kind === 'goal' || textOf(e).includes('<goal_round>')),
  )
  if (pauseNear !== undefined && phaseBeforePause === 'active') {
    verdict(
      true,
      'armed goal paused at the handoff',
      `${clock(pauseNear.time)} (${pauseNear.time - handoffAt}ms vs the child; armed until then)`,
    )
  } else if (armedAtHandoff === 'active') {
    verdict(false, 'armed goal paused at the handoff', pauseNear === undefined ? 'no pause event' : `${clock(pauseNear.time)} came after the goal was un-armed`)
  } else {
    lines.push(`  goal: no armed goal at handoff (phase ${armedAtHandoff ?? 'none'}) — pause path not applicable`)
  }
  verdict(goalRoundsAfter.length === 0, 'no goal round served after the handoff', `${goalRoundsAfter.length} round(s)`)

  // ---- fix 2: the child inherits the parent's permission preset ---------
  const presetAt = (session, at) =>
    session.events
      .filter((e) => e.type === 'permission/preset' && (at === undefined || e.time <= at))
      .reduce((preset, e) => e.data?.preset ?? preset, null)
  const parentPreset = presetAt(parent, handoffAt)
  const childPublished = child.events.find((e) => e.type === 'permission/preset')?.data?.preset ?? null
  // Read the preset the handoff itself left behind, never the child's *current*
  // one: a user who widens the child by hand later (14ff938d did, at 21:48)
  // would otherwise make a missing inheritance look like a pass.
  const childInherited = presetAt(child, handoffAt + INHERIT_WINDOW_MS)
  const childCurrent = presetAt(child)
  lines.push(
    `  preset: parent ${parentPreset} → child ${childPublished} (published) → ` +
      `${childInherited} (inherited) → ${childCurrent} (current now)`,
  )
  verdict(
    childInherited === parentPreset,
    'child inherited the parent permission preset',
    `${childInherited} vs ${parentPreset}`,
  )

  // ---- fix 3: the child inherits the parent's model selection -----------
  // The model a session runs on is visible in the request stream
  // (`request/header.header.config`), while a switch the user made also lands
  // as a `model/selection` event — and that event is what the plugin reads
  // (it hands down the projection's `pending ?? lastUsed`). Prefer the event
  // when the session has one, fall back to the last request: a parent already
  // on the deployment default is skipped by design, so equality is expected in
  // both cases, and a child that snapped back to the default shows up as a
  // mismatch. CAVEAT: `pending` vs `lastUsed` cannot be told apart from the log
  // alone, so a parent switched to another model *without ever using it* may
  // legitimately read here as the older model.
  const modelKey = (m) =>
    m === undefined
      ? '?'
      : `${m.provider}/${m.model}${m.reasoningEffort === undefined ? '' : ` (effort ${m.reasoningEffort})`}`
  const lastOf = (session, type, at) =>
    session.events.filter((e) => e.type === type && typeof e.time === 'number' && e.time <= at).pop()
  const parentModel =
    lastOf(parent, 'model/selection', handoffAt)?.data ??
    lastOf(parent, 'request/header', handoffAt)?.data?.header?.config
  const childRequest = child.events.find(
    (e) => e.type === 'request/header' && typeof e.time === 'number' && e.time >= handoffAt,
  )
  const childModel = childRequest?.data?.header?.config
  const sameModel = (a, b) =>
    a !== undefined &&
    b !== undefined &&
    a.provider === b.provider &&
    a.model === b.model &&
    (a.reasoningEffort ?? undefined) === (b.reasoningEffort ?? undefined)
  if (parentModel === undefined || childModel === undefined) {
    lines.push(
      `  model: cannot judge — no ${parentModel === undefined ? 'parent selection' : 'child request'} in these logs`,
    )
  } else {
    lines.push(`  model: parent ${modelKey(parentModel)} → child ${modelKey(childModel)} (first request)`)
    verdict(
      sameModel(parentModel, childModel),
      'child inherited the parent model selection',
      `${modelKey(childModel)} vs ${modelKey(parentModel)}`,
    )
  }

  lines.push(
    `  child: cwd ${child.header.cwd ?? '?'} preset ${child.header.agentPreset ?? 'default'} ` +
      `seeded ${child.header.isSeeded ?? false} created ${clock(handoffAt)}`,
  )

  return { failed, lines, handoffAt }
}

// ---------------------------------------------------------------- main ----

const all = loadAll()
const args = process.argv.slice(2)
let pairs = []

if (args.length >= 2) {
  const parents = resolve(args[0])
  const children = resolve(args[1])
  if (parents.length !== 1 || children.length !== 1) {
    console.error(`handoff-acceptance: ambiguous or unknown session ids (${parents.length}/${children.length} matched)`)
    process.exit(2)
  }
  pairs = [{ parent: parents[0], child: children[0] }]
} else {
  for (const child of all) {
    if (handoffPromptOf(child) === undefined) continue
    const short = args[0] ?? parentIdOf(child)
    const parent = all.find((s) => s.id.startsWith(`session-${short}`))
    if (parent !== undefined) pairs.push({ parent, child })
  }
  pairs.sort((a, b) => a.child.header.createdAt - b.child.header.createdAt)
}

if (pairs.length === 0) {
  console.log('handoff-acceptance: no checkpoint handoff found in these session logs')
  process.exit(0)
}

let anyFailed = false
for (const pair of pairs) {
  console.log(`\n=== handoff ${pair.parent.id.slice(0, 16)} → ${pair.child.id.slice(0, 16)} @ ${clock(pair.child.header.createdAt)}`)
  const { failed, lines } = check(pair)
  for (const line of lines) console.log(line)
  console.log(`  ${failed ? 'VERDICT: FAIL' : 'VERDICT: PASS'}`)
  anyFailed = anyFailed || failed
}
console.log(`\nhandoff-acceptance: ${pairs.length} handoff(s) checked — ${anyFailed ? 'FAIL' : 'PASS'}`)
process.exit(anyFailed ? 1 : 0)
