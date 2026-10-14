# Installing (just type it)

## 0. Check that your dsh has the `plugin` subcommand

```bash
dsh plugin --help
```

If that errors, your version is older — mount things by hand instead (each plugin's README explains how).

## 1. Install (one command)

```bash
cd /absolute/path/to/dsh-degeneration-kit
bash install.sh
```

`install.sh` does one thing: it calls dsh's own install command for you, for both plugins. Flags:

| Flag | Effect |
|---|---|
| (none) | install both |
| `--only guard` | only `thinking-guard` (folding) |
| `--only checkpoint` | only `dsh-auto-checkpoint` (compaction / fresh session) |
| `--profile <name>` | use another profile (default `web`) |

If it cannot find the `dsh` command it looks for `bin.js` in the usual places, and if that fails too it prints the
commands for you to run by hand instead of guessing.

Typing them yourself is equivalent:

```bash
# (1) folding — install at least this one
dsh plugin --profile web add /absolute/path/to/dsh-degeneration-kit/thinking-guard

# (2) compaction / fresh session — add this if you want it exhaustive
dsh plugin --profile web add /absolute/path/to/dsh-degeneration-kit/auto-checkpoint
```

⚠️ Use an **absolute path** pointing at the **subdirectory** (not the repo root).

**What those two commands do** (measured locally, finished in 468 ms):

- add the package to the profile's dependencies — a local path becomes `link:`, so **files are not copied** and
  editing the source takes effect immediately;
- **add the package name to the profile's `bundles` list automatically** (the package declares `dsh.bundle.patch`).

## 2. Restart dsh web

Plugins load **at startup**; editing a `.mjs` and refreshing the page does nothing.

## 3. Verify (30 seconds, no guessing)

```bash
dsh --profile web --dump-config | grep -A8 'dsh-thinking-guard'
dsh --profile web --dump-config | grep -A8 'auto-checkpoint'
```

The first one should show:

```
- id: thinking-guard
  name: dsh-thinking-guard
  inject:
    - agents
  config:
    enabled: true
```

Seeing that means it entered the plugin tree — the line between "installed" and "actually loaded".

## 4. Configuration lives in the package's `cordis.patch.yml`

To **watch first, act later**: uncomment the line

```yaml
        # dryRun: true
```

in `thinking-guard/cordis.patch.yml` and **restart**. This was measured — the line shows up in `--dump-config`
as `dryRun: true`.

Thresholds work the same way; every key in that file is commented.

### Thresholds can also be dragged in the UI (no restart)

`dsh-auto-checkpoint` has two panel entry points, **use whichever you can see**:

- with the desktop-pet plugin `dsh-cost-whale` ⇒ the panel is in that pet's menu;
- without it ⇒ the plugin ships a **floating panel in the bottom-right corner** (collapsed to a small button).

If the floating panel does not appear on its own, force it with `?acfloat=1`, e.g. `http://127.0.0.1:3081/?acfloat=1`.
(If the URL already carries `?token=...`, **do not add another question mark** — append `#acfloat` instead.)

Dragging takes effect **at runtime** (the panel POSTs to the runtime config route, updating memory and disk
together) — **no restart**.

## 5. Can I install only one?

Yes. But **install `thinking-guard` at least**: it has zero host-service dependencies, hooks exactly one event,
and does not touch your session structure.
`dsh-auto-checkpoint` **changes your sessions** (compaction / new session), so configure the thresholds for your
window before enabling it (see that plugin's README).

⚠️ **Do not mount the same entry twice in one profile** (e.g. install the package *and* hand-write an entry in a
preset) — startup fails with `duplicate loader entry id`. Run `--dump-config` first.

## 6. Uninstalling

Remove the two lines from the profile's `bundles` and `dependencies`, then restart.
(`dsh plugin --profile web remove <name>` probably works too, but we did not measure it, so we don't claim it does.)

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Nothing happens after install | You did not restart. Plugins load at startup |
| Cannot find the panel / sliders | Without the desktop pet, add `?acfloat=1` to the URL; with it, open the pet's menu |
| `duplicate loader entry id` on startup | You mounted the same entry before — remove the old one |
| Want to see what it does | Give `debugFile` a path in `cordis.patch.yml`; read that file after restarting |
| `dsh plugin` does not exist | Older version ⇒ mount by hand (each plugin's README) |
| Want proof it is running | With `debugFile` set, the log shows `apply 被调用` and `sweep 首次：surface N 节点` |
