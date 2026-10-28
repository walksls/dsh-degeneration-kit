/**
 * 运行时配置回归测试：`taskBoundaryTokens` 可调（2026-09-21 新增）。
 *
 * 用户要求："任务边界触发最好改成可以让我手动调整的阈值，
 * 不然 150k 有时候还是太小了，活都没干两轮呢就触发了。"
 *
 * 所以这条链路必须通：
 *   面板滑块 → POST /dsh-auto-checkpoint/config → runtime → 落盘
 *   → 重启后 loadRuntimeFile 读回 → 触发判定用新值
 *
 * 本测试**不启 HTTP、不用模型**：直接验证
 *   ① `$DSH_HOME/auto-checkpoint.json` 里的 taskBoundaryTokens 会被读回并生效
 *   ② 缺字段时回落到编译期默认值（150k）
 *   ③ 0 表示关闭（而不是"永远触发"）
 *
 * 用法：node test/runtime-config.test.mjs [pluginIndexPath]
 */

import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginPath = resolve(process.argv[2] ?? join(here, '..', 'index.js'))

const home = await mkdtemp(join(tmpdir(), 'cp-runtime-cfg-home-'))
process.env.DSH_HOME = home

const results = []
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ name, ok, actual, expected })
  return ok
}

function makeContext({ totalTokens }) {
  const handlers = new Map()
  return {
    handlers,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    on(n, h) { handlers.set(n, h) },
    inject() {},
    effect(f) { const d = f(); return () => d?.() },
    tokenMeter: { measure: () => ({ totalTokens }) },
    get() { return undefined },
  }
}

const todoEvent = (todos) => ({ type: 'todo/write', data: { todos } })
const todo = (status) => ({ content: 'x', status })
const signal = { aborted: false }
const enter = async () => ({ kind: 'enter', messages: [] })

let caseSeq = 0
/**
 * 跑一次 pre-step。
 * @param boundaryTokens 写进运行时文件的 taskBoundaryTokens（undefined = 不写该字段）
 */
async function run({ totalTokens, boundaryTokens, events }) {
  caseSeq += 1
  const cfg = { triggerTokens: 300_000, autoNewSession: false }
  if (boundaryTokens !== undefined) cfg.taskBoundaryTokens = boundaryTokens
  await writeFile(join(home, 'auto-checkpoint.json'), JSON.stringify(cfg), 'utf8')

  const ctx = makeContext({ totalTokens })
  const plugin = await import(`${pluginPath}?rt=${caseSeq}`)
  plugin.apply(ctx, { triggerTokens: 300_000, autoNewSession: false })
  const preStep = ctx.handlers.get('agent/pre-step')
  // 插件异步 loadRuntimeFile；让出一轮事件循环再调用
  await new Promise((r) => setTimeout(r, 30))
  const agent = {
    id: `ag${caseSeq}`,
    session: {
      id: `session-rt${String(caseSeq).padStart(4, '0')}`,
      header: { cwd: '/tmp' },
      seq: events.length,
      eventAt: (i) => events[i],
    },
  }
  return preStep({ agent, signal, step: 1, turn: 1, messages: [] }, enter)
}

// ⚠️ 2026-10-11 修：原断言只认旧结构 `source.plugin`，而插件早已按 AGENTS §十七.4 改成
// v4 形态 `source.kind = 'plugin:<name>'`（index.js:2500）⇒ 断言恒 false，"要触发"的用例假红。
const asked = (d, name) =>
  (d?.messages ?? []).some(
    (m) =>
      (m.source?.kind === 'plugin' && m.source?.plugin === name) ||
      m.source?.kind === `plugin:${name}` ||
      (m.source?.sections ?? []).some((s) => s?.name === name),
  )
const boundaryEvents = [todoEvent([todo('in_progress')]), todoEvent([todo('completed')])]

async function main() {
  const plugin = await import(`${pluginPath}?rtname=1`)

  // ① 运行时文件把边界调高 → 160k 不该触发
  {
    const d = await run({ totalTokens: 160_000, boundaryTokens: 500_000, events: boundaryEvents })
    check('运行时 taskBoundaryTokens=500k → 160k 不触发', asked(d, plugin.name), false)
  }

  // ② 运行时文件把边界调低 → 160k 该触发
  {
    const d = await run({ totalTokens: 160_000, boundaryTokens: 100_000, events: boundaryEvents })
    check('运行时 taskBoundaryTokens=100k → 160k 触发', asked(d, plugin.name), true)
  }

  // ③ 运行时文件写 0 → 关闭任务边界（退回纯阈值）
  {
    const d = await run({ totalTokens: 160_000, boundaryTokens: 0, events: boundaryEvents })
    check('运行时 taskBoundaryTokens=0 → 边界不触发', asked(d, plugin.name), false)
  }
  {
    // 0 关闭的是"边界"，不能把压力阈值也关掉
    const d = await run({ totalTokens: 400_000, boundaryTokens: 0, events: [todoEvent([])] })
    check('运行时 taskBoundaryTokens=0 时压力阈值仍触发', asked(d, plugin.name), true)
  }

  // ④ 运行时文件没写该字段 → 回落到编译期默认 150k
  {
    const d = await run({ totalTokens: 160_000, boundaryTokens: undefined, events: boundaryEvents })
    check('运行时文件缺字段 → 回落默认 150k（160k 触发）', asked(d, plugin.name), true)
  }
  {
    const d = await run({ totalTokens: 120_000, boundaryTokens: undefined, events: boundaryEvents })
    check('运行时文件缺字段 → 120k < 150k 不触发', asked(d, plugin.name), false)
  }

  /**
   * ⑤ 往返：真的走一次 POST /dsh-auto-checkpoint/config（面板就调它），
   *    然后确认落盘的文件读回后能生效。
   *
   *    ⚠️ 必须真的走插件的路由处理器，不能自己手写文件 ——
   *       我前两版都是手写文件再断言，那测的是我的测试，不是插件。
   *       这一版给 `ctx.inject(['webServer'], cb)` 传一个假 webServer，
   *       捕获路由表，然后直接调 POST 处理器（等价于面板拖滑块）。
   */
  {
    caseSeq += 1
    const routes = new Map()
    // 插件用 webServer.register({kind,path,handler})，不是 route()
    const fakeWebServer = {
      register(entry) { routes.set(entry.path, entry.handler); return () => {} },
      tapIndex() { return () => {} },
    }
    const handlers = new Map()
    const ctx = {
      handlers,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      on(n, h) { handlers.set(n, h) },
      // 插件调 inject(['webServer'], cb) 时要真的回调，才能拿到路由
      inject(names, cb) {
        if (names.includes('webServer')) cb({ webServer: fakeWebServer })
      },
      effect(f) { const d = f(); return () => d?.() },
      tokenMeter: { measure: () => ({ totalTokens: 10_000 }) },
      get() { return undefined },
    }
    const p = await import(`${pluginPath}?rt=${caseSeq}`)
    p.apply(ctx, { triggerTokens: 300_000, autoNewSession: false })
    const post = routes.get('/dsh-auto-checkpoint/config')
    check('POST /dsh-auto-checkpoint/config 路由已注册', typeof post, 'function')

    if (typeof post === 'function') {
      // 直接调处理器：模拟面板提交 taskBoundaryTokens=234000
      const req = {
        method: 'POST',
        url: '/dsh-auto-checkpoint/config',
        on(event, cb) {
          if (event === 'data') cb(Buffer.from(JSON.stringify({ taskBoundaryTokens: 234_000 })))
          if (event === 'end') cb()
          return req
        },
      }
      let status = 0
      let body = ''
      const res = {
        set statusCode(v) { status = v },
        get statusCode() { return status },
        setHeader() {},
        end(chunk) { body = String(chunk ?? '') },
      }
      await post(req, res)
      check('POST 返回 200', status, 200)
      let parsedBody = null
      try { parsedBody = JSON.parse(body) } catch { /* ignore */ }
      check('响应里带新的 taskBoundaryTokens', parsedBody?.taskBoundaryTokens, 234_000)

      // 落盘文件必须也带上它（否则重启后设置"自己变回默认"）
      const raw = await readFile(join(home, 'auto-checkpoint.json'), 'utf8')
      const parsed = JSON.parse(raw)
      check('落盘文件里带 taskBoundaryTokens', parsed.taskBoundaryTokens, 234_000)
    }

    // 非法值要被拒（面板手输可能传负数）
    if (typeof post === 'function') {
      const req = {
        method: 'POST',
        url: '/dsh-auto-checkpoint/config',
        on(event, cb) {
          if (event === 'data') cb(Buffer.from(JSON.stringify({ taskBoundaryTokens: -5 })))
          if (event === 'end') cb()
          return req
        },
      }
      let status = 0
      const res = {
        set statusCode(v) { status = v },
        get statusCode() { return status },
        setHeader() {},
        end() {},
      }
      await post(req, res)
      check('负数被拒（400）', status, 400)
    }
  }

  /**
   * ⑥ ⭐ 启动竞态回归（2026-09-21 发现并修复的**原有 bug**）。
   *
   * 症状：`apply()` 之后**立刻** POST 改配置，改动会被异步的 loadRuntimeFile 吞掉——
   *       POST 返回旧值，磁盘也被旧值覆盖。真实场景就是"web 刚起来用户就拖滑块"。
   *
   * 根因：初版 `void loadRuntimeFile(base).then(loaded => Object.assign(runtime, loaded))`
   *       无条件覆盖 runtime。修法：加 runtimeDirty 标志，写入过就不再覆盖。
   *
   * 这条用例的价值：它**不是**新功能的测试，而是把一个既存缺陷钉死，
   * 防止以后有人"简化"掉那个 dirty 标志。
   */
  {
    caseSeq += 1
    const routes = new Map()
    const fakeWebServer = {
      register(entry) { routes.set(entry.path, entry.handler); return () => {} },
      tapIndex() { return () => {} },
    }
    const ctx = {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      on() {},
      inject(names, cb) { if (names.includes('webServer')) cb({ webServer: fakeWebServer }) },
      effect(f) { const d = f(); return () => d?.() },
      tokenMeter: { measure: () => ({ totalTokens: 10_000 }) },
      get() { return undefined },
    }
    // 预置一个旧值，模拟"上次会话留下的配置"
    await writeFile(join(home, 'auto-checkpoint.json'),
      JSON.stringify({ triggerTokens: 300_000, taskBoundaryTokens: 150_000 }), 'utf8')
    const p = await import(`${pluginPath}?race=${caseSeq}`)
    p.apply(ctx, { triggerTokens: 300_000 })
    const post = routes.get('/dsh-auto-checkpoint/config')
    // ⚠️ 关键：**立刻** POST，不给异步 load 回来的机会
    const req = {
      method: 'POST',
      url: '/dsh-auto-checkpoint/config',
      on(event, cb) {
        if (event === 'data') cb(Buffer.from(JSON.stringify({ taskBoundaryTokens: 400_000 })))
        if (event === 'end') cb()
        return req
      },
    }
    let body = ''
    const res = {
      set statusCode(_v) {}, get statusCode() { return 200 },
      setHeader() {}, end(c) { body = String(c ?? '') },
    }
    await post(req, res)
    let parsed = null
    try { parsed = JSON.parse(body) } catch { /* ignore */ }
    check('竞态：启动后立刻 POST 不被旧值吞掉', parsed?.taskBoundaryTokens, 400_000)

    // 磁盘也必须是新值
    const onDisk = JSON.parse(await readFile(join(home, 'auto-checkpoint.json'), 'utf8'))
    check('竞态：磁盘上是新值', onDisk.taskBoundaryTokens, 400_000)
  }

  const failed = results.filter((r) => !r.ok)
  for (const r of results) {
    if (r.ok) console.log(`  PASS  ${r.name}`)
    else console.log(`  FAIL  ${r.name}\n        expected ${JSON.stringify(r.expected)}\n        actual   ${JSON.stringify(r.actual)}`)
  }
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length > 0) process.exitCode = 1
}

await main()
