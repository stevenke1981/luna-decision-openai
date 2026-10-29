// Specialists from packs: the roles of an agent-team-workflow pack (config/registry.json) and
// the skills of a skill pack (*/SKILL.md). On a new turn Luna picks the specialist that should
// carry out the request (one `choice` question in the same Decisions call as the effort), and
// the proxy hands the agent that specialist's way of working for the whole turn.
// Several packs can be combined (software, games, video, music...), so one list holds them all.
// Packs are read as data only, from a .zip or an unpacked folder; nothing in them is executed
// or written to disk.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const REGISTRY = 'config/registry.json';
const PROFILES = 'config/profiles.json';
const SKILL_FILE = /(?:^|\/)SKILL\.md$/;
// The value Luna answers when no listed specialist fits (a question, chat, general work).
export const NO_ROLE = 'none';
const MAX_LIST = 5;
const MAX_ITEM = 80;
const MAX_DESCRIPTION = 160;
const MAX_SKILL_BODY = 1500;
// No pack file this reader needs comes near this once inflated; a larger one is refused.
const MAX_ENTRY_BYTES = 8 << 20;
// The end of central directory record: 22 bytes, then a comment of up to 65535.
const EOCD_SIZE = 22;
const EOCD_SEARCH = EOCD_SIZE + 0xffff;
// Between a pack and its set in LUNA_ROLE_PACK; Windows file names cannot hold it, and .env
// files do not read it as a comment.
const SET_MARK = '|';
// Name words too common to point at a skill on their own.
const GENERIC_WORDS = new Set(['skill', 'skills', 'agent', 'agents', 'pack', 'expert', 'playbook', 'engineering', 'selection', 'formats', 'and', 'the']);

// Request words that point at a team role when Luna cannot be asked. First match wins, so the
// more specific roles come first. Only roles in the active set are considered.
const ROLE_RULES = [
  ['debugging_engineer', /\b(?:debug|bug|crash|stack ?trace|regression|root cause|fix(?:es|ing)? (?:the |a )?(?:bug|error|failure))\b|除錯|錯誤|崩潰|當機|根因|修復|修 ?bug/i],
  ['e2e_engineer', /\b(?:e2e|end[- ]to[- ]end|playwright|cypress|selenium|browser tests?)\b|端到端/i],
  ['test_engineer', /\b(?:unit tests?|test coverage|write tests?|add tests?|pytest|jest|vitest|mocha)\b|測試|覆蓋率/i],
  ['ci_engineer', /\b(?:ci|github actions?|workflows?\.ya?ml|pipeline)\b|持續整合/i],
  ['build_engineer', /\b(?:build system|bundl(?:e|er|ing)|packag(?:e|ing)|installer|webpack|vite config|cmake|msbuild)\b|打包|建置/i],
  ['technical_writer', /\b(?:readme|docs?|documentation|changelog|tutorial|user guide)\b|文件|說明書|教學|手冊/i],
  ['database_engineer', /\b(?:sql|database|schema|migration|postgres|mysql|sqlite|database index(?:es)?)\b|資料庫|資料表|遷移/i],
  ['rust_engineer', /\b(?:rust|cargo|crate)\b|\.rs\b/i],
  ['python_engineer', /\b(?:python|pip|venv|django|flask|fastapi|pandas)\b|\.py\b/i],
  ['frontend_engineer', /\b(?:frontend|front-end|react|vue|svelte|angular|css|html|tailwind|component)\b|前端|網頁|頁面/i],
  ['ui_designer', /\b(?:visual design|design system|color palette|typography)\b|視覺設計|設計系統/i],
  ['ux_designer', /\b(?:ux|user flow|wireframe|usability)\b|互動設計|使用流程/i],
  ['backend_engineer', /\b(?:backend|back-end|api|endpoint|server|rest(?:ful)? api|graphql|auth(?:entication|orization)?)\b|後端|伺服器|介面/i],
  ['desktop_engineer', /\b(?:desktop|electron|tauri|wpf|winforms|gui)\b|桌面/i],
  ['integration_engineer', /\b(?:integration|mcp|webhook|third[- ]party|sdk)\b|整合/i],
];

// ---- zip (stored and deflated entries; enough for a pack zip) ----

// The end of central directory record: the last signature whose comment length reaches the
// end of the file exactly (a comment may itself hold the signature bytes).
function findEocd(buf) {
  for (let at = buf.length - EOCD_SIZE; at >= Math.max(0, buf.length - EOCD_SEARCH); at--) {
    if (buf.readUInt32LE(at) === 0x06054b50 && at + EOCD_SIZE + buf.readUInt16LE(at + 20) === buf.length) return at;
  }
  throw new Error('not a zip file (no end of central directory)');
}

function zipEntries(buf) {
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || at === 0xffffffff) throw new Error('zip64 archives are not supported; unpack the pack and name its folder');
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) throw new Error('broken zip central directory');
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    entries.set(name, { method, size, local });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function zipRead(buf, entry) {
  if (entry.local + 30 > buf.length || buf.readUInt32LE(entry.local) !== 0x04034b50) throw new Error('broken zip entry');
  const start = entry.local + 30 + buf.readUInt16LE(entry.local + 26) + buf.readUInt16LE(entry.local + 28);
  if (entry.size === 0xffffffff || start + entry.size > buf.length) throw new Error('broken or zip64 zip entry');
  const data = buf.subarray(start, start + entry.size);
  if (entry.method === 0) return data.toString('utf8');
  if (entry.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES }).toString('utf8');
  throw new Error(`unsupported zip compression method ${entry.method}`);
}

// The pack as a list of files (forward-slash relative names) and a reader.
function packReader(source) {
  if (fs.statSync(source).isDirectory()) {
    const names = fs.readdirSync(source, { recursive: true })
      .map((n) => String(n).split(path.sep).join('/'))
      .filter((n) => {
        try {
          return fs.statSync(path.join(source, n)).isFile();
        } catch {
          return false; // a dangling link
        }
      });
    return { names, read: (n) => fs.readFileSync(path.join(source, n), 'utf8') };
  }
  const buf = fs.readFileSync(source);
  const entries = zipEntries(buf);
  return { names: [...entries.keys()].filter((n) => !n.endsWith('/')), read: (n) => zipRead(buf, entries.get(n)) };
}

const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

function teamRoles(registryText) {
  const registry = JSON.parse(registryText);
  if (!Array.isArray(registry?.roles)) throw new Error(`${REGISTRY} has no roles list`);
  return registry.roles
    .filter((r) => r && typeof r.id === 'string' && /^[a-z0-9_]+$/.test(r.id) && r.id !== NO_ROLE)
    .map((r) => ({
      id: r.id,
      kind: 'role',
      title: String(r.title ?? r.id),
      mode: String(r.mode ?? ''),
      methods: String(r.methods ?? ''),
      steps: list(r.steps),
      outputs: list(r.outputs),
      exitCriteria: list(r.exit_criteria),
      native: typeof r.native_file === 'string' ? path.basename(r.native_file, '.toml') : null,
      body: '',
    }));
}

// The front matter fields this reader needs: name and description. A value may be plain or
// quoted, go on over indented lines, or be a block scalar (| or >); it is read as one line.
function frontMatter(raw) {
  const text = raw.replace(/^\uFEFF/, '');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!m) return null;
  const lines = m[1].split(/\r?\n/);
  const field = (key) => {
    const at = lines.findIndex((l) => l.startsWith(`${key}:`));
    if (at < 0) return '';
    const first = lines[at].slice(key.length + 1).trim();
    const more = [];
    for (let i = at + 1; i < lines.length && (/^\s/.test(lines[i]) || lines[i] === ''); i++) more.push(lines[i].trim());
    const value = (/^[|>][-+]?$/.test(first) ? more : [first, ...more]).filter(Boolean).join(' ');
    const quoted = value.match(/^(['"])([\s\S]*)\1$/);
    if (!quoted) return value;
    return quoted[1] === "'" ? quoted[2].replace(/''/g, "'") : quoted[2].replace(/\\"/g, '"');
  };
  return { name: field('name'), description: field('description'), body: text.slice(m[0].length).trim() };
}

function skillRoles(reader) {
  return reader.names.filter((n) => SKILL_FILE.test(n)).flatMap((n) => {
    const fm = frontMatter(reader.read(n));
    const id = fm?.name && /^[A-Za-z0-9_.-]+$/.test(fm.name) && fm.name !== NO_ROLE ? fm.name : null;
    if (!id) return [];
    return [{
      id, kind: 'skill', title: id, mode: 'skill', methods: fm.description, steps: [], outputs: [], exitCriteria: [], native: null,
      body: fm.body.length > MAX_SKILL_BODY ? `${fm.body.slice(0, MAX_SKILL_BODY)}…` : fm.body,
    }];
  });
}

/**
 * Reads one pack: an agent-team-workflow pack (its roles and profiles) or a skill pack (each
 * SKILL.md is one specialist).
 * @param {string} source a .zip of the pack or its folder
 * @returns {{roles:Array<{id:string, kind:'role'|'skill', title:string, mode:string, methods:string,
 *   steps:string[], outputs:string[], exitCriteria:string[], native:string|null, body:string}>,
 *   profiles:Record<string,string[]>}}
 */
export function loadRolePack(source) {
  const reader = packReader(source);
  const registry = reader.names.find((n) => n === REGISTRY || n.endsWith(`/${REGISTRY}`));
  if (registry) {
    const profilesName = registry.slice(0, -REGISTRY.length) + PROFILES;
    const profiles = reader.names.includes(profilesName) ? JSON.parse(reader.read(profilesName)) : {};
    return { roles: teamRoles(reader.read(registry)), profiles: profiles && typeof profiles === 'object' ? profiles : {} };
  }
  const skills = skillRoles(reader);
  if (skills.length === 0) throw new Error(`${source} is neither a team pack (${REGISTRY}) nor a skill pack (SKILL.md)`);
  return { roles: skills, profiles: {} };
}

/**
 * The specialists Luna chooses between from one pack. For a team pack, a profile name (lean,
 * product, full...) keeps that profile's implementers (mode author), or every role of it when
 * none is an implementer; `author` keeps every implementer. For a skill pack, every skill.
 * A comma list names specialists in either kind of pack.
 * @param {string} [set] when empty: the `product` profile if the pack has one, else `author`
 */
export function pickRoleSet(pack, set = '') {
  const byId = new Map(pack.roles.map((r) => [r.id, r]));
  const wanted = set || (pack.profiles.product ? 'product' : 'author');
  if (wanted === 'author') {
    const authors = pack.roles.filter((r) => r.mode === 'author');
    return authors.length > 0 ? authors : pack.roles;
  }
  if (Array.isArray(pack.profiles[wanted])) {
    const inProfile = pack.profiles[wanted].map((id) => byId.get(id)).filter(Boolean);
    const authors = inProfile.filter((r) => r.mode === 'author');
    const picked = authors.length > 0 ? authors : inProfile;
    if (picked.length === 0) throw new Error(`role profile "${wanted}" names no known role`);
    return picked;
  }
  const ids = wanted.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = ids.filter((id) => !byId.has(id));
  if (ids.length === 0 || unknown.length > 0) {
    const names = ['author', ...Object.keys(pack.profiles)].join(', ');
    throw new Error(`role set must be one of ${names} or a comma list of ids; unknown: ${unknown.join(', ') || wanted}`);
  }
  return ids.map((id) => byId.get(id));
}

// One LUNA_ROLE_PACK entry as its source and its own set ('' for none): `pack.zip|lean`.
function packEntry(entry) {
  const mark = entry.lastIndexOf(SET_MARK);
  return mark > 0 ? { source: entry.slice(0, mark).trim(), own: entry.slice(mark + 1).trim() } : { source: entry, own: '' };
}

/**
 * Loads every pack of LUNA_ROLE_PACK: sources separated by `;` (or new lines), each optionally
 * followed by `|set` (see pickRoleSet), which must fit that pack. `defaultSet` (LUNA_ROLE_SET)
 * applies to the rest: a profile name or `author` where a pack has it (that pack's default
 * otherwise), or a comma list of ids, which keeps those ids from whichever pack has them.
 * An id already taken, by an earlier pack or within one, is skipped, so the first one wins.
 * @returns {{roles:object[], packs:Array<{source:string, set:string, count:number}>}}
 */
export function loadRoles(spec, defaultSet = '') {
  const loaded = String(spec ?? '').split(/[;\r\n]+/).map((s) => s.trim()).filter(Boolean).map((entry) => {
    const { source, own } = packEntry(entry);
    try {
      return { source, own, pack: loadRolePack(source) };
    } catch (err) {
      throw new Error(`LUNA_ROLE_PACK ${source}: ${err.message}`);
    }
  });
  const shared = String(defaultSet ?? '').trim();
  const sharedIds = shared && shared !== 'author' && !loaded.some(({ pack }) => Array.isArray(pack.profiles[shared]))
    ? shared.split(',').map((s) => s.trim()).filter(Boolean)
    : null;
  const roles = [];
  const packs = [];
  const seen = new Set();
  for (const { source, own, pack } of loaded) {
    let set = own || shared;
    let picked;
    try {
      if (own) {
        picked = pickRoleSet(pack, own);
      } else if (sharedIds) {
        picked = pack.roles.filter((r) => sharedIds.includes(r.id));
      } else {
        try {
          picked = pickRoleSet(pack, set);
        } catch (err) {
          if (!set) throw err;
          set = '';
          picked = pickRoleSet(pack, set);
        }
      }
    } catch (err) {
      throw new Error(`LUNA_ROLE_PACK ${source}: ${err.message}`);
    }
    const fresh = picked.filter((r) => !seen.has(r.id) && seen.add(r.id));
    roles.push(...fresh);
    packs.push({ source, set: set || '(default)', count: fresh.length });
  }
  const missing = sharedIds?.filter((id) => !seen.has(id)) ?? [];
  if (missing.length > 0) throw new Error(`LUNA_ROLE_SET: no pack has ${missing.join(', ')}`);
  return { roles, packs };
}

function oneLine(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** The Decisions question that asks Luna which specialist should do a new request. */
export function roleQuestion(roles) {
  return {
    type: 'choice',
    name: 'role',
    instructions: 'Which specialist should carry out this new request? Pick "none" for a question, chat, '
      + 'or work that no listed specialist fits.',
    choices: [
      ...roles.map((r) => ({ value: r.id, description: oneLine(r.methods ? `${r.title}: ${r.methods}` : r.title, MAX_DESCRIPTION) })),
      { value: NO_ROLE, description: 'no specialist: a question, chat or general work' },
    ],
  };
}

/**
 * The specialist Luna chose, or null when it chose none, named an unknown one, or was not sure.
 * @returns {{id:string, confidence:number}|null}
 */
export function roleFromAnswer(answer, roles, minConfidence) {
  if (answer?.type !== 'choice' || typeof answer.choice !== 'string' || answer.choice === NO_ROLE) return null;
  if (!roles.some((r) => r.id === answer.choice)) return null;
  const p = answer.probabilities;
  const listed = Array.isArray(p) ? p.find((x) => x?.value === answer.choice)?.probability : p?.[answer.choice];
  const confidence = Number.isFinite(answer.confidence) ? answer.confidence : Number.isFinite(listed) ? listed : 1;
  return confidence >= minConfidence ? { id: answer.choice, confidence } : null;
}

// A skill matches when the request names at least two of the distinctive words of its name
// (or its only one): "storage-backup-migration" matches "plan a backup migration".
function skillMatch(role, text) {
  const words = role.id.toLowerCase().split(/[-_.]+/).filter((w) => w.length >= 3 && !GENERIC_WORDS.has(w));
  if (words.length === 0) return 0;
  const hits = words.filter((w) => new RegExp(`\\b${w}`, 'i').test(text)).length;
  return hits >= Math.min(2, words.length) ? hits : 0;
}

/** The specialist the request's words point at, among `roles`, or null. Team roles first. */
export function ruleRole(userText, roles) {
  const ids = new Set(roles.map((r) => r.id));
  const text = String(userText ?? '');
  for (const [id, pattern] of ROLE_RULES) if (ids.has(id) && pattern.test(text)) return id;
  let best = null;
  let bestHits = 0;
  for (const r of roles) {
    if (r.kind !== 'skill') continue;
    const hits = skillMatch(r, text);
    if (hits > bestHits) [best, bestHits] = [r.id, hits];
  }
  return best;
}

function bullets(items) {
  return items.slice(0, MAX_LIST).map((s) => `- ${s.slice(0, MAX_ITEM)}`).join('\n');
}

/**
 * The developer message that hands the agent a specialist for this turn.
 * @param {{delegate?:boolean}} [options] delegate: suggest the pack's native Codex subagent
 */
export function roleText(role, { delegate = false } = {}) {
  if (role.kind === 'skill') {
    return [
      `[luna] For this request, follow the \`${role.id}\` skill${role.methods ? ` (${oneLine(role.methods, MAX_DESCRIPTION)})` : ''}.`,
      ...(role.body ? ['Skill guide:', role.body] : []),
      'Follow the project\'s own instructions first; this skill only guides how you work.',
    ].join('\n');
  }
  const lines = [`[luna] For this request, work as the ${role.title} (\`${role.id}\`).`];
  if (role.methods) lines.push(`Method: ${role.methods}.`);
  if (role.steps.length) lines.push('Steps:', bullets(role.steps));
  if (role.outputs.length) lines.push(`Deliver: ${role.outputs.slice(0, MAX_LIST).join(', ')}.`);
  if (role.exitCriteria.length) lines.push('Done only when:', bullets(role.exitCriteria));
  if (delegate && role.native) {
    lines.push(`If a \`${role.native}\` subagent is available, you may delegate the implementation to it and review its result.`);
  }
  lines.push('Follow the project\'s own instructions first; this role only guides how you work.');
  return lines.join('\n');
}
