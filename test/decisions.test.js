import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  RUBRIC, CACHE_KEY, situation, effortCall, requestBody, answersByName, scoreLevel, toAssessment,
  combineEffort, callCost, resetLunaPause, postDecision, lunaDecide, closingOf, lunaStopCheck,
} from '../src/decisions.js';
import { decisionKeyFor, decisionOptions } from '../src/router.js';
import { loadConfig } from '../src/config.js';

const LADDER = ['low', 'medium', 'high', 'xhigh'];
const DECISIONS_URL = 'https://luna.test/v1/decisions';
const realFetch = globalThis.fetch;

const step = (kind, command, failed) => ({ kind, command, failed });
const turn = {
  userText: 'find bugs',
  steps: [step('read', 'rg foo', false), step('verify', 'pytest', true), step('verify', 'pytest', true)],
};
const okTurn = { userText: 'fix the parser', steps: [step('read', 'cat a', false), step('verify', 'pytest', false)] };

// Stubs globalThis.fetch: every request is recorded (parsed body included); `handler(n, init)`
// answers the n-th request with a Response, or throws / rejects.
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body), signal: init.signal });
    return handler(calls.length, init);
  };
  return calls;
}
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', ...headers },
});
const USAGE = { input_tokens: 1300, input_tokens_details: { cached_tokens: 1200 } };
const ok = (answers, usage = { input_tokens: 10 }) => json(200, { answers, usage });
// Never answers: resolves only by aborting on the request's timeout signal.
const hang = (signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));

const OPTS = { url: DECISIONS_URL, apiKey: 'sk-test', model: 'gpt-6-luna', timeoutMs: 2000 };
const DECIDE_OPTS = { ...OPTS, ladder: LADDER, minConfidence: 0.5 };
const NEW = effortCall({ userText: 'hi there', steps: [] }, LADDER);

const effort = (score, probabilities, confidence) => ({ type: 'score', name: 'effort', score, probabilities, confidence });
const stuck = (probability) => ({ type: 'predicate', name: 'stuck', probability });
const stopReply = (picked, probabilities, inProgress, usage) => ok([
  { type: 'choice', name: 'end', choice: picked, probabilities },
  { type: 'predicate', name: 'in_progress', probability: inProgress },
], usage);

afterEach(() => {
  globalThis.fetch = realFetch;
  resetLunaPause();
});

test('situation turns the last step into one coarse phrase', () => {
  assert.equal(situation([step('read', 'cat a', false)]), 'read a file, it worked');
  assert.equal(situation([step('edit', 'apply_patch', false)]), 'edited code, it worked');
  assert.equal(situation([step('exec', 'npm i', null)]), 'ran a command, still running');
  const reads = ['a', 'b', 'c', 'd', 'e'].map((f) => step('read', `cat ${f}`, false));
  assert.equal(situation([step('edit', 'apply_patch', false), ...reads]), 'read 5 files since the last edit');
  assert.equal(situation([step('verify', 'pytest', true)]), 'ran the tests or build, it failed; first failure');
  assert.equal(situation(turn.steps), 'ran the tests or build, it failed; 2 failures in a row; the same failing command was repeated');
  const four = ['a', 'b', 'c', 'd'].map((c) => step('exec', `make ${c}`, true));
  assert.equal(situation(four), 'ran a command, it failed; 4 or more failures in a row');
});

test('effortCall: a new turn asks one effort score over the ladder, about the request only', () => {
  const { state, questions } = effortCall({ userText: 'x'.repeat(2500), steps: [] }, LADDER);
  assert.deepEqual(state, { request: 'x'.repeat(2000) });
  assert.deepEqual(questions.map((q) => q.name), ['effort']);
  assert.equal(questions[0].type, 'score');
  assert.deepEqual(questions[0].levels.map((l) => l.label), LADDER);
  assert.ok(questions[0].levels.every((l) => typeof l.description === 'string' && l.description.length > 0));
  // The levels follow the configured ladder, not a fixed list.
  assert.deepEqual(effortCall({ userText: 'x', steps: [] }, ['medium', 'max']).questions[0].levels.map((l) => l.label), ['medium', 'max']);
});

test('effortCall: inside a turn, the effort score and the stuck predicate read the trajectory', () => {
  const steps = [
    step('read', 'cat  a.js', false),
    step('edit', 'apply_patch', false),
    step('verify', 'npm   test\n-- x', true),
    step('exec', 'make', null),
  ];
  const { state, questions } = effortCall({ userText: 'fix it', steps }, LADDER);
  assert.deepEqual(Object.keys(state), ['request', 'last_step', 'recent_steps', 'steps_so_far']);
  assert.equal(state.request, 'fix it');
  assert.equal(state.steps_so_far, 4);
  assert.equal(state.last_step, 'ran a command, still running');
  assert.deepEqual(state.recent_steps, [
    { kind: 'read', command: 'cat a.js', status: 'ok' },
    { kind: 'edit', command: 'apply_patch', status: 'ok' },
    { kind: 'verify', command: 'npm test -- x', status: 'failed' },
    { kind: 'exec', command: 'make', status: 'pending' },
  ]);
  assert.deepEqual(questions.map((q) => [q.name, q.type]), [['effort', 'score'], ['stuck', 'predicate']]);
  assert.deepEqual(questions[0].levels.map((l) => l.label), LADDER);
  assert.equal(typeof questions[1].instructions, 'string');
});

test('effortCall keeps the last 8 steps and cuts long commands to 160 characters', () => {
  const many = Array.from({ length: 10 }, (_, i) => step('read', `cat f${i}`, false));
  const { state } = effortCall({ userText: 'x', steps: many }, LADDER);
  assert.equal(state.steps_so_far, 10);
  assert.equal(state.recent_steps.length, 8);
  assert.equal(state.recent_steps[0].command, 'cat f2');
  const long = effortCall({ userText: 'x', steps: [step('exec', 'y'.repeat(300), false)] }, LADDER);
  assert.equal(long.state.recent_steps[0].command.length, 160);
});

test('the rubric is the cached prefix: long, first, and identical across calls', () => {
  const words = RUBRIC.split(/\s+/).filter(Boolean).length;
  assert.ok(words > 900, `rubric has ${words} words`);
  const a = requestBody('gpt-6-luna', { request: 'one' }, NEW.questions, 'explicit');
  const b = requestBody('gpt-6-luna', { request: 'two', last_step: 'x' }, effortCall(turn, LADDER).questions, 'explicit');
  assert.equal(a.input[0].role, 'developer');
  assert.equal(a.input[0].content[0].text, RUBRIC);
  assert.equal(JSON.stringify(a.input[0]), JSON.stringify(b.input[0]));
  assert.deepEqual(a.input[1], { role: 'user', content: [{ type: 'input_json', data: { request: 'one' } }] });
});

test('requestBody: explicit mode marks the rubric as the one cache breakpoint', () => {
  const body = requestBody('gpt-6-luna', NEW.state, NEW.questions, 'explicit');
  assert.deepEqual(body.input[0].content[0].prompt_cache_breakpoint, { mode: 'explicit' });
  assert.equal(JSON.stringify(body).split('prompt_cache_breakpoint').length - 1, 1);
  assert.equal(body.prompt_cache_key, CACHE_KEY);
  assert.deepEqual(body.prompt_cache_options, { mode: 'explicit' });
  assert.equal(body.model, 'gpt-6-luna');
  assert.deepEqual(body.questions, NEW.questions);
  // Explicit is the default.
  assert.deepEqual(requestBody('gpt-6-luna', NEW.state, NEW.questions), body);
});

test('requestBody: implicit mode sends only the cache key, and off sends no caching fields', () => {
  const implicit = requestBody('gpt-6-luna', NEW.state, NEW.questions, 'implicit');
  assert.equal(implicit.input[0].content[0].prompt_cache_breakpoint, undefined);
  assert.equal(implicit.prompt_cache_options, undefined);
  assert.equal(implicit.prompt_cache_key, CACHE_KEY);

  const off = requestBody('gpt-6-luna', NEW.state, NEW.questions, 'off');
  assert.deepEqual(Object.keys(off), ['model', 'input', 'questions']);
  assert.equal(off.input[0].content[0].prompt_cache_breakpoint, undefined);
});

test('answersByName keys the named answers and skips the rest', () => {
  const body = { answers: [{ type: 'predicate', name: 'a', probability: 0.5 }, null, { type: 'x' }, { type: 'score', name: 'effort' }] };
  assert.deepEqual(Object.keys(answersByName(body)), ['a', 'effort']);
  assert.deepEqual(answersByName({}), {});
  assert.deepEqual(answersByName(null), {});
});

test('scoreLevel takes the median of the level distribution, and a higher quantile leans up', () => {
  const probs = [0.1, 0.3, 0.4, 0.2];
  const median = scoreLevel(effort(2, probs), LADDER);
  assert.equal(median.level, 2);
  assert.ok(Math.abs(median.probs.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.equal(scoreLevel(effort(2, probs), LADDER, 0.9).level, 3);
  assert.equal(scoreLevel(effort(2, probs), LADDER, 0.8).level, 2);
  assert.equal(scoreLevel(effort(2, probs), LADDER, 0.25).level, 1);
  assert.equal(scoreLevel(effort(2, probs), LADDER, 0.05).level, 0);
});

test('scoreLevel reads probabilities given as an array, an object by label, or an object by index', () => {
  const probs = [0.1, 0.3, 0.4, 0.2];
  assert.equal(scoreLevel(effort(2, probs), LADDER).level, 2);
  const byLabel = { low: 0.1, medium: 0.3, high: 0.4, xhigh: 0.2 };
  assert.equal(scoreLevel(effort(2, byLabel), LADDER).level, 2);
  const byIndex = { 0: 0.1, 1: 0.3, 2: 0.4, 3: 0.2 };
  assert.equal(scoreLevel(effort(2, byIndex), LADDER).level, 2);
  // A label with no probability counts as zero.
  assert.equal(scoreLevel(effort(1.5, { medium: 0.5, high: 0.5 }), LADDER).level, 1);
  // Unnormalized weights are normalized before the quantile is taken.
  assert.equal(scoreLevel(effort(2, [1, 3, 4, 2]), LADDER).level, 2);
});

test('scoreLevel falls back to the rounded score when there is no usable distribution', () => {
  assert.deepEqual(scoreLevel({ type: 'score', score: 1.6 }, LADDER), { level: 2, probs: null });
  assert.equal(scoreLevel({ type: 'score', score: -0.4 }, LADDER).level, 0);
  assert.equal(scoreLevel({ type: 'score', score: 99 }, LADDER).level, 3);
  assert.equal(scoreLevel({ type: 'score', score: 1, probabilities: [0, 0, 0, 0] }, LADDER).level, 1);
  assert.throws(() => scoreLevel({ type: 'score' }, LADDER), /score without a value/);
});

test('toAssessment: the stuck probability sets hold 2, 1 or 0, and release below 0.25', () => {
  const pick = (a) => [a.target, a.hold, a.release, a.stuck];
  const at = (p) => toAssessment({ effort: effort(2, [0.05, 0.15, 0.6, 0.2], 0.8), stuck: stuck(p) }, LADDER, 0.5);
  assert.deepEqual(pick(at(0.9)), [2, 2, false, 0.9]);
  assert.deepEqual(pick(at(0.75)), [2, 2, false, 0.75]);
  assert.deepEqual(pick(at(0.74)), [2, 1, false, 0.74]);
  assert.deepEqual(pick(at(0.5)), [2, 1, false, 0.5]);
  assert.deepEqual(pick(at(0.49)), [2, 0, false, 0.49]);
  assert.deepEqual(pick(at(0.25)), [2, 0, false, 0.25]);
  assert.deepEqual(pick(at(0.24)), [2, 0, true, 0.24]);
  assert.deepEqual(pick(at(0.1)), [2, 0, true, 0.1]);
  // A new turn has no stuck question, so nothing holds or releases.
  assert.deepEqual(pick(toAssessment({ effort: effort(2, [0.05, 0.15, 0.6, 0.2], 0.8) }, LADDER, 0.5)), [2, 0, false, null]);
});

test('toAssessment: the target is the quantile level, and the reasons say what luna answered', () => {
  const a = toAssessment({ effort: effort(2.2, [0.05, 0.15, 0.6, 0.2], 0.8), stuck: stuck(0.9) }, LADDER, 0.5);
  assert.deepEqual(a.reasons, ['luna high (score 2.20, confidence 0.80)', 'stuck 0.90']);
  assert.equal(toAssessment({ effort: effort(2, [0.1, 0.3, 0.4, 0.2], 0.8) }, LADDER, 0.5, 0.9).target, 3);
});

test('toAssessment: luna abstains below the confidence floor, and a confidence of exactly the floor passes', () => {
  assert.throws(
    () => toAssessment({ effort: effort(2, [0.05, 0.15, 0.6, 0.2], 0.4) }, LADDER, 0.5),
    /Luna abstained: high \(score 2\.00, confidence 0\.40 < 0\.5\)/,
  );
  assert.equal(toAssessment({ effort: effort(2, [0.05, 0.15, 0.6, 0.2], 0.5) }, LADDER, 0.5).target, 2);
});

test('toAssessment: without a confidence, the largest probability is the confidence, and a bare score is certain', () => {
  assert.equal(toAssessment({ effort: effort(2, [0.1, 0.2, 0.6, 0.1]) }, LADDER, 0.5).target, 2);
  assert.throws(() => toAssessment({ effort: effort(2, [0.3, 0.3, 0.2, 0.2]) }, LADDER, 0.5), /abstained/);
  assert.equal(toAssessment({ effort: { type: 'score', score: 1 } }, LADDER, 0.5).target, 1);
});

test('toAssessment rejects refusals, wrong answer types and a stuck answer without a probability', () => {
  assert.throws(() => toAssessment({ effort: { type: 'refusal', name: 'effort' } }, LADDER, 0.5), /Luna refused "effort"/);
  assert.throws(() => toAssessment({ effort: { type: 'predicate', name: 'effort', probability: 0.9 } }, LADDER, 0.5), /no score answer for "effort"/);
  assert.throws(() => toAssessment({}, LADDER, 0.5), /no score answer for "effort"/);
  const ok2 = effort(2, [0.05, 0.15, 0.6, 0.2], 0.8);
  assert.throws(() => toAssessment({ effort: ok2, stuck: { type: 'choice', name: 'stuck', choice: 'stuck' } }, LADDER, 0.5), /no predicate answer for "stuck"/);
  assert.throws(() => toAssessment({ effort: ok2, stuck: { type: 'predicate', name: 'stuck' } }, LADDER, 0.5), /no probability for "stuck"/);
  assert.throws(() => toAssessment({ effort: ok2, stuck: { type: 'refusal', name: 'stuck' } }, LADDER, 0.5), /Luna refused "stuck"/);
});

test('combineEffort: luna leads a new turn; inside a turn it may only raise the effort', () => {
  const luna = { target: 1, hold: 0, release: false, reasons: ['luna medium 0.70'] };
  const rules = { target: 2, hold: 2, reasons: ['2 failures in a row'] };
  // New turn: luna's answer stands as it is.
  assert.equal(combineEffort(luna, rules, true), luna);
  // Inside a turn, luna below the rules: the rules' target and hold stand, luna's reasons are added.
  assert.deepEqual(combineEffort(luna, rules, false), { target: 2, hold: 2, reasons: ['2 failures in a row', 'luna medium 0.70'] });
  // A tie keeps the rules' (deterministic) hold.
  const tie = { target: 2, hold: 0, release: false, reasons: ['luna high 0.80'] };
  assert.deepEqual(combineEffort(tie, rules, false), { target: 2, hold: 2, reasons: ['2 failures in a row', 'luna high 0.80'] });
  // Inside a turn, a higher luna target is taken, keeping the larger of the two holds.
  const higher = { ...luna, target: 3 };
  assert.deepEqual(combineEffort(higher, rules, false), { ...higher, hold: 2 });
  const longer = { ...higher, hold: 3 };
  assert.deepEqual(combineEffort(longer, rules, false), longer);
});

test('callCost prices the input tokens at the uncached rate and reports the cache hits', () => {
  const c = callCost(USAGE);
  assert.deepEqual(c.tokens, { input: 1300, cached: 1200 });
  assert.ok(Math.abs(c.cost - 0.00013) < 1e-12);
  assert.deepEqual(callCost({ input_tokens: 50 }).tokens, { input: 50, cached: 0 });
  assert.deepEqual(callCost(undefined), { cost: null, tokens: null });
  assert.deepEqual(callCost({ output_tokens: 9 }), { cost: null, tokens: null });
});

test('postDecision without a key throws before any request', async () => {
  const calls = stubFetch(() => ok([]));
  await assert.rejects(postDecision({ ...OPTS, apiKey: '' }, NEW.state, NEW.questions), /no OpenAI API key/);
  await assert.rejects(postDecision({ ...OPTS, apiKey: undefined }, NEW.state, NEW.questions), /no OpenAI API key/);
  assert.equal(calls.length, 0);
});

test('postDecision sends the bearer key, and the organization and project only when set', async () => {
  const calls = stubFetch(() => ok([]));
  await postDecision({ ...OPTS, organization: 'org-1', project: 'proj-1' }, NEW.state, NEW.questions);
  await postDecision(OPTS, NEW.state, NEW.questions);
  assert.equal(calls[0].url, DECISIONS_URL);
  assert.deepEqual(calls[0].headers, {
    'content-type': 'application/json', authorization: 'Bearer sk-test', 'openai-organization': 'org-1', 'openai-project': 'proj-1',
  });
  assert.deepEqual(calls[1].headers, { 'content-type': 'application/json', authorization: 'Bearer sk-test' });
});

test('postDecision retries once without the explicit breakpoint when the API rejects it, and stays implicit', async () => {
  const calls = stubFetch((n) => (n === 1
    ? json(400, { error: { message: 'prompt_cache_breakpoint is not supported for this model' } })
    : ok([])));
  const body = await postDecision(OPTS, NEW.state, NEW.questions);
  assert.deepEqual(body.answers, []);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].body.input[0].content[0].prompt_cache_breakpoint, { mode: 'explicit' });
  assert.equal(calls[1].body.input[0].content[0].prompt_cache_breakpoint, undefined);
  assert.equal(calls[1].body.prompt_cache_options, undefined);
  assert.equal(calls[1].body.prompt_cache_key, CACHE_KEY);

  // Later calls in the explicit mode go out implicit, without a failing first request.
  await postDecision(OPTS, NEW.state, NEW.questions);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].body.input[0].content[0].prompt_cache_breakpoint, undefined);

  // A reset forgets the rejection, so explicit is tried again.
  resetLunaPause();
  await postDecision(OPTS, NEW.state, NEW.questions);
  assert.deepEqual(calls[3].body.input[0].content[0].prompt_cache_breakpoint, { mode: 'explicit' });
});

test('postDecision retries only an explicit request, and only on a cache message', async () => {
  const calls = stubFetch(() => json(400, { error: { message: 'cache is not allowed here' } }));
  // Implicit has no breakpoint to retry without: the 400 is final.
  await assert.rejects(postDecision({ ...OPTS, cacheMode: 'implicit' }, NEW.state, NEW.questions), /Luna HTTP 400: cache is not allowed here/);
  assert.equal(calls.length, 1);

  // Explicit: one retry in implicit mode; it fails too, so the error is final and there is no third try.
  await assert.rejects(postDecision(OPTS, NEW.state, NEW.questions), /Luna HTTP 400: cache is not allowed here/);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1].body.input[0].content[0].prompt_cache_breakpoint, { mode: 'explicit' });
  assert.equal(calls[2].body.input[0].content[0].prompt_cache_breakpoint, undefined);
});

test('postDecision: a 400 that is not about the cache is not retried and does not pause', async () => {
  const calls = stubFetch((n) => (n === 1 ? json(400, { error: { message: 'unknown model' } }) : ok([])));
  await assert.rejects(postDecision(OPTS, NEW.state, NEW.questions), /Luna HTTP 400: unknown model/);
  assert.equal(calls.length, 1);
  await postDecision(OPTS, NEW.state, NEW.questions);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body.input[0].content[0].prompt_cache_breakpoint, { mode: 'explicit' });
});

test('postDecision: a rejected key pauses Luna for 10 minutes, with no further request', async () => {
  const calls = stubFetch(() => json(401, { error: { message: 'bad key' } }));
  await assert.rejects(postDecision(OPTS, NEW.state, NEW.questions), /Luna HTTP 401: bad key/);
  await assert.rejects(postDecision(OPTS, NEW.state, NEW.questions), /Luna paused for 600 s/);
  assert.equal(calls.length, 1);
});

test('postDecision: a 403 pauses like a 401', async () => {
  const calls = stubFetch(() => json(403, { error: { message: 'forbidden' } }));
  await assert.rejects(postDecision(OPTS, NEW.state, NEW.questions), /Luna HTTP 403/);
  await assert.rejects(postDecision(OPTS, NEW.state, NEW.questions), /Luna paused/);
  assert.equal(calls.length, 1);
});

test('postDecision: a 429 pauses for the retry-after seconds, or 60 s without the header', async () => {
  const calls = stubFetch(() => json(429, { error: { message: 'slow down' } }, { 'retry-after': '7' }));
  await assert.rejects(postDecision(OPTS, NEW.state, NEW.questions), /Luna HTTP 429: slow down/);
  await assert.rejects(postDecision(OPTS, NEW.state, NEW.questions), /Luna paused for 7 s/);
  assert.equal(calls.length, 1);

  resetLunaPause();
  stubFetch(() => json(429, { error: { message: 'slow down' } }));
  await assert.rejects(postDecision(OPTS, NEW.state, NEW.questions), /Luna HTTP 429/);
  await assert.rejects(postDecision(OPTS, NEW.state, NEW.questions), /Luna paused for 60 s/);
});

test('postDecision: a timed-out call pauses Luna for 30 s; resetLunaPause ends the pause', async () => {
  const calls = stubFetch((n, init) => (n === 1 ? hang(init.signal) : ok([])));
  const fast = { ...OPTS, timeoutMs: 20 };
  await assert.rejects(postDecision(fast, NEW.state, NEW.questions), { name: 'TimeoutError' });
  await assert.rejects(postDecision(fast, NEW.state, NEW.questions), /Luna paused for 30 s/);
  assert.equal(calls.length, 1);
  resetLunaPause();
  const body = await postDecision(fast, NEW.state, NEW.questions);
  assert.deepEqual(body.answers, []);
  assert.equal(calls.length, 2);
});

test('postDecision: a refused connection fails at once and does not pause', async () => {
  const calls = stubFetch((n) => (n === 1 ? Promise.reject(new TypeError('fetch failed')) : ok([])));
  await assert.rejects(postDecision(OPTS, NEW.state, NEW.questions), /fetch failed/);
  await postDecision(OPTS, NEW.state, NEW.questions);
  assert.equal(calls.length, 2);
});

test('lunaDecide: a stuck turn maps luna\'s effort and stuck answers, with the call cost', async () => {
  const calls = stubFetch(() => ok([effort(2.2, [0.05, 0.15, 0.6, 0.2], 0.8), stuck(0.6)], USAGE));
  const d = await lunaDecide(turn, DECIDE_OPTS);
  assert.equal(d.target, 2);
  assert.equal(d.hold, 1);
  assert.equal(d.release, false);
  assert.equal(d.stuck, 0.6);
  assert.deepEqual(d.reasons, ['luna high (score 2.20, confidence 0.80)', 'stuck 0.60']);
  assert.deepEqual(d.tokens, { input: 1300, cached: 1200 });
  assert.ok(Math.abs(d.cost - 0.00013) < 1e-12);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.authorization, 'Bearer sk-test');
  assert.equal(calls[0].body.model, 'gpt-6-luna');
  assert.deepEqual(calls[0].body.questions.map((q) => q.name), ['effort', 'stuck']);
  assert.deepEqual(calls[0].body.input[1].content[0].data, effortCall(turn, LADDER).state);
  assert.deepEqual(calls[0].body.input[0].content[0].prompt_cache_breakpoint, { mode: 'explicit' });
});

test('lunaDecide on a new turn asks the effort only and holds nothing', async () => {
  const calls = stubFetch(() => ok([effort(0, [0.9, 0.1, 0, 0], 0.9)], { input_tokens: 40 }));
  const d = await lunaDecide({ userText: 'thanks', steps: [] }, DECIDE_OPTS);
  assert.deepEqual([d.target, d.hold, d.release, d.stuck], [0, 0, false, null]);
  assert.deepEqual(d.reasons, ['luna low (score 0.00, confidence 0.90)']);
  assert.deepEqual(calls[0].body.questions.map((q) => q.name), ['effort']);
});

test('lunaDecide rejects a low-confidence answer, a refusal and a missing effort answer', async () => {
  stubFetch(() => ok([effort(2, [0.05, 0.15, 0.6, 0.2], 0.2)]));
  await assert.rejects(lunaDecide(turn, DECIDE_OPTS), /Luna abstained/);
  stubFetch(() => ok([{ type: 'refusal', name: 'effort' }]));
  await assert.rejects(lunaDecide(turn, DECIDE_OPTS), /Luna refused "effort"/);
  stubFetch(() => ok([]));
  await assert.rejects(lunaDecide(turn, DECIDE_OPTS), /no score answer for "effort"/);
});

test('closingOf keeps the last 800 characters, where the closing question sits', () => {
  assert.equal(closingOf('  done.  '), 'done.');
  const long = `${'a'.repeat(1000)}Shall I go on?`;
  assert.equal(closingOf(long).length, 800);
  assert.match(closingOf(long), /Shall I go on\?$/);
  assert.equal(closingOf(null), '');
  assert.equal(closingOf('   '), '');
});

test('lunaStopCheck: the hard rules settle the stop without a call', async () => {
  const calls = stubFetch(() => stopReply('done', { done: 1 }, 0.9));
  assert.deepEqual(
    await lunaStopCheck({ userText: 'hi', steps: [] }, null, 'Next I will fix it.', OPTS),
    { unfinished: 0, reasons: ['no work started'], cost: null },
  );
  assert.deepEqual(
    await lunaStopCheck(turn, null, 'Please provide your API key.', OPTS),
    { unfinished: 0.1, reasons: ['needs the user'], cost: null },
  );
  const plan = { total: 3, done: 1, open: ['write tests', 'update docs'] };
  assert.deepEqual(
    await lunaStopCheck(turn, plan, 'All done.', OPTS),
    { unfinished: 0.9, reasons: ['plan 1/3 done'], cost: null },
  );
  // No closing text: nothing for luna to read, so the rules' answer stands.
  assert.deepEqual(
    await lunaStopCheck(turn, null, '   ', OPTS),
    { unfinished: 0.5, reasons: ['ended on a failing step'], cost: null },
  );
  assert.equal(calls.length, 0);
});

test('lunaStopCheck sends the closing text and reads the end and in_progress answers', async () => {
  const calls = stubFetch(() => stopReply('will_continue', { will_continue: 0.7, done: 0.2, needs_user: 0.1, other: 0 }, 0.6, { input_tokens: 1000 }));
  const closing = 'Config is updated; the router comes after this.';
  const r = await lunaStopCheck(turn, null, closing, OPTS);
  assert.equal(r.unfinished, 0.7);
  assert.deepEqual(r.reasons, ['luna will_continue 0.70, in progress 0.60']);
  assert.ok(Math.abs(r.cost - 0.0001) < 1e-12);
  assert.deepEqual(calls[0].body.input[1].content[0].data, { request: 'find bugs', steps_so_far: 3, closing });
  assert.deepEqual(calls[0].body.questions.map((q) => q.name), ['end', 'in_progress']);
  assert.deepEqual(calls[0].body.questions[0].choices.map((c) => c.value), ['will_continue', 'done', 'needs_user', 'other']);
});

test('lunaStopCheck: a sure "done" ignores in_progress; the rules still count', async () => {
  stubFetch(() => stopReply('done', { will_continue: 0.03, done: 0.95, needs_user: 0.01, other: 0.01 }, 0.9));
  const r = await lunaStopCheck(okTurn, null, 'All tests pass and the work is done.', OPTS);
  // Without the sure "done" the in_progress 0.90 would have won; the rules' 0.10 is what remains.
  assert.equal(r.unfinished, 0.1);
  assert.deepEqual(r.reasons, ['luna done 0.95, in progress 0.90', 'looks done']);
});

test('lunaStopCheck: an unsure "done" takes the larger of will_continue and in_progress', async () => {
  stubFetch(() => stopReply('done', { will_continue: 0.3, done: 0.5, needs_user: 0.1, other: 0.1 }, 0.6));
  assert.equal((await lunaStopCheck(okTurn, null, 'Parser rewritten.', OPTS)).unfinished, 0.6);
  stubFetch(() => stopReply('will_continue', { will_continue: 0.7, done: 0.2, needs_user: 0.05, other: 0.05 }, 0.2));
  assert.equal((await lunaStopCheck(okTurn, null, 'Parser rewritten, more to come.', OPTS)).unfinished, 0.7);
});

test('lunaStopCheck: the rules\' higher unfinished value wins over luna', async () => {
  stubFetch(() => stopReply('done', { will_continue: 0.1, done: 0.6, needs_user: 0.2, other: 0.1 }, 0.1));
  const r = await lunaStopCheck(okTurn, null, 'Would you like me to continue with the rest?', OPTS);
  assert.equal(r.unfinished, 0.75);
  assert.deepEqual(r.reasons, ['luna done 0.60, in progress 0.10', 'asks permission to continue']);
});

test('lunaStopCheck: when luna says the agent needs the user, only luna\'s will_continue counts', async () => {
  stubFetch(() => stopReply('needs_user', { will_continue: 0.2, done: 0.2, needs_user: 0.6, other: 0 }, 0.7));
  const r = await lunaStopCheck(turn, null, 'Which database should I target, shall I pick one?', OPTS);
  // The rules alone would give 0.75 (a permission question); luna's answer overrides them.
  assert.equal(r.unfinished, 0.2);
  assert.deepEqual(r.reasons, ['luna needs_user 0.60, in progress 0.70']);
});

test('lunaStopCheck accepts probabilities given as a list of value and probability', async () => {
  stubFetch(() => ok([
    { type: 'choice', name: 'end', choice: 'will_continue', probabilities: [{ value: 'will_continue', probability: 0.8 }, { value: 'done', probability: 0.2 }] },
    { type: 'predicate', name: 'in_progress', probability: 0.1 },
  ]));
  assert.equal((await lunaStopCheck(okTurn, null, 'Next I will update the docs.', OPTS)).unfinished, 0.8);
});

test('lunaStopCheck throws on an HTTP error, an unknown choice, a refusal and a missing answer', async () => {
  stubFetch(() => json(500, { error: { message: 'boom', code: 'inference_failed' } }));
  await assert.rejects(lunaStopCheck(turn, null, 'done', OPTS), /Luna HTTP 500: boom/);

  stubFetch(() => stopReply('maybe', { maybe: 1 }, 0.2));
  await assert.rejects(lunaStopCheck(turn, null, 'done', OPTS), /unknown choice for "end"/);

  stubFetch(() => ok([{ type: 'refusal', name: 'end' }, { type: 'predicate', name: 'in_progress', probability: 0.2 }]));
  await assert.rejects(lunaStopCheck(turn, null, 'done', OPTS), /Luna refused "end"/);

  stubFetch(() => ok([{ type: 'choice', name: 'end', choice: 'done', probabilities: { done: 1 } }]));
  await assert.rejects(lunaStopCheck(turn, null, 'done', OPTS), /no predicate answer for "in_progress"/);
});

// The exact response shapes gpt-6-luna returned in a live check: probabilities are lists of
// {value, label, probability} entries, one per level or choice.
test('live gpt-6-luna shapes: lists of {value, label, probability} are read by effort and stop checks', async () => {
  const LIVE_LADDER = ['low', 'medium', 'high', 'xhigh', 'max'];
  const LIVE_EFFORT = {
    type: 'score',
    name: 'effort',
    score: 0.94,
    probabilities: [
      { value: 0, label: 'low', probability: 0.05 },
      { value: 1, label: 'medium', probability: 0.95 },
      { value: 2, label: 'high', probability: 0 },
      { value: 3, label: 'xhigh', probability: 0 },
      { value: 4, label: 'max', probability: 0 },
    ],
    confidence: 0.95,
  };
  const LIVE_STUCK = { type: 'predicate', name: 'stuck', probability: 0.95 };
  const LIVE_USAGE = { input_tokens: 1458, input_tokens_details: { cached_tokens: 1236 } };

  const calls = stubFetch(() => ok([LIVE_EFFORT, LIVE_STUCK], LIVE_USAGE));
  const d = await lunaDecide(turn, { ...OPTS, ladder: LIVE_LADDER, minConfidence: 0.5 });
  // The median of the distribution is medium (cumulative 0.05, then 1.00).
  assert.equal(d.target, 1);
  assert.equal(d.hold, 2);
  assert.equal(d.release, false);
  assert.equal(d.stuck, 0.95);
  assert.deepEqual(d.reasons, ['luna medium (score 0.94, confidence 0.95)', 'stuck 0.95']);
  assert.deepEqual(d.tokens, { input: 1458, cached: 1236 });
  assert.ok(Math.abs(d.cost - 0.0001458) < 1e-12);
  assert.deepEqual(calls[0].body.questions.map((q) => q.name), ['effort', 'stuck']);
  // A low quantile lands on low: the 0.05 of mass at low is the first cumulative value.
  assert.equal(scoreLevel(LIVE_EFFORT, LIVE_LADDER, 0.04).level, 0);

  const LIVE_END = {
    type: 'choice',
    name: 'end',
    choice: 'needs_user',
    probabilities: [
      { value: 'will_continue', probability: 0 },
      { value: 'done', probability: 0.01 },
      { value: 'needs_user', probability: 0.99 },
      { value: 'other', probability: 0 },
    ],
    confidence: 0.99,
  };
  stubFetch(() => ok([LIVE_END, { type: 'predicate', name: 'in_progress', probability: 0.02 }]));
  // The rules see a permission question (0.75); luna's needs_user overrides it with its will_continue of 0.
  const r = await lunaStopCheck(okTurn, null, 'Should I also update the README?', OPTS);
  assert.equal(r.unfinished, 0);
  assert.deepEqual(r.reasons, ['luna needs_user 0.99, in progress 0.02']);
});

const PROJECT_KEY = `sk-proj-${'a1B2'.repeat(12)}`;
const LEGACY_KEY = `sk-${'Z9y8'.repeat(12)}`;

test("decisionKeyFor: the configured key wins; else the client's own OpenAI key when allowed", () => {
  const configured = loadConfig({ LUNA_API_KEY: 'sk-configured' });
  assert.equal(decisionKeyFor(configured, { authorization: `Bearer ${PROJECT_KEY}` }), 'sk-configured');
  assert.equal(decisionKeyFor(loadConfig({ OPENAI_API_KEY: 'sk-openai' }), {}), 'sk-openai');
  assert.equal(decisionKeyFor(loadConfig({ LUNA_API_KEY: 'sk-luna', OPENAI_API_KEY: 'sk-openai' }), {}), 'sk-luna');

  const client = loadConfig({});
  assert.equal(client.useClientKey, true);
  assert.equal(decisionKeyFor(client, { authorization: `Bearer ${PROJECT_KEY}` }), PROJECT_KEY);
  assert.equal(decisionKeyFor(client, { authorization: `Bearer ${LEGACY_KEY}` }), LEGACY_KEY);
  // Keys of other vendors that also start with sk- are never sent to OpenAI.
  assert.equal(decisionKeyFor(client, { authorization: 'Bearer sk-or-v1-openrouter' }), '');
  assert.equal(decisionKeyFor(client, { authorization: `Bearer sk-ant-api03-${'x'.repeat(40)}` }), '');
  assert.equal(decisionKeyFor(client, { authorization: 'Bearer sk-short' }), '');
  assert.equal(decisionKeyFor(client, { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig' }), '');
  assert.equal(decisionKeyFor(client, { authorization: `Basic ${PROJECT_KEY}` }), '');
  assert.equal(decisionKeyFor(client, {}), '');
  assert.equal(decisionKeyFor(client), '');

  // A request bound for another gateway keeps its key away from OpenAI.
  const gateway = loadConfig({ LUNA_UPSTREAM: 'https://api.deepseek.com/v1' });
  assert.equal(decisionKeyFor(gateway, { authorization: `Bearer ${LEGACY_KEY}` }), '');
  const proxied = loadConfig({ LUNA_API_UPSTREAM: 'https://gateway.example/v1' });
  assert.equal(decisionKeyFor(proxied, { authorization: `Bearer ${PROJECT_KEY}` }), '');

  const off = loadConfig({ LUNA_USE_CLIENT_KEY: 'off' });
  assert.equal(decisionKeyFor(off, { authorization: `Bearer ${PROJECT_KEY}` }), '');
});

test('decisionOptions maps the config to the Decisions call, with the key the caller chose', () => {
  const config = loadConfig({
    LUNA_API_KEY: 'sk-cfg', OPENAI_ORG_ID: 'org-1', OPENAI_PROJECT_ID: 'proj-1', LUNA_CACHE: 'implicit', LUNA_DECISION_TIMEOUT_MS: '1500',
  });
  // A client's own key gets no organization or project: those belong to the configured key.
  assert.deepEqual(decisionOptions(config, 'sk-client'), {
    url: 'https://api.openai.com/v1/decisions',
    apiKey: 'sk-client',
    model: 'gpt-6-luna',
    timeoutMs: 1500,
    cacheMode: 'implicit',
    organization: '',
    project: '',
  });
  const own = decisionOptions(config);
  assert.equal(own.apiKey, 'sk-cfg');
  assert.equal(own.organization, 'org-1');
  assert.equal(own.project, 'proj-1');
});

test('review fixes: list order, zero-weight levels, per-key pauses and capped Retry-After', async () => {
  const ladder = ['low', 'medium', 'high', 'xhigh', 'max'];
  const entries = [0, 0.05, 0.05, 0.7, 0.2].map((probability, value) => ({ value, label: ladder[value], probability }));
  const answer = (probabilities) => ({ type: 'score', name: 'effort', score: 3, probabilities, confidence: 0.7 });
  // The entries carry their level, so their order and omitted zero levels do not matter.
  assert.equal(scoreLevel(answer([...entries].sort((a, b) => b.probability - a.probability)), ladder).level, 3);
  assert.equal(scoreLevel(answer(entries.filter((e) => e.probability > 0)), ladder).level, 3);
  // Quantile 0 picks the lowest level Luna gives any weight, not a zero-probability one.
  assert.equal(scoreLevel(answer(entries), ladder, 0).level, 1);

  const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const opts = (apiKey) => ({ url: DECISIONS_URL, apiKey, model: 'gpt-6-luna', timeoutMs: 1000 });
  const calls = stubFetch((n, init) => (init.headers.authorization === 'Bearer sk-bad'
    ? json(401, { error: { message: 'Incorrect API key' } })
    : json(200, { answers: [] })));
  await assert.rejects(postDecision(opts('sk-bad'), {}, []), /HTTP 401/);
  // Another key is not paused by the bad one.
  await postDecision(opts('sk-good'), {}, []);
  assert.equal(calls.length, 2);
  await assert.rejects(postDecision(opts('sk-bad'), {}, []), /paused/);
  assert.equal(calls.length, 2);

  resetLunaPause();
  stubFetch(() => json(429, { error: { message: 'slow down' } }, { 'retry-after': '86400' }));
  await assert.rejects(postDecision(opts('sk-good'), {}, []), /HTTP 429/);
  await assert.rejects(postDecision(opts('sk-good'), {}, []), /paused for (\d+) s/, 'capped pause');
  const m = await postDecision(opts('sk-good'), {}, []).catch((e) => e.message);
  assert.ok(Number(m.match(/paused for (\d+) s/)[1]) <= 600);
});
