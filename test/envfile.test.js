import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadEnvFiles, envFileCandidates } from '../src/envfile.js';
import { authLine, addGlobal } from '../src/codexconfig.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'luna-env-'));
}

test('env files: the project folder first, then LUNA_HOME; .env.local before .env', () => {
  const root = tempDir();
  const home = tempDir();
  try {
    assert.deepEqual(envFileCandidates({ LUNA_HOME: home }, root), [
      path.join(root, '.env.local'), path.join(root, '.env'), path.join(home, '.env.local'), path.join(home, '.env'),
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('env files fill only unset variables, and the first file wins', () => {
  const dir = tempDir();
  try {
    const local = path.join(dir, '.env.local');
    const plain = path.join(dir, '.env');
    fs.writeFileSync(local, '# keys\nOPENAI_API_KEY=sk-local\nOPENROUTER_API_KEY="sk-or-local"\nLUNA_MODEL=\n');
    fs.writeFileSync(plain, 'OPENAI_API_KEY=sk-plain\nLUNA_MODEL=gpt-6.1-sol\nLUNA_PORT=9000\n');
    const env = { LUNA_PORT: '8791', LUNA_MODEL: '' };
    const loaded = loadEnvFiles(env, [local, plain, path.join(dir, 'missing.env')]);
    assert.equal(env.OPENAI_API_KEY, 'sk-local');
    assert.equal(env.OPENROUTER_API_KEY, 'sk-or-local');
    // An empty value in an earlier file does not block a later one, and the shell's value wins.
    assert.equal(env.LUNA_MODEL, 'gpt-6.1-sol');
    assert.equal(env.LUNA_PORT, '8791');
    assert.deepEqual(loaded.map((l) => path.basename(l.file)), ['.env.local', '.env']);
    assert.deepEqual(loaded[1].keys, ['LUNA_MODEL']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('provider sets how Codex authenticates: login, OPENAI_API_KEY or OPENROUTER_API_KEY', () => {
  assert.equal(authLine(), 'requires_openai_auth = true');
  assert.equal(authLine('openai'), 'env_key = "OPENAI_API_KEY"');
  assert.equal(authLine('openrouter'), 'env_key = "OPENROUTER_API_KEY"');
  assert.throws(() => authLine('azure'), /unknown provider/);
  const text = addGlobal('', { host: '127.0.0.1', port: 8791, model: 'gpt-6.1-terra', defaultEffort: 'medium', provider: 'openrouter' });
  assert.match(text, /env_key = "OPENROUTER_API_KEY"/);
  assert.doesNotMatch(text, /requires_openai_auth/);
});
