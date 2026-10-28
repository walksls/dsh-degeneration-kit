/**
 * prompt-probe.mjs —— 「三条提示词到底长什么样」的回归探针（dev-only，无副作用）
 *
 * ── 为什么需要它 ──
 *
 * 这个插件的三条关键文案（写检查点的提醒、未落盘时的催促提醒、接棒词）都是 index.js 的
 * **内部常量**、**没有导出**。于是：
 *   · `JSON.stringify(await import('index.js'))` 看不到它们（只得到 apply/inject/name）；
 *   · 光看源码渲染 ≠ 活进程里跑的是这版。
 * 2026-10-06 的真实事故（session-c41a9661，见 ~/.dsh/AGENTS.md §6.4）就出在这些文案上：
 * 写检查点那条说"下一棒**只读这个文件**"，接棒那条又教人只 `grep checkpoint-*.md`
 * ⇒ 接棒的 AI 连 `ls 任务单/` 都不做，把项目里早已写好的经验重新摸了 2.2 小时。
 * ⚠️ 那句话原本出现在**两个**地方（完整提醒 + 催促提醒），只改一处会漏。
 *
 * ── 它做什么 ──
 *
 * 把**实盘加载的那份 index.js** 装进假 ctx，真跑它的 `apply()`：
 *   ① 压力顶过阈值 → 调 `agent/pre-step` → 抓「写检查点提醒」；
 *   ② 不落盘、再过 remindEvery 步 → 抓「催促提醒」；
 *   ③ 在临时目录造出检查点文件 → 再调一次 → 插件走完整 handoff →
 *      抓它喂给 `sessionController.prompt()` 的「接棒词」。
 *
 * 不联网、不调模型、不写工作区。
 *
 * ── 用法 ──
 *
 *   node /root/4/dsh-auto-checkpoint/test/prompt-probe.mjs
 *   # 退出码 0 = 全部断言通过；非 0 = 文案被改坏了（要么补断言，要么改回去）
 *
 * ⚠️ 它验证的是**文案内容**，不是"活进程加载了这版"——后者认
 * `GET /dsh-auto-checkpoint/state` 的 `build` 字段（改 index.js 后**必须重启 dsh web**）。
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ⚠️ 必须在 import 插件**之前**设好：插件的 STATE_FILE = join(DSH_HOME, 'auto-checkpoint-state.json')
// 是在模块加载时求值的。不隔离的话，探针会把假的 agent 写进**正式**的隔离状态文件里
// （2026-10-06 实测踩过一次：probe-agent 真进了 ~/.dsh/auto-checkpoint-state.json）。
const SANDBOX = mkdtempSync(join(tmpdir(), 'prompt-probe-home-'))
process.env.DSH_HOME = SANDBOX

let seq = 0
const fails = []
const check = (name, ok) => { if (!ok) fails.push(name); console.log(`   ${ok ? '✓' : '✗'} ${name}`) }

/** 造一个够用的假 ctx：接住它注册的处理器，并提供 pre-step 依赖的服务。 */
function fakeCtx(captured) {
  const handlers = new Map()
  return {
    handlers,
    get: undefined,
    ctx: {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      on(event, fn) { handlers.set(event, fn); return () => {} },
      effect() {}, inject() {}, provide() {}, set() {}, emit() {},
      tokenMeter: { measure: () => ({ totalTokens: 999_999 }) },   // 顶过阈值
      get(name) {
        if (name === 'sessionController') {
          return {
            create: async () => ({ sessionId: 'prompt-probe-child' }),
            prompt: async (request) => { captured.push(request.content?.[0]?.text ?? '') },
          }
        }
        return undefined
      },
    },
  }
}

/** 起一个全新的插件实例（每个 block 都用**全新的 agent id**，避开模块级 states 串味）。 */
function mount(captured, config = {}) {
  const fresh = fakeCtx(captured)
  mod.apply(fresh.ctx, { triggerTokens: 1, taskBoundaryTokens: 0, ...config })
  return fresh.handlers.get('agent/pre-step')
}

const mod = await import(new URL('../index.js', import.meta.url))

// ── ① 写检查点提醒（首次越过阈值） ─────────────────────────────────────────
{
  const captured = []
  const preStep = mount(captured)
  const agent = { id: `probe-a-${process.pid}-${++seq}`, session: { id: `session-${process.pid}-${seq}`, header: { cwd: SANDBOX, delegationDepth: 0 } } }
  const out = await preStep(
    { turn: 1, step: 1, agent, signal: { aborted: false }, messages: [] },
    async () => ({ kind: 'ok', messages: [] }),
  )
  const text = (out?.messages ?? []).map((m) => m.content?.[0]?.text ?? '').join('\n')
  console.log('═══ ① 写检查点提醒\n')
  console.log(text || '(没有注入 —— 触发条件没满足)')
  console.log()
  check('① 真的注入了', text.length > 0)
  check('① 不再说「它只读这个文件」（那正是事故根因）', !text.includes('只读这个文件'))
  check('① 说了「接棒者默认只会读检查点」', text.includes('接棒者默认只会读检查点'))
  check('① 结构含第 8 节 `## 项目知识档案（下一棒必看）`', text.includes('## 项目知识档案（下一棒必看）'))
  check('① 结构 1~8 节首尾都在', text.includes('## 任务（不变）') && text.includes('## 环境事实'))
  // 2026-10-11 新增第 10 条：会话自己交棒（handoff.sh）—— 别只喊"请开新会话"然后停下
  check('① 第 10 条：该交棒时调 tools/handoff.sh', text.includes('tools/handoff.sh'))
  check('① 第 10 条写明了「它不会帮你 park」', text.includes('帮你 park'))
}

// ── ② 未落盘时的催促提醒（第二处「只读这个文件」就在这） ────────────────────
{
  const captured = []
  const preStep = mount(captured)
  const agent = { id: `probe-b-${process.pid}-${++seq}`, session: { id: `session-${process.pid}-${seq}`, header: { cwd: SANDBOX, delegationDepth: 0 } } }
  const call = (step) => preStep(
    { turn: 1, step, agent, signal: { aborted: false }, messages: [] },
    async () => ({ kind: 'ok', messages: [] }),
  )
  await call(1)                       // → requested（提醒已发一次）
  const out = await call(4)           // 不落盘 + 过了 remindEvery(默认3) → 催促
  const text = (out?.messages ?? []).map((m) => m.content?.[0]?.text ?? '').join('\n')
  console.log('═══ ② 催促提醒（检查点还没写）\n')
  console.log(text || '(没有注入)')
  console.log()
  check('② 催促提醒真的注入了', text.length > 0)
  check('② 催促里也不再说「接棒者只读这个文件」', !text.includes('只读这个文件'))
  check('② 催促里点了第 8 节', text.includes('项目知识档案'))
}

// ── ③ 接棒词（走完整 handoff 路径） ────────────────────────────────────────
{
  const cwd = mkdtempSync(join(tmpdir(), 'prompt-probe-cwd-'))
  const captured = []
  const preStep = mount(captured, { autoNewSession: true })
  const sid = `session-${process.pid}-${++seq}x`
  const agent = {
    id: `probe-c-${process.pid}-${seq}`,
    session: { id: sid, header: { cwd, id: sid, delegationDepth: 0 } },
    whenIdle: async () => {},
  }
  const call = (step) => preStep(
    { turn: 1, step, agent, signal: { aborted: false }, messages: [] },
    async () => ({ kind: 'ok', messages: [] }),
  )
  await call(1)                                                     // → requested
  // pathFor(): sid 去掉 'session-' 前缀后取前 8 位
  writeFileSync(join(cwd, `checkpoint-${sid.replace(/^session-/, '').slice(0, 8)}.md`), '# 假检查点\n')
  await call(2)                                                     // 文件落盘 → handoff
  await new Promise((r) => setTimeout(r, 800))                      // handoff 是 fire-and-forget
  rmSync(cwd, { recursive: true, force: true })

  const text = captured.join('\n')
  console.log('═══ ③ 接棒词\n')
  console.log(text || '(没有发出接棒词 —— handoff 没走到)')
  console.log()
  check('③ 接棒词真的发给了 sessionController.prompt', captured.length === 1)
  check('③ 旧的「重点抓这五类」已改成六类', text.includes('重点抓这六类内容'))
  check('③ 新增 ⑥ 检查点只给「状态」，经验在别处', text.includes('检查点只给「状态」'))
  check('③ 检索口径 = 整项目（--include="*.md" .）', text.includes('--include="*.md" .'))
  check('③ 点名了 c41a9661 这起事故', text.includes('session-c41a9661'))
  check('③ 新增「你翻了哪几个」这一行（漏读信号）', text.includes('你翻了哪几个'))
}

rmSync(SANDBOX, { recursive: true, force: true })

console.log()
if (fails.length) {
  console.log(`✗ ${fails.length} 项断言失败：`)
  for (const f of fails) console.log('   - ' + f)
  process.exit(1)
}
console.log('✅ 全部断言通过 —— 三条文案都是「检查点只给状态、经验在项目档案里」这一版。')
console.log('   （⚠️ 这只证明文案对；「活进程跑的是这版」认 state 接口的 build 字段。）')
