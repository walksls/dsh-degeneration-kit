/**
 * precompact-nudge-probe.mjs —— 抓「压缩前落档催办」那条文案，验证 2026-10-25 的改动
 *
 * 为什么需要它：prompt-probe.mjs 只覆盖「写检查点提醒 / 催促提醒 / 接棒词」三条，
 * reminder-probe.mjs 覆盖落档**流程**但不抓**文案内容**（它自己造档、只看压没压）。
 * 而 2026-10-25 改的正是落档文案（新增 `## 🔑 这一轮定下的结论` + 第 8 项改写）。
 *
 * 做法：把**实盘那份 index.js** 装进假 ctx，真跑 apply()，让 turn/end 顶过阈值
 * ⇒ 插件走 requestPreflightNote ⇒ 截下它喂给 sessionController.prompt() 的正文。
 *
 * 不联网、不调模型、不写真实状态（DSH_HOME 隔离到临时目录）。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ⚠️ 必须在 import 插件之前设好：STATE_FILE 在模块加载时求值
const home = mkdtempSync(join(tmpdir(), 'nudge-probe-home-'))
process.env.DSH_HOME = home
mkdirSync(join(home, 'sessions'), { recursive: true })

const workspace = mkdtempSync(join(tmpdir(), 'nudge-probe-ws-'))

let plugin
try {
  plugin = await import('/root/4/dsh-auto-checkpoint/index.js')
} catch (e) {
  console.log('❌ 插件加载失败:', e.message)
  process.exit(1)
}

const captured = []          // 抓 sessionController.prompt 的每一次调用
const handlers = new Map()

function makeCtx() {
  return {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    effect() {}, inject() {}, provide() {}, set() {}, emit() {},
    get(name) {
      if (name === 'sessionController') {
        return {
          async prompt(payload) {
            captured.push(payload)
          },
        }
      }
      if (name === 'tokenMeter') {
        return { measure: () => ({ totalTokens: 999_999, inputTokens: 999_999, outputTokens: 0 }) }
      }
      if (name === 'configEditor') {
        return { configuration: () => ({}) }
      }
      return undefined
    },
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(fn)
      return () => {}
    },
    async emit(event, payload) {
      for (const fn of handlers.get(event) ?? []) await fn(payload)
    },
  }
}

const ctx = makeCtx()
try {
  await plugin.apply(ctx, { triggerTokens: 200000, taskBoundaryTokens: 0 })
} catch (e) {
  console.log('❌ apply() 失败:', e.message)
  process.exit(1)
}

// ── 造一个「压力已超阈值」的会话，走 agent/pre-step ──
const session = {
  id: 'session-TESTNUDGE-0000-0000-0000-000000000000',
  cwd: workspace,
  agentPreset: 'standard',
}
const agent = { id: session.id, session, cwd: workspace }

let stepNo = 0
for (let i = 0; i < 4; i++) {
  stepNo++
  const payload = {
    agent,
    session,
    turn: 1,
    step: stepNo,
    signal: { aborted: false },
    messages: [],
    sessionId: session.id,
    agentId: agent.id,
  }
  const fns = handlers.get('agent/pre-step') ?? []
  for (const fn of fns) {
    try {
      // 中间件链：必须传 next
      await fn(payload, async () => ({ kind: 'continue' }))
    } catch (e) {
      console.log('   (pre-step 抛错:', e.message, ')')
    }
  }
  await new Promise((r) => setTimeout(r, 120))
}
await new Promise((r) => setTimeout(r, 400))

// ── 断言 ──
console.log('抓到的 prompt 调用数:', captured.length)
let nudge = null
for (const c of captured) {
  const t = (c.content ?? []).map((x) => x.text ?? '').join('')
  if (t.includes('precompact') || t.includes('落档') || t.includes('🔑')) {
    nudge = t
    break
  }
}

if (!nudge) {
  console.log('\n⚠️ 没抓到落档催办文案 —— 探针的触发条件没对上（不是文案坏了）。')
  console.log('   已订阅事件:', [...handlers.keys()].join(', '))
  console.log('   抓到的 prompt 正文前 200 字:')
  for (const c of captured) {
    const t = (c.content ?? []).map((x) => x.text ?? '').join('')
    console.log('   ---', t.slice(0, 200).replace(/\n/g, ' | '))
  }
  rmSync(home, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
  process.exit(2)
}

console.log('\n===== 落档催办文案（实盘 index.js 渲染） =====')
console.log(nudge)
console.log('\n===== 断言 =====')
const checks = [
  ['含 🔑 这一轮定下的结论', nudge.includes('## 🔑 这一轮定下的结论')],
  ['🔑 节排在 1. 现在在做什么 之前', nudge.indexOf('## 🔑') < nudge.indexOf('## 现在在做什么')],
  ['要求 3-7 条', nudge.includes('3-7 条')],
  ['给了反例', nudge.includes('✗ 反例')],
  ['给了正例（第一人称锚）', nudge.includes('第一人称锚丢失时的缺省主语')],
  ['第 8 项改成「先写用上的 1-3 份」', nudge.includes('先写「这一轮真正用上的那 1-3 份」')],
  ['第 8 项保留备查清单', nudge.includes('备查清单')],
  ['1-9 九条齐全', [1,2,3,4,5,6,7,8,9].every((n) => nudge.includes(`\n${n}. \`## `))],
  ['仍含旧的事故教训（没删掉历史）', nudge.includes('2026-10-14 真实事故')],
  ['标题槽位是当前会话 id', nudge.includes('TESTNUDGE')],
]
let ok = true
for (const [name, pass] of checks) {
  console.log(`${pass ? '✅' : '❌'} ${name}`)
  if (!pass) ok = false
}
console.log('\n文案总长', nudge.length, '字符')

rmSync(home, { recursive: true, force: true })
rmSync(workspace, { recursive: true, force: true })
process.exit(ok ? 0 : 1)
