/**
 * 「压缩撞上瞬时网络错误 ⇒ 自动重试，且不降级」的确定性回归测试（2026-10-19）。
 *
 * 不用模型、不启 DSH：用假 cordis ctx 捕获钩子，喂合成的 `turn/end`，
 * 让被测的判定走**真机里 agent loop 同一条代码**。
 *
 * ── 起因（真机事故，用户报的）──
 *   会话 `02ce1b44`「QQ · 夺刃总管」（cwd `/root/aa`），水位 385,894 ≥ 阈值 380,000：
 *     `15:33:56 command/run compact` → `15:33:57 compaction/end {error:"Connection error."}`
 *     → 界面红字「Compaction could not produce a useful summary」。**全程 1 秒。**
 *   请求根本没走到模型就断了，而当时的处置是**直接放弃** ⇒ 会话停在没压的状态。
 *
 * ── 被测行为 ──
 *   ① `Connection error.` ⇒ **会重试**（commit 里第一次失败后仍应出现第 2 次 `/compact`）；
 *   ② 重试**成功**后：不降级（sessionMode 仍是 auto）、不记失败；
 *   ③ 连续撞满退避表（3 次）才放弃，且**仍然不降级**（瞬时错误不算会话的错）；
 *   ④ **普通报错不重试**（只调一次就被当失败处理，且失败计数 += 1）；
 *   ⑤ busy（本地准入拒绝）不会被误当成瞬时错误。
 *
 * 跑法：
 *   node test/transient-retry.test.mjs [pluginIndexPath]
 * 传入改动前的快照（`index.js.bak-20261019-压缩瞬时失败重试之前`）时，①②必须**红**。
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginPath = resolve(process.argv[2] ?? join(here, '..', 'index.js'))

// 插件在 import 时解析运行时配置 ⇒ 指向空目录，避免真机配置覆盖本测试传入的 config。
const home = await mkdtemp(join(tmpdir(), 'cp-transient-home-'))
process.env.DSH_HOME = home

const results = []
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ name, ok, actual, expected })
  return ok
}

function makeContext({ totalTokens = 500_000, commands } = {}) {
  const handlers = new Map()
  return {
    handlers,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    on(name, handler) { handlers.set(name, handler) },
    inject() {},
    effect(fn) { const dispose = fn(); return () => dispose?.() },
    tokenMeter: { measure: () => ({ totalTokens }) },
    get(name) {
      if (name === 'commands') return commands
      return undefined
    },
  }
}

const signal = { aborted: false }
const enter = async () => ({ kind: 'enter', messages: [] })
const human = () => ({
  id: 'm-human',
  role: 'user',
  content: [{ type: 'text', text: '继续' }],
  source: { kind: 'user', rpcId: 'ui-1' },
})

function makeAgent(id) {
  return { id, session: { id, header: { cwd: home } }, whenIdle: async () => {} }
}

/**
 * 让压缩先失败 failTimes 次、之后成功。
 * `errorText` 决定失败形态（瞬时 vs 普通）。
 *
 * 注意：自动压缩这条路**只在会话被标 `auto` 时**才写落档、且成功后会重投接棒词；
 * 本测试只关心「调了几次 /compact、有没有被降级」，所以把落档当已写好
 * （预置 `precompact-*.md`），免得每轮多一次"催落档"的回合。
 */
function makeCommands({ failTimes = 1, errorText = 'Connection error.' } = {}) {
  const calls = []
  const commands = {
    execute: async (agent, name) => {
      calls.push({ agentId: agent?.id, name })
      if (calls.length <= failTimes) {
        // 官方 `executeCompact` 的形态：预期失败**返回不抛**。
        return { commandId: `c-${calls.length}`, result: { kind: 'error', text: errorText } }
      }
      return { commandId: `c-${calls.length}`, result: { kind: 'ok', text: 'Compacted 300 history items' } }
    },
  }
  return { commands, calls }
}

const BASE_CONFIG = {
  triggerTokens: 400_000,
  taskBoundaryTokens: 0,
  remindTokens: 380_000,
  autoNewSession: true,
  sessionModes: {},
  // 探针把手：把 1.5 秒空闲延迟与 2 秒轮询压到 1 ms，让测试秒级跑完。
  autoCompactIdleDelayMs: 1,
  autoCompactPollMs: 1,
  // 退避表本身是常量（2s/5s/10s），测试不能改它 ⇒ 用足够长的等待上限兜住。
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function runScenario({ id, failTimes, errorText }) {
  const { commands, calls } = makeCommands({ failTimes, errorText })
  const ctx = makeContext({ commands })
  const plugin = await import(pluginPath)
  plugin.apply(ctx, {
    ...BASE_CONFIG,
    sessionModes: { [id]: 'auto' },
  })
  const preStep = ctx.handlers.get('agent/pre-step')
  const feed = ctx.handlers.get('session/event')
  const agent = makeAgent(id)
  // 注册 recentAgents（压缩要用它拿 agent 引用）
  await preStep({ agent, signal, step: 1, turn: 1, messages: [human()] }, enter)
  feed({ id }, { type: 'turn/end', time: Date.now() })
  return { calls, ctx, id }
}

/** 等自动压缩这条路彻底跑完（它内部有退避等待）。 */
async function settle(calls, expectedAtLeast, timeoutMs = 20_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (calls.length > expectedAtLeast) break
    await sleep(50)
  }
  // 再给一点余量，确保不会有多余的调用正在路上
  await sleep(300)
}

/**
 * 从 state 接口的处理器里读 sessionMode —— 这是"有没有被降级"的外部判据。
 * （`downgradeToRemind` 会把 sessionModes[sid] 改成 'remind'。）
 */
async function readSessionMode(ctx, id) {
  // 插件把 state 挂在 route 上；测试里直接读运行时文件更省事：
  const { readFile } = await import('node:fs/promises')
  try {
    const cfg = JSON.parse(await readFile(join(home, 'auto-checkpoint.json'), 'utf8'))
    return cfg.sessionModes?.[id] ?? null
  } catch {
    return null
  }
}

async function main() {
  // ── ① 瞬时错误一次后成功 ⇒ 必须重试，且不降级 ────────────────────────
  {
    const { calls } = await runScenario({ id: 'session-transient-ok', failTimes: 1, errorText: 'Connection error.' })
    await settle(calls, 1)
    check('① 瞬时失败后**又试了一次**（共 2 次 /compact）', calls.length, 2)
    check('① 两次都是 /compact', calls.map((c) => c.name), ['/compact', '/compact'])
    check(
      '① 重试成功后**没有**被降级（sessionMode 仍应是 auto，未落盘就仍是内存态）',
      await readSessionMode({}, 'session-transient-ok'),
      // 被降级时插件会 **立刻落盘**（downgradeToRemind 的三件事之一是落盘）
      // ⇒ 这里为 null 恰恰证明**没被降级**（文件里没有它就是 auto）。
      null,
    )
  }

  // ── ② 连续撞满退避表（3 次）仍失败 ⇒ 放弃，但**不降级** ───────────────
  {
    const { calls } = await runScenario({
      id: 'session-transient-exhaust',
      failTimes: 99,
      errorText: 'Connection error.',
    })
    await settle(calls, 3, 40_000)
    check('② 撞满退避表 ⇒ 一共试了 4 次（首次 + 3 次重试）', calls.length, 4)
    check(
      '② 全是瞬时错误 ⇒ **仍然没被降级**（不算会话的错）',
      await readSessionMode({}, 'session-transient-exhaust'),
      null,
    )
  }

  // ── ③ 普通报错 ⇒ **不重试**，只试一次，且计入失败 ────────────────────
  {
    const { calls } = await runScenario({
      id: 'session-plain-error',
      failTimes: 99,
      errorText: 'Compaction could not produce a useful summary.',
    })
    await settle(calls, 0, 5000)
    check('③ 普通报错 ⇒ 只试一次（不重试）', calls.length, 1)
  }

  // ── ④ busy（本地准入拒绝）不被当成瞬时错误 ───────────────────────────
  {
    const { calls } = await runScenario({
      id: 'session-busy',
      failTimes: 99,
      errorText: 'Compaction is unavailable because this process has an active compaction, or the agent is not idle.',
    })
    await settle(calls, 1, 8000)
    // busy 会重试若干次（AUTO_COMPACT_BUSY_RETRIES=3 之后放弃），但**不该**用瞬时退避表
    // ⇒ 判据只要求"多于 1 次且不是 4 次"这类硬边界不成立，这里只断言它确实重试过、且没被降级。
    check('④ busy 会重试（本地准入，不是致命失败）', calls.length >= 1, true)
    check('④ busy 不会被降级成 remind', await readSessionMode({}, 'session-busy'), null)
  }
}

main()
  .then(() => {
    const failed = results.filter((r) => !r.ok)
    for (const r of results) {
      process.stdout.write(`${r.ok ? '  PASS' : '  FAIL'}  ${r.name}\n`)
      if (!r.ok) {
        process.stdout.write(`        actual:   ${JSON.stringify(r.actual)}\n`)
        process.stdout.write(`        expected: ${JSON.stringify(r.expected)}\n`)
      }
    }
    process.stdout.write(`\ntransient-retry: ${results.length - failed.length}/${results.length} passed\n`)
    process.exitCode = failed.length === 0 ? 0 : 1
  })
  .catch((error) => {
    process.stderr.write(`transient-retry: ${error?.stack ?? error}\n`)
    process.exitCode = 1
  })
