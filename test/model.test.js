import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wantsModelRouting, modelId, clampEffort } from '../src/model.js';
import { createRouter } from '../src/router.js';
import { loadConfig } from '../src/config.js';
import { parseTurn } from '../src/trajectory.js';

const config = loadConfig({ LUNA_MODE: 'heuristic' });
const userMsg = (text) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const ok = (i) => [
  { type: 'function_call', name: 'shell', call_id: `k${i}`, arguments: JSON.stringify({ command: ['bash', '-lc', 'ls'] }) },
  { type: 'function_call_output', call_id: `k${i}`, output: 'Exit code: 0\nOutput:\nsrc' },
];
const route = (router, input) => router.route({ input }, 's1', null, parseTurn(input));

test('config: one model, default effort medium, long-task help on', () => {
  assert.equal(config.model, 'gpt-6.1-terra');
  assert.deepEqual(config.ladder, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(config.defaultEffort, 'medium');
  assert.equal(config.port, 8791);
  assert.deepEqual([config.continueTurns, config.maxContinues, config.continueThreshold, config.nudge], [true, 20, 0.6, true]);
  assert.deepEqual([config.maxStalls, config.verify, config.reviewRounds], [2, true, 1]);
  const custom = loadConfig({ LUNA_MODEL: 'gpt-x', LUNA_DEFAULT_EFFORT: 'HIGH', LUNA_CONTINUE: 'off', LUNA_MAX_CONTINUES: '1', LUNA_NUDGE: 'off' });
  assert.deepEqual([custom.model, custom.defaultEffort, custom.continueTurns, custom.maxContinues, custom.nudge], ['gpt-x', 'high', false, 1, false]);
  const loop = loadConfig({ LUNA_MAX_STALLS: '5', LUNA_VERIFY: 'off', LUNA_REVIEW_ROUNDS: '0' });
  assert.deepEqual([loop.maxStalls, loop.verify, loop.reviewRounds], [5, false, 0]);
  assert.throws(() => loadConfig({ LUNA_MAX_STALLS: '-1' }), /LUNA_MAX_STALLS must be a non-negative integer/);
  assert.throws(() => loadConfig({ LUNA_VERIFY: 'yes' }), /LUNA_VERIFY must be on\|off/);
  assert.throws(() => loadConfig({ LUNA_DEFAULT_EFFORT: 'minimal' }), /LUNA_DEFAULT_EFFORT must be one of LUNA_LEVELS/);
  assert.throws(() => loadConfig({ LUNA_CONTINUE: 'maybe' }), /LUNA_CONTINUE must be on\|off/);
  assert.throws(() => loadConfig({ LUNA_CONTINUE_THRESHOLD: '2' }), /LUNA_CONTINUE_THRESHOLD must be 0\.\.1/);
});

test('wantsModelRouting: aliases, the model id and its openai/ form', () => {
  for (const model of ['luna-auto', 'AUTO', 'gpt-6.1-terra', 'openai/gpt-6.1-terra']) {
    assert.equal(wantsModelRouting({ model }, config), true, model);
  }
  for (const model of ['gpt-6.1-sol', 'gpt-4o', '', undefined]) assert.equal(wantsModelRouting({ model }, config), false, String(model));
});

test('modelId adds the openai/ prefix only on OpenRouter; clampEffort maps minimal to low', () => {
  assert.equal(modelId(config, false), 'gpt-6.1-terra');
  assert.equal(modelId(config, true), 'openai/gpt-6.1-terra');
  assert.equal(modelId(loadConfig({ LUNA_MODEL: 'vendor/x' }), true), 'vendor/x');
  assert.equal(clampEffort('minimal'), 'low');
  assert.equal(clampEffort('xhigh'), 'xhigh');
});

test('router: a resumed turn never drops below the default effort, and a new turn resets it', async () => {
  const router = createRouter(config);
  const first = [userMsg('list the files'), ...ok(1)];
  assert.equal((await route(router, first)).effort, 'low');
  assert.equal(router.continuesOf('s1'), 0);

  // The proxy resumed this turn: one rung up, at least the default.
  assert.deepEqual(router.noteContinue('s1'), { continues: 1, effort: 'medium', stalls: 0, reviews: 0 });
  assert.equal(router.continuesOf('s1'), 1);

  const later = [...first, ...ok(2), ...ok(3)];
  const d = await route(router, later);
  assert.equal(d.effort, 'medium');
  assert.match(d.reasons.join(';'), /resumed turn keeps default effort/);
  assert.equal(router.continuesOf('s1'), 1);

  // A new user turn starts over.
  await route(router, [...later, userMsg('now the tests')]);
  assert.equal(router.continuesOf('s1'), 0);
});

test('router: noteContinue climbs one rung per resume and stops at the top', () => {
  const router = createRouter(config);
  // An unseen session counts as sitting at the default.
  assert.deepEqual(router.noteContinue('x'), { continues: 1, effort: 'high', stalls: 0, reviews: 0 });
  assert.deepEqual(router.noteContinue('x'), { continues: 2, effort: 'xhigh', stalls: 0, reviews: 0 });
  assert.deepEqual(router.noteContinue('x'), { continues: 3, effort: 'max', stalls: 0, reviews: 0 });
  // The top of the ladder holds; the count keeps rising.
  assert.deepEqual(router.noteContinue('x'), { continues: 4, effort: 'max', stalls: 0, reviews: 0 });
});

test('router: canResume allows LUNA_MAX_STALLS resumes without progress after the last one that had some', () => {
  const router = createRouter(loadConfig({ LUNA_MODE: 'heuristic', LUNA_MAX_STALLS: '2' }));
  assert.equal(router.canResume('s', 'm1'), true);
  assert.equal(router.noteContinue('s', { mark: 'm1' }).stalls, 0);
  assert.equal(router.noteContinue('s', { mark: 'm1' }).stalls, 1);
  assert.equal(router.canResume('s', 'm1'), true);
  assert.equal(router.noteContinue('s', { mark: 'm1' }).stalls, 2);
  assert.equal(router.canResume('s', 'm1'), false);
  // Progress (a new mark) starts a new streak.
  assert.equal(router.canResume('s', 'm2'), true);
  assert.equal(router.noteContinue('s', { mark: 'm2' }).stalls, 0);
  // 0: only after progress.
  const strict = createRouter(loadConfig({ LUNA_MODE: 'heuristic', LUNA_MAX_STALLS: '0' }));
  strict.noteContinue('s', { mark: 'm1' });
  assert.deepEqual([strict.canResume('s', 'm1'), strict.canResume('s', 'm2')], [false, true]);
});

test('router: observe resets the resume bookkeeping when a model-only session starts a new turn', () => {
  const router = createRouter(config);
  router.observe('s', 1);
  router.noteContinue('s', { mark: 'm', review: true, edits: 2, focus: 'f' });
  router.observe('s', 3);
  assert.deepEqual([router.continuesOf('s'), router.focusOf('s')], [1, 'f']);
  router.observe('s', 1);
  assert.deepEqual([router.continuesOf('s'), router.focusOf('s'), router.canReview('s', 1)], [0, null, true]);
});

test('router: the focus of a resume lasts until cleared or a new turn', async () => {
  const router = createRouter(config);
  const first = [userMsg('fix it'), ...ok(1)];
  await route(router, first);
  assert.equal(router.focusOf('s1'), null);
  router.noteContinue('s1', { mark: 'm', focus: 'keep going' });
  await route(router, [...first, ...ok(2)]);
  assert.equal(router.focusOf('s1'), 'keep going');
  router.clearFocus('s1');
  assert.equal(router.focusOf('s1'), null);
  router.noteContinue('s1', { mark: 'n', focus: 'again' });
  await route(router, [...first, ...ok(2), userMsg('next')]);
  assert.equal(router.focusOf('s1'), null);
});

test('router: canResume stops at LUNA_MAX_CONTINUES even while the turn keeps moving', () => {
  const router = createRouter(loadConfig({ LUNA_MODE: 'heuristic', LUNA_MAX_CONTINUES: '2' }));
  router.noteContinue('s', { mark: 'a' });
  router.noteContinue('s', { mark: 'b' });
  assert.equal(router.canResume('s', 'c'), false);
  assert.equal(router.canReview('s', 5), false);
});

test('router: canReview needs rounds left and edits since the last review', () => {
  const router = createRouter(loadConfig({ LUNA_MODE: 'heuristic', LUNA_REVIEW_ROUNDS: '2' }));
  assert.equal(router.canReview('s', 0), false);
  assert.equal(router.canReview('s', 1), true);
  assert.deepEqual(router.noteContinue('s', { mark: '1/0/1', review: true, edits: 1 }), { continues: 1, effort: 'high', stalls: 0, reviews: 1 });
  assert.equal(router.canReview('s', 1), false, 'no new edit since the review');
  assert.equal(router.canReview('s', 2), true);
  router.noteContinue('s', { mark: '2/0/2', review: true, edits: 2 });
  assert.equal(router.canReview('s', 9), false, 'rounds spent');
  assert.equal(createRouter(loadConfig({ LUNA_MODE: 'heuristic', LUNA_REVIEW_ROUNDS: '0' })).canReview('s', 3), false);
});

test('router: resume bookkeeping survives the generations of a turn and resets on a new turn', async () => {
  const router = createRouter(config);
  const first = [userMsg('list the files'), ...ok(1)];
  await route(router, first);
  router.noteContinue('s1', { mark: 'm', review: true, edits: 1 });
  await route(router, [...first, ...ok(2)]);
  const kept = router.sessions.get('s1');
  assert.deepEqual([kept.continues, kept.reviews, kept.reviewedEdits, kept.mark, kept.stalls], [1, 1, 1, 'm', 0]);
  await route(router, [...first, ...ok(2), userMsg('next task')]);
  const fresh = router.sessions.get('s1');
  assert.deepEqual([fresh.continues, fresh.reviews, fresh.mark], [0, undefined, undefined]);
});

const fail = (i) => [
  { type: 'function_call', name: 'shell', call_id: `f${i}`, arguments: JSON.stringify({ command: ['bash', '-lc', `make t${i}`] }) },
  { type: 'function_call_output', call_id: `f${i}`, output: 'Exit code: 2\nOutput:\nboom' },
];

test('router: luna leads a new turn but inside a turn it may only raise the effort', async () => {
  const seen = [];
  const decideFn = async (turn, opts) => {
    seen.push([turn.steps.length, opts.url, opts.model, opts.minConfidence]);
    return { target: 1, hold: 0, release: false, stuck: null, reasons: ['luna medium 0.80'], cost: null };
  };
  const router = createRouter(loadConfig({}), { decideFn });
  // The rules would start this hard request at high; luna reads it and picks medium.
  const d = await route(router, [userMsg('refactor the auth module')]);
  assert.deepEqual([d.effort, d.source], ['medium', 'luna']);
  // Three failures in a row: the rules escalate to the top rung (max) and luna's medium cannot lower it.
  const stuck = await router.route({}, 's2', null, parseTurn([userMsg('fix it'), ...fail(1), ...fail(2), ...fail(3)]));
  assert.equal(stuck.effort, 'max');
  assert.match(stuck.reasons.join(';'), /3 failures in a row;luna medium 0.80/);
  assert.deepEqual(seen[0], [0, 'https://api.openai.com/v1/decisions', 'gpt-6-luna', 0.4]);
});
