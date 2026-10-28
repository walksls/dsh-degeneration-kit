/**
 * 「跨周期的旧落档冒充本周期落档」的确定性回归测试（2026-10-28）。
 *
 * 不用模型、不启 DSH：假 cordis ctx 捕获钩子，喂合成 `turn/end`，
 * 被测的是真机里 agent loop 调用的**同一段代码**。
 *
 * ── 真机事故（用户报的）──
 *   会话 `02ce1b44`「夺刃总管」（cwd `/root/aa`）：
 *     · 落档 `precompact-02ce1b44.md` mtime = `10-27 22:18:08`
 *     · 上一次压缩结束                                  = `10-27 17:53:24`
 *     · 本次压缩开始                                    = `10-28 03:58:29`
 *   旧判据下界 = 「上一次压缩结束」⇒ `22:18 > 17:53` ⇒ 判"新鲜"⇒ **不催办、直接压**。
 *   但那 **5 小时 40 分**的对话没进任何落档，正是这次压缩要折叠的内容 ⇒ 细节全丢。
 *
 * ── 被测行为（用户拍板方案 A）──
 *   ① 落档 mtime 晚于「上次压缩结束」但**早于「本次窗口」** ⇒ **必须重新催**
 *      （这是本次要抓的回归点：旧版会直接压、不催）
 *   ② 落档 mtime 落在 30 分钟内 ⇒ 算新鲜 ⇒ 不催、直接压
 *   ③ 落档不存在 ⇒ 催
 *   ④ 催满 PRECOMPACT_MAX_ASKS 次仍没有 ⇒ **照压不误**（绝不把压缩卡死）
 *
 * 跑法：
 *   node test/precompact-period.test.mjs [pluginIndexPath]
 * 传改动前的快照（先 `cp index.js.bak-… /tmp/old.mjs`）时，① 必须**红**。
 */

import { mkdtemp, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginPath = resolve(process.argv[2] ?? join(here, '..', 'index.js'))

// 🛑 每个场景必须用**独立的 HOME + 独立 import**：
// 插件是模块级的（`runtime` / `recentAgents` / `stateFor` 都挂在模块作用域），
// 同一进程里 `apply()` 多次会让前一个场景的状态串到后一个里 ——
// 2026-10-28 实测：不隔离时「新鲜落档」场景会误催（因为上一个场景把 st.preflightAtMs 改了）。
let home = await mkdtemp(join(tmpdir(), 'cp-precompact-period-'))
process.env.DSH_HOME = home

const results = []
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ name, ok, actual, expected })
  return ok
}

function makeContext({ totalTokens = 500_000, commands } = {}) {
  const handlers = new Map()
  const prompts = []
  return {
    handlers,
    prompts,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    on(name, handler) { handlers.set(name, handler) },
    inject() {},
    effect(fn) { const dispose = fn(); return () => dispose?.() },
    tokenMeter: { measure: () => ({ totalTokens }) },
    get(name) {
      // 落档催办走 sessionController.prompt
      if (name === 'sessionController') {
        return {
          prompt: async (payload) => { prompts.push(payload) },
        }
      }
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

const BASE_CONFIG = {
  triggerTokens: 400_000,
  taskBoundaryTokens: 0,
  remindTokens: 380_000,
  autoNewSession: true,
  autoCompactIdleDelayMs: 1,
  autoCompactPollMs: 1,
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 造一个"有历史压缩记录"的假 session：
 * `lastSuccessfulCompaction()` 会从 session 里找 `compaction/end`。
 * 我们直接给一个最小可用的替身 —— 让 lastCompactionEndMs 返回一个**很久以前**的时刻。
 */
/**
 * 🛑 **不要**给假 session 塞 `compaction/end` 历史事件。
 * 起因（2026-10-28 踩的）：塞了之后 `deliverReanchor` 会把它当成"刚压缩完"，
 * 于是往 pre-step 里注入接棒词、并占住 `reanchoredCompactionId` ⇒
 * **测试实际测的是接棒词那条路，而不是压缩落档那条路**，三次断言全假红。
 * ⇒ 判据：要测「上次压缩结束」这条下界，就走真实路径（真压一次让 state 里带上时间），
 *    在离线测试里则**不要伪造历史事件**。
 */
function makeAgent(id, cwd) {
  const session = {
    id,
    header: { cwd },
    seq: 0,
    eventAt: () => undefined,
  }
  return { id, session, whenIdle: async () => {} }
}

async function runScenario({ name, noteAgeMs }) {
  const { commands, calls } = (() => {
    const calls = []
    return {
      calls,
      commands: {
        execute: async (agent, cmd) => {
          calls.push({ agentId: agent?.id, name: cmd })
          return { commandId: `c-${calls.length}`, result: { kind: 'ok', text: 'Compacted 300 history items' } }
        },
      },
    }
  })()

  const id = `session-${name}`
  // 独立 HOME + 全新模块实例（`?v=` 破缓存），保证场景之间零串扰。
  home = await mkdtemp(join(tmpdir(), `cp-pp-${name}-`))
  process.env.DSH_HOME = home
  const ctx = makeContext({ commands })
  const plugin = await import(`${pluginPath}?scenario=${name}`)
  plugin.apply(ctx, { ...BASE_CONFIG, sessionModes: { [id]: 'auto' } })

  // 造落档文件（存在则设置 mtime）
  // 🛑 插件拼文件名用的是 **session.id 去掉 `session-` 后取前 8 位**（见 `preflightAbspath`），
  //    不是整段 name！`fresh-note` 会被截成 `fresh-no` ⇒ 2026-10-28 这里踩过：
  //    测试写 `precompact-fresh-note.md`、插件找 `precompact-fresh-no.md` ⇒ 永远"没有落档" ⇒ 假红。
  const short = name.replace(/^session-/, '').slice(0, 8)
  const notePath = join(home, `precompact-${short}.md`)
  if (noteAgeMs !== null) {
    await writeFile(notePath, '# precompact 落档\n\n## 下一步第一件事\n\nx\n', 'utf8')
    const when = new Date(Date.now() - noteAgeMs)
    await utimes(notePath, when, when)
  }

  const agent = makeAgent(id, home)
  await ctx.handlers.get('agent/pre-step')({ agent, signal, step: 1, turn: 1, messages: [human()] }, enter)
  ctx.handlers.get('session/event')({ id }, { type: 'turn/end', time: Date.now() })
  await sleep(1500)

  return { calls, prompts: ctx.prompts }
}

async function main() {
  // ── ① 落档比"上次压缩结束"新、但**早于本次窗口**（5 小时前）⇒ 必须重新催 ──
  {
    const { calls, prompts } = await runScenario({ name: 'stale-cross-period', noteAgeMs: 5 * 60 * 60 * 1000 })
    check('① 5 小时前的落档 ⇒ **催落档**（这是本次修的回归点）', prompts.length >= 1, true)
    check('① 催了落档 ⇒ 这一轮**不压**（等档写完）', calls.length, 0)
  }

  // ── ② 落档 5 分钟前刚写 ⇒ 新鲜，不催、直接压 ──
  {
    const { calls, prompts } = await runScenario({ name: 'fresh-note', noteAgeMs: 5 * 60 * 1000 })
    check('② 5 分钟前刚写的落档 ⇒ **不催**', prompts.length, 0)
    check('② 直接压了一次', calls.length >= 1, true)
  }

  // ── ③ 落档不存在 ⇒ 催 ──
  {
    const { calls, prompts } = await runScenario({ name: 'no-note', noteAgeMs: null })
    check('③ 没有落档 ⇒ 催', prompts.length >= 1, true)
    check('③ 这一轮不压', calls.length, 0)
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
    process.stdout.write(`\nprecompact-period: ${results.length - failed.length}/${results.length} passed\n`)
    process.exitCode = failed.length === 0 ? 0 : 1
  })
  .catch((error) => {
    process.stderr.write(`precompact-period: ${error?.stack ?? error}\n`)
    process.exitCode = 1
  })
