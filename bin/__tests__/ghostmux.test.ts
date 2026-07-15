/**
 * Tests for the ghostmux agent-native selector.
 * Zero deps: bun:test + node builtins. Spawns the real CLI (fresh-clone safe).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "ghostmux.ts");

async function run(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(["bun", CLI, ...args], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { stdout, stderr, code };
}

describe("list", () => {
  test("list --json emits valid JSON with both profiles", async () => {
    const { stdout, code } = await run(["list", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    const ids = parsed.profiles.map((p: { id: string }) => p.id).sort();
    expect(ids).toEqual(["ghostty", "tmux"]);
    for (const p of parsed.profiles) {
      expect(typeof p.title).toBe("string");
      expect(typeof p.description).toBe("string");
      expect(typeof p.tmuxConf).toBe("string");
      expect(typeof p.gestures.scroll).toBe("string");
      expect(typeof p.gestures.select).toBe("string");
      expect(typeof p.gestures.copy).toBe("string");
      expect(Array.isArray(p.tradeoffs)).toBe(true);
    }
  });

  test("bare --json is an alias for list --json", async () => {
    const { stdout, code } = await run(["--json"]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout).profiles).toHaveLength(2);
  });
});

describe("apply error envelopes", () => {
  test("apply bogus returns structured error envelope + non-zero exit", async () => {
    const { stdout, stderr, code } = await run(["apply", "bogus"]);
    expect(code).not.toBe(0);
    const parsed = JSON.parse(stderr || stdout);
    expect(parsed.error.code).toBe("UNKNOWN_PROFILE");
    expect(typeof parsed.error.message).toBe("string");
  });

  test("apply with no profile errors", async () => {
    const { stderr, code } = await run(["apply"]);
    expect(code).not.toBe(0);
    expect(JSON.parse(stderr).error.code).toBe("MISSING_PROFILE");
  });

  test("unknown command errors", async () => {
    const { stderr, code } = await run(["frobnicate"]);
    expect(code).not.toBe(0);
    expect(JSON.parse(stderr).error.code).toBe("UNKNOWN_COMMAND");
  });

  test("no command errors", async () => {
    const { stderr, code } = await run([]);
    expect(code).not.toBe(0);
    expect(JSON.parse(stderr).error.code).toBe("USAGE");
  });
});

describe("apply", () => {
  test("apply --print writes nothing and prints a source-file line", async () => {
    const { stdout, code } = await run(["apply", "ghostty", "--print"]);
    expect(code).toBe(0);
    expect(stdout).toContain("source-file");
    expect(stdout).toContain("tmux/ghostty.conf");
    expect(stdout.toLowerCase()).toContain("re-attach");
  });

  test("apply <profile> --config <path> writes a source-file line to the target", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gmx-apply-"));
    const target = join(dir, ".tmux.conf");
    try {
      const { code } = await run(["apply", "tmux", "--config", target]);
      expect(code).toBe(0);
      const written = readFileSync(target, "utf8");
      expect(written).toContain("source-file");
      expect(written).toContain("tmux/tmux.conf");
      expect(written).toContain("# profile: tmux");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("re-applying replaces the managed block (idempotent, single block)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gmx-apply-"));
    const target = join(dir, ".tmux.conf");
    try {
      await run(["apply", "ghostty", "--config", target]);
      await run(["apply", "tmux", "--config", target]);
      const written = readFileSync(target, "utf8");
      const blocks = written.split("# >>> ghostmux profile >>>").length - 1;
      expect(blocks).toBe(1);
      expect(written).toContain("tmux/tmux.conf");
      expect(written).not.toContain("tmux/ghostty.conf");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
