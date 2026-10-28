/**
 * 「压缩提醒横幅」探针（2026-10-07 新增）。
 *
 * 为什么必须有它：这次的改动**大半在前端脚本里**，而那段脚本是 `apply()` 里的一个
 * 模板字符串常量 —— `node --check index.js` **只能证明模板字符串本身没写坏，
 * 证明不了渲染出来的那份 JS 有没有语法错**。本机踩过同类坑（预算面板的
 * `els.thr` 恒为 null 导致 render 中途抛异常、后面全部静默失效）。
 *
 * 这个探针把 web 半边真跑一遍：
 *   ① 调 `/dsh-auto-checkpoint/widget.js` 路由，把返回的脚本落盘并 `node --check`；
 *   ② 调 `/dsh-auto-checkpoint/state`，断言它带回 `remindTokens`；
 *   ③ 调 POST `/dsh-auto-checkpoint/config`，断言 accept 合法值、reject 非法值。
 *
 * 跑法：node /root/4/dsh-auto-checkpoint/test/reminder-probe.mjs
 * ⚠️ 必须在 import 插件之前隔离 DSH_HOME（③ 会真写运行时配置文件）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const home = mkdtempSync(join(tmpdir(), 'reminder-home-'))
process.env.DSH_HOME = home

const { apply } = await import('../index.js')

const routes = new Map()
let tappedHtml = null
const fakeWebServer = {
  register(entry) {
    routes.set(entry.path, entry.handler)
    return () => {}
  },
  tapIndex(fn) {
    tappedHtml = fn('<html><body></body></html>')
    return () => {}
  },
}

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

const handlers = new Map()
const compactCalls = []
const noticeTexts = []
let fakePressure = 1000
// 假 execute 的返回值可切换：默认成功；⑥ 组切到"官方失败形态"（直接返回 kind:'error'，不抛）。
let fakeOutcome = { kind: 'success', text: 'Compacted 1 history items (~1 tokens).' }
const fakeCommands = {
  execute: async (agent, line) => {
    compactCalls.push({ agentId: agent?.id, line })
    return fakeOutcome
  },
}
/** 记下插件注入给用户的通知正文（降级说明走这条路）。 */
const fakeController = {
  prompt: async (req) => { noticeTexts.push(req?.content?.[0]?.text ?? '') },
}
const ctx = new Proxy({}, {
  get(_t, key) {
    if (key === 'on') return (name, fn) => { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(fn) }
    if (key === 'logger') return { info() {}, warn() {}, error() {}, debug() {} }
    if (key === 'tokenMeter') return { measure: () => ({ totalTokens: fakePressure }) }
    if (key === 'get') {
      return (name) => {
        if (name === 'commands') return fakeCommands
        if (name === 'sessionController') return fakeController
        return undefined
      }
    }
    if (key === 'inject') return (_deps, cb) => cb({ webServer: fakeWebServer })
    if (key === 'effect') return (fn) => { try { fn() } catch {} }
    return magic()
  },
})

// 冷却调成 300ms、空闲延迟调成 20ms（默认分别是 10 分钟 / 1.5 秒）：
// ⑤ 组的"冷却期内不重复"仍在窗口内（它只等 150ms），⑥ 组则等得到冷却过去再失败第二次。
apply(ctx, { autoCompactCooldownMs: 300, autoCompactIdleDelayMs: 20, autoCompactPollMs: 10 })

let failures = 0
function check(label, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) failures += 1
}

/**
 * 「压缩前落档」这一关的现场（2026-10-09 加）。
 *
 * 🛑 为什么必须走这个 helper：插件现在的顺序是
 *   **压力超了 → 先催模型写 `precompact-<sid>.md` → 这一轮不压**；
 *   **写完之后的下一轮 `turn/end` → 才真压**。
 * 所以"一条 turn/end 就压下去了"的旧断言全都不再成立 —— 这不是回归，
 * 而是这次改动的**意图**（拿一轮 token 换一份救压缩后自己的档）。
 *
 * 参数 `times` 是给组 ⑦ 用的：那里判空闲靠 `event.time` 比较，
 * 两次 turn/end 必须带**递增**的时间戳，否则会被当成同一时刻。
 */
async function preflightThenTurnEnd(emit, session, times = {}) {
  const rel = `precompact-${String(session.id).replace(/^session-/, '').slice(0, 8)}.md`
  emit(session, { type: 'turn/end', ...(times.first !== undefined ? { time: times.first } : {}) })
  await new Promise((r) => setTimeout(r, 90))
  // 模拟模型把档写下来 —— mtime 必须晚于插件催的那一下，`freshPreflightSize` 才认账。
  writeFileSync(
    join(home, rel),
    '# 压缩前落档（探针自造）\n\n## 我读过哪些文档\n- 探针路径，用于验证"写完才压"这一关\n',
  )
  emit(session, { type: 'turn/end', ...(times.second !== undefined ? { time: times.second } : {}) })
  await new Promise((r) => setTimeout(r, 170))
}

function makeRes() {
  const res = { code: 0, headers: {}, body: '' }
  res.statusCode = 200
  res.setHeader = (k, v) => { res.headers[String(k).toLowerCase()] = v }
  res.end = (chunk) => { if (chunk !== undefined && chunk !== null) res.body += String(chunk) }
  return res
}
const getReq = (url) => ({ url, method: 'GET' })
const postReq = (url, body) => ({
  url,
  method: 'POST',
  on(event, fn) {
    if (event === 'data') fn(JSON.stringify(body))
    if (event === 'end') fn()
    return this
  },
})

const widgetRoute = routes.get('/dsh-auto-checkpoint/widget.js')
const stateRoute = routes.get('/dsh-auto-checkpoint/state')
const configRoute = routes.get('/dsh-auto-checkpoint/config')
check('① 三条路由都注册了（widget / state / config）',
  typeof widgetRoute === 'function' && typeof stateRoute === 'function' && typeof configRoute === 'function')
check('① 首页注入的 tag 指向本插件', typeof tappedHtml === 'string' && tappedHtml.includes('/dsh-auto-checkpoint/widget.js'))

// ① 前端脚本：取回、落盘、真做一次语法检查
{
  const res = makeRes()
  await widgetRoute(getReq('/dsh-auto-checkpoint/widget.js'), res)
  const script = res.body
  check('① widget.js 有内容', script.length > 2000)
  check('① 含横幅代码（ac-banner）', script.includes('ac-banner'))
  check('① 含提醒阈值交互（remindTokens）', script.includes('remindTokens'))
  check('① 不含未转义的反引号', !script.includes('`'))
  const file = join(home, 'widget.check.js')
  writeFileSync(file, script, 'utf8')
  let ok = true
  let detail = ''
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  } catch (error) {
    ok = false
    detail = String(error.stderr ?? error.message).slice(0, 400)
  }
  check('① widget.js 真做语法检查通过', ok)
  if (!ok) console.error(detail)
}

// ② state 路由带回 remindTokens
{
  const res = makeRes()
  await stateRoute(getReq('/dsh-auto-checkpoint/state?sessionId=session-probe'), res)
  let body = {}
  try { body = JSON.parse(res.body) } catch {}
  check('② state 返回 200 且是 JSON', res.statusCode === 200 && body.ok === true)
  check('② state 带 remindTokens 且默认 400000', body.remindTokens === 400000)
  check('② state 仍带原有字段（triggerTokens / pressure）',
    Object.prototype.hasOwnProperty.call(body, 'triggerTokens') && Object.prototype.hasOwnProperty.call(body, 'pressure'))
}

// ③ POST /config：接受合法值、拒绝非法值
{
  const res1 = makeRes()
  await configRoute(postReq('/dsh-auto-checkpoint/config', { remindTokens: 500000 }), res1)
  const res2 = makeRes()
  await stateRoute(getReq('/dsh-auto-checkpoint/state'), res2)
  let body2 = {}
  try { body2 = JSON.parse(res2.body) } catch {}
  check('③ 合法值 500000 被接受并生效', res1.statusCode === 200 && body2.remindTokens === 500000)

  const res3 = makeRes()
  await configRoute(postReq('/dsh-auto-checkpoint/config', { remindTokens: -1 }), res3)
  check('③ 非法值 -1 被拒绝（400）', res3.statusCode === 400)

  const res4 = makeRes()
  await configRoute(postReq('/dsh-auto-checkpoint/config', { remindTokens: 0 }), res4)
  const res5 = makeRes()
  await stateRoute(getReq('/dsh-auto-checkpoint/state'), res5)
  let body5 = {}
  try { body5 = JSON.parse(res5.body) } catch {}
  check('③ 0 被接受（表示关闭提醒）', res4.statusCode === 200 && body5.remindTokens === 0)
}

// ④ 按会话模式：设置 / 读取 / 清除 / 非法值 / 自检字段
{
  const r1 = makeRes()
  await configRoute(postReq('/dsh-auto-checkpoint/config', { sessionId: 'session-probe', sessionMode: 'remind' }), r1)
  const r2 = makeRes()
  await stateRoute(getReq('/dsh-auto-checkpoint/state?sessionId=session-probe'), r2)
  let b2 = {}
  try { b2 = JSON.parse(r2.body) } catch {}
  check('④ 设为 remind 后 state 读得到', r1.statusCode === 200 && b2.sessionMode === 'remind')

  const r3 = makeRes()
  await stateRoute(getReq('/dsh-auto-checkpoint/state?sessionId=session-other'), r3)
  let b3 = {}
  try { b3 = JSON.parse(r3.body) } catch {}
  check('④ 没标记的会话 sessionMode = null（默认全关）', b3.sessionMode === null)

  const r4 = makeRes()
  await configRoute(postReq('/dsh-auto-checkpoint/config', { sessionId: 'session-probe', sessionMode: null }), r4)
  const r5 = makeRes()
  await stateRoute(getReq('/dsh-auto-checkpoint/state?sessionId=session-probe'), r5)
  let b5 = {}
  try { b5 = JSON.parse(r5.body) } catch {}
  check('④ 传 null 能清除标记', r4.statusCode === 200 && b5.sessionMode === null)

  const r6 = makeRes()
  await configRoute(postReq('/dsh-auto-checkpoint/config', { sessionId: 'session-probe', sessionMode: 'nonsense' }), r6)
  check('④ 非法模式被拒绝（400）', r6.statusCode === 400)

  const r7 = makeRes()
  await configRoute(postReq('/dsh-auto-checkpoint/config', { sessionMode: 'remind' }), r7)
  check('④ 缺 sessionId 被拒绝（400）', r7.statusCode === 400)

  const r8 = makeRes()
  await stateRoute(getReq('/dsh-auto-checkpoint/state'), r8)
  let b8 = {}
  try { b8 = JSON.parse(r8.body) } catch {}
  check('④ 自检字段 canCompact = true（插件真能执行 /compact）', b8.canCompact === true)
}

// ⑤ 到阈值自动压缩：**并且只在该会话「停下来」之后压**
//    🛑 这一组钉的是 2026-10-07 那个致命时机 bug：pre-step 里 agent 正忙，
//    当场调 `/compact` 必被 compaction 的准入检查拒（`busy` →
//    "the agent is not idle"）。真机证据：session-8ec526d7 的 seq 1764 / 1786。
{
  const preStep = handlers.get('agent/pre-step')?.[0]
  const onEvent = handlers.get('session/event')?.[0]
  check('⑤ 注册了 agent/pre-step 与 session/event',
    typeof preStep === 'function' && typeof onEvent === 'function')
  // ⚠️ ③ 的最后一步把 remindTokens 设成了 0（表示关闭），这里必须先恢复 ——
  //    否则自动压缩的阈值判定（threshold > 0）永远不成立，本组会整片假失败。
  const r0 = makeRes()
  await configRoute(postReq('/dsh-auto-checkpoint/config', { remindTokens: 400000 }), r0)
  const r1 = makeRes()
  await configRoute(postReq('/dsh-auto-checkpoint/config', { sessionId: 'session-auto', sessionMode: 'auto' }), r1)
  check('⑤ 标记 auto 成功（200）', r1.statusCode === 200)
  const base = { header: { cwd: home }, seq: 0, eventAt: () => undefined }
  const session = { ...base, id: 'session-auto' }
  const agent = { id: 'session-auto', session }
  const run = (a) => preStep(
    { agent: a, step: 1, signal: { aborted: false }, messages: [] },
    async () => ({ kind: 'pass', messages: [] }),
  )
  const turnEnd = (s) => onEvent(s, { type: 'turn/end' })

  fakePressure = 500
  await run(agent)
  turnEnd(session)
  await new Promise((r) => setTimeout(r, 120))
  check('⑤ 压力低于阈值时不触发', compactCalls.length === 0)

  fakePressure = 900000
  await run(agent)
  await new Promise((r) => setTimeout(r, 60))
  check('⑤ pre-step 当场**不**压（那正是实测失败的时机）', compactCalls.length === 0)

  await preflightThenTurnEnd(onEvent, session)
  check('⑤ turn/end 之后调了一次 /compact', compactCalls.length === 1 && compactCalls[0].line === '/compact')
  check('⑤ 调的是这个会话的 agent', compactCalls[0]?.agentId === 'session-auto')
  check('⑤ 压缩前先催过一次落档（2026-10-09 新增行为）',
    noticeTexts.some((t) => typeof t === 'string' && t.includes('即将压缩') && t.includes('我读过哪些文档')))

  await preflightThenTurnEnd(onEvent, session)
  check('⑤ 冷却期内不重复触发（失败不会被无限重试）', compactCalls.length === 1)

  const other = { id: 'session-plain', session: { ...base, id: 'session-plain' } }
  await run(other)
  turnEnd(other.session)
  await new Promise((r) => setTimeout(r, 150))
  check('⑤ 没标记的会话压力再高也不动（默认全关）', compactCalls.length === 1)
}

// ⑥ 保险（2026-10-07 加）：压缩「失败」必须被认出来，连续 2 次就降级为 remind。
//    🛑 这组的存在理由：官方 `executeCompact` 把预期失败转成 `{kind:'error', text}`
//    **直接返回、不抛异常**（`@deepseek-ai/dsh-command-compact` 的 expectedFailure）。
//    只写 catch 的版本会把"压缩失败"记成"压缩成功"，保险永远不触发 —— 这组就是钉住这个判据。
{
  const preStep = handlers.get('agent/pre-step')?.[0]
  const base = { header: { cwd: home }, seq: 0, eventAt: () => undefined }
  const agent = { id: 'session-flaky', session: { ...base, id: 'session-flaky' } }
  const run = (a) => preStep(
    { agent: a, step: 1, signal: { aborted: false }, messages: [] },
    async () => ({ kind: 'pass', messages: [] }),
  )
  const modeOf = async (id) => {
    const res = makeRes()
    await stateRoute(getReq(`/dsh-auto-checkpoint/state?sessionId=${id}`), res)
    try { return JSON.parse(res.body).sessionMode } catch { return '<parse error>' }
  }
  // 压缩只在 turn/end 之后发生（pre-step 只负责登记 agent）
  const onEvent = handlers.get('session/event')[0]
  const turnEnd = (s) => onEvent(s, { type: 'turn/end' })

  const r0 = makeRes()
  await configRoute(postReq('/dsh-auto-checkpoint/config', { sessionId: 'session-flaky', sessionMode: 'auto' }), r0)
  check('⑥ 标记 auto 成功（200）', r0.statusCode === 200)

  const before = compactCalls.length
  fakeOutcome = {
    commandId: 'c-flaky',
    result: { kind: 'error', text: 'prompt is too long: 100001 tokens > 100000 maximum' },
  }
  await run(agent)
  await preflightThenTurnEnd(onEvent, agent.session)
  check('⑥ 第 1 次失败：真的压了一次', compactCalls.length === before + 1)
  check('⑥ 第 1 次失败后仍是 auto（一次失败不放弃）', (await modeOf('session-flaky')) === 'auto')

  // 等过冷却（300ms）再失败一次 ⇒ 应当降级
  await new Promise((r) => setTimeout(r, 350))
  await run(agent)
  await preflightThenTurnEnd(onEvent, agent.session)
  check('⑥ 第 2 次失败：又压了一次', compactCalls.length === before + 2)
  check('⑥ 第 2 次失败 ⇒ 自动降级为 remind（不会再自动重试）',
    (await modeOf('session-flaky')) === 'remind')
  check('⑥ 降级时给用户的说明里带了失败原文',
    noticeTexts.some((t) => typeof t === 'string' && t.includes('prompt is too long')))
  check('⑥ 说明里写清"已停手、改回只提醒"',
    noticeTexts.some((t) => typeof t === 'string' && t.includes('只提醒')))

  // 降级之后：压力仍超阈值也不许再调 —— 这才是"真停手"
  await new Promise((r) => setTimeout(r, 350))
  await run(agent)
  await preflightThenTurnEnd(onEvent, agent.session)
  check('⑥ 降级后压力再高也不动（真停手）', compactCalls.length === before + 2)

  // 恢复成功形态，别把后面的用例带坏
  fakeOutcome = { kind: 'success', text: 'Compacted 1 history items (~1 tokens).' }
}

// ⑦ 空闲窗口轮询（2026-10-08 加，A+B 里的 **B**）。
//    🛑 存在理由（`session-a63ff73e`，用户报"到阈值了也不压缩"）：那条会话开着 goal 模式，
//    `turn/end` 之后 **16 毫秒**就冒出新的 `turn/start`（goal 自动续跑）⇒ agent 从不空闲，
//    v2 的"等 1.5 秒试一次"必然撞 `busy`；而失败又把 10 分钟冷却写上了 ⇒ 之后两次 turn/end
//    连试都没试。这组钉住三件事：
//    ① 自动续跑期间**一次都不试**（不刷日志、不白撞 busy）；
//    ② 真静下来（turn/end 之后没有新 turn/start）时**必须压上** —— 这才是"必然能修"的那一半；
//    ③ A 部分：`busy` 是**本地准入拒绝**（连上游请求都没发）⇒ 不许计入失败数。
{
  const preStep = handlers.get('agent/pre-step')?.[0]
  const onEvent = handlers.get('session/event')?.[0]
  const base = { header: { cwd: home }, seq: 0, eventAt: () => undefined }
  const session = { ...base, id: 'session-goal' }
  const agent = { id: 'session-goal', session }
  const run = (a) => preStep(
    { agent: a, step: 1, signal: { aborted: false }, messages: [] },
    async () => ({ kind: 'pass', messages: [] }),
  )

  const modeOf = async (id) => {
    const res = makeRes()
    await stateRoute(getReq(`/dsh-auto-checkpoint/state?sessionId=${id}`), res)
    try { return JSON.parse(res.body).sessionMode } catch { return '<parse error>' }
  }

  await configRoute(
    postReq('/dsh-auto-checkpoint/config', { sessionId: 'session-goal', sessionMode: 'auto' }),
    makeRes(),
  )
  await run(agent) // 登记 agent（`recentAgents`）——`session/event` 只给 session、不给 agent
  fakePressure = 900000
  const before = compactCalls.length

  // ── goal 续跑：turn/end 之后**立刻**来一个新 turn/start（真实间隔只有 16ms，
  //    所以必须赶在 idleDelay(20ms) 之前发出去，否则测的是另一个场景）
  const t0 = Date.now()
  onEvent(session, { type: 'turn/end', time: t0 })
  await new Promise((r) => setTimeout(r, 5))
  onEvent(session, { type: 'turn/start', time: t0 + 5 })
  await new Promise((r) => setTimeout(r, 200))
  check('⑦ goal 续跑期间一次都不试（不刷日志、不白撞 busy）', compactCalls.length === before)

  // 等这一轮等到放弃（maxWait = pollMs × 150 = 1.5 秒）退出后再来
  await new Promise((r) => setTimeout(r, 1600))
  check('⑦ 续跑期间直到超时放弃，全程一次没试', compactCalls.length === before)

  // ── goal 停下来了：新的一次 turn/end，之后再没有 turn/start
  //     ⚠️ 会先催一次落档（helper 负责把那份文件补上），所以这一步现在是"催完再压"，
  //        两条 turn/end 的时间戳必须递增，否则会被 `lastTurnStartMs` 判成同一时刻。
  const t2 = Date.now()
  await preflightThenTurnEnd(onEvent, session, { first: t2, second: t2 + 50 })
  check('⑦ goal 停下后 ⇒ 真的压了（"必然能修"的那一半）', compactCalls.length === before + 1)

  // ── A 部分：busy 不许计入失败数
  fakeOutcome = {
    kind: 'error',
    text: 'Compaction is unavailable because this process has an active compaction, or the agent is not idle.',
  }
  for (let i = 0; i < 2; i += 1) {
    await new Promise((r) => setTimeout(r, 350))
    onEvent(session, { type: 'turn/end', time: Date.now() })
    await new Promise((r) => setTimeout(r, 150))
  }
  check('⑦ 连吃两次 busy 仍是 auto（本地拒绝 ≠ 压缩失败，不许冤枉降级）',
    (await modeOf('session-goal')) === 'auto')
  check('⑦ busy 之后确实又试过（说明没被 10 分钟冷却挡死）', compactCalls.length > before + 1)

  fakeOutcome = { kind: 'success', text: 'Compacted 1 history items (~1 tokens).' }
}

// ⑧ 落档也要过 opt-in 门（2026-10-09 第二次改，用户拍板 B）。
//    🛑 存在理由：`valveFired` 会**跳过 `sessionModes` 门**（阀掐断后要立刻压，见 `isValveAbort`），
//    于是**未标记的会话**也会一路走到落档那一段。而用户的设计原则是
//    「默认全关、只干**手动标记过**的会话」—— 落档不该是例外。
//    这组钉住两件事：
//      ① 未标记 + 阀开火 ⇒ **不催落档**，直接压（阀的逻辑不能被落档挡住）；
//      ② 标记 auto + 阀开火 ⇒ **先催落档**，这一轮不压。
{
  const preStep = handlers.get('agent/pre-step')?.[0]
  const onEvent = handlers.get('session/event')?.[0]
  const base = { header: { cwd: home }, seq: 0, eventAt: () => undefined }
  // 复刻 `isValveAbort` 的判据：`reason.kind === 'aborted'` + 内层 hook 带 `loop-valve`。
  const valveEvent = () => ({
    type: 'turn/end',
    time: Date.now(),
    data: { reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'loop-valve: probe' } } },
  })
  const run = (a) => preStep(
    { agent: a, step: 1, signal: { aborted: false }, messages: [] },
    async () => ({ kind: 'pass', messages: [] }),
  )

  // ── ① 未标记的会话：阀开火应当**直接压**，且不催落档
  const plain = { ...base, id: 'session-valve-plain' }
  await run({ id: 'session-valve-plain', session: plain })
  fakePressure = 900000
  const noticeBefore = noticeTexts.length
  const callBefore = compactCalls.length
  onEvent(plain, valveEvent())
  await new Promise((r) => setTimeout(r, 200))
  check('⑧ 未标记 + 阀开火 ⇒ 没催落档（默认全关，不该被打扰）',
    noticeTexts.length === noticeBefore)
  check('⑧ 未标记 + 阀开火 ⇒ 直接压了（阀的逻辑没被落档挡住）',
    compactCalls.length === callBefore + 1)

  // ── ② 标记 auto 的会话：阀开火也要**先催落档**，这一轮不压
  await configRoute(
    postReq('/dsh-auto-checkpoint/config', { sessionId: 'session-valve-optin', sessionMode: 'auto' }),
    makeRes(),
  )
  const opt = { ...base, id: 'session-valve-optin' }
  await run({ id: 'session-valve-optin', session: opt })
  const notice2 = noticeTexts.length
  const call2 = compactCalls.length
  onEvent(opt, valveEvent())
  await new Promise((r) => setTimeout(r, 200))
  check('⑧ 标记 auto + 阀开火 ⇒ 先催落档（不抢在落档之前压）',
    noticeTexts.length === notice2 + 1)
  check('⑧ 标记 auto + 阀开火 ⇒ 这一轮没压（等档写完）',
    compactCalls.length === call2)
}

rmSync(home, { recursive: true, force: true })
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)