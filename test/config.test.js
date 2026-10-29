import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, KNOWN_MODELS } from '../src/config.js';

test('defaults: auto mode (heuristic fallback), the medium..max ladder at medium, gpt-6.1-terra on port 8791 with the Decisions API', () => {
  const cfg = loadConfig({});
  assert.equal(cfg.mode, 'auto');
  assert.equal(cfg.autoFallback, 'heuristic');
  assert.deepEqual(cfg.ladder, ['medium', 'high', 'xhigh', 'max']);
  assert.equal(cfg.defaultEffort, 'medium');
  assert.equal(cfg.model, 'gpt-6.1-terra');
  assert.equal(cfg.port, 8791);
  assert.equal(cfg.host, '127.0.0.1');
  assert.equal(cfg.decisionModel, 'gpt-6-luna');
  assert.equal(cfg.decisionUrl, 'https://api.openai.com/v1/decisions');
  assert.equal(cfg.decisionTimeoutMs, 3000);
  assert.equal(cfg.cacheMode, 'explicit');
  assert.equal(cfg.minConfidence, 0.4);
  assert.equal(cfg.effortQuantile, 0.5);
  assert.equal(cfg.home, path.join(os.homedir(), '.luna-decision-openai'));
  assert.equal(cfg.logFile, path.join(cfg.home, 'decisions.jsonl'));
  assert.equal(cfg.quiet, false);
});

test('the returned config is frozen so no caller can change it mid-run', () => {
  assert.equal(Object.isFrozen(loadConfig({})), true);
});

test('LUNA_HOME moves the home, the decision log and the event file', () => {
  const home = path.join(os.tmpdir(), 'luna-config-home');
  const cfg = loadConfig({ LUNA_HOME: home });
  assert.equal(cfg.home, home);
  assert.equal(cfg.logFile, path.join(home, 'decisions.jsonl'));
  assert.equal(cfg.eventFile, path.join(home, 'events.jsonl'));
});

test('decisionKey: LUNA_API_KEY wins over OPENAI_API_KEY, which is used otherwise, and none is empty', () => {
  assert.equal(loadConfig({ LUNA_API_KEY: 'luna-key', OPENAI_API_KEY: 'openai-key' }).decisionKey, 'luna-key');
  assert.equal(loadConfig({ OPENAI_API_KEY: 'openai-key' }).decisionKey, 'openai-key');
  assert.equal(loadConfig({}).decisionKey, '');
});

test('models: the configured model comes first, then the known ones, then LUNA_MODELS, without duplicates', () => {
  assert.deepEqual(loadConfig({}).models, ['gpt-6.1-terra', 'gpt-6.1-sol', 'gpt-6-astra']);
  assert.deepEqual(KNOWN_MODELS, ['gpt-6.1-terra', 'gpt-6.1-sol', 'gpt-6-astra']);

  const extra = loadConfig({ LUNA_MODELS: ' gpt-6-astra, gpt-x, gpt-x, ,gpt-6.1-sol ' }).models;
  assert.deepEqual(extra, ['gpt-6.1-terra', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-x']);
  assert.equal(new Set(extra).size, extra.length);

  const custom = loadConfig({ LUNA_MODEL: 'gpt-x' }).models;
  assert.equal(custom[0], 'gpt-x');
  assert.ok(KNOWN_MODELS.every((m) => custom.includes(m)));
});

test('LUNA_LEVELS: a valid custom ladder is kept, its names are normalized', () => {
  const cfg = loadConfig({ LUNA_LEVELS: 'MEDIUM, High', LUNA_DEFAULT_EFFORT: 'high' });
  assert.deepEqual(cfg.ladder, ['medium', 'high']);
  assert.equal(cfg.defaultEffort, 'high');
});

test('LUNA_LEVELS must ascend without repeats', () => {
  assert.throws(() => loadConfig({ LUNA_LEVELS: 'high,medium' }), /LUNA_LEVELS must go from least to most effort without repeats/);
  assert.throws(() => loadConfig({ LUNA_LEVELS: 'medium,medium' }), /LUNA_LEVELS must go from least to most effort without repeats/);
});

test('LUNA_LEVELS rejects unknown efforts and an empty list', () => {
  assert.throws(() => loadConfig({ LUNA_LEVELS: 'low,turbo' }), /LUNA_LEVELS must be a comma list of/);
  assert.throws(() => loadConfig({ LUNA_LEVELS: ' , ' }), /LUNA_LEVELS must be a comma list of/);
});

test('LUNA_DEFAULT_EFFORT must be an effort on the ladder', () => {
  assert.throws(() => loadConfig({ LUNA_DEFAULT_EFFORT: 'turbo' }), /LUNA_DEFAULT_EFFORT must be one of LUNA_LEVELS/);
  assert.throws(() => loadConfig({ LUNA_DEFAULT_EFFORT: 'minimal' }), /LUNA_DEFAULT_EFFORT must be one of LUNA_LEVELS/);
  assert.throws(() => loadConfig({ LUNA_LEVELS: 'medium,high', LUNA_DEFAULT_EFFORT: 'xhigh' }), /LUNA_DEFAULT_EFFORT must be one of LUNA_LEVELS \(medium,high\)/);
});

test('LUNA_MODE accepts auto|luna|heuristic|llm|off and nothing else', () => {
  for (const mode of ['auto', 'luna', 'heuristic', 'llm', 'off']) assert.equal(loadConfig({ LUNA_MODE: mode }).mode, mode);
  assert.throws(() => loadConfig({ LUNA_MODE: 'gpt' }), /LUNA_MODE must be auto\|luna\|heuristic\|llm\|off/);
});

test('LUNA_AUTO_FALLBACK accepts heuristic|llm; auto needs a ladder Luna can choose from', () => {
  assert.equal(loadConfig({ LUNA_AUTO_FALLBACK: 'LLM' }).autoFallback, 'llm');
  assert.throws(() => loadConfig({ LUNA_AUTO_FALLBACK: 'off' }), /LUNA_AUTO_FALLBACK must be heuristic\|llm/);
  assert.throws(() => loadConfig({ LUNA_LEVELS: 'medium', LUNA_DEFAULT_EFFORT: 'medium' }), /at least 2 efforts/);
  assert.equal(loadConfig({ LUNA_MODE: 'heuristic', LUNA_LEVELS: 'medium', LUNA_DEFAULT_EFFORT: 'medium' }).ladder.length, 1);
});

test('LUNA_CACHE accepts explicit|implicit|off and rejects anything else', () => {
  assert.equal(loadConfig({ LUNA_CACHE: 'OFF' }).cacheMode, 'off');
  assert.equal(loadConfig({ LUNA_CACHE: 'implicit' }).cacheMode, 'implicit');
  assert.throws(() => loadConfig({ LUNA_CACHE: 'sometimes' }), /LUNA_CACHE must be explicit\|implicit\|off/);
});

test('LUNA_DECISION_TIMEOUT_MS must be at least 1 ms', () => {
  assert.equal(loadConfig({ LUNA_DECISION_TIMEOUT_MS: '1' }).decisionTimeoutMs, 1);
  assert.throws(() => loadConfig({ LUNA_DECISION_TIMEOUT_MS: '0' }), /LUNA_DECISION_TIMEOUT_MS must be at least 1/);
  assert.throws(() => loadConfig({ LUNA_DECISION_TIMEOUT_MS: '-5' }), /LUNA_DECISION_TIMEOUT_MS must be a non-negative integer/);
  assert.throws(() => loadConfig({ LUNA_DECISION_TIMEOUT_MS: 'soon' }), /LUNA_DECISION_TIMEOUT_MS must be a non-negative integer/);
});

test('LUNA_EFFORT_QUANTILE and LUNA_MIN_CONFIDENCE must be probabilities 0..1', () => {
  assert.equal(loadConfig({ LUNA_EFFORT_QUANTILE: '1' }).effortQuantile, 1);
  assert.throws(() => loadConfig({ LUNA_EFFORT_QUANTILE: '2' }), /LUNA_EFFORT_QUANTILE must be 0\.\.1/);
  assert.throws(() => loadConfig({ LUNA_EFFORT_QUANTILE: '-0.1' }), /LUNA_EFFORT_QUANTILE must be 0\.\.1/);
  assert.throws(() => loadConfig({ LUNA_MIN_CONFIDENCE: 'high' }), /LUNA_MIN_CONFIDENCE must be 0\.\.1/);
});

test('LUNA_PORT overrides the port and LUNA_USE_CLIENT_KEY is an on|off switch', () => {
  assert.equal(loadConfig({ LUNA_PORT: '9100' }).port, 9100);
  assert.equal(loadConfig({}).useClientKey, true);
  assert.equal(loadConfig({ LUNA_USE_CLIENT_KEY: 'off' }).useClientKey, false);
  assert.throws(() => loadConfig({ LUNA_USE_CLIENT_KEY: 'maybe' }), /LUNA_USE_CLIENT_KEY must be on\|off/);
});

test('routing and judge reject efforts below medium', () => {
  for (const effort of ['none', 'minimal', 'low']) {
    assert.throws(() => loadConfig({ LUNA_LEVELS: `${effort},medium` }), /LUNA_LEVELS/);
    assert.throws(() => loadConfig({ LUNA_JUDGE_EFFORT: effort }), /LUNA_JUDGE_EFFORT/);
  }
  assert.equal(loadConfig({}).judgeEffort, 'medium');
});
