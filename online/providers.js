'use strict';
/*
 * providers.js: the Dungeon Master brain (LLM) and voice providers for AI-DnD Online.
 * Node >= 18, built-ins only (global fetch). Keys stay on the server and are never logged.
 *
 *   createDM(env)                 -> null | { name: 'anthropic'|'gemini', model, complete({ system, user, schema, signal }) }
 *   createVoice(env, { dataDir }) -> null | { name: 'elevenlabs'|'gemini', model, speak({ text, voice, lang }), sfx(name), chars }
 *
 * Errors carry .code: 'timeout' | 'rate_limited' | 'refused' | 'bad_json' | 'auth' | 'upstream'
 * (voice errors may also use 'quota' and 'bad_request').
 *
 * Upstream overrides, for tests only: AIDND_ANTHROPIC_URL, AIDND_GEMINI_URL, AIDND_ELEVENLABS_URL
 * (each is a base such as http://127.0.0.1:4010). ANTHROPIC_BASE_URL is deliberately never read.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ARCHETYPES = ['narrator', 'gruff', 'sage', 'young', 'sinister', 'noble', 'cheerful', 'creature'];
const MAX_TTS_CHARS = 1200;

/* ------------------------------------------------------------------ shared */

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const trimSlash = (s) => String(s).replace(/\/+$/, '');
const lower = (v) => String(v == null ? '' : v).trim().toLowerCase();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function num(v, dflt, min, max) {
  const n = Number(v);
  if (v == null || v === '' || !Number.isFinite(n)) return dflt;
  return Math.min(max == null ? n : max, Math.max(min == null ? n : min, n));
}

/** Returns (code, message, extra) => Error with the key values removed from the message. */
function errorFactory(provider, secrets) {
  const list = secrets.filter((s) => typeof s === 'string' && s.length >= 6);
  const clean = (text) => {
    let out = String(text);
    for (const s of list) out = out.split(s).join('[redacted]');
    return out;
  };
  const make = (code, message, extra) => {
    const e = new Error(clean(`${provider}: ${message}`));
    e.name = 'ProviderError';
    e.code = code;
    e.provider = provider;
    e.retryable = false;
    return Object.assign(e, extra);
  };
  make.clean = clean;
  return make;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new Error('aborted'));
    const onAbort = () => { clearTimeout(t); reject(new Error('aborted')); };
    const t = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** One time budget for a whole call (both attempts and the back-off), merged with the caller's signal. */
function makeDeadline(timeoutMs, outer) {
  const ctl = new AbortController();
  const started = Date.now();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
  const onAbort = () => ctl.abort();
  if (outer) {
    if (outer.aborted) ctl.abort();
    else outer.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: ctl.signal,
    remaining: () => timeoutMs - (Date.now() - started),
    timedOut: () => timedOut,
    done() { clearTimeout(timer); if (outer) outer.removeEventListener('abort', onAbort); },
  };
}

function retryAfterMs(res) {
  const raw = res.headers.get('retry-after');
  const secs = raw == null || raw === '' ? NaN : Number(raw);
  return Number.isFinite(secs) && secs >= 0 ? Math.ceil(secs * 1000) : undefined;
}

const netReason = (e) => (e && e.cause && (e.cause.code || e.cause.message)) || (e && e.message) || String(e);

/**
 * Runs attempt(signal) with one retry for errors marked retryable. The time budget covers
 * everything, and a timeout is never retried (it would double the wait at the table).
 */
async function withOneRetry(E, timeoutMs, outerSignal, attempt) {
  const dl = makeDeadline(timeoutMs, outerSignal);
  const classify = (err) => {
    if (err && err.name === 'ProviderError') return err;
    if (dl.signal.aborted) {
      return dl.timedOut()
        ? E('timeout', `no answer within ${timeoutMs} ms`)
        : E('upstream', 'request aborted by the caller', { aborted: true });
    }
    return E('upstream', `network error: ${netReason(err)}`, { retryable: true });
  };
  try {
    for (let tries = 0; ; tries++) {
      try {
        return await attempt(dl.signal);
      } catch (raw) {
        const err = classify(raw);
        if (!err.retryable || tries >= 1) throw err;
        const wait = err.retryAfterMs != null ? Math.min(err.retryAfterMs, 10000) : 400 + Math.floor(Math.random() * 800);
        if (wait + 1500 > dl.remaining()) throw err;      // no time left for a useful retry
        try { await sleep(wait, dl.signal); } catch (e) { throw classify(e); }
      }
    }
  } finally {
    dl.done();
  }
}

async function postJson(url, headers, body, signal) {
  const res = await fetch(url, {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, headers),
    body: JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (_) { /* an HTML error page from a proxy, for example */ }
  return { res, text, json };
}

/** Structured outputs make this a formality, but tolerate a code fence or stray prose around the object. */
function extractObject(text) {
  if (typeof text !== 'string') return undefined;
  const s = (text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text).trim();
  const tryParse = (t) => { try { return JSON.parse(t); } catch (_) { return undefined; } };
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  let v = tryParse(s);
  if (isObj(v)) return v;
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && isObj(v = tryParse(fence[1].trim()))) return v;
  let from = 0;
  for (let n = 0; n < 8; n++) {                           // scan balanced {...} candidates, string-aware
    const start = s.indexOf('{', from);
    if (start < 0) break;
    let depth = 0, inString = false, escaped = false, end = -1;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) { end = i; break; }
    }
    if (end < 0) break;                                   // unbalanced: truncated output
    if (isObj(v = tryParse(s.slice(start, end + 1)))) return v;
    from = start + 1;
  }
  return undefined;
}

/* ------------------------------------------------------------------ Anthropic (Dungeon Master) */

const ANTHROPIC_VERSION = '2026-10-21';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
// Models with server-side refusal fallback. Claude Haiku 5.5 has none.
const HAS_SERVER_FALLBACK = /^claude-(fable-5-[12]|mythos-5-[12]|opus-5(-5)?|sonnet-5-5)$/;
const NO_EFFORT = /^claude-(haiku|sonnet)-4-5/;            // these two reject output_config.effort

// Structured outputs compile the schema into a grammar and answer 400 to keywords the grammar
// cannot express. The contract's DM schema already avoids them; this is a safety net.
const STRIPPED = new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minLength', 'maxLength', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties']);

function toAnthropicSchema(node) {
  if (Array.isArray(node)) return node.map(toAnthropicSchema);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (STRIPPED.has(key)) continue;
    if (key === 'minItems') out.minItems = value > 1 ? 1 : value;
    else if (key === 'properties' || key === '$defs' || key === 'definitions') {
      out[key] = {};
      for (const [name, sub] of Object.entries(value || {})) out[key][name] = toAnthropicSchema(sub);
    } else if (key === 'items' || key === 'anyOf' || key === 'allOf') out[key] = toAnthropicSchema(value);
    else out[key] = value;
  }
  const types = Array.isArray(out.type) ? out.type : [out.type];
  if (types.includes('object') || out.properties) out.additionalProperties = false;
  return out;
}

function anthropicDM(env) {
  const key = env.ANTHROPIC_API_KEY;
  const model = String(env.ANTHROPIC_MODEL || 'claude-opus-5-5').trim();
  const base = trimSlash(env.AIDND_ANTHROPIC_URL || 'https://api.anthropic.com');
  const url = /\/v1\/messages$/.test(base) ? base : `${base}/v1/messages`;
  const effort = lower(env.DM_EFFORT) || 'low';
  const timeoutMs = num(env.DM_TIMEOUT_MS, 45000, 50, 600000);
  const E = errorFactory('anthropic', [key]);
  let fallbackUsable = HAS_SERVER_FALLBACK.test(model);   // flips off if the org cannot use the beta

  function httpError(res, text, json) {
    const err = (json && json.error) || {};
    const status = res.status;
    const message = `HTTP ${status} ${err.type || ''}: ${err.message || String(text).slice(0, 200)}`;
    const extra = { status, type: err.type };
    const retry = Object.assign({ retryable: true, retryAfterMs: retryAfterMs(res) }, extra);
    if (status === 429) {
      // A monthly spend-cap 429 keeps failing; do not retry it.
      const spendCap = err.details && err.details.error_code === 'enforced_spend_limit_reached';
      return E('rate_limited', message, spendCap ? extra : retry);
    }
    if (status === 401 || status === 403) return E('auth', message, extra);
    if (status === 408 || status === 409 || status >= 500) return E('upstream', message, retry);   // 529 = overloaded
    return E('upstream', message, extra);                 // 400, 402, 404, 413: never retried
  }

  function complete(args) {
    const a = args || {};
    const body = {
      model,
      max_tokens: 16000,                                  // backstop only; thinking tokens count against it
      messages: [{ role: 'user', content: String(a.user == null || a.user === '' ? '(Continue.)' : a.user) }],
      output_config: {},
      // No temperature / top_p / top_k (HTTP 400 on this API version), no `thinking` field
      // (adaptive is the default), no assistant prefill, no forced tool_choice.
    };
    // The static rules go in one cacheable block; everything per-turn belongs in `user`.
    if (a.system) body.system = [{ type: 'text', text: String(a.system), cache_control: { type: 'ephemeral' } }];
    if (a.schema) body.output_config.format = { type: 'json_schema', schema: toAnthropicSchema(a.schema) };
    if (!NO_EFFORT.test(model)) body.output_config.effort = effort;   // the latency dial; the API default is higher

    return withOneRetry(E, timeoutMs, a.signal, async (signal) => {
      const withFallback = fallbackUsable;
      const headers = { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION };
      if (withFallback) headers['anthropic-beta'] = FALLBACK_BETA;
      const { res, text, json } = await postJson(url, headers, withFallback ? Object.assign({ fallbacks: 'default' }, body) : body, signal);
      if (!res.ok) {
        const err = httpError(res, text, json);
        if (withFallback && res.status === 400 && /anthropic-beta|fallbacks|server-side-fallback/i.test(err.message)) {
          fallbackUsable = false;                         // beta not available here: go on without it
          err.retryable = true;
          err.retryAfterMs = 0;
        }
        throw err;
      }
      if (!json || !Array.isArray(json.content)) throw E('bad_json', 'malformed response envelope');
      // A safety decline is HTTP 200 with stop_reason "refusal": read stop_reason before content.
      if (json.stop_reason === 'refusal') {
        const category = (json.stop_details && json.stop_details.category) || 'uncategorised';
        throw E('refused', `the model declined this turn (${category})`, { category });
      }
      if (json.stop_reason === 'max_tokens') throw E('bad_json', 'reply was cut off at max_tokens', { truncated: true });
      // Select blocks by type, never by position: content[0] is often a thinking block.
      const out = json.content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
      const obj = extractObject(out);
      if (!obj) throw E('bad_json', `reply was not a JSON object: ${out.slice(0, 120)}`);
      return obj;
    });
  }

  return { name: 'anthropic', model, complete };
}

/* ------------------------------------------------------------------ Gemini (Dungeon Master) */

const GEMINI_HOST = 'https://generativelanguage.googleapis.com';

function geminiThinking(model) {
  if (/^gemini-2\.5-pro/.test(model)) return { thinkingBudget: 128 };   // minimum; cannot be turned off
  if (/^gemini-2\.5/.test(model)) return { thinkingBudget: 0 };
  return { thinkingLevel: 'low' };                        // Gemini 3.x and 4: levels only
}

function geminiHttpError(E, res, text, json) {
  const err = (json && json.error) || {};
  const status = res.status;
  const message = `HTTP ${status} ${err.status || ''}: ${err.message || String(text).slice(0, 200)}`;
  const extra = { status, type: err.status };
  let wait = retryAfterMs(res);
  for (const d of Array.isArray(err.details) ? err.details : []) {      // google.rpc.RetryInfo
    const m = d && typeof d.retryDelay === 'string' && d.retryDelay.match(/^([\d.]+)s$/);
    if (m) wait = Math.ceil(Number(m[1]) * 1000);
  }
  const retry = Object.assign({ retryable: true, retryAfterMs: wait }, extra);
  if (status === 429) return E('rate_limited', message, retry);
  if (status === 401 || status === 403) return E('auth', message, extra);
  if (status === 408 || status >= 500) return E('upstream', message, retry);
  return E('upstream', message, extra);                   // 400, 402, 404: never retried
}

function geminiDM(env) {
  const key = env.GEMINI_API_KEY;
  const model = String(env.GEMINI_MODEL || 'gemini-3.8-flash').trim();
  const url = `${trimSlash(env.AIDND_GEMINI_URL || GEMINI_HOST)}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const timeoutMs = num(env.DM_TIMEOUT_MS, 45000, 50, 600000);
  const E = errorFactory('gemini', [key]);
  let useResponseFormat = false;                          // flips on if the server rejects responseJsonSchema

  function complete(args) {
    const a = args || {};
    return withOneRetry(E, timeoutMs, a.signal, async (signal) => {
      const usedResponseFormat = useResponseFormat;
      const generationConfig = {
        maxOutputTokens: 8192,                            // includes thinking tokens
        thinkingConfig: geminiThinking(model),
        // No temperature / topP / topK: ignored with deprecation warnings on current models.
      };
      if (a.schema && usedResponseFormat) {
        generationConfig.responseFormat = { text: { mimeType: 'APPLICATION_JSON', schema: a.schema } };
      } else {
        generationConfig.responseMimeType = 'application/json';
        if (a.schema) generationConfig.responseJsonSchema = a.schema;
      }
      const body = {
        contents: [{ role: 'user', parts: [{ text: String(a.user == null || a.user === '' ? '(Continue.)' : a.user) }] }],
        generationConfig,
      };
      if (a.system) body.systemInstruction = { parts: [{ text: String(a.system) }] };
      const { res, text, json } = await postJson(url, { 'x-goog-api-key': key }, body, signal);   // key in a header, never in the URL
      if (!res.ok) {
        const err = geminiHttpError(E, res, text, json);
        if (!usedResponseFormat && res.status === 400 &&
            /Unknown name|Cannot find field|response_?json_?schema|response_?mime_?type/i.test(err.message)) {
          useResponseFormat = true;                       // retry once with the newer spelling
          err.retryable = true;
          err.retryAfterMs = 0;
        }
        throw err;
      }
      if (!json || typeof json !== 'object') throw E('bad_json', 'malformed response envelope');
      const cand = Array.isArray(json.candidates) ? json.candidates[0] : undefined;
      if (!cand) {                                        // the prompt itself was blocked: HTTP 200, no candidates
        const why = (json.promptFeedback && json.promptFeedback.blockReason) || 'no candidates';
        throw E('refused', `prompt blocked (${why})`, { category: why });
      }
      const reason = cand.finishReason;
      if (reason === 'MAX_TOKENS') throw E('bad_json', 'reply was cut off at maxOutputTokens', { truncated: true });
      if (reason && reason !== 'STOP') throw E('refused', `generation stopped (${reason})`, { category: reason });
      const parts = (cand.content && cand.content.parts) || [];
      const out = parts.filter((p) => p && !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
      const obj = extractObject(out);
      if (!obj) throw E('bad_json', `reply was not a JSON object: ${out.slice(0, 120)}`);
      return obj;
    });
  }

  return { name: 'gemini', model, complete };
}

/**
 * DM_PROVIDER wins when set ('scripted' -> null); otherwise Anthropic when its key is set,
 * else Gemini when its key is set, else null (the scripted brain runs the game).
 */
function createDM(env) {
  const e = env || {};
  const pick = lower(e.DM_PROVIDER);
  if (pick === 'scripted' || pick === 'none' || pick === 'off') return null;
  let name = pick === 'anthropic' || pick === 'claude' ? 'anthropic' : pick === 'gemini' || pick === 'google' ? 'gemini' : '';
  if (!name) name = e.ANTHROPIC_API_KEY ? 'anthropic' : e.GEMINI_API_KEY ? 'gemini' : '';
  if (name === 'anthropic') return e.ANTHROPIC_API_KEY ? anthropicDM(e) : null;
  if (name === 'gemini') return e.GEMINI_API_KEY ? geminiDM(e) : null;
  return null;
}

/* ------------------------------------------------------------------ audio cache */

/** Memory LRU (bounded by bytes) over an optional directory. Disk errors are swallowed. */
function createAudioCache(dir, ext, maxBytes) {
  const mem = new Map();                                  // key -> Buffer, least recently used first
  let bytes = 0;
  let diskOk = !!dir;
  let made = false;
  const file = (key) => path.join(dir, `${key}.${ext}`);
  function ensureDir() {
    if (!diskOk || made) return diskOk;
    try { fs.mkdirSync(dir, { recursive: true }); made = true; } catch (_) { diskOk = false; }
    return diskOk;
  }
  function remember(key, buf) {
    if (mem.has(key)) { bytes -= mem.get(key).length; mem.delete(key); }
    mem.set(key, buf);
    bytes += buf.length;
    for (const [k, v] of mem) {
      if (bytes <= maxBytes || k === key) break;
      mem.delete(k);
      bytes -= v.length;
    }
  }
  async function get(key) {
    if (mem.has(key)) { const buf = mem.get(key); mem.delete(key); mem.set(key, buf); return buf; }
    if (!diskOk) return null;
    try {
      const buf = await fs.promises.readFile(file(key));
      if (!buf.length) return null;
      remember(key, buf);
      return buf;
    } catch (_) { return null; }
  }
  async function put(key, buf) {
    remember(key, buf);
    if (!ensureDir()) return;
    const tmp = `${file(key)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      await fs.promises.writeFile(tmp, buf);
      await fs.promises.rename(tmp, file(key));
    } catch (_) { fs.promises.unlink(tmp).catch(() => {}); }
  }
  return { get, put, stats: () => ({ entries: mem.size, bytes }) };
}

/** Callers that ask for the same key while it is being produced share one promise. */
function singleFlight(map, key, produce) {
  if (map.has(key)) return map.get(key);
  const p = Promise.resolve().then(produce);
  map.set(key, p);
  const clear = () => { if (map.get(key) === p) map.delete(key); };
  p.then(clear, clear);
  return p;
}

/** At most `max` jobs in flight, first come first served. */
function createLimiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    while (active < max && queue.length) { active++; queue.shift()(); }
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push(() => Promise.resolve().then(fn).then(resolve, reject).then(() => { active--; next(); }));
    next();
  });
}

/** Whitespace-normalized, markdown-free text of at most MAX_TTS_CHARS, cut at a sentence or word end. */
function speechText(raw) {
  let s = String(raw == null ? '' : raw).replace(/[*_`#~]+/g, '').replace(/\s+/g, ' ').trim();
  if (s.length <= MAX_TTS_CHARS) return s;
  s = s.slice(0, MAX_TTS_CHARS);
  const stop = Math.max(s.lastIndexOf('. '), s.lastIndexOf('! '), s.lastIndexOf('? '));
  if (stop > MAX_TTS_CHARS * 0.6) return s.slice(0, stop + 1);
  const space = s.lastIndexOf(' ');
  return (space > MAX_TTS_CHARS * 0.6 ? s.slice(0, space) : s).trim();
}

const archetypeOf = (voice) => { const k = lower(voice); return ARCHETYPES.includes(k) ? k : 'narrator'; };

/** One POST that returns audio bytes, with a per-attempt timeout and one retry on 429 / 5xx / network errors. */
async function postForAudio(E, url, headers, body, timeoutMs, onHttpError, read) {
  for (let tries = 0; ; tries++) {
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: Object.assign({ 'content-type': 'application/json' }, headers),
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      if (!res.ok) {
        let text = '';
        try { text = await res.text(); } catch (_) { /* no body */ }
        throw onHttpError(res, text);
      }
      return await read(res);                             // the timer also covers the body download
    } catch (raw) {
      let err = raw;
      if (!(err && err.name === 'ProviderError')) {
        err = timedOut ? E('timeout', `no answer within ${timeoutMs} ms`) : E('upstream', `network error: ${netReason(raw)}`, { retryable: true });
      }
      if (!err.retryable || tries >= 1) throw err;
      await sleep(err.retryAfterMs != null ? Math.min(err.retryAfterMs, 5000) : (err.status === 429 ? 1000 : 400) + Math.random() * 250);
    } finally {
      clearTimeout(timer);
    }
  }
}

/* ------------------------------------------------------------------ ElevenLabs voice */

/*
 * Casting table: candidate voice ids per archetype, tried in order. Nothing here is validated
 * by listing voices (the game's key cannot list them): an id that the account cannot use is
 * marked bad on first failure and the next candidate takes over, ending at the narrator's.
 * Override any archetype with ELEVENLABS_VOICE_<ARCHETYPE>=<voice id>.
 *
 * Order, as verified live on 2026-11-15 with a free-plan key: ElevenLabs stock ("Default") voices
 * first, because they work on every plan. They are announced to expire on 2026-12-31. The ids
 * after them are the Voice Library replacements; a free plan gets "402 paid_plan_required" for
 * those, a paid plan can use them. Marked: [ok] spoke live, [402]/[404] refused live, [?] not tried.
 */
const ELEVEN_CAST = {
  narrator: ['JBFqnCBsd6RMkjVDRZzb', 'nPczCjzI2devNBz1zQrb', '6WwXjDDEMyNmFG95zycZ', '8dEUmyPMdDdK91vboYih'],   // George [ok], Brian [?], Eldrin [402], Sawyer [?]
  gruff: ['SOYHLrjzK2X1ezoPC6cr', 'pNInz6obpgDQGcFmaJgB', '10NkTYmU7tSz3Kkl3Lex'],                               // Harry [ok], Adam [ok], Kaelen [402]
  sage: ['pqHfZKP75CvOlQylNhV4', 'FrS6cKLB1wg4WYgPa9GW'],                                                         // Bill [ok], Wyatt [402]
  young: ['cgSgspJ2msm6clMCkdW9', 'TX3LPaxmHKxFdv7VOQHJ', 'g7LVvkPWALzPxOQbF6OE'],                               // Jessica [ok], Liam [?], Jade [402]
  sinister: ['N2lVS1w4EtoT3dr4eOWO', 'fs2OqxduwXgp9foh2xjK'],                                                     // Callum [ok], Callum replacement [404]
  noble: ['pFZP5JQG7iQjIQuC4Bku', 'Xb7hH8MSUJpSbSDYk0k2', '22N9cF8z0o7y23njdyaY'],                               // Lily [ok], Alice [?], Florence [402]
  cheerful: ['XrExE9yKIg1WjnnlVkGX', 'FGY2WhTYpPnrIDTdsKH5', 'QtY3JBOUKEB5xzrRfOKc'],                            // Matilda [ok], Laura [?], Maisie [402]
  creature: ['pNInz6obpgDQGcFmaJgB', 'nPczCjzI2devNBz1zQrb', 'N2lVS1w4EtoT3dr4eOWO'],                            // Adam [ok], Brian [?], Callum [ok]
};

/* One loopable bed per ambience value (everything in the enum except 'none'). */
const SFX_PROMPTS = {
  tavern: 'Cozy medieval tavern ambience, crackling hearth fire, low murmur of voices, occasional clink of mugs, seamless loop',
  town: 'Medieval market town ambience, distant chatter, cart wheels on cobblestones, a far-off bell, light breeze, seamless loop',
  forest: 'Deep forest ambience, gentle wind through leaves, birdsong, a distant stream, seamless loop',
  cave: 'Damp cave ambience, slow water drips echoing, faint low wind, deep rumble, seamless loop',
  dungeon: 'Dark stone dungeon ambience, distant chains, dripping water, low ominous drone, faint torch crackle, seamless loop',
  crypt: 'Ancient crypt ambience, cold hollow wind, faint ghostly whispers, deep eerie drone, seamless loop',
  mountain: 'High mountain pass ambience, strong cold wind gusts, distant eagle cry, loose stones shifting, seamless loop',
  storm: 'Heavy thunderstorm ambience, steady rain, rolling thunder, gusting wind, seamless loop',
  camp: 'Night campfire ambience, crackling fire, crickets, soft wind, an owl in the distance, seamless loop',
  combat: 'Tense fantasy battle ambience, low war drums, pulsing dark percussion, distant clash of steel, seamless loop',
};
const SFX_SECONDS = 10;

const LANG_CODES = {
  english: 'en', spanish: 'es', french: 'fr', german: 'de', italian: 'it', portuguese: 'pt', dutch: 'nl', polish: 'pl',
  russian: 'ru', ukrainian: 'uk', turkish: 'tr', swedish: 'sv', norwegian: 'no', danish: 'da', finnish: 'fi', czech: 'cs',
  greek: 'el', romanian: 'ro', hungarian: 'hu', hindi: 'hi', arabic: 'ar', japanese: 'ja', korean: 'ko', chinese: 'zh',
  indonesian: 'id', vietnamese: 'vi', filipino: 'fil',
};

function elevenVoice(env, opts) {
  const key = env.ELEVENLABS_API_KEY;
  const base = trimSlash(env.AIDND_ELEVENLABS_URL || 'https://api.elevenlabs.io');
  const model = String(env.ELEVENLABS_MODEL || 'eleven_flash_v2_5').trim();
  const sfxModel = String(env.ELEVENLABS_SFX_MODEL || 'eleven_text_to_sound_v3').trim();
  const dataDir = opts && opts.dataDir ? String(opts.dataDir) : '';
  const E = errorFactory('elevenlabs', [key]);
  const cache = createAudioCache(dataDir && path.join(dataDir, 'tts'), 'mp3', num(env.VOICE_CACHE_MB, 64, 1, 4096) * 1024 * 1024);
  const sfxCache = createAudioCache(dataDir && path.join(dataDir, 'sfx'), 'mp3', 32 * 1024 * 1024);
  const limit = createLimiter(num(env.ELEVENLABS_CONCURRENCY, 3, 1, 30));
  const flights = new Map();                              // request key or cache key -> Promise
  const bad = new Set();                                  // voice ids this account turned out not to have
  const sfxRetryAt = new Map();                           // name -> do not try again before this time
  let sfxOffUntil = 0;
  let langCodes = /_v2_5$/.test(model);                   // language_code is only sent to the v2.5 models
  let chars = 0;
  let sfxMade = 0;

  function candidates(archetype) {
    const list = [];
    const add = (id) => { const v = String(id || '').trim(); if (v && !list.includes(v)) list.push(v); };
    for (const a of archetype === 'narrator' ? ['narrator'] : [archetype, 'narrator']) {
      add(env[`ELEVENLABS_VOICE_${a.toUpperCase()}`]);
      (ELEVEN_CAST[a] || []).forEach(add);
    }
    return list;
  }

  /** Error bodies are { detail: { type, code, status, message } }; a 422 can carry a list instead. */
  function httpError(res, text) {
    let detail;
    try { detail = JSON.parse(text).detail; } catch (_) { /* not JSON */ }
    const status = res.status;
    let message = '';
    let tag = '';
    if (Array.isArray(detail)) {
      message = detail.map((d) => `${(d && d.loc ? d.loc : []).join('.')}: ${d && d.msg}`).join('; ');
      tag = 'validation_error';
    } else if (detail && typeof detail === 'object') {
      message = String(detail.message || '');
      tag = `${detail.code || ''} ${detail.status || ''} ${detail.type || ''}`;
    } else if (typeof detail === 'string') message = detail;
    else message = String(text || '').slice(0, 200);
    const info = { status, detail: tag.trim() };
    const text2 = `HTTP ${status}${tag.trim() ? ` ${tag.trim()}` : ''}: ${message}`.slice(0, 400);
    if (status === 429) return E('rate_limited', text2, Object.assign({ retryable: true, retryAfterMs: retryAfterMs(res) }, info));
    if (status >= 500 || status === 408) return E('upstream', text2, Object.assign({ retryable: true }, info));
    const aboutVoice = /voice/i.test(`${tag} ${message}`);
    if (/quota_exceeded|insufficient_credits|max_character_limit/.test(tag)) return E('quota', text2, info);
    // A wrong key answers 400 invalid_api_key; a missing permission answers 401.
    if (status === 401 || /invalid_api_key|missing_api_key|missing_permissions|needs_authorization|authentication_error/.test(tag)) return E('auth', text2, info);
    if (status === 402 && !aboutVoice) return E('quota', text2, info);
    if (/model_|unsupported_model|text_too_long/.test(tag)) return E('bad_request', text2, info);
    if (tag === 'validation_error' && !aboutVoice) return E('bad_request', text2, info);
    // Every other 4xx (400, 402, 403, 404, 422 naming the voice) means this voice id is not usable here.
    return E('upstream', text2, Object.assign({ voiceBad: true }, info));
  }

  const readAudio = async (res) => {
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw E('upstream', 'empty audio in the reply', { retryable: true });
    return buf;
  };

  function ttsOnce(voiceId, text, languageCode) {
    const body = { text, model_id: model };
    if (languageCode) body.language_code = languageCode;
    const url = `${base}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`;
    return limit(() => postForAudio(E, url, { 'xi-api-key': key, accept: 'audio/mpeg' }, body, 30000, httpError, readAudio));
  }

  async function synthesize(voiceId, text, languageCode) {
    let buf;
    try {
      buf = await ttsOnce(voiceId, text, languageCode);
    } catch (err) {
      // language_code is an optional nicety: if a request carrying it is refused, find out whether it was the culprit.
      if (!languageCode || !(err.voiceBad || err.code === 'bad_request')) throw err;
      buf = await ttsOnce(voiceId, text, '');
      langCodes = false;
    }
    chars += text.length;
    return buf;
  }

  async function speak(args) {
    const a = args || {};
    const text = speechText(a.text);
    if (!text) throw E('bad_request', 'nothing to say');
    const archetype = archetypeOf(a.voice);
    const code = LANG_CODES[lower(a.lang)] || '';
    return singleFlight(flights, `req|${archetype}|${sha(text)}`, async () => {
      let last = null;
      for (const voiceId of candidates(archetype)) {
        if (bad.has(voiceId)) continue;
        const cacheKey = sha(`elevenlabs|${voiceId}|${model}|${text}`);
        try {
          const out = await singleFlight(flights, cacheKey, async () => {
            const hit = await cache.get(cacheKey);
            if (hit) return { mime: 'audio/mpeg', buffer: hit, cached: true, voiceId };
            const buffer = await synthesize(voiceId, text, langCodes && code && code !== 'en' ? code : '');
            await cache.put(cacheKey, buffer);
            return { mime: 'audio/mpeg', buffer, cached: false, voiceId };
          });
          return out;
        } catch (err) {
          if (!err.voiceBad) throw err;
          if (!bad.has(voiceId)) {
            bad.add(voiceId);
            console.warn(`[voice] ElevenLabs voice ${voiceId} (${archetype}) is not usable with this key (HTTP ${err.status}); trying the next one`);
          }
          last = err;
        }
      }
      throw last || E('upstream', `no usable voice for ${archetype}`);
    });
  }

  // full: with `loop` and `model_id` (accepted live on 2026-11-15); otherwise the bare body.
  function sfxOnce(prompt, full) {
    const body = { text: prompt, duration_seconds: SFX_SECONDS };
    if (full) { body.loop = true; if (sfxModel) body.model_id = sfxModel; }
    return postForAudio(E, `${base}/v1/sound-generation`, { 'xi-api-key': key, accept: 'audio/mpeg' }, body, 90000, httpError, readAudio);
  }

  /** One generated ambience loop per name, made once and kept on disk. Never rejects. */
  function sfx(name) {
    const k = lower(name);
    if (!own(SFX_PROMPTS, k)) return Promise.resolve(null);
    const prompt = SFX_PROMPTS[k];
    const cacheKey = `${k}-${sha(`${prompt}|${SFX_SECONDS}`).slice(0, 10)}`;
    return singleFlight(flights, `sfx|${cacheKey}`, async () => {
      try {
        const hit = await sfxCache.get(cacheKey);
        if (hit) return { mime: 'audio/mpeg', buffer: hit, cached: true };
        const now = Date.now();
        if (now < sfxOffUntil || now < (sfxRetryAt.get(k) || 0)) return null;
        let buffer;
        try {
          buffer = await sfxOnce(prompt, true);
        } catch (err) {
          // If the optional fields are ever refused, fall back to the bare { text, duration_seconds } body.
          if (!(err.voiceBad || err.code === 'bad_request')) throw err;
          buffer = await sfxOnce(prompt, false);
        }
        sfxMade++;
        await sfxCache.put(cacheKey, buffer);
        return { mime: 'audio/mpeg', buffer, cached: false };
      } catch (err) {
        const wait = 10 * 60 * 1000;
        if (err && (err.code === 'auth' || err.code === 'quota')) sfxOffUntil = Date.now() + wait;
        else sfxRetryAt.set(k, Date.now() + wait);
        return null;
      }
    }).catch(() => null);
  }

  const api = {
    name: 'elevenlabs',
    model,
    speak,
    sfx,
    /** Diagnostics: the voice id each archetype currently resolves to, and the ids found unusable. */
    info() {
      const cast = {};
      for (const a of ARCHETYPES) cast[a] = candidates(a).find((id) => !bad.has(id)) || null;
      return { provider: 'elevenlabs', model, cast, bad: [...bad], languageCodes: langCodes, sfxGenerated: sfxMade, chars };
    },
  };
  Object.defineProperty(api, 'chars', { enumerable: true, get: () => chars });
  return api;
}

/* ------------------------------------------------------------------ Gemini voice */

// Archetype -> prebuilt voice and a short, constant style (long style text makes the voice drift).
const GEMINI_VOICES = {
  narrator: { voice: 'Algenib', style: 'measured, low, unhurried storyteller' },
  gruff: { voice: 'Orus', style: 'gruff and impatient' },
  sage: { voice: 'Sadaltager', style: 'old, calm and deliberate' },
  young: { voice: 'Leda', style: 'young and curious' },
  sinister: { voice: 'Enceladus', style: 'quiet menace, slow' },
  noble: { voice: 'Schedar', style: 'composed and formal' },
  cheerful: { voice: 'Achird', style: 'friendly and eager' },
  creature: { voice: 'Fenrir', style: 'snarling and breathless' },
};

/** Wraps raw 16-bit little-endian PCM in a 44-byte RIFF/WAVE header. */
function pcmToWav(pcm, sampleRate, channels) {
  const blockAlign = channels * 2;
  const dataLen = pcm.length - (pcm.length % blockAlign);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + dataLen, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * blockAlign, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(dataLen, 40);
  return Buffer.concat([h, pcm.subarray(0, dataLen)], 44 + dataLen);
}

function geminiVoice(env, opts) {
  const key = env.GEMINI_API_KEY;
  const model = String(env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-tts').trim();
  const url = `${trimSlash(env.AIDND_GEMINI_URL || GEMINI_HOST)}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const dataDir = opts && opts.dataDir ? String(opts.dataDir) : '';
  const E = errorFactory('gemini', [key]);
  const cache = createAudioCache(dataDir && path.join(dataDir, 'tts'), 'wav', num(env.VOICE_CACHE_MB, 64, 1, 4096) * 1024 * 1024);
  const limit = createLimiter(2);
  const flights = new Map();
  let chars = 0;

  const httpError = (res, text) => {
    let json;
    try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
    return geminiHttpError(E, res, text, json);
  };

  async function readAudio(res) {
    let json;
    try { json = JSON.parse(await res.text()); } catch (_) { throw E('upstream', 'reply was not JSON', { retryable: true }); }
    const cand = json && Array.isArray(json.candidates) ? json.candidates[0] : undefined;
    if (!cand) {
      const why = json && json.promptFeedback && json.promptFeedback.blockReason;
      throw why ? E('refused', `speech prompt blocked (${why})`) : E('upstream', 'no audio in the reply', { retryable: true });
    }
    const chunks = [];
    let mime = '';
    for (const p of (cand.content && cand.content.parts) || []) {
      if (p && p.inlineData && p.inlineData.data) { chunks.push(Buffer.from(p.inlineData.data, 'base64')); mime = mime || String(p.inlineData.mimeType || ''); }
    }
    if (!chunks.length) {
      const reason = cand.finishReason || 'no audio part';
      throw /SAFETY|PROHIBITED|BLOCKLIST|SPII|RECITATION/.test(reason) ? E('refused', `speech refused (${reason})`) : E('upstream', `no audio in the reply (${reason})`, { retryable: true });
    }
    const buf = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
    // Current models answer with a finished WAV file; older ones with headerless PCM ("audio/L16;rate=24000").
    if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') return buf;
    const m = mime.toLowerCase();
    if (m && !/l16|pcm/.test(m)) throw E('upstream', `unexpected audio type ${mime}`);
    const rate = /rate=(\d+)/.exec(m);
    const ch = /channels=(\d+)/.exec(m);
    return pcmToWav(buf, rate ? Number(rate[1]) : 24000, ch ? Number(ch[1]) : 1);
  }

  async function speak(args) {
    const a = args || {};
    const text = speechText(a.text);
    if (!text) throw E('bad_request', 'nothing to say');
    const v = GEMINI_VOICES[archetypeOf(a.voice)];
    const cacheKey = sha(`gemini|${v.voice}|${model}|${text}`);
    return singleFlight(flights, cacheKey, async () => {
      const hit = await cache.get(cacheKey);
      if (hit) return { mime: 'audio/wav', buffer: hit, cached: true, voiceId: v.voice };
      const body = {
        contents: [{ role: 'user', parts: [{ text, speech_metadata: { style: v.style } }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { voice: v.voice } } },
      };
      const buffer = await limit(() => postForAudio(E, url, { 'x-goog-api-key': key }, body, 45000, httpError, readAudio));
      chars += text.length;
      await cache.put(cacheKey, buffer);
      return { mime: 'audio/wav', buffer, cached: false, voiceId: v.voice };
    });
  }

  const api = {
    name: 'gemini',
    model,
    speak,
    sfx: () => Promise.resolve(null),                     // generated ambience is ElevenLabs only
    info() {
      const cast = {};
      for (const a of ARCHETYPES) cast[a] = GEMINI_VOICES[a].voice;
      return { provider: 'gemini', model, cast, bad: [], languageCodes: false, sfxGenerated: 0, chars };
    },
  };
  Object.defineProperty(api, 'chars', { enumerable: true, get: () => chars });
  return api;
}

/**
 * VOICE_PROVIDER wins when set ('browser' / 'off' -> null); otherwise ElevenLabs when its key
 * is set, else Gemini speech when its key is set, else null (clients use browser speech).
 */
function createVoice(env, opts) {
  const e = env || {};
  const pick = lower(e.VOICE_PROVIDER);
  if (pick === 'browser' || pick === 'off' || pick === 'none') return null;
  let name = pick === 'elevenlabs' || pick === 'gemini' ? pick : '';
  if (!name) name = e.ELEVENLABS_API_KEY ? 'elevenlabs' : e.GEMINI_API_KEY ? 'gemini' : '';
  if (name === 'elevenlabs') return e.ELEVENLABS_API_KEY ? elevenVoice(e, opts) : null;
  if (name === 'gemini') return e.GEMINI_API_KEY ? geminiVoice(e, opts) : null;
  return null;
}

module.exports = { createDM, createVoice };
