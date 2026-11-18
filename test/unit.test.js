import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { newestTimestamp, lastActivity, idleDays } from '../src/idle.js';
import { parsePs, ancestors, descendants } from '../src/proc.js';
import { normTty, ttyKey } from '../src/tty.js';
import { parseTmuxPanes } from '../src/terminals/tmux.js';
import { parseHerdrLs, herdrPaneFromGet } from '../src/terminals/herdr.js';
import { findPane } from '../src/terminals/index.js';
import { parsePidfile, isClaudeProcess } from '../src/agents/claude.js';
import { evaluate, protectedPids, matchesOnly } from '../src/discover.js';
import { hookShellFor, parkMethod } from '../src/park.js';
import { closeProcess } from '../src/close.js';
import { parseArgs } from '../src/cli.js';
import { initSnippet } from '../src/hook.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fx = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const procs = parsePs(fx('ps.txt'));
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-18T12:00:00Z');

// ---------- idle parsing ----------
test('newestTimestamp: picks the max, skips partial/invalid lines and non-string timestamps', () => {
  const text = fx('transcript.jsonl');
  assert.equal(newestTimestamp(text), Date.parse('2026-11-12T09:30:00.000Z'));
  assert.equal(newestTimestamp('{"no":"ts"}\n'), null);
  assert.equal(newestTimestamp(''), null);
});

test('lastActivity: reads only the tail and falls back to mtime when no timestamp', () => {
  const r = lastActivity(path.join(FIX, 'transcript.jsonl'));
  assert.deepEqual(r, { ms: Date.parse('2026-11-12T09:30:00.000Z'), source: 'transcript' });
  // tail smaller than the last lines: only the newest lines are parsed
  const tail = lastActivity(path.join(FIX, 'transcript.jsonl'), 120);
  assert.equal(tail.source, 'transcript');
  const tmp = path.join(os.tmpdir(), `as-${process.pid}.jsonl`);
  fs.writeFileSync(tmp, '{"type":"x"}\n');
  assert.equal(lastActivity(tmp).source, 'mtime');
  fs.unlinkSync(tmp);
  assert.equal(lastActivity('/nonexistent/file.jsonl'), null);
  assert.equal(idleDays(NOW - 3 * DAY, NOW), 3);
});

// ---------- process table + tty ----------
test('parsePs + ancestors/descendants', () => {
  assert.equal(procs.get(301).name, 'claude');
  assert.equal(procs.get(200).name, 'zsh');
  assert.equal(procs.get(200).tty, '/dev/ttys001');
  assert.equal(procs.get(600).tty, '/dev/pts/7');
  assert.equal(procs.get(1).tty, null);
  assert.deepEqual([...ancestors(procs, 202)], [202, 201, 200, 100]);
  assert.deepEqual([...descendants(procs, 501)].sort(), [510, 511]);
});

test('normTty / ttyKey', () => {
  assert.equal(normTty('ttys055'), '/dev/ttys055');
  assert.equal(normTty('s055'), '/dev/ttys055');
  assert.equal(normTty('/dev/pts/3'), '/dev/pts/3');
  assert.equal(normTty('??'), null);
  assert.equal(normTty('not a tty'), null);
  assert.equal(ttyKey('pts/3'), 'pts_3');
  assert.equal(ttyKey('/dev/ttys002'), 'ttys002');
});

// ---------- connectors: parsing + mapping ----------
test('tmux: parse list-panes', () => {
  const panes = parseTmuxPanes(fx('tmux-panes.txt'));
  assert.equal(panes.length, 3);
  assert.deepEqual(panes[0], { connector: 'tmux', id: '%0', shellPid: 300, tty: '/dev/ttys002', current: 'claude', label: 'work:0.0', busy: null });
});

test('herdr: ls keeps local live terminals only; get -> pane with tty from the shell pid', () => {
  assert.deepEqual(parseHerdrLs(fx('herdr-ls.json')), ['t2', 't3']);
  assert.deepEqual(parseHerdrLs('not json'), []);
  const p = herdrPaneFromGet(fx('herdr-get-t2.json'), procs);
  assert.equal(p.id, 't2');
  assert.equal(p.tty, '/dev/ttys001');
  assert.equal(p.foregroundPid, 201);
  assert.equal(p.busy, null);
  assert.equal(p.label, 'Space / Tab A');
  assert.match(herdrPaneFromGet(fx('herdr-get-busy.json'), procs).busy, /working/);
});

test('findPane: foreground pid wins, then tty; no match -> null', () => {
  const panes = [
    herdrPaneFromGet(fx('herdr-get-t2.json'), procs),
    ...parseTmuxPanes(fx('tmux-panes.txt')),
  ];
  assert.equal(findPane({ pid: 201, tty: '/dev/ttys001' }, panes).id, 't2');
  assert.equal(findPane({ pid: 301, tty: '/dev/ttys002' }, panes).id, '%0');
  assert.equal(findPane({ pid: 601, tty: '/dev/pts/7' }, panes).id, '%1');
  assert.equal(findPane({ pid: 401, tty: '/dev/ttys003' }, panes), null);
  assert.equal(findPane({ pid: 999, tty: null }, panes), null);
});

// ---------- claude adapter ----------
test('claude pidfile parsing + process check', () => {
  assert.deepEqual(parsePidfile('{"pid":201,"sessionId":"abc","cwd":"/w","status":"idle","kind":"interactive"}'),
    { pid: 201, sessionId: 'abc', cwd: '/w', status: 'idle', name: null });
  assert.equal(parsePidfile('{"pid":1,"sessionId":"x","kind":"sdk-cli"}'), null);
  assert.equal(parsePidfile('garbage'), null);
  assert.equal(parsePidfile('{"sessionId":"x"}'), null);
  assert.ok(isClaudeProcess(procs.get(201)));
  assert.ok(isClaudeProcess(procs.get(301)));
  assert.ok(!isClaudeProcess(procs.get(302)));
  assert.ok(!isClaudeProcess(undefined));
});

// ---------- decision + safety ----------
function fakeAdapter(lastMs) {
  return {
    name: 'claude',
    lastActivity: (s) => (lastMs[s.pid] == null ? null : { ms: lastMs[s.pid], source: 'transcript' }),
    busyReason: (s) => (s.status && s.status !== 'idle' ? `agent status "${s.status}"` : null),
  };
}
const S = (pid, extra = {}) => ({ agent: 'claude', pid, sessionId: `sess-${pid}-aaaaaaaa`, cwd: '/w', status: 'idle', tty: procs.get(pid)?.tty ?? null, ...extra });

function run(sessions, { selfPid = 9999, selfTty = null, days = 3, only = null, panes = [], last } = {}) {
  const lastMs = last || Object.fromEntries(sessions.map((s) => [s.pid, NOW - 10 * DAY]));
  const p = new Map(procs);
  if (!p.has(selfPid)) p.set(selfPid, { pid: selfPid, ppid: 1, cpu: 0, rssKb: 0, tty: null, name: 'node', comm: 'node' });
  return evaluate({ sessions, panes, procs: p, adapters: { claude: fakeAdapter(lastMs) }, protect: protectedPids(p, selfPid), selfTty, days, only, now: NOW });
}

test('SAFETY: never the session running the tool (agent is an ancestor of the tool)', () => {
  // tool runs as a child shell of claude 201 (pid 202 is its bash tool shell)
  const [r] = run([S(201)], { selfPid: 202 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /running agent-snooze/);
});

test('SAFETY: never a session on the same tty as the tool', () => {
  const [r] = run([S(301)], { selfTty: '/dev/ttys002' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /running agent-snooze/);
});

test('SAFETY: protectedPids walks the whole parent chain', () => {
  const pp = protectedPids(procs, 202);
  for (const pid of [202, 201, 200, 100]) assert.ok(pp.has(pid));
  assert.ok(!pp.has(301));
});

test('idle threshold, --days 0, and missing transcript', () => {
  assert.equal(run([S(301)], { last: { 301: NOW - 1 * DAY } })[0].ok, false);
  assert.match(run([S(301)], { last: { 301: NOW - 1 * DAY } })[0].reason, /active/);
  assert.equal(run([S(301)], { days: 0, last: { 301: NOW - 1000 } })[0].ok, true);
  assert.match(run([S(301)], { last: { 301: null } })[0].reason, /no transcript/);
});

test('busy: agent status, pane status, shell child, cpu', () => {
  assert.match(run([S(301, { status: 'busy' })])[0].reason, /agent status "busy"/);
  assert.match(run([S(301, { status: 'waiting' })])[0].reason, /busy/);
  const pane = { ...herdrPaneFromGet(fx('herdr-get-busy.json'), procs), foregroundPid: 301 };
  assert.match(run([S(301)], { panes: [pane] })[0].reason, /herdr status/);
  assert.match(run([S(501)])[0].reason, /shell child/);
  assert.match(run([S(401)])[0].reason, /cpu 7.5/);
  const ok = run([S(301)])[0];
  assert.equal(ok.ok, true);
  assert.equal(ok.memMb, Math.round(60000 / 1024)); // claude + its node child
});

test('no tty -> skip', () => {
  assert.match(run([S(301, { tty: null })])[0].reason, /no terminal/);
});

test('--only filters by pid, pane id or session prefix', () => {
  const panes = parseTmuxPanes(fx('tmux-panes.txt'));
  const all = [S(301), S(601)];
  assert.deepEqual(run(all, { only: '601', panes }).map((r) => r.session.pid), [601]);
  assert.deepEqual(run(all, { only: '%0', panes }).map((r) => r.session.pid), [301]);
  assert.deepEqual(run(all, { only: 'sess-601', panes }).map((r) => r.session.pid), [601]);
  assert.deepEqual(run(all, { only: '12345', panes }), []);
  assert.ok(!matchesOnly('sess', S(301), null)); // too-short prefixes never match
});

// ---------- parking ----------
test('hookShellFor / parkMethod', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'as-home-'));
  const env = { AGENT_SNOOZE_HOME: home };
  fs.mkdirSync(path.join(home, 'hooks'));
  const tmuxPane = parseTmuxPanes(fx('tmux-panes.txt'))[0];
  assert.equal(parkMethod(S(301), tmuxPane, procs, env), 'tmux');
  assert.equal(parkMethod(S(301), null, procs, env), 'tty');
  fs.writeFileSync(path.join(home, 'hooks', 'ttys002'), '300\n'); // the shell that launched claude 301
  assert.equal(hookShellFor(S(301), procs, env), 300);
  assert.equal(parkMethod(S(301), tmuxPane, procs, env), 'hook');
  fs.writeFileSync(path.join(home, 'hooks', 'ttys002'), '200\n'); // stale: other tty, not a parent
  assert.equal(hookShellFor(S(301), procs, env), null);
  fs.rmSync(home, { recursive: true });
});

test('closeProcess: SIGTERM then wait; reports slow and stuck exits', () => {
  let left = 3, sent = null;
  const ok = closeProcess(42, { timeoutMs: 5000, kill: (p, s) => { sent = [p, s]; }, isAlive: () => left-- > 0 });
  assert.deepEqual(sent, [42, 'SIGTERM']);
  assert.equal(ok.ok, true);
  const stuck = closeProcess(42, { timeoutMs: 300, kill: () => {}, isAlive: () => true });
  assert.equal(stuck.ok, false);
  const gone = closeProcess(42, { kill: () => { const e = new Error('x'); e.code = 'ESRCH'; throw e; } });
  assert.equal(gone.ok, true);
});

// ---------- cli + hook ----------
test('parseArgs', () => {
  assert.deepEqual(parseArgs([]), { cmd: 'snooze', apply: false, days: 3, only: null, tty: null, now: false, emit: false, lazy: false, wakeShell: 'posix', shell: null });
  const o = parseArgs(['--apply', '--days', '0', '--only', '%3']);
  assert.equal(o.apply, true); assert.equal(o.days, 0); assert.equal(o.only, '%3');
  assert.equal(parseArgs(['init', 'fish']).shell, 'fish');
  assert.equal(parseArgs(['wake', '--now']).cmd, 'wake');
  assert.throws(() => parseArgs(['--days', '-1']));
  assert.throws(() => parseArgs(['--bogus']));
});

test('init snippets exist for zsh, bash, fish and run wake on a parked tty', () => {
  for (const sh of ['zsh', 'bash', 'fish']) {
    const s = initSnippet(sh, { cmd: 'agent-snooze' });
    assert.match(s, /parked/);
    assert.match(s, /agent-snooze wake --emit --lazy/);
    assert.match(s, /_agent_snooze_ask/);
    assert.match(s, /hooks/);
  }
  assert.equal(initSnippet('tcsh'), null);
});

test('resumeLine quotes cwd and argv for the shell', async () => {
  const { resumeLine } = await import('../src/wake.js');
  const line = resumeLine({ resume: { cwd: "/tmp/it's here", argv: ['claude', '--resume', 'abc-123'] } });
  assert.equal(line, `cd '/tmp/it'\\''s here' && 'claude' '--resume' 'abc-123'`);
});

// ---------- GUI terminals (AppleScript) ----------
import { parseOsaPanes, atShellFromPs, isDenied, ttyAtShell } from '../src/terminals/applescript.js';
import iterm2 from '../src/terminals/iterm2.js';
import terminalApp from '../src/terminals/terminal-app.js';
import { TERMINALS } from '../src/terminals/index.js';

test('osascript listing: tty normalised, rows without a tty dropped, busy and title kept', () => {
  const panes = parseOsaPanes(fx('osa-panes.txt'), 'terminal-app');
  assert.equal(panes.length, 2);
  assert.deepEqual(panes[0], { connector: 'terminal-app', id: '/dev/ttys004', tty: '/dev/ttys004', winId: '101', shellPid: null, current: null, label: 'my tab', busy: null });
  assert.equal(panes[1].label, '/dev/ttys007');
  assert.match(panes[1].busy, /running/);
});

test('GUI connectors are registered and map a session by tty', () => {
  assert.ok(TERMINALS.includes(iterm2) && TERMINALS.includes(terminalApp));
  const panes = parseOsaPanes(fx('osa-panes.txt'), 'iterm2');
  assert.equal(findPane({ pid: 1, tty: '/dev/ttys007' }, panes).tty, '/dev/ttys007');
});

test('atShell: only when every foreground process is a shell', () => {
  assert.equal(atShellFromPs(fx('ps-tty-shell.txt')), true);
  assert.equal(atShellFromPs(fx('ps-tty-claude.txt')), false);
  assert.equal(atShellFromPs(''), false);
  assert.equal(ttyAtShell('ttys004', { run: () => ({ ok: true, stdout: fx('ps-tty-shell.txt') }) }), true);
});

test('typeLine: text goes as argv; denial and missing tab give clean errors; listPanes returns []', () => {
  const env = { ...process.env, AGENT_SNOOZE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'as-')) };
  const pane = { tty: '/dev/ttys004' };
  let seen;
  const ok = (cmd, args) => { seen = [cmd, args]; return { ok: true, stdout: 'ok\n', stderr: '' }; };
  assert.deepEqual(terminalApp.typeLine(pane, 'echo "hi"', { run: ok, env }), { ok: true });
  assert.equal(seen[0], 'osascript');
  assert.deepEqual(seen[1].slice(-2), ['/dev/ttys004', 'echo "hi"']);
  assert.match(seen[1][1], /do script txt in t/);
  assert.match(iterm2.typeLine(pane, 'x', { run: ok, env }).ok ? seen[1][1] : '', /write text txt/);
  const denied = () => ({ ok: false, stdout: '', stderr: 'execution error: Not authorized to send Apple events to Terminal. (-1743)' });
  assert.match(terminalApp.typeLine(pane, 'x', { run: denied, env }).error, /Automation permission denied/);
  assert.deepEqual(terminalApp.listPanes({ run: denied, env }), []);
  assert.match(fs.readFileSync(path.join(env.AGENT_SNOOZE_HOME, 'agent-snooze.log'), 'utf8'), /Automation permission denied for Terminal/);
  const nf = () => ({ ok: true, stdout: 'notfound\n', stderr: '' });
  assert.match(iterm2.typeLine(pane, 'x', { run: nf, env }).error, /no iTerm2 tab/);
  assert.equal(isDenied('(-1743)'), true);
  assert.equal(isDenied('syntax error'), false);
});

test('available(): false when the app is not running, never launches', () => {
  const calls = [];
  const none = (cmd, args) => { calls.push([cmd, ...args]); return { ok: false, stdout: '', stderr: '' }; };
  const env = { ...process.env, AGENT_SNOOZE_FORCE_OSA: '1' };
  assert.equal(terminalApp.available({ run: none, env }), false);
  assert.equal(iterm2.available({ run: none, env }), false);
  assert.deepEqual(calls, [['pgrep', '-x', 'Terminal'], ['pgrep', '-x', 'iTerm2']]);
});

// ---------- Kitty, WezTerm, cmux ----------
import kitty, { parseKittyLs, kittySockets } from '../src/terminals/kitty.js';
import wezterm, { parseWeztermList } from '../src/terminals/wezterm.js';
import cmux, { parseCmuxTree } from '../src/terminals/cmux.js';

test('kitty: ls parsed, tty from shell pid via ps, foreground = non-shell process', () => {
  const procs = new Map([[300, { tty: '/dev/ttys010' }], [310, { tty: '/dev/ttys011' }]]);
  const panes = parseKittyLs(fx('kitty-ls.json'), 'unix:/tmp/kitty-x', procs);
  assert.equal(panes.length, 2);
  assert.deepEqual(panes[1], { connector: 'kitty', id: '2', sock: 'unix:/tmp/kitty-x', tty: '/dev/ttys011', shellPid: 310, foregroundPid: 311, current: 'claude', label: 'claude', busy: null });
  assert.equal(findPane({ pid: 311, tty: null }, panes).id, '2');
  assert.equal(findPane({ pid: 9, tty: '/dev/ttys010' }, panes).id, '1');
});

test('kitty: socket candidates and typeLine args', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-'));
  assert.deepEqual(kittySockets({ KITTY_LISTEN_ON: 'unix:/a/b', AGENT_SNOOZE_KITTY_SOCKET: 'unix:/c' }, dir), ['unix:/c', 'unix:/a/b']);
  let seen;
  const run = (cmd, args) => { seen = [cmd, args]; return { ok: true, stdout: '', stderr: '' }; };
  const env = { ...process.env, AGENT_SNOOZE_KITTY: '/bin/kitten' };
  assert.deepEqual(kitty.typeLine({ id: '2', sock: 'unix:/s' }, 'echo hi', { run, env }), { ok: true });
  assert.deepEqual(seen[1], ['@', '--to', 'unix:/s', 'send-text', '--match', 'id:2', '--', 'echo hi\r']);
  const bad = () => ({ ok: false, stdout: '', stderr: 'boom\n' });
  assert.equal(kitty.typeLine({ id: '2', sock: 'unix:/s' }, 'x', { run: bad, env }).error, 'boom');
});

test('kitty: remote control off means unavailable (no sockets answer)', () => {
  const env = { PATH: '', AGENT_SNOOZE_KITTY: '/bin/kitten', AGENT_SNOOZE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'as-')) };
  const run = (cmd, args) => (cmd === 'pgrep' ? { ok: true, stdout: '1\n', stderr: '' } : { ok: false, stdout: '', stderr: 'no socket' });
  assert.equal(kitty.available({ run, env }), false);
  assert.match(fs.readFileSync(path.join(env.AGENT_SNOOZE_HOME, 'agent-snooze.log'), 'utf8'), /allow_remote_control yes/);
});

test('wezterm: tty_name maps panes, pane without tty stays unmapped, typeLine pins the socket', () => {
  const panes = parseWeztermList(fx('wezterm-list.json'), '/s/gui-sock-1');
  assert.equal(panes.length, 3);
  assert.equal(panes[1].tty, '/dev/ttys058');
  assert.equal(panes[2].tty, null);
  assert.equal(findPane({ pid: 1, tty: '/dev/ttys058' }, panes).id, '3');
  let seen;
  const run = (cmd, args, o) => { seen = [cmd, args, o.env.WEZTERM_UNIX_SOCKET]; return { ok: true, stdout: '', stderr: '' }; };
  const env = { ...process.env, AGENT_SNOOZE_WEZTERM: '/bin/wezterm' };
  assert.deepEqual(wezterm.typeLine({ id: '3', sock: '/s/gui-sock-1' }, 'echo hi', { run, env }), { ok: true });
  assert.deepEqual(seen[1], ['cli', 'send-text', '--pane-id', '3', '--no-paste', 'echo hi\r']);
  assert.equal(seen[2], '/s/gui-sock-1');
});

test('cmux: tolerant tree parse keeps only terminals with a tty', () => {
  const panes = parseCmuxTree(fx('cmux-tree.json'));
  assert.equal(panes.length, 1);
  assert.deepEqual(panes[0], { connector: 'cmux', id: 'surface:1', tty: '/dev/ttys014', shellPid: null, foregroundPid: null, current: null, label: 'my tab', busy: null });
  assert.deepEqual(parseCmuxTree('not json'), []);
});

test('cmux: unavailable outside cmux (cmuxOnly socket) with a log hint; typeLine sends text then Enter', () => {
  const env = { PATH: '', AGENT_SNOOZE_CMUX: '/bin/cmux', AGENT_SNOOZE_EXPERIMENTAL_CMUX: '1', AGENT_SNOOZE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'as-')) };
  const run = (cmd) => ({ ok: cmd === 'pgrep', stdout: '1\n', stderr: '' });
  assert.equal(cmux.available({ run, env: { ...env, AGENT_SNOOZE_EXPERIMENTAL_CMUX: '', CMUX_SURFACE_ID: 'x' } }), false, 'off by default (experimental)');
  assert.equal(cmux.available({ run, env }), false);
  assert.match(fs.readFileSync(path.join(env.AGENT_SNOOZE_HOME, 'agent-snooze.log'), 'utf8'), /cmuxOnly/);
  assert.equal(cmux.available({ run, env: { ...env, CMUX_SURFACE_ID: 'x' } }), true);
  const seen = [];
  const rec = (cmd, args) => { seen.push(args); return { ok: true, stdout: '', stderr: '' }; };
  assert.deepEqual(cmux.typeLine({ id: 'surface:1' }, 'echo hi', { run: rec, env }), { ok: true });
  assert.deepEqual(seen, [['send', '--surface', 'surface:1', '--', 'echo hi'], ['send-key', '--surface', 'surface:1', 'enter']]);
  assert.ok(TERMINALS.includes(kitty) && TERMINALS.includes(wezterm) && TERMINALS.includes(cmux));
});

// ---------- codex adapter ----------
import codex, { findCodexProcs, parseLsofRollouts, readMeta, turnState, threadName, isCodexBinary } from '../src/agents/codex.js';
import { AGENTS } from '../src/agents/index.js';

const CX_ID = '0a0b0c0d-1111-7222-8333-444455556666';

test('codex: process detection (node wrapper -> pid is the wrapper; native binary; nested and tty-less skipped)', () => {
  const p = parsePs(fx('ps-codex.txt'));
  assert.ok(isCodexBinary(p.get(702)) && isCodexBinary(p.get(801)) && !isCodexBinary(p.get(701)));
  assert.deepEqual(findCodexProcs(p), [
    { pid: 701, binPid: 702, tty: '/dev/ttys010' },
    { pid: 801, binPid: 801, tty: '/dev/ttys011' },
  ]);
});

test('codex: lsof -F pn maps pid -> live .jsonl rollout only (no .zst, no locks)', () => {
  const m = parseLsofRollouts(fx('codex-lsof.txt'));
  assert.equal(m.get(702), `/HOME/.codex/sessions/2026/11/18/rollout-2026-11-18T14-04-18-${CX_ID}.jsonl`);
  assert.equal(m.has(801), false);
});

test('codex: session_meta, last activity from transcript, turn state', () => {
  const f = path.join(FIX, 'codex-rollout.jsonl');
  assert.deepEqual(readMeta(f), { id: CX_ID, cwd: '/tmp/proj', source: 'cli' });
  assert.deepEqual(codex.lastActivity({ rollout: f }), { ms: Date.parse('2026-11-12T09:00:06.000Z'), source: 'transcript' });
  assert.equal(turnState(fx('codex-rollout.jsonl')), 'done');
  assert.equal(turnState('{"type":"event_msg","payload":{"type":"task_started"}}\n'), 'running');
  assert.equal(turnState('{"type":"event_msg","payload":{"type":"task_started"}}\n{"type":"event_msg","payload":{"type":"turn_aborted"}}\n'), 'done');
  assert.equal(turnState(''), null);
  assert.equal(codex.busyReason({ rollout: f }), null);
  assert.deepEqual(codex.resumeCommand({ sessionId: CX_ID, cwd: '/tmp/proj' }), { argv: ['codex', 'resume', CX_ID], cwd: '/tmp/proj' });
});

test('codex: listSessions + recheck with a fake CODEX_HOME and lsof', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'as-codex-'));
  const dir = path.join(home, 'sessions/2026/11/18');
  fs.mkdirSync(dir, { recursive: true });
  const roll = path.join(dir, `rollout-2026-11-18T14-04-18-${CX_ID}.jsonl`);
  fs.copyFileSync(path.join(FIX, 'codex-rollout.jsonl'), roll);
  fs.writeFileSync(path.join(home, 'session_index.jsonl'), `{"id":"${CX_ID}","thread_name":"Old name"}\n{"id":"${CX_ID}","thread_name":"Say hi"}\n`);
  const lsof = fx('codex-lsof.txt').replaceAll('/HOME/.codex', home);
  const calls = [];
  const run = (cmd, args) => { calls.push([cmd, ...args]); return { ok: true, stdout: lsof }; };
  const p = parsePs(fx('ps-codex.txt'));
  const [s, ...rest] = codex.listSessions({ procs: p, env: { CODEX_HOME: home }, run });
  assert.equal(rest.length, 0); // 801 has no live rollout (only a .zst)
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 5), ['lsof', '-nP', '-a', '-p', '702,801']);
  assert.equal(s.agent, 'codex'); assert.equal(s.pid, 701); assert.deepEqual(s.pids, [701, 702]);
  assert.equal(s.sessionId, CX_ID); assert.equal(s.cwd, '/tmp/proj'); assert.equal(s.name, 'Say hi');
  assert.equal(threadName(home, 'nope'), null);
  assert.equal(codex.recheck(s, run), null);
  assert.equal(codex.recheck(s, () => ({ ok: false, stdout: '' })), 'rollout no longer open');
  // a new turn starts after the dry run -> busy on recheck
  fs.appendFileSync(roll, '\n{"timestamp":"2026-11-18T10:00:00Z","type":"event_msg","payload":{"type":"task_started"}}\n');
  assert.equal(codex.busyReason(s), 'turn in progress');
  assert.equal(codex.recheck(s, run), 'turn in progress');
  // `codex exec` sessions are skipped
  fs.writeFileSync(roll, fs.readFileSync(roll, 'utf8').replace('"source":"cli"', '"source":"exec"'));
  assert.equal(codex.listSessions({ procs: p, env: { CODEX_HOME: home }, run }).length, 0);
  fs.rmSync(home, { recursive: true, force: true });
});

test('codex: registered; --only matches the native binary pid too; evaluate skips a busy turn', () => {
  assert.deepEqual(AGENTS.map((a) => a.name), ['claude', 'codex']);
  const s = { agent: 'codex', pid: 701, pids: [701, 702], sessionId: CX_ID, tty: '/dev/ttys010' };
  assert.ok(matchesOnly('702', s, null) && matchesOnly('701', s, null) && !matchesOnly('703', s, null));
  const p = parsePs(fx('ps-codex.txt'));
  const fake = (busy) => ({ lastActivity: () => ({ ms: NOW - 5 * DAY }), busyReason: () => busy });
  const ev = (busy) => evaluate({ sessions: [s], panes: [], procs: p, adapters: { codex: fake(busy) }, protect: new Set([1]), days: 3, now: NOW })[0];
  assert.equal(ev(null).ok, true);
  assert.equal(ev(null).memMb, Math.round((27000 + 110000 + 40000) / 1024));
  assert.equal(ev('turn in progress').reason, 'busy (turn in progress)');
});

// ---------- shell-only wake prompt (no Node while waiting) ----------
import { spawnSync } from 'node:child_process';
import { wakeTypedLine, sleepText, fishQ, shellKind, q as shq } from '../src/park.js';

const ODD = [`it's "quoted" $HOME \`tick\` \\ back`, 'emoji 🧴 \u00e9', 'line1\nline2\x1b[31m', '$(touch /tmp/agent-snooze-pwned)'];
const recFor = (label) => ({ label, agent: 'claude', idleDays: 4 });

test('wake line (posix): waits with printf + read, starts Node only after Enter', () => {
  const line = wakeTypedLine(recFor('x'), 'posix', 'NODE SCRIPT');
  assert.match(line, /^printf '.*%s\\n' '.*'; read -r _; eval "\$\(NODE SCRIPT wake --emit --now\)"$/);
  assert.ok(line.indexOf('read -r _') < line.indexOf('NODE SCRIPT'), 'no node before read');
});

test('wake line (fish): fish read + command substitution, --shell fish', () => {
  const line = wakeTypedLine(recFor('x'), 'fish', 'NODE SCRIPT');
  assert.match(line, /; read -l _snooze; eval \(NODE SCRIPT wake --emit --now --shell fish\)$/);
  assert.equal(fishQ(`a'b\\c`), `'a\\'b\\\\c'`);
});

test('wake line: odd labels survive real zsh and bash and never execute', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snz-'));
  const fake = path.join(dir, 'fake.sh');
  fs.writeFileSync(fake, '#!/bin/sh\necho "echo RESUMED"\n', { mode: 0o755 });
  for (const sh of ['zsh', 'bash']) {
    for (const label of ODD) {
      const line = wakeTypedLine(recFor(label), 'posix', shq(fake));
      const r = spawnSync(sh, ['-c', line], { input: '\n', encoding: 'utf8' });
      assert.equal(r.status, 0, `${sh} ${label}: ${r.stderr}`);
      assert.match(r.stdout, /RESUMED/);
      assert.ok(r.stdout.includes(sleepText(recFor(label))), `${sh}: text shown verbatim for ${JSON.stringify(label)}`);
    }
  }
  assert.ok(!fs.existsSync('/tmp/agent-snooze-pwned'));
  fs.rmSync(dir, { recursive: true });
});

test('wake line: fish form when fish is installed', { skip: spawnSync('fish', ['-c', 'true']).error ? 'fish not installed' : false }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snz-'));
  const fake = path.join(dir, 'fake.sh');
  fs.writeFileSync(fake, '#!/bin/sh\necho "echo RESUMED"\n', { mode: 0o755 });
  for (const label of ODD) {
    const r = spawnSync('fish', ['-c', wakeTypedLine(recFor(label), 'fish', fishQ(fake))], { input: '\n', encoding: 'utf8' });
    assert.equal(r.status, 0, `${label}: ${r.stderr}`);
    assert.match(r.stdout, /RESUMED/);
    assert.ok(r.stdout.includes(sleepText(recFor(label))));
  }
  fs.rmSync(dir, { recursive: true });
});

test('sleepText is one line; shellKind picks the tab shell, fish vs posix, bash fallback', () => {
  assert.ok(!/[\n\r\x1b]/.test(sleepText(recFor(ODD[2]))));
  const procs = parsePs([' 10 1 0 100 ttys001 -fish', ' 11 10 0 100 ttys001 claude', ' 20 1 0 100 ttys002 -zsh', ' 21 20 0 100 ttys002 claude', ' 30 1 0 100 ttys003 launchd'].join('\n'));
  assert.equal(shellKind({ pid: 11 }, null, procs), 'fish');
  assert.equal(shellKind({ pid: 21 }, null, procs), 'posix');
  assert.equal(shellKind({ pid: 31 }, null, procs), 'posix');
  assert.equal(shellKind({ pid: 31 }, { shellPid: 10 }, procs), 'fish');
});

test('parseArgs: --lazy and --shell', () => {
  const o = parseArgs(['wake', '--emit', '--lazy', '--shell', 'fish']);
  assert.equal(o.lazy, true); assert.equal(o.wakeShell, 'fish');
  assert.equal(parseArgs(['wake', '--shell', 'zsh']).wakeShell, 'posix');
});

test('resumeLine fish quoting', async () => {
  const { resumeLine } = await import('../src/wake.js');
  assert.equal(resumeLine({ resume: { cwd: "/tmp/it's", argv: ['claude', '--resume', 'a'] } }, 'fish'), `cd '/tmp/it\\'s' && 'claude' '--resume' 'a'`);
});

// ---------- how a sleeping tab calls agent-snooze back ----------
import { resolveSelfCommand, findOnPath, isEphemeralPath } from '../src/invoke.js';

test('invoke: uses `agent-snooze` when a real install is on PATH', () => {
  const r = resolveSelfCommand({ env: {}, bin: '/opt/x/bin/agent-snooze.js', execPath: '/usr/bin/node', which: () => '/usr/local/bin/agent-snooze' });
  assert.deepEqual(r, { cmd: 'agent-snooze', how: 'path' });
  const line = wakeTypedLine(recFor('x'), 'posix', r.cmd);
  assert.match(line, /eval "\$\(agent-snooze wake --emit --now\)"$/);
});

test('invoke: falls back to absolute node + script, quoted', () => {
  const r = resolveSelfCommand({ env: {}, bin: "/home/u/it's/bin/agent-snooze.js", execPath: '/usr/bin/node', which: () => null });
  assert.equal(r.how, 'absolute');
  assert.equal(r.cmd, `'/usr/bin/node' '/home/u/it'\\''s/bin/agent-snooze.js'`);
  assert.equal(r.warning, undefined);
});

test('invoke: npx cache path warns and recommends a global install', () => {
  const bin = '/home/u/.npm/_npx/1a2b3c/node_modules/agent-snooze/bin/agent-snooze.js';
  const r = resolveSelfCommand({ env: {}, bin, execPath: '/usr/bin/node', which: () => null });
  assert.equal(r.how, 'ephemeral');
  assert.match(r.warning, /npm i -g agent-snooze/);
  assert.ok(r.cmd.includes(bin), 'still works until the cache is cleaned');
  for (const p of [bin, '/tmp/bunx-501-agent-snooze/x.js', '/Users/u/Library/Caches/pnpm/dlx/abc/node_modules/agent-snooze/bin/agent-snooze.js']) assert.ok(isEphemeralPath(p), p);
  for (const p of ['/usr/local/lib/node_modules/agent-snooze/bin/agent-snooze.js', '/home/u/src/agent-snooze/bin/agent-snooze.js']) assert.ok(!isEphemeralPath(p), p);
});

test('invoke: findOnPath skips node_modules/.bin, npx cache entries and relative dirs', () => {
  const env = { PATH: ['rel/bin', '/home/u/.npm/_npx/9f/node_modules/.bin', '/home/u/proj/node_modules/.bin', '/opt/cache', '/usr/local/bin'].join(path.delimiter) };
  const exists = new Set(['/home/u/.npm/_npx/9f/node_modules/.bin/agent-snooze', '/home/u/proj/node_modules/.bin/agent-snooze', '/opt/cache/agent-snooze', '/usr/local/bin/agent-snooze', 'rel/bin/agent-snooze']);
  const real = (p) => (p === '/opt/cache/agent-snooze' ? '/home/u/.npm/_npx/9f/node_modules/agent-snooze/bin/agent-snooze.js' : p);
  assert.equal(findOnPath(env, { isExec: (p) => exists.has(p), realpath: real }), '/usr/local/bin/agent-snooze');
  assert.equal(findOnPath({ PATH: '/home/u/proj/node_modules/.bin' }, { isExec: (p) => exists.has(p), realpath: real }), null);
  assert.equal(findOnPath({}, { isExec: () => true, realpath: real }), null);
});

test('invoke: old parked tabs keep working (wake flags their typed lines use still parse)', () => {
  // Tabs parked by earlier builds typed `eval "$(<node> <script> wake --emit)"` or `... wake --emit --now`,
  // and hooks run `wake --emit --lazy --tty X [--shell fish]`.
  for (const argv of [['wake', '--emit'], ['wake', '--emit', '--now'], ['wake', '--emit', '--now', '--shell', 'fish'], ['wake', '--emit', '--lazy', '--tty', '/dev/ttys003'], ['wake', '--emit', '--lazy', '--shell', 'fish', '--tty', '/dev/ttys003']]) {
    const o = parseArgs(argv);
    assert.equal(o.cmd, 'wake'); assert.equal(o.emit, true);
  }
  // the hook snippet embeds whatever command it is given
  assert.match(initSnippet('zsh', { cmd: "'/usr/bin/node' '/x/bin/agent-snooze.js'" }), /eval "\$\('\/usr\/bin\/node' '\/x\/bin\/agent-snooze.js' wake --emit --lazy/);
});
