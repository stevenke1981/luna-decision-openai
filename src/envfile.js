// Loads keys from env files so they need not live in the shell: `.env.local`, then `.env`, in
// the project folder and in LUNA_HOME. Variables already set in the environment always win,
// and the first file that sets a variable wins over later ones.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ENV_FILES = ['.env.local', '.env'];

/** The env files looked at, in order: the project folder first, then LUNA_HOME. */
export function envFileCandidates(env = process.env, root = ROOT) {
  const home = env.LUNA_HOME || path.join(os.homedir(), '.luna-decision-openai');
  const dirs = [...new Set([root, home].map((d) => path.resolve(d)))];
  return dirs.flatMap((dir) => ENV_FILES.map((f) => path.join(dir, f)));
}

/**
 * Copies variables from the env files into `env` without replacing any that are set.
 * @returns {{file:string, keys:string[]}[]} the files read and the variables each one set
 */
export function loadEnvFiles(env = process.env, files = envFileCandidates(env)) {
  const loaded = [];
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw new Error(`cannot read ${file}: ${err.message}`);
    }
    const keys = [];
    for (const [key, value] of Object.entries(parseEnv(text))) {
      if (env[key] != null && env[key] !== '') continue;
      env[key] = value;
      keys.push(key);
    }
    loaded.push({ file, keys });
  }
  return loaded;
}
