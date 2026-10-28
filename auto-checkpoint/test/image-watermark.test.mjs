/**
 * 「图片水位」（2026-10-14）的确定性回归测试 —— 不用模型、不启 DSH。
 *
 * 用假 cordis ctx 捕获插件注册的钩子，直接喂合成的 `agent/pre-step` 与
 * `session/event(turn/end)`，所以被测的判定与真机里 agent loop 调用的那条路**是同一段代码**。
 *
 * 被测行为（用户 2026-10-14 拍板）：
 *   ① 图片体积 ≥ 16 MB、会话**没被标 `auto`** ⇒ 走既有交棒链路：注入「请写检查点」，
 *      且提示词说**图片**原因（不许再谎报"上下文压力已达 X token"）；
 *   ② 同一条件、会话**被标 `auto`** ⇒ 自动压缩（与 token 压力门**并列**，token 很低也照样压）；
 *   ③ `imageWatermark: false` ⇒ 两条路都不触发（有些 api 没有图片限制）；
 *   ④ `dsh-image-budget` 不在场（共享符号不存在）⇒ 永不触发（安全退化）。
 *
 * 跑法：
 *   node test/image-watermark.test.mjs [pluginIndexPath]
 * 传入改动前的快照（`index.js.bak-20261014-图片水位前`）时，①②两条必须**红** ——
 * 那正是它作为回归测试而不是"现状描述"的原因。
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginPath = resolve(process.argv[2] ?? join(here, '..', 'index.js'))

// 插件在 import 时解析运行时配置文件 ⇒ 指到空目录，免得真机的
// ~/.dsh/auto-checkpoint.json 覆盖本测试传进去的 config。
const home = await mkdtemp(join(tmpdir(), 'cp-image-watermark-home-'))
process.env.DSH_HOME = home

const MB = 1024 * 1024
const IMAGE_SHARED_KEY = Symbol.for('dsh-image-budget.shared')

const results = []
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ name, ok, actual, expected })
  return ok
}

/**
 * 伪造 `dsh-image-budget` 的实时共享态 —— 与那个插件挂的是**同一个符号**
 * （同进程 ⇒ 插件读的就是这里写进去的字节数）。
 */
function installImageBudget(entries = []) {
  const shared = { sessions: new Map(entries.map(([id, mb]) => [id, { bytes: Math.round(mb * MB), count: 1 }])) }
  globalThis[IMAGE_SHARED_KEY] = shared
  return shared
}

/** 假 ctx：捕获钩子，只提供插件真正会读的服务。 */
function makeContext({ totalTokens = 100, commands } = {}) {
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
const human = () => ({ id: 'm-human', role: 'user', content: [{ type: 'text', text: '继续' }], source: { kind: 'user', rpcId: 'ui-1' } })

/** 注入文本（把这一回合插进来的所有消息正文拼起来，便于断言）。 */
const injectedText = (decision) =>
  (decision?.messages ?? []).map((m) => (m?.content ?? []).map((c) => c?.text ?? '').join('')).join('\n')

function makeAgent(id) {
  return { id, session: { id, header: { cwd: home } }, whenIdle: async () => {} }
}

const BASE_CONFIG = {
  // token 阈值故意设到天上、任务边界关掉 ⇒ 唯一可能触发的原因就只剩图片水位。
  triggerTokens: 1_000_000,
  taskBoundaryTokens: 0,
  remindTokens: 400_000,
  autoNewSession: true,
}

async function main() {
  // ── ① 未标记会话：图片 20 MB ⇒ 催写检查点（走交棒那条路）──────────────
  {
    installImageBudget([['session-img-over', 20]])
    const ctx = makeContext()
    const plugin = await import(pluginPath)
    plugin.apply(ctx, { ...BASE_CONFIG })
    const agent = makeAgent('session-img-over')
    const out = await ctx.handlers.get('agent/pre-step')({ agent, signal, step: 1, turn: 1, messages: [human()] }, enter)
    const text = injectedText(out)
    check('图片 20 MB ⇒ 注入「请写检查点」的提示词', text.includes('请立即把项目当前状态写入'), true)
    // 🆕 2026-10-14：催办必须给**绝对路径**。原先给的是工作区相对路径，模型会按
    // "自己正在干活的仓库"解析 ⇒ 写到别的目录、插件在 cwd 下看不到（实测事故：
    // 会话 `7e73f1e7` 因此被白催一遍、白写 16.5 KB，压缩后读到的还是旧档）。
    check('催办给的是绝对路径（含本会话 cwd）', text.includes(home), true)
    check('提示词说的是图片原因（20.0 MB）', text.includes('图片体积已达 20.0 MB'), true)
    check('不再谎报"上下文压力已达"（token 只到 100）', text.includes('当前上下文压力已达'), false)
  }

  // ── ② 未标记会话：图片 15.9 MB（低于 16 MB 水位）⇒ 什么都不做 ─────────
  {
    installImageBudget([['session-img-under', 15.9]])
    const ctx = makeContext()
    const plugin = await import(pluginPath)
    plugin.apply(ctx, { ...BASE_CONFIG })
    const agent = makeAgent('session-img-under')
    const out = await ctx.handlers.get('agent/pre-step')({ agent, signal, step: 1, turn: 1, messages: [human()] }, enter)
    check('图片 15.9 MB（低于水位）⇒ 不注入任何东西', injectedText(out), '')
  }

  // ── ③ 开关关闭：20 MB 也不触发 ────────────────────────────────────────
  {
    installImageBudget([['session-img-off', 20]])
    const ctx = makeContext()
    const plugin = await import(pluginPath)
    plugin.apply(ctx, { ...BASE_CONFIG, imageWatermark: false })
    const agent = makeAgent('session-img-off')
    const out = await ctx.handlers.get('agent/pre-step')({ agent, signal, step: 1, turn: 1, messages: [human()] }, enter)
    check('imageWatermark=false ⇒ 图片 20 MB 也不触发', injectedText(out), '')
  }

  // ── ④ dsh-image-budget 不在场 ⇒ 安全退化（不炸、不触发）───────────────
  {
    delete globalThis[IMAGE_SHARED_KEY]
    const ctx = makeContext()
    const plugin = await import(pluginPath)
    plugin.apply(ctx, { ...BASE_CONFIG })
    const agent = makeAgent('session-img-nobudget')
    const out = await ctx.handlers.get('agent/pre-step')({ agent, signal, step: 1, turn: 1, messages: [human()] }, enter)
    check('图片插件不在场 ⇒ 不触发（安全退化）', injectedText(out), '')
  }

  // ── ⑤ auto 会话：图片水位**单独**把压缩拉起来 ─────────────────────────
  {
    installImageBudget([['session-img-auto', 20], ['session-img-plain', 20]])
    const calls = []
    const commands = {
      execute: async (agent, name) => {
        calls.push({ agentId: agent?.id, name })
        return { result: { kind: 'ok', text: 'Compacted 120 history items' } }
      },
    }
    // token 只到 100（remindTokens 是 400000）⇒ 压缩只可能是图片水位触发的。
    const ctx = makeContext({ totalTokens: 100, commands })
    const plugin = await import(pluginPath)
    plugin.apply(ctx, {
      ...BASE_CONFIG,
      sessionModes: { 'session-img-auto': 'auto' },
      // 探针把手：把 1.5 秒延迟与轮询压到 1 ms，让测试秒级跑完。
      autoCompactIdleDelayMs: 1,
      autoCompactPollMs: 1,
    })
    const preStep = ctx.handlers.get('agent/pre-step')
    const feed = ctx.handlers.get('session/event')

    const autoAgent = makeAgent('session-img-auto')
    // pre-step 一次：既注册 recentAgents（压缩要用），也验证 auto 会话**不走交棒**。
    const autoDecision = await preStep({ agent: autoAgent, signal, step: 1, turn: 1, messages: [human()] }, enter)
    check('auto 会话不走交棒（不注入催写检查点）', injectedText(autoDecision), '')

    feed({ id: 'session-img-auto' }, { type: 'turn/end', time: Date.now() })
    await new Promise((resolve) => setTimeout(resolve, 120))
    check('auto 会话到图片水位 ⇒ 自动执行 /compact', calls.map((c) => c.name), ['/compact'])
    check('压缩对象是那条会话', calls.map((c) => c.agentId), ['session-img-auto'])

    // ── ⑥ 同一时刻的**未标记**会话：即使图片到水位也不自动压缩 ──────────
    //    它的处置是交棒（⑤ 上面那条路），两者是用户拍板的"二选一"。
    const plainAgent = makeAgent('session-img-plain')
    await preStep({ agent: plainAgent, signal, step: 1, turn: 1, messages: [human()] }, enter)
    feed({ id: 'session-img-plain' }, { type: 'turn/end', time: Date.now() })
    await new Promise((resolve) => setTimeout(resolve, 120))
    check('未标记会话不会被自动压缩（它的处置是交棒）', calls.map((c) => c.agentId), ['session-img-auto'])
  }
}

main().then(() => {
  const failed = results.filter((r) => !r.ok)
  for (const r of results) {
    process.stdout.write(`${r.ok ? '  PASS' : '  FAIL'}  ${r.name}\n`)
    if (!r.ok) {
      process.stdout.write(`        actual:   ${JSON.stringify(r.actual)}\n`)
      process.stdout.write(`        expected: ${JSON.stringify(r.expected)}\n`)
    }
  }
  process.stdout.write(`\nimage-watermark: ${results.length - failed.length}/${results.length} passed\n`)
  process.exitCode = failed.length === 0 ? 0 : 1
}).catch((error) => {
  process.stderr.write(`image-watermark: ${error?.stack ?? error}\n`)
  process.exitCode = 1
})
