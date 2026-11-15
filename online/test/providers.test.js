'use strict';
/*
 * Tests for providers.js. Plain Node, no dependencies:
 *
 *   node test/providers.test.js
 *
 * Part 1 runs against local mock upstream servers (no network, no keys).
 * Part 2 calls the real ElevenLabs API and only runs when ELEVENLABS_LIVE=1:
 *
 *   ELEVENLABS_API_KEY=<key> ELEVENLABS_LIVE=1 node test/providers.test.js
 *
 * It spends about 260 characters of speech and one sound generation on the first run;
 * later runs reuse the audio cached under the test data directory.
 * AIDND_TEST_DATA chooses that directory (default: <os tmp>/aidnd-providers-test).
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const LIVE = process.env.ELEVENLABS_LIVE === '1';

// Node's fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY=1 (Node >= 22.21). Where a proxy is
// configured, the live part must go through it, so re-run this script once with the flag set.
if (LIVE && (process.env.HTTPS_PROXY || process.env.https_proxy) && process.env.NODE_USE_ENV_PROXY !== '1') {
  const r = spawnSync(process.execPath, [__filename], { stdio: 'inherit', env: Object.assign({}, process.env, { NODE_USE_ENV_PROXY: '1' }) });
  process.exit(r.status == null ? 1 : r.status);
}

const P = require('../providers.js');

const DATA_ROOT = process.env.AIDND_TEST_DATA || path.join(os.tmpdir(), 'aidnd-providers-test');
fs.mkdirSync(DATA_ROOT, { recursive: true });
const RUN_DIR = fs.mkdtempSync(path.join(DATA_ROOT, 'run-'));
let dirCount = 0;
const freshDir = () => path.join(RUN_DIR, `d${++dirCount}`);

const warnings = [];
const realWarn = console.warn;
console.warn = (...a) => { warnings.push(a.join(' ')); };

/* ---------------------------------------------------------------- tiny runner */

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

async function rejects(promise, code) {
  let err = null;
  try { await promise; } catch (e) { err = e; }
  assert.ok(err, `expected a rejection with code ${code}`);
  assert.ok(err instanceof Error, 'rejection is an Error');
  assert.strictEqual(err.code, code, `error code (message: ${err.message})`);
  return err;
}

/* ---------------------------------------------------------------- mock upstream */

function mockServer() {
  const m = { reqs: [], queue: [], fallback: null, url: '' };
  m.server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = raw;
      try { body = JSON.parse(raw); } catch (_) { /* keep the raw text */ }
      const r = { method: req.method, url: req.url, headers: req.headers, body };
      m.reqs.push(r);
      const handler = m.queue.shift() || m.fallback;
      if (!handler) { res.writeHead(500); res.end('no handler'); return; }
      handler(r, res);
    });
  });
  m.reset = () => { m.reqs.length = 0; m.queue.length = 0; };
  m.start = () => new Promise((resolve) => m.server.listen(0, '127.0.0.1', () => {
    m.url = `http://127.0.0.1:${m.server.address().port}`;
    resolve(m);
  }));
  m.stop = () => new Promise((resolve) => { m.server.closeAllConnections(); m.server.close(() => resolve()); });
  return m;
}

const sendJson = (status, obj, headers) => (r, res) => {
  res.writeHead(status, Object.assign({ 'content-type': 'application/json' }, headers));
  res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
};
const sendAudio = (buf, delayMs) => (r, res) => {
  setTimeout(() => { res.writeHead(200, { 'content-type': 'audio/mpeg' }); res.end(buf); }, delayMs || 0);
};
const hang = () => () => { /* never answers */ };

const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(61, 7)]);
const isMp3 = (b) => Buffer.isBuffer(b) && b.length > 3 && (b.toString('latin1', 0, 3) === 'ID3' || (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0));

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['segments', 'chips'],
  properties: {
    segments: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['speaker', 'voice', 'text'],
        properties: { speaker: { type: 'string' }, voice: { type: 'string', enum: ['narrator', 'gruff'] }, text: { type: 'string' } },
      },
    },
    chips: { type: 'array', items: { type: 'string' } },
  },
};
const REPLY = { segments: [{ speaker: 'narrator', voice: 'narrator', text: 'The door creaks open.' }], chips: ['Look around'] };

const A_KEY = 'sk-ant-test-0123456789abcdef';
const G_KEY = 'AIza-test-0123456789abcdef';
const E_KEY = 'el-test-0123456789abcdef';

const claudeOk = (obj, extra) => sendJson(200, Object.assign({
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn',
  content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) }],
  usage: { input_tokens: 10, output_tokens: 20 },
}, extra));
const claudeErr = (status, type, message, headers) => sendJson(status, { type: 'error', error: { type, message } }, headers);
const geminiOk = (obj, finishReason) => sendJson(200, {
  candidates: [{ content: { role: 'model', parts: [{ text: 'pondering', thought: true }, { text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] }, finishReason: finishReason || 'STOP' }],
});
const geminiErr = (status, code, message, headers) => sendJson(status, { error: { code: status, status: code, message } }, headers);
const elevenErr = (status, code, message, headers) => sendJson(status, { detail: { status: code, code, message } }, headers);

const anth = mockServer();
const gem = mockServer();
const el = mockServer();

/* ---------------------------------------------------------------- Dungeon Master: selection */

test('createDM: provider selection rules', () => {
  assert.strictEqual(P.createDM({}), null);
  assert.strictEqual(P.createDM(), null);
  assert.strictEqual(P.createDM({ ANTHROPIC_API_KEY: A_KEY, GEMINI_API_KEY: G_KEY, DM_PROVIDER: 'scripted' }), null);
  const a = P.createDM({ ANTHROPIC_API_KEY: A_KEY });
  assert.strictEqual(a.name, 'anthropic');
  assert.strictEqual(a.model, 'claude-opus-5-5');
  assert.strictEqual(typeof a.complete, 'function');
  assert.strictEqual(P.createDM({ ANTHROPIC_API_KEY: A_KEY, GEMINI_API_KEY: G_KEY }).name, 'anthropic');
  const g = P.createDM({ GEMINI_API_KEY: G_KEY });
  assert.strictEqual(g.name, 'gemini');
  assert.strictEqual(g.model, 'gemini-3.8-flash');
  assert.strictEqual(P.createDM({ ANTHROPIC_API_KEY: A_KEY, GEMINI_API_KEY: G_KEY, DM_PROVIDER: 'gemini' }).name, 'gemini');
  assert.strictEqual(P.createDM({ ANTHROPIC_API_KEY: A_KEY, GEMINI_API_KEY: G_KEY, DM_PROVIDER: 'Anthropic' }).name, 'anthropic');
  assert.strictEqual(P.createDM({ GEMINI_API_KEY: G_KEY, DM_PROVIDER: 'anthropic' }), null, 'named provider without its key');
  assert.strictEqual(P.createDM({ ANTHROPIC_API_KEY: A_KEY, ANTHROPIC_MODEL: 'claude-sonnet-5-5' }).model, 'claude-sonnet-5-5');
  assert.strictEqual(P.createDM({ GEMINI_API_KEY: G_KEY, GEMINI_MODEL: 'gemini-3.5-flash-lite' }).model, 'gemini-3.5-flash-lite');
  assert.deepStrictEqual(Object.keys(P).sort(), ['createDM', 'createVoice']);
});

test('providers.js never reads ANTHROPIC_BASE_URL', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'providers.js'), 'utf8');
  assert.ok(!/\w\s*\.\s*ANTHROPIC_BASE_URL|\[\s*['"`]ANTHROPIC_BASE_URL/.test(src), 'no property access named ANTHROPIC_BASE_URL');
  assert.ok(!/require\(['"](?!crypto|fs|path)[^'"]+['"]\)/.test(src), 'only Node built-ins are required');
});

/* ---------------------------------------------------------------- Dungeon Master: Anthropic */

const anthEnv = (extra) => Object.assign({ ANTHROPIC_API_KEY: A_KEY, AIDND_ANTHROPIC_URL: anth.url, ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/never' }, extra);

test('anthropic: happy path and request shape', async () => {
  anth.reset();
  anth.queue.push(claudeOk(REPLY));
  const dm = P.createDM(anthEnv());
  const out = await dm.complete({ system: 'You are the Dungeon Master.', user: 'Kira opens the door.', schema: SCHEMA });
  assert.deepStrictEqual(out, REPLY);
  assert.strictEqual(anth.reqs.length, 1);
  const r = anth.reqs[0];
  assert.strictEqual(r.method, 'POST');
  assert.strictEqual(r.url, '/v1/messages');
  assert.strictEqual(r.headers['x-api-key'], A_KEY);
  assert.strictEqual(r.headers['anthropic-version'], '2026-10-21');
  assert.ok(/application\/json/.test(r.headers['content-type']));
  assert.strictEqual(r.headers.authorization, undefined);
  const b = r.body;
  assert.strictEqual(b.model, 'claude-opus-5-5');
  assert.ok(Number.isInteger(b.max_tokens) && b.max_tokens >= 4000);
  assert.deepStrictEqual(b.system, [{ type: 'text', text: 'You are the Dungeon Master.', cache_control: { type: 'ephemeral' } }]);
  assert.deepStrictEqual(b.messages, [{ role: 'user', content: 'Kira opens the door.' }]);
  assert.strictEqual(b.output_config.effort, 'low');
  assert.strictEqual(b.output_config.format.type, 'json_schema');
  assert.deepStrictEqual(b.output_config.format.schema, SCHEMA);
  for (const k of ['temperature', 'top_p', 'top_k', 'thinking', 'tool_choice', 'tools', 'output_format', 'stream']) {
    assert.ok(!(k in b), `request must not carry ${k}`);
  }
  // Refusal fallback is opted into on models that support it.
  assert.strictEqual(b.fallbacks, 'default');
  assert.strictEqual(r.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
});

test('anthropic: no fallback parameter on a model without it; schema safety net', async () => {
  anth.reset();
  anth.queue.push(claudeOk(REPLY));
  const dm = P.createDM(anthEnv({ ANTHROPIC_MODEL: 'claude-haiku-5-5' }));
  const loose = { type: 'object', required: ['n'], properties: { n: { type: 'integer', minimum: 1, maximum: 20 }, s: { type: 'string', maxLength: 9 } } };
  await dm.complete({ system: 's', user: 'u', schema: loose });
  const b = anth.reqs[0].body;
  assert.strictEqual(b.model, 'claude-haiku-5-5');
  assert.ok(!('fallbacks' in b));
  assert.strictEqual(anth.reqs[0].headers['anthropic-beta'], undefined);
  assert.deepStrictEqual(b.output_config.format.schema, { type: 'object', required: ['n'], properties: { n: { type: 'integer' }, s: { type: 'string' } }, additionalProperties: false });
});

test('anthropic: a 400 about the fallback beta is retried without it', async () => {
  anth.reset();
  anth.queue.push(claudeErr(400, 'invalid_request_error', 'Unexpected value for the anthropic-beta header'), claudeOk(REPLY), claudeOk(REPLY));
  const dm = P.createDM(anthEnv());
  assert.deepStrictEqual(await dm.complete({ system: 's', user: 'u', schema: SCHEMA }), REPLY);
  assert.strictEqual(anth.reqs.length, 2);
  assert.ok(!('fallbacks' in anth.reqs[1].body));
  assert.strictEqual(anth.reqs[1].headers['anthropic-beta'], undefined);
  await dm.complete({ system: 's', user: 'u', schema: SCHEMA });
  assert.ok(!('fallbacks' in anth.reqs[2].body), 'stays off for later calls');
});

for (const [status, type] of [[529, 'overloaded_error'], [503, 'api_error'], [429, 'rate_limit_error']]) {
  test(`anthropic: retries once on ${status}, then succeeds`, async () => {
    anth.reset();
    anth.queue.push(claudeErr(status, type, 'busy', { 'retry-after': '0' }), claudeOk(REPLY));
    const dm = P.createDM(anthEnv());
    assert.deepStrictEqual(await dm.complete({ system: 's', user: 'u', schema: SCHEMA }), REPLY);
    assert.strictEqual(anth.reqs.length, 2);
  });
}

test('anthropic: gives up after one retry with a typed error', async () => {
  anth.reset();
  anth.queue.push(claudeErr(529, 'overloaded_error', 'busy', { 'retry-after': '0' }), claudeErr(529, 'overloaded_error', 'busy', { 'retry-after': '0' }), claudeOk(REPLY));
  const dm = P.createDM(anthEnv());
  await rejects(dm.complete({ system: 's', user: 'u', schema: SCHEMA }), 'upstream');
  assert.strictEqual(anth.reqs.length, 2);
  anth.reset();
  anth.queue.push(claudeErr(429, 'rate_limit_error', 'slow down', { 'retry-after': '0' }), claudeErr(429, 'rate_limit_error', 'slow down', { 'retry-after': '0' }));
  await rejects(dm.complete({ system: 's', user: 'u', schema: SCHEMA }), 'rate_limited');
  assert.strictEqual(anth.reqs.length, 2);
});

test('anthropic: auth and bad-request errors are not retried; the key is redacted', async () => {
  anth.reset();
  anth.queue.push(claudeErr(401, 'authentication_error', `invalid x-api-key ${A_KEY}`));
  const dm = P.createDM(anthEnv());
  const e = await rejects(dm.complete({ system: 's', user: 'u', schema: SCHEMA }), 'auth');
  assert.strictEqual(anth.reqs.length, 1);
  assert.ok(!e.message.includes(A_KEY), 'key value must not appear in the error');
  assert.ok(!JSON.stringify(Object.assign({}, e)).includes(A_KEY));
  anth.reset();
  anth.queue.push(claudeErr(400, 'invalid_request_error', 'schema is too complex'));
  await rejects(dm.complete({ system: 's', user: 'u', schema: SCHEMA }), 'upstream');
  assert.strictEqual(anth.reqs.length, 1);
});

test('anthropic: timeout', async () => {
  anth.reset();
  anth.queue.push(hang());
  const dm = P.createDM(anthEnv({ DM_TIMEOUT_MS: '250' }));
  const t0 = Date.now();
  await rejects(dm.complete({ system: 's', user: 'u', schema: SCHEMA }), 'timeout');
  assert.ok(Date.now() - t0 < 2000, 'fails promptly');
  assert.strictEqual(anth.reqs.length, 1, 'a timeout is not retried');
});

test('anthropic: caller abort', async () => {
  anth.reset();
  anth.queue.push(hang());
  const dm = P.createDM(anthEnv());
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 60);
  const e = await rejects(dm.complete({ system: 's', user: 'u', schema: SCHEMA, signal: ctl.signal }), 'upstream');
  assert.strictEqual(e.aborted, true);
});

test('anthropic: refusal, truncation and malformed JSON map to typed errors', async () => {
  const dm = P.createDM(anthEnv());
  anth.reset();
  anth.queue.push(sendJson(200, { id: 'm', type: 'message', role: 'assistant', content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } }));
  const e = await rejects(dm.complete({ system: 's', user: 'u', schema: SCHEMA }), 'refused');
  assert.strictEqual(e.category, 'cyber');
  anth.queue.push(claudeOk('{"segments":[{"speaker":"narr', { stop_reason: 'max_tokens' }));
  const t = await rejects(dm.complete({ system: 's', user: 'u', schema: SCHEMA }), 'bad_json');
  assert.strictEqual(t.truncated, true);
  anth.queue.push(claudeOk('The door creaks open, and that is all I have to say.'));
  await rejects(dm.complete({ system: 's', user: 'u', schema: SCHEMA }), 'bad_json');
  anth.queue.push(claudeOk('[1, 2, 3]'));
  await rejects(dm.complete({ system: 's', user: 'u', schema: SCHEMA }), 'bad_json');
  anth.queue.push(sendJson(200, '<html>gateway</html>'));
  await rejects(dm.complete({ system: 's', user: 'u', schema: SCHEMA }), 'bad_json');
  assert.strictEqual(anth.reqs.length, 5, 'none of these is retried');
  anth.queue.push(claudeOk('```json\n' + JSON.stringify(REPLY) + '\n```'));
  assert.deepStrictEqual(await dm.complete({ system: 's', user: 'u', schema: SCHEMA }), REPLY, 'a fenced object is still accepted');
});

test('anthropic: network failure is retried once and reported as upstream', async () => {
  const dm = P.createDM({ ANTHROPIC_API_KEY: A_KEY, AIDND_ANTHROPIC_URL: 'http://127.0.0.1:9', DM_TIMEOUT_MS: '8000' });
  await rejects(dm.complete({ system: 's', user: 'u', schema: SCHEMA }), 'upstream');
});

/* ---------------------------------------------------------------- Dungeon Master: Gemini */

const gemEnv = (extra) => Object.assign({ GEMINI_API_KEY: G_KEY, AIDND_GEMINI_URL: gem.url }, extra);

test('gemini: happy path and request shape', async () => {
  gem.reset();
  gem.queue.push(geminiOk(REPLY));
  const dm = P.createDM(gemEnv());
  const out = await dm.complete({ system: 'You are the Dungeon Master.', user: 'Kira opens the door.', schema: SCHEMA });
  assert.deepStrictEqual(out, REPLY);
  const r = gem.reqs[0];
  assert.strictEqual(r.method, 'POST');
  assert.strictEqual(r.url, '/v1beta/models/gemini-3.8-flash:generateContent');
  assert.ok(!r.url.includes(G_KEY), 'key is not in the URL');
  assert.strictEqual(r.headers['x-goog-api-key'], G_KEY);
  const b = r.body;
  assert.deepStrictEqual(b.systemInstruction, { parts: [{ text: 'You are the Dungeon Master.' }] });
  assert.deepStrictEqual(b.contents, [{ role: 'user', parts: [{ text: 'Kira opens the door.' }] }]);
  assert.strictEqual(b.generationConfig.responseMimeType, 'application/json');
  assert.deepStrictEqual(b.generationConfig.responseJsonSchema, SCHEMA);
  assert.deepStrictEqual(b.generationConfig.thinkingConfig, { thinkingLevel: 'low' });
  for (const k of ['temperature', 'topP', 'topK']) assert.ok(!(k in b.generationConfig), `request must not carry ${k}`);
});

for (const status of [503, 429]) {
  test(`gemini: retries once on ${status}, then succeeds`, async () => {
    gem.reset();
    gem.queue.push(geminiErr(status, status === 429 ? 'RESOURCE_EXHAUSTED' : 'UNAVAILABLE', 'busy', { 'retry-after': '0' }), geminiOk(REPLY));
    const dm = P.createDM(gemEnv());
    assert.deepStrictEqual(await dm.complete({ system: 's', user: 'u', schema: SCHEMA }), REPLY);
    assert.strictEqual(gem.reqs.length, 2);
  });
}

test('gemini: typed errors (rate limit, auth, refusal, truncation, malformed JSON, timeout)', async () => {
  const dm = P.createDM(gemEnv());
  gem.reset();
  gem.queue.push(geminiErr(429, 'RESOURCE_EXHAUSTED', 'quota', { 'retry-after': '0' }), geminiErr(429, 'RESOURCE_EXHAUSTED', 'quota', { 'retry-after': '0' }));
  await rejects(dm.complete({ system: 's', user: 'u', schema: SCHEMA }), 'rate_limited');
  assert.strictEqual(gem.reqs.length, 2);
  gem.reset();
  gem.queue.push(geminiErr(403, 'PERMISSION_DENIED', `API key ${G_KEY} not valid`));
  const e = await rejects(dm.complete({ system: 's', user: 'u', schema: SCHEMA }), 'auth');
  assert.ok(!e.message.includes(G_KEY));
  assert.strictEqual(gem.reqs.length, 1);
  gem.queue.push(sendJson(200, { promptFeedback: { blockReason: 'SAFETY' } }));
  await rejects(dm.complete({ system: 's', user: 'u', schema: SCHEMA }), 'refused');
  gem.queue.push(geminiOk('', 'SAFETY'));
  await rejects(dm.complete({ system: 's', user: 'u', schema: SCHEMA }), 'refused');
  gem.queue.push(geminiOk('{"segments":[', 'MAX_TOKENS'));
  await rejects(dm.complete({ system: 's', user: 'u', schema: SCHEMA }), 'bad_json');
  gem.queue.push(geminiOk('I would rather tell a story.'));
  await rejects(dm.complete({ system: 's', user: 'u', schema: SCHEMA }), 'bad_json');
  gem.queue.push(hang());
  const slow = P.createDM(gemEnv({ DM_TIMEOUT_MS: '250' }));
  await rejects(slow.complete({ system: 's', user: 'u', schema: SCHEMA }), 'timeout');
});

test('gemini: falls back to the responseFormat spelling when responseJsonSchema is rejected', async () => {
  gem.reset();
  gem.queue.push(geminiErr(400, 'INVALID_ARGUMENT', 'Invalid JSON payload received. Unknown name "responseJsonSchema"'), geminiOk(REPLY));
  const dm = P.createDM(gemEnv());
  assert.deepStrictEqual(await dm.complete({ system: 's', user: 'u', schema: SCHEMA }), REPLY);
  assert.deepStrictEqual(gem.reqs[1].body.generationConfig.responseFormat, { text: { mimeType: 'APPLICATION_JSON', schema: SCHEMA } });
});

/* ---------------------------------------------------------------- voice: selection */

test('createVoice: provider selection rules', () => {
  assert.strictEqual(P.createVoice({}, {}), null);
  assert.strictEqual(P.createVoice(), null);
  for (const off of ['browser', 'off']) {
    assert.strictEqual(P.createVoice({ ELEVENLABS_API_KEY: E_KEY, GEMINI_API_KEY: G_KEY, VOICE_PROVIDER: off }, {}), null);
  }
  const v = P.createVoice({ ELEVENLABS_API_KEY: E_KEY, GEMINI_API_KEY: G_KEY }, {});
  assert.strictEqual(v.name, 'elevenlabs');
  assert.strictEqual(v.model, 'eleven_v4');
  assert.strictEqual(typeof v.speak, 'function');
  assert.strictEqual(typeof v.sfx, 'function');
  assert.strictEqual(v.chars, 0);
  assert.strictEqual(P.createVoice({ GEMINI_API_KEY: G_KEY }, {}).name, 'gemini');
  assert.strictEqual(P.createVoice({ ELEVENLABS_API_KEY: E_KEY, GEMINI_API_KEY: G_KEY, VOICE_PROVIDER: 'gemini' }, {}).name, 'gemini');
  assert.strictEqual(P.createVoice({ GEMINI_API_KEY: G_KEY, VOICE_PROVIDER: 'elevenlabs' }, {}), null);
  assert.strictEqual(P.createVoice({ ELEVENLABS_API_KEY: E_KEY, ELEVENLABS_MODEL: 'eleven_v4' }, {}).model, 'eleven_v4');
});

/* ---------------------------------------------------------------- voice: ElevenLabs */

const elEnv = (extra) => Object.assign({ ELEVENLABS_API_KEY: E_KEY, AIDND_ELEVENLABS_URL: el.url }, extra);
const voiceIdOf = (r) => decodeURIComponent(r.url.split('/v1/text-to-speech/')[1].split('?')[0]);

test('elevenlabs: speak request shape, memory cache, disk cache, chars counter', async () => {
  el.reset();
  el.fallback = sendAudio(MP3);
  const dir = freshDir();
  const voice = P.createVoice(elEnv(), { dataDir: dir });
  const text = 'The road bends toward Emberpeak.';
  const out = await voice.speak({ text, voice: 'narrator', lang: 'English' });
  assert.strictEqual(out.mime, 'audio/mpeg');
  assert.ok(out.buffer.equals(MP3));
  assert.strictEqual(el.reqs.length, 1);
  const r = el.reqs[0];
  assert.strictEqual(r.method, 'POST');
  assert.ok(/^\/v1\/text-to-speech\/[A-Za-z0-9]+\?output_format=mp3_44100_128$/.test(r.url), r.url);
  assert.strictEqual(r.headers['xi-api-key'], E_KEY);
  assert.deepStrictEqual(r.body, { text, model_id: 'eleven_v4' });
  assert.strictEqual(voice.chars, text.length);
  assert.strictEqual(typeof voice.chars, 'number');

  const again = await voice.speak({ text, voice: 'narrator', lang: 'English' });
  assert.ok(again.buffer.equals(MP3));
  assert.strictEqual(el.reqs.length, 1, 'second call is a cache hit');
  assert.strictEqual(voice.chars, text.length, 'cache hits do not count');

  const files = fs.readdirSync(path.join(dir, 'tts'));
  assert.strictEqual(files.length, 1);
  assert.ok(/^[0-9a-f]{64}\.mp3$/.test(files[0]), files[0]);
  const expected = require('crypto').createHash('sha256').update(`elevenlabs|${voiceIdOf(r)}|eleven_v4|${text}`).digest('hex');
  assert.strictEqual(files[0], `${expected}.mp3`, 'cache key is sha256(provider|voiceId|model|text)');

  const second = P.createVoice(elEnv(), { dataDir: dir });
  const fromDisk = await second.speak({ text, voice: 'narrator' });
  assert.ok(fromDisk.buffer.equals(MP3));
  assert.strictEqual(el.reqs.length, 1, 'a new process reads the disk cache');
  assert.strictEqual(second.chars, 0);
});

test('elevenlabs: single-flight (two concurrent identical calls make one upstream request)', async () => {
  el.reset();
  el.fallback = sendAudio(MP3, 80);
  const voice = P.createVoice(elEnv(), { dataDir: freshDir() });
  const [a, b, c] = await Promise.all([
    voice.speak({ text: 'Roll for initiative!', voice: 'gruff' }),
    voice.speak({ text: 'Roll for initiative!', voice: 'gruff' }),
    voice.speak({ text: 'Roll   for initiative! ', voice: 'gruff' }),
  ]);
  assert.strictEqual(el.reqs.length, 1);
  assert.ok(a.buffer.equals(MP3) && b.buffer.equals(MP3) && c.buffer.equals(MP3));
  assert.strictEqual(voice.chars, 'Roll for initiative!'.length);
});

test('elevenlabs: a bad voice id falls through to the next candidate and stays bad', async () => {
  el.reset();
  el.fallback = sendAudio(MP3);
  const voice = P.createVoice(elEnv({ ELEVENLABS_VOICE_GRUFF: 'BadGruffVoice0000001' }), { dataDir: freshDir() });
  el.queue.push(elevenErr(404, 'voice_not_found', 'A voice with voice_id BadGruffVoice0000001 was not found.'));
  const out = await voice.speak({ text: 'Stand aside.', voice: 'gruff' });
  assert.ok(out.buffer.equals(MP3));
  assert.strictEqual(el.reqs.length, 2);
  assert.strictEqual(voiceIdOf(el.reqs[0]), 'BadGruffVoice0000001', 'the env override is tried first');
  const next = voiceIdOf(el.reqs[1]);
  assert.notStrictEqual(next, 'BadGruffVoice0000001');
  assert.strictEqual(out.voiceId, next);
  assert.strictEqual(voice.chars, 'Stand aside.'.length, 'a failed attempt is not counted');
  await voice.speak({ text: 'I said stand aside.', voice: 'gruff' });
  assert.strictEqual(el.reqs.length, 3);
  assert.strictEqual(voiceIdOf(el.reqs[2]), next, 'the bad id is skipped for the rest of the process');
  assert.deepStrictEqual(voice.info().bad, ['BadGruffVoice0000001']);
  assert.ok(warnings.some((w) => w.includes('BadGruffVoice0000001')));
});

test('elevenlabs: when every archetype voice is bad the narrator voice is used', async () => {
  el.reset();
  const narrator = 'NarratorVoice0000001';
  el.fallback = (r, res) => (voiceIdOf(r) === narrator ? sendAudio(MP3)(r, res) : elevenErr(400, 'invalid_uid', 'An invalid ID has been received')(r, res));
  const voice = P.createVoice(elEnv({ ELEVENLABS_VOICE_NARRATOR: narrator }), { dataDir: freshDir() });
  const out = await voice.speak({ text: 'Graaah!', voice: 'creature' });
  assert.strictEqual(out.voiceId, narrator);
  assert.strictEqual(voiceIdOf(el.reqs[el.reqs.length - 1]), narrator);
  assert.ok(el.reqs.length >= 3, 'each creature candidate was tried once');
  const before = el.reqs.length;
  const again = await voice.speak({ text: 'Hsss.', voice: 'creature' });
  assert.strictEqual(again.voiceId, narrator);
  assert.strictEqual(el.reqs.length, before + 1, 'bad candidates are not tried again');
  const unknown = await voice.speak({ text: 'Who goes there?', voice: 'no-such-archetype' });
  assert.strictEqual(unknown.voiceId, narrator, 'an unknown archetype uses the narrator');
});

test('elevenlabs: 401 and 429 do not mark a voice bad; 429 and 5xx are retried once', async () => {
  el.reset();
  el.fallback = sendAudio(MP3);
  const voice = P.createVoice(elEnv(), { dataDir: freshDir() });
  el.queue.push(elevenErr(401, 'missing_permissions', `The API key ${E_KEY} is missing the permission text_to_speech`));
  const e = await rejects(voice.speak({ text: 'One.', voice: 'sage' }), 'auth');
  assert.ok(!e.message.includes(E_KEY), 'key value must not appear in the error');
  assert.strictEqual(el.reqs.length, 1, 'auth errors are not retried and do not fall through');
  const first = voiceIdOf(el.reqs[0]);
  el.queue.push(elevenErr(429, 'concurrent_limit_exceeded', 'too many', { 'retry-after': '0' }));
  await voice.speak({ text: 'Two.', voice: 'sage' });
  assert.strictEqual(el.reqs.length, 3);
  assert.strictEqual(voiceIdOf(el.reqs[1]), first);
  assert.strictEqual(voiceIdOf(el.reqs[2]), first, 'same voice after the 429 retry');
  el.queue.push(sendJson(503, 'unavailable'));
  await voice.speak({ text: 'Three.', voice: 'sage' });
  assert.strictEqual(el.reqs.length, 5);
  assert.deepStrictEqual(voice.info().bad, []);
  el.queue.push(elevenErr(400, 'invalid_api_key', 'Invalid API key'));
  await rejects(voice.speak({ text: 'Four.', voice: 'sage' }), 'auth');
  el.queue.push(elevenErr(401, 'quota_exceeded', 'This request exceeds your quota'));
  await rejects(voice.speak({ text: 'Five.', voice: 'sage' }), 'quota');
  el.queue.push(elevenErr(402, 'insufficient_credits', 'Not enough credits'));
  await rejects(voice.speak({ text: 'Six.', voice: 'sage' }), 'quota');
  assert.deepStrictEqual(voice.info().bad, [], 'key and quota problems never poison the cast');
  assert.ok(warnings.every((w) => !w.includes(E_KEY)), 'no key value in any log line');
});

test('elevenlabs: emotion tags reach the expressive model and are stripped for the fast one', async () => {
  el.reset();
  el.fallback = sendAudio(MP3);
  await P.createVoice(elEnv(), { dataDir: freshDir() }).speak({ text: '[whispers] Keep your voice down.', voice: 'narrator' });
  assert.strictEqual(el.reqs[0].body.text, '[whispers] Keep your voice down.');
  await P.createVoice(Object.assign(elEnv(), { ELEVENLABS_MODEL: 'eleven_flash_v2_5' }), { dataDir: freshDir() }).speak({ text: '[whispers] Keep your voice down.', voice: 'narrator' });
  assert.strictEqual(el.reqs[1].body.text, 'Keep your voice down.');
});

test('elevenlabs: text is capped at 1200 characters and empty text is rejected', async () => {
  el.reset();
  el.fallback = sendAudio(MP3);
  const voice = P.createVoice(elEnv(), { dataDir: freshDir() });
  const long = 'The wind howls across the pass. '.repeat(80);
  await voice.speak({ text: long, voice: 'narrator' });
  const sent = el.reqs[0].body.text;
  assert.ok(sent.length <= 1200 && sent.length > 700, `sent ${sent.length} characters`);
  assert.ok(sent.endsWith('.'), 'cut at a sentence end');
  assert.strictEqual(voice.chars, sent.length);
  await rejects(voice.speak({ text: '   ', voice: 'narrator' }), 'bad_request');
  assert.strictEqual(el.reqs.length, 1);
});

test('elevenlabs: language_code is sent for other languages and dropped if the API refuses it', async () => {
  el.reset();
  el.fallback = sendAudio(MP3);
  const voice = P.createVoice(Object.assign(elEnv(), { ELEVENLABS_MODEL: 'eleven_flash_v2_5' }), { dataDir: freshDir() });
  await voice.speak({ text: 'Bienvenidos, viajeros.', voice: 'narrator', lang: 'Spanish' });
  assert.strictEqual(el.reqs[0].body.language_code, 'es');
  el.queue.push(elevenErr(400, 'unsupported_language', 'language_code is not supported'));
  await voice.speak({ text: 'Bonsoir, voyageurs.', voice: 'narrator', lang: 'French' });
  assert.strictEqual(el.reqs.length, 3);
  assert.strictEqual(el.reqs[1].body.language_code, 'fr');
  assert.ok(!('language_code' in el.reqs[2].body));
  assert.strictEqual(voiceIdOf(el.reqs[2]), voiceIdOf(el.reqs[1]), 'same voice, it was not marked bad');
  assert.deepStrictEqual(voice.info().bad, []);
  await voice.speak({ text: 'Guten Abend.', voice: 'narrator', lang: 'German' });
  assert.ok(!('language_code' in el.reqs[3].body), 'stays off afterwards');
});

test('elevenlabs: memory cache is a bounded LRU', async () => {
  el.reset();
  const big = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(600 * 1024, 1)]);
  el.fallback = sendAudio(big);
  const voice = P.createVoice(elEnv({ VOICE_CACHE_MB: '1' }), {});       // no dataDir: memory only
  await voice.speak({ text: 'First line.', voice: 'narrator' });
  await voice.speak({ text: 'Second line.', voice: 'narrator' });
  assert.strictEqual(el.reqs.length, 2);
  await voice.speak({ text: 'Second line.', voice: 'narrator' });
  assert.strictEqual(el.reqs.length, 2, 'newest entry is still cached');
  await voice.speak({ text: 'First line.', voice: 'narrator' });
  assert.strictEqual(el.reqs.length, 3, 'oldest entry was evicted to stay under the limit');
});

test('elevenlabs: an unwritable data directory is tolerated', async () => {
  el.reset();
  el.fallback = sendAudio(MP3);
  const blocker = path.join(RUN_DIR, 'not-a-directory');
  fs.writeFileSync(blocker, 'x');
  const voice = P.createVoice(elEnv(), { dataDir: path.join(blocker, 'data') });
  const a = await voice.speak({ text: 'Still works.', voice: 'noble' });
  const b = await voice.speak({ text: 'Still works.', voice: 'noble' });
  assert.ok(a.buffer.equals(MP3) && b.buffer.equals(MP3));
  assert.strictEqual(el.reqs.length, 1, 'memory cache still serves the second call');
  el.fallback = sendAudio(MP3);
  assert.ok((await voice.sfx('cave')).buffer.equals(MP3));
});

test('elevenlabs: sfx request shape, caching, single-flight and failure handling', async () => {
  el.reset();
  el.fallback = sendAudio(MP3, 40);
  const dir = freshDir();
  const voice = P.createVoice(elEnv(), { dataDir: dir });
  assert.strictEqual(await voice.sfx('none'), null);
  assert.strictEqual(await voice.sfx('disco'), null);
  assert.strictEqual(await voice.sfx('__proto__'), null);
  assert.strictEqual(await voice.sfx(), null);
  assert.strictEqual(el.reqs.length, 0, 'no upstream call for none / unknown names');

  const [a, b] = await Promise.all([voice.sfx('tavern'), voice.sfx('tavern')]);
  assert.strictEqual(el.reqs.length, 1, 'single-flight');
  assert.strictEqual(a.mime, 'audio/mpeg');
  assert.ok(a.buffer.equals(MP3) && b.buffer.equals(MP3));
  const r = el.reqs[0];
  assert.strictEqual(r.method, 'POST');
  assert.strictEqual(r.url, '/v1/sound-generation');
  assert.strictEqual(r.headers['xi-api-key'], E_KEY);
  assert.strictEqual(typeof r.body.text, 'string');
  assert.ok(/tavern/i.test(r.body.text));
  assert.strictEqual(r.body.duration_seconds, 10);
  assert.strictEqual(r.body.loop, true);
  assert.strictEqual(r.body.model_id, 'eleven_text_to_sound_v3');

  assert.ok((await voice.sfx('tavern')).buffer.equals(MP3));
  assert.strictEqual(el.reqs.length, 1, 'cached in memory');
  const files = fs.readdirSync(path.join(dir, 'sfx'));
  assert.strictEqual(files.length, 1);
  assert.ok(/^tavern-[0-9a-f]+\.mp3$/.test(files[0]), files[0]);
  const second = P.createVoice(elEnv(), { dataDir: dir });
  assert.ok((await second.sfx('tavern')).buffer.equals(MP3));
  assert.strictEqual(el.reqs.length, 1, 'cached on disk across processes');
  assert.strictEqual(voice.chars, 0, 'sound effects are not counted as speech characters');

  // `loop` refused: retried once with the bare { text, duration_seconds } body.
  el.queue.push(sendJson(422, { detail: [{ loc: ['body', 'loop'], msg: 'extra fields not permitted', type: 'value_error' }] }));
  assert.ok((await voice.sfx('forest')).buffer.equals(MP3));
  assert.strictEqual(el.reqs.length, 3);
  assert.deepStrictEqual(Object.keys(el.reqs[2].body).sort(), ['duration_seconds', 'text']);

  // Any failure resolves null, and the name is not hammered again straight away.
  el.queue.push(sendJson(500, 'boom'), sendJson(500, 'boom'));
  assert.strictEqual(await voice.sfx('storm'), null);
  assert.strictEqual(el.reqs.length, 5);
  assert.strictEqual(await voice.sfx('storm'), null);
  assert.strictEqual(el.reqs.length, 5);
  el.queue.push(elevenErr(401, 'missing_permissions', 'missing sound_generation'));
  assert.strictEqual(await voice.sfx('crypt'), null);
  assert.strictEqual(await voice.sfx('camp'), null);
  assert.strictEqual(el.reqs.length, 6, 'a key problem pauses all generation');
  assert.ok((await voice.sfx('tavern')).buffer.equals(MP3), 'cached loops keep working');

  // Every ambience value except "none" has a prompt.
  el.reset();
  el.fallback = sendAudio(MP3);
  const all = P.createVoice(elEnv(), { dataDir: freshDir() });
  for (const name of ['tavern', 'town', 'forest', 'cave', 'dungeon', 'crypt', 'mountain', 'storm', 'camp', 'combat']) {
    assert.ok(await all.sfx(name), name);
  }
  assert.strictEqual(el.reqs.length, 10);
  assert.strictEqual(new Set(el.reqs.map((q) => q.body.text)).size, 10);
});

/* ---------------------------------------------------------------- voice: Gemini speech */

test('gemini speech: request shape, WAV output, cache, no sfx', async () => {
  gem.reset();
  const pcm = Buffer.alloc(4800, 3);
  gem.fallback = sendJson(200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm.toString('base64') } }] }, finishReason: 'STOP' }] });
  const dir = freshDir();
  const voice = P.createVoice({ GEMINI_API_KEY: G_KEY, AIDND_GEMINI_URL: gem.url }, { dataDir: dir });
  assert.strictEqual(voice.name, 'gemini');
  const out = await voice.speak({ text: 'Welcome, travelers.', voice: 'cheerful', lang: 'English' });
  assert.strictEqual(out.mime, 'audio/wav');
  assert.strictEqual(out.buffer.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(out.buffer.toString('ascii', 8, 12), 'WAVE');
  assert.strictEqual(out.buffer.readUInt32LE(24), 24000);
  assert.strictEqual(out.buffer.length, 44 + pcm.length);
  const r = gem.reqs[0];
  assert.strictEqual(r.url, '/v1beta/models/gemini-3.8-flash-tts:generateContent');
  assert.strictEqual(r.headers['x-goog-api-key'], G_KEY);
  assert.deepStrictEqual(r.body.generationConfig.responseModalities, ['AUDIO']);
  assert.strictEqual(typeof r.body.generationConfig.speechConfig.voiceConfig.voice, 'string');
  assert.strictEqual(r.body.contents[0].parts[0].text, 'Welcome, travelers.');
  assert.strictEqual(voice.chars, 'Welcome, travelers.'.length);
  await Promise.all([voice.speak({ text: 'Welcome, travelers.', voice: 'cheerful' }), voice.speak({ text: 'Welcome, travelers.', voice: 'cheerful' })]);
  assert.strictEqual(gem.reqs.length, 1, 'cached');
  assert.strictEqual(fs.readdirSync(path.join(dir, 'tts')).filter((f) => f.endsWith('.wav')).length, 1);
  assert.strictEqual(await voice.sfx('tavern'), null);
  const voices = new Set();
  for (const a of ['narrator', 'gruff', 'sage', 'young', 'sinister', 'noble', 'cheerful', 'creature']) {
    await voice.speak({ text: `Line for ${a}.`, voice: a });
    voices.add(gem.reqs[gem.reqs.length - 1].body.generationConfig.speechConfig.voiceConfig.voice);
  }
  assert.strictEqual(voices.size, 8, 'each archetype has its own voice');
  gem.fallback = null;
  gem.queue.push(geminiErr(403, 'PERMISSION_DENIED', `key ${G_KEY} rejected`));
  const e = await rejects(voice.speak({ text: 'Another line.', voice: 'sage' }), 'auth');
  assert.ok(!e.message.includes(G_KEY));
});

/* ---------------------------------------------------------------- live ElevenLabs (opt-in) */

const LIVE_LINES = {
  narrator: 'The road bends toward Emberpeak.',
  gruff: 'Keep your blade close, traveler.',
  sage: 'Old paths remember old names.',
  young: 'Wait for me, I can help!',
  sinister: 'You should not have come here.',
  noble: 'The court will hear you now.',
  cheerful: 'Welcome in, warm stew is ready!',
  creature: 'Leave... my... cave...',
};

if (LIVE) {
  test('LIVE elevenlabs: one short line per archetype, one Spanish line, one ambience loop', async () => {
    assert.ok(process.env.ELEVENLABS_API_KEY, 'ELEVENLABS_API_KEY must be set for the live part');
    assert.ok(!process.env.AIDND_ELEVENLABS_URL, 'AIDND_ELEVENLABS_URL must not be set for the live part');
    const dir = path.join(DATA_ROOT, 'live');             // kept between runs, so repeats cost nothing
    const env = { ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY };
    for (const k of Object.keys(process.env)) if (/^ELEVENLABS_(MODEL|SFX_MODEL|VOICE_[A-Z]+)$/.test(k)) env[k] = process.env[k];
    const voice = P.createVoice(env, { dataDir: dir });
    assert.strictEqual(voice.name, 'elevenlabs');
    const warnedBefore = warnings.length;
    const report = { at: new Date().toISOString(), model: voice.model, archetypes: {}, failures: {} };
    for (const [archetype, text] of Object.entries(LIVE_LINES)) {
      assert.ok(text.length <= 40);
      const t0 = Date.now();
      try {
        const out = await voice.speak({ text, voice: archetype, lang: 'English' });
        assert.strictEqual(out.mime, 'audio/mpeg');
        assert.ok(isMp3(out.buffer), `${archetype}: reply is an MP3`);
        report.archetypes[archetype] = { voiceId: out.voiceId, cached: out.cached, ms: Date.now() - t0, bytes: out.buffer.length, chars: text.length };
      } catch (e) {
        report.failures[archetype] = `${e.code}: ${e.message}`;
      }
    }
    const t1 = Date.now();
    try {
      const es = await voice.speak({ text: 'Bienvenidos, viajeros cansados.', voice: 'narrator', lang: 'Spanish' });
      report.spanish = { ok: isMp3(es.buffer), voiceId: es.voiceId, cached: es.cached, ms: Date.now() - t1, languageCodeAccepted: voice.info().languageCodes };
    } catch (e) { report.spanish = { ok: false, error: `${e.code}: ${e.message}` }; }
    const t2 = Date.now();
    const loop = await voice.sfx('tavern');
    report.sfx = loop ? { ok: isMp3(loop.buffer), cached: loop.cached, ms: Date.now() - t2, bytes: loop.buffer.length } : { ok: false };
    report.badVoiceIds = voice.info().bad;
    report.charsSpent = voice.chars;
    report.sfxGenerated = voice.info().sfxGenerated;
    report.warnings = warnings.slice(warnedBefore);
    fs.writeFileSync(path.join(DATA_ROOT, `live-result-${Date.now()}.json`), JSON.stringify(report, null, 2));
    console.log('LIVE REPORT ' + JSON.stringify(report, null, 2));
    assert.deepStrictEqual(report.failures, {}, 'every archetype produced audio');
    assert.ok(report.spanish.ok, 'the Spanish line produced audio');
    assert.ok(report.sfx.ok, 'the ambience loop was generated');
    assert.ok(voice.chars <= 600, `spent ${voice.chars} characters`);
    assert.ok(report.sfxGenerated <= 2);
  });
}

/* ---------------------------------------------------------------- run */

(async () => {
  await Promise.all([anth.start(), gem.start(), el.start()]);
  let failed = 0;
  for (const t of tests) {
    const t0 = Date.now();
    try {
      await t.fn();
      console.log(`ok   ${t.name} (${Date.now() - t0} ms)`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${t.name}\n     ${String((e && e.stack) || e).split('\n').join('\n     ')}`);
    }
  }
  await Promise.all([anth.stop(), gem.stop(), el.stop()]);
  try { fs.rmSync(RUN_DIR, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  console.warn = realWarn;
  console.log(`\n${tests.length - failed}/${tests.length} passed${LIVE ? ' (including the live ElevenLabs part)' : ' (live ElevenLabs part skipped: set ELEVENLABS_LIVE=1)'}`);
  process.exit(failed ? 1 : 0);
})();
