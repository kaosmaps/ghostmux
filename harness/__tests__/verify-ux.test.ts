/**
 * Static guards for the verify-ux.ts harness.
 *
 * The harness itself (verify-ux.ts) is a LIVE tmux integration proof that needs
 * tmux + script(1); these tests are fast static checks that do NOT spawn tmux.
 * They lock in the shipped-artifact wiring: the harness must point at the
 * `ghostty` profile conf that actually exists on disk.
 *
 * Zero deps: bun:test + node builtins.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HARNESS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(HARNESS_DIR, "..");
const harnessSrc = readFileSync(resolve(HARNESS_DIR, "verify-ux.ts"), "utf8");

describe("verify-ux harness wiring", () => {
  test("references the ghostty profile conf, not the old ghostty-native name", () => {
    expect(harnessSrc).toContain('"ghostty.conf"');
    expect(harnessSrc).not.toContain("ghostty-native.conf");
  });

  test("the conf the harness resolves actually exists on disk", () => {
    expect(existsSync(resolve(REPO_ROOT, "tmux", "ghostty.conf"))).toBe(true);
  });
});

describe("shipped profile confs", () => {
  test("ghostty.conf carries the mouse-off bundle facts asserted by T1", () => {
    const conf = readFileSync(resolve(REPO_ROOT, "tmux", "ghostty.conf"), "utf8");
    expect(conf).toContain("set -g mouse off");
    expect(conf).toContain("smcup@");
    expect(conf).toContain("set -g set-clipboard on");
    expect(conf).toContain("set -g history-limit 100000");
  });

  test("tmux.conf carries the mouse-on bundle facts", () => {
    const conf = readFileSync(resolve(REPO_ROOT, "tmux", "tmux.conf"), "utf8");
    expect(conf).toContain("set -g mouse on");
    expect(conf).toContain("setw -g mode-keys vi");
    expect(conf).toContain("MouseDragEnd1Pane send-keys -X copy-selection-no-clear");
    expect(conf).toContain("WheelUpPane");
    // no alternate-screen suppression override in this profile (comments may mention it)
    expect(conf).not.toContain("terminal-overrides");
  });
});
