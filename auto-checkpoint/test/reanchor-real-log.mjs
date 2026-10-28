/**
 * 「压缩后自动接棒」的第二层验证：拿**真实会话日志**跑一遍（2026-10-06）。
 *
 * 上面那份 `reanchor-pre-step.mjs` 用的是手工构造的事件；这份用的是真机日志 ——
 * 真实事件的字段名、真实的 `compaction/end`、真实的 `compactionId`，用来证明
 * 「我们读的字段名跟 DSH 实际写进去的一致」，而不是自说自话。
 *
 * 跑法：
 *   zstd -dc ~/.dsh/sessions/<cwd>/<session>/session.v4.jsonl.zstd > /tmp/s.jsonl
 *   node /root/4/dsh-auto-checkpoint/test/reanchor-real-log.mjs /tmp/s.jsonl
 *
 * 判据：脚本会自己找出第一条**成功**的 `compaction/end`，把事件流截断到
 * "压缩刚结束"的那一刻（这正是 pre-step 第一次看到它的时机），然后要求
 * handler 必须注入，且注入正文里带得出那次压缩的信息。
 */
import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const file = process.argv[2]
if (!file) {
  console.error('用法: node reanchor-real-log.mjs <已解压的 session.v4.jsonl>')
  process.exit(2)
}

const home = mkdtempSync(join(tmpdir(), 'reanchor-real-home-'))
process.env.DSH_HOME = home
const { apply } = await import('../index.js')

const events = readFileSync(file, 'utf8')
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line))

// 第一条成功的压缩（没有 error 字段）
const successIdx = events.findIndex((e) => e.type === 'compaction/end' && e.data?.error === undefined)
const failIdx = events.findIndex((e) => e.type === 'compaction/end' && e.data?.error !== undefined)
if (successIdx < 0) {
  console.error('这份日志里没有成功的 compaction/end，换一份带压缩的会话日志')
  process.exit(2)
}
const cut = successIdx + 2 // 压缩结束后又过了两条事件 —— 就是 pre-step 该出发的时刻
const window = events.slice(0, cut)
console.log(`日志共 ${events.length} 条事件；成功的 compaction/end 在第 ${successIdx} 条`)
console.log(`compactionId = ${events[successIdx].data.compactionId}`)
if (failIdx >= 0) console.log(`（这份日志里还有一次失败的压缩，在第 ${failIdx} 条）`)

const logs = []
const handlers = new Map()
function magic() {
  const f = function () { return magic() }
  return new Proxy(f, {
    get(target, key) {
      if (key === 'then') return undefined
      if (key === Symbol.toPrimitive) return () => 0
      if (!(key in target)) target[key] = magic()
      return target[key]
    },
    apply() { return magic() },
  })
}
const ctx = new Proxy({}, {
  get(_t, key) {
    if (key === 'on') return (name, fn) => { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(fn) }
    if (key === 'logger') {
      return { info: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)), debug: () => {} }
    }
    if (key === 'tokenMeter') return { measure: () => ({ totalTokens: 1000 }) }
    if (key === 'get') return () => undefined
    return magic()
  },
})
apply(ctx, {})
const preStep = handlers.get('agent/pre-step')?.[0]

const session = {
  id: events[0]?.id ?? 'session-real',
  header: { cwd: events[0]?.cwd ?? process.cwd() },
  seq: window.length,
  eventAt: (i) => window[i],
}
const out = await preStep(
  { agent: { id: session.id, session }, step: 1, signal: { aborted: false }, messages: [] },
  async () => ({ kind: 'pass', messages: [] }),
)

const text = out?.messages?.[0]?.content?.[0]?.text ?? ''
const ok = out?.messages?.length === 1 && text.includes('你刚被压缩过')
console.log(`\n${ok ? 'PASS' : 'FAIL'}  真实日志截断到"刚压完"时注入了一条接棒词`)
console.log('注入正文（前 260 字）：')
console.log(text.slice(0, 260).replace(/^/gm, '  '))
console.log('\n日志行：')
for (const line of logs) console.log('  ', line)

rmSync(home, { recursive: true, force: true })
process.exit(ok ? 0 : 1)
