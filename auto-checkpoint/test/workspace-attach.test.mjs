/**
 * 「派活 / 接力的会话必须落进**工作区分组**，而不是侧边栏「未分组」」回归测试
 * （用户 2026-10-15 实报：总管派出去的会话全进未分组，379 条、一次只展开 5 条）。
 *
 * 与 `handoff-intent.test.mjs` 同一套路：假 cordis 上下文捕获 hook，不启动 DSH、不用模型。
 *
 * 用法：
 *   node test/workspace-attach.test.mjs [pluginIndexPath]
 *
 * 传旧版本路径（例如 `index.js.bak-20261015-修派活会话进未分组前`）⇒ 前 4 条全红，
 * 证明它是**回归测试**而不是现状描述。
 *
 * 判据来自上游源码（`@deepseek-ai/dsh-api-session-controller` 的 `create()`）：
 *   · `workspaceId` 与 `cwd` **只能给一个**（都给 ⇒ `gateway/bad-request`）；
 *   · **只有传了 `workspaceId`** 才会 `workspace.attachSession(sessionId)`。
 * ⇒ 拿 `create()` 的**实参**当判据：命中的工作区必须换成 `workspaceId` 且**不再带 cwd**。
 *
 * 必须锁住的七条性质：
 *   ① cwd 与已注册工作区**同一个目录** ⇒ 换成 `workspaceId`；
 *   ② 调用方给**带尾斜杠**的写法 ⇒ 照样命中（否则静默退回未分组）；
 *   ③ 调用方给**软链接**路径 ⇒ 照样命中（工作区里存的是 realpath）；
 *   ④ 路径**不在**已注册工作区里 ⇒ 原样 `{ cwd }`（不许自作主张换根目录）；
 *   ⑤ 拿不到 registry / `list()` 抛异常 ⇒ 原样 `{ cwd }`，**派活绝不挂**；
 *   ⑥ 会话自己的 preset（`agentPreset`）必须跟着一起传下去，不能被这次替换吃掉；
 *   ⑦ 命中时**不能**同时带 `cwd`（上游会拒）。
 */

import { mkdtemp, writeFile, symlink, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginPath = resolve(process.argv[2] ?? join(here, '..', 'index.js'))

// 运行时配置在 import 时解析路径；指向空目录，避免真实 ~/.dsh/auto-checkpoint.json 干扰。
const home = await mkdtemp(join(tmpdir(), 'cp-ws-home-'))
process.env.DSH_HOME = home

const results = []
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ name, ok, actual, expected })
}

let registryMode = 'normal'
let registryList = []
const warns = []

function makeContext() {
  const handlers = new Map()
  const creates = []
  return {
    handlers,
    creates,
    logger: {
      info() {},
      warn(message) { warns.push(String(message)) },
      error() {},
      debug() {},
    },
    on(name, handler) { handlers.set(name, handler) },
    inject() {},
    effect(fn) { const d = fn(); return () => d?.() },
    tokenMeter: { measure: () => ({ totalTokens: 10_000 }) },
    get(name) {
      if (name === 'workspaceRegistry') {
        if (registryMode === 'absent') return undefined
        return {
          list() {
            if (registryMode === 'throwing') throw new Error('workspace table unavailable')
            return registryList
          },
        }
      }
      if (name === 'sessionController') {
        return {
          async create(request) { creates.push(request); return { sessionId: 'session-child0001' } },
          async cancel() {},
          async prompt() {},
          async selectModel() {},
        }
      }
      if (name === 'permissionPresets') return { set() {} }
      if (name === 'agentDefaultModel') return { currentSelection: () => undefined, saveSelection: async () => {} }
      if (name === 'sessions') return { get: () => undefined }
      return undefined
    },
  }
}

const signal = { aborted: false }
const enter = async () => ({ kind: 'enter', messages: [] })
const stepEvent = () => ({ type: 'step/start', data: {} })

let seq = 0
/**
 * 一个场景：把 cwd 交给交接路径，返回 `sessionController.create()` 的实参。
 * 走的是真代码路径：压力过线 → 检查点文件存在 → 交棒 ⇒ create(workspaceRequestFor(cwd, …))。
 */
async function scenario({ cwd, extraHeader = {} }) {
  seq += 1
  const sid = `session-wsprobe${String(seq).padStart(4, '0')}`
  const short = sid.replace(/^session-/, '').slice(0, 8)
  await mkdir(cwd, { recursive: true })
  const file = join(cwd, `checkpoint-${short}.md`)

  const ctx = makeContext()
  const plugin = await import(`${pluginPath}?ws=${seq}`)
  plugin.apply(ctx, {
    triggerTokens: 1_000,
    checkpointPath: 'checkpoint-{{session}}.md',
    autoNewSession: true,
  })
  const preStep = ctx.handlers.get('agent/pre-step')
  const turnStopping = ctx.handlers.get('agent/turn-stopping')
  const agent = {
    id: `agent-wsprobe${seq}`,
    whenIdle: async () => {},
    session: { id: sid, header: { cwd, ...extraHeader }, seq: 1, eventAt: () => stepEvent() },
  }
  // ⚠️ 检查点必须**比 `askedAtMs` 新**才被认（防上一棒留下的陈旧文件误判）⇒
  //    前几轮让它"还不存在"，每轮之后再把文件写新鲜，模拟模型收到请求后落档。
  for (let round = 1; round <= 4; round += 1) {
    if (turnStopping !== undefined) await turnStopping({ agent, turn: round })
    await new Promise((r) => setTimeout(r, 200))
    await preStep({ agent, signal, step: round, turn: round, messages: [] }, enter)
    if (ctx.creates.length > 0) break
    await writeFile(file, '# 检查点\n\n随便写点东西。\n', 'utf8')
    await new Promise((r) => setTimeout(r, 60))
  }
  return { request: ctx.creates[0], warns }
}

async function main() {
  const real = await mkdtemp(join(tmpdir(), 'cp-ws-real-'))
  const other = await mkdtemp(join(tmpdir(), 'cp-ws-other-'))
  const link = `${real}-link`
  await symlink(real, link)
  const wsId = 'e69333c2-742c-4a25-aed0-cf20e01287ac'
  registryList = [{ id: wsId, path: real }]

  // ① 同一个目录 ⇒ 换成 workspaceId，且**不带 cwd**
  {
    const { request } = await scenario({ cwd: real })
    check('① 命中工作区 ⇒ workspaceId', request?.workspaceId, wsId)
    check('① 命中时不许再带 cwd（上游会给 bad-request）', 'cwd' in (request ?? {}), false)
  }

  // ② 带尾斜杠的写法 ⇒ 照样命中
  {
    const { request } = await scenario({ cwd: `${real}/` })
    check('② 尾斜杠写法 ⇒ 照样命中', request?.workspaceId, wsId)
  }

  // ③ 软链接写法 ⇒ 照样命中（realpath 归一化）
  {
    const { request } = await scenario({ cwd: link })
    check('③ 软链接写法 ⇒ 照样命中', request?.workspaceId, wsId)
  }

  // ④ 不在已注册工作区里 ⇒ 原样 cwd（不许偷偷换成工作区根目录）
  {
    const { request } = await scenario({ cwd: other })
    check('④ 未注册路径 ⇒ 原样 cwd', request, { cwd: other })
  }

  // ⑤ 拿不到 registry ⇒ 原样 cwd，不抛、不告警
  {
    registryMode = 'absent'
    const { request, warns: seen } = await scenario({ cwd: other })
    registryMode = 'normal'
    check('⑤ 无 registry ⇒ 原样 cwd', request, { cwd: other })
    check('⑤ 不抛异常（无 workspace 告警）', seen.some((w) => w.includes('workspace lookup failed')), false)
  }

  // ⑤b registry.list() 抛 ⇒ 原样 cwd ＋ 记一条告警
  {
    registryMode = 'throwing'
    const { request, warns: seen } = await scenario({ cwd: other })
    registryMode = 'normal'
    check('⑤b list() 抛 ⇒ 原样 cwd', request, { cwd: other })
    check('⑤b 抛异常时记告警', seen.some((w) => w.includes('workspace lookup failed')), true)
  }

  // ⑥ 会话自己的 preset 必须跟着传下去
  {
    const { request } = await scenario({ cwd: real, extraHeader: { agentPreset: 'we-need' } })
    check('⑥ preset 一起传下去', request?.agentPreset, 'we-need')
    check('⑥ 且仍命中工作区', request?.workspaceId, wsId)
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
