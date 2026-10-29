// Long-task help. GPT-6.1 Terra tends to end a turn before a long task is done: it
// summarizes, promises "next I will…", or asks whether to continue. These pure functions
// read the agent's plan, tell whether a finished generation ended the turn, judge whether
// that stop was premature (open plan, a promise, changed code left unchecked or failing), track
// progress across resumes, and write the reminder, resume and self-review messages.
// Pure: no I/O, and the request bodies and arrays they receive are never mutated.
import { textOf, isSyntheticUserText, innerCommand } from './trajectory.js';

const OPEN_STEP_CHARS = 120;
const LISTED_STEPS = 5;
const DONE_STATUSES = new Set(['completed', 'cancelled']);
// Responses carries Codex's update_plan only; Chat also carries the opencode todo tools.
const RESPONSES_PLAN_TOOLS = new Set(['update_plan']);
const CHAT_PLAN_TOOLS = new Set(['update_plan', 'todowrite', 'TodoWrite']);
// Output items the server finishes on its own. Anything else (client tools such as
// apply_patch_call or shell_call, and types not known yet) waits for the client, so the
// turn is not over. An allowlist fails safe when a new client tool type appears.
const SERVER_FINISHED_TYPES = new Set([
  'message', 'reasoning', 'web_search_call', 'file_search_call', 'image_generation_call', 'code_interpreter_call',
]);

// Only a request for something the user holds. Each pattern addresses the user directly
// (second person or an imperative), so a summary such as "fixed the login page" or
// "I need to refresh the token" does not count as needing the user.
const NEEDS_USER = [
  /\byour (?:api keys?|passwords?|credentials?|tokens?)\b/i,
  // Not after "I need to": then the agent is describing its own work, not asking the user.
  /(?<!\bI need to\b[^.?!\n]*)\b(?:provide|share|send|enter|give me)\b[^.?!\n]{0,40}\b(?:api keys?|passwords?|credentials?|tokens?)\b/i,
  /\bplease (?:provide|confirm|clarify)\b/i,
  /\bwhich (?:one|option) do you\b/i,
  /\b(?:log ?in|sign ?in) first\b|\byou need to (?:log ?in|sign ?in)\b/i,
  /請提供|請確認|(?:你|您)的(?:密碼|金鑰|帳號|token)|需要(?:你|您)|請先登入|哪一個|哪個選項/,
];
// A direct question: the sentence ends in a question mark (ASCII or full-width).
// "If you want me to, let me know" is not a question, so "want me to" alone is not listed.
// "Let me know if you need anything" closes finished work too, so it is not listed either.
const ASK_PERMISSION = [
  /\b(?:would you like me to|shall I|should I continue|do you want me to)\b[^.!?\n]*[?？]/i,
  /要我[^。！？\n]{0,40}嗎|需要我[^。！？\n]{0,40}嗎|是否要|是否繼續/,
];
// First-person statements of work still to do. Bare status words ("remaining steps", TODO,
// 下一步, 接下來) appear in finished work too, so they do not count on their own.
const PROMISE = [
  /\bnext,?\s+I(?:'ll|’ll| will)\b/i,
  /\bI will now\b/i,
  /\b(?:I|we) still need to\b/i,
  /\bI haven['’]t (?:yet\b|[^.!?\n]{0,60}\byet\b|(?:finished|done|completed|verified|tested)\b)/i,
  // Status phrases, the English counterpart of 尚未完成.
  /\bnot yet (?:done|implemented|finished)\b/i,
  /接下來我會|我還需要|我接著|尚未完成|還沒完成/,
  // "I will fix those and rerun the suite": a work verb promised in the first person. An
  // offer closes finished work, so it does not count, whether the condition comes first
  // ("if you want, I'll add docs") or last ("I'll add docs if you want", "...later").
  // The windows are bounded so a long run of text without punctuation stays linear.
  /(?<!\bif you (?:want|like|prefer|need)\b[^.!?\n]{0,80})\bI(?:'ll|’ll| will) (?:fix|update|add|run|rerun|implement|finish|write|change|refactor|test|verify|migrate|clean up)\b(?![^.!?\n]{0,80}\b(?:if (?:you|anything|needed|necessary)|later|below)\b)/i,
  /(?<!(?:(?:如果|若)(?:你|您)?(?:需要|想要|願意)|的話)[^。！？\n]{0,40})我(?:會|將)(?:再|接著|繼續)?(?:修|改|更新|補|跑|重跑|完成|實作|加上|測試|驗證)(?![^。！？\n]{0,40}的話)/,
];

// Files whose edits need no test run: prose and license text. Not .txt: requirements.txt and
// CMakeLists.txt are build inputs.
const DOC_FILE = /\.(?:md|mdx|markdown|rst|adoc)$|(?:^|[\\/])(?:LICENSE|CHANGELOG|AUTHORS|NOTICE)$/i;
// Commands that succeed without checking anything: version control, file moves, installs.
const NOT_A_CHECK = /^(?:git|mkdir|md|cp|copy|mv|move|rm|del|rmdir|touch|chmod|chown|ln|cd|New-Item|Copy-Item|Move-Item|Remove-Item|(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|ci)|pip3?\s+install|uv\s+(?:add|sync|pip)|poetry\s+(?:add|install)|cargo\s+add|go\s+get)\b/i;
// A closing that ends on a question waits for the user's answer.
const ENDS_ON_QUESTION = /[?？]\s*[)\]*_`"'」』]*\s*$/;
const FAILED_COMMAND_CHARS = 160;
// Stop scores of the verification rules: both clear the default threshold (0.6), and both
// stay below an open plan (0.9) and a permission question or promise (0.75).
const VERIFY_FAILING = 0.7;
const VERIFY_MISSING = 0.65;

const NUDGE_FOOTER ='Keep working through every remaining step and verify the result before you end your turn. '
  + 'Do not stop to summarize or to ask whether to continue unless you truly need something only the user can provide.';
const CONTINUE_FOOTER = 'Continue now: do the remaining work with your tools, then verify. '
  + 'Only stop to ask if you need information only the user has.';
const VERIFY_LINE = 'Verify your changes now: run the project\'s tests, build or linter (or run the program). '
  + 'If anything fails, find the root cause, fix it and run the check again until it passes.';
const STALL_LINE = 'You stopped again without making progress. Take the next concrete step with a tool now; '
  + 'if you are truly blocked, say exactly what you need from the user.';
const REVIEW_LINES = [
  'Before you finish, review your own work:',
  '1. Re-read the original request and check that every part of it is done.',
  '2. Inspect your changes (for example `git diff`) for bugs, missed edge cases, broken error handling and leftover debug code.',
  '3. Check that tests cover the change, then run the tests, build or linter.',
  'Fix every problem you find and verify again. If you find nothing to fix, end your turn with a short summary that says the self-review found no issues.',
];

function itemsOf(body) {
  if (Array.isArray(body?.input)) return body.input;
  if (Array.isArray(body?.messages)) return body.messages;
  return [];
}

// Responses user messages carry type 'message'; Chat messages have no type at all.
function isRealUser(item) {
  return item?.role === 'user'
    && (item.type === undefined || item.type === 'message')
    && !isSyntheticUserText(textOf(item.content));
}

/** Raw `arguments` of every plan call in one item (Responses or Chat), in order. */
function planCallsOf(item) {
  if (item?.type === 'function_call') {
    return RESPONSES_PLAN_TOOLS.has(item.name) ? [item.arguments] : [];
  }
  if (item?.role === 'assistant' && Array.isArray(item.tool_calls)) {
    return item.tool_calls
      .filter((tc) => CHAT_PLAN_TOOLS.has(tc?.function?.name))
      .map((tc) => tc.function.arguments);
  }
  return [];
}

function parsePlanArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// Codex uses `plan` with `step`; the opencode todo tools use `todos` with `content`.
function entriesOf(args) {
  const list = Array.isArray(args.plan) ? args.plan : Array.isArray(args.todos) ? args.todos : null;
  if (!list) return null;
  return list
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({ text: textOf(entry.step ?? entry.content).trim(), done: DONE_STATUSES.has(entry.status) }));
}

function summarize(entries) {
  return {
    total: entries.length,
    done: entries.filter((e) => e.done).length,
    open: entries.filter((e) => !e.done).map((e) => e.text.slice(0, OPEN_STEP_CHARS)),
  };
}

/**
 * The agent's latest plan in the current turn (after the latest real user message):
 * Codex `update_plan` ({plan:[{step,status}]}) or opencode-style `todowrite`/`TodoWrite`
 * ({todos:[{content,status}]}), from a Responses `input` or a Chat `messages` array.
 * @param {object} body request body
 * @returns {{total:number, done:number, open:string[]}|null} null when the turn has no plan
 */
export function turnPlan(body) {
  const items = itemsOf(body);
  const start = items.findLastIndex(isRealUser);
  for (let i = items.length - 1; i > start; i--) {
    const calls = planCallsOf(items[i]);
    if (calls.length === 0) continue;
    // Only the last plan call counts; if it is unreadable the plan is unknown, not the earlier one.
    const args = parsePlanArgs(calls.at(-1));
    const entries = args && entriesOf(args);
    return entries ? summarize(entries) : null;
  }
  return null;
}

/**
 * Whether a finished Responses generation ended the turn, and its visible text.
 * @param {object} response the `response` of a `response.completed` event (has `output`)
 * @returns {{ended:boolean, text:string}} ended: every output item is one the server finishes
 *   on its own (an empty output counts as ended)
 */
export function finalOutput(response) {
  const output = Array.isArray(response?.output) ? response.output : [];
  const ended = output.every((item) => SERVER_FINISHED_TYPES.has(item?.type));
  const text = output
    .filter((item) => item?.type === 'message' && Array.isArray(item.content))
    .flatMap((item) => item.content)
    .filter((part) => part?.type === 'output_text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
  return { ended, text };
}

function matchesAny(patterns, text) {
  return patterns.some((pattern) => pattern.test(text));
}

function permissionReasons(text) {
  const reasons = [];
  if (matchesAny(ASK_PERMISSION, text)) reasons.push('asks permission to continue');
  if (matchesAny(PROMISE, text)) reasons.push('promises more work');
  return reasons;
}

const isDocsEdit = (step) => step.files?.length > 0 && step.files.every((f) => DOC_FILE.test(f));
// An edit that changed code: a rejected patch changed nothing, a prose edit needs no check.
const isCodeEdit = (step) => step.kind === 'edit' && step.failed !== true && !isDocsEdit(step);
// A passing step that checked something: a recognized test or build, or another command that
// is not version control, a file move or an install.
const isCheck = (step) => step.failed === false
  && (step.kind === 'verify' || (step.kind === 'exec' && !NOT_A_CHECK.test(innerCommand(String(step.command ?? '')))));

/**
 * Whether the closing text ends by asking the user something (its last line ends on a question
 * mark). Such a stop waits for an answer, so it gets no self-review round.
 */
export function asksUser(finalText) {
  const lines = String(finalText ?? '').trim().split(/\r?\n/).filter((l) => l.trim());
  return lines.length > 0 && ENDS_ON_QUESTION.test(lines.at(-1));
}

/**
 * Whether the code the turn changed was checked after its last change.
 * A successful command after the last edit counts as a check, not only a recognized test
 * runner, so a project without tests is not asked to verify forever; version control, file
 * moves and installs do not count.
 * @param {Array<{kind:string, command:string, failed:boolean|null, files?:string[]}>} steps
 * @returns {'none'|'verified'|'failing'|'unverified'} none: no code edit (prose-only edits count as none)
 */
export function verification(steps) {
  const last = steps.findLastIndex(isCodeEdit);
  if (last < 0) return 'none';
  const after = steps.slice(last + 1);
  const lastVerify = after.findLast((s) => s.kind === 'verify' && s.failed != null);
  if (lastVerify?.failed) return 'failing';
  return after.some(isCheck) ? 'verified' : 'unverified';
}

/**
 * How far the turn has got: a mark that changes only with real progress (a code edit that
 * applied, a plan step done, the code becoming checked or passing), and the number of code
 * edits. Rerunning a passing test or a git command does not move it. Two resumes with the
 * same mark mean the agent stopped again without moving.
 * @returns {{mark:string, edits:number}} edits: code edits (prose edits and rejected patches excluded)
 */
export function progressOf(turn, plan) {
  const steps = turn?.steps ?? [];
  const edits = steps.filter(isCodeEdit).length;
  const docs = steps.filter((s) => s.kind === 'edit' && s.failed !== true).length - edits;
  return { mark: `${edits}/${docs}/${plan?.done ?? 0}/${verification(steps)}`, edits };
}

/**
 * Heuristic: how likely the agent stopped before the task was done although it could go on alone.
 * @param {{userText:string, steps:Array<{kind:string, command:string, failed:boolean|null, files?:string[]}>}} turn
 * @param {{total:number, done:number, open:string[]}|null} plan
 * @param {string} finalText the text of the generation that ended the turn
 * @param {{verify?:boolean}} [options] verify: changed code that was not checked, or whose
 *   tests still fail, counts as unfinished (default true)
 * @returns {{unfinished:number, reasons:string[], needsUser?:true}} unfinished: 0..1; needsUser
 *   when the agent asks for something only the user has
 */
export function assessStop(turn, plan, finalText, { verify = true } = {}) {
  const text = String(finalText ?? '');
  const steps = turn?.steps ?? [];
  // Rules run in order; the first match decides.
  if (steps.length === 0 && plan == null) return { unfinished: 0, reasons: ['no work started'] };
  // Asking for the user's input is a legitimate stop, even with open steps.
  if (matchesAny(NEEDS_USER, text)) return { unfinished: 0.1, reasons: ['needs the user'], needsUser: true };
  if (plan?.open?.length > 0) return { unfinished: 0.9, reasons: [`plan ${plan.done}/${plan.total} done`] };
  const reasons = permissionReasons(text);
  if (reasons.length > 0) return { unfinished: 0.75, reasons };
  if (verify) {
    const checked = verification(steps);
    if (checked === 'failing') return { unfinished: VERIFY_FAILING, reasons: ['tests or build still fail after the last edit'] };
    if (checked === 'unverified') return { unfinished: VERIFY_MISSING, reasons: ['changed code without verifying it'] };
  }
  // Below the default threshold on purpose: a failed last step is a weaker signal.
  if (steps.at(-1)?.failed === true) return { unfinished: 0.5, reasons: ['ended on a failing step'] };
  return { unfinished: 0.1, reasons: ['looks done'] };
}

function openStepLines(open) {
  const lines = open.slice(0, LISTED_STEPS).map((text) => `- ${text.slice(0, OPEN_STEP_CHARS)}`);
  const more = open.length - lines.length;
  if (more > 0) lines.push(`- ...and ${more} more`);
  return lines.join('\n');
}

/** Reminder appended before a generation while the plan has open steps. */
export function nudgeText(plan) {
  const open = plan?.open ?? [];
  const head = `[luna] ${plan?.done ?? 0} of ${plan?.total ?? 0} plan steps done.`;
  const lines = open.length > 0 ? [`${head} Open steps:`, openStepLines(open)] : [head];
  return [...lines, NUDGE_FOOTER].join('\n');
}

function oneLine(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Instruction that resumes a turn the agent ended too early.
 * @param {{total:number, done:number, open:string[]}|null} plan
 * @param {string[]} reasons why the stop looked premature
 * @param {{steps?:Array<{kind:string, command:string, failed:boolean|null}>, stalls?:number, verify?:boolean}} [context]
 *   steps: the turn's steps (a failing last step is quoted, an unchecked edit asks for a check
 *   unless verify is false); stalls: resumes in a row without progress before this one
 */
export function continueText(plan, reasons, { steps = [], stalls = 0, verify = true } = {}) {
  const why = reasons?.length ? reasons.join('; ') : 'work remains';
  const lines = [`[luna] You ended your turn but the task is not finished (${why}).`];
  if (plan) {
    lines.push(`Plan: ${plan.done} of ${plan.total} steps done.`);
    if (plan.open.length > 0) lines.push('Open steps:', openStepLines(plan.open));
  }
  const last = steps.at(-1);
  if (last?.failed === true) {
    lines.push(`The last step failed: \`${oneLine(last.command, FAILED_COMMAND_CHARS)}\`. `
      + 'Find the root cause before you try again; do not repeat the same failing command unchanged.');
  }
  const checked = verify ? verification(steps) : 'none';
  if (checked === 'unverified' || checked === 'failing') lines.push(VERIFY_LINE);
  if (stalls > 0) lines.push(STALL_LINE);
  lines.push(CONTINUE_FOOTER);
  return lines.join('\n');
}

/**
 * The short reminder repeated before the later generations of a resumed turn, so the resume
 * instruction outlives the one generation it was sent with.
 * @param {'resume'|'review'} kind
 */
export function focusText(kind) {
  return kind === 'review'
    ? '[luna] You are in a self-review round: finish checking your changes against the request, fix what you find, verify, then end with a short summary.'
    : '[luna] You were resumed because the task was not finished. Keep going until it is done and verified; do not stop to summarize or ask whether to continue.';
}

/**
 * Instruction for a self-review round: the agent said it was done after changing code, so it
 * re-reads the request and its own changes, fixes what it finds and verifies again.
 * @param {number} round 1-based review round
 * @param {number} rounds review rounds allowed per turn
 */
export function reviewText(round, rounds) {
  const head = rounds > 1 ? `[luna] Self-review ${round} of ${rounds}.` : '[luna] Self-review.';
  return [`${head} ${REVIEW_LINES[0]}`, ...REVIEW_LINES.slice(1)].join('\n');
}
