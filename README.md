# ghostmux — Ghostty + tmux, without the fight

Smooth trackpad scroll, native drag/double-click/triple-click selection, cmd+C
/ cmd+V, cmd+left / cmd+right at the prompt — exactly as in a plain Ghostty
window, with tmux sessions running underneath.

No plugins. No key bindings. No copy-mode in the daily path.

---

## What you get

| Interaction | How it works |
|---|---|
| Trackpad / wheel scroll | Ghostty native scrollback — smooth, no snapping, no mode to enter or exit |
| Drag to highlight | Ghostty native selection — highlight ≠ copy (macOS default restored) |
| Double-click word, triple-click line | Ghostty native |
| cmd+C | Ghostty native clipboard copy |
| cmd+V | Ghostty bracketed paste — no corruption, no silent discard |
| cmd+left / cmd+right | Sends ctrl+A / ctrl+E; the zsh bindkeys fix makes them work in vi mode |
| Deep pre-attach history | `prefix+[` (tmux copy-mode with vi keys, `y` → clipboard via OSC 52) |
| Sessions, persistence, status bar | tmux — completely unchanged |
| Shift+drag inside vim / htop | Ghostty native (`mouse-shift-capture = never`) |

---

## Three paste-ready blocks

### 1. tmux — add to `~/.tmux.conf`

```tmux
source-file ~/.config/ghostmux/tmux/ghostty-native.conf
```

Or paste the contents of `tmux/ghostty-native.conf` directly.

Reload with: `tmux source-file ~/.tmux.conf`

Existing attached clients keep the old behaviour until they re-attach. To
apply immediately, restart Ghostty (simplest) or run:

```sh
tmux list-clients -F '#{client_name}|#{session_name}' | while IFS='|' read c s; do
  tmux detach-client -t "$c" -E "tmux attach -t '$s'"
done
```

### 2. Ghostty — add to `~/.config/ghostty/config`

```ghostty
scrollback-limit = 100000000
mouse-shift-capture = never
# Remove this line if present: copy-on-select = clipboard
```

See `ghostty/config` for full comments explaining each line.

Reload: cmd+shift+, (reload_config). New windows pick up the new scrollback
limit; existing windows keep their previous buffer.

### 3. zsh — add to `~/.zshrc`

```zsh
bindkey -M viins '^A' beginning-of-line
bindkey -M viins '^E' end-of-line
```

Only needed if `$EDITOR` contains `vi` (e.g. `EDITOR=nvim`). This fixes
cmd+left / cmd+right in vi insert mode; it has no effect in emacs mode.

See `zsh/bindkeys.zsh` for a self-contained sourceable file.

---

## Verify

```sh
bun harness/verify-ux.ts
```

Requires bun, tmux >= 3.5a, script(1). Uses only scratch tmux sockets (`-L gmx-*`);
never touches your default server or any dotfiles. See `harness/README.md` for
what each test proves.

---

## How it works

Two tmux options do all the work:

```tmux
set -g mouse off
set -as terminal-overrides ',xterm-ghostty:smcup@:rmcup@'
```

**`mouse off`** — tmux never intercepts mouse events. Every wheel tick, click,
and drag goes to Ghostty, which handles them natively.

**`smcup@:rmcup@`** — removes the "enter/exit alternate screen" capability for
`xterm-ghostty` clients. Normally tmux switches to the alternate screen on
client attach, hiding the terminal's scrollback. With this override it does
not: pane output streams into Ghostty's own scrollback buffer and stays there.

The decisive fact that makes this work: **Ghostty 1.3.1 saves region-scrolled
lines to scrollback**. tmux with a status bar scrolls a *region* (not the full
screen); many terminals discard region-scrolled lines. Ghostty does not.
Verified on a live probe with 1,500+ lines of region-scrolled history,
status bar active, `smcup@/rmcup@` override applied.

### What each layer owns

| Interaction | Owner | Mechanism |
|---|---|---|
| Wheel / trackpad scroll | Ghostty | native scrollback (region scrolls saved) |
| Highlight (drag / double / triple-click) | Ghostty | native selection; select ≠ copy |
| cmd+C / cmd+V | Ghostty / macOS | native clipboard; paste = bracketed paste |
| cmd+left / cmd+right | Ghostty default keybinds | sends ctrl+A / ctrl+E |
| Deep pre-attach history | tmux | `prefix+[` (vi copy-mode, `y` → OSC 52) |
| Sessions, persistence, status bar | tmux | unchanged |
| Shift+drag in mouse-capturing TUIs | Ghostty | `mouse-shift-capture = never` |

---

## Known trade-offs

1. **Pre-attach history** — history from before a Ghostty window attached (or
   after tmux-resurrect restore) is not in Ghostty's buffer. It lives in tmux
   history; reach it with `prefix+[`.

2. **Multi-window scrollback interleaving** — if you use multiple windows in
   one session, their output streams interleave in Ghostty's buffer. This is
   irrelevant for a one-window-per-surface workflow; it matters if you switch
   windows frequently in a single Ghostty tab.

3. **TUI content remains in scrollback after exit** — full-screen apps (vim,
   less) no longer use the outer alternate screen, so their content scrolls
   into Ghostty's buffer and stays there after exit. Cosmetic only.

4. **Re-attach required for full effect** — `terminal-overrides` is negotiated
   at client attach. Existing clients keep the alternate screen until they
   re-attach. Restart Ghostty or run the per-client refresh command above.

---

## Why there is a post-mortem

The predecessor of this config (fusion mode) was designed, tested in
isolation, and deployed — then immediately broke under production load. The
failure mode: AI agent TUIs issue constant terminal round-trips (CPR replies,
capability probes). In fusion mode, every machine-generated byte sequence
cancelled copy-mode and leaked protocol fragments into the shell prompt. There
is no tmux-layer signal that distinguishes human keystrokes from machine
protocol bytes. The feature class is structurally incompatible with that
environment.

Full evidence and byte-level measurements: [`docs/post-mortem.md`](docs/post-mortem.md).

The harness test T3 (CPR noise immunity) now encodes this failure mode as a
green assertion.

---

*By KaosMaps — [github.com/kaosmaps](https://github.com/kaosmaps). No stars requested.*
