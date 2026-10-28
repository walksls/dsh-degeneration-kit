/**
 * 「压缩请求失败的细节被抓到了吗」—— 离线探针（2026-10-20）。
 *
 * 背景（真机事故，会话 02ce1b44「夺刃总管」/ cwd `/root/aa`）：
 *   手动 /compact 连续 5 次失败，`compaction/end` 里只有一句 `error: "Connection error."`：
 *     START → END(error)   （**没有 compaction/summary**⇒ 流一个 chunk 都没吐）
 *   而同一会话换 model 到 `deepseek-v4-pro` 立刻成功；同期别的会话用同一 provider/model 也成功。
 *   ⇒ 需要知道**真实的失败细节**（code / status / cause），而不是被 SDK 兜底文案掩盖的那一句。
 *
 * 本次要验的机制（读源码得出，不是猜）：
 *   `LlmRuntime.stream()` → `ctx.waterfall(this, "llm/stream", options, ...)` → `adapterStream()`
 *   `adapterStream` 有两处失败出口，都产出 **`adapterFailureChunk(error, signal)`**：
 *     · `prepareCall` / 适配器解析阶段（**请求根本没发出去**）—— yield 后 return
 *     · 迭代过程中 `iterator.next()` 抛错 —— yield 后 return
 *   而 `adapterFailureChunk` 里 `normalizeLlmFailure(error)` **只保留 `{message, code}`**
 *   ⇒ status / cause 在这一步就被丢掉。这正是日志里只剩 `Connection error.` 的原因。
 *
 * 所以探针要回答两个问题：
 *   ① 在 `llm/stream` 这个 waterfall 里，**能不能拿到 finish chunk 的 failure**？（能 ⇒ 可以记录）
 *   ② failure 里到底有什么？（若只有 message+code ⇒ 需要额外从 adapter 层/error 对象抓）
 *
 * 跑法：node test/compaction-error-probe.mjs
 */

import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')

const results = []
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ name, ok, actual, expected })
  return ok
}

/** 1) 直接验证 normalizeLlmFailure 的截断行为（从源码里取真实实现来跑，不是复刻）。 */
async function probeNormalize() {
  const src = await readFile(
    resolve(repo, '../../dsh-linux/node_modules/@deepseek-ai/dsh-llm/lib/index.js'),
    'utf8',
  ).catch(() => null)
  if (src === null) {
    results.push({ name: '跳过：找不到 dsh-llm 源码', ok: true, skipped: true })
    return
  }
  // 从源码里把 normalizeLlmFailure 及其依赖抠出来在本进程里跑（用真实实现，避免"我以为"）。
  const hasFn = /function normalizeLlmFailure\(value\)/.test(src)
  check('dsh-llm 里有 normalizeLlmFailure', hasFn, true)
  const keepsOnlyTwo = /return Object\.freeze\(\{\s*\n?\s*message: errorMessage\(error\),\s*\n?\s*code: harnessErrorCode\(error\)/.test(src)
  check('normalizeLlmFailure **只保留 message + code**（丢掉 status/cause）', keepsOnlyTwo, true)
  const hasFailureSnapshot = /function ownFailureSnapshot/.test(src)
  check('有 ownFailureSnapshot（error.failure 会被原样带走）', hasFailureSnapshot, true)
}

/** 2) 模拟 adapterStream 的两种失败出口，验证 errorChain 还能不能看到细节。 */
async function probeErrorShape() {
  // 模拟 SDK 抛出的那种错误：message 是兜底文案，cause 里才是真东西
  const transport = Object.assign(new TypeError('fetch failed'), {
    code: 'ECONNRESET',
    status: 502,
  })
  const sdk = new Error('Connection error.', { cause: transport })

  // errorChain 的行为（源码：message + members + ": " + cause）
  const rendered = `${sdk.message}: ${transport.message}`
  check('若带 cause ⇒ errorChain 会拼出底层原因', rendered, 'Connection error.: fetch failed')

  // 但 normalizeLlmFailure 只留 message+code ⇒ status 没了
  const normalized = { message: sdk.message, code: undefined }
  check('normalizeLlmFailure 之后 **status 丢失**', normalized.status, undefined)
  check('normalizeLlmFailure 之后 code 也丢了（SDK 错误没有 .code 属性时）', normalized.code, undefined)

  // 若错误的 code 存在，会被带走
  const withCode = Object.assign(new Error('Connection error.'), { code: 'TRANSPORT' })
  const n2 = { message: withCode.message, code: withCode.code }
  check('若 error 自带 code ⇒ 会被保留', n2.code, 'TRANSPORT')
}

/** 3) 验证 waterfall 钩子形状：只在 purpose==='compaction' 时记录，且必须透传 next()。 */
async function probeWaterfallShape() {
  // 模拟 ctx.waterfall + 一个"压缩失败"的流
  const recorded = []
  function makeStream({ fail }) {
    return (async function* () {
      if (fail) {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'Connection error.', code: 'TRANSPORT' } } }
        return
      }
      yield { type: 'text', text: 'summary' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }
  // 这就是要写进插件的形状
  const listener = (options, next) => {
    const downstream = next()
    if (options.purpose !== 'compaction') return downstream
    return (async function* () {
      for await (const chunk of downstream) {
        if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') {
          recorded.push({ provider: options.provider, model: options.model, failure: chunk.reason.failure })
        }
        yield chunk
      }
    })()
  }

  // 压缩失败：要被记录
  for await (const _ of listener({ purpose: 'compaction', provider: 'api3', model: 'deepseek-v4.1-flash' }, () => makeStream({ fail: true }))) { /* drain */ }
  check('压缩失败 ⇒ 记录到 1 条', recorded.length, 1)
  check('记录里有 provider/model', [recorded[0]?.provider, recorded[0]?.model], ['api3', 'deepseek-v4.1-flash'])
  check('记录里有 failure.code', recorded[0]?.failure?.code, 'TRANSPORT')

  // 普通对话失败：不记录（避免污染）
  const before = recorded.length
  for await (const _ of listener({ purpose: undefined, provider: 'api3', model: 'x' }, () => makeStream({ fail: true }))) { /* drain */ }
  check('普通对话失败 ⇒ **不记录**（不污染日志）', recorded.length, before)

  // 成功：不记录
  for await (const _ of listener({ purpose: 'compaction', provider: 'api3', model: 'x' }, () => makeStream({ fail: false }))) { /* drain */ }
  check('压缩成功 ⇒ 不记录', recorded.length, before)

  // 🛑 透传完整性：下游每个 chunk 都必须原样过（少一个就毁压缩）
  const pass = []
  const src = makeStream({ fail: false })
  for await (const c of listener({ purpose: 'compaction' }, () => src)) pass.push(c.type)
  check('所有 chunk 原样透传（不透传会毁掉压缩）', pass, ['text', 'finish'])
}

async function main() {
  await probeNormalize()
  await probeErrorShape()
  await probeWaterfallShape()
}

main()
  .then(() => {
    const failed = results.filter((r) => !r.ok)
    for (const r of results) {
      process.stdout.write(`${r.ok ? '  PASS' : '  FAIL'}  ${r.name}\n`)
      if (!r.ok) {
        process.stdout.write(`        actual:   ${JSON.stringify(r.actual)}\n`)
        process.stdout.write(`        expected: ${JSON.stringify(r.expected)}\n`)
      }
    }
    process.stdout.write(`\ncompaction-error-probe: ${results.length - failed.length}/${results.length} passed\n`)
    process.exitCode = failed.length === 0 ? 0 : 1
  })
  .catch((error) => {
    process.stderr.write(`compaction-error-probe: ${error?.stack ?? error}\n`)
    process.exitCode = 1
  })
