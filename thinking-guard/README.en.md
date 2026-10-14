# thinking-guard

**English | [中文](README.md)**

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that folds degenerate, looping "thinking" blocks out of the history the model sees.

## What it fixes

DSH sends historical `reasoning` blocks back upstream (`@deepseek-ai/dsh-llm-pi-ai` maps `reasoning` to `thinking`). So once a model starts looping, the damage is not limited to that one step: the looping block stays in the context and is re-sent on every following step and turn.

Compaction does not save you here. The default `retainRatio` "keep the tail verbatim" policy tends to retain exactly that block, and compaction only runs on `agent/pre-step` — it cannot reach inside a single generation.

In a request body we captured, one 15,955-character loop reappeared as the body of an assistant message on the next request (`content` length 15,986).

## What it does

Before each step, it sweeps the surface nodes it has not checked yet. When an assistant message contains a degenerate looping reasoning block, the node — **together with the tool results it triggered** — is replaced in place by a single `user/message`, whose body is a short fold note.

- The log stays append-only; nothing is deleted from it.
- In the model-visible history, that step is just the note.
- The human-facing transcript is unaffected (the replacement copy is model-only; the transcript uses the original append event).

The note reads:

```
⟪thinking-guard⟫ the previous step's thinking degenerated into a loop and was folded out of the model-visible history.
```

## How "degenerate" is decided

Two things only: the length of the repeating unit, and its share of the whole block. Defaults:

| Config | Default | Meaning |
|---|---|---|
| `minChars` | 400 | ignore blocks shorter than this |
| `minRepeats` | 25 | the unit must repeat at least this many times |
| `maxUnit` | 30 | longest unit counted as "the repeat" |
| `minShare` | 0.20 | the repeated part must be at least 20% of the block |
| `tailChars` | 4000 | only look at this much of the block's tail |
| `foldToolSteps` | true | fold steps that made tool calls too (see below) |
| `dryRun` | false | log only, fold nothing — **turn this on while tuning** |
| `rotationGuard` | true | **v2 criterion switch** (short-sentence rotation / English fragments). `false` = original criterion only |
| `shortShareMin` | 0.35 | v2: minimum share of short segments (≤3 words) in the tail window |
| `topUnitShareMin` | 0.50 | v2: minimum combined share of the top 5 segments |

## Why it folds whole spans instead of "pure thinking" steps

v1 skipped steps that contained tool calls, to avoid leaving a paired `tool/result` dangling. A scan of 571 sessions and 63,735 assistant messages showed that limit threw away most of the cases:

- of the 24 blocks that matched the degenerate criterion, **17 (71%) contained tool calls**;
- for context: **96.6%** of assistant messages contain a `tool-call`.

It now replaces a **contiguous span across node types** with one `user/message` (`surfaceOp: { op: 'replace', startSeq, endSeq }`). When the pairing is incomplete it does not fold; it waits for the result to land in the surface and retries on the next pre-step.

The replacement uses a core event type (`user/message`) on purpose: custom event types cannot carry the `ignorable` marker in-process, and the loader rejects them.

## Installing

It is a plain cordis plugin (exports `name` and `apply`) with no host-service dependencies — it only listens on `agent/pre-step` and takes `agent.session` from the payload. Two ways to mount it:

1. **Inside an agent preset** (what we do now): add an entry to the preset's `agent.cordis.yml` pointing `name` at this file.
2. **As a host-level plugin** (applies to every preset): add an entry to your profile's plugin tree.

> **Update 2026-10-14: both options have now been tested.** The host-level mount was verified in an isolated environment — a
> headless profile with **no preset section** — where the session finished normally (exit code 0) and the plugin logged
> `apply 被调用：enabled=true` followed by `sweep 首次：surface 0 节点`. When mounting host-wide, declare
> `inject: [agents]` on the entry (that is what our experiment used).
>
> **Which option should you pick? We recommend option 2 (host level).** The reason only became clear on
> 2026-10-14: looping degeneration is the **model's own** behaviour under long context — it has nothing to do with
> which preset is mounted. Mounted inside a preset, only sessions that select that preset are protected. We hit exactly
> that trap here: a 384-turn `standard` session that compacted repeatedly ran with **no protection at all**
> (`⟪thinking-guard⟫` appears **0 times** in its log).
> ⚠️ And the converse matters too: **"my standard sessions never degenerated" does not prove they don't need this** —
> only our we-need sessions had the detector mounted, so a standard session could degenerate and leave **no trace at all**
> (a selection bias).

## Tuning

Run with `dryRun: true` for a day and watch how often it fires and what it matches, then decide whether to fold for real. Hits are logged through `ctx.logger` (`info`): which seq was folded, how many characters, and what the repeating unit was.

A failed fold never breaks the step: the error is swallowed and logged as `warn`.

## Known limits

- The criterion looks at **character-level repetition**; there is no semantic judgement. A model that loops with different wording every time will not be caught.
- **Both Chinese and English match** (measured: a Chinese sentence ×30 and an English sentence ×30 both hit, `share=100%`). Splitting uses `/[。！？!?\n]+|\.\s+/`; a "meaningful" character is `A-Za-z0-9` or a CJK ideograph.
- ⚠️ **Two gaps on the English side — know them before you rely on this**:
  1. **`maxUnit: 30` was tuned for Chinese** — 30 Chinese characters is roughly one sentence, while 30 English characters is about five words.
     Measured: an English 53-character sentence repeated 30 times → **no hit** (skipped by `maxUnit`). ⇒ For English, raise it (start around 80).
  2. **"Same template, different words" loops are missed**: the detector requires the **exact same unit** to repeat ≥25 times.
     Measured: `Let me check / Let me look / Let me verify` 10× each → **no hit**; `Let me examine item N.` with N incrementing → **no hit**.
     English loops are often exactly this shape (Chinese loops are more often verbatim copies, so the Chinese side fares better).
- 🛑 **Do not use "frequent phrases" as a criterion**: in one 379-turn English session (9,008 steps) we counted `Hmm` **39,648** times,
  `Let me check` **8,610**, `Let me do` **7,604**. Those are the normal texture of thinking, not a degeneration signal. The detector looks at
  **repetition density inside the tail window** (`tailChars: 4000`, same unit ≥25 times and ≥20% of sentences), not global word frequency.
  ⇒ **On English, run with `dryRun: true` first** — we have no calibration data for English (the Chinese calibration was "235 sessions
  machine-wide: recall 7/7, 11 extra triggers").
- ⚠️ **The English side used to be a blank — as of 2026-10-14 it is not. Here is what happened.**
  - The original criterion only measures **one** unit's share of the window's segments (`minShare: 0.20`). English degeneration is
    usually **several short sentences rotating**: `Let me write it.` → `Go.` → `Now.` → `OK.` → `Writing.` — the 4,000-char tail
    splits into 300+ segments, each short phrase holds ~15%, **none reaches 20%** ⇒ the whole block passes. Measured: **0/3 recall**;
    and of every block machine-wide with ra≥20, **all 8 English-dominant ones were stopped by that gate**.
  - **Three real samples** (all in sessions where this plugin was **not** mounted — which is why the logs are silent):

    | Date | Session | Preset | Block | ra (top repeat) | Original criterion |
    |---|---|---|---|---|---|
    | 09-16 | `9f419776` seq147 | standard | 18,793 | `Go.`×44 | ❌ |
    | 09-20 | `4795bd89` seq677 | cordis | 38,785 | `OK.`×105 | ❌ |
    | 09-23 | `a09aa199` seq3006 | standard | 29,371 | `Let me write.`×67 | ❌ |

    In the 38,785-char one, `Let me write the tool call.` appears **180** times, and the model even wrote
    `(I apologize for the loop; producing the call.)` itself.
  - ⇒ There is now a second criterion, `detect-v2.mjs` (`rotationGuard`, on by default): within the same tail window,
    **short segments (≤3 words) ≥ 0.35** and **top-5 segments together ≥ 0.50**. Measured: **3/3 recall** and **0 false positives
    on 12,203 normal English blocks** (worst normal block 0.41 vs lowest real sample 0.53 — the threshold sits in the gap).
    It only fires **after** the original criterion passes a block, and it is deliberately **not** wired into the shared `detect`
    that the emergency valve uses (that action is `agent.cancel`, harsher than folding).
  - 🛑 And still do not use "frequent phrase" as a criterion: in one 379-turn English session (9,008 steps) `Hmm` appeared
    **39,648** times and `Let me check` **8,610** — that is the normal texture of thinking.
    ⇒ **On English, still start with `dryRun: true` for a day**: the v2 thresholds were set from 3 samples + 12,203 normal blocks
    on one machine. They are not universal constants.
- ⭐ **A side finding worth more than the English question**: among the sessions with hits, `3867d102` and `98e0ff60`
  have **no fold record at all** — they ran `standard`, where no detector was mounted. That is the selection bias above, measured.
- The file is `escape-valve.mjs` but the plugin name it exports is `loop-valve`. That mismatch is still there.

---
