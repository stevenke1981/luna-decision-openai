// OpenAI's Luna (gpt-6-luna) via the Decisions API (POST /v1/decisions): typed questions in,
// calibrated probabilities out, about 10x faster than a Responses call and billed only for
// input tokens. The calls are shaped for Luna:
// - The effort is a `score` question whose levels are the ladder, low to high. Luna returns a
//   distribution over the levels; the proxy takes a quantile of it (the median by default),
//   which respects the order of the levels where an argmax would not.
// - Yes/no signals (stuck, still working) are `predicate` questions: one probability each.
// - Every call starts with the same long developer rubric, marked as a cache breakpoint, so
//   the shared prefix is billed at the cached rate; only the short JSON state changes.
// - The state is `input_json`: the request, a phrase about the last step and the recent steps.
// Luna's answers are still gated by the rules in policy.js and longtask.js (combineEffort and
// lunaStopCheck): the rules' escalation for a failing agent always stands.
import { assessStop } from './longtask.js';

const MAX_REQUEST = 2000;
const MAX_CLOSING = 800;
const MAX_STEPS = 8;
const MAX_COMMAND = 160;
const SYNTHESIS_READS = 4;
const REPEAT_WINDOW = 6;
const STUCK_HOLD_2 = 0.75;
const STUCK_HOLD_1 = 0.5;
const STUCK_RELEASE = 0.25;
const SURE_DONE = 0.9;
// Uncached input; output is free. Cached reads cost less, so this is an upper bound.
const USD_PER_INPUT_TOKEN = 0.10 / 1e6;
export const CACHE_KEY = 'luna-decision-openai/v1';

// The shared prefix of every call. It must stay byte-identical across calls (and above the
// 1,024-token minimum) to be cached, so it describes every effort, not just the ladder in use.
export const RUBRIC = `You are the effort router of a coding agent proxy. A coding agent (an LLM that edits a
software repository by calling tools: reading files, searching, editing, running commands, tests
and builds) works on a request from its user. Before each of the agent's generations the proxy
asks you how much reasoning effort that generation needs, and when the agent ends its turn the
proxy asks you whether it stopped before the work was done. Your answers set real reasoning
budgets: too little effort makes the agent careless, loop on failures or stop early; too much
wastes time and money on routine steps. Judge only from the evidence in the input.

The input is a JSON object. Fields you may see:
- "request": the user's latest request, verbatim (it may be in any language).
- "last_step": a short phrase about the agent's most recent tool call and its outcome.
- "recent_steps": the latest tool calls in order, each with "kind" (read, edit, verify, exec,
  tool), "command" and "status" (ok, failed or pending).
- "steps_so_far": how many tool calls the agent has made in this turn.
- "closing": the end of the message the agent finished its turn with.

Reasoning effort levels, from least to most:
- none / minimal: nothing to think about; a greeting, thanks or acknowledgement.
- low: routine. A quick factual question; reading, listing or searching files; a command that
  just succeeded and whose next step is obvious.
- medium: ordinary engineering. A small feature, a focused edit to one or two files, a script,
  combining a few findings, or fixing a single new failure with a clear error message.
- high: hard engineering. Designing a feature, a refactor across modules, debugging a subtle or
  intermittent failure, finding a root cause, performance work, a migration; or an agent with
  two or three failures in a row.
- xhigh: very hard or risky. Redesigning an architecture, security-critical code, concurrency
  bugs, data-loss risks; or an agent that has failed four or more times in a row or repeats the
  same failing command, so its approach must change.
- max: the hardest problems: long multi-part tasks with many interacting constraints, proofs,
  novel algorithms, or an agent that keeps failing after it has already been given high effort.

How to judge a new request (no steps yet): judge the work the request implies, not its length
or tone. A long pasted log with a simple question is still simple; a one-line request such as
"make the cache thread-safe" can be hard. Requests that ask why something happens, ask for a
design or a comparison of trade-offs, or touch security, concurrency or data integrity need more
effort than requests to rename, format, list or explain a single thing.

How to judge the next step inside a turn: look at the trajectory, not at the original request
alone. Routine progress (reads, searches, successful commands) needs little effort even inside
a hard task. Effort should rise right after an edit (the change must be verified and its
consequences understood), when many findings must be combined into a diagnosis, and above all
when the agent fails: a first failure needs medium, repeated failures need high or more, and the
same failing command repeated means the agent is stuck and must rethink.

An agent is stuck when it fails again and again, repeats the same failing action, or circles
between the same files without progress. An agent fixing one new failure is not stuck.

How to judge a turn that ended: the agent stopped too early when its closing message promises
or offers more work on the same task ("next I will", "remaining steps", "then run the tests"),
reports partial progress, or asks permission for a step it could simply take. It stopped
legitimately when it says the task is complete and verified, or when it needs something only
the user can give: a password, a key, a login, a payment, or a decision between options that
changes what the user gets. A question that only the agent's own tools could answer is not a
reason to stop.

Worked examples (the right answer is in brackets):
- request "thanks, that works" [effort: none or minimal, else low].
- request "what does the --force flag of install do?" [low].
- request "add a --json option to the stats command and print the same numbers" [medium].
- request "the proxy sometimes drops the last event of a stream under load; find out why and fix
  it" [high: an intermittent failure whose cause is unknown].
- request "redesign session storage so several proxy processes can share it safely" [xhigh:
  architecture plus concurrency].
- last step "read a file, it worked" in a hard task [low: routine progress].
- last step "edited code, it worked" [medium: the change still has to be verified].
- recent steps show the same test command failing three times with small edits in between
  [high or xhigh, stuck likely].
- closing "I updated the parser. Next I will update the CLI and then run the full test suite."
  [will continue; work in progress].
- closing "All 163 tests pass and the change is committed." [done; not in progress].
- closing "I need your OpenAI API key to run the live check; please set OPENAI_API_KEY."
  [needs the user].
- closing "Should I go ahead and also update the README?" when the request asked for docs too
  [the agent stopped early: it asks permission for a step it could simply take].

Answer every question independently, from the evidence, and give honest probabilities: when
the evidence is thin, spread probability across the plausible answers instead of guessing.`;

// One sentence per effort, used as the level descriptions of a score question.
const REQUEST_LEVELS = {
  none: 'nothing to do: a greeting, thanks or acknowledgement',
  minimal: 'nothing to do: a greeting, thanks or acknowledgement',
  low: 'a quick factual question or a trivial single change',
  medium: 'an ordinary coding task: a small feature, a focused edit, a script',
  high: 'hard engineering: design, a refactor across modules, a subtle bug, a root cause',
  xhigh: 'very hard or risky: architecture, security, concurrency, data integrity',
  max: 'the hardest: long multi-part work with many interacting constraints, proofs, novel algorithms',
};
const STEP_LEVELS = {
  none: 'nothing left to think about',
  minimal: 'nothing left to think about',
  low: 'routine progress: it just read, listed or searched, or a command succeeded',
  medium: 'needs thought: it just edited code, must combine findings, or hit one new failure',
  high: 'struggling: two or three failures in a row',
  xhigh: 'stuck: four or more failures in a row, or the same failing command repeated',
  max: 'still failing after high effort; the whole approach must change',
};
const STUCK_QUESTION = {
  type: 'predicate',
  name: 'stuck',
  instructions: 'Is the coding agent stuck: failing again and again, or repeating the same failing action?',
};
// Two views of the closing text, asked in one call. `end` tells a request for the user apart;
// `in_progress` catches progress reports that list what remains.
const END_CHOICES = [
  { value: 'will_continue', description: 'plans or offers to keep going on the same task' },
  { value: 'done', description: 'says the task is complete' },
  { value: 'needs_user', description: 'asks for a key, password, login or a decision only the user can make' },
  { value: 'other', description: 'none of the above' },
];
const STOP_QUESTIONS = [
  { type: 'choice', name: 'end', instructions: 'What does the agent say or ask at the end of its closing message?', choices: END_CHOICES },
  { type: 'predicate', name: 'in_progress', instructions: 'Does the closing message show that part of the work is done and more of the same task remains?' },
];
// Stop rules that settle the question without asking Luna.
const HARD_STOP_REASONS = new Set(['no work started', 'needs the user']);

function levelsFor(table, ladder) {
  return ladder.map((e) => ({ label: e, description: table[e] ?? `${e} reasoning effort` }));
}

function failureStreak(steps) {
  let n = 0;
  for (let i = steps.length - 1; i >= 0 && steps[i].failed; i--) n++;
  return n;
}

function repeatsFailure(steps) {
  const failed = steps.slice(-REPEAT_WINDOW).filter((s) => s.failed).map((s) => s.command.replace(/\s+/g, ' ').trim());
  return new Set(failed).size < failed.length;
}

function readsSinceEdit(steps) {
  let n = 0;
  for (let i = steps.length - 1; i >= 0 && steps[i].kind !== 'edit'; i--) if (steps[i].kind === 'read') n++;
  return n;
}

const KIND_PHRASE = {
  read: 'read a file', edit: 'edited code', verify: 'ran the tests or build', exec: 'ran a command', tool: 'used a tool',
};

/**
 * One coarse phrase about where the turn stands; the recent steps carry the details.
 * @param {Array<{kind:string, command:string, failed:boolean|null}>} steps at least one step
 */
export function situation(steps) {
  const last = steps.at(-1);
  const verb = KIND_PHRASE[last.kind] ?? 'ran a command';
  if (last.failed == null) return `${verb}, still running`;
  if (!last.failed) {
    const reads = readsSinceEdit(steps);
    if (last.kind === 'read' && reads >= SYNTHESIS_READS) return `read ${reads} files since the last edit`;
    return `${verb}, it worked`;
  }
  const streak = failureStreak(steps);
  const parts = [`${verb}, it failed`];
  parts.push(streak === 1 ? 'first failure' : streak >= 4 ? '4 or more failures in a row' : `${streak} failures in a row`);
  if (repeatsFailure(steps)) parts.push('the same failing command was repeated');
  return parts.join('; ');
}

function recentSteps(steps) {
  return steps.slice(-MAX_STEPS).map((s) => ({
    kind: s.kind,
    command: s.command.replace(/\s+/g, ' ').slice(0, MAX_COMMAND),
    status: s.failed == null ? 'pending' : s.failed ? 'failed' : 'ok',
  }));
}

/** The state and questions of an effort call: the request on a new turn, the trajectory after. */
export function effortCall(turn, ladder) {
  const request = turn.userText.slice(0, MAX_REQUEST);
  if (turn.steps.length === 0) {
    return {
      state: { request },
      questions: [
        { type: 'score', name: 'effort', instructions: 'How much reasoning effort does this new request need?', levels: levelsFor(REQUEST_LEVELS, ladder) },
      ],
    };
  }
  return {
    state: {
      request,
      last_step: situation(turn.steps),
      recent_steps: recentSteps(turn.steps),
      steps_so_far: turn.steps.length,
    },
    questions: [
      { type: 'score', name: 'effort', instructions: "How much reasoning effort does the coding agent's next generation need?", levels: levelsFor(STEP_LEVELS, ladder) },
      STUCK_QUESTION,
    ],
  };
}

/**
 * The Decisions request body. The rubric comes first and, in explicit cache mode, carries the
 * one breakpoint; the state follows as JSON, so only it differs between calls.
 * @param {'explicit'|'implicit'|'off'} cacheMode
 */
export function requestBody(model, state, questions, cacheMode = 'explicit') {
  const rubric = { type: 'input_text', text: RUBRIC };
  if (cacheMode === 'explicit') rubric.prompt_cache_breakpoint = { mode: 'explicit' };
  return {
    model,
    input: [
      { role: 'developer', content: [rubric] },
      { role: 'user', content: [{ type: 'input_json', data: state }] },
    ],
    questions,
    ...(cacheMode !== 'off' ? { prompt_cache_key: CACHE_KEY } : {}),
    ...(cacheMode === 'explicit' ? { prompt_cache_options: { mode: 'explicit' } } : {}),
  };
}

/** Answers keyed by question name; a refusal becomes an error. */
export function answersByName(body) {
  const answers = Array.isArray(body?.answers) ? body.answers : [];
  const out = {};
  for (const a of answers) {
    if (a && typeof a.name === 'string') out[a.name] = a;
  }
  return out;
}

function expectAnswer(answer, type, name) {
  if (answer?.type === 'refusal') throw new Error(`Luna refused "${name}"`);
  if (answer?.type !== type) throw new Error(`Luna returned no ${type} answer for "${name}"`);
  return answer;
}

// The probability of each level, in level order. The API may key them by index or by label.
function levelProbabilities(answer, labels) {
  const p = answer.probabilities;
  const values = Array.isArray(p)
    ? labels.map((_, i) => p[i])
    : p && typeof p === 'object' ? labels.map((label, i) => p[label] ?? p[i] ?? p[String(i)]) : [];
  const nums = values.map((v) => (typeof v === 'object' && v ? v.probability : v)).map((v) => (Number.isFinite(v) ? v : 0));
  const total = nums.reduce((a, b) => a + b, 0);
  return total > 0 ? nums.map((v) => v / total) : null;
}

/**
 * The ladder index a score answer points to: the `quantile` of its level distribution (the
 * median by default), or the rounded score when the distribution is missing.
 */
export function scoreLevel(answer, ladder, quantile = 0.5) {
  const probs = levelProbabilities(answer, ladder);
  const top = ladder.length - 1;
  if (probs) {
    let cumulative = 0;
    for (let i = 0; i < probs.length; i++) {
      cumulative += probs[i];
      if (cumulative >= quantile - 1e-9) return { level: i, probs };
    }
    return { level: top, probs };
  }
  if (!Number.isFinite(answer.score)) throw new Error('Luna returned a score without a value');
  return { level: Math.max(0, Math.min(top, Math.round(answer.score))), probs: null };
}

function confidenceOf(answer, probs) {
  if (Number.isFinite(answer.confidence)) return answer.confidence;
  return probs ? Math.max(...probs) : 1;
}

function probabilityOf(answer, name) {
  const p = expectAnswer(answer, 'predicate', name).probability;
  if (!Number.isFinite(p)) throw new Error(`Luna returned no probability for "${name}"`);
  return p;
}

/**
 * Maps Luna's answers onto the policy's assessment shape. Abstains (throws) when the effort
 * answer's confidence is below `minConfidence`, so the caller falls back to the rules.
 */
export function toAssessment(answers, ladder, minConfidence, quantile = 0.5) {
  const effort = expectAnswer(answers?.effort, 'score', 'effort');
  const { level, probs } = scoreLevel(effort, ladder, quantile);
  const confidence = confidenceOf(effort, probs);
  const score = Number.isFinite(effort.score) ? effort.score.toFixed(2) : '?';
  if (confidence < minConfidence) {
    throw new Error(`Luna abstained: ${ladder[level]} (score ${score}, confidence ${confidence.toFixed(2)} < ${minConfidence})`);
  }
  const reasons = [`luna ${ladder[level]} (score ${score}, confidence ${confidence.toFixed(2)})`];
  if (answers.stuck == null) return { target: level, hold: 0, release: false, stuck: null, reasons };
  const stuck = probabilityOf(answers.stuck, 'stuck');
  return {
    target: level,
    hold: stuck >= STUCK_HOLD_2 ? 2 : stuck >= STUCK_HOLD_1 ? 1 : 0,
    release: stuck < STUCK_RELEASE,
    stuck,
    reasons: [...reasons, `stuck ${stuck.toFixed(2)}`],
  };
}

/**
 * Gates Luna's effort with the rules. A new turn follows Luna, which reads the request.
 * Inside a turn Luna may only raise the effort: the rules' escalation for failures always
 * stands, and a tie keeps the rules' (deterministic) hold.
 */
export function combineEffort(luna, heuristic, newTurn) {
  if (newTurn) return luna;
  // A higher Luna target keeps the rules' hold too, so a failing agent does not drop back early.
  if (luna.target > heuristic.target) return { ...luna, hold: Math.max(luna.hold, heuristic.hold) };
  return { ...heuristic, reasons: [...heuristic.reasons, ...luna.reasons] };
}

/** Tokens and the uncached-price upper bound of one call, from the response usage. */
export function callCost(usage) {
  const input = Number.isFinite(usage?.input_tokens) ? usage.input_tokens : null;
  if (input == null) return { cost: null, tokens: null };
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  return { cost: input * USD_PER_INPUT_TOKEN, tokens: { input, cached } };
}

// A Luna that fails in a way the next call would repeat is skipped for a while, so a hung
// endpoint, a bad key or an exhausted quota costs one failure, not one per generation.
const PAUSE_MS = { timeout: 30_000, auth: 600_000, rate: 60_000 };
const pausedUntil = new Map();
// Set when the API rejects explicit cache breakpoints; later calls use the implicit mode.
let explicitCacheRejected = false;

/** Ends every pause and forgets a rejected cache mode; for tests. */
export function resetLunaPause() {
  pausedUntil.clear();
  explicitCacheRejected = false;
}

function pause(url, ms) {
  pausedUntil.set(url, Date.now() + ms);
}

function retryAfterMs(res) {
  const s = Number(res.headers.get('retry-after'));
  return Number.isFinite(s) && s > 0 ? s * 1000 : PAUSE_MS.rate;
}

function headersFor(opts) {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${opts.apiKey}`,
    ...(opts.organization ? { 'openai-organization': opts.organization } : {}),
    ...(opts.project ? { 'openai-project': opts.project } : {}),
  };
}

async function send(opts, body) {
  try {
    return await fetch(opts.url, {
      method: 'POST', headers: headersFor(opts), body: JSON.stringify(body), signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (err) {
    // Only a timeout pauses: a refused connection fails at once and costs nothing.
    if (err?.name === 'TimeoutError') pause(opts.url, PAUSE_MS.timeout);
    throw err;
  }
}

/**
 * POSTs one Decisions request; resolves to the parsed body or throws. An explicit cache
 * breakpoint the API rejects is retried once without it, and not sent again.
 * @param {{url:string, apiKey:string, model:string, timeoutMs:number, cacheMode?:string,
 *   organization?:string, project?:string}} opts
 */
export async function postDecision(opts, state, questions) {
  if (!opts.apiKey) throw new Error('no OpenAI API key (set OPENAI_API_KEY or LUNA_API_KEY)');
  const until = pausedUntil.get(opts.url) ?? 0;
  if (Date.now() < until) throw new Error(`Luna paused for ${Math.ceil((until - Date.now()) / 1000)} s after a failure`);
  let mode = opts.cacheMode ?? 'explicit';
  if (mode === 'explicit' && explicitCacheRejected) mode = 'implicit';
  let res = await send(opts, requestBody(opts.model, state, questions, mode));
  let body = await res.json().catch(() => null);
  if (res.status === 400 && mode === 'explicit' && /cache/i.test(body?.error?.message ?? '')) {
    explicitCacheRejected = true;
    res = await send(opts, requestBody(opts.model, state, questions, 'implicit'));
    body = await res.json().catch(() => null);
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) pause(opts.url, PAUSE_MS.auth);
    if (res.status === 429) pause(opts.url, retryAfterMs(res));
    throw new Error(`Luna HTTP ${res.status}: ${body?.error?.message ?? 'no error body'}`);
  }
  pausedUntil.delete(opts.url);
  return body;
}

/**
 * @param {{userText:string, steps:Array<{kind:string, command:string, failed:boolean|null}>}} turn
 * @param {{url:string, apiKey:string, model:string, timeoutMs:number, ladder:string[],
 *   minConfidence:number, quantile?:number, cacheMode?:string}} opts
 * @returns {Promise<{target:number, hold:number, release:boolean, stuck:number|null, reasons:string[],
 *   cost:number|null, tokens:{input:number, cached:number}|null}>}
 */
export async function lunaDecide(turn, opts) {
  const { state, questions } = effortCall(turn, opts.ladder);
  const body = await postDecision(opts, state, questions);
  const assessment = toAssessment(answersByName(body), opts.ladder, opts.minConfidence, opts.quantile ?? 0.5);
  return { ...assessment, ...callCost(body?.usage) };
}

/** The end of the closing text, where a promise or a question to the user sits. */
export function closingOf(finalText) {
  const text = String(finalText ?? '').trim();
  return text.length > MAX_CLOSING ? text.slice(-MAX_CLOSING) : text;
}

function choiceProbability(answer, value) {
  const p = answer.probabilities;
  const v = Array.isArray(p)
    ? p.find((x) => x?.value === value)?.probability
    : p && typeof p === 'object' ? p[value] : undefined;
  if (Number.isFinite(v)) return v;
  // Without a distribution, the chosen value carries the answer's confidence.
  return answer.choice === value ? (Number.isFinite(answer.confidence) ? answer.confidence : 1) : 0;
}

/**
 * Whether a generation that ended the turn stopped before the task was done.
 * The hard rules decide first (no work started, a request for the user's input, an open
 * plan). Otherwise Luna reads the closing text, and the rules' own signals (a permission
 * question, a promise of more work) stand unless Luna says the agent needs the user.
 * @param {object} turn the parsed turn (userText, steps)
 * @param {{total:number, done:number, open:string[]}|null} plan
 * @param {string} finalText the text of the generation that ended the turn
 * @param {{url:string, apiKey:string, model:string, timeoutMs:number, cacheMode?:string}} opts
 * @returns {Promise<{unfinished:number, reasons:string[], cost:number|null}>}
 */
export async function lunaStopCheck(turn, plan, finalText, opts) {
  const rules = assessStop(turn, plan, finalText);
  if (HARD_STOP_REASONS.has(rules.reasons[0]) || plan?.open?.length > 0) return { ...rules, cost: null };
  const closing = closingOf(finalText);
  if (!closing) return { ...rules, cost: null };
  const state = { request: turn.userText.slice(0, MAX_REQUEST), steps_so_far: turn.steps.length, closing };
  const body = await postDecision(opts, state, STOP_QUESTIONS);
  const answers = answersByName(body);
  const end = expectAnswer(answers.end, 'choice', 'end');
  if (!END_CHOICES.some((c) => c.value === end.choice)) throw new Error('Luna returned an unknown choice for "end"');
  const inProgress = probabilityOf(answers.in_progress, 'in_progress');
  const continuing = choiceProbability(end, 'will_continue');
  const top = choiceProbability(end, end.choice);
  const { cost } = callCost(body?.usage);
  const reasons = [`luna ${end.choice} ${top.toFixed(2)}, in progress ${inProgress.toFixed(2)}`];
  // A request for the user is a legitimate stop: only Luna's own "will continue" counts.
  if (end.choice === 'needs_user') return { unfinished: continuing, reasons, cost };
  // A summary that lists finished items can read as "in progress"; when `end` is sure the
  // message says done, only the rules' own signals can still resume.
  const judged = end.choice === 'done' && top >= SURE_DONE ? continuing : Math.max(continuing, inProgress);
  if (rules.unfinished > judged) return { unfinished: rules.unfinished, reasons: [...reasons, ...rules.reasons], cost };
  return { unfinished: judged, reasons, cost };
}
