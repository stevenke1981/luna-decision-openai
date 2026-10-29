import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import {
  loadRolePack, pickRoleSet, loadRoles, roleQuestion, roleFromAnswer, ruleRole, roleText, NO_ROLE,
} from '../src/roles.js';
import { lunaDecide, resetLunaPause, effortCall, requestBody } from '../src/decisions.js';
import { createRouter } from '../src/router.js';
import { createProxy } from '../src/proxy.js';
import { loadConfig } from '../src/config.js';
import { parseTurn } from '../src/trajectory.js';

const role = (id, mode, extra = {}) => ({
  id, kind: 'role', department: 'engineering', title: `${id} title`, model_tier: 'sol', mode, methods: `${id} method`,
  steps: ['step one', 'step two'], outputs: ['a diff'], exit_criteria: ['tests pass'], handoffs: [],
  file: `agents/roles/${id}.agent.md`, native_file: `.codex/agents/team_${id}.toml`, ...extra,
});
const REGISTRY = {
  schema_version: 1,
  departments: [],
  roles: [
    role('python_engineer', 'author'), role('test_engineer', 'author'), role('technical_writer', 'author'),
    role('debugging_engineer', 'author'), role('planner', 'coordinate'), role('independent_reviewer', 'review'),
  ],
};
const PROFILES = { lean: ['planner', 'python_engineer', 'independent_reviewer'], product: ['python_engineer', 'test_engineer', 'technical_writer'], review: ['independent_reviewer'] };
const SKILL = (name, description, body) => `---\nname: ${name}\ndescription: "${description}"\nlicense: MIT\n---\n\n${body}\n`;

const tmp = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-roles-'));
  tmp.push(dir);
  return dir;
}
afterEach(() => {
  while (tmp.length) fs.rmSync(tmp.pop(), { recursive: true, force: true });
  resetLunaPause();
});

function writeFiles(root, files) {
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
}

// A zip with one entry per file: deflated, or stored when `stored` (the reader needs no CRC).
function writeZip(file, files, { stored = false } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text);
    const data = stored ? raw : zlib.deflateRawSync(raw);
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeFileSync(file, Buffer.concat([...locals, dir, end]));
}

const teamFiles = (prefix = 'agent-team-workflow/') => ({
  [`${prefix}config/registry.json`]: JSON.stringify(REGISTRY),
  [`${prefix}config/profiles.json`]: JSON.stringify(PROFILES),
  [`${prefix}README.md`]: '# pack',
});
const skillFiles = {
  'game-pack/game-level-design/SKILL.md': SKILL('game-level-design', '關卡設計、節奏與難度曲線', '# Level design\n1. 先畫節奏圖'),
  'game-pack/game-audio-mixing/SKILL.md': SKILL('game-audio-mixing', '遊戲音效混音與響度', '# Audio mixing'),
  'game-pack/notes.md': 'not a skill',
};

test('loadRolePack reads a team pack from a folder, a deflated zip and a stored zip alike', () => {
  const dir = tempDir();
  writeFiles(path.join(dir, 'folder'), teamFiles());
  writeZip(path.join(dir, 'pack.zip'), teamFiles());
  writeZip(path.join(dir, 'stored.zip'), teamFiles(''), { stored: true });
  const fromFolder = loadRolePack(path.join(dir, 'folder'));
  assert.equal(fromFolder.roles.length, 6);
  assert.deepEqual(Object.keys(fromFolder.profiles), ['lean', 'product', 'review']);
  assert.deepEqual(loadRolePack(path.join(dir, 'pack.zip')), fromFolder);
  assert.deepEqual(loadRolePack(path.join(dir, 'stored.zip')), fromFolder);
  const py = fromFolder.roles[0];
  assert.deepEqual(
    [py.id, py.kind, py.mode, py.methods, py.steps, py.outputs, py.exitCriteria, py.native],
    ['python_engineer', 'role', 'author', 'python_engineer method', ['step one', 'step two'], ['a diff'], ['tests pass'], 'team_python_engineer']);
});

test('loadRolePack reads a skill pack: each SKILL.md with a name is one specialist', () => {
  const dir = tempDir();
  writeZip(path.join(dir, 'game.zip'), skillFiles);
  const pack = loadRolePack(path.join(dir, 'game.zip'));
  assert.deepEqual(pack.roles.map((r) => [r.id, r.kind, r.methods]), [
    ['game-level-design', 'skill', '關卡設計、節奏與難度曲線'],
    ['game-audio-mixing', 'skill', '遊戲音效混音與響度'],
  ]);
  assert.equal(pack.roles[0].body, '# Level design\n1. 先畫節奏圖');
  assert.deepEqual(pack.profiles, {});
});

test('loadRolePack refuses a pack that is neither kind, and a file that is not a zip', () => {
  const dir = tempDir();
  writeZip(path.join(dir, 'empty.zip'), { 'x/readme.md': 'hi' });
  fs.writeFileSync(path.join(dir, 'bad.zip'), 'not a zip');
  assert.throws(() => loadRolePack(path.join(dir, 'empty.zip')), /neither a team pack/);
  assert.throws(() => loadRolePack(path.join(dir, 'bad.zip')), /not a zip file/);
});

test('pickRoleSet: product by default, a profile keeps its implementers, author, lists and errors', () => {
  const pack = { roles: loadFromRegistry(), profiles: PROFILES };
  assert.deepEqual(ids(pickRoleSet(pack)), ['python_engineer', 'test_engineer', 'technical_writer']);
  assert.deepEqual(ids(pickRoleSet(pack, 'lean')), ['python_engineer']);
  // A profile with no implementer keeps all of its roles.
  assert.deepEqual(ids(pickRoleSet(pack, 'review')), ['independent_reviewer']);
  assert.deepEqual(ids(pickRoleSet(pack, 'author')), ['python_engineer', 'test_engineer', 'technical_writer', 'debugging_engineer']);
  assert.deepEqual(ids(pickRoleSet(pack, 'planner, debugging_engineer')), ['planner', 'debugging_engineer']);
  assert.throws(() => pickRoleSet(pack, 'nobody'), /role set must be one of author, lean, product, review or a comma list of ids; unknown: nobody/);
  // Without a product profile the default is every implementer, or every skill.
  assert.equal(pickRoleSet({ roles: loadFromRegistry(), profiles: {} }).length, 4);
});

function loadFromRegistry() {
  const dir = tempDir();
  writeFiles(dir, teamFiles(''));
  return loadRolePack(dir).roles;
}
const ids = (roles) => roles.map((r) => r.id);

test('loadRoles combines packs with per-pack sets; an id taken by an earlier pack is skipped', () => {
  const dir = tempDir();
  writeZip(path.join(dir, 'team.zip'), teamFiles());
  writeZip(path.join(dir, 'game.zip'), skillFiles);
  writeZip(path.join(dir, 'dup.zip'), { 'x/config/registry.json': JSON.stringify({ roles: [role('python_engineer', 'author', { title: 'other' })] }) });
  const team = path.join(dir, 'team.zip');
  const { roles, packs } = loadRoles(`${team}|lean;\n${path.join(dir, 'game.zip')} ; ${path.join(dir, 'dup.zip')} | author`, 'product');
  assert.deepEqual(ids(roles), ['python_engineer', 'game-level-design', 'game-audio-mixing']);
  assert.equal(roles[0].title, 'python_engineer title');
  assert.deepEqual(packs.map((p) => [p.set, p.count]), [['lean', 1], ['(default)', 2], ['author', 0]]);
  // A pack's own |set must fit it.
  assert.throws(() => loadRoles(`${path.join(dir, 'game.zip')}|product`), /game.zip: role set must be one of author/);
  assert.throws(() => loadRoles(path.join(dir, 'missing.zip')), /LUNA_ROLE_PACK .*missing\.zip: ENOENT/);
  assert.deepEqual(loadRoles(''), { roles: [], packs: [] });
});

const PY = { id: 'python_engineer', kind: 'role', title: 'Python 工程師', mode: 'author', methods: '型別提示', steps: ['s1', 's2'], outputs: ['diff'], exitCriteria: ['tests pass'], native: 'team_python_engineer', body: '' };
const SK = { id: 'game-level-design', kind: 'skill', title: 'game-level-design', mode: 'skill', methods: '關卡設計', steps: [], outputs: [], exitCriteria: [], native: null, body: '# Level design' };

test('roleQuestion lists every specialist and a "none" choice', () => {
  const q = roleQuestion([PY, SK]);
  assert.deepEqual([q.type, q.name], ['choice', 'role']);
  assert.deepEqual(q.choices.map((c) => c.value), ['python_engineer', 'game-level-design', NO_ROLE]);
  assert.equal(q.choices[0].description, 'Python 工程師: 型別提示');
  assert.ok(roleQuestion([{ ...PY, methods: 'x'.repeat(500) }]).choices[0].description.length <= 161);
});

test('roleFromAnswer: the chosen specialist above the confidence, else null', () => {
  const answer = (choice, extra = {}) => ({ type: 'choice', name: 'role', choice, ...extra });
  assert.deepEqual(roleFromAnswer(answer('python_engineer', { confidence: 0.8 }), [PY], 0.4), { id: 'python_engineer', confidence: 0.8 });
  assert.deepEqual(roleFromAnswer(answer('python_engineer', { probabilities: [{ value: 'python_engineer', probability: 0.6 }] }), [PY], 0.4), { id: 'python_engineer', confidence: 0.6 });
  assert.deepEqual(roleFromAnswer(answer('python_engineer', { probabilities: { python_engineer: 0.7 } }), [PY], 0.4), { id: 'python_engineer', confidence: 0.7 });
  assert.equal(roleFromAnswer(answer('python_engineer', { confidence: 0.3 }), [PY], 0.4), null);
  assert.equal(roleFromAnswer(answer(NO_ROLE, { confidence: 0.9 }), [PY], 0.4), null);
  assert.equal(roleFromAnswer(answer('ghost', { confidence: 0.9 }), [PY], 0.4), null);
  assert.equal(roleFromAnswer({ type: 'refusal' }, [PY], 0.4), null);
  assert.equal(roleFromAnswer(undefined, [PY], 0.4), null);
});

test('ruleRole: team roles by request words, skills by the words of their names', () => {
  const team = [PY, { ...PY, id: 'test_engineer' }, { ...PY, id: 'technical_writer' }];
  assert.equal(ruleRole('add pytest unit tests for the parser', team), 'test_engineer');
  assert.equal(ruleRole('update the README', team), 'technical_writer');
  assert.equal(ruleRole('port this script to Python', team), 'python_engineer');
  assert.equal(ruleRole('hi', team), null);
  // A role outside the active set is never picked.
  assert.equal(ruleRole('debug the crash', team), null);
  const skills = [SK, { ...SK, id: 'game-audio-mixing' }];
  assert.equal(ruleRole('improve the level design of stage 2', skills), 'game-level-design');
  assert.equal(ruleRole('fix the audio mixing levels', skills), 'game-audio-mixing');
  assert.equal(ruleRole('design a logo', skills), null);
});

test('roleText: a role with method, steps, deliverables and exit criteria; delegation on request; a skill with its guide', () => {
  const text = roleText(PY);
  assert.match(text, /^\[luna\] For this request, work as the Python 工程師 \(`python_engineer`\)\.\nMethod: 型別提示\.\nSteps:\n- s1\n- s2\nDeliver: diff\.\nDone only when:\n- tests pass\n/);
  assert.ok(!text.includes('subagent'));
  assert.match(roleText(PY, { delegate: true }), /If a `team_python_engineer` subagent is available, you may delegate/);
  assert.match(text, /Follow the project's own instructions first/);
  assert.match(roleText(SK), /^\[luna\] For this request, follow the `game-level-design` skill \(關卡設計\)\.\nSkill guide:\n# Level design\n/);
});

// ---- Luna asks the specialist question on a new turn ----

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const LADDER = ['low', 'medium', 'high'];
const OPTS = { url: 'https://luna.test/v1/decisions', apiKey: 'sk-test', model: 'gpt-6-luna', timeoutMs: 2000, ladder: LADDER, minConfidence: 0.4, roles: [PY, SK] };
const effortAnswer = { type: 'score', name: 'effort', score: 0.5, probabilities: [0.1, 0.8, 0.1], confidence: 0.8 };
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return handler(calls.length);
  };
  return calls;
}
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('lunaDecide asks for the specialist only on a new turn and returns it with the effort', async () => {
  const calls = stubFetch(() => json(200, { answers: [effortAnswer, { type: 'choice', name: 'role', choice: 'game-level-design', confidence: 0.9 }] }));
  const d = await lunaDecide({ userText: 'redesign level 2', steps: [] }, OPTS);
  assert.equal(d.role, 'game-level-design');
  assert.equal(d.target, 1);
  assert.deepEqual(calls[0].questions.map((q) => q.name), ['effort', 'role']);
  // The specialist question comes after the effort, so the cached rubric prefix is unchanged.
  assert.deepEqual(calls[0].input, effortCallInput('redesign level 2'));

  stubFetch(() => json(200, { answers: [effortAnswer, { type: 'score', name: 'stuck' }] }));
  const mid = await lunaDecide({ userText: 'x', steps: [{ kind: 'read', command: 'ls', failed: false }] }, { ...OPTS, minConfidence: 0 }).catch((e) => e);
  assert.equal(mid.role, undefined);
});

const effortCallInput = (userText) => requestBody('gpt-6-luna', effortCall({ userText, steps: [] }, LADDER).state, []).input;

test('lunaDecide: "none" is null; an abstained effort still carries the pick; a 400 drops the question for a while', async () => {
  stubFetch(() => json(200, { answers: [effortAnswer, { type: 'choice', name: 'role', choice: NO_ROLE, confidence: 0.9 }] }));
  assert.equal((await lunaDecide({ userText: 'what is a monad?', steps: [] }, OPTS)).role, null);

  stubFetch(() => json(200, { answers: [{ ...effortAnswer, confidence: 0.1 }, { type: 'choice', name: 'role', choice: 'python_engineer', confidence: 0.9 }] }));
  const abstained = await lunaDecide({ userText: 'port to python', steps: [] }, OPTS).catch((e) => e);
  assert.match(abstained.message, /abstained/);
  assert.equal(abstained.role, 'python_engineer');

  const calls = stubFetch((n) => (n === 1 ? json(400, { error: { message: 'too many choices' } }) : json(200, { answers: [effortAnswer] })));
  const retried = await lunaDecide({ userText: 'port to python', steps: [] }, OPTS);
  assert.deepEqual(calls.map((c) => c.questions.map((q) => q.name)), [['effort', 'role'], ['effort']]);
  assert.equal(retried.role, undefined, 'not asked, so the rules may pick');
  await lunaDecide({ userText: 'again', steps: [] }, OPTS);
  assert.deepEqual(calls[2].questions.map((q) => q.name), ['effort']);
});

test('lunaDecide: a 400 that the call without the question also gets leaves the question on', async () => {
  const calls = stubFetch((n) => (n <= 2 ? json(400, { error: { message: 'bad request' } }) : json(200, { answers: [effortAnswer] })));
  await assert.rejects(lunaDecide({ userText: 'port to python', steps: [] }, OPTS), /Luna HTTP 400/);
  await lunaDecide({ userText: 'port to python', steps: [] }, OPTS);
  assert.deepEqual(calls.map((c) => c.questions.map((q) => q.name)), [['effort', 'role'], ['effort'], ['effort', 'role']]);
});

test('lunaDecide: no question without request text; an unanswered question leaves the pick to the rules', async () => {
  const calls = stubFetch(() => json(200, { answers: [effortAnswer] }));
  assert.equal((await lunaDecide({ userText: '', steps: [] }, OPTS)).role, undefined);
  assert.deepEqual(calls[0].questions.map((q) => q.name), ['effort']);
  const d = await lunaDecide({ userText: 'port to python', steps: [] }, OPTS);
  assert.deepEqual(calls[1].questions.map((q) => q.name), ['effort', 'role']);
  assert.equal(d.role, undefined);
});

// ---- the router keeps the turn's specialist; the proxy hands it to the agent ----

const user = (text) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const shell = (id) => [
  { type: 'function_call', name: 'shell', call_id: id, arguments: JSON.stringify({ command: ['ls'] }) },
  { type: 'function_call_output', call_id: id, output: 'Exit code: 0' },
];

test('router: Luna picks the specialist on a new turn, it lasts for the turn, a new turn picks again', async () => {
  const picks = ['python_engineer', null];
  const decideFn = async (turn, opts) => {
    assert.deepEqual(ids(opts.roles), ['python_engineer', 'game-level-design']);
    return { target: 1, hold: 0, release: false, stuck: null, reasons: ['luna'], cost: null, ...(turn.steps.length === 0 ? { role: picks.shift() } : {}) };
  };
  const router = createRouter(loadConfig({ LUNA_MODE: 'luna', OPENAI_API_KEY: 'sk-x' }), { decideFn, roles: [PY, SK] });
  const first = [user('port the CLI to python')];
  const d1 = await router.route({ input: first }, 's', null, parseTurn(first));
  assert.deepEqual([d1.role, d1.roleSource], ['python_engineer', 'luna']);
  const d2 = await router.route({ input: [...first, ...shell('a')] }, 's', null, parseTurn([...first, ...shell('a')]));
  assert.equal(d2.role, 'python_engineer');
  // Luna's "none" stands even when the words would match a rule.
  const next = [...first, ...shell('a'), user('improve the level design')];
  const d3 = await router.route({ input: next }, 's', null, parseTurn(next));
  assert.equal(d3.role, undefined);
});

test('router: without Luna the rules pick the specialist; without packs there is none', async () => {
  const input = [user('improve the level design of stage 2')];
  const rules = createRouter(loadConfig({ LUNA_MODE: 'heuristic' }), { roles: [PY, SK] });
  const d = await rules.route({ input }, 's', null, parseTurn(input));
  assert.deepEqual([d.role, d.roleSource], ['game-level-design', 'rules']);
  const failing = createRouter(loadConfig({ LUNA_MODE: 'luna', OPENAI_API_KEY: 'sk-x' }), { roles: [PY, SK], decideFn: async () => { throw new Error('down'); } });
  assert.equal((await failing.route({ input }, 's', null, parseTurn(input))).roleSource, 'rules');
  const none = createRouter(loadConfig({ LUNA_MODE: 'heuristic' }));
  assert.equal((await none.route({ input }, 's', null, parseTurn(input))).role, undefined);
});

function listen(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
}

async function proxyWith(roles, env = {}) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push(JSON.parse(raw));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"id":"r","output":[]}');
    });
  });
  const upPort = await listen(upstream);
  const config = loadConfig({ LUNA_UPSTREAM: `http://127.0.0.1:${upPort}`, LUNA_HOME: '.luna-test', LUNA_MODE: 'heuristic', ...env });
  const logged = [];
  const { server, stats } = createProxy(config, { roles, log: { write: (r) => logged.push(r) }, print: () => {} });
  const port = await listen(server);
  const post = async (p, body) => (await fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', body: JSON.stringify(body) })).text();
  return { seen, logged, stats, post, close: () => { server.close(); upstream.close(); } };
}

test('proxy: the turn\'s specialist goes to the agent as the last developer message on every generation', async () => {
  const h = await proxyWith([PY, SK]);
  try {
    const first = [user('improve the level design of stage 2')];
    const req = (input) => ({ model: 'gpt-x', input, reasoning: { effort: 'low' }, prompt_cache_key: 'k' });
    await h.post('/v1/responses', req(first));
    await h.post('/v1/responses', req([...first, ...shell('a')]));
    for (const body of h.seen) {
      const last = body.input.at(-1);
      assert.equal(last.role, 'developer');
      assert.match(last.content[0].text, /^\[luna\] For this request, follow the `game-level-design` skill/);
    }
    // A request with no matching words starts a turn without a specialist.
    await h.post('/v1/responses', req([...first, ...shell('a'), user('hello')]));
    assert.equal(h.seen[2].input.at(-1).role, 'user');
    assert.deepEqual(h.stats.byRole, { 'game-level-design': 1 });
    assert.equal(h.logged[0].role, 'game-level-design');
  } finally {
    h.close();
  }
});

test('proxy: Chat gets the specialist as a system message; LUNA_MODE=off and no packs get nothing', async () => {
  const h = await proxyWith([PY]);
  try {
    await h.post('/v1/chat/completions', { model: 'gpt-x', messages: [{ role: 'user', content: 'port this to python' }], reasoning_effort: 'low' });
    assert.equal(h.seen[0].messages.at(-1).role, 'system');
    assert.match(h.seen[0].messages.at(-1).content, /work as the Python 工程師/);
  } finally {
    h.close();
  }
  for (const [roles, env] of [[[PY], { LUNA_MODE: 'off' }], [[], {}]]) {
    const off = await proxyWith(roles, env);
    try {
      await off.post('/v1/responses', { model: 'luna-auto', input: [user('port this to python')], reasoning: { effort: 'low' } });
      assert.equal(off.seen[0].input.at(-1).role, 'user');
    } finally {
      off.close();
    }
  }
});

test('createProxy loads LUNA_ROLE_PACK and reports the count on /luna/health', async () => {
  const dir = tempDir();
  writeZip(path.join(dir, 'team.zip'), teamFiles());
  writeZip(path.join(dir, 'game.zip'), skillFiles);
  const config = loadConfig({ LUNA_HOME: '.luna-test', LUNA_ROLE_PACK: `${path.join(dir, 'team.zip')};${path.join(dir, 'game.zip')}` });
  const { server, roles } = createProxy(config, { log: { write() {} }, print: () => {} });
  try {
    assert.deepEqual(ids(roles), ['python_engineer', 'test_engineer', 'technical_writer', 'game-level-design', 'game-audio-mixing']);
    const port = await listen(server);
    const health = await (await fetch(`http://127.0.0.1:${port}/luna/health`)).json();
    assert.equal(health.roles, 5);
  } finally {
    server.close();
  }
  // A pack that cannot be read costs the specialists, not the proxy.
  const printed = [];
  const broken = createProxy(loadConfig({ LUNA_HOME: '.luna-test', LUNA_ROLE_PACK: path.join(dir, 'nope.zip') }), { log: { write() {} }, print: (s) => printed.push(s) });
  assert.deepEqual(broken.roles, []);
  assert.match(printed[0], /^\[luna\] warning: no specialists: LUNA_ROLE_PACK .*nope\.zip/);
});

test('LUNA_ROLES=off starts with the specialists off; POST /luna/roles switches them while running', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push(JSON.parse(raw));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"id":"r","output":[]}');
    });
  });
  const upPort = await listen(upstream);
  const config = loadConfig({ LUNA_UPSTREAM: `http://127.0.0.1:${upPort}`, LUNA_HOME: '.luna-test', LUNA_MODE: 'heuristic', LUNA_ROLES: 'off' });
  const printed = [];
  const { server, stats } = createProxy(config, { roles: [PY], log: { write() {} }, print: (s) => printed.push(s) });
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  const ask = (text) => fetch(`${base}/v1/responses`, { method: 'POST', body: JSON.stringify({ model: 'gpt-x', input: [user(text)], reasoning: { effort: 'low' } }) });
  const switchTo = async (body) => fetch(`${base}/luna/roles`, { method: 'POST', body });
  try {
    await ask('port this to python');
    assert.equal(seen[0].input.at(-1).role, 'user', 'off: nothing added');
    assert.deepEqual(await (await fetch(`${base}/luna/roles`)).json(), { enabled: false, roles: 1 });

    assert.deepEqual(await (await switchTo('{"enabled":true}')).json(), { enabled: true, roles: 1 });
    assert.match(printed.at(-1), /specialists on/);
    await ask('port that one to python too');
    assert.equal(seen[1].input.at(-1).role, 'developer');
    assert.equal((await (await fetch(`${base}/luna/health`)).json()).rolesEnabled, true);

    // Off mid-turn: the turn's specialist is no longer handed over.
    await switchTo('{"enabled":false}');
    await fetch(`${base}/v1/responses`, { method: 'POST', body: JSON.stringify({ model: 'gpt-x', input: [user('port that one to python too'), ...shell('a')], reasoning: { effort: 'low' } }) });
    assert.equal(seen[2].input.at(-1).type, 'function_call_output');
    assert.deepEqual(stats.byRole, { python_engineer: 1 });

    assert.equal((await switchTo('{"enabled":"yes"}')).status, 400);
    assert.equal((await switchTo('not json')).status, 400);
  } finally {
    server.close();
    upstream.close();
  }
});

test('router: switched off, neither Luna nor the rules are asked for a specialist', async () => {
  let on = false;
  const asked = [];
  const decideFn = async (turn, opts) => {
    asked.push(opts.roles.length);
    return { target: 1, hold: 0, release: false, stuck: null, reasons: ['luna'], cost: null };
  };
  const router = createRouter(loadConfig({ LUNA_MODE: 'luna', OPENAI_API_KEY: 'sk-x' }), { decideFn, roles: [PY], rolesOn: () => on });
  const input = [user('port the CLI to python')];
  assert.equal((await router.route({ input }, 's', null, parseTurn(input))).role, undefined);
  on = true;
  const next = [...input, ...shell('a'), user('now port the tests to python')];
  assert.equal((await router.route({ input: next }, 's', null, parseTurn(next))).role, 'python_engineer');
  assert.deepEqual(asked, [0, 1]);
});

test('proxy: a bare string input keeps the request when the specialist is added', async () => {
  const h = await proxyWith([PY]);
  try {
    await h.post('/v1/responses', { model: 'gpt-x', input: 'port this script to python', reasoning: { effort: 'low' } });
    const input = h.seen[0].input;
    assert.deepEqual(input[0], { type: 'message', role: 'user', content: 'port this script to python' });
    assert.equal(input[1].role, 'developer');
    assert.match(input[1].content[0].text, /work as the Python 工程師/);
    // The specialist alone is not a nudge.
    assert.equal(h.stats.nudged, 0);
    assert.equal(h.logged[0].nudged, undefined);
  } finally {
    h.close();
  }
});

test('loadRoles: | names a set, # is part of a path, a shared id list keeps those ids, duplicates and "none" are dropped', () => {
  const dir = path.join(tempDir(), 'C#packs');
  fs.mkdirSync(dir);
  writeZip(path.join(dir, 'team.zip'), teamFiles());
  writeZip(path.join(dir, 'game.zip'), {
    ...skillFiles,
    'game-pack/again/SKILL.md': SKILL('game-level-design', 'a second copy', ''),
    'game-pack/none/SKILL.md': SKILL('none', 'clashes with the no-specialist answer', ''),
  });
  const spec = `${path.join(dir, 'team.zip')};${path.join(dir, 'game.zip')}`;
  assert.deepEqual(ids(loadRoles(spec).roles), ['python_engineer', 'test_engineer', 'technical_writer', 'game-level-design', 'game-audio-mixing']);
  assert.equal(loadRoles(spec).roles[3].methods, '關卡設計、節奏與難度曲線');
  assert.deepEqual(ids(loadRoles(spec, 'debugging_engineer, game-audio-mixing').roles), ['debugging_engineer', 'game-audio-mixing']);
  assert.throws(() => loadRoles(spec, 'debugging_engineer, ghost'), /LUNA_ROLE_SET: no pack has ghost/);
  // A profile name applies where a pack has it; elsewhere that pack's default.
  assert.deepEqual(loadRoles(spec, 'lean').packs.map((p) => [p.set, p.count]), [['lean', 1], ['(default)', 2]]);
});

test('loadRolePack: front matter with a BOM, CRLF, block scalars, folded lines and quotes', () => {
  const dir = tempDir();
  writeFiles(dir, {
    'a/SKILL.md': '﻿---\r\nname: bom-skill\r\ndescription: with a BOM\r\n---\r\nbody',
    'b/SKILL.md': '---\nname: block-skill\ndescription: >-\n  folded over\n  two lines\nlicense: MIT\n---\n',
    'c/SKILL.md': '---\nname: plain-skill\ndescription: starts here\n  and goes on\n---\n',
    'd/SKILL.md': "---\nname: quoted-skill\ndescription: 'it''s quoted'\n---\n",
  });
  const byId = Object.fromEntries(loadRolePack(dir).roles.map((r) => [r.id, r]));
  assert.equal(byId['bom-skill'].methods, 'with a BOM');
  assert.equal(byId['bom-skill'].body, 'body');
  assert.equal(byId['block-skill'].methods, 'folded over two lines');
  assert.equal(byId['plain-skill'].methods, 'starts here and goes on');
  assert.equal(byId['quoted-skill'].methods, "it's quoted");
});

test('zip reader: a comment holding the end signature, an oversized entry, a truncated file', () => {
  const dir = tempDir();
  const file = path.join(dir, 'comment.zip');
  writeZip(file, skillFiles);
  const zip = fs.readFileSync(file);
  const comment = Buffer.concat([Buffer.from('PK\x05\x06'), Buffer.alloc(30)]);
  zip.writeUInt16LE(comment.length, zip.length - 2);
  fs.writeFileSync(file, Buffer.concat([zip, comment]));
  assert.equal(loadRolePack(file).roles.length, 2);

  writeZip(path.join(dir, 'bomb.zip'), { 'x/SKILL.md': SKILL('big', 'big', 'x'.repeat(9 << 20)) });
  assert.throws(() => loadRolePack(path.join(dir, 'bomb.zip')), /Cannot create a Buffer larger|maxOutputLength|buffer/i);

  fs.writeFileSync(path.join(dir, 'cut.zip'), zip.subarray(0, 40));
  assert.throws(() => loadRolePack(path.join(dir, 'cut.zip')), /not a zip file/);
});
