// Close = SIGTERM, then wait (default up to 60s). Never SIGKILL.
import { alive, waitFor } from './proc.js';
import { CLOSE_TIMEOUT_MS } from './config.js';

export function closeProcess(pid, { timeoutMs = CLOSE_TIMEOUT_MS, kill = process.kill.bind(process), isAlive = alive } = {}) {
  const t0 = Date.now();
  try { kill(pid, 'SIGTERM'); } catch (e) { if (e.code === 'ESRCH') return { ok: true, ms: 0 }; return { ok: false, ms: 0, error: e.message }; }
  const ok = waitFor(() => !isAlive(pid), timeoutMs, 250);
  return { ok, ms: Date.now() - t0 };
}
