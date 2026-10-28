/**
 * 「报话插到 `next-turn` 队首」的回归测试（2026-10-11，**用户洞见**）。
 *
 * 背景：`sessionController.prompt` 只有两种投递（`dsh-api-session-controller/lib/index.js:882`）——
 * `mode:'steer'`（插 `next-step`，**打断当前回合**）与其余（`followup` = **追加 `next-turn` 队尾**）。
 * 而 **goal 回合也是队尾追加**（`dsh-goal-round-driver`）⇒ 队尾的报话要等 goal 的
 * **下一轮**跑完才轮到它（用户体感：「只有 goal 完了才能报话，黄花菜都凉了」）。
 * 修法：投递后把它 **prepend 到 `next-turn` 队首**（宿主 Inbox 公开了 `prepend`）——
 * **不打断当前回合**，但当前回合结束**下一条就是它**。
 *
 * 用法：`node test/notify-front.test.mjs [pluginIndexPath]`
 * 传旧版本（如 `index.js.bak-20261011-handoff-water-gate`）跑 ⇒ 三条用例应全红（证明它是回归测试）。
 *
 * ⚠️ 本测试要读一次真实的 `~/.dsh/spawn-token` 用于路由鉴权（AGENTS §16：**脚本内部取用，
 *    不打印、不进对话**）；读不到就 SKIP，不算失败。
 */

import { mkdtemp, readFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginPath = resolve(process.argv[2] ?? join(here, '..', 'index.js'))

const home = await mkdtemp(join(tmpdir(), 'cp-notify-home-'))
process.env.DSH_HOME = home

const results = []
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ name, ok, actual, expected })
}

/** 最小 Inbox：与宿主接口同形（`nextTurn` / `append` / `prepend` / `remove`）。 */
function makeInbox(initial = []) {
  const q = [...initial]
  const step = []
  return {
    get nextTurn() {
      return q
    },
    get nextStep() {
      return step
    },
    append(target, message) {
      if (target === 'next-step') step.push(message)
      else q.push(message)
    },
    prepend(target, message) {
      if (target === 'next-step') step.unshift(message)
      else q.unshift(message)
    },
    remove(id) {
      let i = q.findIndex((m) => m.id === id)
      if (i >= 0) {
        q.splice(i, 1)
        return true
      }
      i = step.findIndex((m) => m.id === id)
      if (i >= 0) {
        step.splice(i, 1)
        return true
      }
      return false
    },
  }
}

let seq = 0
/** 假宿主上下文：`inject(['webServer'])` **真回调**（否则拿不到路由）；`prompt` 模拟"追加队尾"。 */
function makeContext({ agent, failSteer = false }) {
  const handlers = new Map()
  const routes = new Map()
  const prompted = []
  return {
    handlers,
    routes,
    prompted,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    on(name, handler) {
      handlers.set(name, handler)
    },
    effect(fn) {
      const d = fn()
      return () => d?.()
    },
    inject(names, callback) {
      if (names.includes('webServer')) {
        callback({
          webServer: {
            register({ path, handler }) {
              routes.set(path, handler)
              return () => {}
            },
          },
        })
      }
    },
    tokenMeter: { measure: () => ({ totalTokens: 1000 }) },
    get(name) {
      if (name === 'sessionController') {
        return {
          async prompt(request) {
            // 宿主在 steer 不可用时抛这个（客户端代码里就有这个错误码）
            if (request.mode === 'steer' && failSteer) throw new Error('session/steer-unavailable')
            prompted.push(request)
            const message = { id: `prompted-${prompted.length}`, text: request.content?.[0]?.text }
            // 真实语义：`mode:'queue'` = followup = **追加 next-turn 队尾**；
            //           `mode:'steer'` = `agent.steer()` = 插 **next-step**（当前回合的下一步就认领）
            if (request.mode === 'steer') agent?.inbox?.append('next-step', message)
            else agent?.inbox?.append('next-turn', message)
          },
        }
      }
      if (name === 'agents') return { get: () => agent }
      return undefined
    },
  }
}

/** 真的走一遍 `/dsh-auto-checkpoint/notify` 的 HTTP handler（含 token 鉴权）。 */
async function callNotify(ctx, token, body) {
  seq += 1
  const plugin = await import(`${pluginPath}?notify=${seq}`)
  await plugin.apply(ctx, { triggerTokens: 300_000, autoNewSession: false })
  const handler = ctx.routes.get('/dsh-auto-checkpoint/notify')
  if (handler === undefined) throw new Error('notify 路由没注册')
  const req = {
    method: 'POST',
    headers: { 'x-spawn-token': token },
    on(event, cb) {
      if (event === 'data') cb(JSON.stringify(body))
      else if (event === 'end') cb()
      return this
    },
  }
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) {
      this.headers[k] = v
    },
    end(s) {
      this.body = s
    },
  }
  await handler(req, res)
  return { res, parsed: JSON.parse(res.body ?? 'null') }
}

async function main() {
  let token = null
  try {
    // 🛑 值不打印、不进对话（AGENTS §16）
    token = (await readFile(join(homedir(), '.dsh', 'spawn-token'), 'utf8')).trim()
  } catch {
    token = null
  }
  if (token === null || token === '') {
    console.log('  SKIP  读不到 ~/.dsh/spawn-token ⇒ 跳过（这不是失败）')
    return
  }

  // ① 目标**正在跑** ⇒ steer（插进当前回合：当前回合的下一步就认领，秒级）
  {
    const agent = { id: 'agent-n1', status: 'running', inbox: makeInbox([{ id: 'goal-r1' }]) }
    const ctx = makeContext({ agent })
    const { parsed } = await callNotify(ctx, token, { sessionId: 'session-n1', text: '重大发现：改方案' })
    check('在跑时默认走 steer', parsed, { ok: true, mode: 'steer' })
    check('消息插进 next-step（不是 next-turn）', agent.inbox.nextStep.map((m) => m.id), ['prompted-1'])
    check('next-turn 里的 goal 回合没被动', agent.inbox.nextTurn.map((m) => m.id), ['goal-r1'])
  }

  // ② 目标**空闲** ⇒ 同样走 steer（2026-10-22 定案：不猜忙闲、不降级）
  //    依据：steer 在空闲时会唤醒开新一轮，忙则插当前回合的下一步 —— 两种状态都正确。
  {
    const agent = { id: 'agent-n2', status: 'idle', inbox: makeInbox([{ id: 'goal-r1' }, { id: 'goal-r2' }]) }
    const ctx = makeContext({ agent })
    const { parsed } = await callNotify(ctx, token, { sessionId: 'session-n2', text: 'x' })
    check('空闲时也走 steer', parsed, { ok: true, mode: 'steer' })
    check('空闲时消息同样插进 next-step', agent.inbox.nextStep.map((m) => m.id), ['prompted-1'])
    check('next-turn 里排着的 goal 回合没被动', agent.inbox.nextTurn.map((m) => m.id), ['goal-r1', 'goal-r2'])
  }

  // ③ 宿主确实不支持 steer（抛 `session/steer-unavailable`）⇒ 如实报错，**不许假装成功**
  //    以前这里会悄悄降级成「排 next-turn 队首」并返回 ok:true —— 那条路在长会话里等于收不到，
  //    调用方却以为送到了。现在宁可报错，让调用方知道要换方式。
  {
    const agent = { id: 'agent-n3', status: 'running', inbox: makeInbox([{ id: 'goal-r1' }]) }
    const ctx = makeContext({ agent, failSteer: true })
    const { parsed } = await callNotify(ctx, token, { sessionId: 'session-n3', text: 'z' })
    check('steer 不可用时如实报错（不假装成功）', parsed, { ok: false, error: 'session/steer-unavailable' })
    check('不会重复塞进 next-turn', agent.inbox.nextTurn.map((m) => m.id), ['goal-r1'])
  }

  // ④ 显式 `mode:'queue'` 保持老语义：追加队尾（别把老调用方搞坏）
  {
    const agent = { id: 'agent-n4', status: 'idle', inbox: makeInbox([{ id: 'goal-r1' }]) }
    const ctx = makeContext({ agent })
    const { parsed } = await callNotify(ctx, token, { sessionId: 'session-n4', text: 'x', mode: 'queue' })
    check('queue 模式返回 queue', parsed, { ok: true, mode: 'queue' })
    check('queue 仍是队尾（老语义不变）', agent.inbox.nextTurn.map((m) => m.id), ['goal-r1', 'prompted-1'])
  }

  // ⑤ 拿不到 agent（未加载/已销毁）⇒ 走控制器统一投递，照样是 steer，不报错
  {
    const ctx = makeContext({ agent: null })
    const { parsed } = await callNotify(ctx, token, { sessionId: 'session-n5', text: 'y' })
    check('拿不到 agent 时不报错', parsed, { ok: true, mode: 'steer' })
    check('照样投递出去', ctx.prompted.length, 1)
  }

  const failed = results.filter((r) => !r.ok)
  for (const r of results) {
    if (r.ok) console.log(`  PASS  ${r.name}`)
    else
      console.log(
        `  FAIL  ${r.name}\n        expected ${JSON.stringify(r.expected)}\n        actual   ${JSON.stringify(r.actual)}`,
      )
  }
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length > 0) process.exitCode = 1
}

await main()
