# ghostmux harness — nested-tmux byte-injection testing

## What this is

`verify-ux.ts` is a standalone Bun script that proves the ghostty-native UX
config does what it claims, using live tmux processes — not mocks.

The technique: an **outer tmux server** hosts a pane whose process is an
attached client of an **inner tmux server** loaded with the config under test.
Raw bytes injected via `send-keys -H` into the outer pane traverse the inner
client's real input path — including SGR mouse sequences, CPR replies, and
bracketed paste — exactly as they would from a real keyboard or a terminal
application. Assertions query the inner server directly with `display-message`,
`capture-pane`, and `show-buffer`.

This turns trackpad-and-clipboard UX — which is normally subjective and
hard to automate — into scriptable assertions with byte-level precision.

## Why it exists

The predecessor of this config (fusion mode) was built and verified in a
sterile harness, then failed on the live system. The failure mode: agent TUI
applications generate constant terminal round-trips. CPR replies
(`ESC[12;34R`), DECRQM responses, and kitty-protocol probes arrive through
the same input path as human keystrokes. In fusion mode, every unrecognised
byte triggered a "type-to-exit" copy-mode binding — so every agent round-trip
yanked the scroll position to the bottom and leaked protocol fragments
(`12;34R`) into the shell prompt. There is no tmux-layer signal that
distinguishes machine bytes from human keys.

The nested-tmux technique can reproduce this exactly: inject a CPR burst via
`send-keys -H` and assert whether copy-mode survives (T3). ghostty-native
passes; fusion failed. The harness makes "survives agent TUI noise" a green
test, not a subjective claim.

## What each test proves

| Test | Claim proved |
|------|-------------|
| T1.1 | The shipped `../tmux/ghostty-native.conf` is a valid tmux config that a scratch server can load without errors. |
| T1.2 | The config adds **zero** custom copy-mode-vi key bindings (key count equals a vanilla `/dev/null` server). This is the core architectural claim: no key-binding layer means no key-binding failure modes. |
| T1.3 | `mouse off` — Ghostty, not tmux, handles all mouse events. |
| T1.4 | `set-clipboard on` — OSC 52 clipboard path is active for intentional copy-mode (`prefix+[`, press `y`). |
| T1.5 | `history-limit 100000` — 100k lines of tmux history available as a fallback via `prefix+[`. |
| T1.6 | `terminal-overrides` contains `smcup@` — the alternate-screen suppression override is present. |
| T2.1 | **Oracle control arm**: a client with no `smcup@` override does send `ESC[?1049h` (alternate-screen enter). Proves the test infrastructure is real; if this fails, terminfo for `xterm-ghostty` is missing on the host. |
| T2.2 | **Alternate-screen byte oracle**: a client loading `ghostty-native.conf` does **not** send `ESC[?1049h`. Proves the `smcup@` override suppresses alternate-screen switching at the byte level. |
| T3.0 | Server-side `copy-mode` command enters copy-mode (`pane_in_mode=1`). |
| T3.1 | **CPR noise immunity**: injecting `ESC[12;34R` (cursor-position report) via the outer client does not cancel copy-mode in the inner server. This is the regression class that killed fusion mode. |
| T3.2 | Copy-mode exits cleanly on a server-side `send-keys -X cancel`. |
| T3.3 | No `12;34R` fragment appears in the shell prompt after the CPR burst — no prompt pollution. |
| T4.1 | Bracketed paste (`ESC[200~echo native-ok ESC[201~`) arrives at the shell prompt intact. |
| T4.2 | Multiline bracketed paste through `cat -v` produces no CSI-u artifacts — tmux extended-keys bug #4663 does not trigger (because `extended-keys` is not set to `always` in this config). |
| T4.3 | Bracketed paste markers were received (not silently discarded). |
| T5.0 | Copy-mode can be entered for the y-copy fallback test. |
| T5.1 | `tmux show-buffer` returns non-empty text after a copy-mode selection — proving that intentional copy-mode (`prefix+[`, select with arrow keys, `copy-selection-and-cancel`) works and reaches the tmux buffer (which in turn reaches the system clipboard via OSC 52). |
| T6.0 | **Pure plan check**: `planClientRefresh` skips non-tty clients (`client-12345` style) with reason `"control-mode or non-tty client"`. No server needed. |
| T6.1–T6.5 | **Hard-refresh live proof**: `refreshTmuxClients` calls `detach-client -E` on a real attached tty client; the client process restarts on the same tty; `client_created` advances (or equals, if instantaneous); the outer server pane remains alive. This matches the mechanism used to re-negotiate `terminal-overrides` on live sessions without closing Ghostty windows. |

## How to run

```sh
# From the repo root:
bun harness/verify-ux.ts

# Or with verbose output already shown (all output goes to stdout/stderr):
bun harness/verify-ux.ts 2>&1 | tee /tmp/ghostmux-verify.log
```

Exit code 0 = all tests passed. Exit code 1 = at least one FAILED.

## Requirements

- **bun** — https://bun.sh (used for its sync subprocess helpers; no npm)
- **tmux >= 3.5a** — the `terminal-overrides` syntax with `@`-suppression and
  the `send-keys -H` hex injection are both 3.x features; 3.5a is the
  verified minimum
- **script(1)** — standard POSIX utility (`util-linux` on Linux, BSD `script`
  on macOS); used by T2 to capture raw bytes from a client attach
- **macOS or Linux** — tty path detection (`/dev/tty*`) assumes a POSIX
  filesystem; WSL may work but is untested

The harness uses only `-L <socket>` scratch servers (named `gmx-*`). It
**never touches the default tmux server** and **never modifies any dotfiles**.
All state is cleaned up on exit, including on failure.
