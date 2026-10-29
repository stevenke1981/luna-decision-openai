import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/luna.js', import.meta.url));
const RUN_TIMEOUT_MS = 15000;

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function run(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env, timeout: RUN_TIMEOUT_MS }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, out: stdout + stderr });
    });
  });
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'luna-decision-openai-test-'));
}

/** The parent environment minus every LUNA_* and OPENAI_* variable, plus the given ones. */
function cleanEnv(extra = {}) {
  const inherited = Object.entries(process.env).filter(([key]) => !/^(LUNA|OPENAI)_/.test(key));
  return { ...Object.fromEntries(inherited), ...extra };
}

/** Answers /luna/health with the given payload on a free port, as another app would. */
async function fakeHealthServer(payload) {
  const port = await freePort();
  const server = http.createServer((req, res) => {
    const health = req.url === '/luna/health';
    res.writeHead(health ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(health ? payload : {}));
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return {
    port,
    close: () => new Promise((r) => {
      server.close(r);
      server.closeAllConnections();
    }),
  };
}

/** A real process the CLI must never signal. */
function bystander() {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
}

test('luna-decision-openai stop stops a running proxy and is a no-op when none runs', async () => {
  const port = await freePort();
  const home = tempDir();
  const env = cleanEnv({ LUNA_PORT: String(port), LUNA_HOME: home, LUNA_MODE: 'heuristic', LUNA_QUIET: '1' });
  const child = spawn(process.execPath, [CLI, 'serve'], { env, stdio: 'ignore' });
  const exited = new Promise((r) => child.on('exit', r));
  try {
    for (let i = 0; i < 50 && (await run(['status'], env)).code !== 0; i++) await new Promise((r) => setTimeout(r, 100));

    const stopped = await run(['stop'], env);
    assert.equal(stopped.code, 0, stopped.out);
    assert.match(stopped.out, new RegExp(`stopped luna-decision-openai proxy \\(pid ${child.pid},`));
    await exited;

    const again = await run(['stop'], env);
    assert.equal(again.code, 0);
    assert.match(again.out, /no luna-decision-openai proxy/);
  } finally {
    child.kill();
    await exited;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('stop and status never signal or reuse a server that does not name luna-decision-openai', async () => {
  const victim = bystander();
  const home = tempDir();
  const fake = await fakeHealthServer({ app: 'some-other-app', version: '9.9.9', build: 'x', pid: victim.pid });
  const anon = await fakeHealthServer({ version: '9.9.9', build: 'x', pid: victim.pid });
  const env = { ...process.env, LUNA_PORT: String(fake.port), LUNA_HOME: home, LUNA_QUIET: '1' };
  try {
    const stopped = await run(['stop'], env);
    assert.equal(stopped.code, 1, stopped.out);
    assert.match(stopped.out, /port \d+ is answered by app "some-other-app", not a luna-decision-openai proxy/);
    assert.match(stopped.out, /not stopping it/);

    const status = await run(['status'], env);
    assert.equal(status.code, 1);
    assert.match(status.out, /not a luna-decision-openai proxy/);

    // A server whose health has no app field at all is foreign too.
    const anonStop = await run(['stop'], { ...env, LUNA_PORT: String(anon.port) });
    assert.equal(anonStop.code, 1);
    assert.match(anonStop.out, /no app id/);

    // Codex must not be pointed at a foreign server: ensureProxy refuses before any codex lookup.
    // PATH and APPDATA are emptied so that, if the guard regressed, codex still could not start.
    const codex = await run(['codex'], { ...env, PATH: '', Path: '', APPDATA: home });
    assert.equal(codex.code, 1);
    assert.match(codex.out, /not a luna-decision-openai proxy/);

    assert.equal(victim.exitCode, null, 'bystander exited, so the CLI signalled it');
    assert.equal(victim.signalCode, null, 'bystander was signalled');
  } finally {
    victim.kill();
    await fake.close();
    await anon.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('serve names the other app when its port is taken and does not reuse it', async () => {
  const fake = await fakeHealthServer({ app: 'other-app' });
  const home = tempDir();
  try {
    const served = await run(['serve'], { ...process.env, LUNA_PORT: String(fake.port), LUNA_HOME: home, LUNA_QUIET: '1' });
    assert.equal(served.code, 1, served.out);
    assert.match(served.out, /EADDRINUSE/);
    assert.match(served.out, /answered by app "other-app", not a luna-decision-openai proxy/);
  } finally {
    await fake.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('serve follows decisions when an existing luna-decision-openai proxy owns the port', async () => {
  const fake = await fakeHealthServer({ app: 'luna-decision-openai', version: '0.3.0', build: 'old', pid: 123 });
  const home = tempDir();
  const child = spawn(process.execPath, [CLI, 'serve'], {
    env: { ...process.env, LUNA_PORT: String(fake.port), LUNA_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  try {
    for (let i = 0; i < 50 && !output.includes('following'); i++) await new Promise((r) => setTimeout(r, 100));
    assert.match(output, /Following decisions/);
    const record = JSON.stringify({ step: 7, effort: 'high', hold: 1, ms: 3, reasons: ['test decision'] }) + '\n';
    fs.appendFileSync(path.join(home, 'decisions.jsonl'), record.slice(0, 15));
    await new Promise((r) => setTimeout(r, 500));
    fs.appendFileSync(path.join(home, 'decisions.jsonl'), record.slice(15));
    for (let i = 0; i < 50 && !output.includes('test decision'); i++) await new Promise((r) => setTimeout(r, 100));
    assert.match(output, /HIGH/);
    assert.match(output, /test decision/);
    assert.equal(child.exitCode, null);
  } finally {
    child.kill();
    await new Promise((r) => child.once('exit', r));
    await fake.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('install writes the luna-decision Codex profile for the configured model and default effort, refusing foreign files', async () => {
  const codexHome = tempDir();
  const env = cleanEnv({ CODEX_HOME: codexHome, LUNA_PORT: '9999', LUNA_MODEL: 'gpt-6.1-terra', LUNA_HOME: codexHome });
  const file = path.join(codexHome, 'luna-decision.config.toml');
  try {
    const first = await run(['install'], env);
    assert.equal(first.code, 0, first.out);
    const toml = fs.readFileSync(file, 'utf8');
    assert.ok(toml.startsWith('# Generated by `luna-decision-openai install`'));
    assert.match(toml, /^model_provider = "luna-decision"$/m);
    assert.match(toml, /^model = "gpt-6\.1-terra"$/m);
    assert.match(toml, /^model_reasoning_effort = "medium"$/m);
    assert.match(toml, /^base_url = "http:\/\/127\.0\.0\.1:9999\/v1"$/m);
    assert.ok(toml.indexOf('model_reasoning_effort = ') < toml.indexOf('[model_providers.luna-decision]'), 'settings must sit above the table');
    // No profile under the names this fork inherited from laya-gpt.
    for (const legacy of ['laya.config.toml', 'layagpt.config.toml']) {
      assert.ok(!fs.existsSync(path.join(codexHome, legacy)), legacy);
    }

    fs.writeFileSync(file, 'hand written\n');
    const second = await run(['install'], env);
    assert.equal(second.code, 1);
    assert.match(second.out, /was not written by luna-decision-openai/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'hand written\n');
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('install --global makes luna-decision-openai the default in config.toml with a backup; uninstall restores it', async () => {
  const codexHome = tempDir();
  const env = cleanEnv({ CODEX_HOME: codexHome, LUNA_PORT: '9999', LUNA_HOME: codexHome });
  const main = path.join(codexHome, 'config.toml');
  const original = 'model = "gpt-5"\n\n[mcp_servers.docs]\ncommand = "docs-mcp"\n';
  try {
    fs.writeFileSync(main, original);
    const first = await run(['install', '--global'], env);
    assert.equal(first.code, 0, first.out);
    assert.match(fs.readFileSync(main, 'utf8'), /^model_provider = "luna-decision"$/m);
    assert.equal(fs.readFileSync(`${main}.luna-decision-openai.bak`, 'utf8'), original);
    assert.ok(fs.existsSync(path.join(codexHome, 'luna-decision.config.toml')));

    const second = await run(['install', '--global'], env);
    assert.equal(second.code, 0, second.out);
    assert.equal(fs.readFileSync(`${main}.luna-decision-openai.bak`, 'utf8'), original);

    const undo = await run(['uninstall'], env);
    assert.equal(undo.code, 0, undo.out);
    assert.equal(fs.readFileSync(main, 'utf8'), original);
    assert.ok(!fs.existsSync(path.join(codexHome, 'luna-decision.config.toml')));
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('stats groups decisions by effort in ladder order and counts resumed early stops', async () => {
  const home = tempDir();
  const rows = [
    { model: 'gpt-6.1-terra', effort: 'xhigh', session: 'a', source: 'luna', cost: 0.001,
      usage: { output_tokens: 100, output_tokens_details: { reasoning_tokens: 50 } }, continues: [{ effort: 'xhigh' }] },
    { model: 'gpt-6.1-terra', effort: 'low', session: 'b', usage: { output_tokens: 10, output_tokens_details: { reasoning_tokens: 0 } } },
    { model: 'gpt-6.1-terra', effort: 'low', session: 'b', usage: { output_tokens: 20, output_tokens_details: { reasoning_tokens: 0 } } },
    { model: 'gpt-6.1-terra', effort: 'medium', session: 'c', continues: [{ effort: 'high' }, { effort: 'xhigh' }] },
    { model: 'gpt-6.1-terra', effort: null, session: 'd' },
  ];
  fs.writeFileSync(path.join(home, 'decisions.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  try {
    const res = await run(['stats'], { ...process.env, LUNA_HOME: home });
    assert.equal(res.code, 0, res.out);
    assert.match(res.out, /^5 generations, 4 sessions, 1 routed by Luna, 3 early stops resumed\r?\n/);
    assert.match(res.out, /low\s+2 gens\s+0 avg reasoning tok\s+30 output tok/);
    assert.match(res.out, /xhigh\s+1 gens\s+50 avg reasoning tok\s+100 output tok/);
    assert.match(res.out, /\n {2}-\s+1 gens/);

    const order = ['  low', '  medium', '  xhigh', '  -'].map((s) => res.out.indexOf(s));
    assert.ok(order.every((i) => i > 0), res.out);
    assert.deepEqual([...order].sort((a, b) => a - b), order);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('stats counts self-review rounds apart from resumed early stops', async () => {
  const home = tempDir();
  const rows = [{ effort: 'medium', session: 'a', continues: [{ kind: 'resume', effort: 'high' }, { kind: 'review', effort: 'high' }] }];
  fs.writeFileSync(path.join(home, 'decisions.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  try {
    const res = await run(['stats'], { ...process.env, LUNA_HOME: home });
    assert.equal(res.code, 0, res.out);
    assert.match(res.out, /^1 generations, 1 sessions, 0 routed by Luna, 1 early stops resumed, 1 self-review rounds\r?\n/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('help names the luna-decision-openai commands, the variables and the port', async () => {
  const home = tempDir();
  try {
    const res = await run([], { ...process.env, LUNA_HOME: home });
    assert.equal(res.code, 0);
    assert.match(res.out, /luna-decision-openai serve/);
    assert.match(res.out, /codex -p luna-decision/);
    for (const name of ['LUNA_MODEL (gpt-6.1-terra)', 'LUNA_DEFAULT_EFFORT (medium)', 'LUNA_CONTINUE (on|off)',
      'LUNA_MAX_CONTINUES (20)', 'LUNA_MAX_STALLS (2)', 'LUNA_VERIFY (on|off)', 'LUNA_REVIEW_ROUNDS (1)', 'LUNA_NUDGE (on|off)', 'LUNA_PORT (8791)']) {
      assert.ok(res.out.includes(name), `help is missing ${name}`);
    }
    assert.match(res.out, /http:\/\/127\.0\.0\.1:8791\/v1, model luna-auto/);
    assert.doesNotMatch(res.out, /jev-effort|jev-sol-terra|JEV_SOL_MODEL/);

    const version = await run(['--version'], { ...process.env, LUNA_HOME: home });
    assert.match(version.out, /^luna-decision-openai v\d+\.\d+\.\d+ \(build [0-9a-f]{12}\)/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('models lists the main models and the effort ladder, starring gpt-6.1-terra by default', async () => {
  const home = tempDir();
  try {
    const res = await run(['models'], cleanEnv({ LUNA_HOME: home }));
    assert.equal(res.code, 0, res.out);
    assert.match(res.out, /^\* gpt-6\.1-terra$/m);
    assert.match(res.out, /^ {2}gpt-6\.1-sol$/m);
    assert.match(res.out, /^ {2}gpt-6-astra$/m);
    assert.match(res.out, /effort ladder: low → medium → high → xhigh → max \(default medium\); decisions by gpt-6-luna/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('models --model and --model= star the chosen main model', async () => {
  const home = tempDir();
  const env = cleanEnv({ LUNA_HOME: home });
  try {
    for (const args of [['models', '--model', 'gpt-6.1-sol'], ['models', '--model=gpt-6.1-sol']]) {
      const res = await run(args, env);
      assert.equal(res.code, 0, res.out);
      assert.match(res.out, /^\* gpt-6\.1-sol$/m, args.join(' '));
      assert.match(res.out, /^ {2}gpt-6\.1-terra$/m, args.join(' '));
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('models --effort changes the default the ladder line shows; an effort off the ladder fails', async () => {
  const home = tempDir();
  const env = cleanEnv({ LUNA_HOME: home });
  try {
    const res = await run(['models', '--effort', 'high'], env);
    assert.equal(res.code, 0, res.out);
    assert.match(res.out, /\(default high\)/);
    assert.doesNotMatch(res.out, /\(default medium\)/);

    const bad = await run(['models', '--effort', 'turbo'], env);
    assert.equal(bad.code, 1);
    assert.match(bad.out, /LUNA_DEFAULT_EFFORT must be one of LUNA_LEVELS/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('probe without an API key exits 1 and names OPENAI_API_KEY before any call to Luna', async () => {
  const home = tempDir();
  try {
    const res = await run(['probe', 'refactor', 'the', 'cache'], cleanEnv({ LUNA_HOME: home }));
    assert.equal(res.code, 1, res.out);
    assert.match(res.out, /OPENAI_API_KEY/);
    assert.doesNotMatch(res.out, /request:/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('install --model gpt-6-astra writes the luna-decision profile for that model on port 8791', async () => {
  const codexHome = tempDir();
  const home = tempDir();
  try {
    const res = await run(['install', '--model', 'gpt-6-astra'], cleanEnv({ CODEX_HOME: codexHome, LUNA_HOME: home }));
    assert.equal(res.code, 0, res.out);
    const toml = fs.readFileSync(path.join(codexHome, 'luna-decision.config.toml'), 'utf8');
    assert.match(toml, /^model = "gpt-6-astra"$/m);
    assert.match(toml, /^model_provider = "luna-decision"$/m);
    assert.match(toml, /^base_url = "http:\/\/127\.0\.0\.1:8791\/v1"$/m);
    assert.match(toml, /^\[model_providers\.luna-decision\]$/m);
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
