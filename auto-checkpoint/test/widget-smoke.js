/**
 * Dev-only runtime smoke test for the auto-checkpoint widget script:
 * executes it inside a minimal DOM/localStorage/fetch shim that mimics the
 * dsh-cost-whale page environment, then verifies the panel actually mounts
 * into the fake whale menu and the poll/render path runs without throwing.
 *
 * Run: node test/widget-smoke.js
 */

import { readFile } from 'node:fs/promises'

/** One fake DOM element with just enough surface for the widget. */
function fakeElement(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    className: '',
    style: new Proxy({}, { set: () => true }),
    textContent: '',
    innerHTML: '',
    value: '',
    checked: false,
    type: '',
    min: '',
    max: '',
    step: '',
    _listeners: {},
    children: [],
    appendChild(child) {
      el.children.push(child)
      return child
    },
    addEventListener(type, fn) {
      el._listeners[type] = fn
    },
    querySelector(selector) {
      return queryIn(el, selector)
    },
  }
  return el
}

/** Match one class token: strip leading '.' and pseudo-classes. */
function classTokenMatches(className, token) {
  const cleaned = token.replace(/^\./, '').replace(/:nth-of-type\(\d+\)/g, '')
  return String(className).split(/\s+/).includes(cleaned)
}

/** Descendant search: split on spaces, walk children recursively. */
function queryIn(root, selector) {
  const parts = String(selector)
    .trim()
    .split(/\s+/)
    .filter((p) => p.length > 0)
  let scope = [root]
  for (const part of parts) {
    const nth = /:nth-of-type\((\d+)\)/.exec(part)
    const want = (nth ? Number(nth[1]) : 1)
    let matches = []
    for (const node of scope) {
      const walk = (n) => {
        for (const child of n.children || []) {
          if (classTokenMatches(child.className, part)) matches.push(child)
          walk(child)
        }
      }
      walk(node)
    }
    if (matches.length < want) return null
    scope = [matches[want - 1]]
  }
  return scope[0] ?? null
}

/** Fake document: the whale menu appears only after the first query. */
const menuBox = fakeElement('div')
let menuQueries = 0
const documentShim = {
  createElement: (tag) => fakeElement(tag),
  head: { appendChild: () => {} },
  body: { appendChild: () => {} },
  querySelector(sel) {
    menuQueries += 1
    // First boot() attempt: menu not mounted yet. From the second query on,
    // the whale menu exists — the widget's retry loop must find it.
    if (String(sel).includes('dshwv-menu') && menuQueries > 1) return menuBox
    return null
  },
  addEventListener: () => {},
}

const statePayload = {
  ok: true,
  triggerTokens: 300000,
  autoNewSession: true,
  enabled: true,
  checkpointPath: 'checkpoint.md',
  pressure: { totalTokens: 123456 },
}

globalThis.window = { __dshAutoCheckpoint: undefined }
globalThis.document = documentShim
globalThis.localStorage = {
  _store: { 'dsh.sessions.current': JSON.stringify({ sessionId: 'session-x' }) },
  getItem(key) {
    return this._store[key] ?? null
  },
  setItem(key, value) {
    this._store[key] = String(value)
  },
}
globalThis.fetch = async (url) => ({
  ok: true,
  json: async () => (String(url).includes('state') ? statePayload : statePayload),
})

const widgetJs = await readFile(new URL('../index.js', import.meta.url).pathname, 'utf8')
// Extract the widget script by invoking the plugin's builder:
const mod = await import('../index.js')
const script = mod._buildWidgetJs()

// Execute inside the shimmed globals.
const fn = new Function('window', 'document', 'localStorage', 'fetch', 'setInterval', 'setTimeout', 'clearInterval', script)
fn(
  globalThis.window,
  documentShim,
  globalThis.localStorage,
  globalThis.fetch,
  globalThis.setInterval,
  globalThis.setTimeout,
  globalThis.clearInterval,
)

// The boot() retry loop runs on an interval; give it a beat, then verify the
// panel mounted into the fake menu box.
setTimeout(() => {
  const panel = menuBox.querySelector('.ac-panel')
  const mounted = menuBox.children?.some((child) => String(child.className).includes('ac-panel'))
  if (mounted) {
    console.log(`SMOKE OK: panel mounted (${menuQueries} menu queries, menu appeared on query 2)`)
    process.exit(0)
  }
  console.error(`SMOKE FAIL: panel not mounted after retries; menu queries=${menuQueries}`)
  process.exit(1)
}, 2000)
