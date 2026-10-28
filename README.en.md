# DSH degeneration kit — ⚠️ **two plugins, and you need both**

**English | [中文](README.md)**

> The longer the context, the more a model spins in "I'm about to do X" loops — and the turn still looks
> **successful**, so you will not notice (measured locally: 18 of 24 real degenerate blocks ended their turn
> normally; the damage stayed inside the reasoning).
>
> This repo holds **two** plugins, each covering one half:
>
> - **produce less** — `thinking-guard`: folds a degenerate reasoning block out of the model-visible history so it
>   is not replayed every step;
> - **clear the stock** — `dsh-auto-checkpoint`: at a watermark, **compact** (clear the pollution that already
>   accumulated) or **hand off to a fresh session**.
>
> **Drop either half and something slips through** (three reasons below). One alone still beats nothing, but for
> real coverage, install both.

## What a loop looks like: two shapes, and they need different detectors

A "loop" is not one thing. We ran every `reasoning` block in **493 local session logs** through the same
measure (`ra` = highest repeat count of a single sentence inside one block), and they fall into two families:

| | **Type A · one sentence, hammered** | **Type B · short phrases rotating** |
|---|---|---|
| Repeat count | **10³–10⁴** | 20–200 |
| Context | short (29k–42k) | long, **rises monotonically with length** |
| Typical shape | `（读`×3369, `做`×1024, 「好」×**10848** | `Let me write it.` → `Go.` → `Now.` → `OK.` |
| Reads as | **normal thinking**: a subject, a next action, every sentence well-formed, zero information | **normal progress** — the hardest of the two to notice |
| How common | rare (5 Chinese blocks machine-wide) | common |
| Tied to a preset | only ever seen under the "force Chinese thinking" preset (31 other sessions: **0**) | no |

⚠️ **Two things that are easy to get backwards**:

- **"Chinese degrades more easily" is a feeling, not what our data says.** What holds is "**the worst cases are
  all Chinese**" (one to two orders of magnitude worse); by count, **the most common shape is the English
  fragment**. Memory keeps the most alarming case, not the most frequent one.
- **All 5 Chinese cases appeared under one single preset**, so we **cannot separate** "it is Chinese" from
  "it is that set of formatting constraints" — do not read correlation as cause.

**Why type B is especially hard to catch**: the original detector required **one** unit to take ≥20% of the
sentences in the tail window, while rotation leaves every short phrase at ~15%. Nothing clears the gate ⇒ the
whole block passes. Measured: **all 8 English-dominant blocks were stopped by that gate**.
That is why the second detector, `rotationGuard`, exists (details in
[thinking-guard/README.en.md](thinking-guard/README.en.md)).

**Why a loop feeds itself**: DSH sends the `reasoning` blocks in the history **back upstream verbatim**.
So a loop is not one bad step — it stays in the context and is re-sent on every step, and the model reads
"this is what I have been repeating". That is what `thinking-guard` folds away.

## Why two, and why both

| Plugin | What it does | When |
|---|---|---|
| **`thinking-guard`** | folds a degenerate reasoning block out of the **model-visible history** | **immediately** (next pre-step, before it is re-sent many times) |
| **`dsh-auto-checkpoint`** | at a watermark, **compact** (clear accumulated pollution) or **hand off to a fresh session** | **afterwards** |

Three reasons, and missing any one leaves a hole:

1. **Folding cannot reach inside a single generation.** It cannot stop a loop that is being generated right now —
   it can only cut it on the next step, and that step's pollution has already been sent once.
2. **Only compaction clears the stock.** Pollution accumulated over several missed blocks is slow to cut one block
   at a time; compaction clears it wholesale (measured locally: in one session with 12 compactions, every
   compaction that had accumulated pollution reduced it, the strongest going **43 → 0** with no recurrence).
3. **There are steps between compactions.** With compaction only, every step between two compactions still replays
   the pollution — that is exactly the stretch folding covers.

⇒ In one line: **folding = produce less, compaction = clear the stock. You need both for a closed loop.**

> 💡 **There is one linkage between the two plugins** (added 2026-10-15): right after the **runaway valve**
> inside `thinking-guard` aborts a loop, `dsh-auto-checkpoint` **compacts once anyway** — ignoring the watermark
> threshold and the per-session handling you picked in the panel. The valve clears "what is being spewed right
> now"; compaction clears "what accumulated" — the two join up.
> ⚠️ This step **only exists if you run the valve** (with `dsh-auto-checkpoint` alone there is none). To turn it
> off you must globally set `AUTO_COMPACT_ON_VALVE_ABORT` to `false` (default `true`) and restart — see
> [auto-checkpoint/README.en.md](auto-checkpoint/README.en.md).

## Measured: one session burned 2.3 billion tokens and stayed alive

![Token usage of a single session](docs/session-2.3b-tokens.png)

A real session's usage panel: **383 turns, 9,227 steps, 2.32 billion tokens** in total
(99.6% cache hits) — and context usage is still only 24%.

Nothing magic: `dsh-auto-checkpoint` compacts or hands off at a watermark so history cannot grow
without bound, and `thinking-guard` folds degenerate reasoning blocks so they are not replayed every step.

⚠️ This shows only that the **session survived**. It is not proof that this setup is faster or cheaper
than any alternative.

## Install (3 minutes)

→ [`INSTALL.en.md`](INSTALL.en.md) (two commands + how to verify + troubleshooting)

## What this does *not* solve (and what to pair it with)

This kit treats "**do not derail**": when the model falls into a loop, or pollution piles up in the context,
it cuts the loop off on the spot and clears the stock. It does **not** treat "**do not forget**".
Three separate things:

| What you fear losing | Does compaction lose it? | Who owns it |
|---|---|---|
| **Persona** (voice, who it is) | **No.** Persona lives in the system prompt, and compaction explicitly excludes it (the `dsh-compaction-basic` docs: the system prompt at surface node 0 is never shadowed) | your preset / mode config |
| **Task state** (where you are, next step, files touched) | **No.** A checkpoint is written before compaction; the next session reads it and carries on | this kit (`dsh-auto-checkpoint`) |
| **Conclusions reached in conversation** ("we agreed on A, not B", pitfalls hit, your preferences) | ⚠️ **Yes.** After compaction the model only sees a summary; those agreements are not in it | ⚠️ **this kit does not cover it** |

The third row is the real gap. This kit guarantees "the session survives and the task continues"; it does
**not** guarantee "it remembers what we settled earlier".

Closing that gap needs a separate **cross-session long-term memory** plugin. We happen to run a third-party
open-source one; it is listed here for reference only:

- **`@aiwayds/dsh-topics-memory`**: <https://github.com/fan56/dsh-topics-memory> (MIT)
- **Not written by us, and not maintained by us.** Its scope complements this kit; see its own README to install.
- It is deliberately strict about what gets remembered. In its own words: a topic keeps only four things —
  the question it started from, the conclusion reached, what it affects, and what it depends on;
  **the process (discussion, dead ends, detours) is deliberately not kept**.
- ⚠️ Its semantic retrieval needs a **local** embedding service (ollama only, defaults to
  `127.0.0.1:11434`); remote embedding providers are explicitly barred from its fast lane. Without
  ollama it silently falls back to lexical retrieval — a **deliberate degradation, not a fault**.

⚠️ Do not treat it as a "preserve the persona" solution — persona comes from your mode/preset config
(e.g. a persona line in a preset), while a memory plugin covers *conclusion-level* cross-session memory.
Two different jobs.

### The other commonly confused pain point: paying for tokens (not context length)

That is a **different problem**: long context is expensive because it is re-sent every turn, while
"do I have to pay for tokens at all" is a **unit-price** question.

We ourselves run **`dsh-our-free-model`** (<https://github.com/Ebony-Vinyl/dsh-our-free-model>, MIT) —
install it and use a set of frontier models with no API key.

🛑 **Four disclaimers — read all of them before deciding**:

- **Not written by us, and not maintained by us.** It is listed only because we use it every day. It is a
  mature public project (~19k stars); file issues in its own repo, not here.
- **It fixes unit price and does nothing about context length**: a memory plugin's injections still fill the
  window and still slow every turn. To cut context, tune that plugin's own injection settings
  (`topK`, injection budget, the `pointer` form instead of `digest`).
- **Your requests go to its own upstream** (currently OpenCode's Zen gateway, `https://opencode.ai/zen/v1/*`,
  with no third-party relay) — **not local inference**. If the code or conversation you feed it is sensitive,
  think it through first.
- **How long the free quota lasts is decided by neither us nor you**: the upstream can change the rules,
  rate-limit, or drop models at any time. Do not build anything you depend on around it.

## The two plugins

| Plugin | Size | README |
|---|---|---|
| `thinking-guard/` | ~760 lines (`lib/`, three files, stop-valve included), **zero host-service dependencies** | [English](thinking-guard/README.en.md)｜[中文](thinking-guard/README.md) |
| `auto-checkpoint/` | 4,292 lines, 8 host services | [English](auto-checkpoint/README.en.md)｜[中文](auto-checkpoint/README.md) |
| `auto-checkpoint/` | 4,524 lines, 8 host services | [English](auto-checkpoint/README.en.md)｜[中文](auto-checkpoint/README.md) |

## When compaction goes wrong, it recovers on its own

Auto-compaction does not just "compact and be done". It fails in several distinct ways,
and each one needs a different response.

| Situation | Before | Now |
|---|---|---|
| Transient upstream drop (`Connection error.`) | Failed in 1 second and **nothing happened afterwards** — the session sat above the threshold, uncompacted | **Retries within the same turn**, backing off between attempts, instead of waiting for the next turn |
| Transient failure | Counted as a strike; two blips degraded a healthy session to "remind only" | **Not counted**, and no cooldown — it can retry right away |
| Network blip vs. a genuine failure | Treated the same | Separated: transient errors retry, real failures count |
| Sending a message to another session | Guessed whether the target was busy, then picked a delivery mode — that guess is wrong in practice | **No guessing**: always deliver as "next step" — inserted mid-turn when busy, opening a fresh turn when idle |
| A note file whose mtime looks recent | Only compared against the previous compaction, so a note written early in the cycle counted as fresh after hours of further work | Anchored to **the start of the current compaction cycle**: too old means it asks again, and only compacts anyway once the ask limit is hit (**never deadlocks**) |

The last row was a real incident: the note was written at 22:18, compaction at 03:58 judged it
fresh and compacted immediately — **5 hours 40 minutes** of conversation never made it into any
note and was reduced to a summary.

> When re-delivering a user's own words, pass `raw: true` so the text goes through unmodified
> with no prefix — otherwise the recipient treats it as a task report.

## Recommended thresholds (`dsh-auto-checkpoint`)

| Your window | task boundary | handoff / compaction |
|---|---|---|
| 256K (DSH default) | 150k | 180k |
| ≥512K | 250k | 350k |
| ≥1M | 350k | 350k–500k |

`350k` is what we run ourselves, and it is **not a ratio** — 512K and 1M use the same numbers, so a bigger
window is not a reason to multiply them.

⚠️ **This is a trade-off — pick by what you fear more**:

- **Afraid of degeneration (loops)** → stay near 350k. The longer the context, the slower and more expensive
  each turn gets, and the higher the risk that the model falls into a loop.
- **Afraid of compacting too often** → you can go to 500k. Every compaction is one full-context request, and it
  also breaks the prompt cache — on long, high-frequency work that can end up costing more.
  **`350k–500k` is an experience-based figure** (our own feel from daily use), **not a measured cut-off**:
  we have never run 500k long-term, and we have no controlled data on "compaction frequency vs tokens spent".

## Changing the thresholds (no restart)

Two entry points, and **both edit the same config — use whichever you can see**:

- **with the desktop-pet plugin `dsh-cost-whale`** — the panel lives in that pet's menu;
- **without it** — this plugin ships its own **floating panel in the bottom-right corner**, collapsed to a small
  button; click to get the three sliders, the "hand off when done" checkbox and the mode dropdown.

If the floating panel does not appear on its own, force it with `?acfloat=1`, e.g.
`http://127.0.0.1:3081/?acfloat=1`. (If the URL already carries `?token=...`, **do not add another question
mark** — just append `#acfloat` at the very end.)

Dragging a slider takes effect **at runtime** (the panel POSTs to the runtime config route, updating memory and
disk together) — **no restart**. Only the keys in the package's `cordis.patch.yml` need a restart.

## Status

- **AS-IS**, MIT.
- Verified against DSH **0.2.1-rc.2** (full real run). **0.2.0-rc.2 was only source-checked, never actually run** —
  both versions ship the same `developer` filter in `dsh-llm`, which is why the fold note always travels as
  `user/message` and does not depend on the version. Both plugins use internal DSH services and events, so
  **a major upgrade may break them together**.
- Not battle-tested at scale; forks and PRs welcome.

### Why the fold note is `role: "user"`

The note left behind after a fold travels as `user/message`, not `developer/message`. That was a hard-won choice.

`developer/message` maps to `role: "system"` upstream, which is semantically better. But the host silently drops
**any developer message that is not a tool update** in `projectToolUpdates()` (`if (!updateIds.has(message.id)) continue`).
We measured it: the session log held correct fold events and `deriveMessages()` returned `developer`, yet the real
HTTP request body contained none of them — it took three probes and a capturing proxy to pin it to that one line.

`user/message` is the only channel that actually reaches the model. The tradeoff is that the model may mistake it
for something the user said, so the wording does two things: it identifies itself in the first clause
(`⟪thinking-guard⟫`), and it contains **no imperatives at all** ("please…", "don't…", "just…" read as a user
issuing an order — that is exactly what makes a model start inventing things the user said).
