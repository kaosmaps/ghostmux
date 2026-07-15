# Post-mortem: why fusion mode was withdrawn

**Date**: 2026-06-10
**Stack**: Ghostty 1.3.1 + tmux 3.5a, macOS

## What fusion mode was

A tmux UX mode that tried to make tmux sessions behave like a native terminal
for everyday interactions — smooth trackpad scrolling, drag-to-select with
immediate clipboard copy, cmd+C / cmd+V — while keeping tmux sessions intact.

The core mechanism: every unrecognised key in copy-mode was bound to
`send-keys -X cancel ; send-keys -- <key>` (a "type-to-exit" approach). About
90 generated bindings covered printable ASCII; an `Any` catch-all handled
the rest. Wheel-up entered copy-mode; typing any key exited it and let the
keystroke through to the shell.

In a sterile test environment, this worked. In production, it failed
immediately.

## The failure mode

The workflow these sessions run is AI-agent-heavy: long-running agent loops
that render TUI updates, issue progress bars, and continuously probe their
own terminal state. Standard terminal protocol includes:

- **CPR** (Cursor Position Report, `ESC[row;colR`) — terminals reply to
  `ESC[6n` probes with the cursor's current position
- **DECRQM** responses — replies to mode interrogation sequences
- **Kitty-protocol capability probes** — `ESC[?u` queries with `ESC[?...c`
  replies

These replies arrive through the same file descriptor — the tty connected to
the tmux client — as human keystrokes. tmux's key dispatcher cannot
distinguish them.

**Measurement**: while a pane was in copy-mode (scroll-view), a single
CPR reply of `ESC[12;34R` was injected via `send-keys -H 1b 5b 31 32 3b 33
34 52` in a nested-tmux test rig (outer client delivering bytes to inner
server's input path). Result:

1. `pane_in_mode` dropped from `1` to `0` — copy-mode was cancelled.
2. `capture-pane` on the last 20 lines showed `12;34R` in the shell prompt.

In production, with agents generating CPRs every few seconds:
- Every time the user scrolled up to check history, the view snapped back to
  the bottom within seconds (next CPR reply cancelled copy-mode).
- Fragments like `12;34R` appeared at the prompt between agent outputs.

## Why it is unsalvageable at the tmux layer

tmux processes all input on a single dispatch path. There is no API, option,
or flag to mark a byte sequence as "protocol response, not a key". The
`Any` catch-all binding is not a solution: `assume-paste-time` bypasses it
for bracketed paste, and CPR/DECRQM replies are not bracketed. The problem
is architectural: fusion requires distinguishing machine bytes from human
bytes, and that distinction does not exist in the tmux input model.

No amount of tuning the binding table fixes this. The feature class is
structurally incompatible with terminals that do ongoing capability probing.

## What replaced it

**the `ghostty` profile**: tmux mouse off, `smcup@/rmcup@` override.

The insight: Ghostty 1.3.1 saves region-scrolled lines to scrollback. With a
status bar enabled, tmux scrolls a *region* (not the full screen); historically
many terminals discarded region-scrolled content from scrollback. Ghostty does
not — verified by scrolling through 1,500+ lines of history on a live probe
window with the status bar active.

With `mouse off` and `smcup@/rmcup@`:

- tmux never enters the alternate screen — pane output streams directly into
  Ghostty's scrollback buffer
- tmux never intercepts mouse events — all scroll, select, and copy goes
  through Ghostty's native path
- CPR replies, DECRQM responses, kitty probes: tmux still receives them (it
  needs to respond to its own terminal probes) but they never touch copy-mode
  because there are **no custom copy-mode bindings**

The tradeoff is that intentional copy-mode (`prefix+[`) is still available as
a fallback — good for deep pre-attach history or search — but it is no longer
the primary interaction path. Primary path is now: trackpad scroll, drag to
select, cmd+C, cmd+V. Exactly like a plain terminal.

The nested-tmux test rig (T3 in the harness) confirms: inject the same CPR
burst into a `ghostty`-profile session in copy-mode — `pane_in_mode` stays `1`,
no `12;34R` fragment in the prompt. Zero configuration change required to
achieve this; it falls out of having no type-to-exit bindings.

## What this tells us about terminal UX design

Three lessons, stated as empirical rules:

1. **Verify under production noise, not in sterile harnesses.** Fusion passed
   every synthetic test. The byte-injection harness T3 would have caught it
   before rollout — but only if the test injected CPR replies, not just
   printable ASCII.

2. **Design for the observed workflow, not the generic user.** The generic
   objection to `smcup@/rmcup@` is "multi-window scrollback interleaving" and
   "region-scroll not saved to scrollback". Neither applies here: the workflow
   is one session per Ghostty surface, one window, and Ghostty 1.3.1 saves
   region-scrolled lines. The generic objection was not wrong — it was wrong
   *for this workflow*.

3. **Platform-UX-changing defaults are the user's call.** Fusion enabled
   `mouse on`, `copy-on-select = clipboard`, and auto-exit-on-typing. All
   of these change how a native macOS terminal user expects their mouse and
   clipboard to behave. The design should have surfaced these as explicit
   choices rather than embedding them as defaults.

---

*By KaosMaps — github.com/kaosmaps*
