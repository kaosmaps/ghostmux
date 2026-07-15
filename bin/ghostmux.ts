#!/usr/bin/env bun
/**
 * ghostmux.ts — agent-native profile selector for ghostmux.
 *
 * Zero dependencies: bun + node builtins only. Runs from a fresh clone.
 *
 * Commands:
 *   ghostmux list --json            # /capabilities-style descriptor of BOTH profiles
 *   ghostmux --json                 # alias for `list --json`
 *   ghostmux apply <ghostty|tmux>   # point ~/.tmux.conf at the chosen profile conf
 *   ghostmux apply <p> --config P   # target a specific tmux config file instead
 *   ghostmux apply <p> --print      # print the source-file line + conf, write nothing
 *
 * Errors are structured envelopes on stderr with a non-zero exit:
 *   { "error": { "code": "...", "message": "..." } }
 *
 * Attribution: github.com/kaosmaps — MIT licence.
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ── repo geometry ───────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

// ── profile descriptors (/capabilities surface) ─────────────────────────────

export type Gestures = { scroll: string; select: string; copy: string };

export type Profile = {
  id: "ghostty" | "tmux";
  title: string;
  description: string;
  tmuxConf: string; // repo-relative path
  gestures: Gestures;
  tradeoffs: string[];
};

export const PROFILES: Record<Profile["id"], Profile> = {
  ghostty: {
    id: "ghostty",
    title: "ghostty — Ghostty owns the mouse (append-only / shell-heavy)",
    description:
      "Ghostty owns scroll, selection, and clipboard natively (tmux mouse off; " +
      "tmux kept off the alternate screen so append-only output feeds Ghostty's " +
      "scrollback). Best for shell/append-heavy work.",
    tmuxConf: "tmux/ghostty.conf",
    gestures: {
      scroll:
        "Ghostty native scrollback — clean for shell/append panes, garbled for " +
        "live-TUI panes (use `prefix [` or the app's own scroll there).",
      select: "Plain drag = native Ghostty selection (highlight != copy).",
      copy: "cmd+C / cmd+V — native clipboard copy and bracketed paste.",
    },
    tradeoffs: [
      "Live-TUI panes (Claude Code, vim, lazygit) cannot be trackpad-scrolled " +
        "coherently — a repaint stream is not scrollback-shaped.",
      "Load-bearing companion: Claude Code classic-renderer pin " +
        "(claude/settings.snippet.json) keeps output append-only.",
    ],
  },
  tmux: {
    id: "tmux",
    title: "tmux — tmux owns the mouse (live-TUI-heavy, future-proof)",
    description:
      "tmux owns scroll and selection (mouse on): plain trackpad scroll enters " +
      "copy-mode for coherent history of any pane including live TUIs; Shift+drag " +
      "gives native Ghostty selection + cmd+C/V. Best for live-TUI-heavy work.",
    tmuxConf: "tmux/tmux.conf",
    gestures: {
      scroll:
        "Plain trackpad scroll enters tmux copy-mode — coherent scroll-back of " +
        "any pane, including live TUIs. Exit: scroll to bottom or `q`.",
      select:
        "Shift+drag = native Ghostty selection; plain drag = tmux selection " +
        "into the tmux buffer.",
      copy: "cmd+C / cmd+V after Shift+drag (via Ghostty mouse-shift-capture = never).",
    },
    tradeoffs: [
      "One muscle-memory change: hold Shift to select natively.",
      "Copy-mode scroll has a light mode wrapper (position indicator; `q` to " +
        "exit) rather than a pure-native feel.",
    ],
  },
};

// ── error envelope ──────────────────────────────────────────────────────────

export class CliError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function emitError(code: string, message: string): never {
  process.stderr.write(`${JSON.stringify({ error: { code, message } })}\n`);
  process.exit(1);
}

// ── managed block ─────────────────────────────────────────────────────────────

const MANAGED_START = "# >>> ghostmux profile >>>";
const MANAGED_END = "# <<< ghostmux profile <<<";

export function stripManagedBlock(content: string): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    if (line.trim() === MANAGED_START) {
      inBlock = true;
      continue;
    }
    if (line.trim() === MANAGED_END) {
      inBlock = false;
      continue;
    }
    if (!inBlock) out.push(line);
  }
  return out.join("\n");
}

// ── commands ────────────────────────────────────────────────────────────────

function cmdList(): void {
  const descriptor = {
    tool: "ghostmux",
    description:
      "Ghostty + tmux, two honest UX profiles. Pick by how much of your day is a TUI.",
    profiles: Object.values(PROFILES),
  };
  process.stdout.write(`${JSON.stringify(descriptor, null, 2)}\n`);
}

const REATTACH =
  "Re-attach reminder: run `tmux source-file <target>`, then detach + re-attach " +
  "each client (restart Ghostty is simplest) so client-negotiated state settles.";

function cmdApply(args: string[]): void {
  const profileId = args[0];
  if (profileId === undefined || profileId.startsWith("-")) {
    throw new CliError(
      "MISSING_PROFILE",
      "apply requires a profile: ghostty or tmux (usage: ghostmux apply <ghostty|tmux> [--config <path>] [--print])",
    );
  }
  if (profileId !== "ghostty" && profileId !== "tmux") {
    throw new CliError(
      "UNKNOWN_PROFILE",
      `unknown profile '${profileId}' — valid profiles are: ghostty, tmux`,
    );
  }

  // parse flags after the profile id
  let configPath: string | undefined;
  let printOnly = false;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--print") {
      printOnly = true;
    } else if (arg === "--config") {
      const value = args[i + 1];
      if (value === undefined) {
        throw new CliError("MISSING_CONFIG_VALUE", "--config requires a path argument");
      }
      if (value === "-") {
        printOnly = true;
      } else {
        configPath = value;
      }
      i++;
    } else {
      throw new CliError("UNKNOWN_FLAG", `unknown flag '${arg}'`);
    }
  }

  const profile = PROFILES[profileId];
  const confAbs = resolve(REPO_ROOT, profile.tmuxConf);
  if (!existsSync(confAbs)) {
    throw new CliError("PROFILE_CONF_MISSING", `profile conf not found on disk: ${confAbs}`);
  }

  const sourceLine = `source-file ${confAbs}`;
  const block = `${MANAGED_START}\n# profile: ${profile.id}\n${sourceLine}\n${MANAGED_END}\n`;

  if (printOnly) {
    process.stdout.write(`${block}\n${REATTACH}\n`);
    return;
  }

  const target = configPath ? resolve(configPath) : resolve(homedir(), ".tmux.conf");
  let existing = "";
  if (existsSync(target)) {
    existing = readFileSync(target, "utf8");
    copyFileSync(target, `${target}.bak`);
  }
  const cleaned = stripManagedBlock(existing).replace(/\n+$/, "");
  const next = cleaned.length > 0 ? `${cleaned}\n\n${block}` : block;
  writeFileSync(target, next);

  process.stdout.write(
    `${JSON.stringify({
      applied: profile.id,
      target,
      sourced: confAbs,
      backup: existing ? `${target}.bak` : null,
    })}\n${REATTACH}\n`,
  );
}

// ── entrypoint ──────────────────────────────────────────────────────────────

export function main(argv: string[]): void {
  if (argv.length === 0) {
    emitError(
      "USAGE",
      "no command given — usage: ghostmux list --json | ghostmux apply <ghostty|tmux> [--config <path>] [--print]",
    );
  }

  const first = argv[0];

  if (first === "--json" || first === "list") {
    cmdList();
    return;
  }

  if (first === "apply") {
    try {
      cmdApply(argv.slice(1));
    } catch (error) {
      if (error instanceof CliError) emitError(error.code, error.message);
      emitError("INTERNAL", (error as Error).message);
    }
    return;
  }

  emitError("UNKNOWN_COMMAND", `unknown command '${first}' — valid commands: list, apply`);
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
