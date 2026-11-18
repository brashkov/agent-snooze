// How a sleeping tab (or the shell hook) calls agent-snooze back.
// The line is typed into another shell, possibly much later, so the command must still work then:
//   1. `agent-snooze` when a real install is on PATH (npm i -g, brew, a symlink you made)
//   2. else the absolute node + script path of this copy (a git checkout, a local install)
//   3. if this copy lives in an npx/pnpm dlx/bunx cache, (2) still works but the cache can be cleaned:
//      warn and recommend a global install.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BIN = fileURLToPath(new URL('../bin/agent-snooze.js', import.meta.url));
export const INSTALL_HINT = 'npm i -g agent-snooze';
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** True for package-runner caches that get cleaned: npx (_npx), pnpm dlx, bunx, yarn dlx. */
export function isEphemeralPath(p) {
  const s = String(p || '').replace(/\\/g, '/');
  return /\/_npx\//.test(s) || /\/dlx[-/]/.test(s) || /\/bunx-/.test(s) || /\/xfs-[^/]+\/dlx/.test(s);
}

function defaultRealpath(p) { try { return fs.realpathSync(p); } catch { return null; } }
function defaultIsExec(p) {
  try { const st = fs.statSync(p); return st.isFile() && (st.mode & 0o111) !== 0; } catch { return false; }
}

/**
 * Find `agent-snooze` on PATH, skipping entries a later shell would not have:
 * npx/npm-run add `node_modules/.bin` dirs to PATH only while they run, and cache paths vanish.
 */
export function findOnPath(env = process.env, { isExec = defaultIsExec, realpath = defaultRealpath } = {}) {
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    if (/\/node_modules\/\.bin\/?$/.test(dir.replace(/\\/g, '/'))) continue;
    const p = path.join(dir, 'agent-snooze');
    if (!isExec(p)) continue;
    const real = realpath(p) || p;
    if (isEphemeralPath(p) || isEphemeralPath(real)) continue;
    return p;
  }
  return null;
}

/** Pure: decide the command. Returns { cmd, how: 'path' | 'absolute' | 'ephemeral', warning? }. */
export function resolveSelfCommand({ env = process.env, bin = BIN, execPath = process.execPath, which = findOnPath } = {}) {
  if (which(env)) return { cmd: 'agent-snooze', how: 'path' };
  const cmd = `${q(execPath)} ${q(bin)}`;
  if (isEphemeralPath(bin)) {
    return {
      cmd, how: 'ephemeral',
      warning: `agent-snooze is running from a temporary npx cache (${bin}). Sleeping tabs will call that path, `
        + `which stops working when the cache is cleaned. Install it for good with: ${INSTALL_HINT}`,
    };
  }
  return { cmd, how: 'absolute' };
}

let cached = null;
/** Memoized for this process. Warns once on stderr when running from an npx cache. */
export function selfCommand() {
  if (!cached) {
    cached = resolveSelfCommand();
    if (cached.warning) process.stderr.write(`agent-snooze: warning: ${cached.warning}\n`);
  }
  return cached.cmd;
}
export function selfCommandInfo() { selfCommand(); return cached; }
