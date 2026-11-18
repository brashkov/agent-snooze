import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** First executable named `name` on PATH or in the extra dirs, else null. */
export function which(name, extraDirs = [], env = process.env) {
  const dirs = [...(env.PATH || '').split(path.delimiter), ...extraDirs.map((d) => d.replace(/^~/, os.homedir()))];
  for (const d of dirs) {
    if (!d) continue;
    const f = path.join(d, name);
    try { fs.accessSync(f, fs.constants.X_OK); return f; } catch { /* next */ }
  }
  return null;
}
