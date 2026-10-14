# DSH degeneration kit — ⚠️ **two plugins, and you need both**

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

## Install (3 minutes)

→ [`INSTALL.md`](INSTALL.md) (two commands + how to verify + troubleshooting)

## The two plugins

| Plugin | Size | README |
|---|---|---|
| `thinking-guard/` | ~760 lines (`lib/`, three files, stop-valve included), **zero host-service dependencies** | [English](thinking-guard/README.md)｜[中文](thinking-guard/README.zh.md) |
| `auto-checkpoint/` | 4,292 lines, 8 host services | [English](auto-checkpoint/README.md)｜[中文](auto-checkpoint/README.zh.md) |

## Recommended thresholds (`dsh-auto-checkpoint`)

| Your window | task boundary | handoff / compaction |
|---|---|---|
| 256K (DSH default) | 150k | 180k |
| ≥512K | 250k | 350k |

`350k` is a **comfort ceiling, not a ratio** — a bigger window is not a reason to raise it.

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
- Verified against DSH **0.2.0-rc.2**. Both plugins use internal DSH services and events, so **a major upgrade may
  break them together**.
- Not battle-tested at scale; forks and PRs welcome.
