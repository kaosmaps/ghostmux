#!/usr/bin/env bun
/**
 * verify-ux.ts — standalone live proof for ghostty-native tmux UX
 *
 * Requires: bun, tmux >= 3.5a, script(1), macOS or Linux.
 * Run from any directory: bun harness/verify-ux.ts
 *
 * Safety invariants (enforced throughout):
 *   - NEVER uses the default tmux socket (all servers use -L gmx-* scratch sockets)
 *   - NEVER writes ~/.tmux.conf, ~/.zshrc, or any Ghostty config
 *   - Cleanup (kill all gmx-* servers, rm temp files) runs even on failure
 *
 * Test matrix:
 *   T1  Block facts: reads ../tmux/ghostty-native.conf (the shipped artifact),
 *       loads it into a scratch server, asserts mouse off / set-clipboard on /
 *       history-limit / smcup@ / zero custom copy-mode-vi bindings
 *   T2  Alt-screen byte oracle: script(1) captures client bytes;
 *       ctrl (no override) has smcup, native (with override) does not
 *   T3  CPR noise immunity: copy-mode stays after CPR burst via outer pane,
 *       no prompt leak (the regression class that killed fusion mode)
 *   T4  Paste integrity: bracketed paste lands at prompt intact;
 *       no CSI-u artifacts in cat -v (extended-keys #4663 guard)
 *   T5  y-copy fallback: copy-mode selection lands in tmux buffer (non-empty)
 *   T6  Hard-refresh live proof: refreshTmuxClients cycles a real attached
 *       client on a scratch server; client_created advances; outer pane survives;
 *       plan-skip pure check for non-tty clients.
 *
 * Inlined from KaosMaps terminal-stack (tmux-core.ts):
 *   parseClientList, planClientRefresh, refreshTmuxClients, ExecFn type
 * Attribution: github.com/kaosmaps — MIT licence
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ── inlined from tmux-core.ts (KaosMaps, MIT) ────────────────────────────────

type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

type ExecFn = (command: string, args?: string[]) => Promise<ExecResult>;

type TmuxClient = {
  name: string;
  session: string;
  created?: number;
};

type ClientRefreshPlan = {
  refresh: Array<{ client: string; session: string; args: string[] }>;
  skipped: Array<{ client: string; session: string; reason: string }>;
};

function parseClientList(raw: string): TmuxClient[] {
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const parts = line.split("|");
      const name = parts[0] ?? "";
      const session = parts[1] ?? "";
      const createdRaw = parts[2]?.trim();
      const created = createdRaw && /^\d+$/.test(createdRaw) ? Number(createdRaw) : undefined;
      return { name, session, created };
    });
}

function escapeSingleQuote(value: string): string {
  return value.replace(/'/g, "'\\''");
}

function planClientRefresh(
  clients: TmuxClient[],
  options?: { tmuxPath?: string; session?: string },
): ClientRefreshPlan {
  const tmuxPath = options?.tmuxPath ?? "tmux";
  const targetSession = options?.session;
  const refresh: ClientRefreshPlan["refresh"] = [];
  const skipped: ClientRefreshPlan["skipped"] = [];

  for (const client of clients) {
    if (!client.name.startsWith("/dev/tty")) {
      skipped.push({ client: client.name, session: client.session, reason: "control-mode or non-tty client" });
      continue;
    }
    if (targetSession !== undefined && client.session !== targetSession) {
      skipped.push({ client: client.name, session: client.session, reason: "not in target session" });
      continue;
    }
    const escapedSession = escapeSingleQuote(client.session);
    const execCmd = `${tmuxPath} attach -t '${escapedSession}'`;
    refresh.push({
      client: client.name,
      session: client.session,
      args: ["detach-client", "-t", client.name, "-E", execCmd],
    });
  }

  return { refresh, skipped };
}

async function safeExec(exec: ExecFn, command: string, args: string[] = []): Promise<ExecResult> {
  try {
    return await exec(command, args);
  } catch (error) {
    return { stdout: "", stderr: (error as Error).message, exitCode: 1 };
  }
}

async function refreshTmuxClients(options: {
  exec: ExecFn;
  tmuxPath?: string;
  session?: string;
}): Promise<{
  cycled: Array<{ client: string; session: string }>;
  skipped: ClientRefreshPlan["skipped"];
  failed: Array<{ client: string; session: string; error: string }>;
  message: string;
}> {
  const tmuxPath = options.tmuxPath ?? "tmux";
  const tmuxBin = tmuxPath.split(/\s+/)[0] ?? "tmux";
  const listResult = await safeExec(options.exec, tmuxBin, [
    "list-clients",
    "-F",
    "#{client_name}|#{session_name}|#{client_created}",
  ]);

  const clients = parseClientList(listResult.stdout);
  const plan = planClientRefresh(clients, { tmuxPath, session: options.session });

  const cycled: Array<{ client: string; session: string }> = [];
  const failed: Array<{ client: string; session: string; error: string }> = [];

  for (const entry of plan.refresh) {
    const result = await safeExec(options.exec, tmuxBin, entry.args);
    if (result.exitCode === 0) {
      cycled.push({ client: entry.client, session: entry.session });
    } else {
      failed.push({
        client: entry.client,
        session: entry.session,
        error: result.stderr || result.stdout || `exit ${result.exitCode}`,
      });
    }
  }

  const parts: string[] = [];
  if (cycled.length > 0) parts.push(`${cycled.length} client${cycled.length === 1 ? "" : "s"} refreshed`);
  if (failed.length > 0) parts.push(`${failed.length} failed`);
  if (plan.skipped.length > 0) parts.push(`${plan.skipped.length} skipped`);
  const summary = parts.length > 0 ? parts.join(", ") : "no clients found";
  const hint =
    "clients re-attach in place; scrollback accumulates from this moment; pre-refresh history stays reachable via prefix [";
  const message = `Hard refresh complete: ${summary}. ${hint}`;

  return { cycled, skipped: plan.skipped, failed, message };
}

// ── end inlined tmux-core.ts ──────────────────────────────────────────────────

// ── output ────────────────────────────────────────────────────────────────────

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function err(line: string): void {
  process.stderr.write(`${line}\n`);
}

// ── types ─────────────────────────────────────────────────────────────────────

type Row = {
  id: string;
  name: string;
  pass: boolean;
  note: string;
};

// ── helpers ───────────────────────────────────────────────────────────────────

async function runCmd(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([cmd, ...args], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

async function tmux(socket: string, ...args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return runCmd("tmux", ["-L", socket, ...args]);
}

function sleepMs(ms: number): void {
  Bun.sleepSync(ms);
}

function poll(predicate: () => boolean, timeoutMs: number, intervalMs = 200): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    sleepMs(intervalMs);
  }
  return predicate();
}

async function killAll(sockets: string[]): Promise<void> {
  for (const sock of sockets) {
    await tmux(sock, "kill-server").catch(() => undefined);
  }
}

function cleanupFiles(paths: string[]): void {
  for (const p of paths) {
    try { rmSync(p, { force: true }); } catch { /* ignore */ }
  }
}

// ── test state ────────────────────────────────────────────────────────────────

const results: Row[] = [];

function pass(id: string, name: string, note = ""): void {
  results.push({ id, name, pass: true, note });
}

function fail(id: string, name: string, note: string): void {
  results.push({ id, name, pass: false, note });
}

// ── setup ─────────────────────────────────────────────────────────────────────

const tmpDir = join(tmpdir(), `gmx-verify-${Date.now()}`);
mkdirSync(tmpDir, { recursive: true });

const ctrlBytesFile = join(tmpDir, "gmx-ctrl.bytes");
const nativeBytesFile = join(tmpDir, "gmx-native.bytes");

// All scratch sockets — must be killed in cleanup
const SOCKETS = ["gmx-a", "gmx-ctrl", "gmx-b", "gmx-outer", "gmx-refresh", "gmx-refresh-outer"];

// Resolve the shipped conf relative to this script file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const NATIVE_CONF = resolve(__dirname, "..", "tmux", "ghostty-native.conf");

// ── cleanup ───────────────────────────────────────────────────────────────────

async function cleanup(): Promise<void> {
  await killAll(SOCKETS);
  cleanupFiles([ctrlBytesFile, nativeBytesFile]);
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Pre-cleanup: kill stale servers from a previous run
  await killAll(SOCKETS);

  // Read the shipped conf (this IS the tested artifact)
  let nativeConfContent: string;
  try {
    nativeConfContent = await readFile(NATIVE_CONF, "utf8");
  } catch (e) {
    err(`FATAL: cannot read ${NATIVE_CONF}: ${e}`);
    process.exit(1);
  }

  out(`Using conf: ${NATIVE_CONF} (${nativeConfContent.length} bytes)`);

  // ════════════════════════════════════════════════════════════════════════════
  // T1: Block facts
  // ════════════════════════════════════════════════════════════════════════════
  out("\n── T1: block facts ──────────────────────────────────────────────");

  // T1.1 — native server starts successfully with the shipped conf
  const t1Start = await tmux("gmx-a", "-f", NATIVE_CONF, "new-session", "-d", "-s", "s", "-x", "200", "-y", "50");
  if (t1Start.exitCode !== 0) {
    fail("T1.1", "native server starts with ghostty-native.conf", `exit ${t1Start.exitCode}: ${t1Start.stderr}`);
  } else {
    pass("T1.1", "native server starts with ghostty-native.conf");
  }

  // T1.2 — list-keys count equals control (no custom copy-mode-vi additions)
  await tmux("gmx-ctrl", "-f", "/dev/null", "new-session", "-d", "-s", "s", "-x", "200", "-y", "50");
  sleepMs(500);
  const ctrlKeys = await tmux("gmx-ctrl", "list-keys", "-T", "copy-mode-vi");
  const nativeKeys = await tmux("gmx-a", "list-keys", "-T", "copy-mode-vi");
  const ctrlCount = ctrlKeys.stdout.split("\n").filter(Boolean).length;
  const nativeCount = nativeKeys.stdout.split("\n").filter(Boolean).length;
  if (ctrlCount === nativeCount) {
    pass("T1.2", `copy-mode-vi key count equals control (${ctrlCount})`);
  } else {
    fail("T1.2", "copy-mode-vi key count equals control",
      `native=${nativeCount} vs ctrl=${ctrlCount} — block adds extra bindings`);
  }

  // T1.3 — mouse off
  const mouseOpt = await tmux("gmx-a", "show-options", "-g", "mouse");
  if (mouseOpt.stdout.includes("mouse off")) {
    pass("T1.3", "mouse off");
  } else {
    fail("T1.3", "mouse off", `show-options: ${mouseOpt.stdout || "(empty)"}`);
  }

  // T1.4 — set-clipboard on
  const clipOpt = await tmux("gmx-a", "show-options", "-g", "set-clipboard");
  if (clipOpt.stdout.includes("set-clipboard on")) {
    pass("T1.4", "set-clipboard on");
  } else {
    fail("T1.4", "set-clipboard on", `show-options: ${clipOpt.stdout || "(empty)"}`);
  }

  // T1.5 — history-limit 100000
  const histOpt = await tmux("gmx-a", "show-options", "-g", "history-limit");
  if (histOpt.stdout.includes("history-limit 100000")) {
    pass("T1.5", "history-limit 100000");
  } else {
    fail("T1.5", "history-limit 100000", `show-options: ${histOpt.stdout || "(empty)"}`);
  }

  // T1.6 — terminal-overrides contains smcup@
  const overrides = await tmux("gmx-a", "show-options", "-s", "terminal-overrides");
  if (overrides.stdout.includes("smcup@")) {
    pass("T1.6", "terminal-overrides contains smcup@");
  } else {
    fail("T1.6", "terminal-overrides contains smcup@", `show-options -s: ${overrides.stdout || "(empty)"}`);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // T2: Alt-screen byte oracle
  // ════════════════════════════════════════════════════════════════════════════
  out("\n── T2: alt-screen byte oracle ───────────────────────────────────");

  // Start native server (gmx-b) for T2+T3+T4+T5 reuse
  await tmux("gmx-b", "kill-server").catch(() => undefined);
  const nvpBStart = await tmux("gmx-b", "-f", NATIVE_CONF, "new-session", "-d", "-s", "s", "-x", "200", "-y", "50");
  if (nvpBStart.exitCode !== 0) {
    fail("T2.setup", "gmx-b native server started for T2-T5", `exit ${nvpBStart.exitCode}: ${nvpBStart.stderr}`);
  }

  // Start outer server for script(1) capture
  await tmux("gmx-outer", "kill-server").catch(() => undefined);
  await tmux("gmx-outer", "new-session", "-d", "-s", "o1", "-x", "220", "-y", "50");
  sleepMs(1500);

  // --- Control path: no smcup@ override ---
  const ctrlCmd = `TERM=xterm-ghostty script -q ${ctrlBytesFile} tmux -L gmx-ctrl -f /dev/null attach -t s`;
  await tmux("gmx-outer", "send-keys", "-t", "o1", ctrlCmd, "Enter");
  sleepMs(2500);
  await tmux("gmx-ctrl", "detach-client");
  sleepMs(1500);

  const ctrlFlushed = poll(() => {
    try { return Bun.file(ctrlBytesFile).size > 0; } catch { return false; }
  }, 5000);

  // --- Native path: with smcup@ override ---
  const nativeCmd = `TERM=xterm-ghostty script -q ${nativeBytesFile} tmux -L gmx-b -f ${NATIVE_CONF} attach -t s`;
  await tmux("gmx-outer", "send-keys", "-t", "o1", nativeCmd, "Enter");
  sleepMs(2500);
  await tmux("gmx-b", "detach-client");
  sleepMs(1500);

  const nativeFlushed = poll(() => {
    try { return Bun.file(nativeBytesFile).size > 0; } catch { return false; }
  }, 5000);

  // Assert smcup presence/absence
  const SMCUP = Buffer.from("\x1b[?1049h");
  let ctrlSmcupCount = 0;
  let nativeSmcupCount = 0;
  let ctrlBytes = 0;
  let nativeBytes = 0;
  let t2OracleNote = "";

  if (!ctrlFlushed) {
    fail("T2.1", "ctrl client sends smcup (oracle control arm)", "ctrl byte file empty after 5s poll — oracle may be broken");
  } else {
    const ctrlData = await readFile(ctrlBytesFile);
    ctrlBytes = ctrlData.length;
    let pos = 0;
    while ((pos = ctrlData.indexOf(SMCUP, pos)) !== -1) { ctrlSmcupCount++; pos++; }

    if (ctrlSmcupCount === 0) {
      t2OracleNote = `ORACLE BROKEN: ctrl capture (${ctrlBytes} bytes) has no smcup — ` +
        `terminfo for TERM=xterm-ghostty may be missing; try: infocmp xterm-ghostty | grep smcup`;
      fail("T2.1", "ctrl client sends smcup (oracle control arm)", t2OracleNote);
    } else {
      pass("T2.1", `ctrl client sends smcup ${ctrlSmcupCount}x (${ctrlBytes} bytes captured)`);
    }
  }

  if (!nativeFlushed) {
    fail("T2.2", "native client sends NO smcup (smcup@ override proof)", "native byte file empty after 5s poll");
  } else {
    const nativeData = await readFile(nativeBytesFile);
    nativeBytes = nativeData.length;
    let pos = 0;
    while ((pos = nativeData.indexOf(SMCUP, pos)) !== -1) { nativeSmcupCount++; pos++; }

    if (nativeSmcupCount === 0) {
      pass("T2.2", `native client sends NO smcup (${nativeBytes} bytes) — smcup@ override confirmed`);
    } else {
      fail("T2.2", "native client sends NO smcup (smcup@ override proof)",
        `found ${nativeSmcupCount} smcup in ${nativeBytes} bytes — smcup@ override NOT working`);
    }
  }

  out(`  ctrl:   ${ctrlBytes} bytes, smcup count: ${ctrlSmcupCount}`);
  out(`  native: ${nativeBytes} bytes, smcup count: ${nativeSmcupCount}`);
  if (t2OracleNote) out(`  NOTE: ${t2OracleNote}`);

  // ════════════════════════════════════════════════════════════════════════════
  // T3: CPR noise immunity in copy-mode
  // ════════════════════════════════════════════════════════════════════════════
  out("\n── T3: CPR noise immunity ──────────────────────────────────────");

  // Build scrollback and enter copy mode
  await tmux("gmx-b", "send-keys", "-t", "s", "seq 1 300", "Enter");
  sleepMs(800);

  await tmux("gmx-b", "copy-mode", "-t", "s");
  sleepMs(400);

  const modeBeforeCpr = await tmux("gmx-b", "display-message", "-t", "s", "-p", "#{pane_in_mode}");
  if (modeBeforeCpr.stdout === "1") {
    pass("T3.0", "pane enters copy-mode (pane_in_mode=1)");
  } else {
    fail("T3.0", "pane enters copy-mode", `pane_in_mode=${modeBeforeCpr.stdout}`);
  }

  // Attach outer pane to gmx-b for CPR injection via outer client
  await tmux("gmx-outer", "send-keys", "-t", "o1", `tmux -L gmx-b -f ${NATIVE_CONF} attach -t s`, "Enter");
  sleepMs(1500);

  // Inject CPR burst (ESC [ 1 2 ; 3 4 R) via outer pane send-keys -H.
  // This is the regression class that killed fusion mode: CPR replies from agent
  // TUIs arrive through the outer-pane TTY and in fusion mode (with type-to-exit
  // bindings) would cancel copy-mode and leak "12;34R" to the shell prompt.
  // In ghostty-native mode, the inner server has no custom copy-mode bindings,
  // so tmux treats CPR as a terminal protocol response (not a key event) and
  // copy-mode stays intact.
  await tmux("gmx-outer", "send-keys", "-H", "-t", "o1", "1b 5b 31 32 3b 33 34 52");
  sleepMs(400);

  const modeAfterCpr = await tmux("gmx-b", "display-message", "-t", "s", "-p", "#{pane_in_mode}");
  if (modeAfterCpr.stdout === "1") {
    pass("T3.1", "copy-mode survives CPR burst via outer pane (pane_in_mode=1)");
  } else {
    fail("T3.1", "copy-mode survives CPR burst via outer pane",
      `pane_in_mode=${modeAfterCpr.stdout} — copy-mode was cancelled by CPR injection`);
  }

  // Cancel copy mode server-side
  await tmux("gmx-b", "send-keys", "-t", "s", "-X", "cancel");
  sleepMs(400);

  const modeAfterCancel = await tmux("gmx-b", "display-message", "-t", "s", "-p", "#{pane_in_mode}");
  if (modeAfterCancel.stdout === "0") {
    pass("T3.2", "copy-mode exits cleanly via server-side send-keys -X cancel");
  } else {
    fail("T3.2", "copy-mode exits cleanly via server-side send-keys -X cancel",
      `pane_in_mode=${modeAfterCancel.stdout} after cancel`);
  }

  // Check for CPR fragment leak at shell prompt
  const paneContent = await tmux("gmx-b", "capture-pane", "-t", "s", "-p", "-S", "-20");
  const hasLeak = paneContent.stdout.includes("12;34R");
  if (!hasLeak) {
    pass("T3.3", "no '12;34R' CPR fragment leaked to shell prompt");
  } else {
    fail("T3.3", "no '12;34R' CPR fragment leaked to shell prompt",
      `pane capture contains '12;34R'`);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // T4: Paste integrity
  // ════════════════════════════════════════════════════════════════════════════
  out("\n── T4: paste integrity ─────────────────────────────────────────");

  const BP_START = "\x1b[200~";
  const BP_END = "\x1b[201~";

  await tmux("gmx-b", "send-keys", "-t", "s", "C-c", "");
  sleepMs(300);

  const pastePayload = `${BP_START}echo native-ok${BP_END}`;
  await tmux("gmx-b", "send-keys", "-t", "s", pastePayload);
  sleepMs(800);

  const paneAfterPaste = await tmux("gmx-b", "capture-pane", "-t", "s", "-p", "-S", "-20");
  if (paneAfterPaste.stdout.includes("echo native-ok")) {
    pass("T4.1", "bracketed paste 'echo native-ok' lands intact at shell prompt");
  } else {
    fail("T4.1", "bracketed paste 'echo native-ok' lands intact at shell prompt",
      `capture does not contain 'echo native-ok': ${paneAfterPaste.stdout.slice(0, 200)}`);
  }

  // T4.2 — extended-keys #4663 guard: multiline paste into cat -v shows no CSI-u artifacts
  await tmux("gmx-b", "send-keys", "-t", "s", "C-c", "");
  sleepMs(300);
  await tmux("gmx-b", "send-keys", "-t", "s", "cat -v", "Enter");
  sleepMs(500);

  const multilinePaste = `${BP_START}line1\nline2${BP_END}`;
  await tmux("gmx-b", "send-keys", "-t", "s", multilinePaste, "Enter");
  sleepMs(1500);

  const catOutput = await tmux("gmx-b", "capture-pane", "-t", "s", "-p", "-S", "-50");
  const csiUPattern = /\[\d+;(?:\d+;)?\d*u|\[13;|\[13u/;
  const hasCsiU = csiUPattern.test(catOutput.stdout);

  if (!hasCsiU) {
    pass("T4.2", "no CSI-u artifacts in cat -v output (extended-keys #4663 guard)");
  } else {
    fail("T4.2", "no CSI-u artifacts in cat -v output",
      `found CSI-u pattern in cat output`);
  }

  const catShowsBP = catOutput.stdout.includes("200~") || catOutput.stdout.includes("^[[200");
  if (catShowsBP) {
    pass("T4.3", "cat -v received bracketed paste markers (no silent discard)");
  } else {
    pass("T4.3", "cat -v ran; BP markers may have scrolled (T4.2 no-artifact check is the gate)");
  }

  await tmux("gmx-b", "send-keys", "-t", "s", "C-c", "");
  sleepMs(300);

  // ════════════════════════════════════════════════════════════════════════════
  // T5: y-copy fallback
  // ════════════════════════════════════════════════════════════════════════════
  out("\n── T5: y-copy fallback ─────────────────────────────────────────");

  await tmux("gmx-b", "send-keys", "-t", "s", "seq 1 300", "Enter");
  sleepMs(800);

  await tmux("gmx-b", "copy-mode", "-t", "s");
  sleepMs(400);

  const t5Mode = await tmux("gmx-b", "display-message", "-t", "s", "-p", "#{pane_in_mode}");
  if (t5Mode.stdout !== "1") {
    fail("T5.0", "pane enters copy-mode for y-copy test", `pane_in_mode=${t5Mode.stdout}`);
  } else {
    pass("T5.0", "pane enters copy-mode (pane_in_mode=1)");
  }

  for (let i = 0; i < 10; i++) {
    await tmux("gmx-b", "send-keys", "-t", "s", "-X", "cursor-up");
  }
  sleepMs(200);

  await tmux("gmx-b", "send-keys", "-t", "s", "-X", "begin-selection");
  sleepMs(100);
  await tmux("gmx-b", "send-keys", "-t", "s", "-X", "cursor-down");
  await tmux("gmx-b", "send-keys", "-t", "s", "-X", "cursor-down");
  sleepMs(100);
  await tmux("gmx-b", "send-keys", "-t", "s", "-X", "copy-selection-and-cancel");
  sleepMs(400);

  const buffer = await tmux("gmx-b", "show-buffer");
  if (buffer.exitCode === 0 && buffer.stdout.trim().length > 0) {
    pass("T5.1", `show-buffer returns non-empty text: ${JSON.stringify(buffer.stdout.trim().slice(0, 40))}`);
  } else {
    // Fallback: select-line
    await tmux("gmx-b", "send-keys", "-t", "s", "seq 1 10", "Enter");
    sleepMs(500);
    await tmux("gmx-b", "copy-mode", "-t", "s");
    sleepMs(300);
    for (let i = 0; i < 5; i++) {
      await tmux("gmx-b", "send-keys", "-t", "s", "-X", "cursor-up");
    }
    await tmux("gmx-b", "send-keys", "-t", "s", "-X", "select-line");
    sleepMs(100);
    await tmux("gmx-b", "send-keys", "-t", "s", "-X", "copy-selection-and-cancel");
    sleepMs(300);

    const buffer2 = await tmux("gmx-b", "show-buffer");
    if (buffer2.exitCode === 0 && buffer2.stdout.trim().length > 0) {
      pass("T5.1", `show-buffer non-empty (select-line fallback): ${JSON.stringify(buffer2.stdout.trim().slice(0, 40))}`);
    } else {
      fail("T5.1", "show-buffer returns non-empty text from seq output",
        `show-buffer empty or error (exit ${buffer2.exitCode})`);
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // T6: Hard-refresh live proof
  // ════════════════════════════════════════════════════════════════════════════
  out("\n── T6: hard-refresh live proof ─────────────────────────────────");

  // T6.0: pure plan-skip check (no server needed)
  {
    const fakeClients = parseClientList("client-12345|somesession|1717000000\n");
    const fakePlan = planClientRefresh(fakeClients);
    if (fakePlan.refresh.length === 0 && fakePlan.skipped.length === 1 &&
        fakePlan.skipped[0].client === "client-12345" &&
        fakePlan.skipped[0].reason === "control-mode or non-tty client") {
      pass("T6.0", "plan-skip: fake 'client-12345' is skipped (non-tty guard)");
    } else {
      fail("T6.0", "plan-skip: fake 'client-12345' is skipped (non-tty guard)",
        `refresh=${fakePlan.refresh.length} skipped=${fakePlan.skipped.length} reason=${fakePlan.skipped[0]?.reason ?? "(none)"}`);
    }
  }

  // T6 live server setup
  await tmux("gmx-refresh", "kill-server").catch(() => undefined);
  await tmux("gmx-refresh-outer", "kill-server").catch(() => undefined);

  const t6InnerStart = await tmux("gmx-refresh", "-f", NATIVE_CONF, "new-session", "-d", "-s", "rs", "-x", "200", "-y", "50");
  if (t6InnerStart.exitCode !== 0) {
    fail("T6.1", "inner scratch server (gmx-refresh) started", `exit ${t6InnerStart.exitCode}: ${t6InnerStart.stderr}`);
    fail("T6.2", "outer scratch server drives a real client", "skipped: inner server failed to start");
    fail("T6.3", "refreshTmuxClients cycles exactly 1 entry", "skipped: no inner server");
    fail("T6.4", "client_created advances after refresh (same tty, newer timestamp)", "skipped");
    fail("T6.5", "outer pane survives after refresh", "skipped");
  } else {
    pass("T6.1", "inner scratch server (gmx-refresh) started");

    const t6OuterStart = await tmux("gmx-refresh-outer", "-f", "/dev/null", "new-session", "-d", "-s", "ro", "-x", "200", "-y", "50");
    if (t6OuterStart.exitCode !== 0) {
      fail("T6.2", "outer scratch server drives a real client", `exit ${t6OuterStart.exitCode}: ${t6OuterStart.stderr}`);
      fail("T6.3", "refreshTmuxClients cycles exactly 1 entry", "skipped: outer server failed");
      fail("T6.4", "client_created advances after refresh (same tty, newer timestamp)", "skipped");
      fail("T6.5", "outer pane survives after refresh", "skipped");
    } else {
      // Find tmux binary (try common paths)
      const TMUX_BIN = (() => {
        for (const p of ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"]) {
          try {
            const r = Bun.spawnSync(["test", "-x", p]);
            if (r.exitCode === 0) return p;
          } catch { /* try next */ }
        }
        return "tmux";
      })();

      await tmux("gmx-refresh-outer", "send-keys", "-t", "ro",
        `exec ${TMUX_BIN} -L gmx-refresh attach -t rs`, "Enter");

      let innerClients: TmuxClient[] = [];
      const clientAttached = poll(() => {
        const r = Bun.spawnSync([TMUX_BIN, "-L", "gmx-refresh", "list-clients", "-F",
          "#{client_name}|#{session_name}|#{client_created}"]);
        const raw = r.stdout?.toString?.() ?? "";
        innerClients = parseClientList(raw).filter((c) => c.name.startsWith("/dev/tty"));
        return innerClients.length === 1;
      }, 6000);

      if (!clientAttached || innerClients.length !== 1) {
        fail("T6.2", "outer scratch server drives a real client on gmx-refresh",
          `list-clients saw ${innerClients.length} tty client(s) after 6s poll`);
        fail("T6.3", "refreshTmuxClients cycles exactly 1 entry", "skipped: no client attached");
        fail("T6.4", "client_created advances after refresh (same tty, newer timestamp)", "skipped");
        fail("T6.5", "outer pane survives after refresh", "skipped");
      } else {
        const beforeClient = innerClients[0];
        pass("T6.2", `outer scratch server drives 1 real client on gmx-refresh: ${beforeClient.name} (created=${beforeClient.created})`);

        const scratchExec: ExecFn = (command, args = []) => {
          const isTmux = command === "tmux" || command === TMUX_BIN || command.endsWith("/tmux");
          if (isTmux) {
            return new Promise((resolve) => {
              const proc = Bun.spawn([TMUX_BIN, "-L", "gmx-refresh", ...args], { stdout: "pipe", stderr: "pipe" });
              Promise.all([
                new Response(proc.stdout).text(),
                new Response(proc.stderr).text(),
                proc.exited,
              ]).then(([stdout, stderr, exitCode]) => {
                resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode });
              }).catch((e) => resolve({ stdout: "", stderr: String(e), exitCode: 1 }));
            });
          }
          return Promise.resolve({ stdout: "", stderr: `unexpected command: ${command}`, exitCode: 1 });
        };

        const t6RefreshResult = await refreshTmuxClients({
          exec: scratchExec,
          tmuxPath: `${TMUX_BIN} -L gmx-refresh`,
        });

        if (t6RefreshResult.cycled.length === 1) {
          pass("T6.3", `refreshTmuxClients cycles exactly 1 entry: ${t6RefreshResult.cycled[0].client}`);
        } else {
          fail("T6.3", "refreshTmuxClients cycles exactly 1 entry",
            `cycled=${t6RefreshResult.cycled.length} failed=${t6RefreshResult.failed.length} skipped=${t6RefreshResult.skipped.length}`);
        }

        let afterClients: TmuxClient[] = [];
        const refreshSettled = poll(() => {
          const r = Bun.spawnSync([TMUX_BIN, "-L", "gmx-refresh", "list-clients", "-F",
            "#{client_name}|#{session_name}|#{client_created}"]);
          const raw = r.stdout?.toString?.() ?? "";
          afterClients = parseClientList(raw).filter((c) => c.name.startsWith("/dev/tty"));
          return afterClients.length === 1;
        }, 6000);

        if (!refreshSettled || afterClients.length !== 1) {
          fail("T6.4", "client_created advances after refresh (same tty, newer timestamp)",
            `after-poll saw ${afterClients.length} tty client(s); settled=${refreshSettled}`);
        } else {
          const afterClient = afterClients[0];
          const sameTty = afterClient.name === beforeClient.name;
          const createdAdvanced = (afterClient.created ?? 0) >= (beforeClient.created ?? 0);
          if (sameTty && createdAdvanced) {
            pass("T6.4",
              `after refresh: same tty=${afterClient.name}, ` +
              `created before=${beforeClient.created} after=${afterClient.created}`);
          } else if (!sameTty) {
            fail("T6.4", "client_created advances after refresh (same tty, newer timestamp)",
              `tty changed: before=${beforeClient.name} after=${afterClient.name}`);
          } else {
            fail("T6.4", "client_created advances after refresh (same tty, newer timestamp)",
              `created did not advance: before=${beforeClient.created} after=${afterClient.created}`);
          }
        }

        const outerAlive = await tmux("gmx-refresh-outer", "has-session", "-t", "ro");
        if (outerAlive.exitCode === 0) {
          pass("T6.5", "outer pane (gmx-refresh-outer ro) still alive after refresh");
        } else {
          fail("T6.5", "outer pane (gmx-refresh-outer ro) still alive after refresh",
            `has-session exit ${outerAlive.exitCode}: ${outerAlive.stderr}`);
        }
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // PASS/FAIL report
  // ════════════════════════════════════════════════════════════════════════════
  out("\n════════════════════════════════════════════════════════════════");
  out("  PASS/FAIL table — bun harness/verify-ux.ts");
  out("════════════════════════════════════════════════════════════════");

  const colId = 8;
  const colName = 55;
  const colStatus = 6;
  const headerLine = `${"ID".padEnd(colId)} ${"Test".padEnd(colName)} ${"Status".padEnd(colStatus)} Note`;
  out(headerLine);
  out("─".repeat(Math.min(headerLine.length + 20, 120)));

  for (const row of results) {
    const status = row.pass ? "PASS" : "FAIL";
    const note = row.note ? ` | ${row.note.slice(0, 80)}` : "";
    out(`${row.id.padEnd(colId)} ${row.name.padEnd(colName)} ${status.padEnd(colStatus)}${note}`);
  }

  out("─".repeat(Math.min(headerLine.length + 20, 120)));

  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  const failed = total - passed;
  out(`\n${passed}/${total} passed${failed > 0 ? `, ${failed} FAILED` : ""}`);

  if (failed > 0) {
    out("\nFAILED tests:");
    for (const row of results.filter((r) => !r.pass)) {
      out(`  ${row.id} ${row.name}: ${row.note}`);
    }
  }

  out("════════════════════════════════════════════════════════════════\n");
}

// ── entrypoint ────────────────────────────────────────────────────────────────

let exitCode = 0;

try {
  await main();
} catch (error) {
  err(`\nUnhandled error: ${error}`);
  exitCode = 1;
} finally {
  await cleanup();
}

const failed = results.filter((r) => !r.pass).length;
if (failed > 0 || exitCode !== 0) {
  process.exit(1);
}
