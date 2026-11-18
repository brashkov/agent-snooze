// Every action is printed and appended to the log file.
import fs from 'node:fs';
import path from 'node:path';
import { logFile } from './config.js';

export function makeLogger({ mode = 'DRY', env = process.env, quiet = false } = {}) {
  const file = logFile(env);
  return (msg) => {
    const line = `${new Date().toISOString()} ${mode} ${msg}`;
    if (!quiet) console.log(`${mode} ${msg}`);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, line + '\n');
    } catch { /* logging must never break a run */ }
  };
}
