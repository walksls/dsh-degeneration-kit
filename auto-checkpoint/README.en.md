# dsh-auto-checkpoint

**English | [中文](README.md)**

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that
watches session token pressure. At a configurable threshold it asks the model to
write a project checkpoint file into the workspace and — optionally — hands the
work to a fresh session seeded with a continue instruction, so the old session
stops consuming context.

## What it fixes

Long sessions degrade: recall of the earliest content drops and every request
re-prices the whole history. Instead of letting one session balloon to the
window edge (and re-introducing bugs already fixed early on), leave a checkpoint
at the threshold and continue in a new session.

## How it works

| Phase | What happens |
|---|---|
| watching | Before each step, prices the session via `ctx.tokenMeter.measure(session).totalTokens`; below threshold: no-op |
| requested | Above threshold: appends one plugin-sourced user message asking the model to write the project state to `checkpointPath` with its `write` tool |
| handoff | Once the file has landed (non-empty): `goals.pause()` stops the old session's active goal, then after `whenIdle()` `sessionController.create()` makes a new session (same cwd, same agent preset), the parent's **permission preset** and **model selection** are handed down to it, and `sessionController.prompt()` feeds the continue instruction; the old session parks |
| parked | The old session's every further step is rejected at `agent/pre-step`, so it converges to idle and stops spending tokens |
| checkpoint-only | With `autoNewSession: false`: only the checkpoint file is written; the session keeps running |

- Safety net: while the model has not written the file, a short reminder is
  injected every `remindEverySteps` steps, so a stalled write cannot silently
  balloon toward the window edge.
- Parking is a pre-step **rejection**, not a kill: the in-flight step finishes,
  then the session settles naturally.
- **Only a genuine human message reopens a parked session.** Goal rounds
  (`<goal_round>`), background-job notices and subagent reports are automatic
  injections and stay rejected — otherwise the old session is read as "the user
  is back", un-parks, and works in the same workspace as its own successor
  (hit in production on 2026-09-17; see the regression tests in `test/`).
- The pause applies to the **old** session's goal; goals never cross sessions,
  so the successor arms its own from the checkpoint file.
- **The permission preset is inherited.** A published child starts from the
  profile's default knobs (`workspace-write` + `ask`); the plugin then hands the
  parent's preset down with `ctx.permissionPresets.set`, so a session you
  switched to "full access" hands its successor the same access. Without it the
  child silently comes back weaker and stalls on writes outside the workspace
  (seen 2026-09-17: `095fb27a` ran with full access, its child `27175d59`
  started as `workspace-write`). A `custom` parent preset logs a warning
  instead of being guessed at.
- **The model selection is inherited too.** `sessionController.create()` builds
  the child from the deployment's default model, so a session you switched to
  another model (or another reasoning effort) used to relay into a child running
  on the default. The plugin reads the parent's live selection from the
  `modelSelection` projection (`pending ?? lastUsed`) and installs it on the
  child with `sessionController.selectModel` — the same call the GUI makes, so an
  unavailable model cannot be installed — before the continue prompt. A parent
  already sitting on the default is skipped: the child starts there anyway, and
  `selectModel` would only re-save that default.

## Install

```bash
dsh plugin --profile web add /absolute/path/to/dsh-auto-checkpoint
```

The package declares `dsh.bundle.patch`, so installation hooks it into the
profile's bundle layer stack automatically.

## Config

In the profile's `cordis.patch.yml`:

```yaml
- id: auto-checkpoint
  config:
    triggerTokens: 300000
    checkpointPath: checkpoint.md
    autoNewSession: true
    continuePrompt: 'This is a new session. First read {{path}} …'
    remindEverySteps: 3
```

| Field | Type | Default | Meaning |
|---|---|---|---|
| `triggerTokens` | number | `300000` | Token pressure threshold. Keep margin: metering is heuristic (4 chars ≈ 1 token; CJK underpriced) |
| `checkpointPath` | string | `checkpoint.md` | Checkpoint file, relative to the session cwd or absolute |
| `autoNewSession` | boolean | `true` | `false`: write the checkpoint only, keep the session |
| `continuePrompt` | string | see README | First message of the new session; `{{path}}` is replaced with the checkpoint path |
| `remindEverySteps` | number | `3` | Reminder cadence while the checkpoint is pending |

### Choosing the thresholds (three numbers, and they must stay ordered)

Three watermarks with three different jobs:

| Key | Code default | Job | Our value |
|---|---|---|---|
| `taskBoundaryTokens` | 150,000 | task boundary: fires when a todo completes | **250,000** |
| `triggerTokens` | 300,000 | pressure threshold: write a checkpoint → **hand off to a fresh session** | **350,000** |
| `remindTokens` | 400,000 | **reminder only** ("you should compact"), takes no action | **350,000** |

**0. Find out your model's context window first.** All three are **absolute token counts** — the plugin does **not**
adapt to the window (there is no such logic in the code).
- **DSH's own default is 256K**: the adapter falls back to `262144`, and the settings page hints `256K`
  (`dsh-client-ui-settings-models/lib/client.js:559-561`).
- **We raised ours to 1M ourselves** (`contextWindow: 1048576` in our profile) — **that is not the default**.
- ⇒ The 250k/350k numbers below assume a **≥512K** window. On 256K they must be scaled down (table below).

**1. Keep them ordered**: `taskBoundaryTokens < triggerTokens`.

**2. "Auto-compact at threshold" and "auto-handoff" are mutually exclusive, per session** (since 2026-10-11, `index.js:2899-2911`):
- tick a session's *auto-compact at threshold* ⇒ the **whole handoff path is skipped** for that session
  (no checkpoint nudge, no new session, no freezing the old one) — it stays alive on compaction;
- unticked ⇒ handoff runs normally (at `triggerTokens` it writes the checkpoint and hands off).

That is why our `remindTokens` may **equal** `triggerTokens`: sessions that opted into compaction never take the
handoff path, so the two never race.

> ⚠️ **"Handoff" names two different things in this plugin — do not conflate them** (added 2026-10-15):
> - **handoff** = write the checkpoint → **open a new session** → freeze the old one. The "mutually exclusive"
>   rule above is about this one;
> - **"post-compaction re-anchor"** (`reanchorAfterCompact`) = after a successful compaction, inject one
>   "read the files before you act" line **into the same session**. It does **not** open a new session.

> 🛑 **One exception: when the runaway valve fires, it bypasses the gate above** (added 2026-10-15).
> If you run the escape valve (`escape-valve`), then right after it aborts a session's turn, this plugin
> **compacts once anyway** — **ignoring** the *auto-compact at threshold* setting **and** the pressure
> threshold (cooldowns still apply). The signature it looks for is `turn/end` carrying
> `{kind:'aborted', reason:{kind:'hook', …}}`; pressing "stop generating" yourself is `kind:'user'` and
> does **not** trigger it.
> · Why: the valve clears "what is being spewed right now", compaction clears "what accumulated" — two
>   halves of one job, not duplicates.
> · To turn it off you must **globally** set the constant `AUTO_COMPACT_ON_VALVE_ABORT` to `false` and
>   restart the web app (`index.js:432`, default `true`). ⚠️ That one constant is **shared** with
>   "auto-compact at threshold" — switching it off disables both.
> · Known limit: compaction needs the agent to be idle. In an ordinary web session the agent really is idle
>   after a valve abort, so it fits; in **long-running / goal-driven sessions** the driver restarts itself and
>   compaction may miss the window (it gives up after 3 retries).

**3. Recommended values** (⚠️ only meaningful for sessions that **take the handoff path**: a session ticked
*auto-compact at threshold* never uses `triggerTokens` / `remindTokens` — it stays alive on compaction):

| Your window | `taskBoundaryTokens` | `triggerTokens` | `remindTokens` |
|---|---|---|---|
| **256K (DSH default)** | 150k | 180k | 180k |
| **512K** | **250k** | **350k** | **350k** |
| **1M (we raised ours)** | **250k** | **350k–500k** | **350k** |

- **512K and 1M use the same numbers** ⇒ **the handoff point is not a percentage of the window**: do not scale it up
  just because the window is bigger.
- Only windows **below 512K** need to scale down: on 256K use 180k (≈ 69% of the window) with a 150k boundary.
- The 512K row is what **we actually run**; the 256K row is a **proportional estimate, not measured on a small window**;
  **`350k–500k` is an experience-based figure** (our own feel from daily use), **not a measured cut-off**.
- 🛑 Copying our numbers onto a 256K window breaks in two ways: `triggerTokens=350k` **never fires** (the plugin looks
  dead), and `taskBoundaryTokens=250k` sits at ~95% of the window, so the checkpoint lands when you are nearly out of room.

**4. Why we hand off around 350k even with a 1M window — and why you may go up to 500k**

It is a **trade-off**; pick by what you fear more:

- **Afraid of degeneration (loops)** → stay near 350k. Past that point a bigger window buys little: requests get slower
  and more expensive, and a longer context raises the risk of degeneration (loops). Handing off around 350k is simply
  more stable.
- **Afraid of compacting too often** → you can go to 500k. Every compaction is one **full-context request**, and it also
  **breaks the prompt cache** — on long, high-frequency work, compacting too eagerly can cost more than carrying a
  little extra context.
- ⚠️ **`350k–500k` is an experience-based figure, not a boundary we measured**: we have no controlled data on
  "compaction frequency vs tokens spent", and we have never run 500k long-term (we run 350k). If your own feel
  disagrees with it, trust yours.

### Old sessions (600K+) may refuse to compact — don't fight it

**Measured (2026-10-07)**: a session that had grown to **684K** failed manual compaction twice, with nothing but
`Compaction could not produce a useful summary` shown in the UI.

The real cause is recorded in the session log under `compaction/end.data.error`, and it is an **upstream rejection**:

```
503: {"code":11133,"msg":"Invalid request parameters"}
extError: model_param_invalid
outer code: no_healthy_account
```

⇒ **It is not necessarily your session that is broken** — DSH retried twice and gave up, and other sessions on the same
account compacted fine at that moment. Whether the very long context contributed to the rejected parameters cannot be
told from the log, so don't blame "the session is too old" right away.

**To rescue such a session**: stop retrying compaction. **Open a new session** and have it read the old session's
**reasoning + user messages**, **skipping tool calls as noise** (those are often tens of thousands of characters).

### It is one half of a pair with `thinking-guard` (use both)

| | What it does | When |
|---|---|---|
| `thinking-guard` | folds a degenerate reasoning block out of the **model-visible history** | **immediately** (next pre-step, before the block is re-sent many times) |
| this plugin (compaction / handoff) | clears **accumulated** pollution wholesale, or moves to a fresh session | **afterwards** (once a watermark is reached) |

They are not redundant:

- folding **cannot reach inside a single generation** — it cannot stop a loop that is being generated right now, only
  cut it on the next step;
- pollution that has **accumulated** over several blocks can only be cleared at once by compaction (measured locally:
  in a session with 12 compactions, every compaction that had accumulated pollution reduced it, the strongest going
  **43 → 0** with no recurrence afterwards).

⇒ **Neither half is complete on its own**: with folding only, misses and accumulation remain; with compaction only, every
step between two compactions still replays the pollution.

## Visual tuning (Web UI)

When installed into the web profile, the plugin renders an "自动检查点"
(auto-checkpoint) section in **one of two places** — whichever exists:

- **with the desktop-pet plugin `dsh-cost-whale`**: inside its menu
  (bottom-right whale → top-right menu button);
- **without it**: the plugin builds its own **floating panel in the
  bottom-right corner**, collapsed to a small button — click to expand.
  Force it any time with `?acfloat=1`, or `#acfloat` if the URL already
  carries a `?token=...`.

Both panels edit the **same config**.

- **Threshold slider** 50k–1000k plus a **number input** (≥1000, no upper
  bound); changes persist immediately to `~/.dsh/auto-checkpoint.json`
  (your `settings.yaml` is untouched) and apply to the very next step —
  no restart needed.
- **Live pressure**: current session token pressure / threshold with a
  progress bar.
- **Toggles**: `写完后自动开新会话` (auto new session), `启用自动检查点`
  (enabled).
- **Per-session handling** (⚠️ stored **per session**, not a global switch): *do nothing (default)* /
  *remind me at threshold* / *auto-compact at threshold*. Whatever you pick applies to **the session you have
  open right now** — it is written into `sessionModes` in `~/.dsh/auto-checkpoint.json` (keyed by session id)
  and then **sticks to that session**: switching away, closing the tab, or restarting the web app all keep it,
  and other sessions are unaffected. ⚠️ Do not read this as "you must stay in that session for it to work".
  (`auto-compact at threshold` makes that session skip the handoff path, see §2 above.)
- Disabling keeps the config; reopening restores it.

The runtime config file overrides the static defaults in `cordis.patch.yml`;
missing file or fields fall back to the static config.

## Requirements

- `ctx.tokenMeter` (ships with `dsh-base`) and `ctx.sessionController`
  (ships with `dsh-web-app`). Without `sessionController` the plugin degrades
  to checkpoint-only and logs a notice.
- DeepSeek Harness `>= 0.1.x` (developed and tested on `0.1.5-rc.2`).
- Node `>= 22.19`. Zero runtime dependencies.

## Uninstall

```bash
dsh plugin --profile web remove dsh-auto-checkpoint
```

## License

MIT
