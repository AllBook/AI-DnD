/* AI-DnD Online: audio.js
 * Defines window.GameAudio (see CONTRACT.md section 5). Classic script, no dependencies.
 *
 *   GameAudio.init({ mode, ttsUrl, sfxUrl, caps, lang? })   mode: 'server' | 'browser' | 'artifact' | 'off'
 *   GameAudio.unlock()                call from a user gesture; idempotent
 *   GameAudio.narrate(entryId, segs)  segs = [{speaker, voice, text}]
 *   GameAudio.stop()
 *   GameAudio.onState(cb)             cb({ playing: entryId|null, seg: index|null }); returns an unsubscribe function
 *   GameAudio.setAmbience(name)       tavern town forest cave dungeon crypt mountain storm camp combat none
 *   GameAudio.sfx(name)               dice hit heal levelup turn notify send
 *   GameAudio.get() / GameAudio.set(patch)   { master, voice, ambience, effects, autoplay }
 *   GameAudio.mic = { available, start(onText, onEnd), stop() }
 *
 * Nothing here throws to the caller: every public method is wrapped, and every path degrades
 * to silence when audio is blocked or unsupported.
 */
(function () {
  'use strict';

  var root = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this);
  var doc = root.document || null;
  var nav = root.navigator || {};

  var STORE_KEY = 'aidnd.audio';
  var MODES = ['server', 'browser', 'artifact', 'off'];
  var ARCHETYPES = ['narrator', 'gruff', 'sage', 'young', 'sinister', 'noble', 'cheerful', 'creature'];
  var AMBIENCES = ['tavern', 'town', 'forest', 'cave', 'dungeon', 'crypt', 'mountain', 'storm', 'camp', 'combat'];
  var XFADE = 1.5;                 // ambience cross-fade, seconds
  var PENDING_MAX_AGE = 20000;     // a reply held back by a locked page is dropped after this long
  var SEG_GAP_MS = 140;

  /* ------------------------------------------------------------------ helpers */

  function noop() {}
  function now() { return Date.now(); }
  function rnd(a, b) { return a + Math.random() * (b - a); }
  function has(arr, v) { return arr.indexOf(v) !== -1; }
  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
  function once(fn) {
    var done = false;
    return function () { if (done) return undefined; done = true; return fn.apply(null, arguments); };
  }
  function safe(fn, fallback) {
    return function () {
      try { return fn.apply(null, arguments); } catch (e) { return fallback; }
    };
  }

  /* ----------------------------------------------------------------- settings */

  var settings = { master: 0.8, voice: 1, ambience: 0.45, effects: 0.7, autoplay: true };

  function mergeSettings(p) {
    if (!p || typeof p !== 'object') return;
    ['master', 'voice', 'ambience', 'effects'].forEach(function (k) {
      if (!own(p, k)) return;
      var v = p[k];
      if (typeof v === 'string' && v.trim() !== '') v = Number(v);
      if (typeof v === 'number' && isFinite(v)) settings[k] = clamp01(v);
    });
    if (own(p, 'autoplay')) settings.autoplay = p.autoplay === 'false' ? false : !!p.autoplay;
  }
  function loadSettings() {
    try {
      var raw = root.localStorage && root.localStorage.getItem(STORE_KEY);
      if (raw) mergeSettings(JSON.parse(raw));
    } catch (e) { /* storage blocked: keep defaults */ }
  }
  function saveSettings() {
    try { if (root.localStorage) root.localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ }
  }
  function getSettings() {
    return { master: settings.master, voice: settings.voice, ambience: settings.ambience, effects: settings.effects, autoplay: settings.autoplay };
  }
  loadSettings();

  /* ------------------------------------------------------------ audio contexts */
  // Two contexts: `ctx` carries voice and effects and keeps running in a hidden tab;
  // `actx` carries ambience only and is suspended whenever it has nothing audible to do.

  var AC = root.AudioContext || root.webkitAudioContext || null;
  var ctx = null, masterG = null, voiceG = null, fxG = null;
  var actx = null, ambG = null;
  var unlocked = false, primedCtx = false, primedSpeech = false;
  var duck = 1;

  function makeCtx(hint) {
    try { return new AC({ latencyHint: hint }); } catch (e) { /* older constructor */ }
    try { return new AC(); } catch (e2) { return null; }
  }
  function ensureContexts() {
    if (!AC) return;
    if (!ctx) {
      try {
        var c = makeCtx('interactive');
        if (c) {
          var m = c.createGain(), v = c.createGain(), f = c.createGain();
          m.gain.value = settings.master; v.gain.value = settings.voice; f.gain.value = settings.effects;
          v.connect(m); f.connect(m); m.connect(c.destination);
          ctx = c; masterG = m; voiceG = v; fxG = f;
        }
      } catch (e) { ctx = null; }
    }
    if (!actx) {
      try {
        var a = makeCtx('playback');
        if (a) {
          var g = a.createGain();
          g.gain.value = settings.master * settings.ambience * duck;
          g.connect(a.destination);
          actx = a; ambG = g;
        }
      } catch (e2) { actx = null; }
    }
  }
  function resume(c) {
    try {
      var p = c.resume();
      if (p && typeof p.then === 'function') { p.then(noop, noop); return p; }
    } catch (e) { /* ignore */ }
    return Promise.resolve();
  }
  function setParam(param, value, c) {
    try {
      param.cancelScheduledValues(c.currentTime);
      param.setTargetAtTime(value, c.currentTime, 0.03);
    } catch (e) {
      try { param.value = value; } catch (e2) { /* ignore */ }
    }
  }
  function applyVolumes() {
    if (ctx && masterG) {
      setParam(masterG.gain, settings.master, ctx);
      setParam(voiceG.gain, settings.voice, ctx);
      setParam(fxG.gain, settings.effects, ctx);
    }
    if (actx && ambG) setParam(ambG.gain, settings.master * settings.ambience * duck, actx);
    if (curEl) { try { curEl.volume = clamp01(settings.master * settings.voice); } catch (e) { /* ignore */ } }
    syncAmbRun();
  }

  /* --------------------------------------------------------- synthesis helpers */

  // Cross-fade the tail of a buffer into its head so that it loops without a click.
  function seamless(c, buf, fadeSec) {
    var n = Math.min(Math.floor(fadeSec * buf.sampleRate), Math.floor(buf.length / 4));
    if (n < 16) return buf;
    var len = buf.length - n, out = c.createBuffer(buf.numberOfChannels, len, buf.sampleRate), ch, i, t, src, dst;
    for (ch = 0; ch < buf.numberOfChannels; ch++) {
      src = buf.getChannelData(ch); dst = out.getChannelData(ch);
      dst.set(src.subarray(0, len));
      for (i = 0; i < n; i++) {
        t = i / n;
        dst[i] = src[i] * Math.sqrt(t) + src[len + i] * Math.sqrt(1 - t);
      }
    }
    return out;
  }
  // Four seconds of looping noise per colour, generated once per context.
  function noiseBuffer(c, kind) {
    var store = c._aidndNoise || (c._aidndNoise = {});
    if (store[kind]) return store[kind];
    var sr = c.sampleRate, len = Math.floor(sr * 4.1), buf = c.createBuffer(1, len, sr), d = buf.getChannelData(0), i, w;
    if (kind === 'pink') {
      var b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (i = 0; i < len; i++) {
        w = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      }
    } else if (kind === 'brown') {
      var last = 0;
      for (i = 0; i < len; i++) {
        w = Math.random() * 2 - 1;
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.5;
      }
    } else {
      for (i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    store[kind] = seamless(c, buf, 0.1);
    return store[kind];
  }
  // A short enveloped oscillator. o: {type, f, f1, sweep, t, dur, gain, attack}
  function tone(c, to, o) {
    var t = o.t, dur = o.dur, osc = c.createOscillator(), g = c.createGain();
    var a = Math.min(o.attack || 0.005, dur * 0.5);
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(Math.max(1, o.f), t);
    if (o.f1) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.f1), t + (o.sweep || dur));
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(Math.max(0.0002, o.gain), t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g); g.connect(to);
    osc.start(t); osc.stop(t + dur + 0.05);
    osc.onended = function () { try { g.disconnect(); } catch (e) { /* ignore */ } };
  }
  // A short enveloped, filtered noise burst. o: {kind, ftype, f, f1, q, t, dur, gain, attack}
  function burst(c, to, o) {
    var t = o.t, dur = o.dur, src = c.createBufferSource(), fl = c.createBiquadFilter(), g = c.createGain();
    var a = Math.min(o.attack || 0.004, dur * 0.5);
    src.buffer = noiseBuffer(c, o.kind || 'white'); src.loop = true;
    fl.type = o.ftype || 'bandpass';
    fl.frequency.setValueAtTime(o.f || 1000, t);
    if (o.f1) fl.frequency.exponentialRampToValueAtTime(o.f1, t + dur);
    fl.Q.value = o.q != null ? o.q : 1;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(Math.max(0.0002, o.gain), t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(fl); fl.connect(g); g.connect(to);
    src.start(t, Math.random() * 3.5); src.stop(t + dur + 0.05);
    src.onended = function () { try { g.disconnect(); } catch (e) { /* ignore */ } };
  }
  function bell(c, to, t, f, gain, dur) {
    [[1, 1], [2.0, 0.6], [2.76, 0.4], [4.07, 0.25], [5.4, 0.12]].forEach(function (p) {
      tone(c, to, { f: f * p[0], t: t, dur: dur / (0.6 + p[0] * 0.4), gain: gain * p[1], attack: 0.004 });
    });
  }

  /* --------------------------------------------------------------------- effects */

  var SFX = {
    dice: function (c, to, t) {
      var n = 6 + (Math.random() * 3 | 0), i, at = t;
      for (i = 0; i < n; i++) {
        burst(c, to, { kind: 'white', f: rnd(1800, 4200), q: 3, t: at, dur: 0.03, gain: 0.5 * rnd(0.5, 1), attack: 0.001 });
        tone(c, to, { type: 'triangle', f: rnd(300, 520), t: at, dur: 0.03, gain: 0.07, attack: 0.001 });
        at += 0.04 + i * 0.012 + Math.random() * 0.02;
      }
      burst(c, to, { kind: 'white', f: 1200, q: 2, t: at + 0.03, dur: 0.07, gain: 0.6, attack: 0.001 });
      tone(c, to, { f: 230, f1: 140, t: at + 0.03, dur: 0.1, gain: 0.2, attack: 0.002 });
    },
    hit: function (c, to, t) {
      tone(c, to, { f: 170, f1: 45, t: t, dur: 0.26, gain: 0.7, attack: 0.002 });
      burst(c, to, { kind: 'white', ftype: 'lowpass', f: 2200, q: 0.7, t: t, dur: 0.13, gain: 0.4, attack: 0.001 });
      burst(c, to, { kind: 'white', f: 3500, q: 1.5, t: t, dur: 0.04, gain: 0.25, attack: 0.001 });
    },
    heal: function (c, to, t) {
      [523.25, 659.25, 783.99, 1046.5].forEach(function (f, i) {
        tone(c, to, { f: f, t: t + i * 0.09, dur: 0.9, gain: 0.12, attack: 0.02 });
        tone(c, to, { type: 'triangle', f: f * 2.003, t: t + i * 0.09, dur: 0.5, gain: 0.025, attack: 0.02 });
      });
      burst(c, to, { kind: 'white', ftype: 'highpass', f: 6000, q: 0.5, t: t, dur: 0.9, gain: 0.03, attack: 0.3 });
    },
    levelup: function (c, to, t) {
      [392, 523.25, 659.25, 783.99].forEach(function (f, i) {
        tone(c, to, { type: 'triangle', f: f, t: t + i * 0.11, dur: 0.26, gain: 0.17, attack: 0.008 });
        tone(c, to, { type: 'square', f: f, t: t + i * 0.11, dur: 0.2, gain: 0.025, attack: 0.008 });
      });
      [523.25, 659.25, 783.99, 1046.5].forEach(function (f) {
        tone(c, to, { type: 'triangle', f: f, t: t + 0.46, dur: 1.3, gain: 0.11, attack: 0.01 });
        tone(c, to, { f: f * 2, t: t + 0.46, dur: 0.9, gain: 0.03, attack: 0.01 });
      });
      burst(c, to, { kind: 'white', ftype: 'highpass', f: 5000, q: 0.5, t: t + 0.46, dur: 1.1, gain: 0.035, attack: 0.05 });
    },
    turn: function (c, to, t) {
      tone(c, to, { f: 659.25, t: t, dur: 0.5, gain: 0.16, attack: 0.006 });
      tone(c, to, { f: 1318.5, t: t, dur: 0.3, gain: 0.03, attack: 0.006 });
      tone(c, to, { f: 880, t: t + 0.14, dur: 0.75, gain: 0.16, attack: 0.006 });
      tone(c, to, { f: 1760, t: t + 0.14, dur: 0.4, gain: 0.03, attack: 0.006 });
    },
    notify: function (c, to, t) {
      tone(c, to, { f: 987.77, t: t, dur: 0.35, gain: 0.12, attack: 0.006 });
      tone(c, to, { f: 1318.5, t: t + 0.11, dur: 0.5, gain: 0.1, attack: 0.006 });
    },
    send: function (c, to, t) {
      tone(c, to, { f: 420, f1: 780, t: t, dur: 0.1, gain: 0.09, attack: 0.012 });
    }
  };
  var sfxLast = {};

  function sfx(name) {
    if (typeof name !== 'string' || !own(SFX, name)) return;
    if (!unlocked || !ctx || !fxG) return;
    if (ctx.state !== 'running') { resume(ctx); return; }
    if (settings.master * settings.effects < 0.001) return;
    var t0 = now();
    if (sfxLast[name] && t0 - sfxLast[name] < 50) return;
    sfxLast[name] = t0;
    SFX[name](ctx, fxG, ctx.currentTime + 0.01);
  }

  /* -------------------------------------------------------------------- ambience */

  // A scene is a small node graph feeding one output gain; S.every() schedules sparse random events.
  function makeScene(c, dest, level) {
    var S = { c: c, dead: false, level: level, srcs: [], slots: [], panL: null, panR: null };
    S.out = c.createGain(); S.out.gain.value = 0; S.out.connect(dest);
    if (c.createStereoPanner) {
      S.panL = c.createStereoPanner(); S.panL.pan.value = -0.6; S.panL.connect(S.out);
      S.panR = c.createStereoPanner(); S.panR.pan.value = 0.6; S.panR.connect(S.out);
    }
    S.side = function () {
      var r = Math.random();
      return r < 0.34 || !S.panL ? S.out : (r < 0.67 ? S.panL : S.panR);
    };
    S.gain = function (v, to) { var g = c.createGain(); g.gain.value = v; g.connect(to || S.out); return g; };
    S.filter = function (type, f, q, to) {
      var b = c.createBiquadFilter(); b.type = type; b.frequency.value = f;
      if (q != null) b.Q.value = q;
      b.connect(to || S.out); return b;
    };
    S.noise = function (kind, to, rate) {
      var s = c.createBufferSource(); s.buffer = noiseBuffer(c, kind); s.loop = true;
      if (rate) s.playbackRate.value = rate;
      s.connect(to); s.start(0, Math.random() * 3.5); S.srcs.push(s); return s;
    };
    S.osc = function (type, f, to) {
      var o = c.createOscillator(); o.type = type; o.frequency.value = f;
      o.connect(to); o.start(); S.srcs.push(o); return o;
    };
    S.lfo = function (hz, depth, param) {
      var g = c.createGain(); g.gain.value = depth; g.connect(param);
      return S.osc('sine', hz, g);
    };
    // A bus that is heard dry and through a damped feedback echo.
    S.wet = function (time, fb, lp, wetGain) {
      var bus = c.createGain(), d = c.createDelay(1.5), f = c.createBiquadFilter(), g = c.createGain(), w = c.createGain();
      d.delayTime.value = time; f.type = 'lowpass'; f.frequency.value = lp; g.gain.value = fb; w.gain.value = wetGain;
      bus.connect(S.out); bus.connect(d); d.connect(f); f.connect(g); g.connect(d); f.connect(w); w.connect(S.out);
      return bus;
    };
    S.every = function (minS, maxS, fn, firstS) {
      var slot = { id: 0 };
      S.slots.push(slot);
      function arm(sec) {
        slot.id = setTimeout(function () {
          if (S.dead) return;
          if (c.state === 'running' && !(doc && doc.hidden)) {
            try { fn(c.currentTime + 0.03); } catch (e) { /* ignore one event */ }
          }
          arm(rnd(minS, maxS));
        }, sec * 1000);
      }
      arm(firstS != null ? firstS : rnd(minS, maxS) * 0.6);
    };
    S.fade = function (to, secs) {
      var p = S.out.gain, t = c.currentTime;
      try { p.cancelScheduledValues(t); p.setValueAtTime(p.value, t); p.linearRampToValueAtTime(to, t + secs); }
      catch (e) { try { p.value = to; } catch (e2) { /* ignore */ } }
    };
    S.kill = function () {
      if (S.dead) return;
      S.dead = true;
      S.slots.forEach(function (s) { clearTimeout(s.id); });
      S.srcs.forEach(function (s) { try { s.stop(); } catch (e) { /* ignore */ } try { s.disconnect(); } catch (e2) { /* ignore */ } });
      try { S.out.disconnect(); } catch (e) { /* ignore */ }
      S.srcs = []; S.slots = [];
    };
    return S;
  }

  function crackle(S, minS, maxS, g) {
    S.every(minS, maxS, function (t) {
      var big = Math.random() < 0.18;
      burst(S.c, S.out, {
        kind: 'white', ftype: big ? 'bandpass' : 'highpass', f: big ? rnd(900, 1800) : rnd(2500, 6000), q: big ? 1.5 : 0.7,
        t: t, dur: big ? rnd(0.03, 0.08) : rnd(0.008, 0.03), gain: g * (big ? 1.6 : rnd(0.3, 1)), attack: 0.001
      });
    });
  }
  function wind(S, f, q, g, sweepHz, rate) {
    var gn = S.gain(g), fl = S.filter('bandpass', f, q, gn);
    S.noise('pink', fl, rate);
    S.lfo(rnd(0.05, 0.09), sweepHz, fl.frequency);
    S.lfo(rnd(0.09, 0.14), g * 0.45, gn.gain);
    S.lfo(rnd(0.03, 0.05), g * 0.3, gn.gain);
    return gn;
  }
  function bird(S, t, g) {
    var c = S.c, to = S.side(), kind = Math.random(), f = rnd(2600, 4800), i, n;
    if (kind < 0.4) {
      n = 3 + (Math.random() * 6 | 0);
      for (i = 0; i < n; i++) tone(c, to, { f: f, f1: f * rnd(1.05, 1.25), t: t + i * 0.075, dur: 0.05, gain: g, attack: 0.006 });
    } else if (kind < 0.75) {
      tone(c, to, { f: f, f1: f * 0.72, t: t, dur: 0.16, gain: g, attack: 0.02 });
      tone(c, to, { f: f * 0.8, f1: f * 0.62, t: t + 0.22, dur: 0.2, gain: g * 0.8, attack: 0.02 });
    } else {
      n = 2 + (Math.random() * 3 | 0);
      for (i = 0; i < n; i++) tone(c, to, { f: f * 0.7, f1: f * 1.2, t: t + i * 0.19, dur: 0.12, gain: g, attack: 0.015 });
    }
  }
  function drip(S, t, to, g) {
    var f = rnd(650, 1500);
    tone(S.c, to, { f: f, f1: f * rnd(1.6, 2.2), sweep: 0.05, t: t, dur: rnd(0.07, 0.13), gain: g, attack: 0.002 });
  }
  function thunder(S, t) {
    var c = S.c, close = Math.random() < 0.35, dur = rnd(3, 5.5), peak = close ? rnd(0.9, 1.3) : rnd(0.4, 0.8);
    if (close) burst(c, S.out, { kind: 'white', ftype: 'lowpass', f: 3500, f1: 600, q: 0.5, t: t, dur: 0.25, gain: 0.3, attack: 0.004 });
    var src = c.createBufferSource(), fl = c.createBiquadFilter(), g = c.createGain(), p = g.gain;
    var k, n = 2 + (Math.random() * 3 | 0), tt = t + 0.3;
    src.buffer = noiseBuffer(c, 'brown'); src.loop = true;
    fl.type = 'lowpass'; fl.Q.value = 0.7;
    fl.frequency.setValueAtTime(close ? 500 : 260, t);
    fl.frequency.exponentialRampToValueAtTime(70, t + dur);
    p.setValueAtTime(0.0001, t);
    p.linearRampToValueAtTime(peak, t + (close ? 0.05 : 0.5));
    for (k = 0; k < n; k++) {
      tt += rnd(0.3, 0.8);
      if (tt > t + dur - 0.6) break;
      p.linearRampToValueAtTime(peak * rnd(0.25, 0.5), tt);
      tt += rnd(0.15, 0.35);
      p.linearRampToValueAtTime(peak * rnd(0.5, 0.9) * (1 - k / (n + 1)), tt);
    }
    p.linearRampToValueAtTime(0.0001, t + dur);
    src.connect(fl); fl.connect(g); g.connect(S.out);
    src.start(t, Math.random() * 3); src.stop(t + dur + 0.1);
    src.onended = function () { try { g.disconnect(); } catch (e) { /* ignore */ } };
  }

  var LEVEL = { tavern: 1, town: 1, forest: 1, cave: 1, dungeon: 1, crypt: 1, mountain: 1, storm: 1, camp: 1, combat: 1 };

  var BUILD = {
    tavern: function (S) {
      var c = S.c;
      var hearth = S.gain(0.22); S.noise('brown', S.filter('lowpass', 420, 0.5, hearth)); S.lfo(0.31, 0.06, hearth.gain);
      crackle(S, 0.07, 0.45, 0.16);
      var m1 = S.gain(0.2), f1 = S.filter('bandpass', 430, 1.1, m1);
      S.noise('pink', f1); S.lfo(0.21, 0.07, m1.gain); S.lfo(3.3, 0.05, m1.gain); S.lfo(0.09, 110, f1.frequency);
      var m2 = S.gain(0.09), f2 = S.filter('bandpass', 950, 1.6, m2);
      S.noise('pink', f2, 0.83); S.lfo(0.37, 0.04, m2.gain); S.lfo(5.1, 0.03, m2.gain); S.lfo(0.13, 220, f2.frequency);
      S.every(3.5, 10, function (t) {
        var f = rnd(2100, 3400), to = S.side();
        tone(c, to, { f: f, t: t, dur: 0.3, gain: 0.03 });
        tone(c, to, { f: f * 2.71, t: t, dur: 0.15, gain: 0.012 });
        if (Math.random() < 0.4) tone(c, to, { f: f * 1.12, t: t + 0.09, dur: 0.25, gain: 0.02 });
      });
      S.every(8, 21, function (t) { tone(c, S.out, { f: 95, f1: 48, t: t, dur: 0.2, gain: 0.16 }); });
    },
    town: function (S) {
      var c = S.c;
      var air = S.gain(0.11); S.noise('pink', S.filter('lowpass', 900, 0.5, air)); S.lfo(0.07, 0.04, air.gain);
      var cr = S.gain(0.1), cf = S.filter('bandpass', 620, 0.9, cr);
      S.noise('pink', cf, 0.9); S.lfo(0.19, 0.04, cr.gain); S.lfo(3.7, 0.025, cr.gain); S.lfo(0.08, 150, cf.frequency);
      S.every(2.5, 7, function (t) { bird(S, t, 0.022); });
      S.every(9, 20, function (t) {
        var n = 4 + (Math.random() * 6 | 0), to = S.side(), i;
        for (i = 0; i < n; i++) {
          burst(c, to, {
            kind: 'pink', f: i % 2 ? 780 : 1050, q: 5, t: t + i * 0.27 + (i % 2 ? 0.04 : 0), dur: 0.06,
            gain: 0.5 * (0.5 + 0.5 * Math.sin(Math.PI * (i + 0.5) / n)), attack: 0.002
          });
        }
      });
      S.every(24, 55, function (t) {
        var n = 1 + (Math.random() * 3 | 0), i;
        for (i = 0; i < n; i++) bell(c, S.out, t + i * 1.7, 392, 0.045, 3.2);
      }, rnd(6, 14));
      S.every(6, 15, function (t) {
        tone(c, S.side(), { f: rnd(700, 900), t: t, dur: 0.12, gain: 0.02 });
        burst(c, S.out, { f: 2400, q: 2, t: t, dur: 0.04, gain: 0.08 });
      });
    },
    forest: function (S) {
      var c = S.c;
      var lv = S.gain(0.06), lf = S.filter('highpass', 1900, 0.5, lv);
      S.noise('pink', lf); S.lfo(0.09, 0.03, lv.gain); S.lfo(0.31, 0.015, lv.gain);
      wind(S, 320, 0.6, 0.12, 90, 0.8);
      S.every(0.8, 4, function (t) { bird(S, t, rnd(0.02, 0.04)); }, 0.6);
      S.every(3, 9, function (t) { bird(S, t, 0.015); });
      S.every(12, 30, function (t) {
        var n = 6 + (Math.random() * 6 | 0), to = S.side(), i;
        for (i = 0; i < n; i++) burst(c, to, { kind: 'white', f: 1500, q: 4, t: t + i * 0.055, dur: 0.02, gain: 0.25, attack: 0.001 });
      });
      S.every(7, 18, function (t) {
        burst(c, S.side(), { kind: 'pink', ftype: 'highpass', f: 2500, q: 0.5, t: t, dur: rnd(0.4, 1.1), gain: 0.05, attack: 0.2 });
      });
    },
    cave: function (S) {
      var c = S.c, wet = S.wet(0.37, 0.5, 1700, 0.5);
      var dr = S.gain(0.5); S.noise('brown', S.filter('lowpass', 150, 0.7, dr)); S.lfo(0.06, 0.15, dr.gain);
      var ar = S.gain(0.3), af = S.filter('bandpass', 520, 3, ar);
      S.noise('pink', af); S.lfo(0.04, 200, af.frequency); S.lfo(0.11, 0.12, ar.gain);
      S.every(0.7, 3.6, function (t) { drip(S, t, wet, rnd(0.05, 0.12)); }, 0.5);
      S.every(20, 45, function (t) {
        burst(c, S.out, { kind: 'brown', ftype: 'lowpass', f: 110, q: 0.7, t: t, dur: 3, gain: 0.5, attack: 0.8 });
      });
    },
    dungeon: function (S) {
      var c = S.c, wet = S.wet(0.45, 0.55, 1400, 0.6);
      var dg = S.gain(0.06), df = S.filter('lowpass', 170, 2, dg);
      S.osc('sawtooth', 55, df); S.osc('sawtooth', 55.6, df); S.lfo(0.05, 55, df.frequency);
      var sub = S.gain(0.1); S.osc('sine', 36.7, sub); S.lfo(0.08, 0.04, sub.gain);
      var rm = S.gain(0.3); S.noise('brown', S.filter('lowpass', 230, 0.6, rm)); S.lfo(0.07, 0.1, rm.gain);
      crackle(S, 0.09, 0.6, 0.03);
      S.every(7, 18, function (t) {
        var i, n, f;
        if (Math.random() < 0.5) {
          f = rnd(480, 880);
          [1, 1.48, 2.37, 3.11].forEach(function (m, k) {
            tone(c, wet, { type: k ? 'sine' : 'triangle', f: f * m, t: t, dur: 0.6 / (1 + k * 0.4), gain: 0.03 / (1 + k) });
          });
        } else {
          n = 5 + (Math.random() * 6 | 0);
          for (i = 0; i < n; i++) burst(c, wet, { kind: 'white', f: rnd(2800, 4200), q: 7, t: t + i * rnd(0.05, 0.09), dur: 0.035, gain: 0.12, attack: 0.001 });
        }
      }, 3);
      S.every(4, 11, function (t) { drip(S, t, wet, 0.05); });
    },
    crypt: function (S) {
      var c = S.c, wet = S.wet(0.53, 0.6, 1100, 0.7);
      var d1 = S.gain(0.14); S.osc('sine', 41.2, d1); S.osc('sine', 41.55, d1);
      var d2 = S.gain(0.05); S.osc('sine', 61.7, d2); S.lfo(0.05, 0.03, d2.gain);
      var bed = S.gain(0.18); S.noise('brown', S.filter('lowpass', 200, 0.6, bed));
      var w1 = S.gain(0.45), f1 = S.filter('bandpass', 720, 9, w1);
      S.noise('pink', f1); S.lfo(0.06, 340, f1.frequency); S.lfo(0.13, 0.25, w1.gain);
      var w2 = S.gain(0.3), f2 = S.filter('bandpass', 1500, 12, w2);
      S.noise('pink', f2, 1.2); S.lfo(0.045, 480, f2.frequency); S.lfo(0.1, 0.18, w2.gain);
      [[466.2, 0.07], [493.9, 0.11], [698.5, 0.085]].forEach(function (p) {
        var g = S.gain(0.004); S.osc('sine', p[0], g); S.lfo(p[1], 0.004, g.gain);
      });
      S.every(14, 32, function (t) {
        if (Math.random() < 0.5) bell(c, wet, t, 110, 0.05, 6);
        else burst(c, wet, { kind: 'pink', f: 950, f1: 300, q: 6, t: t, dur: 2.6, gain: 0.3, attack: 0.9 });
      }, 5);
    },
    mountain: function (S) {
      var c = S.c;
      wind(S, 520, 0.8, 0.3, 240, 1);
      wind(S, 230, 0.7, 0.2, 80, 0.7);
      var wh = S.gain(0.3), wf = S.filter('bandpass', 1700, 14, wh);
      S.noise('pink', wf, 1.3); S.lfo(0.07, 480, wf.frequency); S.lfo(0.09, 0.22, wh.gain);
      var lo = S.gain(0.25); S.noise('brown', S.filter('lowpass', 180, 0.6, lo));
      S.every(18, 42, function (t) {
        var to = S.side(), i, n, at;
        if (Math.random() < 0.5) {
          for (i = 0; i < 3; i++) tone(c, to, { f: 2700, f1: 1900, t: t + i * 0.62, dur: 0.5, gain: 0.022 / (1 + i), attack: 0.04 });
        } else {
          n = 6 + (Math.random() * 5 | 0); at = t;
          for (i = 0; i < n; i++) {
            burst(c, to, { kind: 'brown', f: rnd(250, 520), q: 2, t: at, dur: rnd(0.08, 0.2), gain: 0.5 * (1 - i / (n + 2)), attack: 0.003 });
            at += rnd(0.1, 0.32);
          }
        }
      }, rnd(6, 14));
    },
    storm: function (S) {
      var r1 = S.gain(0.1), rf = S.filter('highpass', 1100, 0.5, S.filter('lowpass', 7500, 0.5, r1));
      S.noise('white', rf); S.lfo(0.13, 0.03, r1.gain);
      var r2 = S.gain(0.1); S.noise('pink', S.filter('bandpass', 2400, 0.7, r2), 1.1); S.lfo(0.21, 0.03, r2.gain);
      var lo = S.gain(0.22); S.noise('brown', S.filter('lowpass', 480, 0.6, lo));
      wind(S, 380, 1.2, 0.2, 170, 0.9);
      S.every(8, 24, function (t) { thunder(S, t); }, rnd(2, 5));
    },
    camp: function (S) {
      var c = S.c;
      var fire = S.gain(0.26); S.noise('brown', S.filter('lowpass', 520, 0.5, fire)); S.lfo(0.4, 0.07, fire.gain); S.lfo(0.17, 0.04, fire.gain);
      var hiss = S.gain(0.03); S.noise('pink', S.filter('bandpass', 1300, 0.8, hiss));
      crackle(S, 0.05, 0.38, 0.2);
      var nw = S.gain(0.05); S.noise('pink', S.filter('lowpass', 600, 0.5, nw), 0.8); S.lfo(0.06, 0.025, nw.gain);
      function cricket(f, minS, maxS, g, to) {
        S.every(minS, maxS, function (t) {
          var n = 2 + (Math.random() * 3 | 0), i;
          for (i = 0; i < n; i++) tone(c, to, { f: f, t: t + i * 0.052, dur: 0.04, gain: g, attack: 0.008 });
        });
      }
      cricket(4300, 0.45, 0.85, 0.012, S.panL || S.out);
      cricket(4950, 0.6, 1.3, 0.009, S.panR || S.out);
      S.every(16, 38, function (t) {
        var to = S.side(), f = rnd(310, 370);
        tone(c, to, { f: f, f1: f * 0.94, t: t, dur: 0.4, gain: 0.05, attack: 0.06 });
        tone(c, to, { f: f, f1: f * 0.94, t: t + 0.62, dur: 0.22, gain: 0.04, attack: 0.05 });
        tone(c, to, { f: f * 0.98, f1: f * 0.9, t: t + 0.9, dur: 0.5, gain: 0.05, attack: 0.06 });
      }, rnd(5, 12));
    },
    combat: function (S) {
      var c = S.c;
      var dg = S.gain(0.05), df = S.filter('lowpass', 230, 3, dg);
      S.osc('sawtooth', 55, df); S.osc('sawtooth', 82.6, df); S.osc('sawtooth', 55.4, df); S.lfo(0.19, 80, df.frequency);
      var tg = S.gain(0.05), tf = S.filter('bandpass', 2100, 2, tg);
      S.noise('pink', tf); S.lfo(0.23, 0.035, tg.gain);
      var step = 60 / 104 / 2, pat = [1, 0, 0, 0.6, 0, 0, 0.8, 0, 1, 0, 0.5, 0, 0.7, 0, 0.6, 0.4], n = 0, next = 0;
      S.every(0.2, 0.2, function (t) {
        var v;
        if (next < t) next = t + 0.05;
        while (next < t + 0.45) {
          v = pat[n % 16];
          if (v) {
            tone(c, S.out, { f: 98, f1: 44, t: next, dur: 0.26, gain: 0.42 * v, attack: 0.003 });
            burst(c, S.out, { kind: 'brown', ftype: 'lowpass', f: 500, q: 0.7, t: next, dur: 0.07, gain: 0.25 * v, attack: 0.002 });
          } else if (Math.random() < 0.22) {
            burst(c, S.side(), { kind: 'white', f: 1900, q: 3, t: next, dur: 0.035, gain: 0.12, attack: 0.001 });
          }
          n++; next += step;
        }
      }, 0.1);
      S.every(4, 10, function (t) {
        var f = rnd(2300, 3600), to = S.side();
        [1, 1.51, 2.42].forEach(function (m, k) { tone(c, to, { f: f * m, t: t, dur: 0.4 / (1 + k * 0.5), gain: 0.02 / (1 + k), attack: 0.001 }); });
        burst(c, to, { kind: 'white', ftype: 'highpass', f: 5000, q: 0.7, t: t, dur: 0.05, gain: 0.05, attack: 0.001 });
      });
    }
  };

  var amb = { want: 'none', name: 'none', kind: null, scene: null, live: [], loops: {} };
  var sfxUrlFn = null;

  function ambShouldRun() {
    return !!(unlocked && actx && !(doc && doc.hidden) && amb.live.length > 0 && settings.master * settings.ambience > 0.0005);
  }
  function syncAmbRun() {
    if (!actx) return;
    try {
      var want = ambShouldRun();
      if (want && actx.state !== 'running') resume(actx);
      else if (!want && actx.state === 'running') { var p = actx.suspend(); if (p && p.then) p.then(noop, noop); }
    } catch (e) { /* ignore */ }
  }
  function loopUrl(name) {
    try {
      var u = sfxUrlFn ? sfxUrlFn(name) : null;
      return typeof u === 'string' && u ? u : null;
    } catch (e) { return null; }
  }
  function retire(S) {
    S.fade(0, XFADE);
    setTimeout(function () {
      S.kill();
      var i = amb.live.indexOf(S);
      if (i !== -1) amb.live.splice(i, 1);
      syncAmbRun();
    }, XFADE * 1000 + 250);
  }
  function adopt(S, kind) {
    amb.live.push(S); amb.scene = S; amb.kind = kind;
    S.fade(S.level, XFADE);
  }
  function startProc(name) {
    var S = makeScene(actx, ambG, LEVEL[name] || 1);
    try { BUILD[name](S); } catch (e) { S.kill(); return; }
    adopt(S, 'proc');
  }
  function startLoop(buf) {
    var S = makeScene(actx, ambG, 0.55);
    try {
      var src = actx.createBufferSource();
      src.buffer = buf; src.loop = true; src.connect(S.out); src.start();
      S.srcs.push(src);
    } catch (e) { S.kill(); return false; }
    adopt(S, 'loop');
    return true;
  }
  function maybeFetchLoop(name) {
    var url = loopUrl(name), e;
    if (!url || !root.fetch || !actx) return;
    e = amb.loops[url];
    if (e && (e.buf || e.busy || now() - e.failed < 60000)) return;
    e = amb.loops[url] = { busy: true, buf: null, failed: 0 };
    fetchBytes(url, 30000).then(function (ab) { return decode(actx, ab); }).then(function (buf) {
      if (!buf || !(buf.duration > 0.5)) throw new Error('short');
      e.buf = seamless(actx, buf, Math.min(0.6, buf.duration / 5));
      e.busy = false;
      if (amb.name === name && amb.kind === 'proc' && loopUrl(name) === url) {
        var old = amb.scene;
        if (startLoop(e.buf) && old) retire(old);
        syncAmbRun();
      }
    }).then(noop, function () { e.busy = false; e.failed = now(); });
  }
  function applyAmbience() {
    if (!unlocked || !actx || !ambG) return;
    var want = amb.want, old, url, lp;
    if (want !== amb.name) {
      old = amb.scene;
      amb.scene = null; amb.name = want; amb.kind = null;
      if (old) retire(old);
      if (want !== 'none') {
        url = loopUrl(want); lp = url ? amb.loops[url] : null;
        if (!(lp && lp.buf && startLoop(lp.buf))) startProc(want);
      }
    }
    if (amb.name !== 'none' && amb.kind === 'proc') maybeFetchLoop(amb.name);
    syncAmbRun();
  }
  function setAmbience(name) {
    amb.want = typeof name === 'string' && has(AMBIENCES, name) ? name : 'none';
    applyAmbience();
  }

  /* --------------------------------------------------------------------- loading */

  function fetchBytes(url, ms) {
    return new Promise(function (resolve, reject) {
      if (!root.fetch) { reject(new Error('no fetch')); return; }
      var ctl = null, timer;
      try { ctl = root.AbortController ? new root.AbortController() : null; } catch (e) { ctl = null; }
      timer = setTimeout(function () {
        try { if (ctl) ctl.abort(); } catch (e) { /* ignore */ }
        reject(new Error('timeout'));
      }, ms);
      root.fetch(url, ctl ? { signal: ctl.signal } : undefined).then(function (r) {
        if (!r || !r.ok) throw new Error('http');
        var ct = '';
        try { ct = r.headers.get('content-type') || ''; } catch (e) { ct = ''; }
        if (/json|html|text\//i.test(ct)) throw new Error('not audio');
        return r.arrayBuffer();
      }).then(function (ab) {
        clearTimeout(timer);
        if (!ab || ab.byteLength < 64) throw new Error('empty');
        resolve(ab);
      }).then(noop, function (e) { clearTimeout(timer); reject(e); });
    });
  }
  function decode(c, ab) {
    return new Promise(function (resolve, reject) {
      var p;
      try { p = c.decodeAudioData(ab, resolve, reject); } catch (e) { reject(e); return; }
      if (p && typeof p.then === 'function') p.then(resolve, reject);
    });
  }

  /* --------------------------------------------------------------- speech voices */

  var synth = null;
  try { if (root.speechSynthesis && typeof root.SpeechSynthesisUtterance === 'function') synth = root.speechSynthesis; } catch (e) { synth = null; }

  // pitch 0..2, rate 0.1..10 (speechSynthesis); g = preferred voice gender
  var PROFILES = {
    narrator: { g: 'm', pitch: 0.95, rate: 0.96 },
    gruff:    { g: 'm', pitch: 0.55, rate: 0.9 },
    sage:     { g: 'm', pitch: 0.8,  rate: 0.84 },
    young:    { g: 'f', pitch: 1.45, rate: 1.06 },
    sinister: { g: 'm', pitch: 0.35, rate: 0.82 },
    noble:    { g: 'f', pitch: 1.0,  rate: 0.92 },
    cheerful: { g: 'f', pitch: 1.25, rate: 1.1 },
    creature: { g: 'm', pitch: 0.1,  rate: 0.72 }
  };
  // The artifact `tts` capability has four voices; pace separates archetypes that share one.
  var CAP_VOICES = {
    narrator: { voice: 'buttery', rate: 0.97 },
    gruff:    { voice: 'rounded', rate: 0.9 },
    sage:     { voice: 'rounded', rate: 0.82 },
    young:    { voice: 'airy',    rate: 1.1 },
    sinister: { voice: 'glassy',  rate: 0.84 },
    noble:    { voice: 'glassy',  rate: 0.98 },
    cheerful: { voice: 'airy',    rate: 1.0 },
    creature: { voice: 'buttery', rate: 0.74 }
  };
  var RE_FEMALE = /female|woman|\b(samantha|victoria|karen|moira|tessa|fiona|veena|allison|ava|susan|zira|hazel|heera|catherine|kate|serena|martha|nicky|aria|jenny|michelle|sonia|libby|natasha|clara|emma|amy|joanna|kendra|kimberly|salli|ivy|linda|heather|sara|ellen|amelie|anna|alice|paulina|monica|joana|luciana|helena|sabina|laura|lekha|milena|yuna|kyoko|zosia|ioana|alva|carmit|melina|mariska|satu|nora|lana|damayanti|kanya|yelda|marie|audrey|aurelie|petra|katja|elsa|isabella|lucia|ines|maria|sofia|google us english)\b/i;
  var RE_MALE = /\bmale\b|\bman\b|\b(daniel|alex|fred|david|mark|george|james|ryan|guy|aaron|arthur|gordon|oliver|rishi|thomas|tom|lee|bruce|ralph|eddy|reed|rocko|grandpa|diego|jorge|juan|luca|xander|yuri|maged|otoya|nicolas|jacques|markus|stefan|yannick|andrew|brian|christopher|eric|roger|steffan|william|liam|connor|matthew|joey|justin|kevin|russell|geraint|hans|carlos|enrique|felipe|ricardo|cristiano|giorgio|mathieu|henri|sean|richard|pablo|paul|conrad|killian|ravi)\b/i;
  var RE_NOVELTY = /\b(albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|deranged|hysterical|pipe organ|junior|kathy|princess)\b/i;
  var RE_QUALITY = /natural|neural|premium|enhanced|siri/i;

  var langTag = 'en', langExplicit = false;
  var LANG_NAMES = {
    english: 'en', spanish: 'es', espanol: 'es', 'español': 'es', french: 'fr', 'français': 'fr', german: 'de', deutsch: 'de',
    italian: 'it', italiano: 'it', portuguese: 'pt', 'português': 'pt', dutch: 'nl', polish: 'pl', russian: 'ru',
    japanese: 'ja', chinese: 'zh', mandarin: 'zh', korean: 'ko', swedish: 'sv', norwegian: 'nb', danish: 'da',
    finnish: 'fi', turkish: 'tr', ukrainian: 'uk', czech: 'cs', greek: 'el', hebrew: 'he', hindi: 'hi', arabic: 'ar',
    hungarian: 'hu', romanian: 'ro', indonesian: 'id', vietnamese: 'vi', thai: 'th'
  };
  function resolveLang(s) {
    s = String(s == null ? '' : s).trim();
    if (!s) return '';
    var low = s.toLowerCase(), first;
    if (own(LANG_NAMES, low)) return LANG_NAMES[low];
    if (/^[a-z]{2,3}([-_][a-z0-9]{2,8})*$/i.test(s)) return s.replace(/_/g, '-');
    first = low.split(/[^a-zà-ÿ]+/)[0];
    return first && own(LANG_NAMES, first) ? LANG_NAMES[first] : '';
  }
  try { langTag = resolveLang(doc && doc.documentElement && doc.documentElement.lang) || 'en'; } catch (e) { langTag = 'en'; }

  var castCache = null, synthDeadUntil = 0;

  function voicesNow() {
    try { var v = synth ? synth.getVoices() : []; return v && v.length ? Array.prototype.slice.call(v) : []; } catch (e) { return []; }
  }
  function castVoices() {
    var all = voicesNow();
    var base = String(langTag || 'en').toLowerCase().split(/[-_]/)[0];
    var key = base + '|' + all.length + '|' + (all[0] ? all[0].name : '');
    if (castCache && castCache.key === key) return castCache.map;
    var pool = [], used = [], map = {};
    all.forEach(function (v) {
      var name = String(v.name || ''), lang = String(v.lang || '').toLowerCase().replace(/_/g, '-');
      if (lang.split('-')[0] !== base || RE_NOVELTY.test(name)) return;
      pool.push({
        voice: v, name: name, lang: lang,
        g: RE_FEMALE.test(name) ? 'f' : (RE_MALE.test(name) ? 'm' : '?'),
        q: (RE_QUALITY.test(name) ? 3 : 0) + (/google|online/i.test(name) ? 2 : 0) - (/compact|espeak/i.test(name) ? 2 : 0)
      });
    });
    pool.sort(function (a, b) { return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0); });
    ARCHETYPES.forEach(function (arch) {
      var p = PROFILES[arch], best = -1, bestScore = -1e9;
      pool.forEach(function (v, idx) {
        var s = v.q + (v.g === p.g ? 8 : (v.g === '?' ? 3 : 0)) - 3 * (used[idx] || 0);
        if (base === 'en' && /gb|uk|british/.test(v.lang + ' ' + v.name.toLowerCase()) &&
            (arch === 'narrator' || arch === 'sage' || arch === 'noble' || arch === 'sinister')) s += 2;
        if (arch === 'narrator' && v.voice.default) s += 0.5;
        if (s > bestScore) { bestScore = s; best = idx; }
      });
      if (best !== -1) { used[best] = (used[best] || 0) + 1; map[arch] = pool[best].voice; }
    });
    castCache = { key: key, map: map };
    return map;
  }
  function onVoicesChanged() { castCache = null; synthDeadUntil = 0; }
  if (synth) {
    try {
      voicesNow();   // triggers the asynchronous voice list load in Chromium
      if (typeof synth.addEventListener === 'function') synth.addEventListener('voiceschanged', onVoicesChanged);
      else synth.onvoiceschanged = onVoicesChanged;
    } catch (e) { /* ignore */ }
  }

  function cleanText(t) {
    return String(t == null ? '' : t).replace(/[*_`#~>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  }
  // Split text into pieces of at most `max` characters, preferring sentence boundaries.
  function splitText(text, max) {
    text = String(text || '').trim();
    if (!text) return [];
    if (text.length <= max) return [text];
    var parts = text.match(/[^.!?…。！？]+[.!?…。！？]*["'”’)\]]*\s*/g) || [text];
    var out = [], buf = '';
    function push(s) { s = s.trim(); if (s) out.push(s); }
    parts.forEach(function (p) {
      var words, line, i, w;
      if ((buf + p).length <= max) { buf += p; return; }
      push(buf); buf = '';
      if (p.length <= max) { buf = p; return; }
      words = p.split(/(\s+)/); line = '';
      for (i = 0; i < words.length; i++) {
        w = words[i];
        if ((line + w).length > max && line.trim()) { push(line); line = ''; }
        while (w.length > max) { push(w.slice(0, max)); w = w.slice(max); }
        line += w;
      }
      buf = line;
    });
    push(buf);
    return out;
  }

  /* ------------------------------------------------------------------- narration */

  var mode = 'off', ttsUrlFn = null, caps = {};
  var gen = 0, cur = null, pending = null, curHalt = null, curEl = null;
  var listeners = [], lastState = { playing: null, seg: null };
  var speechBusy = false, keepUtter = null;
  var capBusy = false, capDenied = false, capOff = null;

  function emit(playing, seg) {
    if (playing == null) { playing = null; seg = null; }
    if (lastState.playing === playing && lastState.seg === seg) return;
    lastState = { playing: playing, seg: seg };
    var ls = listeners.slice(), i;
    for (i = 0; i < ls.length; i++) {
      try { ls[i]({ playing: playing, seg: seg }); } catch (e) { /* a listener must not break playback */ }
    }
  }
  function onState(cb) {
    if (typeof cb !== 'function') return noop;
    listeners.push(cb);
    return function () {
      var i = listeners.indexOf(cb);
      if (i !== -1) listeners.splice(i, 1);
    };
  }
  function backend() {
    if (mode === 'server') return 'server';
    if (mode === 'browser') return synth ? 'speech' : 'none';
    if (mode === 'artifact') {
      if (caps && caps.tts) return capDenied ? 'none' : 'cap';
      return synth ? 'speech' : 'none';
    }
    return 'none';
  }
  function normSegs(segs) {
    if (typeof segs === 'string') segs = [{ voice: 'narrator', text: segs }];
    if (!Array.isArray(segs)) return [];
    return segs.map(function (s) {
      var text = '', voice = 'narrator';
      if (typeof s === 'string') text = s;
      else if (s && typeof s === 'object') {
        if (typeof s.text === 'string') text = s.text;
        if (typeof s.voice === 'string' && has(ARCHETYPES, s.voice)) voice = s.voice;
      }
      return { voice: voice, text: cleanText(text) };
    });
  }
  function cancelSpeech() {
    speechBusy = false; keepUtter = null;
    try { if (synth) synth.cancel(); } catch (e) { /* ignore */ }
  }
  // Silence whatever is playing and invalidate every callback of the current job.
  function halt(keepCap) {
    gen++;
    var h = curHalt, job = cur;
    curHalt = null; cur = null;
    if (h) { try { h(); } catch (e) { /* ignore */ } }
    if (job) { clearTimeout(job.timer); clearTimeout(job.timer2); }
    if (speechBusy) cancelSpeech();
    if (capBusy) {
      capBusy = false;
      if (!keepCap) {
        try { var p = caps.tts.stop(); if (p && typeof p.then === 'function') p.then(noop, noop); } catch (e) { /* ignore */ }
      }
    }
  }
  function stop() {
    pending = null;
    halt(false);
    emit(null, null);
  }
  function narrate(entryId, segs) {
    var list = normSegs(segs), be = backend(), any = false, i, job;
    for (i = 0; i < list.length; i++) if (list[i].text) { any = true; break; }
    var audible = settings.master * settings.voice >= 0.005;
    var canPlay = be !== 'none' && any && entryId != null && audible;
    if (canPlay && !unlocked) {
      try { if (nav.userActivation && nav.userActivation.hasBeenActive) unlock(); } catch (e) { /* ignore */ }
    }
    halt(canPlay && unlocked && be === 'cap' && !micSession);
    pending = null;
    if (!canPlay) { emit(null, null); return; }
    job = { id: entryId, segs: list, at: now() };
    if (!unlocked || micSession) { pending = job; emit(null, null); return; }
    begin(job);
  }
  function flushPending() {
    var p = pending;
    if (!p || micSession || !unlocked) return;
    pending = null;
    if (now() - p.at > PENDING_MAX_AGE || cur || backend() === 'none') return;
    begin(p);
  }
  function firstSeg(job) {
    var i;
    for (i = 0; i < job.segs.length; i++) if (job.segs[i].text) return i;
    return -1;
  }
  function begin(p) {
    var g = ++gen;
    var job = cur = { id: p.id, segs: p.segs, at: p.at, g: g, loads: {}, played: 0, blocked: false, timer: 0, timer2: 0, cap: false, lineSeg: null };
    var first = firstSeg(job), go;
    if (first < 0) { finish(job); return; }
    if (backend() === 'cap') { capBegin(job, first); return; }
    if (ctx && ctx.state !== 'running') {
      // resume() can stay pending while the page is still locked: give it a moment, then carry on
      emit(job.id, first);
      go = once(function () { runSeg(job, first); });
      resume(ctx).then(go, go);
      job.timer2 = setTimeout(go, 350);
      return;
    }
    runSeg(job, first);
  }
  function finish(job) {
    if (job.g !== gen) return;
    cur = null; curHalt = null;
    if (job.played === 0 && job.blocked && now() - job.at < PENDING_MAX_AGE) pending = { id: job.id, segs: job.segs, at: job.at };
    emit(null, null);
  }
  function segUrl(job, i) {
    try {
      var u = ttsUrlFn ? ttsUrlFn(job.id, i) : null;
      return typeof u === 'string' && u ? u : null;
    } catch (e) { return null; }
  }
  function loadSeg(job, i) {
    if (job.loads[i]) return job.loads[i];
    var url = segUrl(job, i), p;
    if (!url || !ctx) p = Promise.reject(new Error('no url'));
    else p = fetchBytes(url, 12000).then(function (ab) { return decode(ctx, ab); });
    p.then(noop, noop);
    job.loads[i] = p;
    return p;
  }
  function prefetch(job, i) {
    while (i < job.segs.length && !job.segs[i].text) i++;
    if (i < job.segs.length && job.g === gen) loadSeg(job, i);
  }
  function runSeg(job, i) {
    if (job.g !== gen) return;
    while (i < job.segs.length && !job.segs[i].text) i++;
    if (i >= job.segs.length) { finish(job); return; }
    emit(job.id, i);
    var seg = job.segs[i], url;
    var next = once(function (ok) {
      if (job.g !== gen) return;
      curHalt = null;
      if (ok) job.played++;
      job.timer = setTimeout(function () { runSeg(job, i + 1); }, ok ? SEG_GAP_MS : 0);
    });
    var viaSpeech = once(function () {
      if (job.g !== gen) return;
      speakSeg(job, seg, next);
    });
    if (backend() !== 'server') { viaSpeech(); return; }
    url = segUrl(job, i);
    if (!url) { viaSpeech(); return; }
    if (ctx && voiceG && ctx.state === 'running') {
      loadSeg(job, i).then(function (buf) {
        if (job.g !== gen) return;
        prefetch(job, i + 1);
        playBuffer(job, buf, function (ok) { if (ok) next(true); else viaSpeech(); });
      }, function () { viaSpeech(); });
      prefetch(job, i + 1);
      return;
    }
    if (typeof root.Audio === 'function') {
      playElement(job, url, function (ok) { if (ok) next(true); else viaSpeech(); });
      return;
    }
    viaSpeech();
  }
  function playBuffer(job, buf, done) {
    var src, wd = 0;
    var fin = once(function (ok) {
      clearTimeout(wd);
      if (src) { src.onended = null; try { src.disconnect(); } catch (e) { /* ignore */ } }
      if (job.g !== gen) return;
      curHalt = null;
      done(ok);
    });
    try {
      src = ctx.createBufferSource();
      src.buffer = buf; src.connect(voiceG);
      src.onended = function () { fin(true); };
      curHalt = function () {
        clearTimeout(wd);
        try { src.onended = null; src.stop(); } catch (e) { /* ignore */ }
        try { src.disconnect(); } catch (e2) { /* ignore */ }
      };
      wd = setTimeout(function () { fin(true); }, buf.duration * 1000 + 1500);
      src.start();
    } catch (e) { fin(false); }
  }
  function playElement(job, url, done) {
    var a = null, wd = 0;
    function release() {
      if (!a) return;
      a.onended = a.onerror = a.onloadedmetadata = null;
      try { a.pause(); a.removeAttribute('src'); a.load(); } catch (e) { /* ignore */ }
      if (curEl === a) curEl = null;
    }
    var fin = once(function (ok) {
      clearTimeout(wd);
      release();
      if (job.g !== gen) return;
      curHalt = null;
      done(ok);
    });
    try {
      a = new root.Audio();
      a.preload = 'auto';
      a.volume = clamp01(settings.master * settings.voice);
      a.onended = function () { fin(true); };
      a.onerror = function () { fin(false); };
      a.onloadedmetadata = function () {
        if (isFinite(a.duration) && a.duration > 0) {
          clearTimeout(wd);
          wd = setTimeout(function () { fin(true); }, a.duration * 1000 + 3000);
        }
      };
      a.src = url;
      curEl = a;
      curHalt = function () { clearTimeout(wd); release(); };
      wd = setTimeout(function () { fin(false); }, 15000);
      var p = a.play();
      if (p && typeof p.then === 'function') {
        p.then(noop, function (e) {
          if (e && e.name === 'NotAllowedError') job.blocked = true;
          fin(false);
        });
      }
    } catch (e) { fin(false); }
  }
  // Browser speech for one segment, chunked so no utterance runs long enough to be cut off.
  function speakSeg(job, seg, done) {
    if (!synth || synthDeadUntil > now()) { done(false); return; }
    var prof = PROFILES[seg.voice] || PROFILES.narrator;
    var voice = castVoices()[seg.voice] || null;
    var chunks = splitText(seg.text, Math.max(90, Math.round(165 * prof.rate)));
    var k = 0, anyOk = false;
    speechBusy = true;
    function next() {
      if (job.g !== gen) return;
      if (k >= chunks.length) { speechBusy = false; done(anyOk); return; }
      var text = chunks[k++], u, started = false, wd = 0, hasVoices = voicesNow().length > 0;
      try { u = new root.SpeechSynthesisUtterance(text); } catch (e) { speechBusy = false; done(anyOk); return; }
      var fin = once(function (ok) {
        clearTimeout(wd);
        u.onend = u.onerror = u.onstart = null;
        if (keepUtter === u) keepUtter = null;
        if (job.g !== gen) return;
        if (ok) { anyOk = true; next(); } else { speechBusy = false; done(anyOk); }
      });
      try {
        if (voice) { u.voice = voice; u.lang = voice.lang || langTag; } else { u.lang = langTag; }
        u.pitch = prof.pitch; u.rate = prof.rate;
        u.volume = clamp01(settings.master * settings.voice);
      } catch (e2) { /* keep engine defaults */ }
      u.onstart = function () {
        started = true;
        clearTimeout(wd);
        // some engines never fire `end` on a long remote utterance: move on after a generous estimate
        wd = setTimeout(function () { try { synth.cancel(); } catch (e) { /* ignore */ } fin(true); }, text.length * 160 / prof.rate + 8000);
      };
      u.onend = function () { fin(true); };
      u.onerror = function (e) {
        if (e && e.error === 'not-allowed') job.blocked = true;
        fin(false);
      };
      wd = setTimeout(function () {
        if (started) return;
        if (!hasVoices) synthDeadUntil = now() + 60000;   // speech is not working here: stop trying for a while
        try { synth.cancel(); } catch (e) { /* ignore */ }
        fin(false);
      }, hasVoices ? 5000 : 2500);
      keepUtter = u;   // keep a reference: Chromium drops events of collected utterances
      try {
        if (synth.paused) synth.resume();
        synth.speak(u);
      } catch (e3) { fin(false); }
    }
    try {
      if (synth.speaking || synth.pending) {
        synth.cancel();
        job.timer2 = setTimeout(next, 80);
        return;
      }
    } catch (e) { /* ignore */ }
    next();
  }

  /* ------------------------------------------------ artifact `tts` capability path */

  function capUnsubscribe() {
    var off = capOff;
    capOff = null;
    if (off) { try { off(); } catch (e) { /* ignore */ } }
  }
  function capSubscribe() {
    capUnsubscribe();
    var t = caps && caps.tts;
    if (mode !== 'artifact' || !t || typeof t.onLine !== 'function') return;
    try {
      var off = t.onLine(function (e) { try { capLine(e); } catch (err) { /* ignore */ } });
      if (typeof off === 'function') capOff = off;
    } catch (e) { /* ignore */ }
  }
  function capLine(e) {
    var job = cur, seg = null, n;
    if (!job || !job.cap || job.g !== gen || !e) return;
    if (e.id != null) { n = parseInt(e.id, 10); if (isFinite(n)) seg = n; }
    if (seg == null && typeof e.line === 'number' && job.lineSeg) seg = job.lineSeg[e.line];
    if (seg != null && seg >= 0 && seg < job.segs.length) { job.played++; emit(job.id, seg); }
  }
  // One multi-line reading for the whole reply; each line carries its archetype's voice and pace.
  function capBegin(job, first) {
    var t = caps.tts, lines = [], lineSeg = [], chars = 0, wd = 0, p;
    job.segs.forEach(function (s, i) {
      if (!s.text) return;
      var m = CAP_VOICES[s.voice] || CAP_VOICES.narrator;
      splitText(s.text, 1900).forEach(function (part) {
        if (lines.length >= 100) return;
        lines.push({ text: part, voice: m.voice, rate: m.rate, id: String(i) });
        lineSeg.push(i); chars += part.length;
      });
    });
    if (!lines.length) { finish(job); return; }
    job.cap = true; job.lineSeg = lineSeg;
    capBusy = true;
    emit(job.id, first);
    var done = once(function (err) {
      clearTimeout(wd);
      if (job.g !== gen) return;
      capBusy = false;
      if (err) {
        // not_granted / unavailable: the viewer or the platform said no. Stay silent, and do not
        // read the text with the browser's own voice instead.
        if (err.code === 'not_granted' || err.code === 'unavailable') capDenied = true;
        else if (err.code === 'no_gesture') job.blocked = true;
      }
      finish(job);
    });
    wd = setTimeout(function () { done(null); }, chars * 130 + 60000);
    try { p = t.speak(lines, langExplicit ? { language: langTag } : undefined); }
    catch (e) { done({ code: 'upstream_error' }); return; }
    if (p && typeof p.then === 'function') {
      p.then(function () { job.played++; done(null); }, function (err) { done(err && typeof err === 'object' ? err : { code: 'upstream_error' }); });
    } else done(null);
  }

  /* ----------------------------------------------------------------- unlock/init */

  function primeSpeech() {
    // iOS only lets speech start from a gesture the first time: say nothing, once.
    if (primedSpeech || !synth || mode === 'off' || (mode === 'artifact' && caps && caps.tts)) return;
    primedSpeech = true;
    try {
      if (synth.speaking || synth.pending) return;
      var u = new root.SpeechSynthesisUtterance(' ');
      u.volume = 0;
      synth.speak(u);
    } catch (e) { /* ignore */ }
  }
  function unlock() {
    unlocked = true;
    ensureContexts();
    if (ctx) {
      if (ctx.state !== 'running') resume(ctx);
      if (!primedCtx) {
        primedCtx = true;
        try {   // a one-sample buffer: the classic iOS Web Audio unlock
          var s = ctx.createBufferSource();
          s.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
          s.connect(ctx.destination); s.start(0);
        } catch (e) { /* ignore */ }
      }
    }
    if (!pending) primeSpeech();
    applyAmbience();
    syncAmbRun();
    flushPending();
  }
  function init(opts) {
    opts = opts && typeof opts === 'object' ? opts : {};
    var m = opts.mode === undefined ? mode : (has(MODES, opts.mode) ? opts.mode : 'off');
    var nc = opts.caps && typeof opts.caps === 'object' ? opts.caps : {};
    var ttsChanged = (nc.tts || null) !== ((caps && caps.tts) || null);
    var dictChanged = (nc.dictation || null) !== ((caps && caps.dictation) || null);
    if (m !== mode || ttsChanged) {
      if (cur || pending || capBusy || speechBusy) stop();   // uses the outgoing mode and capability
    }
    if ((m !== mode || dictChanged) && micSession) micFinish(micSession);
    mode = m;
    ttsUrlFn = typeof opts.ttsUrl === 'function' ? opts.ttsUrl : null;
    if (sfxUrlFn !== opts.sfxUrl) amb.loops = {};
    sfxUrlFn = typeof opts.sfxUrl === 'function' ? opts.sfxUrl : null;
    caps = nc;
    if (ttsChanged) capDenied = false;
    if (dictChanged) dictDead = false;
    if (typeof opts.lang === 'string') {
      var l = resolveLang(opts.lang);
      if (l) { if (l !== langTag) castCache = null; langTag = l; langExplicit = true; }
    }
    capSubscribe();
    applyAmbience();
  }
  function set(patch) {
    mergeSettings(patch);
    saveSettings();
    applyVolumes();
    return getSettings();
  }

  /* ------------------------------------------------------------------ microphone */

  var SR = null;
  try { SR = root.SpeechRecognition || root.webkitSpeechRecognition || null; } catch (e) { SR = null; }
  var micSession = null, dictDead = false;

  function micBackend() {
    if (mode === 'artifact' && caps && caps.dictation) return dictDead ? null : 'cap';
    return typeof SR === 'function' ? 'sr' : null;
  }
  function micPush(s) {
    var a = s.finalText, b = s.partial, best;
    best = (a && b && !/\s$/.test(a) && !/^\s/.test(b) ? a + ' ' + b : a + b).replace(/\s+/g, ' ').trim();
    if (best === s.best) return;
    s.best = best;
    try { s.onText(best); } catch (e) { /* ignore */ }
  }
  function micFinish(s) {
    if (!s || s.done) return;
    s.done = true;
    clearTimeout(s.timer);
    s.unsubs.forEach(function (u) { try { if (typeof u === 'function') u(); } catch (e) { /* ignore */ } });
    if (s.rec) {
      s.rec.onresult = s.rec.onerror = s.rec.onend = null;
      try { s.rec.abort(); } catch (e) { /* ignore */ }
    }
    if (micSession === s) { micSession = null; duck = 1; applyVolumes(); }
    try { s.onEnd(s.best); } catch (e2) { /* ignore */ }
    flushPending();
  }
  function micStart(onText, onEnd) {
    if (micSession) micFinish(micSession);
    var be = micBackend(), d, p, rec;
    var s = {
      be: be, onText: typeof onText === 'function' ? onText : noop, onEnd: typeof onEnd === 'function' ? onEnd : noop,
      finalText: '', partial: '', best: '', done: false, stopping: false, unsubs: [], timer: 0, rec: null
    };
    if (!be) { setTimeout(function () { micFinish(s); }, 0); return false; }
    micSession = s;
    if (be === 'cap') {
      d = caps.dictation;
      // start() first: it must run synchronously inside the viewer's click
      try { p = d.start(); } catch (e) { micFinish(s); return false; }
      try {
        s.unsubs.push(d.onPartial(function (e) { if (s.done) return; s.partial = e && typeof e.text === 'string' ? e.text : ''; micPush(s); }));
        s.unsubs.push(d.onFinal(function (e) {
          if (s.done) return;
          var t = e && typeof e.text === 'string' ? e.text : '';
          s.finalText += s.finalText ? t : t.replace(/^\s+/, '');
          s.partial = '';
          micPush(s);
        }));
        s.unsubs.push(d.onState(function (e) {
          if (s.done || !e) return;
          if (e.state === 'idle') {
            if (e.reason === 'unavailable' || e.reason === 'not_granted') dictDead = true;
            micFinish(s);
          }
        }));
      } catch (e2) { /* partial subscriptions still work */ }
      if (p && typeof p.then === 'function') {
        p.then(noop, function (err) {
          if (err && (err.code === 'unavailable' || err.code === 'not_granted')) dictDead = true;
          micFinish(s);
        });
      }
    } else {
      try {
        rec = new SR();
        s.rec = rec;
        rec.continuous = !/Android/i.test(String(nav.userAgent || ''));   // Android repeats text in continuous mode
        rec.interimResults = true;
        rec.maxAlternatives = 1;
        rec.lang = micLang();
        rec.onresult = function (e) {
          var fin = '', inter = '', i, r, t;
          if (s.done || !e || !e.results) return;
          for (i = 0; i < e.results.length; i++) {
            r = e.results[i]; t = r && r[0] && typeof r[0].transcript === 'string' ? r[0].transcript : '';
            if (r && r.isFinal) fin += t; else inter += t;
          }
          s.finalText = fin; s.partial = inter;
          micPush(s);
        };
        rec.onerror = function (e) {
          var code = e && e.error;
          if (code === 'not-allowed' || code === 'service-not-allowed' || code === 'audio-capture') micFinish(s);
        };
        rec.onend = function () { micFinish(s); };
        rec.start();
      } catch (e3) { micFinish(s); return false; }
    }
    // the DM's voice would be picked up by the microphone: stop it and lower the ambience
    if (cur || capBusy || speechBusy) { halt(false); emit(null, null); }
    duck = 0.25; applyVolumes();
    return true;
  }
  function micStop() {
    var s = micSession, p;
    if (!s || s.done || s.stopping) return;
    s.stopping = true;
    function fin() { micFinish(s); }
    if (s.be === 'cap') {
      s.timer = setTimeout(fin, 4000);
      try {
        p = caps.dictation.stop();
        if (p && typeof p.then === 'function') p.then(fin, fin); else fin();
      } catch (e) { fin(); }
      return;
    }
    s.timer = setTimeout(fin, 2000);   // the last words arrive just before `end`
    try { s.rec.stop(); } catch (e2) { fin(); }
  }
  function micLang() {
    var navLang = '';
    try { navLang = String(nav.language || ''); } catch (e) { navLang = ''; }
    if (!langExplicit) return navLang || 'en-US';
    if (navLang && navLang.toLowerCase().split('-')[0] === langTag.toLowerCase().split('-')[0]) return navLang;
    return langTag;
  }

  var mic = { start: safe(micStart, false), stop: safe(micStop) };
  try {
    Object.defineProperty(mic, 'available', {
      enumerable: true,
      get: function () { try { return !!micBackend(); } catch (e) { return false; } }
    });
  } catch (e) { mic.available = false; }

  /* --------------------------------------------------------------- page listeners */

  if (doc && typeof doc.addEventListener === 'function') {
    try {
      // Belt and braces: unlock on any gesture even if the app forgets to call unlock().
      var onGesture = function () { try { unlock(); } catch (e) { /* ignore */ } };
      ['pointerup', 'mousedown', 'touchend', 'keydown', 'click'].forEach(function (ev) {
        doc.addEventListener(ev, onGesture, { capture: true, passive: true });
      });
      doc.addEventListener('visibilitychange', function () { try { syncAmbRun(); } catch (e) { /* ignore */ } });
    } catch (e) { /* ignore */ }
  }
  if (typeof root.addEventListener === 'function') {
    try {
      root.addEventListener('pagehide', function () { try { if (speechBusy) cancelSpeech(); } catch (e) { /* ignore */ } });
    } catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------------------ public API */

  root.GameAudio = {
    init: safe(init),
    unlock: safe(unlock),
    narrate: safe(narrate),
    stop: safe(stop),
    onState: safe(onState, noop),
    setAmbience: safe(setAmbience),
    sfx: safe(sfx),
    get: safe(getSettings, { master: 0.8, voice: 1, ambience: 0.45, effects: 0.7, autoplay: true }),
    set: safe(set),
    mic: mic
  };
})();
