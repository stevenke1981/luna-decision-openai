// Per-session effort routing: trajectory -> assessment (luna gated by rules, heuristic or judge) -> hysteresis.
// The session state also remembers how this turn was resumed after early stops: how often in
// all, how many times in a row without progress, and how many self-review rounds it had.
import { parseTurn } from './trajectory.js';
import { assess, nextState, isNewTurn } from './policy.js';
import { judge } from './judge.js';
import { lunaDecide, combineEffort } from './decisions.js';

// OpenAI key shapes: project, service-account and admin keys, and legacy `sk-` + 40+ letters
// and digits. Other vendors' `sk-` keys (sk-or-, sk-ant-, ...) have a different prefix.
const OPENAI_KEY = /^sk-(?:(?:proj|svcacct|admin)-[\w-]{20,}|[A-Za-z0-9]{40,})$/;
const MAX_FAILURE = 120;

/**
 * The API key Luna is billed to: the configured one, else (LUNA_USE_CLIENT_KEY=on) the
 * client's own OpenAI key, but only when that request itself goes to OpenAI's API (no fixed
 * upstream), so a key meant for another gateway is never sent to OpenAI. ChatGPT logins and
 * OpenRouter keys cannot call the Decisions API and are never used.
 */
export function decisionKeyFor(config, headers = {}) {
  if (config.decisionKey) return config.decisionKey;
  if (!config.useClientKey || config.upstream) return '';
  if (new URL(config.apiUpstream).hostname !== 'api.openai.com') return '';
  const m = String(headers.authorization ?? '').match(/^Bearer\s+(\S+)$/);
  return m && OPENAI_KEY.test(m[1]) ? m[1] : '';
}

/** One line of at most MAX_FAILURE characters, for logs and the console. */
export function failureText(err) {
  return String(err?.message ?? err).replace(/[\r\n]+/g, ' ').slice(0, MAX_FAILURE);
}

/** The Decisions call options shared by effort routing and the stop check. */
export function decisionOptions(config, apiKey) {
  const key = apiKey ?? config.decisionKey;
  const own = key === config.decisionKey;
  return {
    url: config.decisionUrl,
    apiKey: key,
    model: config.decisionModel,
    timeoutMs: config.decisionTimeoutMs,
    cacheMode: config.cacheMode,
    // The organization and project belong to the configured key, not to a client's own key.
    organization: own ? config.organization : '',
    project: own ? config.project : '',
  };
}

const MAX_SESSIONS = 500;
// Resume bookkeeping that lives for one turn and survives the per-generation effort state.
const TURN_FIELDS = ['continues', 'stalls', 'mark', 'reviews', 'reviewedEdits', 'focus'];

function turnFields(prev) {
  const out = {};
  for (const k of TURN_FIELDS) if (prev?.[k] !== undefined) out[k] = prev[k];
  return out;
}

export function createRouter(config, { judgeFn = judge, decideFn = lunaDecide } = {}) {
  const sessions = new Map();
  const ladder = config.ladder;
  const defaultLevel = Math.max(0, ladder.indexOf(config.defaultEffort));

  function remember(key, state) {
    sessions.delete(key);
    sessions.set(key, state);
    if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  }

  async function assessTurn(body, judgeTarget, turn, step, apiKey) {
    const heuristic = assess(turn, ladder, config.defaultEffort);
    if (config.mode === 'luna') {
      try {
        const d = await decideFn(turn, { ...decisionOptions(config, apiKey), ladder, minConfidence: config.minConfidence, quantile: config.effortQuantile });
        const useLuna = turn.steps.length === 0 || d.target > heuristic.target;
        return { a: combineEffort(d, heuristic, turn.steps.length === 0), source: useLuna ? 'luna' : 'heuristic (luna considered)', cost: d.cost ?? null,
          suggestions: { luna: ladder[d.target], heuristic: ladder[heuristic.target] } };
      } catch (err) {
        return { a: heuristic, source: `heuristic (luna failed: ${failureText(err)})`, cost: null };
      }
    }
    if (config.mode === 'llm' && judgeTarget && step > 1) {
      try {
        const a = await judgeFn(turn, {
          ...judgeTarget,
          model: config.judgeModel || judgeTarget.model || body.model,
          effort: config.judgeEffort,
          timeoutMs: config.judgeTimeoutMs,
          ladder,
        });
        return { a, source: 'judge', cost: null };
      } catch (err) {
        return { a: heuristic, source: `heuristic (judge failed: ${failureText(err)})`, cost: null };
      }
    }
    return { a: heuristic, source: 'heuristic', cost: null };
  }

  /**
   * @param {object} body Responses or Chat Completions request body
   * @param {string} sessionKey
   * @param {{url:string, headers:Record<string,string>, model?:string}|null} judgeTarget model: what
   *   the judge runs on when LUNA_JUDGE_MODEL is unset (the proxy resolves aliases)
   * @param {object} [turn] parsed trajectory; defaults to the Responses `input`
   * @param {{apiKey?:string}} [auth] the API key Luna is billed to (see decisionKeyFor)
   * @returns {Promise<{effort:string, from:string|null, step:number, hold:number, reasons:string[],
   *   source:string, cost:number|null, ms:number}>}
   */
  async function route(body, sessionKey, judgeTarget, turn = parseTurn(body.input), auth = {}) {
    const started = performance.now();
    const step = turn.steps.length + 1;
    const prev = sessions.get(sessionKey);
    const { a, source, cost, suggestions } = await assessTurn(body, judgeTarget, turn, step, auth.apiKey);
    const fresh = isNewTurn(prev, step);
    let state = nextState(prev, a, step);
    const kept = fresh ? { continues: 0 } : { continues: 0, ...turnFields(prev) };
    if (kept.continues > 0 && state.level < defaultLevel) {
      // The model already tried to stop early this turn; low effort is where it gets lazy.
      state = { ...state, level: defaultLevel, reasons: [...state.reasons, 'resumed turn keeps default effort'] };
    }
    remember(sessionKey, { ...state, ...kept });
    return {
      effort: ladder[state.level],
      from: state.from == null ? null : ladder[state.from],
      step,
      hold: state.hold,
      reasons: state.reasons,
      source,
      ...(suggestions ? { suggestions } : {}),
      ...(state.level !== a.target ? { adjustment: 'session policy' } : {}),
      cost,
      ms: Math.round(performance.now() - started),
    };
  }

  /** How many times this session's current turn was resumed after an early stop. */
  function continuesOf(sessionKey) {
    return sessions.get(sessionKey)?.continues ?? 0;
  }

  /**
   * Notes a generation of a session that is not routed (only its model is set), so a new turn
   * still resets the resume bookkeeping of the last one.
   * @param {number} step 1-based generation index within the turn
   */
  function observe(sessionKey, step) {
    const prev = sessions.get(sessionKey);
    if (isNewTurn(prev, step)) remember(sessionKey, { level: defaultLevel, hold: 0, step, from: null, reasons: [], continues: 0 });
    else remember(sessionKey, { ...prev, step });
  }

  // Resumes without progress before this one, if the turn were resumed now at progress `mark`:
  // 0 when the turn moved since the last resume (or was never resumed).
  function stallsAt(prev, mark) {
    return mark != null && prev?.mark === mark ? (prev.stalls ?? 0) + 1 : 0;
  }

  /**
   * Whether the current turn may be resumed once more: under LUNA_MAX_CONTINUES in all, and at
   * most LUNA_MAX_STALLS resumes in a row without progress after the last one that had some.
   * @param {string} [mark] the turn's progress (longtask progressOf); omitted, only the total counts
   */
  function canResume(sessionKey, mark) {
    const prev = sessions.get(sessionKey);
    if ((prev?.continues ?? 0) >= config.maxContinues) return false;
    return mark == null || stallsAt(prev, mark) <= (config.maxStalls ?? Infinity);
  }

  /**
   * Whether the current turn is due a self-review round: rounds are left, the total budget is
   * not spent, and code changed since the last review (or since the turn began).
   * @param {number} edits edits in the turn so far
   */
  function canReview(sessionKey, edits) {
    const prev = sessions.get(sessionKey);
    if ((prev?.continues ?? 0) >= config.maxContinues) return false;
    if ((prev?.reviews ?? 0) >= (config.reviewRounds ?? 0)) return false;
    return edits > (prev?.reviewedEdits ?? 0);
  }

  /**
   * Records that the proxy resumed the current turn, and returns the effort for the
   * resumed generation: one rung above the last one, at least the default.
   * @param {{mark?:string, review?:boolean, edits?:number, focus?:string|null}} [resume] mark: the
   *   turn's progress; review: this resume is a self-review round over `edits` edits; focus: the
   *   reminder repeated before the turn's next generations (see focusOf)
   * @returns {{continues:number, effort:string, stalls:number, reviews:number}}
   */
  function noteContinue(sessionKey, { mark, review = false, edits = 0, focus = null } = {}) {
    const prev = sessions.get(sessionKey) ?? { level: defaultLevel, hold: 0, step: 1, continues: 0 };
    const level = Math.min(ladder.length - 1, Math.max(defaultLevel, prev.level + 1));
    const continues = (prev.continues ?? 0) + 1;
    // A review is progress-driven (it needs new edits), so it starts a fresh streak.
    const stalls = review ? 0 : stallsAt(prev, mark);
    const reviews = (prev.reviews ?? 0) + (review ? 1 : 0);
    const next = { ...prev, level, continues, stalls, mark, reviews, focus };
    if (review) next.reviewedEdits = edits;
    remember(sessionKey, next);
    return { continues, effort: ladder[level], stalls, reviews };
  }

  /**
   * The reminder of the last resume, while the turn it belongs to goes on. A resume instruction
   * reaches only the generation it was sent with (the client keeps no copy), so the proxy
   * repeats a short form of it before the turn's later generations.
   */
  function focusOf(sessionKey) {
    return sessions.get(sessionKey)?.focus ?? null;
  }

  /** Drops the reminder once the turn has ended for good. */
  function clearFocus(sessionKey) {
    const prev = sessions.get(sessionKey);
    if (prev?.focus) remember(sessionKey, { ...prev, focus: null });
  }

  return { route, observe, continuesOf, canResume, canReview, noteContinue, focusOf, clearFocus, sessions };
}
