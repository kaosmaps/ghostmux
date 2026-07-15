# zsh/bindkeys.zsh — vi-mode home/end fix for the `ghostty` profile tmux UX
#
# Source this from ~/.zshrc (or paste the two bindkey lines directly):
#   source ~/.config/ghostmux/zsh/bindkeys.zsh
#
# Why this is needed:
#   When EDITOR=nvim (or any $EDITOR containing "vi"), zsh activates its vi
#   keymap. In vi-insert mode (viins), ctrl+A and ctrl+E self-insert the
#   literal characters ^A and ^E instead of jumping to line start/end.
#
#   Ghostty sends ctrl+A for cmd+left and ctrl+E for cmd+right (the default
#   macOS line-navigation keybinds). Without these bindkeys, cmd+left and
#   cmd+right type garbage at the prompt even in a plain Ghostty window —
#   and even more confusingly, they worked fine before switching to vi mode.
#
#   The fix: re-bind ^A and ^E in the viins keymap to their readline actions.
#   This has no effect in emacs mode (bindkey -e), where these are already
#   bound. It does not affect vi normal mode (vicmd) — there ^A increments
#   a number and ^E is unused, both unrelated to line navigation.

bindkey -M viins '^A' beginning-of-line
bindkey -M viins '^E' end-of-line
