# claude/ — Claude Code renderer pin

`settings.snippet.json` contains a single key:

```json
{ "tui": "default" }
```

Merge it into your Claude Code `settings.json`. It pins Claude Code to its
**classic (append-only) renderer** instead of the newer fullscreen TUI.

## Why this exists (the TUI-rerendering context)

Terminals have two output models:

- **Append-only** — each line is printed once and scrolls upward forever. The
  terminal's own scrollback captures everything losslessly.
- **Repaint / fullscreen TUI** — the app owns a fixed grid and overwrites it in
  place (spinners, live input boxes, streaming tokens, status bars). What
  reaches the terminal's native scrollback is a *record of repaints*, which
  renders as garble. No terminal can reconstruct clean history from that; the
  information isn't there.

Recent Claude Code versions default to a fullscreen TUI. Pinning
`"tui": "default"` keeps Claude's output **append-only**.

## When it is load-bearing

- **`ghostty` profile** — **load-bearing.** That profile lets Ghostty's native
  scrollback own history. Native scrollback is only coherent for append-only
  output, so Claude must stay on the classic renderer or its scroll-back
  garbles.
- **`tmux` profile** — **harmless, not required.** There the mouse is routed to
  the app and tmux's copy-mode (which models the grid) gives coherent history
  regardless of renderer. Claude's own fullscreen renderer + scroll work fine.
  The pin does no harm if left in place.

If you run the `ghostty` profile, apply this. If you run only the `tmux`
profile, it is optional.
