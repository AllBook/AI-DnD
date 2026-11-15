#!/usr/bin/env node
/*
 * AI-DnD Online — multiplayer server. No dependencies: `node server.js`.
 *
 *   PORT             port to listen on (default 3000)
 *   GEMINI_API_KEY   optional; turns on the AI Dungeon Master narrator
 *   GEMINI_MODEL     optional; default gemini-2.5-flash
 *
 * Players create a room, share its 4-letter code or link, and every browser
 * holds one Server-Sent Events stream of room state. Actions are POSTed.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Engine = require('./engine.js');
const DATA = require('./data.json');

const PORT = Number(process.env.PORT) || 3000;
const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const MAX_ROOMS = 500;
const ROOM_TTL_MS = 12 * 60 * 60 * 1000;

/** code -> { room, tokens: Map<token, playerId>, clients: Set<{res, pid}>, pending } */
const rooms = new Map();

const STATIC = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/index.html': ['public/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['public/style.css', 'text/css; charset=utf-8'],
  '/engine.js': ['engine.js', 'text/javascript; charset=utf-8'],
};
const dataJs = 'window.DND_DATA = ' + JSON.stringify(DATA) + ';';

function newCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += letters[crypto.randomInt(letters.length)];
    if (!rooms.has(c)) return c;
  }
}

function snapshot(entry) {
  return JSON.stringify(Object.assign({}, entry.room, { ai: !!GEMINI_KEY }));
}

function broadcast(entry) {
  const online = new Set([...entry.clients].map((c) => c.pid));
  for (const id in entry.room.players) entry.room.players[id].online = online.has(id);
  const msg = `data: ${snapshot(entry)}\n\n`;
  for (const c of entry.clients) c.res.write(msg);
}

async function gemini(prompt) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.9, maxOutputTokens: 1024 },
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
  const json = await res.json();
  const parts = (json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts) || [];
  return parts.map((p) => p.text || '').join('').trim();
}

function narrate(entry, requests) {
  if (!GEMINI_KEY) return;
  for (const req of requests) {
    if (entry.pending >= 4) return;
    entry.pending += 1;
    gemini(req.prompt)
      .then((text) => { if (text && Engine.setNarration(entry.room, req.id, text)) broadcast(entry); })
      .catch((err) => console.warn('narrator:', err.message))
      .finally(() => { entry.pending -= 1; });
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 8192) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function send(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function seat(entry, name, token) {
  if (token && entry.tokens.has(token)) return { token, playerId: entry.tokens.get(token) };
  const playerId = 'p' + crypto.randomBytes(5).toString('hex');
  const r = Engine.addPlayer(entry.room, playerId, name);
  if (!r.ok) return { error: r.error };
  token = crypto.randomBytes(16).toString('hex');
  entry.tokens.set(token, playerId);
  return { token, playerId };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
      return fs.createReadStream(path.join(__dirname, file)).pipe(res);
    }
    if (req.method === 'GET' && url.pathname === '/data.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(dataJs);
    }
    if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true, rooms: rooms.size, ai: !!GEMINI_KEY });

    if (req.method === 'POST' && url.pathname === '/api/create') {
      const body = await readJson(req);
      if (rooms.size >= MAX_ROOMS) return send(res, 503, { error: 'The server is full. Try again later.' });
      const code = newCode();
      const entry = { room: Engine.newRoom(code), tokens: new Map(), clients: new Set(), pending: 0 };
      rooms.set(code, entry);
      const s = seat(entry, body.name);
      return send(res, 200, Object.assign({ code }, s));
    }

    if (req.method === 'POST' && url.pathname === '/api/join') {
      const body = await readJson(req);
      const code = String(body.code || '').toUpperCase().trim();
      const entry = rooms.get(code);
      if (!entry) return send(res, 404, { error: `No party with the code ${code || '…'}. Check the code, or create a new party.` });
      const s = seat(entry, body.name, body.token);
      if (s.error) return send(res, 409, { error: s.error });
      broadcast(entry);
      return send(res, 200, Object.assign({ code }, s));
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      const entry = rooms.get(String(url.searchParams.get('code') || '').toUpperCase());
      const pid = entry && entry.tokens.get(url.searchParams.get('token'));
      if (!pid) return send(res, 404, { error: 'This party no longer exists.' });
      res.writeHead(200, {
        'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive', 'x-accel-buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      const client = { res, pid };
      entry.clients.add(client);
      broadcast(entry);
      req.on('close', () => { entry.clients.delete(client); broadcast(entry); });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/action') {
      const body = await readJson(req);
      const entry = rooms.get(String(body.code || '').toUpperCase());
      const pid = entry && entry.tokens.get(body.token);
      if (!pid) return send(res, 404, { error: 'This party no longer exists.' });
      const now = Date.now();
      if (now - (entry.last && entry.last[pid] || 0) < 40) return send(res, 429, { error: 'Slow down a little.' });
      (entry.last = entry.last || {})[pid] = now;
      const result = Engine.act(entry.room, pid, body.action);
      if (!result.ok) return send(res, 200, { ok: false, error: result.error });
      broadcast(entry);
      narrate(entry, result.narr);
      return send(res, 200, { ok: true });
    }

    send(res, 404, { error: 'Not found' });
  } catch (err) {
    if (!res.headersSent) send(res, 400, { error: 'Bad request' });
    else res.end();
  }
});

// Keep proxies from closing idle streams, and drop rooms nobody has used.
setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of rooms) {
    for (const c of entry.clients) c.res.write(': ping\n\n');
    if (!entry.clients.size && now - entry.room.updated > ROOM_TTL_MS) rooms.delete(code);
  }
}, 15000).unref();

server.listen(PORT, () => {
  console.log(`AI-DnD Online listening on http://localhost:${PORT}`);
  console.log(GEMINI_KEY ? `AI Dungeon Master: on (${GEMINI_MODEL})` : 'AI Dungeon Master: off — set GEMINI_API_KEY to turn it on. Built-in narration is used meanwhile.');
});
