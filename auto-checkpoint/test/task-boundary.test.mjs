/**
 * 任务边界触发（task-boundary trigger）的确定性回归测试。
 *
 * 背景（2026-09-21 新增）：原来只有"压力阈值"一条触发路径，
 * 交接点会落在**压力越线的随机位置**——可能正改到一半。
 * 新增第二条路径：**刚完成一个 todo 任务**（列表全 completed）且压力过
 * `taskBoundaryTokens`（默认 150k）时也触发，把交接点移到任务接缝上。
 *
 * 这个测试不需要模型、不需要启动 DSH：用假 cordis 上下文捕获插件的 hook，
 * 直接喂合成的 `agent/pre-step`，并构造带 `todo/write` 事件的假会话。
 *
 * 用法：
 *   node test/task-boundary.test.mjs [pluginIndexPath]
 *
 * 传旧版本路径可以看到新增用例全红（证明它是回归测试，不是现状描述）：
 *   node test/task-boundary.test.mjs /root/4/dsh-auto-checkpoint/index.js.bak-20260921-加任务边界触发前
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginPath = resolve(process.argv[2] ?? join(here, '..', 'index.js'))

// 运行时配置文件在 import 时解析路径；指向空目录，避免真实
// ~/.dsh/auto-checkpoint.json 覆盖本测试传入的配置。
const home = await mkdtemp(join(tmpdir(), 'cp-boundary-home-'))
process.env.DSH_HOME = home

const results = []
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ name, ok, actual, expected })
  return ok
}

/** 假会话：支持 `seq` 与 `eventAt(seq)`，用来喂 todo/write 序列。 */
function makeSession(events, id = 'session-boundary0001') {
  return {
    id,
    header: { cwd: '/tmp' },
    seq: events.length,
    eventAt: (seq) => events[seq],
  }
}

/** 假上下文：捕获 hook，提供插件读取的服务。 */
function makeContext({ totalTokens, session }) {
  const handlers = new Map()
  const injected = []
  return {
    handlers,
    injected,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    on(name, handler) { handlers.set(name, handler) },
    // 插件在 apply 里会用 inject 挂 webServer 半（面板路由）。
    // 这里只记录、不回调 —— 本测试不涉及面板。
    inject(names, callback) { injected.push({ names, callback }) },
    effect(fn) { const dispose = fn(); return () => dispose?.() },
    tokenMeter: { measure: () => ({ totalTokens }) },
    get() { return undefined },
    session,
  }
}

/** 造一个 todo/write 事件。 */
const todoEvent = (todos) => ({ type: 'todo/write', data: { todos } })
const stepEvent = () => ({ type: 'step/start', data: {} })
const todo = (status) => ({ content: 'x', status })

const signal = { aborted: false }
const enter = async () => ({ kind: 'enter', messages: [] })

/**
 * 跑一个场景：给定事件序列与压力，返回 pre-step 的决策。
 *
 * ⚠️ 每个场景都用 `?case=N` 强制**新的模块实例**。
 *    原因：插件把每个会话的 phase 存在模块级 Map 里（`states`），
 *    而 Node 的 ESM import 有缓存 —— 两次 import 同一路径会拿到**同一个**
 *    模块实例，于是前一个用例的 phase 会污染后一个用例
 *    （我第一版就这么错的：`taskBoundaryTokens=0` 那个用例因为会话 id 与
 *     前一个用例相同而读到了残留状态，明明插件是对的却报 FAIL）。
 */
let caseSeq = 0
async function run({ events, totalTokens, config = {} }) {
  const ctx = makeContext({ totalTokens, session: null })
  caseSeq += 1
  const plugin = await import(`${pluginPath}?case=${caseSeq}`)
  plugin.apply(ctx, {
    triggerTokens: 300_000,
    checkpointPath: 'checkpoint-{{session}}.md',
    autoNewSession: false,
    ...config,
  })
  const preStep = ctx.handlers.get('agent/pre-step')
  if (preStep === undefined) throw new Error('plugin did not register agent/pre-step')
  // 每个用例用**独立会话 id**，双保险
  const agent = { id: `agent-b${caseSeq}`, session: makeSession(events, `session-boundary${String(caseSeq).padStart(4, '0')}`) }
  return preStep({ agent, signal, step: 1, turn: 1, messages: [] }, enter)
}

/** 决策里有没有注入"写检查点"的请求。 */
function asked(decision, pluginName) {
  // ⚠️ 2026-10-11 修：本函数原先只认旧结构 `source.plugin`，而插件早已按 AGENTS §十七.4
  //    改成 v4 形态 `source.kind = 'plugin:<name>'`（index.js:2500）⇒ 断言恒为 false，
  //    "要触发"的用例全假红（10/13 的 3 条 FAIL 就是这么来的，与插件行为无关）。
  return (decision?.messages ?? []).some(
    (m) =>
      (m.source?.kind === 'plugin' && m.source?.plugin === pluginName) ||
      m.source?.kind === `plugin:${pluginName}` ||
      (m.source?.sections ?? []).some((s) => s?.name === pluginName),
  )
}

async function main() {
  // 只为拿插件名做断言；用独立实例避免与 run() 的实例互相影响
  const plugin = await import(`${pluginPath}?nameonly=1`)

  // ── 基线：压力不够、也没有任务边界 → 不触发 ──
  {
    const d = await run({ events: [stepEvent()], totalTokens: 10_000 })
    check('低压力 + 无任务 → 不触发', asked(d, plugin.name), false)
  }

  // ── 原有行为不能坏：压力过 triggerTokens 就触发（哪怕没有 todo）──
  {
    const d = await run({ events: [stepEvent()], totalTokens: 400_000 })
    check('压力过阈值 → 触发（原有行为）', asked(d, plugin.name), true)
  }

  // ── 新增：刚完成一个任务 + 压力过 taskBoundaryTokens → 触发 ──
  {
    const events = [
      todoEvent([todo('in_progress'), todo('pending')]),
      todoEvent([todo('completed'), todo('completed')]),   // ← 刚完成
    ]
    const d = await run({ events, totalTokens: 160_000 })
    check('任务边界（160k > 150k）→ 触发', asked(d, plugin.name), true)
  }

  // ── 任务边界但压力不够 → 不触发（水位线仍生效）──
  {
    const events = [
      todoEvent([todo('in_progress')]),
      todoEvent([todo('completed')]),
    ]
    const d = await run({ events, totalTokens: 100_000 })
    check('任务边界但 100k < 150k → 不触发', asked(d, plugin.name), false)
  }

  // ── 全部 completed，但上一次没有 in_progress（模型一次性写列表）→ 不算边界 ──
  {
    const events = [
      todoEvent([todo('completed'), todo('completed')]),
    ]
    const d = await run({ events, totalTokens: 200_000 })
    check('只有一次 todo/write 且全 completed → 不算边界', asked(d, plugin.name), false)
  }

  {
    const events = [
      todoEvent([todo('pending'), todo('pending')]),
      todoEvent([todo('completed'), todo('completed')]),
    ]
    const d = await run({ events, totalTokens: 200_000 })
    check('上一次无 in_progress（只从 pending→completed）→ 不算边界', asked(d, plugin.name), false)
  }

  // ── 还有 in_progress → 不算完成 ──
  {
    const events = [
      todoEvent([todo('in_progress'), todo('pending')]),
      todoEvent([todo('completed'), todo('in_progress')]),
    ]
    const d = await run({ events, totalTokens: 200_000 })
    check('列表里还有 in_progress → 不算边界', asked(d, plugin.name), false)
  }

  // ── 空列表 → 不算边界 ──
  {
    const events = [
      todoEvent([todo('in_progress')]),
      todoEvent([]),
    ]
    const d = await run({ events, totalTokens: 200_000 })
    check('最后一次 todo/write 是空列表 → 不算边界', asked(d, plugin.name), false)
  }

  // ── 关闭开关 → 退回纯阈值行为 ──
  {
    const events = [
      todoEvent([todo('in_progress')]),
      todoEvent([todo('completed')]),
    ]
    const d = await run({ events, totalTokens: 160_000, config: { taskBoundaryTokens: 0 } })
    check('taskBoundaryTokens=0 → 任务边界不触发', asked(d, plugin.name), false)
  }
  {
    const events = [stepEvent()]
    const d = await run({ events, totalTokens: 400_000, config: { taskBoundaryTokens: 0 } })
    check('taskBoundaryTokens=0 时压力阈值仍然触发', asked(d, plugin.name), true)
  }

  // ── 自定义水位线 ──
  {
    const events = [
      todoEvent([todo('in_progress')]),
      todoEvent([todo('completed')]),
    ]
    const d = await run({ events, totalTokens: 160_000, config: { taskBoundaryTokens: 500_000 } })
    check('自定义 500k 水位：160k 不够 → 不触发', asked(d, plugin.name), false)
  }

  // ── 🛑 回归：交棒不能被 token 水位绑架（2026-10-11 修复；会话 cd4feb96 查实，代码级）──
  //
  // 场景：压力越阈值 ⇒ 插件催写检查点（phase: watching → requested）；
  //       随后自动压缩把 token 压回阈值以下（实测 463,759 → 68,311）；
  //       但检查点**已经写好**。
  // 旧代码：`if (!overPressure && !atBoundary) return decision` 直接早退
  //        ⇒ 写好的检查点永远走不到「文件写好了吗」确认分支 ⇒ 永不交棒。
  // 新代码：`requested` 阶段不再看水位 ⇒ 读文件、确认、进交接
  //        （autoNewSession=false 时退化为 checkpoint-only 并返回 `{ kind: 'reject' }`）。
  {
    const cwd = await mkdtemp(join(tmpdir(), 'cp-water-'))
    const sid = 'session-water0001'
    // 与 index.js:1127 同一规则：去掉 `session-` 前缀取前 8 位
    const file = join(cwd, `checkpoint-${sid.replace(/^session-/, '').slice(0, 8)}.md`)
    const ctx = makeContext({ totalTokens: 400_000, session: null })
    caseSeq += 1
    const plug = await import(`${pluginPath}?case=water${caseSeq}`)
    plug.apply(ctx, {
      triggerTokens: 300_000,
      checkpointPath: 'checkpoint-{{session}}.md',
      autoNewSession: false,
    })
    const preStep = ctx.handlers.get('agent/pre-step')
    const agent = {
      id: `agent-water${caseSeq}`,
      session: { id: sid, header: { cwd }, seq: 1, eventAt: () => stepEvent() },
    }
    const d1 = await preStep({ agent, signal, step: 1, turn: 1, messages: [] }, enter)
    check('越阈值 → 催写检查点（照旧）', asked(d1, plug.name), true)

    // 模型把检查点写好了
    await writeFile(file, 'x'.repeat(200), 'utf8')

    // 水位回落（模拟自动压缩之后）—— 同一条会话、同一个插件实例
    ctx.tokenMeter = { measure: () => ({ totalTokens: 10_000 }) }
    const d2 = await preStep({ agent, signal, step: 2, turn: 2, messages: [] }, enter)
    check('水位回落后仍确认已写好的检查点 → 进交接', d2?.kind, 'reject')
  }

  // ── 安全性质：`watching` 阶段**不许**因为"磁盘上有检查点"就交棒 ──
  //    watching 的 state 没有 `askedAtMs` 锚点 ⇒ `freshCheckpointSize` 降级成 `size > 0`
  //    （index.js:1217）。若把触发点加在 watching，工作区里躺着一份旧检查点
  //    就会把**正在用**的会话交出去（web 重启后每个写过检查点的会话都会中招）。
  {
    const cwd = await mkdtemp(join(tmpdir(), 'cp-water-watch-'))
    const sid = 'session-watch0001'
    const file = join(cwd, `checkpoint-${sid.replace(/^session-/, '').slice(0, 8)}.md`)
    await writeFile(file, 'x'.repeat(200), 'utf8')
    const ctx = makeContext({ totalTokens: 10_000, session: null })
    caseSeq += 1
    const plug = await import(`${pluginPath}?case=watch${caseSeq}`)
    plug.apply(ctx, {
      triggerTokens: 300_000,
      checkpointPath: 'checkpoint-{{session}}.md',
      autoNewSession: false,
    })
    const preStep = ctx.handlers.get('agent/pre-step')
    const agent = {
      id: `agent-watch${caseSeq}`,
      session: { id: sid, header: { cwd }, seq: 1, eventAt: () => stepEvent() },
    }
    const d = await preStep({ agent, signal, step: 1, turn: 1, messages: [] }, enter)
    check('低压力 + 磁盘上有检查点 → 不交棒（watching 不认文件）', d?.kind, 'enter')
  }

  // ── 坏数据不能让门控崩（这是门控，崩了会卡住所有会话）──
  {
    const events = [todoEvent(null), { type: 'todo/write' }, todoEvent([null, { status: 42 }])]
    const d = await run({ events, totalTokens: 200_000 })
    check('todo 数据畸形 → 不崩且不触发', asked(d, plugin.name), false)
  }
  {
    // session 缺 eventAt / seq —— 老会话或假对象
    const ctx = makeContext({ totalTokens: 200_000, session: null })
    plugin.apply(ctx, { triggerTokens: 300_000, autoNewSession: false })
    const preStep = ctx.handlers.get('agent/pre-step')
    const agent = { id: 'agent-x', session: { id: 's', header: {} } }
    const d = await preStep({ agent, signal, step: 1, turn: 1, messages: [] }, enter)
    check('会话缺 seq/eventAt → 不崩且不触发', asked(d, plugin.name), false)
  }

  // ── 输出 ──
  const failed = results.filter((r) => !r.ok)
  for (const r of results) {
    if (r.ok) console.log(`  PASS  ${r.name}`)
    else console.log(`  FAIL  ${r.name}\n        expected ${JSON.stringify(r.expected)}\n        actual   ${JSON.stringify(r.actual)}`)
  }
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length > 0) process.exitCode = 1
}

await main()
