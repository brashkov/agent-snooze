// Paths and defaults. Everything can be overridden by env, so tests never touch real state.
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_DAYS = 3;
export const CLOSE_TIMEOUT_MS = 60_000;
export const SHELL_WAIT_MS = 10_000;
export const BUSY_CPU_PERCENT = 5;
export const SHELLS = ['zsh', 'bash', 'fish', 'sh', 'dash', 'ksh', 'tcsh', 'nu'];

export function stateDir(env = process.env) {
  return env.AGENT_SNOOZE_HOME || path.join(os.homedir(), '.agent-snooze');
}
export const parkedDir = (env) => path.join(stateDir(env), 'parked');
export const hooksDir = (env) => path.join(stateDir(env), 'hooks');
export const logFile = (env) => path.join(stateDir(env), 'agent-snooze.log');
