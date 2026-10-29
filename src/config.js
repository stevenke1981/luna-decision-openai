import os from 'node:os';
import path from 'node:path';

export const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

// Main models the proxy knows by name. A client that asks for one of them keeps it; the
// proxy only picks its effort. LUNA_MODELS adds more ids.
export const KNOWN_MODELS = ['gpt-6.1-terra', 'gpt-6.1-sol', 'gpt-6-astra'];

function parseLadder(raw) {
  const ladder = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const bad = ladder.filter((e) => !EFFORTS.includes(e));
  if (bad.length || ladder.length === 0) {
    throw new Error(`LUNA_LEVELS must be a comma list of ${EFFORTS.join('/')}; got "${raw}"`);
  }
  // Luna scores the ladder as ordered levels, so it must run from least to most effort.
  for (let i = 1; i < ladder.length; i++) {
    if (EFFORTS.indexOf(ladder[i]) <= EFFORTS.indexOf(ladder[i - 1])) {
      throw new Error(`LUNA_LEVELS must go from least to most effort without repeats; got "${raw}"`);
    }
  }
  return ladder;
}

function list(raw) {
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function intEnv(env, name, fallback) {
  const v = env[name];
  if (v == null || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative integer; got "${v}"`);
  return n;
}

function probabilityEnv(env, name, fallback) {
  const v = Number(env[name] ?? fallback);
  if (!(v >= 0 && v <= 1)) throw new Error(`${name} must be 0..1; got "${env[name]}"`);
  return v;
}

function switchEnv(env, name, fallback) {
  const v = (env[name] || fallback).toLowerCase();
  if (!['on', 'off'].includes(v)) throw new Error(`${name} must be on|off; got "${v}"`);
  return v === 'on';
}

function oneOf(env, name, fallback, allowed) {
  const v = (env[name] || fallback).toLowerCase();
  if (!allowed.includes(v)) throw new Error(`${name} must be ${allowed.join('|')}; got "${v}"`);
  return v;
}

export function loadConfig(env = process.env) {
  const home = env.LUNA_HOME || path.join(os.homedir(), '.luna-decision-openai');
  // auto (the default): OpenAI's Luna decides for a request that has a key for it, the
  // fallback (LUNA_AUTO_FALLBACK) for one that has none. When Luna fails, every decision falls
  // back to the rules, so no mode ever blocks a client.
  const mode = oneOf(env, 'LUNA_MODE', 'auto', ['auto', 'luna', 'heuristic', 'llm', 'off']);
  const ladder = parseLadder(env.LUNA_LEVELS || 'low,medium,high,xhigh,max');
  // A score question needs 2 to 10 levels.
  if ((mode === 'luna' || mode === 'auto') && ladder.length < 2) {
    throw new Error('LUNA_LEVELS needs at least 2 efforts for Luna to choose between');
  }
  const defaultEffort = (env.LUNA_DEFAULT_EFFORT || 'medium').trim().toLowerCase();
  if (!ladder.includes(defaultEffort)) {
    throw new Error(`LUNA_DEFAULT_EFFORT must be one of LUNA_LEVELS (${ladder.join(',')}); got "${defaultEffort}"`);
  }
  const decisionTimeoutMs = intEnv(env, 'LUNA_DECISION_TIMEOUT_MS', 3000);
  // 0 would abort every call and silently turn Luna off; LUNA_MODE=heuristic does that openly.
  if (decisionTimeoutMs < 1) throw new Error('LUNA_DECISION_TIMEOUT_MS must be at least 1; use LUNA_MODE=heuristic to turn Luna off');
  const model = (env.LUNA_MODEL || 'gpt-6.1-terra').trim();
  return Object.freeze({
    host: env.LUNA_HOST || '127.0.0.1',
    // 8791, so it can run beside laya-gpt (8790).
    port: intEnv(env, 'LUNA_PORT', 8791),
    ladder,
    // Where a turn starts when nothing says it is trivial or hard, and the floor once the
    // model has tried to stop early in a turn.
    defaultEffort,
    // The main model a `luna-auto` request is served by.
    model,
    // Main model ids the proxy recognizes (listed by `models`; any of them can be chosen).
    models: [...new Set([model, ...KNOWN_MODELS, ...list(env.LUNA_MODELS || '')])],
    // Client model names that hand the request to the router (besides the model id itself).
    autoModels: list(env.LUNA_AUTO_MODELS || 'luna-auto,auto'),
    // Long-task help: resume a turn the model ended before the work was done, and remind it
    // of an unfinished plan before each generation.
    continueTurns: switchEnv(env, 'LUNA_CONTINUE', 'on'),
    // Resumes per turn in all; a long task that keeps moving is resumed up to this many times.
    maxContinues: intEnv(env, 'LUNA_MAX_CONTINUES', 20),
    // Resumes in a row without progress (no new edit, plan step or newly passing check) after
    // the last one that had some, so an agent that only talks is not resumed forever. 0: resume
    // only after progress.
    maxStalls: intEnv(env, 'LUNA_MAX_STALLS', 2),
    continueThreshold: probabilityEnv(env, 'LUNA_CONTINUE_THRESHOLD', 0.6),
    // Changed code that was never checked, or whose tests still fail, is unfinished work.
    verify: switchEnv(env, 'LUNA_VERIFY', 'on'),
    // Self-review rounds per turn: after the agent says it is done with changed code, it is sent
    // back once to review its own diff against the request and fix what it finds (0 turns it off).
    reviewRounds: intEnv(env, 'LUNA_REVIEW_ROUNDS', 1),
    nudge: switchEnv(env, 'LUNA_NUDGE', 'on'),
    mode,
    // What LUNA_MODE=auto does for a request without a Luna key: the free rules, or the LLM judge.
    autoFallback: oneOf(env, 'LUNA_AUTO_FALLBACK', 'heuristic', ['heuristic', 'llm']),
    // How the Codex profile authenticates the main model: the ChatGPT login, OPENAI_API_KEY or
    // OPENROUTER_API_KEY. The proxy picks the upstream from the key the client sends.
    provider: oneOf(env, 'LUNA_PROVIDER', 'chatgpt', ['chatgpt', 'openai', 'openrouter']),
    // Fixed upstream; when unset the auth type picks ChatGPT backend, OpenRouter or API.
    upstream: env.LUNA_UPSTREAM || '',
    chatgptUpstream: env.LUNA_CHATGPT_UPSTREAM || 'https://chatgpt.com/backend-api/codex',
    apiUpstream: env.LUNA_API_UPSTREAM || 'https://api.openai.com/v1',
    openrouterUpstream: env.LUNA_OPENROUTER_UPSTREAM || 'https://openrouter.ai/api/v1',
    judgeModel: env.LUNA_JUDGE_MODEL || '',
    judgeEffort: env.LUNA_JUDGE_EFFORT || 'low',
    judgeTimeoutMs: intEnv(env, 'LUNA_JUDGE_TIMEOUT_MS', 2500),
    // OpenAI's Decisions API and its one model. Calls are billed to an API key:
    // LUNA_API_KEY, else OPENAI_API_KEY, else (LUNA_USE_CLIENT_KEY=on) a client's own sk- key.
    decisionUrl: env.LUNA_DECISION_URL || 'https://api.openai.com/v1/decisions',
    decisionModel: env.LUNA_DECISION_MODEL || 'gpt-6-luna',
    decisionKey: env.LUNA_API_KEY || env.OPENAI_API_KEY || '',
    useClientKey: switchEnv(env, 'LUNA_USE_CLIENT_KEY', 'on'),
    organization: env.OPENAI_ORG_ID || env.OPENAI_ORGANIZATION || '',
    project: env.OPENAI_PROJECT_ID || env.OPENAI_PROJECT || '',
    decisionTimeoutMs,
    // explicit: one cache breakpoint after the shared rubric (the default); implicit: the
    // API's own breakpoint at the end of input; off: no caching fields are sent.
    cacheMode: oneOf(env, 'LUNA_CACHE', 'explicit', ['explicit', 'implicit', 'off']),
    // Below this confidence Luna abstains and the rules decide.
    minConfidence: probabilityEnv(env, 'LUNA_MIN_CONFIDENCE', 0.4),
    // The point of Luna's effort distribution that is used: 0.5 is the median level; higher
    // values lean toward more effort when Luna is unsure.
    effortQuantile: probabilityEnv(env, 'LUNA_EFFORT_QUANTILE', 0.5),
    home,
    logFile: path.join(home, 'decisions.jsonl'),
    eventFile: path.join(home, 'events.jsonl'),
    quiet: env.LUNA_QUIET === '1',
  });
}
