# ghostmux — Ghostty + tmux, two honest profiles

**Pick by how much of your day is a TUI.**

There is no single set of terminal settings that gives you *both* coherent
scroll-back of a live-TUI pane *and* plain-drag native selection — because
scroll and drag are the **same mouse-event channel with exactly one owner**. So
ghostmux ships **two coherent profiles**, named by the layer that owns the
mouse, and lets you choose by workload.

No plugins. No magic. Two paste-ready bundles and one honest trade-off.

---

## The 30-second model

Terminals have two output models:

- **Append-only** — each line is printed once and scrolls upward forever. The
  terminal's own scrollback captures everything losslessly. Trackpad scroll,
  `less`, `tmux copy-mode` all work, because history *is* just the stream of
  past lines.
- **Repaint / fullscreen TUI** — the app owns a fixed grid and overwrites it in
  place: spinners, live input boxes, streaming tokens, status bars. This is the
  `vim` / `htop` / `lazygit` model — and now the model of AI coding CLIs.

**The one-owner mouse rule.** Scroll-wheel and click-drag are the same mouse
event stream. tmux's `mouse` option decides who receives it — there is exactly
one owner:

- `mouse off` → **Ghostty** owns it. Plain drag = native selection. Trackpad
  scroll = Ghostty scrollback (clean for append output, **garbled for a live
  TUI**).
- `mouse on` → **tmux / the focused app** owns it. Trackpad scroll = coherent
  (copy-mode or the app's own scroll). Native selection moves to **Shift+drag**.

You cannot have plain-drag-select *and* coherent-TUI-trackpad-scroll at the same
time. Choosing between them is the design, not a workaround.

---

## Why this exists — the TUI-rerendering trend

The old dream was "let the terminal own everything natively." AI CLIs broke it.

When a TUI repaints, old cells are **overwritten, not scrolled off** — so what
reaches the terminal's native scrollback is a *record of repaints*, which
renders as garble. No terminal can reconstruct clean history from that; the
information isn't there. Only two things *can* give coherent history of a TUI:

- the **application itself** (its own transcript view — e.g. Claude Code's
  `Ctrl+O`), or
- a **grid-tracking multiplexer** (`tmux copy-mode`), which models the cells
  rather than the byte stream.

**Verified empirically (Ghostty 1.3.1 + tmux 3.5a, macOS):** append-only output
scrolls perfectly in Ghostty alone *and* through tmux's relay. tmux's captured
grid history of a live TUI pane is clean. Ghostty's *native* scrollback of the
same pane is garbled. Ghostty and tmux are both healthy — the garble is inherent
to native-scrolling a repaint stream. Not a bug; a model mismatch.

The consequence: as more of your day becomes AI-CLI / TUI time, "Ghostty owns
everything" hits its ceiling more often. Routing scroll to a layer that
understands the grid (the `tmux` profile) is future-proof against that trend.

---

## The two profiles

| Profile | Owner of mouse | Scroll-back of a live TUI | Native selection | Best for |
|---|---|---|---|---|
| **`ghostty`** | Ghostty (`mouse off`) | garbled (repaint stream) | plain drag | append-only / shell-heavy work |
| **`tmux`** | tmux (`mouse on`) | coherent (copy-mode / app) | **Shift**+drag | live-TUI-heavy work (Claude Code, vim, lazygit) |

### `ghostty` — gesture map

| Gesture | Behavior |
|---|---|
| Trackpad scroll | Ghostty native scrollback — clean for shell/append panes, **garbled for live-TUI panes** |
| Drag | native Ghostty selection (highlight ≠ copy) |
| cmd+C / cmd+V | native clipboard copy / bracketed paste |
| Deep / pre-attach / TUI history | `prefix [` (tmux copy-mode, keyboard) |

**Ceiling**: live-TUI panes cannot be trackpad-scrolled coherently. Use keyboard
`prefix [` or the app's own scroll for those.

### `tmux` — gesture map

| Gesture | Behavior |
|---|---|
| Plain trackpad scroll | **coherent scroll-back** — tmux copy-mode (shell panes) or the app's own transcript (Claude, if it grabs the mouse). Exit copy-mode: scroll to bottom or `q` |
| Shift+drag | native Ghostty selection → cmd+C / cmd+V (via `mouse-shift-capture = never`) |
| Plain drag | tmux selection (visible, into the tmux buffer) |
| Shift+scroll | raw Ghostty native scroll — clean for shell, **garbled for TUI** (do not use on Claude panes) |
| Full Claude conversation | `Ctrl+O` (Claude's own transcript) — complete, renderer-independent |

**Cost**: one muscle-memory change — hold **Shift** to select. Copy/paste keys
unchanged. Copy-mode scroll has a light "mode" wrapper (position indicator; `q`
to exit) rather than a pure-native feel.

---

## When to pick which

- **`tmux`** — your day is mostly **live TUIs** (Claude Code, vim, lazygit,
  k9s). You value coherent scroll-back of *everything* over
  selecting-without-a-modifier. **Future-proof** as TUIs proliferate. (This is
  the recommended pick if you live in AI CLIs.)
- **`ghostty`** — your day is mostly **append-only shell** (logs, command
  output, REPLs), you rarely scroll a TUI's history, and you prize the purest
  native feel (no modifier to select, no copy-mode wrapper). Distinctive, but
  ceilinged as TUIs proliferate.

Rule of thumb: **more AI-CLI / TUI time → `tmux`. More classic-shell time →
`ghostty`.** There is no baked-in default — the right pick is workload-dependent.

---

## Paste-ready blocks

Each profile is a **bundle**: tmux + Ghostty (+ optional Claude) settings that
move together. Mixing across bundles is the source of "flaky/patchy" behavior;
the profile is the unit.

### Shared — Ghostty (`~/.config/ghostty/config`), both profiles

```ghostty
scrollback-limit = 100000000
mouse-shift-capture = never
# Remove this line if present: copy-on-select = clipboard
```

Reload with cmd+shift+, (reload_config). New surfaces pick up the new scrollback
limit; existing surfaces keep their previous buffer. See `ghostty/config` for
full comments. These two lines are identical for both profiles.

### Profile `ghostty` — tmux (`~/.tmux.conf`)

```tmux
source-file ~/.config/ghostmux/tmux/ghostty.conf
```

Or paste the contents of `tmux/ghostty.conf` directly. Then reload:
`tmux source-file ~/.tmux.conf`.

Companion (load-bearing for this profile): pin Claude Code's classic renderer so
its output stays append-only — merge `claude/settings.snippet.json`
(`{ "tui": "default" }`) into your Claude Code `settings.json`. See
`claude/README.md`.

If `$EDITOR` contains `vi` (e.g. `EDITOR=nvim`), also add the two `bindkey` lines
from `zsh/bindkeys.zsh` to `~/.zshrc` to fix cmd+left / cmd+right at the prompt.

### Profile `tmux` — tmux (`~/.tmux.conf`)

```tmux
source-file ~/.config/ghostmux/tmux/tmux.conf
```

Or paste the contents of `tmux/tmux.conf` directly. Then reload:
`tmux source-file ~/.tmux.conf`.

The Claude renderer pin is **not** load-bearing here (harmless if left in place):
with the mouse routed to the app, Claude's fullscreen renderer + its own scroll
work fine.

### Re-attach reminder (both profiles)

Some of these settings (notably `terminal-overrides` in the `ghostty` profile)
are **client-negotiated at attach time**. Existing attached clients keep the old
behavior until they re-attach. To apply immediately, restart Ghostty (simplest),
or run:

```sh
tmux list-clients -F '#{client_name}|#{session_name}' | while IFS='|' read c s; do
  tmux detach-client -t "$c" -E "tmux attach -t '$s'"
done
```

---

## Install? Only to contribute

The `tmux/`, `ghostty/`, and `zsh/` configs are **paste-ready and zero-install**
— nothing to build. The optional `bin/` and `harness/` scripts run under `bun`
directly (`bun bin/ghostmux.ts …`, `bun harness/verify-ux.ts`) with no install
step. `bun install` is only needed for typechecking or contributing:

```sh
bun install       # dev tooling only (@types/bun, typescript) — no runtime deps
bun run typecheck # tsc --noEmit
bun test          # fast static guards
```

## Agent-native selector

`bin/ghostmux.ts` is a zero-dependency Bun CLI (bun + node builtins only) for
machine-consumable profile switching.

```sh
# Machine-readable descriptor of BOTH profiles (id, gestures, trade-offs):
bun bin/ghostmux.ts list --json      # (bare --json is an alias)

# Point ~/.tmux.conf at a profile's conf (writes a managed source-file block):
bun bin/ghostmux.ts apply tmux
bun bin/ghostmux.ts apply ghostty --config /path/to/tmux.conf

# Print the source-file block without writing anything:
bun bin/ghostmux.ts apply tmux --print
```

`apply` backs up an existing target to `<target>.bak` and keeps a single managed
block (re-applying replaces it). Bad or missing arguments return a structured
error envelope on stderr with a non-zero exit:

```json
{ "error": { "code": "UNKNOWN_PROFILE", "message": "unknown profile 'bogus' — valid profiles are: ghostty, tmux" } }
```

---

## Verify

```sh
bun harness/verify-ux.ts
```

Requires bun, tmux >= 3.5a, script(1). Uses only scratch tmux sockets
(`-L gmx-*`); never touches your default server or any dotfiles. This proves the
`ghostty` profile's byte-level claims (alternate-screen suppression, CPR-noise
immunity, paste integrity) with live tmux processes. See `harness/README.md`
for what each test proves.

Fast static guards (no tmux needed):

```sh
bun test
```

---

## Honest caveats

1. **`ghostty` profile garbles live-TUI trackpad history.** A repaint stream is
   not scrollback-shaped; native scrollback of a live TUI (Claude Code, vim,
   lazygit) renders as garble. Use `prefix [` (tmux copy-mode) or the app's own
   scroll for those panes. This is the profile's ceiling, not a bug.
2. **`tmux` profile needs Shift+drag to select.** Plain drag goes to tmux; hold
   Shift for native Ghostty selection + cmd+C. Copy-mode scroll has a light mode
   wrapper (`q` to exit) rather than a pure-native feel.
3. **Re-attach required for full effect.** `terminal-overrides` is negotiated at
   client attach; existing clients keep old behavior until they re-attach.

## Why there is a post-mortem

The predecessor of the `ghostty` profile (fusion mode) was designed, tested in
isolation, and deployed — then immediately broke under production load. AI agent
TUIs issue constant terminal round-trips (CPR replies, capability probes); in
fusion mode every machine-generated byte sequence cancelled copy-mode and leaked
protocol fragments into the shell prompt. There is no tmux-layer signal that
distinguishes human keystrokes from machine protocol bytes. The feature class is
structurally incompatible with that environment.

Full evidence and byte-level measurements: [`docs/post-mortem.md`](docs/post-mortem.md).
The harness test T3 (CPR noise immunity) now encodes that failure mode as a
green assertion.

---

*By KaosMaps — [github.com/kaosmaps](https://github.com/kaosmaps). MIT licensed.*
