/**
 * 「压缩后自动接棒」的单元验证（2026-10-06 新增）。
 *
 * 为什么要有这个脚本：插件的改动**只有重启 web 才生效**，而重启要用户手动点
 * （见 ~/.dsh/AGENTS.md 第三节）。所以改动必须在这里先证明是对的 —— 用伪造的
 * ctx 抓住 `agent/pre-step` 的 handler，喂进构造好的会话事件，看它到底注入没注入。
 *
 * 跑法：node /root/4/dsh-auto-checkpoint/test/reanchor-pre-step.mjs
 * 期望：全部 6 项 PASS，进程退出码 0。
 *
 * ⚠️ 刻意把 DSH_HOME 指到临时目录：否则会读到真实的 `~/.dsh/auto-checkpoint.json`
 * （里面可能是 enabled:false），测试结果就跟着线上配置飘。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'reanchor-home-'))
process.env.DSH_HOME = home

const { apply } = await import('../index.js')

/** 万能桩：任何属性都能继续取、任何调用都能继续调，不会把 apply 打断。 */
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

const logs = []
const handlers = new Map()
/** 假 sessionController：记录投递进来的 payload（2026-10-07 的"以用户身份投递"主路径）。 */
const delivered = []
const sessionController = {
  prompt: async (payload) => { delivered.push(payload) },
}
const ctx = new Proxy({}, {
  get(_t, key) {
    if (key === 'on') {
      return (name, fn) => {
        if (!handlers.has(name)) handlers.set(name, [])
        handlers.get(name).push(fn)
      }
    }
    if (key === 'logger') {
      return {
        info: (m) => logs.push(['info', String(m)]),
        warn: (m) => logs.push(['warn', String(m)]),
        error: (m) => logs.push(['error', String(m)]),
        debug: () => {},
      }
    }
    if (key === 'tokenMeter') return { measure: () => ({ totalTokens: 1000 }) }
    if (key === 'get') return (name) => (name === 'sessionController' ? sessionController : undefined)
    return magic()
  },
})

apply(ctx, {})

const preStep = handlers.get('agent/pre-step')?.[0]
const sessionEvent = handlers.get('session/event')?.[0]
if (typeof preStep !== 'function' || typeof sessionEvent !== 'function') {
  console.error('FAIL: apply() 没有同时注册 agent/pre-step 与 session/event')
  rmSync(home, { recursive: true, force: true })
  process.exit(1)
}

/** 造一个只实现 seq / eventAt 的假会话 —— 与 justCompletedTask 用的是同一套接口。 */
function makeAgent(id, events) {
  const session = {
    id,
    header: { cwd: '/tmp/reanchor-project' },
    seq: events.length,
    eventAt: (i) => events[i],
  }
  return { id, session }
}

const run = (agent) => preStep(
  { agent, step: 1, signal: { aborted: false }, messages: [] },
  async () => ({ kind: 'pass', messages: [] }),
)

const injected = (out) => Array.isArray(out?.messages) && out.messages.length > 0
const textOf = (out) => JSON.stringify(out?.messages?.[0]?.content ?? [])

let failures = 0
function check(label, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) failures += 1
}

const okEnd = (id) => ({ type: 'compaction/end', data: { compactionId: id } })
const failEnd = (id) => ({ type: 'compaction/end', data: { compactionId: id, error: 'summary too big' } })

// ① 从没压过 → 不注入
{
  const out = await run(makeAgent('session-a', [{ type: 'turn/start', data: {} }, { type: 'turn/end', data: {} }]))
  check('① 无压缩事件时不注入', !injected(out))
}

// ② 刚压完（成功）→ 注入，且正文是接棒词
{
  const out = await run(makeAgent('session-b', [
    { type: 'user/message', data: {} },
    okEnd('c-1'),
    { type: 'user/message', data: { source: { kind: 'compact-checkpoint' } } },
  ]))
  const text = textOf(out)
  check('② 刚压缩成功后注入一条消息', injected(out))
  check('② 注入正文含「你刚被压缩过」', text.includes('你刚被压缩过'))
  check('② 注入正文指向检查点文件', text.includes('checkpoint-{{session}}.md') || text.includes('checkpoint'))
  check('② source.kind = plugin:auto-checkpoint', out?.messages?.[0]?.source?.kind === 'plugin:auto-checkpoint')
  check('② 注入文本与 sections 一致', out?.messages?.[0]?.source?.sections?.[0]?.text === out?.messages?.[0]?.content?.[0]?.text)
}

// ③ 同一个 compactionId 再来一步 → 不重复注入
{
  const agent = makeAgent('session-c', [{ type: 'user/message', data: {} }, okEnd('c-2')])
  const first = await run(agent)
  const second = await run(agent)
  check('③ 首次注入', injected(first))
  check('③ 同一 compactionId 不重复注入', !injected(second))
}

// ④ 最后一次压缩是**失败**的 → 不注入（没有新上下文可用）
{
  const out = await run(makeAgent('session-d', [
    okEnd('c-3-old'),
    failEnd('c-3-fail'),
  ]))
  check('④ 最后一次压缩失败时不注入', !injected(out))
}

// ⑤ 很久以前压过（超出窗口）→ 不注入（web 重启后的老会话不能被打扰）
{
  const events = [okEnd('c-4')]
  for (let i = 0; i < 30; i += 1) events.push({ type: 'tool/call', data: {} })
  const out = await run(makeAgent('session-e', events))
  check('⑤ 超出 REANCHOR_WINDOW 的老压缩不注入', !injected(out))
}

// ⑥ 会话接口不可用 → 静默不注入，绝不抛错
{
  const out = await run({ id: 'session-f', session: { id: 'session-f' } })
  check('⑥ 会话无 seq/eventAt 时不抛错且不注入', !injected(out))
}

// ⑦ 主路径：压缩成功 → 通过 sessionController 以**用户身份**投递一条（2026-10-07 改）
{
  const session = { id: 'session-g', header: { cwd: '/tmp/reanchor-project' } }
  await sessionEvent(session, okEnd('c-5'))
  await new Promise((r) => setTimeout(r, 20))
  check('⑦ 压缩成功后投递了一条消息', delivered.length === 1)
  const payload = delivered[0] ?? {}
  check('⑦ 投递对象带 sessionId', payload.sessionId === 'session-g')
  check('⑦ mode = queue', payload.mode === 'queue')
  check('⑦ rpcId 带 auto-checkpoint- 前缀（不会被当成真人消息）',
    String(payload.requestId ?? '').startsWith('auto-checkpoint-'))
  check('⑦ 正文就是接棒词', JSON.stringify(payload.content ?? []).includes('你刚被压缩过'))
}

// ⑧ 同一个 compactionId 只投递一次
{
  const session = { id: 'session-h', header: { cwd: '/tmp/reanchor-project' } }
  await sessionEvent(session, okEnd('c-6'))
  await new Promise((r) => setTimeout(r, 20))
  const before = delivered.length
  await sessionEvent(session, okEnd('c-6'))
  await new Promise((r) => setTimeout(r, 20))
  check('⑧ 同一 compactionId 不重复投递', delivered.length === before)
}

// ⑨ 压缩失败（带 error）不投递
{
  const before = delivered.length
  await sessionEvent({ id: 'session-i', header: { cwd: '/tmp' } }, failEnd('c-7'))
  await new Promise((r) => setTimeout(r, 20))
  check('⑨ 失败的压缩不投递', delivered.length === before)
}

// ⑩ 两条路径共用去重键：投递过之后，pre-step 不再重复注入
{
  const events = [okEnd('c-8'), { type: 'user/message', data: {} }]
  const session = {
    id: 'session-j',
    header: { cwd: '/tmp/reanchor-project' },
    seq: events.length,
    eventAt: (i) => events[i],
  }
  await sessionEvent(session, okEnd('c-8'))
  await new Promise((r) => setTimeout(r, 20))
  const out = await run({ id: 'session-j', session })
  check('⑩ 已投递过的压缩，pre-step 不再注入（不重复打扰）', !injected(out))
}

// ⑪ 没有 sessionController 时退化：pre-step 那条注入路径照旧生效
{
  const sessionControllerBackup = sessionController.prompt
  sessionController.prompt = undefined
  const events = [okEnd('c-9'), { type: 'user/message', data: {} }]
  const session = {
    id: 'session-k',
    header: { cwd: '/tmp/reanchor-project' },
    seq: events.length,
    eventAt: (i) => events[i],
  }
  await sessionEvent(session, okEnd('c-9'))
  await new Promise((r) => setTimeout(r, 20))
  const out = await run({ id: 'session-k', session })
  check('⑪ 无 sessionController 时 pre-step 兜底注入', injected(out))
  sessionController.prompt = sessionControllerBackup
}

console.log('\n注入日志：')
for (const [level, message] of logs.filter(([l]) => l === 'info')) console.log('  ', message)

rmSync(home, { recursive: true, force: true })
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
