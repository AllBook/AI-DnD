/* AI-DnD Online: the tabletop map.
 *
 * One classic script, no dependencies, no image files. Inside #sceneBox it draws the place the
 * party is in as a top-down battle map (room.map): procedurally painted floors, walls and
 * furniture on a canvas, warm light around fires and torches, fog of war over what nobody has
 * seen yet, and DOM game-piece tokens for heroes, the people in the scene and monsters.
 *
 * Players play on it: click a square to walk there, click a door, chest, exit, feature or
 * person to use it, click an enemy to target it and again to attack. Actions go through
 * window.Net.act. Targeting still goes through the app's own buttons (data-k="foe-<id>" and
 * "pc-<id>"), and the selection is read back from their aria-pressed.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined' || window.GameTable) return;
  const doc = document;
  const U = 48;            // world units (CSS px before the camera scale) per square

  // ------------------------------------------------------------------ styles

  const CSS = [
    '.tabletop{position:relative;display:block;width:100%;margin-top:8px;aspect-ratio:var(--ar,1.57);min-height:220px;border:1px solid #2b2620;border-radius:10px;overflow:hidden;',
    'background:radial-gradient(ellipse at 50% 40%,#1a1a1c 0,#0d0e10 70%,#08090a 100%);isolation:isolate;user-select:none;-webkit-user-select:none;',
    'color:var(--vellum,#ebe4d2);font-family:var(--font-body,system-ui,sans-serif);touch-action:pan-y;outline:none;-webkit-tap-highlight-color:transparent;',
    'box-shadow:inset 0 0 0 1px rgba(0,0,0,.6),0 6px 22px rgba(0,0,0,.35)}',
    '.tabletop.zoomed{touch-action:none}',
    '.tabletop:focus-visible{box-shadow:inset 0 0 0 2px var(--brass,#d1a94f),0 0 0 2px rgba(209,169,79,.35)}',
    '.tabletop[hidden]{display:none!important}',
    '#sceneBox.tt-battle-on #foes{display:none!important}',
    '#sceneBox.tt-on .scene-head{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}',
    '.tt-cam{position:absolute;left:0;top:0;transform-origin:0 0;will-change:transform}',
    '.tt-cam.ease{transition:transform .38s cubic-bezier(.25,.8,.25,1)}',
    '.tt-scene{position:absolute;inset:0;transform-origin:50% 50%}',
    '.tt-scene.enter{animation:tt-enter .7s cubic-bezier(.2,.8,.2,1) both}',
    '@keyframes tt-enter{from{opacity:0;transform:scale(1.045);filter:brightness(.4)}to{opacity:1;transform:none;filter:none}}',
    '.tt-scene>canvas,.tt-scene>svg,.tt-scene>.tt-l{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none}',
    '.tt-scene>svg{overflow:visible}',
    '.tt-lights,.tt-water{mix-blend-mode:screen}',


    '.tt-lights canvas{position:absolute;animation:tt-lf 2.3s ease-in-out infinite}',
    '@keyframes tt-lf{0%,100%{opacity:.95}18%{opacity:.78}37%{opacity:1}58%{opacity:.83}79%{opacity:.97}}',
    '.tt-water canvas{position:absolute;inset:0;width:100%;height:100%;animation:tt-wa 3.6s ease-in-out infinite}',
    '.tt-water canvas+canvas{animation-delay:-1.8s}',
    '@keyframes tt-wa{0%,100%{opacity:0}50%{opacity:1}}',
    '.tt-fog{transition:opacity .7s ease}',
    '.tt-flick{transform-box:fill-box;transform-origin:50% 100%;animation:tt-flick .8s ease-in-out infinite}',
    '@keyframes tt-flick{0%,100%{transform:scale(1,1)}22%{transform:scale(.9,1.12) skewX(4deg)}48%{transform:scale(1.07,.9)}74%{transform:scale(.94,1.07) skewX(-4deg)}}',
    '.tt-ember{animation:tt-ember 2.4s ease-out infinite;opacity:0}',
    '@keyframes tt-ember{0%{transform:translate(0,0);opacity:0}15%{opacity:1}100%{transform:translate(var(--dx,4px),-34px);opacity:0}}',
    '.tt-objs,.tt-tokens{position:absolute;inset:0;pointer-events:none}',
    '.tt-vig{position:absolute;inset:0;pointer-events:none;z-index:3;background:radial-gradient(ellipse at 50% 50%,rgba(0,0,0,0) 55%,rgba(0,0,0,.42) 100%);',
    'box-shadow:inset 0 0 40px rgba(0,0,0,.55)}',

    /* tokens and object markers, in world units; names are counter-scaled to stay readable */
    '.tt-scene .tk,.tt-scene .ob{position:absolute;left:0;top:0;width:var(--tk,40px);height:var(--tk,40px);margin:calc(var(--tk,40px)/-2) 0 0 calc(var(--tk,40px)/-2);',
    'padding:0;border:0;background:none;border-radius:50%;color:inherit;font:inherit;line-height:1;overflow:visible;cursor:pointer;pointer-events:auto;',
    '-webkit-tap-highlight-color:transparent;will-change:transform}',
    '.tt-scene .tk:disabled{cursor:default}',
    '.tt-scene .tk:focus-visible,.tt-scene .ob:focus-visible{outline:calc(2px*var(--inv,1)) solid var(--brass,#d1a94f);outline-offset:calc(3px*var(--inv,1))}',
    '.tk-shk,.tk-body{position:absolute;inset:0;display:block}',
    '.tk-body{transform-origin:50% 50%;transition:transform .5s cubic-bezier(.3,1.35,.5,1),filter .5s ease,opacity .5s ease}',
    '.tk-svg,.ob-svg{display:block;width:100%;height:100%;overflow:visible}',
    '.tt-scene button.tk:hover:not(:disabled):not(.is-down) .tk-body{transform:scale(1.08)}',
    '.tk-hp{transition:stroke-dashoffset .5s ease,stroke .3s ease}',
    '.tk-name,.ob-name{position:absolute;left:50%;top:100%;transform:translateX(-50%);margin-top:calc(1px*var(--inv,1));max-width:calc(110px*var(--inv,1));',
    'padding:calc(1px*var(--inv,1)) calc(5px*var(--inv,1)) calc(2px*var(--inv,1));border-radius:calc(6px*var(--inv,1));background:rgba(10,13,15,.84);',
    'box-shadow:0 0 0 calc(1px*var(--inv,1)) rgba(52,66,74,.75);font:600 calc(11px*var(--inv,1))/1.2 var(--font-body,sans-serif);color:var(--vellum,#ebe4d2);',
    'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;transition:opacity .25s}',
    '.tk-foe .tk-name{opacity:0}.tk-foe:hover .tk-name,.tk-foe.is-target .tk-name,.tk-foe.is-boss .tk-name,.tk-foe:focus-visible .tk-name{opacity:1}',
    '.tk.nm-off:not(:hover):not(:focus-visible) .tk-name{opacity:0}',
    '.tk-tag{display:none;position:absolute;left:50%;bottom:calc(100% + 2px*var(--inv,1));transform:translateX(-50%);padding:calc(1px*var(--inv,1)) calc(6px*var(--inv,1));border-radius:999px;',
    'background:var(--brass,#d1a94f);color:var(--brass-ink,#1c1608);font:700 calc(9px*var(--inv,1))/1.35 var(--font-body,sans-serif);letter-spacing:.08em;text-transform:uppercase;',
    'white-space:nowrap;pointer-events:none;box-shadow:0 1px 5px rgba(0,0,0,.6)}',
    '.tk.is-turn .tk-tag{display:block}',
    '.tk.is-turn{z-index:5!important}',
    '.tk.is-turn .tk-svg{filter:drop-shadow(0 0 3px rgba(209,169,79,.95)) drop-shadow(0 0 9px rgba(209,169,79,.6));animation:tk-turn 1.6s ease-in-out infinite}',
    '.tk.is-me::before{content:"";position:absolute;left:50%;top:calc(-9px*var(--inv,1));margin-left:calc(-5px*var(--inv,1));border:calc(5px*var(--inv,1)) solid transparent;',
    'border-top:calc(7px*var(--inv,1)) solid var(--brass,#d1a94f);border-bottom:0;filter:drop-shadow(0 1px 2px rgba(0,0,0,.8));animation:tk-bob 1.8s ease-in-out infinite}',
    '.tk.is-me.is-turn::before{display:none}',
    '.tk.is-me .tk-name{color:var(--brass,#d1a94f);box-shadow:0 0 0 calc(1px*var(--inv,1)) rgba(209,169,79,.7)}',
    '.tk.is-off .tk-body{opacity:.5;filter:saturate(.35)}',
    '.tk.is-down .tk-body{transform:rotate(-14deg) scale(.88);filter:grayscale(1) brightness(.6)}',
    '.tk.is-down::after{content:"";position:absolute;left:18%;right:18%;top:46%;height:9%;background:#c8493d;transform:rotate(-40deg);border-radius:2px;box-shadow:0 0 0 1px #0b0e10}',
    '.tk.is-dead{cursor:default;z-index:0!important;pointer-events:none}',
    '.tk.is-dead .tk-body{transform:scale(.8) rotate(16deg);filter:grayscale(1) brightness(.5);opacity:.42}',
    '.tk-ring{stroke:none;fill:none}',
    '.tk.is-target .tk-ring{stroke:var(--blood,#c8493d);stroke-width:3;stroke-dasharray:7 5.04;transform-box:fill-box;transform-origin:center;',
    'animation:tk-rot 7s linear infinite;filter:drop-shadow(0 0 3px var(--blood,#c8493d))}',
    '.tk.is-target .tk-name{box-shadow:0 0 0 calc(1px*var(--inv,1)) var(--blood,#c8493d);color:#f6c9c2}',
    '.tk.in-reach:not(.is-dead) .tk-svg{filter:drop-shadow(0 0 4px rgba(226,80,64,.9))}',
    '.tk.is-ally .tk-ring{stroke:var(--moss,#77b06c);stroke-width:2;filter:drop-shadow(0 0 2px var(--moss,#77b06c))}',
    '.tk.is-speaking{z-index:5!important}',
    '.tk.is-speaking .tk-body{animation:tk-speak 1.1s ease-in-out infinite}',
    '.tk.is-speaking::after{content:"";position:absolute;inset:-3px;border-radius:50%;border:2px solid var(--brass,#d1a94f);animation:tk-ripple 1.1s ease-out infinite;pointer-events:none}',
    '.tk.is-speaking .tk-name{color:var(--brass,#d1a94f)}',
    '.tk.tk-in .tk-shk{animation:tk-in .6s cubic-bezier(.2,.9,.3,1.2) both}',
    '.tk.tk-out{opacity:0;transition:opacity .35s;pointer-events:none}',
    '.tk.fx-shake .tk-shk{animation:tk-shake .45s ease}',
    '.tk.fx-flash .tk-svg{animation:tk-flash .45s ease}',
    '@keyframes tk-in{from{opacity:0;transform:scale(.4)}60%{opacity:1}to{opacity:1;transform:none}}',
    '@keyframes tk-shake{0%,100%{transform:translateX(0)}15%{transform:translateX(-12%) rotate(-5deg)}35%{transform:translateX(10%) rotate(4deg)}55%{transform:translateX(-7%) rotate(-3deg)}75%{transform:translateX(4%)}}',
    '@keyframes tk-flash{0%,100%{filter:none}30%{filter:brightness(1.9) saturate(1.6) drop-shadow(0 0 6px #c8493d)}}',
    '@keyframes tk-rot{to{transform:rotate(360deg)}}',
    '@keyframes tk-turn{0%,100%{filter:drop-shadow(0 0 3px rgba(209,169,79,.95)) drop-shadow(0 0 9px rgba(209,169,79,.6))}50%{filter:drop-shadow(0 0 2px rgba(209,169,79,.7)) drop-shadow(0 0 4px rgba(209,169,79,.25))}}',
    '@keyframes tk-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}',
    '@keyframes tk-speak{0%,100%{transform:scale(1)}50%{transform:scale(1.1)}}',
    '@keyframes tk-ripple{from{transform:scale(.95);opacity:.9}to{transform:scale(1.45);opacity:0}}',
    '.ob{border-radius:8px}',
    '.ob-name{opacity:0}',
    '.ob-exit .ob-name,.ob:hover .ob-name,.ob:focus-visible .ob-name,.ob.show .ob-name{opacity:1}',
    '.ob-exit .ob-name{color:var(--brass,#d1a94f);box-shadow:0 0 0 calc(1px*var(--inv,1)) rgba(209,169,79,.6)}',
    '.ob-feature .ob-svg{animation:ob-glow 2.4s ease-in-out infinite}',
    '@keyframes ob-glow{0%,100%{filter:drop-shadow(0 0 2px rgba(255,214,120,.7))}50%{filter:drop-shadow(0 0 9px rgba(255,214,120,1))}}',
    '.ob-exit .ob-svg{animation:ob-pulse 2.2s ease-in-out infinite}',
    '@keyframes ob-pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.08)}}',
    '.ob:hover .ob-svg{filter:brightness(1.25)}',
    '.ob.used{cursor:default}',

    /* HUD, in screen space */
    '.tt-hud{position:absolute;inset:0;z-index:4;pointer-events:none}',
    '.tt-loc,.tt-round,.tt-move{position:absolute;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:rgba(12,16,19,.88);border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,.5)}',
    '.tt-loc{left:8px;top:7px;max-width:calc(100% - 16px);padding:2px 10px 3px;font:400 13px/1.2 var(--font-display,Georgia,serif);letter-spacing:.05em;',
    'color:var(--brass,#d1a94f);border:1px solid rgba(209,169,79,.55);outline:1px solid rgba(209,169,79,.16);outline-offset:-4px}',
    '.tabletop.battle .tt-loc{max-width:calc(100% - 120px)}',
    '.tt-round{right:8px;top:7px;padding:3px 9px;font:700 10px/1.3 var(--font-mono,monospace);letter-spacing:.12em;text-transform:uppercase;color:var(--vellum,#ebe4d2);border:1px solid var(--line,#34424a)}',
    '.tt-move{right:8px;top:31px;padding:2px 9px;font:600 12px/1.35 var(--font-body,sans-serif);color:#f1d89a;border:1px solid rgba(209,169,79,.6)}',
    '.tt-move b{color:#fff}',
    '.tt-plaque{position:absolute;left:50%;bottom:6px;transform:translateX(-50%);max-width:calc(100% - 100px);display:flex;align-items:center;gap:9px;',
    'padding:2px 11px 2px 8px;border-radius:999px;background:rgba(12,16,19,.9);border:1px solid rgba(200,73,61,.6);',
    'font:11px/1.45 var(--font-mono,monospace);color:var(--muted,#9aa7a4);white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.5)}',
    '.tt-plaque b{font:700 12px/1.3 var(--font-body,sans-serif);color:#f2b9b0;min-width:0;overflow:hidden;text-overflow:ellipsis}',
    '.tt-plaque i{flex:none;width:9px;height:9px;border-radius:50%;border:2px solid var(--blood,#c8493d);box-shadow:0 0 0 1px rgba(12,16,19,.9),0 0 5px var(--blood,#c8493d)}',
    '.tt-plaque span{flex:none}.tt-plaque .v{color:var(--vellum,#ebe4d2)}',
    '.tt-plaque.idle{border-color:var(--line,#34424a)}.tt-plaque.idle i{display:none}.tt-plaque.idle b{color:var(--muted,#9aa7a4);font-weight:400}',
    '.tabletop.sm .tt-plaque{max-width:calc(100% - 64px);gap:6px}.tabletop.sm .tt-plaque .ad{display:none}',
    '.tt-zoom{position:absolute;right:8px;bottom:8px;width:34px;height:34px;padding:0;display:grid;place-items:center;pointer-events:auto;border-radius:8px;',
    'background:rgba(12,16,19,.88);border:1px solid var(--line,#34424a);color:var(--vellum,#ebe4d2);box-shadow:0 2px 8px rgba(0,0,0,.5)}',
    '.tt-zoom svg{width:18px;height:18px}',
    '.tt-tip{position:absolute;left:0;top:0;max-width:240px;padding:4px 9px 5px;border-radius:6px;background:rgba(10,13,15,.94);border:1px solid #3b4a52;',
    'font:12px/1.35 var(--font-body,sans-serif);color:var(--vellum,#ebe4d2);box-shadow:0 4px 14px rgba(0,0,0,.55);pointer-events:none;white-space:normal}',
    '.tt-tip b{display:block;font-weight:700;color:#f3e7c6}.tt-tip span{color:var(--muted,#9aa7a4)}.tt-tip .go{color:#e9c977}.tt-tip .bad{color:#f09b8f}',
    '.tt-toast{position:absolute;left:50%;top:40px;transform:translateX(-50%);max-width:calc(100% - 24px);padding:6px 12px;border-radius:8px;',
    'background:rgba(122,32,26,.95);border:1px solid #d76a5c;color:#fff;font:600 13px/1.35 var(--font-body,sans-serif);box-shadow:0 6px 18px rgba(0,0,0,.5);',
    'animation:tt-toast 3.6s ease both;text-align:center}',
    '.tt-toast.info{background:rgba(18,24,28,.95);border-color:var(--brass,#d1a94f);color:var(--vellum,#ebe4d2)}',
    '@keyframes tt-toast{0%{opacity:0;transform:translate(-50%,-6px)}8%{opacity:1;transform:translate(-50%,0)}85%{opacity:1}100%{opacity:0}}',
    '.tt-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}',

    /* floating numbers */
    '.tt-fx{position:absolute;inset:0;z-index:5;pointer-events:none}',
    '.tt-float{position:absolute;transform:translate(-50%,-100%);padding:0 6px;border-radius:6px;background:rgba(10,13,15,.75);',
    'font:700 17px/1.3 var(--font-mono,monospace);white-space:nowrap;text-shadow:0 1px 0 #000;animation:tt-float 1.25s ease-out both}',
    '.tt-float.dmg{color:#ff7c6e;box-shadow:0 0 0 1px rgba(200,73,61,.7)}',
    '.tt-float.heal{color:#9fd993;box-shadow:0 0 0 1px rgba(119,176,108,.7)}',
    '.tt-float.lvl{color:var(--brass,#d1a94f);font:400 15px/1.4 var(--font-display,Georgia,serif);letter-spacing:.06em;box-shadow:0 0 0 1px rgba(209,169,79,.7)}',
    '@keyframes tt-float{0%{opacity:0;transform:translate(-50%,-70%) scale(.7)}15%{opacity:1;transform:translate(-50%,-110%) scale(1.15)}30%{transform:translate(-50%,-120%) scale(1)}80%{opacity:1}100%{opacity:0;transform:translate(-50%,-210%) scale(1)}}',

    /* d20 */
    '.tt-die{position:absolute;left:50%;top:47%;z-index:7;width:88px;height:88px;margin:-44px 0 0 -44px;color:var(--brass,#d1a94f);pointer-events:none;transition:opacity .4s ease,color .2s}',
    '.tabletop.sm .tt-die{width:74px;height:74px;margin:-37px 0 0 -37px}',
    '.tt-die::before{content:"";position:absolute;inset:-34%;border-radius:50%;background:radial-gradient(closest-side,rgba(6,9,11,.82),rgba(6,9,11,0))}',
    '.tt-die svg{position:relative;display:block;width:100%;height:100%;filter:drop-shadow(0 6px 10px rgba(0,0,0,.6))}',
    '.tt-die-n{font:700 22px var(--font-body,sans-serif);fill:#0b0e10}',
    '.tt-die.pass{color:var(--moss,#77b06c)}.tt-die.fail{color:var(--blood,#c8493d)}',
    '.tt-die.spin svg{animation:tt-die-spin .7s cubic-bezier(.2,.7,.3,1) both}',
    '.tt-die.land svg{animation:tt-die-land .35s ease-out both}',
    '.tt-die.out{opacity:0}',
    '.tt-die-cap{position:absolute;left:50%;top:100%;transform:translateX(-50%);margin-top:3px;padding:1px 9px;border-radius:999px;background:rgba(10,13,15,.88);',
    'box-shadow:0 0 0 1px currentColor;font:700 11px/1.5 var(--font-body,sans-serif);letter-spacing:.08em;text-transform:uppercase;white-space:nowrap;max-width:240px;overflow:hidden;text-overflow:ellipsis}',
    '.tt-die-cap:empty{display:none}',
    '@keyframes tt-die-spin{0%{transform:rotate(-620deg) scale(.35);opacity:0}25%{opacity:1}100%{transform:rotate(0) scale(1);opacity:1}}',
    '@keyframes tt-die-land{0%{transform:scale(1.28)}60%{transform:scale(.95)}100%{transform:scale(1)}}',
    '@media (prefers-reduced-motion:reduce){.tabletop,.tabletop *,.tabletop *::before,.tabletop *::after{animation:none!important;transition:none!important}}',
  ].join('');

  // ------------------------------------------------------------------ small helpers

  const f1 = (n) => Math.round(n * 10) / 10;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const el = (tag, cls) => { const n = doc.createElement(tag); if (cls) n.className = cls; return n; };
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);
  const reduced = () => { try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; } };
  const raf = (fn) => (window.requestAnimationFrame ? window.requestAnimationFrame(fn) : setTimeout(fn, 16));
  const selEsc = (v) => String(v).replace(/["\\]/g, '\\$&');
  const keyOf = (x, y) => x + ',' + y;
  const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  function hash3(x, y, s) {
    let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 2246822519);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function strHash(s) { let h = 2166136261; s = String(s); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  const mkCanvas = (w, h) => { const c = doc.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; };
  // HSL helper: a colour from hue/sat/light plus a jitter.
  const hsl = (h, s, l, a) => 'hsla(' + f1(h) + ',' + f1(s) + '%,' + f1(l) + '%,' + (a == null ? 1 : a) + ')';
  function rrect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
  }
  // A smooth irregular blob (quadratic curves through jittered points).
  function blob(ctx, cx, cy, r, R, n, jit) {
    const k = n || 9, pts = [];
    for (let i = 0; i < k; i++) { const a = i / k * Math.PI * 2, rr = r * (1 - jit + R() * jit * 2); pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]); }
    const mid = (i) => { const p = pts[i % k], q = pts[(i + 1) % k]; return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]; };
    const m0 = mid(k - 1);
    ctx.moveTo(m0[0], m0[1]);
    for (let i = 0; i < k; i++) { const m = mid(i); ctx.quadraticCurveTo(pts[i][0], pts[i][1], m[0], m[1]); }
    ctx.closePath();
  }

  // ------------------------------------------------------------------ the map model

  const WALK = new Set(['.', ',', ':', 'r', 'c', 'R', 'S', "'", '_']);
  const LIGHT_BLOCK = new Set(['#', '+', ' ']);
  const at = (m, x, y) => (x >= 0 && y >= 0 && x < m.w && y < m.h ? (m.tiles[y] || '')[x] || ' ' : ' ');
  const seenAt = (m, x, y) => !!(m.seen && m.seen[y] && m.seen[y][x] === '1');
  const isWall = (ch) => ch === '#';
  const OUTDOOR = { town: 1, docks: 1, forest: 1, mountain: 1, camp: 1, shore: 1 };
  // Ambient darkness per layout (0 = broad daylight, 1 = pitch black).
  const DARK = { tavern: 0.4, town: 0.22, docks: 0.2, forest: 0.2, mountain: 0.06, camp: 0.42, cave: 0.55, mine: 0.52, dungeon: 0.5, crypt: 0.55, shore: 0.08 };

  function walkableT(m, x, y) {
    try { if (window.Engine && typeof window.Engine.walkable === 'function') return !!window.Engine.walkable(m, x, y); } catch (e) { /* fall back */ }
    return WALK.has(at(m, x, y));
  }

  // Squares inside buildings (not reachable from the map edge without passing a wall or door).
  function interiorOf(m) {
    const out = new Set(), seen = new Set(), q = [];
    for (let x = 0; x < m.w; x++) { q.push([x, 0], [x, m.h - 1]); }
    for (let y = 0; y < m.h; y++) { q.push([0, y], [m.w - 1, y]); }
    while (q.length) {
      const [x, y] = q.pop(), k = keyOf(x, y);
      if (x < 0 || y < 0 || x >= m.w || y >= m.h || seen.has(k)) continue;
      const ch = at(m, x, y);
      if (ch === '#' || ch === '+' || ch === "'") continue;
      seen.add(k);
      q.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
    for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) if (!seen.has(keyOf(x, y)) && at(m, x, y) !== '#') out.add(keyOf(x, y));
    return out;
  }

  // ------------------------------------------------------------------ painting the map
  // Everything is drawn in square units: ctx is scaled so one map square = 1.

  const PAL = {
    wood: { base: [28, 36, 25], mortar: '#20150d' },
    stone: { base: [40, 6, 36] }, crypt: { base: [215, 7, 34] },
    cave: { base: [28, 9, 26] }, grass: { base: [92, 33, 31] }, snow: { base: [210, 25, 88] },
    sand: { base: [38, 42, 63] }, dirt: { base: [30, 26, 31] },
  };

  function paintMap(m, R) {
    const W = m.w, H = m.h;
    const cv = mkCanvas(W * R, H * R);
    const ctx = cv.getContext('2d');
    const seed = strHash(m.layout + '|' + m.id + '|' + (m.tiles || []).join('').length);
    const rnd = rng(seed);
    const hs = (x, y, s) => hash3(x, y, seed + (s || 0));
    const layout = m.layout, theme = m.theme || 'stone';
    const inside = (layout === 'town' || layout === 'docks' || layout === 'camp') ? interiorOf(m) : null;
    const T = (x, y) => at(m, x, y);
    ctx.setTransform(R, 0, 0, R, 0, 0);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';

    // Which floor look a square gets under its contents.
    const floorOf = (x, y) => {
      const ch = T(x, y);
      if (ch === '#' || ch === ' ' || ch === '~') return null;
      if (inside && inside.has(keyOf(x, y))) return 'wood';
      if (ch === ',') {
        if (theme === 'stone') return 'cobble';
        if (layout === 'town') return 'grass';
      }
      if (layout === 'town') return 'grass';
      if (layout === 'crypt' && theme === 'stone') return 'crypt';
      return theme;
    };
    const groups = {};
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const f = floorOf(x, y); if (f) (groups[f] = groups[f] || []).push([x, y]); }

    const clipTo = (cells, fn) => {
      ctx.save(); ctx.beginPath();
      cells.forEach(([x, y]) => ctx.rect(x - 0.002, y - 0.002, 1.004, 1.004));
      ctx.clip(); fn(); ctx.restore();
    };
    Object.keys(groups).forEach((kind) => clipTo(groups[kind], () => FLOOR[kind] ? FLOOR[kind](ctx, W, H, rng(seed + kind.length * 7919), layout) : FLOOR.stone(ctx, W, H, rng(seed), layout)));

    // big soft variation over every floor
    const allFloor = [].concat(...Object.values(groups));
    clipTo(allFloor, () => {
      const nc = mkCanvas(W * 2, H * 2), nx = nc.getContext('2d'), id = nx.createImageData(nc.width, nc.height);
      for (let i = 0; i < id.data.length; i += 4) { const v = rnd(); id.data[i] = id.data[i + 1] = id.data[i + 2] = v < 0.5 ? 0 : 255; id.data[i + 3] = Math.round(Math.abs(v - 0.5) * 70); }
      nx.putImageData(id, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(nc, 0, 0, W, H);
    });

    // rough ground decorations
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (T(x, y) === ',') rough(ctx, x, y, rng(seed + x * 131 + y * 977), theme, layout, inside && inside.has(keyOf(x, y)));

    // paths, roads, runners and piers
    paths(ctx, m, T, rng(seed + 3), layout, theme, inside);
    // rugs
    components(m, 'r').forEach((c) => rug(ctx, c, rng(seed + c.x0 * 31 + c.y0)));
    // deep water and shallows
    water(ctx, m, T, rng(seed + 5));
    // rails and stairs
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const ch = T(x, y);
      if (ch === 'R') rails(ctx, x, y, T);
      else if (ch === 'S') stairs(ctx, x, y, T, theme);
    }
    // contact shadows of walls on the floor
    wallShadows(ctx, m, T);
    // walls
    walls(ctx, m, T, rng(seed + 11), layout, theme);
    // doors
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const ch = T(x, y); if (ch === '+' || ch === "'") door(ctx, x, y, T, ch === '+', layout); }

    // furniture: shadows first, then the things themselves
    const furn = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) furn.push([x, y, T(x, y)]);
    const conn = (x, y, ch) => ({ l: T(x - 1, y) === ch, r: T(x + 1, y) === ch, u: T(x, y - 1) === ch, d: T(x, y + 1) === ch });
    // drop shadows
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,.38)';
    furn.forEach(([x, y, ch]) => {
      if (ch === '=' || ch === 'B' || ch === 's' || ch === 'w' || ch === 'a') { ctx.beginPath(); autoShape(ctx, x + 0.07, y + 0.09, conn(x, y, ch), ch === 'B' ? 0.06 : 0.1, 0.1); ctx.fill(); }
      else if (ch === 'b' || ch === 'o' || ch === '^') { ctx.beginPath(); ctx.ellipse(x + 0.56, y + 0.6, 0.38, 0.34, 0, 0, Math.PI * 2); ctx.fill(); }
      else if (ch === 'n') { ctx.beginPath(); ctx.rect(x + 0.12, y + 0.14, 0.92, 0.92); ctx.fill(); }
    });
    ctx.restore();
    furn.forEach(([x, y, ch]) => { if (ch === 'c') chair(ctx, x, y, T, hs(x, y, 1)); });
    furn.forEach(([x, y, ch]) => {
      const R2 = rng(seed + x * 7919 + y * 104729);
      if (ch === '=') table(ctx, x, y, conn(x, y, '='), R2, comps.has('='), layout);
      else if (ch === 'B') bar(ctx, x, y, conn(x, y, 'B'), R2);
      else if (ch === 'b') barrel(ctx, x, y, R2, layout);
      else if (ch === 'k') shelf(ctx, x, y, T, conn(x, y, 'k'), R2, layout);
      else if (ch === 'w') bed(ctx, x, y, T, conn(x, y, 'w'), R2, !!OUTDOOR[layout] && !(inside && inside.has(keyOf(x, y))));
      else if (ch === 's') sarcophagus(ctx, x, y, conn(x, y, 's'), R2);
      else if (ch === 'a') altar(ctx, x, y, T, R2);
      else if (ch === 'o') pillar(ctx, x, y, R2, theme);
      else if (ch === 'h') hearth(ctx, x, y, T, conn(x, y, 'h'), R2);
      else if (ch === 'x') torch(ctx, x, y, T, R2);
      else if (ch === 'F') campfire(ctx, x, y, R2);
      else if (ch === 'n') tent(ctx, x, y, R2);
      else if (ch === '^') boulder(ctx, x, y, R2, theme, layout);
    });
    // trees last so canopies overlap their neighbours
    const trees = furn.filter((f) => f[2] === 'T');
    ctx.save(); ctx.fillStyle = 'rgba(0,0,0,.33)';
    trees.forEach(([x, y]) => { const r = 0.56 + hs(x, y, 9) * 0.14; ctx.beginPath(); ctx.ellipse(x + 0.68, y + 0.72, r, r * 0.86, 0.3, 0, Math.PI * 2); ctx.fill(); });
    ctx.restore();
    trees.forEach(([x, y]) => tree(ctx, x, y, rng(seed + x * 6151 + y * 3571), layout, theme));

    // baked lighting
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const L = lighting(m);
    ctx.imageSmoothingEnabled = true;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.42;
    ctx.drawImage(L.warm, 0, 0, W * R, H * R);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    grain(ctx, cv.width, cv.height, rng(seed + 99));
    return { canvas: cv, lights: L.lights, glows: L.glows, flames: L.flames, darkA: L.darkA };
  }
  const comps = new Set(['=']);

  function grain(ctx, w, h, R) {
    try {
      const id = ctx.getImageData(0, 0, w, h), d = id.data;
      for (let i = 0; i < d.length; i += 4) {
        const n = (R() - 0.5) * 13;
        d[i] = d[i] + n; d[i + 1] = d[i + 1] + n; d[i + 2] = d[i + 2] + n;
      }
      ctx.putImageData(id, 0, 0);
    } catch (e) { /* a tainted or huge canvas: skip the grain */ }
  }

  // ---- floors (whole-map patterns, clipped to the squares that use them)

  const FLOOR = {
    wood(ctx, W, H, R) {
      ctx.fillStyle = '#2a1a10'; ctx.fillRect(0, 0, W, H);
      const ph = 0.25;
      for (let j = 0; j < H / ph; j++) {
        const y0 = j * ph;
        let x = -R() * 2;
        while (x < W) {
          const len = 1.1 + R() * 2.4, l = 23 + R() * 10, hue = 24 + R() * 9, sat = 34 + R() * 12;
          const g = ctx.createLinearGradient(0, y0, 0, y0 + ph);
          g.addColorStop(0, hsl(hue, sat, l + 3)); g.addColorStop(1, hsl(hue, sat, l - 3));
          ctx.fillStyle = g; ctx.fillRect(x + 0.006, y0 + 0.006, len - 0.012, ph - 0.012);
          ctx.strokeStyle = hsl(hue, sat, l - 12, 0.45); ctx.lineWidth = 0.007;
          for (let k = 0; k < 3; k++) {
            const gy = y0 + 0.04 + R() * (ph - 0.08), a = (R() - 0.5) * 0.03;
            ctx.beginPath(); ctx.moveTo(x + 0.04, gy); ctx.bezierCurveTo(x + len * 0.33, gy + a, x + len * 0.66, gy - a, x + len - 0.04, gy + a * 0.5); ctx.stroke();
          }
          if (R() < 0.18) {
            const kx = x + 0.2 + R() * (len - 0.4), ky = y0 + 0.07 + R() * 0.11;
            ctx.strokeStyle = hsl(hue, sat, l - 14, 0.6); ctx.lineWidth = 0.008;
            ctx.beginPath(); ctx.ellipse(kx, ky, 0.05, 0.022, 0, 0, Math.PI * 2); ctx.stroke();
            ctx.beginPath(); ctx.ellipse(kx, ky, 0.09, 0.04, 0, 0, Math.PI * 2); ctx.stroke();
          }
          ctx.fillStyle = 'rgba(12,8,5,.55)';
          [[x + 0.06, y0 + 0.07], [x + 0.06, y0 + ph - 0.07], [x + len - 0.06, y0 + 0.07], [x + len - 0.06, y0 + ph - 0.07]].forEach((p) => { ctx.beginPath(); ctx.arc(p[0], p[1], 0.011, 0, Math.PI * 2); ctx.fill(); });
          ctx.fillStyle = 'rgba(255,225,180,.05)'; ctx.fillRect(x, y0 + 0.006, len, 0.012);
          x += len;
        }
      }
    },
    stone(ctx, W, H, R, layout, cool) {
      ctx.fillStyle = cool ? '#1a1c20' : '#1f1e1b'; ctx.fillRect(0, 0, W, H);
      const rh = 0.5;
      for (let j = 0; j < H / rh; j++) {
        const y0 = j * rh;
        let x = -R() * 0.5;
        while (x < W) {
          const sw = [0.5, 0.75, 1, 0.5, 0.75][Math.floor(R() * 5)];
          const l = (cool ? 30 : 33) + R() * 10, hue = cool ? 205 + R() * 20 : 30 + R() * 20, sat = 4 + R() * 6;
          const x1 = x + 0.025, y1 = y0 + 0.025, w1 = sw - 0.05, h1 = rh - 0.05;
          const g = ctx.createLinearGradient(x1, y1, x1 + w1, y1 + h1);
          g.addColorStop(0, hsl(hue, sat, l + 4)); g.addColorStop(1, hsl(hue, sat, l - 4));
          ctx.fillStyle = g; ctx.beginPath(); rrect(ctx, x1, y1, w1, h1, 0.05); ctx.fill();
          ctx.lineWidth = 0.018;
          ctx.strokeStyle = 'rgba(255,255,255,.07)'; ctx.beginPath(); ctx.moveTo(x1 + 0.04, y1 + 0.012); ctx.lineTo(x1 + w1 - 0.04, y1 + 0.012); ctx.moveTo(x1 + 0.012, y1 + 0.04); ctx.lineTo(x1 + 0.012, y1 + h1 - 0.04); ctx.stroke();
          ctx.strokeStyle = 'rgba(0,0,0,.28)'; ctx.beginPath(); ctx.moveTo(x1 + 0.04, y1 + h1 - 0.012); ctx.lineTo(x1 + w1 - 0.04, y1 + h1 - 0.012); ctx.moveTo(x1 + w1 - 0.012, y1 + 0.04); ctx.lineTo(x1 + w1 - 0.012, y1 + h1 - 0.04); ctx.stroke();
          for (let k = 0; k < 5; k++) { ctx.fillStyle = R() < 0.5 ? 'rgba(0,0,0,.18)' : 'rgba(255,255,255,.06)'; ctx.beginPath(); ctx.arc(x1 + R() * w1, y1 + R() * h1, 0.008 + R() * 0.02, 0, Math.PI * 2); ctx.fill(); }
          if (R() < 0.14) {
            ctx.strokeStyle = 'rgba(10,10,10,.45)'; ctx.lineWidth = 0.012;
            let cx = x1 + R() * w1, cy = y1;
            ctx.beginPath(); ctx.moveTo(cx, cy);
            for (let s = 0; s < 4; s++) { cx += (R() - 0.5) * 0.14; cy += h1 / 4; ctx.lineTo(cx, cy); }
            ctx.stroke();
          }
          if (layout === 'crypt' && R() < 0.12) { ctx.fillStyle = 'rgba(95,120,70,.25)'; ctx.beginPath(); blob(ctx, x1 + R() * w1, y1 + R() * h1, 0.08 + R() * 0.08, R, 8, 0.4); ctx.fill(); }
          x += sw;
        }
      }
    },
    crypt(ctx, W, H, R, layout) { FLOOR.stone(ctx, W, H, R, layout, true); },
    cobble(ctx, W, H, R) {
      ctx.fillStyle = '#211e1a'; ctx.fillRect(0, 0, W, H);
      const s = 0.25;
      for (let y = 0; y < H; y += s) for (let x = 0; x < W; x += s) {
        const cx = x + s / 2 + (R() - 0.5) * 0.06, cy = y + s / 2 + (R() - 0.5) * 0.06, l = 26 + R() * 12;
        ctx.fillStyle = hsl(32 + R() * 15, 6 + R() * 6, l);
        ctx.beginPath(); ctx.ellipse(cx, cy, 0.105 + R() * 0.02, 0.095 + R() * 0.02, R() * 3, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,.07)'; ctx.beginPath(); ctx.ellipse(cx - 0.025, cy - 0.03, 0.05, 0.03, 0, 0, Math.PI * 2); ctx.fill();
      }
    },
    cave(ctx, W, H, R) {
      ctx.fillStyle = '#4d453d'; ctx.fillRect(0, 0, W, H);
      for (let i = 0; i < W * H * 6; i++) {
        ctx.fillStyle = R() < 0.5 ? hsl(28, 9, 36 + R() * 7, 0.3) : hsl(25, 10, 24 + R() * 6, 0.25);
        ctx.beginPath(); blob(ctx, R() * W, R() * H, 0.12 + R() * 0.4, R, 9, 0.35); ctx.fill();
      }
      for (let i = 0; i < W * H * 2; i++) {
        const x = R() * W, y = R() * H, r = 0.02 + R() * 0.045;
        ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.beginPath(); ctx.ellipse(x + 0.01, y + 0.012, r, r * 0.8, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = hsl(30, 8, 38 + R() * 12); ctx.beginPath(); ctx.ellipse(x, y, r, r * 0.8, R() * 3, 0, Math.PI * 2); ctx.fill();
      }
      ctx.strokeStyle = 'rgba(10,8,6,.45)'; ctx.lineWidth = 0.013;
      for (let i = 0; i < W * H * 0.25; i++) {
        let x = R() * W, y = R() * H;
        ctx.beginPath(); ctx.moveTo(x, y);
        for (let s = 0; s < 4; s++) { x += (R() - 0.5) * 0.35; y += (R() - 0.5) * 0.35; ctx.lineTo(x, y); }
        ctx.stroke();
      }
    },
    grass(ctx, W, H, R) {
      ctx.fillStyle = '#4a6631'; ctx.fillRect(0, 0, W, H);
      const greens = ['#56763a', '#435d2b', '#5f8240', '#3d5628', '#668a45'];
      for (let i = 0; i < W * H * 3; i++) { ctx.fillStyle = greens[Math.floor(R() * greens.length)]; ctx.globalAlpha = 0.22; ctx.beginPath(); blob(ctx, R() * W, R() * H, 0.3 + R() * 0.6, R, 10, 0.3); ctx.fill(); }
      ctx.globalAlpha = 1;
      ctx.lineWidth = 0.014;
      for (let i = 0; i < W * H * 34; i++) {
        const x = R() * W, y = R() * H, dx = (R() - 0.5) * 0.06;
        ctx.strokeStyle = R() < 0.5 ? 'rgba(130,170,80,.5)' : 'rgba(35,55,22,.5)';
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + dx, y - 0.05 - R() * 0.06); ctx.stroke();
      }
      const fl = ['#f1ecd2', '#f2d35b', '#b99ae0', '#e38a7a'];
      for (let i = 0; i < W * H * 0.45; i++) { ctx.fillStyle = fl[Math.floor(R() * fl.length)]; ctx.beginPath(); ctx.arc(R() * W, R() * H, 0.018, 0, Math.PI * 2); ctx.fill(); }
    },
    snow(ctx, W, H, R) {
      ctx.fillStyle = '#dbe3ea'; ctx.fillRect(0, 0, W, H);
      for (let i = 0; i < W * H * 1.6; i++) { ctx.fillStyle = R() < 0.55 ? 'rgba(170,190,212,.16)' : 'rgba(250,252,255,.3)'; ctx.beginPath(); blob(ctx, R() * W, R() * H, 0.4 + R() * 0.9, R, 10, 0.3); ctx.fill(); }
      ctx.strokeStyle = 'rgba(150,172,196,.35)'; ctx.lineWidth = 0.016;
      for (let i = 0; i < W * H * 0.8; i++) { const x = R() * W, y = R() * H; ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(x + 0.2, y - 0.07, x + 0.4, y); ctx.stroke(); }
      for (let i = 0; i < W * H * 0.3; i++) { ctx.fillStyle = 'rgba(90,96,104,.6)'; ctx.beginPath(); blob(ctx, R() * W, R() * H, 0.03 + R() * 0.04, R, 7, 0.3); ctx.fill(); }
    },
    sand(ctx, W, H, R) {
      ctx.fillStyle = '#c4a573'; ctx.fillRect(0, 0, W, H);
      for (let i = 0; i < W * H * 1.6; i++) { ctx.fillStyle = R() < 0.5 ? 'rgba(220,196,148,.2)' : 'rgba(160,128,86,.14)'; ctx.beginPath(); blob(ctx, R() * W, R() * H, 0.4 + R() * 0.9, R, 10, 0.3); ctx.fill(); }
      ctx.strokeStyle = 'rgba(120,92,58,.22)'; ctx.lineWidth = 0.015;
      for (let i = 0; i < W * H * 1.3; i++) { const x = R() * W, y = R() * H; ctx.beginPath(); ctx.moveTo(x, y); ctx.bezierCurveTo(x + 0.12, y - 0.05, x + 0.25, y + 0.05, x + 0.4, y); ctx.stroke(); }
      for (let i = 0; i < W * H * 0.35; i++) { ctx.fillStyle = R() < 0.5 ? '#efe6d4' : '#8c7a64'; ctx.beginPath(); ctx.ellipse(R() * W, R() * H, 0.025, 0.017, R() * 3, 0, Math.PI * 2); ctx.fill(); }
    },
    dirt(ctx, W, H, R) {
      ctx.fillStyle = '#5e4b37'; ctx.fillRect(0, 0, W, H);
      for (let i = 0; i < W * H * 3; i++) { ctx.fillStyle = R() < 0.5 ? 'rgba(122,98,72,.35)' : 'rgba(60,46,32,.35)'; ctx.beginPath(); blob(ctx, R() * W, R() * H, 0.2 + R() * 0.5, R, 9, 0.35); ctx.fill(); }
      for (let i = 0; i < W * H * 1.5; i++) { ctx.fillStyle = hsl(30, 10, 35 + R() * 15); ctx.beginPath(); ctx.ellipse(R() * W, R() * H, 0.025 + R() * 0.03, 0.02 + R() * 0.02, R() * 3, 0, Math.PI * 2); ctx.fill(); }
    },
  };

  function rough(ctx, x, y, R, theme, layout, indoor) {
    if (indoor || theme === 'wood') {
      ctx.strokeStyle = 'rgba(214,180,96,.55)'; ctx.lineWidth = 0.012;
      for (let i = 0; i < 14; i++) { const px = x + R(), py = y + R(), a = R() * 3.14; ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + Math.cos(a) * 0.12, py + Math.sin(a) * 0.12); ctx.stroke(); }
      return;
    }
    if (theme === 'grass' || theme === 'dirt') {
      for (let i = 0; i < 7; i++) {
        const px = x + 0.1 + R() * 0.8, py = y + 0.15 + R() * 0.8;
        for (let k = 0; k < 6; k++) {
          ctx.strokeStyle = k % 2 ? 'rgba(48,74,28,.85)' : 'rgba(118,156,70,.75)'; ctx.lineWidth = 0.018;
          const a = -Math.PI / 2 + (k - 2.5) * 0.28;
          ctx.beginPath(); ctx.moveTo(px, py); ctx.quadraticCurveTo(px + Math.cos(a) * 0.06, py + Math.sin(a) * 0.08, px + Math.cos(a) * 0.1, py + Math.sin(a) * 0.15); ctx.stroke();
        }
      }
      if (R() < 0.3) { ctx.fillStyle = '#e6d36a'; ctx.beginPath(); ctx.arc(x + R(), y + R(), 0.022, 0, 7); ctx.fill(); }
      return;
    }
    if (theme === 'cave') {
      ctx.fillStyle = 'rgba(78,112,58,.45)';
      for (let i = 0; i < 4; i++) { ctx.beginPath(); blob(ctx, x + 0.2 + R() * 0.6, y + 0.2 + R() * 0.6, 0.12 + R() * 0.16, R, 9, 0.4); ctx.fill(); }
      ctx.fillStyle = 'rgba(130,200,170,.5)';
      for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.arc(x + R(), y + R(), 0.02, 0, 7); ctx.fill(); }
      return;
    }
    // snow, sand, stone: scree and pebbles
    for (let i = 0; i < 9; i++) {
      const px = x + R(), py = y + R(), r = 0.03 + R() * 0.06;
      ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.beginPath(); ctx.ellipse(px + 0.012, py + 0.014, r, r * 0.8, 0, 0, 7); ctx.fill();
      ctx.fillStyle = theme === 'snow' ? hsl(210, 5, 42 + R() * 15) : theme === 'sand' ? hsl(35, 25, 50 + R() * 15) : hsl(30, 6, 34 + R() * 12);
      ctx.beginPath(); blob(ctx, px, py, r, R, 7, 0.3); ctx.fill();
    }
  }

  function paths(ctx, m, T, R, layout, theme, inside) {
    const cells = [];
    for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) if (T(x, y) === ':') cells.push([x, y]);
    if (!cells.length) return;
    const indoor = (x, y) => (inside ? inside.has(keyOf(x, y)) : !OUTDOOR[m.layout]);
    const runner = cells.filter(([x, y]) => indoor(x, y) && layout !== 'docks');
    const pier = layout === 'docks' ? cells : [];
    const road = cells.filter(([x, y]) => !indoor(x, y) && layout !== 'docks');
    // carpet runner
    runner.forEach(([x, y]) => {
      const c = { l: T(x - 1, y) === ':', r: T(x + 1, y) === ':', u: T(x, y - 1) === ':', d: T(x, y + 1) === ':' };
      ctx.fillStyle = '#6c2320'; ctx.beginPath(); autoShape(ctx, x, y, c, 0.12, 0.03); ctx.fill();
      ctx.strokeStyle = '#b8903f'; ctx.lineWidth = 0.035; ctx.beginPath(); autoShape(ctx, x, y, c, 0.17, 0.02, true); ctx.stroke();
      ctx.fillStyle = 'rgba(200,150,70,.35)'; ctx.beginPath(); ctx.moveTo(x + 0.5, y + 0.32); ctx.lineTo(x + 0.66, y + 0.5); ctx.lineTo(x + 0.5, y + 0.68); ctx.lineTo(x + 0.34, y + 0.5); ctx.closePath(); ctx.fill();
    });
    // wooden pier planks (docks)
    pier.forEach(([x, y]) => {
      ctx.fillStyle = 'rgba(0,0,0,.4)'; ctx.fillRect(x + 0.04, y + 0.06, 1, 1);
      for (let k = 0; k < 4; k++) { ctx.fillStyle = hsl(28, 30, 26 + R() * 8); ctx.fillRect(x + k * 0.25 + 0.01, y, 0.23, 1); }
      ctx.fillStyle = '#2a1c12'; [0.1, 0.9].forEach((py) => { ctx.beginPath(); ctx.arc(x + 0.1, y + py, 0.06, 0, 7); ctx.arc(x + 0.9, y + py, 0.06, 0, 7); ctx.fill(); });
    });
    if (!road.length) return;
    const town = layout === 'town';
    const set = new Set(road.map(([x, y]) => keyOf(x, y)));
    const shape = (grow) => {
      ctx.beginPath();
      road.forEach(([x, y]) => {
        const j = (hash3(x, y, 77) - 0.5) * 0.14;
        const rr = 0.56 + grow + (hash3(x, y, 78) - 0.5) * 0.1;
        ctx.moveTo(x + 0.5 + rr, y + 0.5 + j); ctx.arc(x + 0.5, y + 0.5 + j, rr, 0, Math.PI * 2);
      });
      road.forEach(([x, y]) => {
        const hw = 0.44 + grow;
        [[1, 0], [0, 1]].forEach(([dx, dy]) => { if (set.has(keyOf(x + dx, y + dy))) ctx.rect(x + 0.5 - (dy ? hw : 0), y + 0.5 - (dx ? hw : 0), dx ? 1 : hw * 2, dy ? 1 : hw * 2); });
      });
    };
    const col = town ? ['rgba(40,34,28,.5)', '#5d5246'] : theme === 'snow' ? ['rgba(120,134,150,.4)', '#b9c3cc'] : theme === 'sand' ? ['rgba(110,84,52,.35)', '#a98a5c'] : ['rgba(40,28,16,.45)', '#6e5638'];
    shape(0.08); ctx.fillStyle = col[0]; ctx.fill('nonzero');
    shape(0); ctx.fillStyle = col[1]; ctx.fill('nonzero');
    ctx.save(); shape(0); ctx.clip('nonzero');
    if (town) {
      for (const [x, y] of road) for (let k = 0; k < 16; k++) {
        const cx = x - 0.1 + (k % 4) * 0.3 + (Math.floor(k / 4) % 2) * 0.15, cy = y - 0.1 + Math.floor(k / 4) * 0.3;
        ctx.fillStyle = hsl(30, 8, 36 + R() * 14); ctx.beginPath(); rrect(ctx, cx, cy, 0.26, 0.26, 0.08); ctx.fill();
        ctx.fillStyle = 'rgba(0,0,0,.22)'; ctx.fillRect(cx + 0.02, cy + 0.22, 0.22, 0.04);
      }
    } else {
      for (const [x, y] of road) {
        for (let k = 0; k < 8; k++) { ctx.fillStyle = R() < 0.5 ? 'rgba(0,0,0,.15)' : 'rgba(255,240,210,.1)'; ctx.beginPath(); blob(ctx, x + R(), y + R(), 0.1 + R() * 0.2, R, 8, 0.4); ctx.fill(); }
        for (let k = 0; k < 6; k++) { ctx.fillStyle = hsl(30, 10, 40 + R() * 20, 0.8); ctx.beginPath(); ctx.arc(x + R(), y + R(), 0.015 + R() * 0.02, 0, 7); ctx.fill(); }
      }
    }
    ctx.restore();
  }

  // A rectangle that reaches the square's edge where it joins a neighbour of the same kind.
  function autoShape(ctx, x, y, c, inset, r, strokeOnly) {
    const l = c.l ? 0 : inset, rt = c.r ? 0 : inset, u = c.u ? 0 : inset, d = c.d ? 0 : inset;
    const x0 = x + l, x1 = x + 1 - rt, y0 = y + u, y1 = y + 1 - d;
    const tl = !c.l && !c.u ? r : 0, tr = !c.r && !c.u ? r : 0, br = !c.r && !c.d ? r : 0, bl = !c.l && !c.d ? r : 0;
    if (strokeOnly) {
      // only the outer edges
      if (!c.u) { ctx.moveTo(x0 + (c.l ? -0.001 : 0), y0); ctx.lineTo(x1, y0); }
      if (!c.r) { ctx.moveTo(x1, y0); ctx.lineTo(x1, y1); }
      if (!c.d) { ctx.moveTo(x1, y1); ctx.lineTo(x0, y1); }
      if (!c.l) { ctx.moveTo(x0, y1); ctx.lineTo(x0, y0); }
      return;
    }
    ctx.moveTo(x0 + tl, y0); ctx.lineTo(x1 - tr, y0); if (tr) ctx.quadraticCurveTo(x1, y0, x1, y0 + tr);
    ctx.lineTo(x1, y1 - br); if (br) ctx.quadraticCurveTo(x1, y1, x1 - br, y1);
    ctx.lineTo(x0 + bl, y1); if (bl) ctx.quadraticCurveTo(x0, y1, x0, y1 - bl);
    ctx.lineTo(x0, y0 + tl); if (tl) ctx.quadraticCurveTo(x0, y0, x0 + tl, y0);
    ctx.closePath();
  }

  function components(m, ch) {
    const seen = new Set(), out = [];
    for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
      if (at(m, x, y) !== ch || seen.has(keyOf(x, y))) continue;
      const c = { cells: [], x0: x, y0: y, x1: x, y1: y };
      const q = [[x, y]]; seen.add(keyOf(x, y));
      while (q.length) {
        const [cx, cy] = q.pop();
        c.cells.push([cx, cy]);
        c.x0 = Math.min(c.x0, cx); c.y0 = Math.min(c.y0, cy); c.x1 = Math.max(c.x1, cx); c.y1 = Math.max(c.y1, cy);
        [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dy]) => { const nx = cx + dx, ny = cy + dy; if (at(m, nx, ny) === ch && !seen.has(keyOf(nx, ny))) { seen.add(keyOf(nx, ny)); q.push([nx, ny]); } });
      }
      out.push(c);
    }
    return out;
  }

  function rug(ctx, c, R) {
    const x = c.x0 + 0.1, y = c.y0 + 0.1, w = c.x1 - c.x0 + 0.8, h = c.y1 - c.y0 + 0.8;
    const pal = [['#6e2421', '#c69a48', '#2e3c56'], ['#2b4057', '#c9a35a', '#7a2a24'], ['#5a3a1e', '#d7b56a', '#3d5a3a']][Math.floor(R() * 3)];
    ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.fillRect(x + 0.03, y + 0.04, w, h);
    // fringe
    ctx.strokeStyle = '#d8ccb0'; ctx.lineWidth = 0.012;
    const long = w >= h;
    for (let t = 0.04; t < (long ? h : w) - 0.02; t += 0.05) {
      ctx.beginPath();
      if (long) { ctx.moveTo(x, y + t); ctx.lineTo(x - 0.06, y + t); ctx.moveTo(x + w, y + t); ctx.lineTo(x + w + 0.06, y + t); }
      else { ctx.moveTo(x + t, y); ctx.lineTo(x + t, y - 0.06); ctx.moveTo(x + t, y + h); ctx.lineTo(x + t, y + h + 0.06); }
      ctx.stroke();
    }
    ctx.fillStyle = pal[0]; ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = pal[1]; ctx.lineWidth = 0.05; ctx.strokeRect(x + 0.1, y + 0.1, w - 0.2, h - 0.2);
    ctx.strokeStyle = pal[2]; ctx.lineWidth = 0.03; ctx.strokeRect(x + 0.18, y + 0.18, w - 0.36, h - 0.36);
    // medallion and corner motifs
    const cx = x + w / 2, cy = y + h / 2;
    ctx.fillStyle = pal[2]; ctx.beginPath(); ctx.moveTo(cx, cy - h * 0.32); ctx.lineTo(cx + w * 0.28, cy); ctx.lineTo(cx, cy + h * 0.32); ctx.lineTo(cx - w * 0.28, cy); ctx.closePath(); ctx.fill();
    ctx.fillStyle = pal[1]; ctx.beginPath(); ctx.moveTo(cx, cy - h * 0.18); ctx.lineTo(cx + w * 0.15, cy); ctx.lineTo(cx, cy + h * 0.18); ctx.lineTo(cx - w * 0.15, cy); ctx.closePath(); ctx.fill();
    ctx.fillStyle = pal[0]; ctx.beginPath(); ctx.arc(cx, cy, Math.min(w, h) * 0.06, 0, 7); ctx.fill();
    ctx.fillStyle = pal[1];
    [[x + 0.3, y + 0.3], [x + w - 0.3, y + 0.3], [x + 0.3, y + h - 0.3], [x + w - 0.3, y + h - 0.3]].forEach(([px, py]) => { ctx.beginPath(); ctx.moveTo(px, py - 0.07); ctx.lineTo(px + 0.07, py); ctx.lineTo(px, py + 0.07); ctx.lineTo(px - 0.07, py); ctx.fill(); });
    // worn texture
    for (let i = 0; i < w * h * 30; i++) { ctx.fillStyle = R() < 0.5 ? 'rgba(0,0,0,.08)' : 'rgba(255,255,255,.05)'; ctx.fillRect(x + R() * w, y + R() * h, 0.03, 0.01); }
  }

  function water(ctx, m, T, R) {
    const isW = (x, y) => { const ch = T(x, y); return ch === '~'; };
    for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
      const ch = T(x, y);
      if (ch === '~') {
        const g = ctx.createLinearGradient(x, y, x, y + 1);
        g.addColorStop(0, '#1b3d4f'); g.addColorStop(1, '#14303f');
        ctx.fillStyle = g; ctx.fillRect(x - 0.001, y - 0.001, 1.002, 1.002);
        // deeper further from shore
        let near = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (!isW(x + dx, y + dy) && at(m, x + dx, y + dy) !== ' ') near++;
        if (!near) { ctx.fillStyle = 'rgba(5,15,25,.35)'; ctx.fillRect(x, y, 1, 1); }
        ctx.strokeStyle = 'rgba(140,200,220,.14)'; ctx.lineWidth = 0.02;
        for (let k = 0; k < 3; k++) { const py = y + 0.2 + k * 0.3 + (R() - 0.5) * 0.1, px = x + R() * 0.4; ctx.beginPath(); ctx.moveTo(px, py); ctx.quadraticCurveTo(px + 0.15, py - 0.05, px + 0.3, py); ctx.quadraticCurveTo(px + 0.45, py + 0.05, px + 0.6, py); ctx.stroke(); }
      }
    }
    // shore bands and foam
    for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
      if (T(x, y) !== '~') continue;
      [[0, -1, 'u'], [0, 1, 'd'], [-1, 0, 'l'], [1, 0, 'r']].forEach(([dx, dy]) => {
        const n = T(x + dx, y + dy);
        if (n === '~' || n === ' ') return;
        const x0 = dx === 1 ? x + 1 : x, y0 = dy === 1 ? y + 1 : y;
        const g = dy ? ctx.createLinearGradient(x, y0, x, y0 - dy * 0.45) : ctx.createLinearGradient(x0, y, x0 - dx * 0.45, y);
        g.addColorStop(0, 'rgba(80,150,160,.75)'); g.addColorStop(1, 'rgba(80,150,160,0)');
        ctx.fillStyle = g;
        if (dy) ctx.fillRect(x, dy > 0 ? y + 0.55 : y, 1, 0.45); else ctx.fillRect(dx > 0 ? x + 0.55 : x, y, 0.45, 1);
        ctx.strokeStyle = 'rgba(235,245,240,.65)'; ctx.lineWidth = 0.028;
        ctx.beginPath();
        for (let t = 0; t <= 1.001; t += 0.25) {
          const wob = Math.sin((x + y) * 3 + t * 9) * 0.04;
          const px = dy ? x + t : x0 - dx * (0.06 + wob), py = dy ? y0 - dy * (0.06 + wob) : y + t;
          if (t === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
      });
    }
    // shallows over the floor
    const sh = [];
    for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) if (T(x, y) === '_') sh.push([x, y]);
    if (!sh.length) return;
    const wet = (x, y) => { const ch = T(x, y); return ch === '_' || ch === '~'; };
    ctx.beginPath();
    sh.forEach(([x, y]) => autoShape(ctx, x, y, { l: wet(x - 1, y), r: wet(x + 1, y), u: wet(x, y - 1), d: wet(x, y + 1) }, 0.07, 0.3));
    ctx.fillStyle = 'rgba(48,104,124,.6)'; ctx.fill('nonzero');
    ctx.strokeStyle = 'rgba(200,235,240,.35)'; ctx.lineWidth = 0.02;
    ctx.beginPath();
    sh.forEach(([x, y]) => autoShape(ctx, x, y, { l: wet(x - 1, y), r: wet(x + 1, y), u: wet(x, y - 1), d: wet(x, y + 1) }, 0.07, 0.3, true));
    ctx.stroke();
    ctx.strokeStyle = 'rgba(190,230,235,.25)'; ctx.lineWidth = 0.02;
    sh.forEach(([x, y]) => { for (let k = 0; k < 2; k++) { ctx.beginPath(); ctx.ellipse(x + 0.3 + R() * 0.4, y + 0.3 + R() * 0.4, 0.1 + R() * 0.1, 0.06 + R() * 0.05, 0, 0, 7); ctx.stroke(); } });
  }

  function rails(ctx, x, y, T) {
    const c = (dx, dy) => { const n = T(x + dx, y + dy); return n === 'R' || n === 'S'; };
    let dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dy]) => c(dx, dy));
    if (dirs.length === 0) dirs = [[1, 0], [-1, 0]];
    if (dirs.length === 1) dirs.push([-dirs[0][0], -dirs[0][1]]);
    dirs.forEach(([dx, dy]) => {
      const px = -dy, py = dx;
      // sleepers
      ctx.fillStyle = '#4a3322';
      for (let t = 0.12; t < 0.55; t += 0.2) {
        const cx = x + 0.5 + dx * t, cy = y + 0.5 + dy * t;
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(Math.atan2(dy, dx)); ctx.fillRect(-0.05, -0.32, 0.1, 0.64); ctx.restore();
      }
      ctx.strokeStyle = '#8b8f92'; ctx.lineWidth = 0.045;
      [-0.2, 0.2].forEach((o) => { ctx.beginPath(); ctx.moveTo(x + 0.5 + px * o, y + 0.5 + py * o); ctx.lineTo(x + 0.5 + dx * 0.52 + px * o, y + 0.5 + dy * 0.52 + py * o); ctx.stroke(); });
      ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.lineWidth = 0.012;
      [-0.21, 0.19].forEach((o) => { ctx.beginPath(); ctx.moveTo(x + 0.5 + px * o, y + 0.5 + py * o); ctx.lineTo(x + 0.5 + dx * 0.52 + px * o, y + 0.5 + dy * 0.52 + py * o); ctx.stroke(); });
    });
  }

  function stairs(ctx, x, y, T, theme) {
    // Steps run down toward a wall (or downward by default).
    let d = [0, 1];
    for (const v of [[0, -1], [-1, 0], [1, 0], [0, 1]]) if (T(x + v[0], y + v[1]) === '#' || T(x + v[0], y + v[1]) === ' ') { d = v; break; }
    ctx.save(); ctx.translate(x + 0.5, y + 0.5); ctx.rotate(Math.atan2(d[1], d[0]) - Math.PI / 2);
    ctx.fillStyle = '#100d0b'; ctx.fillRect(-0.46, -0.46, 0.92, 0.92);
    const n = 5;
    for (let i = 0; i < n; i++) {
      const y0 = -0.46 + i * (0.92 / n), l = 46 - i * 7;
      ctx.fillStyle = theme === 'wood' ? hsl(28, 30, l * 0.7) : hsl(35, 6, l * 0.85);
      ctx.fillRect(-0.4 + i * 0.02, y0, 0.8 - i * 0.04, 0.92 / n - 0.03);
      ctx.fillStyle = 'rgba(255,255,255,.12)'; ctx.fillRect(-0.4 + i * 0.02, y0, 0.8 - i * 0.04, 0.02);
    }
    ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(-0.48, -0.46, 0.06, 0.92); ctx.fillRect(0.42, -0.46, 0.06, 0.92);
    ctx.restore();
  }

  function wallShadows(ctx, m, T) {
    const solid = (ch) => ch === '#' || ch === '+' || ch === ' ';
    for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
      const ch = T(x, y);
      if (solid(ch) || ch === '~') continue;
      const band = (x0, y0, x1, y1, a) => { const g = ctx.createLinearGradient(x0, y0, x1, y1); g.addColorStop(0, 'rgba(0,0,0,' + a + ')'); g.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = g; ctx.fillRect(x, y, 1, 1); };
      if (solid(T(x, y - 1))) band(x, y, x, y + 0.42, 0.55);
      if (solid(T(x - 1, y))) band(x, y, x + 0.34, y, 0.42);
      if (solid(T(x + 1, y))) band(x + 1, y, x + 0.75, y, 0.3);
      if (solid(T(x, y + 1))) band(x, y + 1, x, y + 0.8, 0.25);
    }
  }

  const WALL_STYLE = { tavern: 'timber', town: 'timber', docks: 'timber', camp: 'timber', dungeon: 'masonry', crypt: 'masonry', cave: 'rock', mine: 'rock', mountain: 'rock', shore: 'rock', forest: 'hedge' };

  function walls(ctx, m, T, R, layout, theme) {
    const style = WALL_STYLE[layout] || 'masonry';
    const W = m.w, H = m.h;
    const solid = (ch) => ch === '#';
    const floorish = (ch) => ch !== '#' && ch !== ' ';
    // distance (in squares) from open ground, for darkening deep rock
    const dist = [];
    for (let y = 0; y < H; y++) { dist.push([]); for (let x = 0; x < W; x++) dist[y].push(solid(T(x, y)) ? 99 : 0); }
    for (let pass = 0; pass < 4; pass++) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (dist[y][x] === 0) continue;
      let best = 99;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const r = dist[y + dy]; if (r && r[x + dx] != null) best = Math.min(best, r[x + dx] + 1); }
      dist[y][x] = Math.min(dist[y][x], best);
    }
    const cells = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (solid(T(x, y))) cells.push([x, y]);
    if (!cells.length) return;
    const top = { timber: '#57504a', masonry: layout === 'crypt' ? '#34373c' : '#3a3833', rock: theme === 'snow' ? '#6b6f74' : theme === 'sand' ? '#8a7353' : '#6a6159', hedge: '#2c4321' }[style];
    const bumps = style === 'rock' || style === 'hedge';
    // shape of the wall mass: tiles plus bulges into the floor for rock
    const bulge = [];
    if (bumps) {
      cells.forEach(([x, y]) => {
        [[0, -1], [0, 1], [-1, 0], [1, 0]].forEach(([dx, dy]) => {
          if (!floorish(T(x + dx, y + dy))) return;
          for (let k = 0; k < 3; k++) {
            const t = 0.15 + k * 0.35 + (R() - 0.5) * 0.12;
            const ex = dx ? x + (dx > 0 ? 1 : 0) : x + t, ey = dy ? y + (dy > 0 ? 1 : 0) : y + t;
            bulge.push([ex - dx * 0.04, ey - dy * 0.04, 0.12 + R() * 0.14]);
          }
        });
      });
    }
    const massPath = (grow) => {
      ctx.beginPath();
      cells.forEach(([x, y]) => ctx.rect(x - grow, y - grow, 1 + grow * 2, 1 + grow * 2));
      bulge.forEach(([bx, by, r]) => { ctx.moveTo(bx + r + grow, by); ctx.arc(bx, by, r + grow, 0, Math.PI * 2); });
    };
    // outline: the mass grown a little, in near black
    massPath(0.045); ctx.fillStyle = 'rgba(6,6,7,.9)'; ctx.fill('nonzero');
    massPath(0); ctx.fillStyle = top; ctx.fill('nonzero');
    ctx.save(); massPath(0); ctx.clip('nonzero');
    // texture on the top faces
    if (style === 'masonry') {
      ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 0.02;
      cells.forEach(([x, y]) => {
        for (let r = 0; r < 3; r++) {
          const yy = y + r / 3;
          ctx.beginPath(); ctx.moveTo(x, yy); ctx.lineTo(x + 1, yy); ctx.stroke();
          const off = ((x + y + r) % 2) * 0.25;
          for (let xx = x + off; xx < x + 1; xx += 0.5) { ctx.beginPath(); ctx.moveTo(xx, yy); ctx.lineTo(xx, yy + 1 / 3); ctx.stroke(); }
        }
        for (let k = 0; k < 4; k++) { ctx.fillStyle = R() < 0.5 ? 'rgba(255,255,255,.05)' : 'rgba(0,0,0,.12)'; ctx.fillRect(x + Math.floor(R() * 2) * 0.5, y + Math.floor(R() * 3) / 3, 0.5, 1 / 3); }
      });
    } else if (style === 'timber') {
      cells.forEach(([x, y]) => {
        // rubble-stone wall with a timber frame
        ctx.strokeStyle = 'rgba(0,0,0,.32)'; ctx.lineWidth = 0.018;
        for (let r = 0; r < 3; r++) {
          const yy = y + r / 3;
          ctx.beginPath(); ctx.moveTo(x, yy); ctx.lineTo(x + 1, yy); ctx.stroke();
          const off = ((x + y + r) % 2) * 0.22;
          for (let xx = x + off + 0.1; xx < x + 1; xx += 0.42) { ctx.beginPath(); ctx.moveTo(xx, yy); ctx.lineTo(xx, yy + 1 / 3); ctx.stroke(); }
        }
        for (let k = 0; k < 3; k++) { ctx.fillStyle = R() < 0.5 ? 'rgba(255,240,220,.06)' : 'rgba(0,0,0,.12)'; ctx.fillRect(x + R() * 0.6, y + Math.floor(R() * 3) / 3, 0.4, 1 / 3); }
        const corner = (solid(T(x - 1, y)) || solid(T(x + 1, y))) && (solid(T(x, y - 1)) || solid(T(x, y + 1)));
        if (corner) {
          ctx.fillStyle = '#24170e'; ctx.fillRect(x + 0.18, y + 0.18, 0.64, 0.64);
          ctx.fillStyle = '#4c3626'; ctx.fillRect(x + 0.24, y + 0.24, 0.52, 0.52);
          ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.strokeRect(x + 0.32, y + 0.32, 0.36, 0.36);
        }
      });
    } else if (style === 'hedge') {
      cells.concat(bulge.map(([bx, by]) => [bx - 0.5, by - 0.5])).forEach(([x, y]) => {
        for (let k = 0; k < 5; k++) { ctx.fillStyle = R() < 0.5 ? 'rgba(80,120,50,.6)' : 'rgba(18,30,12,.5)'; ctx.beginPath(); ctx.arc(x + R(), y + R(), 0.15 + R() * 0.2, 0, 7); ctx.fill(); }
      });
    } else {
      cells.forEach(([x, y]) => {
        for (let k = 0; k < 6; k++) { ctx.fillStyle = R() < 0.5 ? 'rgba(255,255,255,.07)' : 'rgba(0,0,0,.18)'; ctx.beginPath(); blob(ctx, x + R(), y + R(), 0.1 + R() * 0.25, R, 8, 0.4); ctx.fill(); }
        ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 0.015;
        let px = x + R(), py = y + R(); ctx.beginPath(); ctx.moveTo(px, py); for (let s = 0; s < 3; s++) { px += (R() - 0.5) * 0.4; py += (R() - 0.5) * 0.4; ctx.lineTo(px, py); } ctx.stroke();
        if (theme === 'snow' && R() < 0.7) { ctx.fillStyle = 'rgba(240,245,250,.75)'; ctx.beginPath(); blob(ctx, x + 0.3 + R() * 0.4, y + 0.25 + R() * 0.3, 0.18 + R() * 0.15, R, 8, 0.3); ctx.fill(); }
      });
      bulge.forEach(([bx, by, r]) => { ctx.fillStyle = 'rgba(255,255,255,.08)'; ctx.beginPath(); ctx.arc(bx - r * 0.25, by - r * 0.25, r * 0.6, 0, 7); ctx.fill(); });
    }
    // front faces where the wall stands above open floor (gives the walls height)
    cells.forEach(([x, y]) => {
      if (!floorish(T(x, y + 1))) return;
      const fh = bumps ? 0.22 : 0.3;
      const g = ctx.createLinearGradient(0, y + 1 - fh, 0, y + 1);
      const face = { timber: ['#6b4e34', '#3e2b1c'], masonry: layout === 'crypt' ? ['#4a4e55', '#2a2c30'] : ['#58544c', '#2e2c28'], rock: ['#3a342f', '#221e1b'], hedge: ['#22361a', '#142010'] }[style];
      g.addColorStop(0, face[0]); g.addColorStop(1, face[1]);
      ctx.fillStyle = g; ctx.fillRect(x, y + 1 - fh, 1, fh);
      if (style === 'masonry') {
        ctx.strokeStyle = 'rgba(0,0,0,.4)'; ctx.lineWidth = 0.014;
        ctx.beginPath(); ctx.moveTo(x, y + 1 - fh / 2); ctx.lineTo(x + 1, y + 1 - fh / 2);
        for (let k = 0; k < 3; k++) { const xx = x + 0.12 + k * 0.36 + ((y % 2) * 0.18); ctx.moveTo(xx, y + 1 - fh); ctx.lineTo(xx, y + 1 - fh / 2); ctx.moveTo(xx + 0.18, y + 1 - fh / 2); ctx.lineTo(xx + 0.18, y + 1); }
        ctx.stroke();
      } else if (style === 'timber') {
        ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 0.014;
        ctx.beginPath(); for (let k = 1; k < 5; k++) { ctx.moveTo(x + k * 0.2, y + 1 - fh); ctx.lineTo(x + k * 0.2, y + 1); } ctx.stroke();
      }
      ctx.fillStyle = 'rgba(255,240,210,.14)'; ctx.fillRect(x, y + 1 - fh, 1, 0.018);
    });
    ctx.restore();
    // rims on edges facing the floor
    ctx.lineWidth = 0.022;
    cells.forEach(([x, y]) => {
      ctx.strokeStyle = 'rgba(255,240,215,.12)';
      ctx.beginPath();
      if (floorish(T(x, y - 1))) { ctx.moveTo(x, y + 0.012); ctx.lineTo(x + 1, y + 0.012); }
      if (floorish(T(x - 1, y))) { ctx.moveTo(x + 0.012, y); ctx.lineTo(x + 0.012, y + 1); }
      if (floorish(T(x + 1, y))) { ctx.moveTo(x + 0.988, y); ctx.lineTo(x + 0.988, y + 1); }
      ctx.stroke();
    });
    // deep rock fades to black
    cells.forEach(([x, y]) => { const d = dist[y][x]; if (d >= 2) { ctx.fillStyle = 'rgba(4,5,6,' + [0, 0, 0.45, 0.72, 0.86][Math.min(4, d)] + ')'; ctx.fillRect(x - 0.002, y - 0.002, 1.004, 1.004); } });
  }

  function door(ctx, x, y, T, closed, layout) {
    const wl = (ch) => ch === '#' || ch === 'x' || ch === 'k';
    const horiz = wl(T(x - 1, y)) || wl(T(x + 1, y)) || !(wl(T(x, y - 1)) || wl(T(x, y + 1)));
    ctx.save(); ctx.translate(x + 0.5, y + 0.5); if (!horiz) ctx.rotate(Math.PI / 2);
    // threshold
    ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(-0.5, -0.2, 1, 0.4);
    ctx.fillStyle = layout === 'dungeon' || layout === 'crypt' ? '#57534c' : '#4a3626'; ctx.fillRect(-0.44, -0.14, 0.88, 0.28);
    // jambs
    ctx.fillStyle = '#1a1612'; ctx.fillRect(-0.53, -0.27, 0.13, 0.54); ctx.fillRect(0.4, -0.27, 0.13, 0.54);
    ctx.fillStyle = layout === 'dungeon' || layout === 'crypt' ? '#6a665e' : '#5c412b'; ctx.fillRect(-0.51, -0.25, 0.1, 0.5); ctx.fillRect(0.41, -0.25, 0.1, 0.5);
    if (closed) {
      ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(-0.41, -0.11, 0.84, 0.28);
      const g = ctx.createLinearGradient(0, -0.13, 0, 0.13);
      g.addColorStop(0, '#8a5d36'); g.addColorStop(1, '#5a3a20');
      ctx.fillStyle = g; ctx.fillRect(-0.42, -0.13, 0.84, 0.26);
      ctx.strokeStyle = 'rgba(30,18,8,.7)'; ctx.lineWidth = 0.016;
      ctx.beginPath(); for (let k = 1; k < 5; k++) { ctx.moveTo(-0.42 + k * 0.168, -0.13); ctx.lineTo(-0.42 + k * 0.168, 0.13); } ctx.stroke();
      ctx.fillStyle = '#2b2b2c'; ctx.fillRect(-0.3, -0.13, 0.05, 0.26); ctx.fillRect(0.25, -0.13, 0.05, 0.26);
      ctx.fillStyle = '#c9a54a'; ctx.beginPath(); ctx.arc(0.12, 0.06, 0.035, 0, 7); ctx.fill();
      ctx.strokeStyle = '#1a120a'; ctx.lineWidth = 0.02; ctx.strokeRect(-0.42, -0.13, 0.84, 0.26);
    } else {
      // leaf swung open against the left jamb
      ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.fillRect(-0.36, 0.02, 0.14, 0.62);
      ctx.fillStyle = '#7a5130'; ctx.fillRect(-0.4, 0, 0.12, 0.6);
      ctx.strokeStyle = 'rgba(30,18,8,.7)'; ctx.lineWidth = 0.016; ctx.strokeRect(-0.4, 0, 0.12, 0.6);
      ctx.fillStyle = '#2b2b2c'; ctx.fillRect(-0.4, 0.1, 0.12, 0.04); ctx.fillRect(-0.4, 0.46, 0.12, 0.04);
    }
    ctx.restore();
  }

  function chair(ctx, x, y, T, h) {
    let d = null;
    for (const v of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const n = T(x + v[0], y + v[1]); if (n === '=' || n === 'B') { d = v; break; } }
    const bar = d && T(x + d[0], y + d[1]) === 'B';
    const cx = x + 0.5 + (d ? d[0] * 0.08 : 0), cy = y + 0.5 + (d ? d[1] * 0.08 : 0);
    ctx.fillStyle = 'rgba(0,0,0,.4)';
    if (bar || !d) {
      ctx.beginPath(); ctx.arc(cx + 0.04, cy + 0.05, 0.22, 0, 7); ctx.fill();
      ctx.fillStyle = '#6b4627'; ctx.beginPath(); ctx.arc(cx, cy, 0.21, 0, 7); ctx.fill();
      ctx.strokeStyle = '#3a2414'; ctx.lineWidth = 0.025; ctx.stroke();
      ctx.strokeStyle = 'rgba(255,220,170,.15)'; ctx.lineWidth = 0.012; ctx.beginPath(); ctx.arc(cx, cy, 0.13, 0, 7); ctx.stroke();
      return;
    }
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(Math.atan2(d[1], d[0]));
    ctx.fillRect(-0.24, -0.22, 0.5, 0.5);
    ctx.fillStyle = h < 0.5 ? '#6e4828' : '#5f3d22'; ctx.beginPath(); rrect(ctx, -0.25, -0.24, 0.46, 0.48, 0.06); ctx.fill();
    ctx.strokeStyle = '#2f1d10'; ctx.lineWidth = 0.022; ctx.stroke();
    ctx.fillStyle = '#3f2815'; ctx.beginPath(); rrect(ctx, -0.33, -0.27, 0.12, 0.54, 0.04); ctx.fill();
    ctx.fillStyle = 'rgba(255,220,170,.12)'; ctx.fillRect(-0.2, -0.2, 0.36, 0.04);
    ctx.restore();
  }

  function table(ctx, x, y, c, R, _, layout) {
    const inset = 0.1;
    ctx.fillStyle = '#2c1a0e'; ctx.beginPath(); autoShape(ctx, x, y, c, inset - 0.02, 0.12); ctx.fill();
    const g = ctx.createLinearGradient(x, y, x + 1, y + 1);
    g.addColorStop(0, '#94653d'); g.addColorStop(1, '#6c4526');
    ctx.fillStyle = g; ctx.beginPath(); autoShape(ctx, x, y, c, inset, 0.1); ctx.fill();
    ctx.save(); ctx.beginPath(); autoShape(ctx, x, y, c, inset, 0.1); ctx.clip();
    const vert = c.u || c.d;
    ctx.strokeStyle = 'rgba(40,22,10,.5)'; ctx.lineWidth = 0.012;
    for (let k = 1; k < 4; k++) { ctx.beginPath(); if (vert) { ctx.moveTo(x + k * 0.25, y); ctx.lineTo(x + k * 0.25, y + 1); } else { ctx.moveTo(x, y + k * 0.25); ctx.lineTo(x + 1, y + k * 0.25); } ctx.stroke(); }
    ctx.strokeStyle = 'rgba(60,34,16,.25)'; ctx.lineWidth = 0.007;
    for (let k = 0; k < 7; k++) { const o = R(); ctx.beginPath(); if (vert) { ctx.moveTo(x + o, y); ctx.bezierCurveTo(x + o + 0.03, y + 0.4, x + o - 0.03, y + 0.6, x + o, y + 1); } else { ctx.moveTo(x, y + o); ctx.bezierCurveTo(x + 0.4, y + o + 0.03, x + 0.6, y + o - 0.03, x + 1, y + o); } ctx.stroke(); }
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,225,180,.22)'; ctx.lineWidth = 0.02; ctx.beginPath(); autoShape(ctx, x, y, c, inset + 0.02, 0.08, true); ctx.stroke();
    // things on the table
    const n = 1 + Math.floor(R() * 2.3);
    for (let i = 0; i < n; i++) {
      const px = x + 0.25 + R() * 0.5, py = y + 0.25 + R() * 0.5, k = R();
      if (k < 0.35) { // tankard
        ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.beginPath(); ctx.arc(px + 0.02, py + 0.025, 0.08, 0, 7); ctx.fill();
        ctx.fillStyle = '#8a6a44'; ctx.beginPath(); ctx.arc(px, py, 0.075, 0, 7); ctx.fill();
        ctx.fillStyle = '#efe4c4'; ctx.beginPath(); ctx.arc(px, py, 0.052, 0, 7); ctx.fill();
        ctx.strokeStyle = '#5a4128'; ctx.lineWidth = 0.022; ctx.beginPath(); ctx.arc(px + 0.09, py, 0.035, -1.3, 1.3); ctx.stroke();
      } else if (k < 0.65) { // plate with food
        ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.beginPath(); ctx.arc(px + 0.02, py + 0.025, 0.12, 0, 7); ctx.fill();
        ctx.fillStyle = '#d9d2c0'; ctx.beginPath(); ctx.arc(px, py, 0.115, 0, 7); ctx.fill();
        ctx.fillStyle = '#b7aa8e'; ctx.beginPath(); ctx.arc(px, py, 0.08, 0, 7); ctx.fill();
        ctx.fillStyle = R() < 0.5 ? '#9a5b2c' : '#c69b4a'; ctx.beginPath(); ctx.ellipse(px - 0.01, py, 0.05, 0.035, R() * 3, 0, 7); ctx.fill();
      } else if (k < 0.85) { // candle (flame added by the light layer)
        ctx.fillStyle = '#e6dcc4'; ctx.beginPath(); ctx.arc(px, py, 0.045, 0, 7); ctx.fill();
        ctx.fillStyle = '#c9bd9d'; ctx.beginPath(); ctx.arc(px, py, 0.025, 0, 7); ctx.fill();
        ctx.fillStyle = '#5a3e22'; ctx.beginPath(); ctx.arc(px, py, 0.075, 0, 7); ctx.globalAlpha = 0.25; ctx.fill(); ctx.globalAlpha = 1;
      } else { // cards or a map
        ctx.save(); ctx.translate(px, py); ctx.rotate(R() * 3);
        ctx.fillStyle = '#e9dfc4'; ctx.fillRect(-0.12, -0.08, 0.24, 0.16);
        ctx.strokeStyle = 'rgba(120,80,40,.6)'; ctx.lineWidth = 0.01; ctx.strokeRect(-0.1, -0.06, 0.2, 0.12);
        ctx.restore();
      }
    }
  }

  function bar(ctx, x, y, c, R) {
    ctx.fillStyle = '#1d1209'; ctx.beginPath(); autoShape(ctx, x, y, c, 0.04, 0.08); ctx.fill();
    const g = ctx.createLinearGradient(x, y, x + 1, y + 1);
    g.addColorStop(0, '#6e4528'); g.addColorStop(1, '#4b2d18');
    ctx.fillStyle = g; ctx.beginPath(); autoShape(ctx, x, y, c, 0.07, 0.07); ctx.fill();
    ctx.save(); ctx.beginPath(); autoShape(ctx, x, y, c, 0.07, 0.07); ctx.clip();
    const vert = c.u || c.d;
    ctx.strokeStyle = 'rgba(255,215,160,.12)'; ctx.lineWidth = 0.01;
    for (let k = 0; k < 6; k++) { const o = R(); ctx.beginPath(); if (vert) { ctx.moveTo(x + o, y); ctx.lineTo(x + o, y + 1); } else { ctx.moveTo(x, y + o); ctx.lineTo(x + 1, y + o); } ctx.stroke(); }
    ctx.restore();
    ctx.strokeStyle = '#b8903f'; ctx.lineWidth = 0.03; ctx.beginPath(); autoShape(ctx, x, y, c, 0.12, 0.05, true); ctx.stroke();
    const cols = ['#3f6a4a', '#6a3a2a', '#2f5a72', '#8a7a2a', '#5a2f4a'];
    const n = Math.floor(R() * 3);
    for (let i = 0; i < n; i++) {
      const px = x + 0.28 + R() * 0.44, py = y + 0.28 + R() * 0.44;
      if (R() < 0.55) { ctx.fillStyle = cols[Math.floor(R() * cols.length)]; ctx.beginPath(); ctx.arc(px, py, 0.06, 0, 7); ctx.fill(); ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.beginPath(); ctx.arc(px - 0.02, py - 0.02, 0.018, 0, 7); ctx.fill(); }
      else { ctx.fillStyle = '#8a6a44'; ctx.beginPath(); ctx.arc(px, py, 0.065, 0, 7); ctx.fill(); ctx.fillStyle = '#efe4c4'; ctx.beginPath(); ctx.arc(px, py, 0.045, 0, 7); ctx.fill(); }
    }
  }

  function barrel(ctx, x, y, R, layout) {
    const k = R(), cx = x + 0.5, cy = y + 0.5;
    if (k < 0.5) {
      ctx.fillStyle = '#3a2412'; ctx.beginPath(); ctx.arc(cx, cy, 0.38, 0, 7); ctx.fill();
      const g = ctx.createRadialGradient(cx - 0.1, cy - 0.1, 0.05, cx, cy, 0.36);
      g.addColorStop(0, '#9a6a3c'); g.addColorStop(1, '#5e3b1e');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, 0.34, 0, 7); ctx.fill();
      ctx.strokeStyle = '#2d2d2e'; ctx.lineWidth = 0.035; ctx.beginPath(); ctx.arc(cx, cy, 0.34, 0, 7); ctx.stroke();
      ctx.lineWidth = 0.02; ctx.beginPath(); ctx.arc(cx, cy, 0.24, 0, 7); ctx.stroke();
      ctx.strokeStyle = 'rgba(40,22,10,.55)'; ctx.lineWidth = 0.012;
      ctx.beginPath(); for (let i = -2; i <= 2; i++) { ctx.moveTo(cx + i * 0.09, cy - Math.sqrt(0.05 - (i * 0.09) ** 2)); ctx.lineTo(cx + i * 0.09, cy + Math.sqrt(0.05 - (i * 0.09) ** 2)); } ctx.stroke();
      ctx.fillStyle = '#2a1a0d'; ctx.beginPath(); ctx.arc(cx + 0.1, cy - 0.06, 0.03, 0, 7); ctx.fill();
    } else if (k < 0.82) {
      const s = 0.36, a = (R() - 0.5) * 0.3;
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(a);
      ctx.fillStyle = '#3b2a17'; ctx.fillRect(-s - 0.03, -s - 0.03, 2 * s + 0.06, 2 * s + 0.06);
      ctx.fillStyle = '#8f6c40'; ctx.fillRect(-s, -s, 2 * s, 2 * s);
      ctx.strokeStyle = '#5b4126'; ctx.lineWidth = 0.05; ctx.strokeRect(-s + 0.03, -s + 0.03, 2 * s - 0.06, 2 * s - 0.06);
      ctx.beginPath(); ctx.moveTo(-s + 0.05, -s + 0.05); ctx.lineTo(s - 0.05, s - 0.05); ctx.stroke();
      ctx.strokeStyle = 'rgba(40,25,10,.4)'; ctx.lineWidth = 0.012; ctx.beginPath(); ctx.moveTo(-s, -0.12); ctx.lineTo(s, -0.12); ctx.moveTo(-s, 0.12); ctx.lineTo(s, 0.12); ctx.stroke();
      ctx.restore();
    } else {
      [[-0.12, -0.08, 0.24], [0.14, 0.1, 0.22]].forEach(([dx, dy, r]) => {
        ctx.fillStyle = '#4e3d24'; ctx.beginPath(); blob(ctx, cx + dx, cy + dy, r + 0.02, R, 9, 0.12); ctx.fill();
        ctx.fillStyle = '#b39a6a'; ctx.beginPath(); blob(ctx, cx + dx, cy + dy, r, R, 9, 0.12); ctx.fill();
        ctx.strokeStyle = '#7a6440'; ctx.lineWidth = 0.02; ctx.beginPath(); ctx.moveTo(cx + dx - 0.05, cy + dy - r * 0.6); ctx.lineTo(cx + dx + 0.05, cy + dy - r * 0.6); ctx.stroke();
      });
    }
  }

  function shelf(ctx, x, y, T, c, R, layout) {
    let d = null;
    for (const v of [[0, -1], [-1, 0], [1, 0], [0, 1]]) if (T(x + v[0], y + v[1]) === '#') { d = v; break; }
    ctx.save(); ctx.translate(x + 0.5, y + 0.5);
    if (d) ctx.rotate(Math.atan2(d[1], d[0]) + Math.PI / 2);
    const back = d ? -0.5 : -0.25, depth = d ? 0.48 : 0.5;
    ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.fillRect(-0.5, back, 1, depth + 0.07);
    ctx.fillStyle = '#3a2516'; ctx.fillRect(-0.5, back, 1, depth);
    ctx.fillStyle = '#21140b'; ctx.fillRect(-0.47, back + 0.04, 0.94, depth - 0.08);
    const cols = ['#7a2d26', '#2d4a6a', '#4f6a35', '#8a6a2a', '#5a3a5a', '#a08458', '#3a5a5a'];
    const weapons = layout === 'dungeon' && R() < 0.4;
    if (weapons) {
      ctx.strokeStyle = '#b9bdc0'; ctx.lineWidth = 0.03;
      for (let i = 0; i < 4; i++) { const px = -0.36 + i * 0.24; ctx.beginPath(); ctx.moveTo(px, back + 0.08); ctx.lineTo(px + 0.05, back + depth - 0.08); ctx.stroke(); }
    } else {
      let px = -0.45;
      while (px < 0.42) {
        const bw = 0.04 + R() * 0.05;
        ctx.fillStyle = cols[Math.floor(R() * cols.length)];
        ctx.fillRect(px, back + 0.06 + R() * 0.04, bw - 0.006, depth - 0.14 - R() * 0.06);
        px += bw;
        if (R() < 0.08) px += 0.08;
      }
    }
    ctx.fillStyle = 'rgba(255,220,170,.12)'; ctx.fillRect(-0.5, back + depth - 0.03, 1, 0.03);
    ctx.restore();
  }

  function bed(ctx, x, y, T, c, R, roll) {
    const blankets = ['#7a2d26', '#2d4a6a', '#4f6a35', '#6a4a2a'];
    if (roll) {
      ctx.save(); ctx.translate(x + 0.5, y + 0.5); ctx.rotate((R() - 0.5) * 0.6);
      ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.beginPath(); rrect(ctx, -0.18, -0.4, 0.42, 0.86, 0.15); ctx.fill();
      ctx.fillStyle = blankets[Math.floor(R() * 4)]; ctx.beginPath(); rrect(ctx, -0.2, -0.42, 0.4, 0.84, 0.16); ctx.fill();
      ctx.fillStyle = '#c9b48a'; ctx.beginPath(); rrect(ctx, -0.17, -0.4, 0.34, 0.16, 0.07); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.3)'; ctx.lineWidth = 0.02; ctx.beginPath(); ctx.moveTo(-0.2, 0.05); ctx.lineTo(0.2, 0.05); ctx.stroke();
      ctx.restore();
      return;
    }
    // head toward the wall, joined with a neighbour into a long bed
    let head = [0, -1];
    if (c.d && !c.u) head = [0, -1]; else if (c.u && !c.d) head = [0, 1]; else if (c.r && !c.l) head = [-1, 0]; else if (c.l && !c.r) head = [1, 0];
    else for (const v of [[0, -1], [-1, 0], [1, 0], [0, 1]]) if (T(x + v[0], y + v[1]) === '#') { head = v; break; }
    const isHead = !(head[0] ? c[head[0] < 0 ? 'l' : 'r'] : c[head[1] < 0 ? 'u' : 'd']);
    ctx.fillStyle = '#3a2516'; ctx.beginPath(); autoShape(ctx, x, y, c, 0.1, 0.06); ctx.fill();
    ctx.fillStyle = '#d9cfb6'; ctx.beginPath(); autoShape(ctx, x, y, c, 0.15, 0.05); ctx.fill();
    ctx.save(); ctx.translate(x + 0.5, y + 0.5); ctx.rotate(Math.atan2(head[1], head[0]) + Math.PI / 2);
    const col = blankets[Math.floor(hash3(x * 0 + Math.round(x / 3), Math.round(y / 3), 3) * 4)];
    if (isHead) {
      ctx.fillStyle = '#f1ebdc'; ctx.beginPath(); rrect(ctx, -0.3, -0.33, 0.6, 0.2, 0.08); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.15)'; ctx.lineWidth = 0.012; ctx.stroke();
      ctx.fillStyle = col; ctx.fillRect(-0.35, 0.02, 0.7, 0.48);
    } else { ctx.fillStyle = col; ctx.fillRect(-0.35, -0.5, 0.7, 0.85); }
    ctx.fillStyle = 'rgba(255,255,255,.1)'; ctx.fillRect(-0.35, isHead ? 0.02 : -0.5, 0.7, 0.04);
    ctx.restore();
  }

  function sarcophagus(ctx, x, y, c, R) {
    const horiz = c.l || c.r;
    ctx.save(); ctx.translate(x + 0.5 + (c.r ? 0.5 : 0), y + 0.5 + (c.d ? 0.5 : 0));
    if (horiz) ctx.rotate(Math.PI / 2);
    if (c.l || c.u) { ctx.restore(); return; }
    const L = c.r || c.d ? 0.92 : 0.44, Wd = 0.3;
    ctx.fillStyle = '#26282b'; ctx.beginPath(); rrect(ctx, -Wd - 0.04, -L - 0.04, 2 * Wd + 0.08, 2 * L + 0.08, 0.06); ctx.fill();
    const g = ctx.createLinearGradient(-Wd, -L, Wd, L); g.addColorStop(0, '#8d8a82'); g.addColorStop(1, '#5d5a54');
    ctx.fillStyle = g; ctx.beginPath(); rrect(ctx, -Wd, -L, 2 * Wd, 2 * L, 0.05); ctx.fill();
    ctx.strokeStyle = 'rgba(30,30,30,.5)'; ctx.lineWidth = 0.02; ctx.beginPath(); rrect(ctx, -Wd + 0.06, -L + 0.06, 2 * Wd - 0.12, 2 * L - 0.12, 0.04); ctx.stroke();
    // a carved figure
    ctx.fillStyle = 'rgba(40,40,40,.35)'; ctx.beginPath(); ctx.arc(0, -L + 0.18, 0.08, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.moveTo(-0.13, -L + 0.3); ctx.lineTo(0.13, -L + 0.3); ctx.lineTo(0.09, L - 0.15); ctx.lineTo(-0.09, L - 0.15); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.2)'; ctx.lineWidth = 0.015; ctx.beginPath(); ctx.moveTo(0, -L + 0.36); ctx.lineTo(0, -L + 0.6); ctx.moveTo(-0.08, -L + 0.45); ctx.lineTo(0.08, -L + 0.45); ctx.stroke();
    ctx.restore();
  }

  function altar(ctx, x, y, T, R) {
    let d = [0, -1];
    for (const v of [[0, -1], [-1, 0], [1, 0], [0, 1]]) if (T(x + v[0], y + v[1]) === '#') { d = v; break; }
    ctx.save(); ctx.translate(x + 0.5, y + 0.5); ctx.rotate(Math.atan2(d[1], d[0]) + Math.PI / 2);
    ctx.fillStyle = '#26272a'; ctx.fillRect(-0.46, -0.36, 0.92, 0.62);
    ctx.fillStyle = '#7d7a73'; ctx.fillRect(-0.42, -0.32, 0.84, 0.54);
    ctx.fillStyle = '#5b1f3a'; ctx.fillRect(-0.14, -0.32, 0.28, 0.6);
    ctx.fillStyle = '#c9a54a'; ctx.fillRect(-0.14, 0.2, 0.28, 0.03);
    ctx.strokeStyle = '#d8b65c'; ctx.lineWidth = 0.025; ctx.beginPath(); ctx.arc(0, -0.04, 0.08, 0, 7); ctx.moveTo(0, -0.16); ctx.lineTo(0, 0.08); ctx.stroke();
    [[-0.32, -0.2], [0.32, -0.2]].forEach(([px, py]) => { ctx.fillStyle = '#ece3cb'; ctx.beginPath(); ctx.arc(px, py, 0.045, 0, 7); ctx.fill(); });
    ctx.restore();
  }

  function pillar(ctx, x, y, R, theme) {
    const cx = x + 0.5, cy = y + 0.5;
    ctx.fillStyle = '#1e1d1b'; ctx.fillRect(x + 0.08, y + 0.08, 0.84, 0.84);
    ctx.fillStyle = theme === 'cave' ? '#4f4842' : '#5d5a54'; ctx.fillRect(x + 0.1, y + 0.1, 0.8, 0.8);
    ctx.strokeStyle = 'rgba(255,255,255,.1)'; ctx.lineWidth = 0.02; ctx.strokeRect(x + 0.15, y + 0.15, 0.7, 0.7);
    const g = ctx.createRadialGradient(cx - 0.1, cy - 0.12, 0.03, cx, cy, 0.34);
    g.addColorStop(0, '#b2ada2'); g.addColorStop(0.7, '#77736b'); g.addColorStop(1, '#4b4843');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, 0.31, 0, 7); ctx.fill();
    ctx.strokeStyle = '#2b2a27'; ctx.lineWidth = 0.025; ctx.stroke();
    ctx.strokeStyle = 'rgba(40,40,40,.35)'; ctx.lineWidth = 0.012; ctx.beginPath(); ctx.arc(cx, cy, 0.22, 0, 7); ctx.stroke();
  }

  function hearth(ctx, x, y, T, c, R) {
    let back = [0, -1];
    for (const v of [[0, -1], [-1, 0], [1, 0], [0, 1]]) if (T(x + v[0], y + v[1]) === '#') { back = v; break; }
    const horiz = back[1] !== 0;
    ctx.save(); ctx.translate(x + 0.5, y + 0.5); ctx.rotate(Math.atan2(back[1], back[0]) + Math.PI / 2);
    const left = horiz ? (back[1] < 0 ? c.l : c.r) : (back[0] > 0 ? c.u : c.d);
    const right = horiz ? (back[1] < 0 ? c.r : c.l) : (back[0] > 0 ? c.d : c.u);
    const x0 = left ? -0.5 : -0.46, x1 = right ? 0.5 : 0.46;
    // stone surround
    ctx.fillStyle = '#2a2724'; ctx.fillRect(x0, -0.5, x1 - x0, 0.98);
    for (let i = 0; i < 6; i++) { ctx.fillStyle = hsl(30, 5, 32 + R() * 14); ctx.beginPath(); rrect(ctx, x0 + R() * (x1 - x0 - 0.2), -0.48 + R() * 0.8, 0.2 + R() * 0.12, 0.14, 0.03); ctx.fill(); }
    if (!left) { ctx.fillStyle = '#5c5750'; ctx.fillRect(-0.46, -0.5, 0.14, 0.92); }
    if (!right) { ctx.fillStyle = '#5c5750'; ctx.fillRect(0.32, -0.5, 0.14, 0.92); }
    // firebox
    const fx0 = left ? -0.5 : -0.32, fx1 = right ? 0.5 : 0.32;
    const g = ctx.createLinearGradient(0, -0.5, 0, 0.3);
    g.addColorStop(0, '#0b0605'); g.addColorStop(1, '#3a1a0a');
    ctx.fillStyle = g; ctx.fillRect(fx0, -0.5, fx1 - fx0, 0.78);
    // embers and logs
    for (let i = 0; i < 10; i++) { ctx.fillStyle = R() < 0.5 ? '#ff8a2a' : '#c4401a'; ctx.beginPath(); ctx.arc(fx0 + 0.05 + R() * (fx1 - fx0 - 0.1), -0.05 + R() * 0.25, 0.015 + R() * 0.03, 0, 7); ctx.fill(); }
    ctx.fillStyle = '#3a2414'; ctx.save(); ctx.rotate(0.35); ctx.fillRect(-0.28, 0.0, 0.5, 0.09); ctx.restore(); ctx.save(); ctx.rotate(-0.3); ctx.fillRect(-0.24, 0.02, 0.48, 0.08); ctx.restore();
    // hearthstone apron
    ctx.fillStyle = '#6b665e'; ctx.fillRect(x0, 0.28, x1 - x0, 0.22);
    ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 0.015; ctx.beginPath(); ctx.moveTo(x0, 0.28); ctx.lineTo(x1, 0.28); ctx.stroke();
    ctx.restore();
  }

  function torch(ctx, x, y, T, R) {
    const wallish = (ch) => ch === '#';
    let d = null;
    for (const v of [[0, -1], [-1, 0], [1, 0], [0, 1]]) if (wallish(T(x + v[0], y + v[1]))) { d = v; break; }
    const inWall = (wallish(T(x - 1, y)) && wallish(T(x + 1, y))) || (wallish(T(x, y - 1)) && wallish(T(x, y + 1)));
    const cx = x + 0.5, cy = y + 0.5;
    if (!d) { // brazier
      ctx.fillStyle = 'rgba(0,0,0,.4)'; ctx.beginPath(); ctx.arc(cx + 0.05, cy + 0.06, 0.3, 0, 7); ctx.fill();
      ctx.fillStyle = '#2d2b2a'; ctx.beginPath(); ctx.arc(cx, cy, 0.3, 0, 7); ctx.fill();
      ctx.strokeStyle = '#6b6560'; ctx.lineWidth = 0.03; ctx.stroke();
      const g = ctx.createRadialGradient(cx, cy, 0.02, cx, cy, 0.24); g.addColorStop(0, '#ffd27a'); g.addColorStop(0.5, '#e0601e'); g.addColorStop(1, '#3a120a');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, 0.23, 0, 7); ctx.fill();
      return;
    }
    if (inWall) {
      // drawn as wall, with a sconce on its open face
      ctx.fillStyle = '#55524b'; ctx.fillRect(x, y, 1, 1);
      ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.fillRect(x, y, 1, 1);
      let face = [0, 1];
      for (const v of [[0, 1], [0, -1], [1, 0], [-1, 0]]) if (!wallish(T(x + v[0], y + v[1])) && T(x + v[0], y + v[1]) !== ' ') { face = v; break; }
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(Math.atan2(face[1], face[0]) - Math.PI / 2);
      ctx.fillStyle = '#2b2a28'; ctx.fillRect(-0.5, 0.2, 1, 0.3);
      ctx.fillStyle = '#1b1b1c'; ctx.fillRect(-0.1, 0.3, 0.2, 0.2);
      ctx.fillStyle = '#5a3a1e'; ctx.fillRect(-0.04, 0.32, 0.08, 0.2);
      ctx.restore();
      return;
    }
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(Math.atan2(d[1], d[0]) - Math.PI / 2);
    // bracket on the wall side (local -y is the wall)
    ctx.fillStyle = '#1b1b1c'; ctx.fillRect(-0.12, 0.36, 0.24, 0.14);
    ctx.fillStyle = '#5a3a1e'; ctx.fillRect(-0.045, 0.1, 0.09, 0.34);
    ctx.fillStyle = '#2b2a28'; ctx.beginPath(); ctx.arc(0, 0.1, 0.08, 0, 7); ctx.fill();
    ctx.restore();
  }

  function campfire(ctx, x, y, R) {
    const cx = x + 0.5, cy = y + 0.5;
    ctx.fillStyle = 'rgba(20,14,10,.6)'; ctx.beginPath(); ctx.arc(cx, cy, 0.46, 0, 7); ctx.fill();
    for (let i = 0; i < 9; i++) {
      const a = i / 9 * Math.PI * 2, px = cx + Math.cos(a) * 0.36, py = cy + Math.sin(a) * 0.36;
      ctx.fillStyle = 'rgba(0,0,0,.4)'; ctx.beginPath(); ctx.arc(px + 0.015, py + 0.02, 0.085, 0, 7); ctx.fill();
      ctx.fillStyle = hsl(30, 6, 40 + R() * 15); ctx.beginPath(); blob(ctx, px, py, 0.08, R, 7, 0.2); ctx.fill();
    }
    ctx.fillStyle = '#1a120c'; ctx.beginPath(); ctx.arc(cx, cy, 0.26, 0, 7); ctx.fill();
    ctx.fillStyle = '#4a2e18';
    [0.4, -0.5, 1.6].forEach((a) => { ctx.save(); ctx.translate(cx, cy); ctx.rotate(a); ctx.fillRect(-0.26, -0.04, 0.52, 0.08); ctx.restore(); });
    for (let i = 0; i < 12; i++) { ctx.fillStyle = R() < 0.5 ? '#ff9a3a' : '#c4401a'; ctx.beginPath(); ctx.arc(cx + (R() - 0.5) * 0.36, cy + (R() - 0.5) * 0.36, 0.02 + R() * 0.03, 0, 7); ctx.fill(); }
  }

  function tent(ctx, x, y, R) {
    const cols = [['#b49a6a', '#8a7450'], ['#6e7a4a', '#525c36'], ['#8a5a3a', '#6a4028']][Math.floor(R() * 3)];
    const cx = x + 0.5, cy = y + 0.5, s = 0.58;
    ctx.save(); ctx.translate(cx, cy); ctx.rotate((R() - 0.5) * 0.3);
    ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(-s * 0.9 + 0.08, -s * 0.9 + 0.1, s * 1.8, s * 1.8);
    // guy ropes
    ctx.strokeStyle = 'rgba(220,200,160,.5)'; ctx.lineWidth = 0.012;
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([a, b]) => { ctx.beginPath(); ctx.moveTo(a * s * 0.9, b * s * 0.9); ctx.lineTo(a * (s + 0.1), b * (s + 0.12)); ctx.stroke(); ctx.fillStyle = '#3a2a1a'; ctx.fillRect(a * (s + 0.1) - 0.015, b * (s + 0.12) - 0.015, 0.03, 0.03); });
    ctx.fillStyle = cols[0]; ctx.beginPath(); ctx.moveTo(-s * 0.9, -s * 0.9); ctx.lineTo(0, -s * 0.9); ctx.lineTo(0, s * 0.9); ctx.lineTo(-s * 0.9, s * 0.9); ctx.closePath(); ctx.fill();
    ctx.fillStyle = cols[1]; ctx.beginPath(); ctx.moveTo(0, -s * 0.9); ctx.lineTo(s * 0.9, -s * 0.9); ctx.lineTo(s * 0.9, s * 0.9); ctx.lineTo(0, s * 0.9); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#3a2a1a'; ctx.lineWidth = 0.025; ctx.beginPath(); ctx.moveTo(0, -s * 0.95); ctx.lineTo(0, s * 0.95); ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,.25)'; ctx.lineWidth = 0.012;
    for (let k = 1; k < 4; k++) { ctx.beginPath(); ctx.moveTo(-s * 0.9, -s * 0.9 + k * s * 0.45); ctx.lineTo(s * 0.9, -s * 0.9 + k * s * 0.45); ctx.stroke(); }
    ctx.fillStyle = '#2a1c10'; ctx.beginPath(); ctx.moveTo(-0.12, s * 0.9); ctx.lineTo(0, s * 0.55); ctx.lineTo(0.12, s * 0.9); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  function boulder(ctx, x, y, R, theme, layout) {
    const cx = x + 0.5 + (R() - 0.5) * 0.1, cy = y + 0.5 + (R() - 0.5) * 0.1, r = 0.36 + R() * 0.08;
    const base = theme === 'sand' ? [35, 22, 46] : theme === 'snow' ? [210, 5, 46] : [30, 6, 40];
    ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.beginPath(); blob(ctx, cx, cy, r + 0.03, R, 9, 0.18); ctx.fill();
    const g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, 0.02, cx, cy, r * 1.1);
    g.addColorStop(0, hsl(base[0], base[1], base[2] + 18)); g.addColorStop(0.6, hsl(base[0], base[1], base[2])); g.addColorStop(1, hsl(base[0], base[1], base[2] - 16));
    ctx.fillStyle = g; ctx.beginPath(); blob(ctx, cx, cy, r, R, 9, 0.18); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 0.015; ctx.beginPath(); ctx.moveTo(cx - r * 0.2, cy - r * 0.6); ctx.lineTo(cx, cy - r * 0.1); ctx.lineTo(cx + r * 0.4, cy + r * 0.2); ctx.stroke();
    if (theme === 'snow') { ctx.fillStyle = 'rgba(245,248,252,.9)'; ctx.beginPath(); blob(ctx, cx - r * 0.15, cy - r * 0.25, r * 0.55, R, 8, 0.25); ctx.fill(); }
    if (layout === 'forest' && R() < 0.6) { ctx.fillStyle = 'rgba(90,130,60,.6)'; ctx.beginPath(); blob(ctx, cx - r * 0.3, cy - r * 0.3, r * 0.35, R, 8, 0.4); ctx.fill(); }
    for (let i = 0; i < 3; i++) { const a = R() * 7, px = cx + Math.cos(a) * (r + 0.08), py = cy + Math.sin(a) * (r + 0.08); ctx.fillStyle = hsl(base[0], base[1], base[2] + R() * 10); ctx.beginPath(); ctx.arc(px, py, 0.03 + R() * 0.03, 0, 7); ctx.fill(); }
  }

  function tree(ctx, x, y, R, layout, theme) {
    const cx = x + 0.5 + (R() - 0.5) * 0.12, cy = y + 0.5 + (R() - 0.5) * 0.12;
    if (theme === 'snow' || layout === 'mountain') {
      const r = 0.5 + R() * 0.12;
      const star = (rad, col) => { ctx.fillStyle = col; ctx.beginPath(); for (let i = 0; i <= 16; i++) { const a = i / 16 * Math.PI * 2, rr = i % 2 ? rad * 0.62 : rad; const px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr; if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); } ctx.closePath(); ctx.fill(); };
      star(r + 0.03, '#0f1d16'); star(r, '#24402f'); star(r * 0.72, '#305540'); star(r * 0.42, '#3f6a50');
      ctx.fillStyle = 'rgba(245,248,252,.8)'; for (let i = 0; i < 6; i++) { const a = R() * 7, d = R() * r * 0.8; ctx.beginPath(); ctx.arc(cx + Math.cos(a) * d - 0.05, cy + Math.sin(a) * d - 0.05, 0.05 + R() * 0.05, 0, 7); ctx.fill(); }
      return;
    }
    const r = 0.52 + R() * 0.14;
    const hue = 95 + R() * 25, l = 22 + R() * 6;
    ctx.fillStyle = hsl(hue, 35, l - 12); ctx.beginPath(); blob(ctx, cx, cy, r + 0.03, R, 12, 0.12); ctx.fill();
    ctx.fillStyle = hsl(hue, 35, l); ctx.beginPath(); blob(ctx, cx, cy, r, R, 12, 0.12); ctx.fill();
    for (let i = 0; i < 7; i++) {
      const a = R() * 7, d = R() * r * 0.55, rr = r * (0.28 + R() * 0.2);
      const px = cx + Math.cos(a) * d - 0.05, py = cy + Math.sin(a) * d - 0.06;
      ctx.fillStyle = hsl(hue, 38, l + 5 + R() * 6); ctx.beginPath(); blob(ctx, px, py, rr, R, 9, 0.2); ctx.fill();
    }
    for (let i = 0; i < 4; i++) { const a = R() * 7, d = R() * r * 0.4; ctx.fillStyle = hsl(hue - 10, 45, l + 18, 0.6); ctx.beginPath(); ctx.arc(cx + Math.cos(a) * d - 0.12, cy + Math.sin(a) * d - 0.12, 0.05 + R() * 0.05, 0, 7); ctx.fill(); }
    ctx.strokeStyle = hsl(hue, 30, l - 8, 0.5); ctx.lineWidth = 0.012;
    for (let i = 0; i < 5; i++) { const a = R() * 7; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * r * 0.6, cy + Math.sin(a) * r * 0.6); ctx.stroke(); }
  }

  // ------------------------------------------------------------------ light

  const LIGHT = {
    h: { r: 6, s: 1.1, c: [255, 150, 60] }, x: { r: 4.2, s: 0.85, c: [255, 160, 70] }, F: { r: 7, s: 1.2, c: [255, 140, 55] },
    a: { r: 3, s: 0.6, c: [190, 140, 255] }, candle: { r: 1.8, s: 0.35, c: [255, 190, 110] },
  };
  function lighting(m) {
    const W = m.w, H = m.h, Q = 4;
    const amb = DARK[m.layout] == null ? 0.55 : DARK[m.layout];
    const lights = [];
    const seenComp = new Set();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const ch = at(m, x, y);
      if (ch === 'h') {
        // one light per hearth, in front of it
        if (seenComp.has(keyOf(x, y))) continue;
        const comp = components({ w: W, h: H, tiles: m.tiles }, 'h').find((c) => c.cells.some(([a, b]) => a === x && b === y));
        comp.cells.forEach(([a, b]) => seenComp.add(keyOf(a, b)));
        const cx = (comp.x0 + comp.x1) / 2 + 0.5, cy = (comp.y0 + comp.y1) / 2 + 0.5;
        let back = [0, -1];
        for (const v of [[0, -1], [-1, 0], [1, 0], [0, 1]]) if (at(m, x + v[0], y + v[1]) === '#') { back = v; break; }
        lights.push({ x: cx - back[0] * 0.15, y: cy - back[1] * 0.15, tx: Math.floor(cx - back[0] * 0.8), ty: Math.floor(cy - back[1] * 0.8), k: 'h', w: comp.cells.length, back });
      } else if (ch === 'x' || ch === 'F' || ch === 'a') {
        let fx = x + 0.5, fy = y + 0.5, tx = x, ty = y;
        if (ch === 'x') {
          for (const v of [[0, -1], [-1, 0], [1, 0], [0, 1]]) {
            if (at(m, x + v[0], y + v[1]) === '#') {
              const inWall = (at(m, x - 1, y) === '#' && at(m, x + 1, y) === '#') || (at(m, x, y - 1) === '#' && at(m, x, y + 1) === '#');
              if (inWall) { const f = [[0, 1], [0, -1], [1, 0], [-1, 0]].find((u) => at(m, x + u[0], y + u[1]) !== '#' && at(m, x + u[0], y + u[1]) !== ' ') || [0, 1]; fx += f[0] * 0.45; fy += f[1] * 0.45; tx = x + f[0]; ty = y + f[1]; }
              else { fx -= v[0] * 0.1; fy -= v[1] * 0.1; }
              break;
            }
          }
        }
        lights.push({ x: fx, y: fy, tx, ty, k: ch });
      }
    }
    // candles on tavern tables
    if (m.layout === 'tavern' || m.layout === 'town' || m.layout === 'docks') {
      components(m, '=').forEach((c, i) => { if (hash3(c.x0, c.y0, 41) < 0.6) lights.push({ x: (c.x0 + c.x1) / 2 + 0.5, y: (c.y0 + c.y1) / 2 + 0.5, tx: c.x0, ty: c.y0, k: 'candle' }); });
    }
    // line of sight per light, per square
    const losCache = lights.map((L) => {
      const vis = new Uint8Array(W * H), sx = clamp(L.tx, 0, W - 1), sy = clamp(L.ty, 0, H - 1), rad = LIGHT[L.k].r + 1;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (Math.abs(x - sx) > rad || Math.abs(y - sy) > rad) continue;
        let ok = true, x0 = sx, y0 = sy;
        const dx = Math.abs(x - x0), dy = -Math.abs(y - y0), stx = x0 < x ? 1 : -1, sty = y0 < y ? 1 : -1;
        let err = dx + dy;
        while (!(x0 === x && y0 === y)) {
          const e2 = 2 * err;
          if (e2 >= dy) { err += dy; x0 += stx; }
          if (e2 <= dx) { err += dx; y0 += sty; }
          if (x0 === x && y0 === y) break;
          if (LIGHT_BLOCK.has(at(m, x0, y0))) { ok = false; break; }
        }
        vis[y * W + x] = ok ? 1 : 0;
      }
      return vis;
    });
    const dark = mkCanvas(W * Q, H * Q), warm = mkCanvas(W * Q, H * Q);
    const dd = dark.getContext('2d').createImageData(W * Q, H * Q), wd = warm.getContext('2d').createImageData(W * Q, H * Q);
    const per = lights.map((L) => { const r = LIGHT[L.k].r; const x0 = Math.max(0, Math.floor(L.x - r)), y0 = Math.max(0, Math.floor(L.y - r)), x1 = Math.min(W, Math.ceil(L.x + r)), y1 = Math.min(H, Math.ceil(L.y + r)); return { x0, y0, x1, y1, img: new Float32Array((x1 - x0) * Q * (y1 - y0) * Q) }; });
    for (let py = 0; py < H * Q; py++) for (let px = 0; px < W * Q; px++) {
      const wx = (px + 0.5) / Q, wy = (py + 0.5) / Q, tx = Math.floor(wx), ty = Math.floor(wy);
      let lit = 0, r = 0, g = 0, b = 0;
      for (let i = 0; i < lights.length; i++) {
        const L = lights[i], spec = LIGHT[L.k];
        const d = Math.hypot(wx - L.x, wy - L.y);
        if (d > spec.r) continue;
        if (!losCache[i][ty * W + tx]) continue;
        const v = spec.s * Math.pow(1 - d / spec.r, 1.7);
        lit += v; r += spec.c[0] * v; g += spec.c[1] * v; b += spec.c[2] * v;
        const P = per[i];
        if (tx >= P.x0 && tx < P.x1 && ty >= P.y0 && ty < P.y1) P.img[(py - P.y0 * Q) * (P.x1 - P.x0) * Q + (px - P.x0 * Q)] = v;
      }
      const o = (py * W * Q + px) * 4;
      const a = clamp(amb * (1 - Math.min(1, lit * 1.25)), 0, 1);
      dd.data[o] = 6; dd.data[o + 1] = 6; dd.data[o + 2] = 12; dd.data[o + 3] = Math.round(a * 255);
      if (lit > 0) { const k = Math.min(1, lit); wd.data[o] = clamp(r / lit, 0, 255); wd.data[o + 1] = clamp(g / lit, 0, 255); wd.data[o + 2] = clamp(b / lit, 0, 255); wd.data[o + 3] = Math.round(k * 120 * Math.max(0.35, amb + 0.2)); }
    }
    blurRGBA(dd.data, W * Q, H * Q, 2); blurRGBA(wd.data, W * Q, H * Q, 2);
    const darkA = new Float32Array(W * Q * H * Q);
    for (let i = 0; i < darkA.length; i++) darkA[i] = dd.data[i * 4 + 3] / 255;
    dark.getContext('2d').putImageData(dd, 0, 0);
    warm.getContext('2d').putImageData(wd, 0, 0);
    // per-light glow canvases for the flicker layer
    const glows = lights.filter((L) => L.k !== 'candle' || true).map((L, i) => {
      const P = per[i], w = (P.x1 - P.x0) * Q, h = (P.y1 - P.y0) * Q, c = mkCanvas(w, h), cx = c.getContext('2d'), id = cx.createImageData(w, h), col = LIGHT[L.k].c;
      for (let k = 0; k < P.img.length; k++) { const v = Math.min(1, P.img[k]); id.data[k * 4] = col[0]; id.data[k * 4 + 1] = col[1]; id.data[k * 4 + 2] = col[2]; id.data[k * 4 + 3] = Math.round(v * 70 * (0.4 + amb)); }
      cx.putImageData(id, 0, 0);
      return { canvas: c, x: P.x0, y: P.y0, w: P.x1 - P.x0, h: P.y1 - P.y0, k: L.k };
    });
    return { dark, warm, lights, glows, flames: lights, darkA };
  }

  function blurRGBA(d, w, h, r) {
    const tmp = new Float32Array(d.length);
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        for (let c = 0; c < 4; c++) {
          let s = 0, n = 0;
          for (let k = -r; k <= r; k++) { const xx = pass ? x : x + k, yy = pass ? y + k : y; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue; s += d[(yy * w + xx) * 4 + c]; n++; }
          tmp[(y * w + x) * 4 + c] = s / n;
        }
      }
      for (let i = 0; i < d.length; i++) d[i] = tmp[i];
    }
  }

  // Flames as SVG (animated by CSS) for every light source.
  function flamesSvg(m, lights) {
    const fl = (x, y, s, i, c1, c2) => '<g transform="translate(' + f1(x * U) + ' ' + f1(y * U) + ') scale(' + f1(s) + ')"><g class="tt-flick" style="animation-delay:' + f1(-(i % 7) * 0.29) + 's;animation-duration:' + f1(0.7 + (i % 3) * 0.13) + 's">' +
      '<path d="M0 0C-9 0-13-8-9-17C-8-12-5-11-4-14C-3-22 1-26 0-32C7-26 12-18 9-11C11-12 12-14 12-17C16-9 10 0 0 0Z" fill="' + (c1 || '#e9772e') + '"/>' +
      '<path d="M0 0C-5 0-7-5-5-10C-3-8-2-10-1-16C4-11 7-6 5-2C4-.5 2 0 0 0Z" fill="' + (c2 || '#ffd987') + '"/></g></g>';
    const halo = (x, y, r, col) => '<circle cx="' + f1(x * U) + '" cy="' + f1(y * U) + '" r="' + f1(r * U) + '" fill="url(#tt-halo-' + col + ')"/>';
    let s = '<defs><radialGradient id="tt-halo-o"><stop offset="0" stop-color="#ffb35c" stop-opacity=".55"/><stop offset="1" stop-color="#ff8a2a" stop-opacity="0"/></radialGradient>' +
      '<radialGradient id="tt-halo-v"><stop offset="0" stop-color="#c9a2ff" stop-opacity=".5"/><stop offset="1" stop-color="#8a5aff" stop-opacity="0"/></radialGradient></defs>';
    lights.forEach((L, i) => {
      if (L.k === 'h') {
        const n = Math.max(2, Math.min(5, (L.w || 2) + 1));
        const px = -L.back[1], py = L.back[0];
        s += halo(L.x, L.y, 0.9, 'o');
        for (let k = 0; k < n; k++) { const o = (k - (n - 1) / 2) * 0.32; s += fl(L.x + px * o + L.back[0] * 0.1, L.y + py * o + L.back[1] * 0.1 + 0.12, 0.62 + (k % 2) * 0.22, i * 3 + k); }
        for (let k = 0; k < 4; k++) s += '<circle class="tt-ember" style="--dx:' + ((k % 2 ? 1 : -1) * (3 + k * 2)) + 'px;animation-delay:' + f1(-k * 0.6) + 's" cx="' + f1((L.x + (k - 1.5) * 0.25) * U) + '" cy="' + f1((L.y - 0.1) * U) + '" r="1.4" fill="#ffc46a"/>';
      } else if (L.k === 'F') {
        s += halo(L.x, L.y, 1.1, 'o');
        s += fl(L.x - 0.12, L.y + 0.18, 0.7, i) + fl(L.x + 0.12, L.y + 0.2, 0.62, i + 2) + fl(L.x, L.y + 0.16, 1.0, i + 1);
        for (let k = 0; k < 5; k++) s += '<circle class="tt-ember" style="--dx:' + ((k % 2 ? 1 : -1) * (2 + k * 2)) + 'px;animation-delay:' + f1(-k * 0.5) + 's" cx="' + f1((L.x + (k - 2) * 0.1) * U) + '" cy="' + f1(L.y * U) + '" r="1.5" fill="#ffc46a"/>';
      } else if (L.k === 'x') {
        s += halo(L.x, L.y, 0.55, 'o') + fl(L.x, L.y + 0.12, 0.42, i);
      } else if (L.k === 'a') {
        s += halo(L.x, L.y, 0.6, 'v') + fl(L.x - 0.3, L.y - 0.12, 0.17, i, '#e9a24e', '#fff0c0') + fl(L.x + 0.3, L.y - 0.12, 0.17, i + 1, '#e9a24e', '#fff0c0');
      } else if (L.k === 'candle') {
        s += halo(L.x, L.y, 0.35, 'o');
      }
    });
    return '<svg viewBox="0 0 ' + m.w * U + ' ' + m.h * U + '" aria-hidden="true" focusable="false">' + s + '</svg>';
  }

  // Shimmer layers over water: two patterns that cross-fade.
  function shimmer(m, R, phase) {
    const has = m.tiles.some((r) => r.indexOf('~') >= 0 || r.indexOf('_') >= 0);
    if (!has) return null;
    const Q = Math.max(16, Math.round(R / 2));
    const c = mkCanvas(m.w * Q, m.h * Q), ctx = c.getContext('2d');
    ctx.setTransform(Q, 0, 0, Q, 0, 0);
    const Rr = rng(strHash(m.id + '|' + phase));
    ctx.strokeStyle = 'rgba(170,220,235,.32)'; ctx.lineWidth = 0.025; ctx.lineCap = 'round';
    for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
      const ch = at(m, x, y);
      if (ch !== '~' && ch !== '_') continue;
      for (let k = 0; k < 3; k++) {
        const px = x + Rr() * 0.7, py = y + 0.1 + Rr() * 0.8, l = 0.12 + Rr() * 0.2;
        ctx.beginPath(); ctx.moveTo(px, py); ctx.quadraticCurveTo(px + l / 2, py - 0.04, px + l, py); ctx.stroke();
      }
    }
    return c;
  }

  // Fog of war: a soft mask, a few pixels per square, smoothed when scaled up.
  function fogCanvas(m) {
    const Q = 6, W = m.w, H = m.h, c = mkCanvas(W * Q, H * Q), ctx = c.getContext('2d'), id = ctx.createImageData(W * Q, H * Q);
    const a0 = new Float32Array(W * Q * H * Q);
    let any = false;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const unseen = !seenAt(m, x, y);
      if (unseen) any = true;
      if (!unseen) continue;
      for (let j = 0; j < Q; j++) for (let i = 0; i < Q; i++) a0[(y * Q + j) * W * Q + x * Q + i] = 1;
    }
    if (!any) return null;
    // two box blurs for a soft edge (keep it inside the fogged squares a little)
    const blur = (src) => {
      const out = new Float32Array(src.length), w = W * Q, h = H * Q, r = 3;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0, n = 0; for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < w) { s += src[y * w + xx]; n++; } else { s += 1; n++; } } out[y * w + x] = s / n; }
      const out2 = new Float32Array(src.length);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0, n = 0; for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < h) { s += out[yy * w + x]; n++; } else { s += 1; n++; } } out2[y * w + x] = s / n; }
      return out2;
    };
    const a = blur(blur(a0));
    const Rr = rng(strHash('fog' + m.id));
    // cloudy texture
    const SC = 3 * Q, nW = Math.ceil(W / 3) + 2, nH = Math.ceil(H / 3) + 2, lat = new Float32Array(nW * nH);
    for (let i = 0; i < lat.length; i++) lat[i] = Rr();
    for (let py = 0; py < H * Q; py++) for (let px = 0; px < W * Q; px++) {
      const k = py * W * Q + px;
      const fx = px / SC, fy = py / SC, ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const n = (lat[iy * nW + ix] * (1 - sx) + lat[iy * nW + ix + 1] * sx) * (1 - sy) + (lat[(iy + 1) * nW + ix] * (1 - sx) + lat[(iy + 1) * nW + ix + 1] * sx) * sy;
      let v = a[k];
      v = clamp((v - 0.12) / 0.7, 0, 1);
      const o = k * 4;
      id.data[o] = 9 + n * 10; id.data[o + 1] = 11 + n * 12; id.data[o + 2] = 15 + n * 14; id.data[o + 3] = Math.round(v * 252);
    }
    ctx.putImageData(id, 0, 0);
    return c;
  }

  // ------------------------------------------------------------------ token art (64 x 64, glyphs in a 24 box)

  const INK = '#14181b';
  const GLYPH = {
    Fighter: (c) => '<g transform="rotate(42 12 12)"><path d="M12 0L14.3 3.6V14.4H9.7V3.6Z" fill="' + c + '"/><path d="M12 3.6V13" stroke="' + INK + '" stroke-opacity=".35" stroke-width=".9"/>' +
      '<rect x="6" y="14.4" width="12" height="2.5" rx="1.1" fill="' + c + '"/><rect x="10.7" y="16.9" width="2.6" height="4.4" fill="' + c + '"/><circle cx="12" cy="22.4" r="1.9" fill="' + c + '"/></g>',
    Wizard: (c) => '<path d="M11 2C11.7 8 14.4 10.8 20.5 11.5C14.4 12.2 11.7 15 11 21C10.3 15 7.6 12.2 1.5 11.5C7.6 10.8 10.3 8 11 2Z" fill="' + c + '"/>' +
      '<path d="M19 15C19.3 17.6 20.3 18.6 23 19C20.3 19.4 19.3 20.4 19 23C18.7 20.4 17.7 19.4 15 19C17.7 18.6 18.7 17.6 19 15Z" fill="' + c + '"/><circle cx="19.6" cy="4.4" r="1.5" fill="' + c + '"/>',
    Rogue: (c) => '<g transform="rotate(38 12 12)"><path d="M12 23.5L9 11.6H15Z" fill="' + c + '"/><path d="M5.4 9.2Q12 12.4 18.6 9.2V11Q12 14 5.4 11Z" fill="' + c + '"/>' +
      '<rect x="10.7" y="3.6" width="2.6" height="6.6" fill="' + c + '"/><circle cx="12" cy="2.5" r="2" fill="' + c + '"/></g>',
    Cleric: (c) => '<circle cx="12" cy="12" r="4.7" fill="' + c + '"/><path d="M12 1.4V5M12 19V22.6M1.4 12H5M19 12H22.6M4.5 4.5L7 7M17 17L19.5 19.5M4.5 19.5L7 17M17 7L19.5 4.5" stroke="' + c + '" stroke-width="2.3" stroke-linecap="round"/>',
    hero: (c) => '<path d="M12 2L21 5.5V11.5C21 17 17 20.8 12 22.5C7 20.8 3 17 3 11.5V5.5Z" fill="' + c + '"/><path d="M12 5V19.5M6 10.5H18" stroke="' + INK + '" stroke-opacity=".4" stroke-width="1.4"/>',
    npc: (c) => '<path d="M12 2C6.4 2 4.6 7.4 4.6 12C4.6 15.6 3.4 19.2 2.2 22H21.8C20.6 19.2 19.4 15.6 19.4 12C19.4 7.4 17.6 2 12 2Z" fill="' + c + '"/>' +
      '<path d="M12 5.6C9 5.6 7.8 8.4 7.8 11C7.8 13.8 9.7 15.8 12 15.8C14.3 15.8 16.2 13.8 16.2 11C16.2 8.4 15 5.6 12 5.6Z" fill="' + INK + '"/>' +
      '<path d="M9.4 22C9.8 19.6 10.8 18.2 12 17.6C13.2 18.2 14.2 19.6 14.6 22Z" fill="' + INK + '" fill-opacity=".45"/>',
    person: (c) => '<circle cx="12" cy="7.2" r="4.6" fill="' + c + '"/><path d="M3.5 22.5C3.8 16.6 7.4 13.4 12 13.4C16.6 13.4 20.2 16.6 20.5 22.5Z" fill="' + c + '"/>',
    Goblin: (c) => '<path d="M12 4.5C8.6 4.5 6.6 6.8 6.4 10.2L1 6.5L4.2 14.2C5 18.3 8.2 21 12 21C15.8 21 19 18.3 19.8 14.2L23 6.5L17.6 10.2C17.4 6.8 15.4 4.5 12 4.5Z" fill="' + c + '"/>' +
      '<path d="M7.4 11.4L11 13.2L8.2 14.4ZM16.6 11.4L13 13.2L15.8 14.4Z" fill="' + INK + '"/><path d="M8.6 16.8H15.4L14.2 18.6L13.1 17.2L12 18.6L10.9 17.2L9.8 18.6Z" fill="' + INK + '"/>',
    Wolf: (c) => '<path d="M3.5 2.5L9 7C10.9 6.4 13.1 6.4 15 7L20.5 2.5L20 11.5C20 14 17.6 16.2 15.4 18.6L12 22L8.6 18.6C6.4 16.2 4 14 4 11.5Z" fill="' + c + '"/>' +
      '<path d="M6.8 10.8L10.4 12.6L7.6 13.6ZM17.2 10.8L13.6 12.6L16.4 13.6Z" fill="' + INK + '"/><path d="M10.3 18H13.7L12 20.2Z" fill="' + INK + '"/>',
    Bandit: (c) => '<path d="M12 2.5C7.5 2.5 5 6 5 10.5C5 15 7.5 18.5 12 18.5C16.5 18.5 19 15 19 10.5C19 6 16.5 2.5 12 2.5Z" fill="' + c + '"/>' +
      '<path d="M5 11.4C8 10 16 10 19 11.4C18.6 15 16 17.6 12 22.4C8 17.6 5.4 15 5 11.4Z" fill="' + INK + '"/><path d="M7.4 7.8H10.8V9.4H7.4ZM13.2 7.8H16.6V9.4H13.2Z" fill="' + INK + '"/>',
    Cultist: (c) => '<path d="M12 .8L18.6 11.5C19.6 15 20.6 18.5 22 21.8H2C3.4 18.5 4.4 15 5.4 11.5Z" fill="' + c + '"/><ellipse cx="12" cy="13" rx="3.7" ry="4.6" fill="' + INK + '"/>' +
      '<circle cx="10.5" cy="12.5" r="1" fill="#ff6a55"/><circle cx="13.5" cy="12.5" r="1" fill="#ff6a55"/>',
    Skeleton: (c) => '<path d="M12 2.5C7 2.5 3.8 6 3.8 10.6C3.8 13.6 5.2 15.6 7.4 16.8V20.8H16.6V16.8C18.8 15.6 20.2 13.6 20.2 10.6C20.2 6 17 2.5 12 2.5Z" fill="' + c + '"/>' +
      '<circle cx="8.6" cy="10.8" r="2.5" fill="' + INK + '"/><circle cx="15.4" cy="10.8" r="2.5" fill="' + INK + '"/><path d="M12 12.8L13.3 15.6H10.7Z" fill="' + INK + '"/>' +
      '<path d="M9.8 17.6V20.8M12 17.6V20.8M14.2 17.6V20.8" stroke="' + INK + '" stroke-width="1"/>',
    Spider: (c) => '<path d="M8.6 11.5L4 8L2.2 10.6M8 13.5L3.2 13L1.5 16.5M8.4 15.5L4.6 18L4 21.8M9.6 17L8 20L8.4 22.8M15.4 11.5L20 8L21.8 10.6M16 13.5L20.8 13L22.5 16.5M15.6 15.5L19.4 18L20 21.8M14.4 17L16 20L15.6 22.8" ' +
      'stroke="' + c + '" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/><ellipse cx="12" cy="14.6" rx="4.3" ry="5.2" fill="' + c + '"/><circle cx="12" cy="7.8" r="2.9" fill="' + c + '"/>' +
      '<circle cx="10.9" cy="7.2" r=".8" fill="' + INK + '"/><circle cx="13.1" cy="7.2" r=".8" fill="' + INK + '"/><path d="M12 11.6L13.7 14.6L12 17.6L10.3 14.6Z" fill="#c8493d"/>',
    Orc: (c) => '<path d="M2 8L5.6 9.2L5.2 12.6ZM22 8L18.4 9.2L18.8 12.6Z" fill="' + c + '"/><path d="M10.4 4L12 .8L13.6 4Z" fill="' + c + '"/>' +
      '<path d="M12 3C7.6 3 5 6 5 10C5 11.6 4.4 12.6 3.8 13.8C4.4 18 7.8 21.4 12 21.4C16.2 21.4 19.6 18 20.2 13.8C19.6 12.6 19 11.6 19 10C19 6 16.4 3 12 3Z" fill="' + c + '"/>' +
      '<path d="M6.8 9L10.8 10.4L10.6 12L7.2 11.5ZM17.2 9L13.2 10.4L13.4 12L16.8 11.5Z" fill="' + INK + '"/><path d="M7.4 16.4H16.6V18.2H7.4Z" fill="' + INK + '"/>' +
      '<path d="M7.8 18L8.9 13L10.3 18ZM16.2 18L15.1 13L13.7 18Z" fill="#f6f0dd" stroke="' + INK + '" stroke-width=".6" stroke-linejoin="round"/>',
    Wraith: (c) => '<path d="M12 1.8C7.4 1.8 5 5.4 5 10V22.4L7.4 20L9.7 22.4L12 20L14.3 22.4L16.6 20L19 22.4V10C19 5.4 16.6 1.8 12 1.8Z" fill="' + c + '"/>' +
      '<ellipse cx="9.3" cy="9.6" rx="1.6" ry="2.3" fill="' + INK + '"/><ellipse cx="14.7" cy="9.6" rx="1.6" ry="2.3" fill="' + INK + '"/><ellipse cx="12" cy="14.8" rx="1.7" ry="2.4" fill="' + INK + '"/>',
    Ogre: (c) => '<path d="M5.8 8.4L2.6 2.2L9.4 5ZM18.2 8.4L21.4 2.2L14.6 5Z" fill="' + c + '"/>' +
      '<path d="M12 4C6.6 4 3.2 8 3.2 13C3.2 18 7 21.8 12 21.8C17 21.8 20.8 18 20.8 13C20.8 8 17.4 4 12 4Z" fill="' + c + '"/>' +
      '<path d="M6.2 10.2L11 11.2V12.6H6.2ZM17.8 10.2L13 11.2V12.6H17.8Z" fill="' + INK + '"/><path d="M6.6 16H17.4V18.8H6.6Z" fill="' + INK + '"/>' +
      '<path d="M7.6 18.8V16.6H9.6V18.8ZM14.4 18.8V16.6H16.4V18.8ZM11 16V17.6H13V16Z" fill="#f6f0dd"/>',
    Boss: (c) => '<path d="M5.2 10C2.4 8.4 1.4 5.2 2 1.8C3.8 4.6 6 5.9 8.6 6.5ZM18.8 10C21.6 8.4 22.6 5.2 22 1.8C20.2 4.6 18 5.9 15.4 6.5Z" fill="' + c + '"/>' +
      '<path d="M12 4.6C7.6 4.6 4.8 7.7 4.8 11.7C4.8 14.3 6 16.1 7.8 17.3V21.4H16.2V17.3C18 16.1 19.2 14.3 19.2 11.7C19.2 7.7 16.4 4.6 12 4.6Z" fill="' + c + '"/>' +
      '<path d="M6.4 10.4L10.8 12.2L10 14.6L7 13.8ZM17.6 10.4L13.2 12.2L14 14.6L17 13.8Z" fill="#e2463a"/><path d="M12 14.4L13.1 16.8H10.9Z" fill="' + INK + '"/>' +
      '<path d="M10 18.2V21.4M12 18.2V21.4M14 18.2V21.4" stroke="' + INK + '" stroke-width="1"/>',
    foe: (c) => '<path d="M6 3C7.2 10 6.6 16 4.4 21M12 2.4C13.2 10 12.6 16 10.4 21.6M18 3C19.2 10 18.6 16 16.4 21" stroke="' + c + '" stroke-width="2.8" stroke-linecap="round" fill="none"/>',
  };
  const CLASS_ART = {
    Fighter: { face: '#a3463a', fg: '#f6eedb' }, Wizard: { face: '#4f62bd', fg: '#f6eedb' },
    Rogue: { face: '#3b8361', fg: '#f6eedb' }, Cleric: { face: '#ddd3b4', fg: '#7a5712' },
  };
  const FOE_ART = {
    Goblin: { face: '#4f6b34', fg: '#e9f0cc' }, Wolf: { face: '#56606a', fg: '#edf0f1' }, Bandit: { face: '#6f5236', fg: '#f2e4ca' },
    Cultist: { face: '#553763', fg: '#eadcf2' }, Skeleton: { face: '#44484b', fg: '#f1ebd8' }, Spider: { face: '#3d3552', fg: '#e4def2' },
    Orc: { face: '#55692e', fg: '#e9f0cf' }, Wraith: { face: '#2a535e', fg: '#d8f2f0' }, Ogre: { face: '#80612f', fg: '#f5e8c6' },
    Boss: { face: '#6e1c22', fg: '#f6eedb' },
  };
  const MOOD = { friendly: '#77b06c', neutral: '#9aa7a4', hostile: '#c8493d' };
  const RING_R = 27.2, RING_C = 2 * Math.PI * RING_R;
  const SPIKES = (function () {
    let d = '';
    for (let i = 0; i < 28; i++) { const a = (i / 28) * Math.PI * 2 - Math.PI / 2, r = i % 2 ? 30.5 : 34; d += (i ? 'L' : 'M') + f1(32 + Math.cos(a) * r) + ' ' + f1(32 + Math.sin(a) * r); }
    return d + 'Z';
  })();

  function tokenSvg(o) {
    let s = '<ellipse cx="34" cy="36" rx="31" ry="31" fill="#000" opacity=".45"/>';
    if (o.spiked) s += '<path d="' + SPIKES + '" fill="#0b0e10" stroke="' + o.rim + '" stroke-width="1.2" stroke-linejoin="round"/>';
    s += '<circle cx="32" cy="32" r="31" fill="#0b0e10"/><circle cx="32" cy="32" r="30.1" fill="none" stroke="' + o.rim + '" stroke-width="1.7"/>';
    if (o.mood) {
      s += '<circle class="tk-mood" cx="32" cy="32" r="' + RING_R + '" fill="none" stroke="' + o.mood + '" stroke-width="4"/>';
    } else {
      s += '<circle cx="32" cy="32" r="' + RING_R + '" fill="none" stroke="#1d252a" stroke-width="4.4"/>' +
        '<circle class="tk-hp" cx="32" cy="32" r="' + RING_R + '" fill="none" stroke="#77b06c" stroke-width="4.4" transform="rotate(-90 32 32)" stroke-dasharray="' + f1(RING_C) + '" stroke-dashoffset="0"/>';
    }
    s += '<circle cx="32" cy="32" r="24.2" fill="' + o.face + '"/>' +
      '<path d="M11.6 28A20.8 20.8 0 0 1 41 13.3" fill="none" stroke="#fff" stroke-opacity=".3" stroke-width="1.7" stroke-linecap="round"/>' +
      '<path d="M52.4 36A20.8 20.8 0 0 1 23 50.7" fill="none" stroke="#000" stroke-opacity=".32" stroke-width="1.7" stroke-linecap="round"/>' +
      '<g transform="translate(17 17) scale(1.25)">' + o.glyph + '</g>';
    if (o.crown) {
      s += '<path d="M20.5 7.5L18 -6L26 .8L32 -9L38 .8L46 -6L43.5 7.5Z" fill="#d1a94f" stroke="#1c1608" stroke-width="1.3" stroke-linejoin="round"/>' +
        '<circle cx="32" cy="2.4" r="2" fill="#c8493d"/><circle cx="24.6" cy="3.6" r="1.2" fill="#1c1608"/><circle cx="39.4" cy="3.6" r="1.2" fill="#1c1608"/>';
    }
    return s + '<circle class="tk-ring" cx="32" cy="32" r="35"/>';
  }
  function heroArt(cls) {
    const a = CLASS_ART[cls] || { face: '#5b6a73', fg: '#f6eedb' };
    return tokenSvg({ face: a.face, rim: '#c9b98a', glyph: (GLYPH[cls] || GLYPH.hero)(a.fg) });
  }
  function foeType(e) {
    if (e.type && FOE_ART[e.type]) return e.type;
    const n = String(e.name || '').toLowerCase();
    const hit = Object.keys(FOE_ART).find((k) => n.indexOf(k.toLowerCase()) >= 0);
    return hit || (e.boss ? 'Boss' : 'foe');
  }
  function foeArt(type, boss) {
    const a = FOE_ART[type] || { face: '#5a2f33', fg: '#f6eedb' };
    return tokenSvg({ face: a.face, rim: boss ? '#d1a94f' : '#8a3a33', glyph: (GLYPH[type] || GLYPH.foe)(a.fg), spiked: true, crown: boss });
  }
  function npcArt(mood, hooded) {
    return tokenSvg({ face: hooded ? '#2c363d' : '#5a4a3a', rim: '#56646c', glyph: (hooded ? GLYPH.npc : GLYPH.person)('#e6dfcc'), mood: MOOD[mood] || MOOD.neutral });
  }
  // Object markers (64 x 64)
  function chestSvg(open) {
    const sh = '<ellipse cx="34" cy="50" rx="24" ry="6" fill="#000" opacity=".45"/>';
    if (open) {
      return sh + '<rect x="10" y="26" width="44" height="24" rx="3" fill="#5c3b1e" stroke="#1d1209" stroke-width="2"/>' +
        '<rect x="14" y="29" width="36" height="17" rx="2" fill="#160d07"/><path d="M18 40h28" stroke="#3a2614" stroke-width="2"/>' +
        '<path d="M10 26L14 10H50L54 26Z" fill="#6e4726" stroke="#1d1209" stroke-width="2" stroke-linejoin="round"/><path d="M20 10V26M44 10V26" stroke="#8d8f91" stroke-width="3"/>';
    }
    return sh + '<rect x="10" y="20" width="44" height="30" rx="4" fill="#7a4e28" stroke="#1d1209" stroke-width="2"/>' +
      '<path d="M10 30H54" stroke="#3a2614" stroke-width="2.5"/><path d="M20 20V50M44 20V50" stroke="#9a9c9e" stroke-width="3.5"/>' +
      '<path d="M12 22H52" stroke="#c08a52" stroke-width="2" stroke-opacity=".6"/>' +
      '<rect x="28" y="27" width="8" height="10" rx="1.5" fill="#d1a94f" stroke="#1c1608" stroke-width="1.2"/><circle cx="32" cy="32" r="1.4" fill="#1c1608"/>';
  }
  function exitSvg(dir, stairs) {
    const rot = Math.round(Math.atan2(dir[1], dir[0]) * 180 / Math.PI);
    let s = '<circle cx="32" cy="32" r="26" fill="rgba(12,16,19,.78)" stroke="#d1a94f" stroke-width="2.5"/><circle cx="32" cy="32" r="21" fill="none" stroke="#d1a94f" stroke-opacity=".35" stroke-width="1.2"/>';
    if (stairs) s += '<path d="M18 42H26V36H32V30H38V24H46" fill="none" stroke="#f1d89a" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round"/>';
    else s += '<g transform="rotate(' + rot + ' 32 32)"><path d="M18 32H42M34 22L45 32L34 42" fill="none" stroke="#f1d89a" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/></g>';
    return s;
  }
  function featureSvg() {
    return '<circle cx="32" cy="32" r="22" fill="url(#tt-fg)"/><defs><radialGradient id="tt-fg"><stop offset="0" stop-color="#ffe19a" stop-opacity=".9"/><stop offset=".5" stop-color="#e5a83c" stop-opacity=".35"/><stop offset="1" stop-color="#e5a83c" stop-opacity="0"/></radialGradient></defs>' +
      '<path d="M32 18L36 28L46 32L36 36L32 46L28 36L18 32L28 28Z" fill="#fff3cc" stroke="#7a5712" stroke-width="1.5" stroke-linejoin="round"/>' +
      '<circle cx="32" cy="32" r="3" fill="#d1a94f"/>';
  }

  const DIE_SVG = '<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">' +
    '<polygon points="50,3 91,26.5 91,73.5 50,97 9,73.5 9,26.5" fill="#0b0e10" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/>' +
    [['50,25 76,68 24,68', 0.96], ['9,26.5 50,3 50,25', 0.56], ['50,3 91,26.5 50,25', 0.72], ['9,26.5 50,25 24,68', 0.66], ['91,26.5 76,68 50,25', 0.82], ['9,26.5 24,68 9,73.5', 0.4],
      ['91,26.5 91,73.5 76,68', 0.52], ['9,73.5 24,68 50,97', 0.3], ['91,73.5 50,97 76,68', 0.4], ['24,68 76,68 50,97', 0.48]]
      .map((f) => '<polygon points="' + f[0] + '" fill="currentColor" fill-opacity="' + f[1] + '"/>').join('') +
    '<path d="M50 3V25M9 26.5L50 25L91 26.5M9 26.5L24 68L9 73.5M91 26.5L76 68L91 73.5M24 68H76M24 68L50 97L76 68M50 25L24 68M50 25L76 68" fill="none" stroke="#0b0e10" stroke-width="1.6" stroke-linejoin="round" stroke-opacity=".85"/>' +
    '<text class="tt-die-n" x="50" y="62.5" text-anchor="middle">20</text></svg>';
  const ICON_ZOOM_IN = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15.5 15.5L21 21M7.5 10.5h6M10.5 7.5v6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  const ICON_ZOOM_OUT = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15.5 15.5L21 21M7.5 10.5h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

  // ------------------------------------------------------------------ state and DOM

  const S = {
    room: null, me: null, code: null, prev: null, map: null, battle: false, visible: false,
    sel: { foe: null, ally: null }, audio: { playing: null, seg: null },
    baseSig: '', fogSig: '', R: 0, mapId: null, cam: { s: 1, tx: 0, ty: 0, zoom: 1, panX: 0, panY: 0, auto: true },
    hover: null, pending: 0, reach: null, reachSig: '', overSig: '',
  };
  const tokens = new Map();
  const objs = new Map();
  let stage = null, cam = null, scene = null, cvBase = null, elLights = null, elWater = null, elFlames = null, elCarry = null, cvFog = null, cvFogOld = null, cvOver = null, elObjs = null, elTokens = null;
  let elHud = null, elLoc = null, elRound = null, elMove = null, elPlaque = null, plaque = null, elZoom = null, elTip = null, elFx = null, elDie = null, elDieN = null, elDieCap = null, elSr = null, elLive = null;
  let box = null, layoutRaf = 0, selRaf = 0, obsFoes = null, obsParty = null, dieTimers = [], subscribed = false, audioSub = false, tweenRaf = 0, rerenderTimer = 0;

  function injectStyle() {
    if (doc.getElementById('aidnd-table-style')) return;
    const st = doc.createElement('style');
    st.id = 'aidnd-table-style';
    st.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(st);
  }

  function build() {
    stage = el('section', 'tabletop');
    stage.id = 'tableTop';
    stage.tabIndex = 0;
    stage.setAttribute('role', 'application');
    stage.setAttribute('aria-roledescription', 'map');
    stage.setAttribute('aria-label', 'Map');
    stage.hidden = true;
    cam = el('div', 'tt-cam');
    scene = el('div', 'tt-scene');
    cvBase = el('canvas', 'tt-base');
    elLights = el('div', 'tt-l tt-lights');
    elWater = el('div', 'tt-l tt-water');
    elFlames = el('div', 'tt-l tt-flames');
    elCarry = el('canvas', 'tt-carry');
    cvFogOld = el('canvas', 'tt-fog'); cvFog = el('canvas', 'tt-fog');
    cvOver = el('canvas', 'tt-over');
    elObjs = el('div', 'tt-objs');
    elTokens = el('div', 'tt-tokens');
    [cvBase, elLights, elWater, elCarry, elFlames, cvFogOld, cvFog, cvOver, elObjs, elTokens].forEach((n) => scene.appendChild(n));
    cam.appendChild(scene);
    const vig = el('div', 'tt-vig');
    elHud = el('div', 'tt-hud');
    elLoc = el('div', 'tt-loc');
    elRound = el('div', 'tt-round'); elRound.hidden = true;
    elMove = el('div', 'tt-move'); elMove.hidden = true;
    elPlaque = el('div', 'tt-plaque'); elPlaque.hidden = true;
    plaque = { name: el('b'), hp: el('span', 'v'), atk: el('span', 'ad'), def: el('span', 'ad') };
    elPlaque.appendChild(el('i'));
    [plaque.name, plaque.hp, plaque.atk, plaque.def].forEach((n) => elPlaque.appendChild(n));
    elZoom = el('button', 'tt-zoom'); elZoom.type = 'button';
    elZoom.addEventListener('click', (ev) => { ev.stopPropagation(); toggleZoom(); });
    elZoom.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    elTip = el('div', 'tt-tip'); elTip.hidden = true;
    elSr = el('p', 'tt-sr'); elSr.id = 'ttHelp';
    elSr.textContent = 'Click or tap a square to walk there. Click a door, chest, exit, person or marked feature to use it. Click an enemy to target it, and again to attack. With the map focused, arrow keys move your hero one square and Enter uses the door or object next to you.';
    elLive = el('div', 'tt-sr'); elLive.setAttribute('role', 'status');
    stage.setAttribute('aria-describedby', 'ttHelp');
    [elLoc, elRound, elMove, elPlaque, elZoom, elTip, elSr, elLive].forEach((n) => elHud.appendChild(n));
    elFx = el('div', 'tt-fx');
    elDie = el('div', 'tt-die'); elDie.hidden = true; elDie.innerHTML = DIE_SVG;
    elDieN = elDie.querySelector('.tt-die-n');
    elDieCap = el('span', 'tt-die-cap'); elDie.appendChild(elDieCap);
    [cam, vig, elHud, elFx, elDie].forEach((n) => stage.appendChild(n));
    wireInput();
    if (typeof window.ResizeObserver === 'function') new window.ResizeObserver(() => queueLayout()).observe(stage);
    else window.addEventListener('resize', () => queueLayout());
  }

  // Put the stage right after #sceneBox's heading. Returns false while there is no #sceneBox.
  function mount() {
    const b = doc.getElementById('sceneBox');
    if (!b) return false;
    if (!stage) { injectStyle(); build(); }
    if (stage.parentNode !== b) {
      const head = b.querySelector('.scene-head');
      if (head) head.insertAdjacentElement('afterend', stage); else b.insertBefore(stage, b.firstChild);
    }
    box = b;
    watchSelection();
    return true;
  }
  function hide() {
    S.visible = false;
    if (stage) stage.hidden = true;
    if (box) box.classList.remove('tt-battle-on', 'tt-on');
  }

  // ------------------------------------------------------------------ map layers

  const dpr = () => Math.min(3, Math.max(1, window.devicePixelRatio || 1));
  function wantR() { return clamp(Math.ceil(S.cam.s * U * dpr() / 8) * 8, 24, 112); }

  function renderBase(force) {
    const m = S.map;
    if (!m) return;
    const R = wantR();
    const sig = m.id + '|' + m.layout + '|' + m.tiles.join('');
    if (!force && sig === S.baseSig && S.R && (R <= S.R * 1.15 && R >= S.R * 0.6)) return;
    S.baseSig = sig; S.R = R;
    const t0 = Date.now();
    const out = paintMap(m, R);
    cvBase.width = out.canvas.width; cvBase.height = out.canvas.height;
    cvBase.getContext('2d').drawImage(out.canvas, 0, 0);
    S.darkA = out.darkA; carrySig = '';
    drawCarry();
    // flickering light pools
    elLights.textContent = '';
    out.glows.forEach((g, i) => {
      const c = g.canvas;
      c.style.left = (g.x * U) + 'px'; c.style.top = (g.y * U) + 'px'; c.style.width = (g.w * U) + 'px'; c.style.height = (g.h * U) + 'px';
      c.style.animationDelay = f1(-i * 0.77) + 's';
      c.style.animationDuration = f1(1.9 + (i % 4) * 0.37) + 's';
      elLights.appendChild(c);
    });
    elFlames.innerHTML = flamesSvg(m, out.lights);
    elWater.textContent = '';
    [0, 1].forEach((k) => { const c = shimmer(m, R, k); if (c) elWater.appendChild(c); });
    S.renderMs = Date.now() - t0;
  }

  function renderFog() {
    const m = S.map;
    const sig = m ? m.id + '|' + m.seen.join('') : '';
    if (sig === S.fogSig) return;
    const sameMap = S.fogSig && S.fogSig.split('|')[0] === String(m && m.id);
    S.fogSig = sig;
    const c = m ? fogCanvas(m) : null;
    // cross-fade: the old fog fades out over the new one
    const old = cvFogOld;
    cvFogOld = cvFog; cvFog = old;
    cvFog.width = c ? c.width : 1; cvFog.height = c ? c.height : 1;
    const x = cvFog.getContext('2d');
    x.clearRect(0, 0, cvFog.width, cvFog.height);
    if (c) x.drawImage(c, 0, 0);
    scene.insertBefore(cvFog, cvOver);
    cvFog.style.transition = 'none'; cvFog.style.opacity = '1';
    if (!sameMap || reduced()) { cvFogOld.style.transition = 'none'; cvFogOld.style.opacity = '0'; }
    else { cvFogOld.style.transition = 'none'; cvFogOld.style.opacity = '1'; void cvFogOld.offsetWidth; cvFogOld.style.transition = ''; cvFogOld.style.opacity = '0'; }
  }

  // ------------------------------------------------------------------ camera

  function queueLayout() {
    if (layoutRaf) return;
    layoutRaf = raf(() => { layoutRaf = 0; try { layout(); } catch (e) { if (window.console) console.error('[tabletop]', e); } });
  }
  function myPos() {
    const t = tokens.get('h:' + S.me);
    if (t && t.px != null) return { x: t.px, y: t.py };
    const p = S.room && S.room.players && S.room.players[S.me];
    return p && p.pos ? { x: p.pos.x, y: p.pos.y } : null;
  }
  function layout(animate) {
    if (!stage || stage.hidden || !S.map) return;
    const W = stage.clientWidth, H = stage.clientHeight, m = S.map;
    if (!W || !H) return;
    stage.classList.toggle('sm', W < 520);
    const mw = m.w * U, mh = m.h * U, pad = 4;
    const s0 = Math.min((W - pad * 2) / mw, (H - pad * 2) / mh);
    const c = S.cam;
    c.fitTile = s0 * U;
    if (c.zoomAuto !== false && c.zoomPref == null) c.zoom = c.fitTile < 27 ? clamp(40 / c.fitTile, 1.3, 3.5) : 1;
    const z = Math.max(1, c.zoom);
    const s = s0 * z;
    let tx, ty;
    const sw = mw * s, sh = mh * s;
    if (z <= 1.001) { tx = (W - sw) / 2; ty = (H - sh) / 2; c.panX = c.panY = 0; }
    else {
      let f = myPos() || { x: m.w / 2, y: m.h / 2 };
      // in a fight, frame everyone still standing when they fit; otherwise follow your hero
      if (S.battle && S.room && S.room.combat) {
        const pts = [];
        tokens.forEach((t) => { if ((t.kind === 'hero' || t.kind === 'foe') && !t.dead && t.px != null) pts.push(t); });
        if (pts.length) {
          const x0 = Math.min(...pts.map((t) => t.px)), x1 = Math.max(...pts.map((t) => t.px)), y0 = Math.min(...pts.map((t) => t.py)), y1 = Math.max(...pts.map((t) => t.py));
          if ((x1 - x0 + 2) * U * s <= W && (y1 - y0 + 2) * U * s <= H) f = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
        }
      }
      tx = W / 2 - (f.x + 0.5) * U * s + c.panX; ty = H / 2 - (f.y + 0.5) * U * s + c.panY;
      if (sw > W) tx = clamp(tx, W - sw - pad, pad); else tx = (W - sw) / 2;
      if (sh > H) ty = clamp(ty, H - sh - pad, pad); else ty = (H - sh) / 2;
    }
    const changed = Math.abs(c.s - s) > 1e-4 || Math.abs(c.tx - tx) > 0.5 || Math.abs(c.ty - ty) > 0.5;
    c.s = s; c.tx = tx; c.ty = ty;
    cam.classList.toggle('ease', !!animate && !reduced());
    cam.style.width = mw + 'px'; cam.style.height = mh + 'px';
    cam.style.transform = 'translate(' + f1(tx) + 'px,' + f1(ty) + 'px) scale(' + s.toFixed(4) + ')';
    cam.style.setProperty('--inv', (1 / s).toFixed(3));
    stage.classList.toggle('zoomed', z > 1.001);
    elZoom.innerHTML = z > 1.001 ? ICON_ZOOM_OUT : ICON_ZOOM_IN;
    elZoom.setAttribute('aria-label', z > 1.001 ? 'Show the whole map' : 'Zoom in on your hero');
    elZoom.title = elZoom.getAttribute('aria-label');
    if (changed) {
      clearTimeout(rerenderTimer);
      rerenderTimer = setTimeout(() => { try { renderBase(false); drawOverlay(true); } catch (e) { /* ignore */ } }, 180);
    }
  }
  function toggleZoom() {
    const c = S.cam;
    if (c.zoom > 1.001) { c.zoom = 1; c.zoomPref = 1; }
    else { c.zoom = clamp(Math.max(2, 42 / (c.fitTile || 20)), 1.5, 4); c.zoomPref = c.zoom; }
    c.panX = c.panY = 0;
    layout(true);
  }

  // ------------------------------------------------------------------ tokens

  function makeToken(kind, id) {
    const node = el('button', 'tk tk-' + kind + ' tk-in');
    node.type = 'button';
    node.tabIndex = -1;
    const shk = el('span', 'tk-shk'), body = el('span', 'tk-body'), tag = el('span', 'tk-tag'), name = el('span', 'tk-name');
    shk.appendChild(body);
    node.appendChild(shk); node.appendChild(tag); node.appendChild(name);
    const t = { kind, id, el: node, body, name, tag, hp: null, c: {}, px: null, py: null, path: [], floats: 0, gone: false };
    node.addEventListener('click', (ev) => { ev.stopPropagation(); if (S.dragged) return; tokenClick(t); });
    elTokens.appendChild(node);
    setTimeout(() => node.classList.remove('tk-in'), 700);
    return t;
  }
  function put(t, key, val, fn) { if (t.c[key] !== val) { t.c[key] = val; fn(val); } }
  function flag(t, cls, on) { put(t, 'f:' + cls, !!on, (v) => t.el.classList.toggle(cls, v)); }
  function setArt(t, key, html) {
    put(t, 'art', key, () => {
      t.body.innerHTML = '<svg class="tk-svg" viewBox="0 0 64 64" aria-hidden="true" focusable="false">' + html + '</svg>';
      t.hp = t.body.querySelector('.tk-hp');
      delete t.c.hp;
    });
  }
  function setHp(t, hp, maxHp) {
    const frac = maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) : 0;
    put(t, 'hp', Math.round(frac * 1000), () => {
      if (!t.hp) return;
      t.hp.setAttribute('stroke-dashoffset', f1(RING_C * (1 - frac)));
      t.hp.setAttribute('stroke', frac > 0.5 ? '#77b06c' : frac > 0.25 ? '#d1a94f' : '#c8493d');
    });
  }
  function dropToken(map, key) {
    const t = map.get(key);
    if (!t) return;
    map.delete(key);
    t.gone = true;
    t.el.classList.add('tk-out');
    t.el.disabled = true;
    setTimeout(() => t.el.remove(), 380);
  }
  // Walk a token to (x, y) along the map, or jump there on first sight.
  function moveTo(t, x, y, instant) {
    if (t.tx === x && t.ty === y && t.px != null) return;
    t.tx = x; t.ty = y;
    if (t.px == null || instant || reduced()) { t.px = x; t.py = y; t.path = []; placeEl(t); return; }
    const from = { x: Math.round(t.path.length ? t.path[t.path.length - 1].x : t.px), y: Math.round(t.path.length ? t.path[t.path.length - 1].y : t.py) };
    let steps = walkPath(S.map, from, { x, y });
    if (!steps || steps.length > 40) steps = [{ x, y }];
    t.path = t.path.concat(steps);
    startTween();
  }
  function walkPath(m, a, b) {
    if (!m) return null;
    const seen = new Map([[keyOf(a.x, a.y), null]]), q = [a];
    const ok = (x, y) => WALK.has(at(m, x, y)) || (x === b.x && y === b.y);
    while (q.length) {
      const c = q.shift();
      if (c.x === b.x && c.y === b.y) break;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const x = c.x + dx, y = c.y + dy, k = keyOf(x, y);
        if (seen.has(k) || !ok(x, y)) continue;
        if (dx && dy && !(ok(c.x + dx, c.y) && ok(c.x, c.y + dy))) continue;
        seen.set(k, c); q.push({ x, y });
      }
    }
    if (!seen.has(keyOf(b.x, b.y))) return null;
    const out = [];
    for (let n = { x: b.x, y: b.y }; n && !(n.x === a.x && n.y === a.y); n = seen.get(keyOf(n.x, n.y))) out.unshift({ x: n.x, y: n.y });
    return out;
  }
  function startTween() {
    if (tweenRaf) return;
    let last = 0;
    const step = (now) => {
      tweenRaf = 0;
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
      last = now;
      let busy = false;
      const all = [].concat(Array.from(tokens.values()));
      all.forEach((t) => {
        if (!t.path.length) return;
        busy = true;
        const n = t.path[0], speed = 7.5 * dt;
        const dx = n.x - t.px, dy = n.y - t.py, d = Math.hypot(dx, dy);
        if (d <= speed) { t.px = n.x; t.py = n.y; t.path.shift(); }
        else { t.px += dx / d * speed; t.py += dy / d * speed; }
        placeEl(t);
        if (t.kind === 'hero' && t.id === S.me && S.cam.zoom > 1.001) layout(false);
      });
      if (busy) tweenRaf = raf(step);
      else { drawOverlay(true); }
    };
    tweenRaf = raf(step);
  }
  function placeEl(t) {
    const ox = t.ox || 0, oy = t.oy || 0;
    t.el.style.transform = 'translate(' + f1((t.px + 0.5 + ox) * U) + 'px,' + f1((t.py + 0.5 + oy) * U) + 'px)';
    if (t.kind === 'hero') queueCarry();
  }
  // Lantern light the heroes carry in dark places: the brightest lantern wins, walls block it.
  let carryRaf = 0, carrySig = '';
  function queueCarry() { if (!carryRaf) carryRaf = raf(() => { carryRaf = 0; try { drawCarry(); } catch (e) { /* ignore */ } }); }
  function drawCarry() {
    const m = S.map;
    if (!m || !elCarry) return;
    const darkness = DARK[m.layout] == null ? 0.5 : DARK[m.layout];
    const hs = [];
    tokens.forEach((t) => { if (t.kind === 'hero' && t.px != null && !t.c['f:is-down']) hs.push({ x: t.px + 0.5, y: t.py + 0.5, tx: Math.round(t.px), ty: Math.round(t.py) }); });
    const sig = m.id + '|' + m.tiles.join('') + '|' + hs.map((h) => f1(h.x) + ',' + f1(h.y)).join(';');
    if (sig === carrySig || !S.darkA) return;
    carrySig = sig;
    const Q = 4, W = m.w, H = m.h, RAD = 3.6;
    if (elCarry.width !== W * Q) { elCarry.width = W * Q; elCarry.height = H * Q; }
    const ctx = elCarry.getContext('2d'), id = ctx.createImageData(W * Q, H * Q);
    const los = hs.map((h) => {
      const vis = new Uint8Array(W * H);
      for (let y = Math.max(0, h.ty - 5); y <= Math.min(H - 1, h.ty + 5); y++) for (let x = Math.max(0, h.tx - 5); x <= Math.min(W - 1, h.tx + 5); x++) {
        let x0 = h.tx, y0 = h.ty, ok = true;
        const dx = Math.abs(x - x0), dy = -Math.abs(y - y0), sx = x0 < x ? 1 : -1, sy = y0 < y ? 1 : -1;
        let err = dx + dy;
        while (!(x0 === x && y0 === y)) {
          const e2 = 2 * err;
          if (e2 >= dy) { err += dy; x0 += sx; }
          if (e2 <= dx) { err += dx; y0 += sy; }
          if (x0 === x && y0 === y) break;
          if (LIGHT_BLOCK.has(at(m, x0, y0))) { ok = false; break; }
        }
        vis[y * W + x] = ok ? 1 : 0;
      }
      return vis;
    });
    for (let py = 0; py < H * Q; py++) for (let px = 0; px < W * Q; px++) {
      const wx = (px + 0.5) / Q, wy = (py + 0.5) / Q, ti = Math.floor(wy) * W + Math.floor(wx);
      let v = 0;
      for (let i = 0; i < hs.length; i++) {
        const d = Math.hypot(wx - hs[i].x, wy - hs[i].y);
        if (d >= RAD || !los[i][ti]) continue;
        const f = Math.pow(1 - d / RAD, 1.3);
        if (f > v) v = f;
      }
      const o = (py * W * Q + px) * 4, k = py * W * Q + px;
      id.data[o] = 6; id.data[o + 1] = 6; id.data[o + 2] = 12; id.data[o + 3] = Math.round(255 * S.darkA[k] * (1 - 0.8 * v));
    }
    blurRGBA(id.data, W * Q, H * Q, 1);
    ctx.putImageData(id, 0, 0);
  }
  function setSize(t, k) { put(t, 'size', k, (v) => t.el.style.setProperty('--tk', f1(U * v) + 'px')); }

  function speakers(room) {
    const a = S.audio || {};
    if (!room || a.playing == null || a.seg == null || !Array.isArray(room.log)) return '';
    const e = room.log.find((x) => x && x.id === a.playing);
    const sg = e && Array.isArray(e.segs) ? e.segs[a.seg] : null;
    const n = sg && typeof sg.speaker === 'string' ? sg.speaker.trim().toLowerCase() : '';
    return n && n !== 'narrator' ? n : '';
  }
  const isDown = (p) => p.alive === false || (typeof p.hp === 'number' && p.hp <= 0);
  const HOODED = /hood|stranger|cloak|figure|shadow|monk|priest|witch|mystic|seer|cultist|hermit/i;

  function syncTokens(room) {
    const m = S.map;
    const want = new Set();
    const players = room.players && typeof room.players === 'object' ? room.players : {};
    const order = Array.isArray(room.order) ? room.order : Object.keys(players);
    const combat = S.battle ? room.combat : null;
    const turn = combat ? combat.turn : null;
    const first = S.firstPaint;
    order.filter((id) => players[id] && players[id].cls && players[id].pos).slice(0, 6).forEach((id) => {
      const p = players[id], key = 'h:' + id;
      want.add(key);
      let t = tokens.get(key);
      if (!t) { t = makeToken('hero', id); tokens.set(key, t); }
      const down = isDown(p), me = id === S.me, acting = turn === id && !down;
      setArt(t, String(p.cls), heroArt(p.cls));
      setSize(t, 0.84);
      put(t, 'name', String(p.name || 'Hero'), (v) => { t.name.textContent = v; });
      setHp(t, num(p.hp), num(p.maxHp));
      flag(t, 'is-me', me); flag(t, 'is-down', down); flag(t, 'is-off', p.online === false); flag(t, 'is-turn', acting);
      put(t, 'tag', acting ? (me ? 'Your turn' : 'Turn') : '', (v) => { t.tag.textContent = v; });
      t.label = (p.name || 'Hero') + ', ' + p.cls + (p.level ? ' level ' + p.level : '') + ', HP ' + num(p.hp) + ' of ' + num(p.maxHp) + (me ? ', you' : '') + (down ? ', down' : '') + (acting ? ', acting now' : '');
      put(t, 'label', t.label, (v) => t.el.setAttribute('aria-label', v));
      t.tile = { x: p.pos.x, y: p.pos.y };
      moveTo(t, p.pos.x, p.pos.y, first || t.px == null);
    });
    if (combat) {
      combat.enemies.forEach((e, i) => {
        if (!e || e.id == null || !e.pos) return;
        const id = String(e.id), key = 'e:' + id;
        if (want.has(key)) return;
        want.add(key);
        let t = tokens.get(key);
        if (!t) { t = makeToken('foe', id); tokens.set(key, t); if (!first) t.el.querySelector('.tk-shk').style.animationDelay = (i * 0.09) + 's'; }
        const dead = e.alive === false || num(e.hp) <= 0, type = foeType(e);
        t.boss = !!e.boss;
        setArt(t, type + (e.boss ? '!' : ''), foeArt(type, !!e.boss));
        setSize(t, e.boss ? 1.12 : 0.82);
        put(t, 'name', String(e.name || e.type || 'Enemy'), (v) => { t.name.textContent = v; });
        setHp(t, num(e.hp), num(e.maxHp));
        flag(t, 'is-dead', dead); flag(t, 'is-boss', !!e.boss);
        put(t, 'dis', dead, (v) => { t.el.disabled = v; });
        t.dead = dead;
        t.base = (e.name || e.type || 'Enemy') + (e.boss ? ', boss' : '') + (dead ? ', defeated' : ', HP ' + num(e.hp) + ' of ' + num(e.maxHp));
        t.tile = { x: e.pos.x, y: e.pos.y };
        moveTo(t, e.pos.x, e.pos.y, first || t.px == null);
      });
    }
    // people in the scene
    const speaking = speakers(room);
    (m.objects || []).forEach((o) => {
      if (!o || o.kind !== 'npc') return;
      const key = 'n:' + o.id;
      want.add(key);
      let t = tokens.get(key);
      if (!t) { t = makeToken('npc', o.id); tokens.set(key, t); }
      const mood = MOOD[o.mood] ? o.mood : 'neutral', hooded = HOODED.test(o.name || '');
      setArt(t, mood + hooded, npcArt(mood, hooded));
      setSize(t, 0.8);
      t.obj = o;
      put(t, 'name', String(o.name || 'Someone'), (v) => { t.name.textContent = v; });
      flag(t, 'is-speaking', !!speaking && (speaking === String(o.name || '').toLowerCase() || String(o.name || '').toLowerCase().indexOf(speaking) === 0));
      put(t, 'label', (o.name || 'Someone') + ', ' + mood + '. Talk to them', (v) => t.el.setAttribute('aria-label', v));
      t.tile = { x: o.x, y: o.y };
      t.el.style.display = seenAt(m, o.x, o.y) ? '' : 'none';
      moveTo(t, o.x, o.y, first || t.px == null);
    });
    Array.from(tokens.keys()).forEach((key) => { if (!want.has(key)) dropToken(tokens, key); });
    // tokens sharing a square are nudged apart
    const byTile = new Map();
    tokens.forEach((t) => { if (!t.tile || t.dead) return; const k = keyOf(t.tile.x, t.tile.y); (byTile.get(k) || byTile.set(k, []).get(k)).push(t); });
    tokens.forEach((t) => { t.ox = 0; t.oy = 0; });
    byTile.forEach((list) => { if (list.length < 2) return; list.forEach((t, i) => { const a = i / list.length * Math.PI * 2; t.ox = Math.cos(a) * 0.2; t.oy = Math.sin(a) * 0.2; placeEl(t); }); });
    tokens.forEach((t) => placeEl(t));
    // a hero's name hides when another token stands just below it (hover shows it)
    tokens.forEach((t) => {
      if (t.kind !== 'hero' || !t.tile) return;
      let below = false;
      tokens.forEach((o) => { if (o !== t && o.tile && !o.dead && o.tile.y === t.tile.y + 1 && Math.abs(o.tile.x - t.tile.x) <= 1) below = true; });
      flag(t, 'nm-off', below && t.id !== S.me);
    });
    queueCarry();
  }

  function syncObjects(room) {
    const m = S.map, want = new Set();
    (m.objects || []).forEach((o) => {
      if (!o || o.kind === 'npc' || (o.kind !== 'chest' && o.kind !== 'exit' && o.kind !== 'feature')) return;
      const key = 'o:' + o.id;
      want.add(key);
      let b = objs.get(key);
      if (!b) {
        const node = el('button', 'ob ob-' + o.kind);
        node.type = 'button'; node.tabIndex = -1;
        const art = el('span', 'tk-body'), name = el('span', 'ob-name');
        node.appendChild(art); node.appendChild(name);
        b = { el: node, art, name, c: {}, o };
        node.addEventListener('click', (ev) => { ev.stopPropagation(); if (S.dragged) return; clickTile(b.o.x, b.o.y); });
        elObjs.appendChild(node);
        objs.set(key, b);
      }
      b.o = o;
      let art;
      if (o.kind === 'chest') art = 'c' + (o.used ? 1 : 0);
      else if (o.kind === 'exit') { const d = edgeDir(m, o); art = 'e' + d.join() + (at(m, o.x, o.y) === 'S'); }
      else art = 'f';
      put(b, 'art', art, () => {
        const svg = o.kind === 'chest' ? chestSvg(o.used) : o.kind === 'exit' ? exitSvg(edgeDir(m, o), at(m, o.x, o.y) === 'S') : featureSvg();
        b.art.innerHTML = '<svg class="ob-svg" viewBox="0 0 64 64" aria-hidden="true" focusable="false">' + svg + '</svg>';
      });
      const size = o.kind === 'exit' ? 0.74 : o.kind === 'feature' ? 0.7 : 0.78;
      put(b, 'size', size, (v) => b.el.style.setProperty('--tk', f1(U * v) + 'px'));
      put(b, 'name', String(o.name || o.kind), (v) => { b.name.textContent = v; });
      b.el.classList.toggle('used', o.kind === 'chest' && !!o.used);
      const label = o.kind === 'chest' ? (o.name || 'Chest') + (o.used ? ', opened' : ', open it') : o.kind === 'exit' ? (o.name || 'Exit') + ', travel onward' : (o.name || 'Something') + ', examine it';
      put(b, 'label', label, (v) => b.el.setAttribute('aria-label', v));
      b.el.style.transform = 'translate(' + f1((o.x + 0.5) * U) + 'px,' + f1((o.y + 0.5) * U) + 'px)';
      b.el.style.display = seenAt(m, o.x, o.y) ? '' : 'none';
    });
    Array.from(objs.keys()).forEach((key) => { if (!want.has(key)) { const b = objs.get(key); objs.delete(key); b.el.remove(); } });
  }
  function edgeDir(m, o) {
    const d = [[o.x, [-1, 0]], [m.w - 1 - o.x, [1, 0]], [o.y, [0, -1]], [m.h - 1 - o.y, [0, 1]]].sort((a, b) => a[0] - b[0]);
    return d[0][1];
  }

  // ------------------------------------------------------------------ overlay (reach, path preview, hover)

  function myTurn() {
    const r = S.room;
    return !!(r && S.battle && r.combat && r.combat.turn === S.me && r.players[S.me] && !isDown(r.players[S.me]));
  }
  function engineCall(name, args, dflt) {
    try { const E = window.Engine; if (E && typeof E[name] === 'function') { const v = E[name].apply(E, args); return v == null ? dflt : v; } } catch (e) { /* fall back */ }
    return dflt;
  }
  function reachSet() {
    const r = S.room;
    const sig = r ? [S.map.id, S.map.tiles.join(''), JSON.stringify(r.combat && [r.combat.turn, r.combat.left, r.combat.enemies.map((e) => e.pos && e.alive)]), Object.values(r.players).map((p) => p.pos ? p.pos.x + ',' + p.pos.y : '').join(';')].join('|') : '';
    if (sig === S.reachSig) return S.reach;
    S.reachSig = sig;
    const list = myTurn() ? engineCall('reachable', [r, S.me], []) : [];
    S.reach = new Set((Array.isArray(list) ? list : []).map((c) => keyOf(c.x, c.y)));
    return S.reach;
  }
  function drawOverlay(force) {
    const m = S.map;
    if (!m || !cvOver) return;
    const R = S.R || 48;
    const hov = S.hover;
    const sig = [R, S.reachSig, hov ? hov.x + ',' + hov.y : '', S.battle, S.sel.foe, myTurn(), m.seen.join('').length, tokens.size, S.pathSig || ''].join('|');
    if (!force && sig === S.overSig) return;
    S.overSig = sig;
    if (cvOver.width !== m.w * R || cvOver.height !== m.h * R) { cvOver.width = m.w * R; cvOver.height = m.h * R; }
    const ctx = cvOver.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cvOver.width, cvOver.height);
    ctx.setTransform(R, 0, 0, R, 0, 0);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    // grid on open squares
    ctx.strokeStyle = S.battle ? 'rgba(235,228,210,.13)' : 'rgba(235,228,210,.055)';
    ctx.lineWidth = 1 / R;
    ctx.beginPath();
    for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
      if (!WALK.has(at(m, x, y)) || !seenAt(m, x, y)) continue;
      ctx.rect(x + 0.5 / R, y + 0.5 / R, 1 - 1 / R, 1 - 1 / R);
    }
    ctx.stroke();
    const mine = myTurn();
    const me = S.room && S.room.players[S.me];
    if (mine && me && me.pos) {
      // movement range
      const reach = reachSet();
      ctx.fillStyle = 'rgba(209,169,79,.16)';
      reach.forEach((k) => { const [x, y] = k.split(',').map(Number); ctx.fillRect(x + 0.04, y + 0.04, 0.92, 0.92); });
      edgeOutline(ctx, reach, 'rgba(232,196,110,.7)', 0.03, null);
      // reach of a basic attack
      const rr = Math.max(1, num(engineCall('rangeOf', [S.room, S.me, { t: 'attack' }], 1)));
      const ring = new Set();
      for (let y = me.pos.y - rr; y <= me.pos.y + rr; y++) for (let x = me.pos.x - rr; x <= me.pos.x + rr; x++) if (x >= 0 && y >= 0 && x < m.w && y < m.h) ring.add(keyOf(x, y));
      edgeOutline(ctx, ring, 'rgba(226,92,74,.85)', 0.035, [0.12, 0.08]);
      // the acting square
      ctx.strokeStyle = 'rgba(255,215,120,.9)'; ctx.lineWidth = 0.05; ctx.beginPath(); rrect(ctx, me.pos.x + 0.06, me.pos.y + 0.06, 0.88, 0.88, 0.12); ctx.stroke();
    }
    // target square
    if (S.battle && S.sel.foe) {
      const e = S.room.combat.enemies.find((x) => String(x.id) === S.sel.foe && x.alive !== false && x.pos);
      if (e) { ctx.fillStyle = 'rgba(200,73,61,.22)'; ctx.fillRect(e.pos.x + 0.03, e.pos.y + 0.03, 0.94, 0.94); ctx.strokeStyle = 'rgba(226,92,74,.9)'; ctx.lineWidth = 0.04; ctx.strokeRect(e.pos.x + 0.05, e.pos.y + 0.05, 0.9, 0.9); }
    }
    // hover square and walking path
    if (hov && hov.x >= 0 && hov.y >= 0 && hov.x < m.w && hov.y < m.h) {
      ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 0.035; ctx.beginPath(); rrect(ctx, hov.x + 0.05, hov.y + 0.05, 0.9, 0.9, 0.1); ctx.stroke();
      const path = S.hoverPath;
      if (path && path.length && me && me.pos) {
        ctx.strokeStyle = mine ? 'rgba(255,220,130,.95)' : 'rgba(240,232,210,.85)';
        ctx.lineWidth = 0.07; ctx.setLineDash([0.02, 0.16]);
        ctx.beginPath(); ctx.moveTo(me.pos.x + 0.5, me.pos.y + 0.5);
        path.forEach((p) => ctx.lineTo(p.x + 0.5, p.y + 0.5));
        ctx.stroke(); ctx.setLineDash([]);
        const end = path[path.length - 1];
        ctx.fillStyle = mine ? 'rgba(255,220,130,.9)' : 'rgba(240,232,210,.85)';
        ctx.beginPath(); ctx.arc(end.x + 0.5, end.y + 0.5, 0.11, 0, 7); ctx.fill();
      }
    }
  }
  function edgeOutline(ctx, set, color, w, dash) {
    ctx.strokeStyle = color; ctx.lineWidth = w;
    if (dash) ctx.setLineDash(dash);
    ctx.beginPath();
    set.forEach((k) => {
      const [x, y] = k.split(',').map(Number);
      if (!set.has(keyOf(x, y - 1))) { ctx.moveTo(x, y); ctx.lineTo(x + 1, y); }
      if (!set.has(keyOf(x, y + 1))) { ctx.moveTo(x, y + 1); ctx.lineTo(x + 1, y + 1); }
      if (!set.has(keyOf(x - 1, y))) { ctx.moveTo(x, y); ctx.lineTo(x, y + 1); }
      if (!set.has(keyOf(x + 1, y))) { ctx.moveTo(x + 1, y); ctx.lineTo(x + 1, y + 1); }
    });
    ctx.stroke();
    if (dash) ctx.setLineDash([]);
  }

  // ------------------------------------------------------------------ what is on a square

  const TILE_NAME = {
    '#': 'Wall', 'r': 'Rug', 'R': 'Mine-cart rails', 'S': 'Stairs', "'": 'Open door', '+': 'Closed door', '~': 'Deep water', '_': 'Shallow water',
    'T': 'Tree', '^': 'Boulder', 'o': 'Pillar', '=': 'Table', 'B': 'Counter', 'h': 'Hearth', 'x': 'Torch', 'F': 'Campfire', 'b': 'Barrels and crates',
    'k': 'Shelves', 's': 'Sarcophagus', 'a': 'Altar', 'n': 'Tent', 'w': 'Bed', 'c': 'Chair',
  };
  function tileName(m, x, y) {
    const ch = at(m, x, y), th = m.theme, lay = m.layout;
    if (ch === '.') return lay === 'town' ? 'Wooden floor' : { wood: lay === 'docks' ? 'Boardwalk' : 'Wooden floor', stone: 'Flagstones', cave: 'Cave floor', grass: 'Grass', snow: 'Snow', sand: 'Sand', dirt: 'Packed earth' }[th] || 'Floor';
    if (ch === ',') return { stone: 'Rough stone', grass: 'Long grass', cave: 'Moss', snow: 'Scree', sand: 'Dune grass', dirt: 'Weeds', wood: 'Straw' }[th] || 'Rough ground';
    if (ch === ':') return OUTDOOR[lay] ? (lay === 'town' ? 'Cobbled road' : lay === 'docks' ? 'Pier' : 'Path') : 'Carpet runner';
    if (ch === 'x') { const free = ['#'].indexOf(at(m, x, y - 1)) < 0 && at(m, x - 1, y) !== '#' && at(m, x + 1, y) !== '#' && at(m, x, y + 1) !== '#'; return free ? 'Brazier' : 'Wall torch'; }
    if (ch === 'w' && OUTDOOR[lay]) return 'Bedroll';
    if (ch === 'b' && (lay === 'docks' || lay === 'town')) return 'Crates and barrels';
    if (ch === '#' && lay === 'forest') return 'Thicket';
    if (ch === '#' && (lay === 'cave' || lay === 'mine' || lay === 'mountain' || lay === 'shore')) return 'Rock';
    if (ch === '^' && (lay === 'mine' || lay === 'cave')) return 'Rubble';
    if (ch === 'c') { const nb = [at(m, x - 1, y), at(m, x + 1, y), at(m, x, y - 1), at(m, x, y + 1)]; return nb.indexOf('B') >= 0 ? 'Stool' : nb.indexOf('=') >= 0 ? 'Chair' : 'Stool'; }
    if (ch === 'B') return lay === 'tavern' ? 'Bar counter' : 'Counter';
    if (ch === 'k') return lay === 'tavern' || lay === 'dungeon' ? (lay === 'dungeon' ? 'Shelves' : 'Shelves of bottles') : 'Bookshelf';
    return TILE_NAME[ch] || '';
  }
  function thingsAt(x, y) {
    const r = S.room, m = S.map, out = {};
    if (!r || !m) return out;
    if (S.battle) out.foe = r.combat.enemies.find((e) => e && e.pos && e.pos.x === x && e.pos.y === y && e.alive !== false) || null;
    out.obj = (m.objects || []).find((o) => o && o.x === x && o.y === y) || null;
    out.hero = Object.values(r.players || {}).find((p) => p && p.cls && p.pos && p.pos.x === x && p.pos.y === y) || null;
    out.ch = at(m, x, y);
    return out;
  }
  const FURNITURE = new Set(['=', 'B', 'h', 'x', 'F', 'b', 'k', 's', 'a', 'n', 'w', 'o', 'T', '^', '~']);

  function describe(x, y) {
    const m = S.map, r = S.room;
    if (!seenAt(m, x, y)) return { title: 'Unexplored', sub: 'Nobody has seen what lies here yet.' };
    const t = thingsAt(x, y), mine = myTurn();
    if (t.foe) {
      const sel = S.sel.foe === String(t.foe.id);
      return { title: t.foe.name, sub: 'HP ' + num(t.foe.hp) + '/' + num(t.foe.maxHp), go: sel ? (mine ? 'Click again to attack' : 'Your target') : 'Click to target' };
    }
    if (t.hero) return { title: t.hero.name + (t.hero.id === S.me ? ' (you)' : ''), sub: t.hero.cls + ' · HP ' + num(t.hero.hp) + '/' + num(t.hero.maxHp) };
    if (t.obj) {
      const o = t.obj;
      if (o.kind === 'npc') return { title: o.name, sub: (o.mood || 'neutral').replace(/^./, (c) => c.toUpperCase()), go: S.battle ? '' : 'Click to talk' };
      if (o.kind === 'chest') return { title: o.name || 'Chest', sub: o.used ? 'Opened and empty' : 'Closed', go: o.used ? '' : 'Click to open it' };
      if (o.kind === 'exit') return { title: o.name || 'The way on', sub: 'Leads onward', go: 'Click to travel on' };
      return { title: o.name || 'Something', sub: 'Something the story mentioned', go: 'Click to examine' };
    }
    const name = tileName(m, x, y);
    if (t.ch === '+') return { title: name, go: S.battle && !mine ? '' : 'Click to open' };
    if (walkableT(m, x, y)) {
      const path = S.hoverPath;
      if (S.battle) {
        if (!mine) return { title: name, sub: 'Wait for your turn to move' };
        return path ? { title: name, go: path.length + ' square' + (path.length === 1 ? '' : 's') + ' of ' + num(r.combat.left) + ' left' } : { title: name, bad: 'Out of reach this turn' };
      }
      return { title: name, go: path ? 'Click to walk here' : '' };
    }
    if (FURNITURE.has(t.ch) && !S.battle) return { title: name, go: 'Click to look closer' };
    return { title: name || 'Darkness' };
  }

  // ------------------------------------------------------------------ input

  function tileFromEvent(ev) {
    const r = stage.getBoundingClientRect(), c = S.cam;
    const x = Math.floor((ev.clientX - r.left - c.tx) / (c.s * U)), y = Math.floor((ev.clientY - r.top - c.ty) / (c.s * U));
    return { x, y };
  }
  function setHover(tile, ev) {
    const m = S.map;
    if (!m) return;
    const inside = tile && tile.x >= 0 && tile.y >= 0 && tile.x < m.w && tile.y < m.h && at(m, tile.x, tile.y) !== ' ';
    if (!inside) { if (S.hover) { S.hover = null; S.hoverPath = null; elTip.hidden = true; drawOverlay(); } return; }
    if (!S.hover || S.hover.x !== tile.x || S.hover.y !== tile.y) {
      S.hover = tile;
      const me = S.room && S.room.players[S.me];
      S.hoverPath = null;
      if (me && me.pos && seenAt(m, tile.x, tile.y) && walkableT(m, tile.x, tile.y) && !(me.pos.x === tile.x && me.pos.y === tile.y) && (!S.battle || myTurn())) {
        const p = engineCall('pathTo', [S.room, S.me, tile.x, tile.y], null);
        S.hoverPath = Array.isArray(p) && p.length ? p : null;
      }
      S.pathSig = S.hoverPath ? S.hoverPath.length + ':' + tile.x + ',' + tile.y : '';
      const d = describe(tile.x, tile.y);
      elTip.innerHTML = '';
      const b = el('b'); b.textContent = d.title; elTip.appendChild(b);
      if (d.sub) { const s = el('span'); s.textContent = d.sub; elTip.appendChild(s); }
      if (d.go) { const g = el('span', 'go'); g.textContent = (d.sub ? ' · ' : '') + d.go; elTip.appendChild(g); }
      if (d.bad) { const g = el('span', 'bad'); g.textContent = (d.sub ? ' · ' : '') + d.bad; elTip.appendChild(g); }
      elTip.hidden = false;
      drawOverlay();
    }
    if (ev) {
      const r = stage.getBoundingClientRect(), c = S.cam;
      const sx = c.tx + (tile.x + 0.5) * U * c.s, sy = c.ty + tile.y * U * c.s;
      const w = elTip.offsetWidth || 160, h = elTip.offsetHeight || 40;
      let left = sx - w / 2, top = sy - h - 8;
      if (top < 30) top = sy + U * c.s + 8;
      left = clamp(left, 6, r.width - w - 6); top = clamp(top, 6, r.height - h - 6);
      elTip.style.transform = 'translate(' + Math.round(left) + 'px,' + Math.round(top) + 'px)';
    }
  }

  function wireInput() {
    const pts = new Map();
    let down = null, pinch = null;
    stage.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0 && ev.pointerType === 'mouse') return;
      pts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      S.dragged = false;
      if (pts.size === 1) down = { x: ev.clientX, y: ev.clientY, panX: S.cam.panX, panY: S.cam.panY, id: ev.pointerId };
      if (pts.size === 2) {
        const [a, b] = Array.from(pts.values());
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: S.cam.zoom };
        down = null;
      }
    });
    stage.addEventListener('pointermove', (ev) => {
      if (pts.has(ev.pointerId)) pts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (pinch && pts.size >= 2) {
        const [a, b] = Array.from(pts.values());
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        S.cam.zoom = clamp(pinch.z * d / pinch.d, 1, 4); S.cam.zoomPref = S.cam.zoom;
        S.dragged = true;
        layout(false);
        return;
      }
      if (down && pts.has(ev.pointerId) && S.cam.zoom > 1.001) {
        const dx = ev.clientX - down.x, dy = ev.clientY - down.y;
        if (S.dragged || Math.hypot(dx, dy) > 8) {
          S.dragged = true;
          S.cam.panX = down.panX + dx; S.cam.panY = down.panY + dy;
          layout(false);
          elTip.hidden = true;
          return;
        }
      }
      if (ev.pointerType === 'mouse') setHover(tileFromEvent(ev), ev);
    });
    const end = (ev) => {
      pts.delete(ev.pointerId);
      if (pts.size < 2) pinch = null;
      if (!pts.size) setTimeout(() => { down = null; }, 0);
    };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
    stage.addEventListener('pointerleave', (ev) => { if (ev.pointerType === 'mouse') setHover(null); });
    stage.addEventListener('click', (ev) => {
      if (S.dragged) { S.dragged = false; return; }
      if (ev.target.closest && ev.target.closest('.tt-zoom')) return;
      const t = tileFromEvent(ev);
      clickTile(t.x, t.y);
    });
    stage.addEventListener('wheel', (ev) => {
      if (!ev.ctrlKey) return;
      ev.preventDefault();
      S.cam.zoom = clamp(S.cam.zoom * Math.exp(-ev.deltaY * 0.01), 1, 4); S.cam.zoomPref = S.cam.zoom;
      layout(false);
    }, { passive: false });
    stage.addEventListener('keydown', onKey);
  }

  function onKey(ev) {
    if (ev.target !== stage) return;
    const r = S.room, m = S.map, me = r && r.players[S.me];
    if (!m || !me || !me.pos) return;
    const dirs = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    if (dirs[ev.key]) {
      ev.preventDefault();
      const [dx, dy] = dirs[ev.key];
      const x = me.pos.x + dx, y = me.pos.y + dy;
      const t = thingsAt(x, y);
      if (t.ch === '+' || (t.obj && t.obj.kind !== 'feature')) clickTile(x, y);
      else send({ t: 'move', x, y });
      return;
    }
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      const order = [];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const x = me.pos.x + dx, y = me.pos.y + dy, t = thingsAt(x, y);
        if (t.obj && !(t.obj.kind === 'chest' && t.obj.used)) order.push([t.obj.kind === 'npc' ? 0 : t.obj.kind === 'chest' ? 1 : t.obj.kind === 'feature' ? 2 : 3, x, y]);
        else if (t.ch === '+') order.push([4, x, y]);
        else if (t.ch === "'" && !(dx === 0 && dy === 0)) order.push([5, x, y]);
      }
      order.sort((a, b) => a[0] - b[0]);
      if (order.length) send({ t: 'interact', x: order[0][1], y: order[0][2] });
      else mapToast('There is nothing to use next to you.', true);
      return;
    }
    if (ev.key === '+' || ev.key === '=' || ev.key === '-') { ev.preventDefault(); if ((ev.key === '-') === (S.cam.zoom > 1.001)) toggleZoom(); }
  }

  function tokenClick(t) {
    if (t.kind === 'foe') return clickFoe(t.id);
    if (t.kind === 'hero') {
      // a hero standing on a door, exit or chest: outside a fight the click uses the thing beneath
      if (!S.battle && t.tile && (thingsAt(t.tile.x, t.tile.y).obj)) return clickTile(t.tile.x, t.tile.y, true);
      if (t.id !== S.me) proxyClick('pc-' + t.id);
      return;
    }
    if (t.kind === 'npc' && t.tile) clickTile(t.tile.x, t.tile.y);
  }
  function clickFoe(id) {
    const r = S.room;
    if (!r || !S.battle) return;
    const e = r.combat.enemies.find((x) => String(x.id) === String(id));
    if (!e || e.alive === false) return;
    if (S.sel.foe !== String(id)) { proxyClick('foe-' + id); return; }
    if (myTurn()) send({ t: 'attack', target: e.id });
    else mapToast('Wait for your turn to attack.', true);
  }
  function clickTile(x, y, self) {
    const m = S.map, r = S.room;
    if (!m || !r || x < 0 || y < 0 || x >= m.w || y >= m.h) return;
    stage.focus({ preventScroll: true });
    const me = r.players[S.me];
    if (!me || !me.cls) { mapToast('Choose a class to join the story first.', true); return; }
    if (!seenAt(m, x, y)) { mapToast('You have not explored there yet.', true); return; }
    const t = thingsAt(x, y);
    if (t.foe) return clickFoe(t.foe.id);
    if (S.battle && !myTurn()) { mapToast('Wait for your turn.', true); return; }
    if (t.obj) {
      if (t.obj.kind === 'chest' && t.obj.used) { mapToast('The chest is empty.', true); return; }
      if (S.battle) { mapToast('Not in the middle of a fight.', true); return; }
      return send({ t: 'interact', x, y });
    }
    if (t.hero && t.hero.id !== S.me) { proxyClick('pc-' + t.hero.id); return; }
    if (t.hero && self) return;
    if (t.ch === '+') return send({ t: 'interact', x, y });
    if (walkableT(m, x, y)) { if (me.pos && me.pos.x === x && me.pos.y === y) return; return send({ t: 'move', x, y }); }
    if (FURNITURE.has(t.ch) && !S.battle) return lookAt(tileName(m, x, y));
  }
  // Furniture is not an object the engine knows: offer it to the player as an action to send.
  function lookAt(name) {
    const box = doc.getElementById('sayInput');
    const doBtn = doc.querySelector('#modes [data-mode="do"]');
    if (!box || !name) return;
    if (box.value.trim()) { mapToast('Finish your message first, then look at the ' + name.toLowerCase() + '.', true); return; }
    if (doBtn && doBtn.getAttribute('aria-checked') !== 'true' && !doBtn.disabled) doBtn.click();
    box.value = 'I take a closer look at the ' + name.toLowerCase() + '.';
    try { box.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) { /* old browser */ }
    const fine = window.matchMedia && window.matchMedia('(pointer: fine)').matches;
    if (fine) { box.focus(); try { box.setSelectionRange(box.value.length, box.value.length); } catch (e) { /* ignore */ } }
    mapToast('Press Send to look at the ' + name.toLowerCase() + ', or change the words first.', false);
  }
  async function send(action) {
    const N = window.Net;
    if (!N || typeof N.act !== 'function') return;
    if (S.pending && action.t !== 'move') return;
    S.pending++;
    let res = null;
    try { res = await N.act(action); } catch (e) { res = { ok: false, error: 'Could not reach the table. Check your connection.' }; }
    S.pending = Math.max(0, S.pending - 1);
    if (!res || !res.ok) mapToast((res && res.error) || 'That did not work.', true);
    return res;
  }
  let toastEl = null, toastTimer = 0;
  function mapToast(msg, bad) {
    if (!elHud) return;
    if (toastEl) toastEl.remove();
    toastEl = el('div', 'tt-toast' + (bad ? '' : ' info'));
    toastEl.textContent = msg;
    elHud.appendChild(toastEl);
    elLive.textContent = msg;
    clearTimeout(toastTimer);
    const n = toastEl;
    toastTimer = setTimeout(() => { n.remove(); if (toastEl === n) toastEl = null; }, 3700);
  }

  // ------------------------------------------------------------------ targeting (through the app's own buttons)

  function findStub(k) { try { return doc.querySelector('[data-k="' + selEsc(k) + '"]'); } catch (e) { return null; } }
  function proxyClick(k) {
    const b = findStub(k);
    if (b && !b.disabled && typeof b.click === 'function') b.click();
    queueSel();
  }
  function readSel() {
    const out = { foe: null, ally: null };
    try {
      const f = doc.querySelector('#foes [data-k^="foe-"][aria-pressed="true"]');
      if (f) out.foe = f.getAttribute('data-k').slice(4);
      const p = doc.querySelector('#party [data-k^="pc-"][aria-pressed="true"]');
      if (p) out.ally = p.getAttribute('data-k').slice(3);
    } catch (e) { /* no selection */ }
    return out;
  }
  function queueSel() {
    if (selRaf) return;
    selRaf = raf(() => { selRaf = 0; try { syncSel(); } catch (e) { /* never break the page */ } });
  }
  function watchSelection() {
    if (typeof window.MutationObserver !== 'function') return;
    const opts = { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-pressed'] };
    const foes = doc.getElementById('foes'), party = doc.getElementById('party');
    if (foes && (!obsFoes || obsFoes.node !== foes)) { if (obsFoes) obsFoes.mo.disconnect(); obsFoes = { node: foes, mo: new window.MutationObserver(queueSel) }; obsFoes.mo.observe(foes, opts); }
    if (party && (!obsParty || obsParty.node !== party)) { if (obsParty) obsParty.mo.disconnect(); obsParty = { node: party, mo: new window.MutationObserver(queueSel) }; obsParty.mo.observe(party, opts); }
  }
  function statOf(e, name) {
    try { const fn = window.Engine && window.Engine[name === 'atk' ? 'atkOf' : 'defOf']; if (typeof fn === 'function') { const v = fn(e); if (typeof v === 'number' && isFinite(v)) return v; } } catch (err) { /* raw stat */ }
    return num(e[name]);
  }
  function syncSel() {
    if (!stage) return;
    const sel = readSel();
    const changed = sel.foe !== S.sel.foe;
    S.sel = sel;
    const room = S.room;
    const me = room && room.players && room.players[S.me];
    const rr = myTurn() ? Math.max(1, num(engineCall('rangeOf', [room, S.me, { t: 'attack' }], 1))) : 0;
    tokens.forEach((t) => {
      if (t.kind === 'foe') {
        const on = S.battle && sel.foe === t.id && !t.dead;
        flag(t, 'is-target', on);
        flag(t, 'in-reach', !!rr && me && me.pos && t.tile && cheb(me.pos, t.tile) <= rr);
        put(t, 'pressed', on, (v) => t.el.setAttribute('aria-pressed', String(v)));
        put(t, 'label', (t.base || '') + (on ? ', targeted. Click again to attack' : ', click to target'), (v) => t.el.setAttribute('aria-label', v));
      } else if (t.kind === 'hero') {
        flag(t, 'is-ally', sel.ally === t.id && t.id !== S.me);
      }
    });
    if (changed) drawOverlay();
    const enemies = S.battle && room && room.combat ? room.combat.enemies : null;
    if (!enemies) { elPlaque.hidden = true; return; }
    const e = enemies.find((x) => x && String(x.id) === sel.foe && x.alive !== false);
    elPlaque.hidden = false;
    elPlaque.classList.toggle('idle', !e);
    if (!e) {
      const left = enemies.some((x) => x && x.alive !== false);
      plaque.name.textContent = left ? 'Click an enemy to target it' : 'The field is clear';
      plaque.hp.textContent = plaque.atk.textContent = plaque.def.textContent = '';
      plaque.hp.hidden = plaque.atk.hidden = plaque.def.hidden = true;
      return;
    }
    plaque.hp.hidden = plaque.atk.hidden = plaque.def.hidden = false;
    plaque.name.textContent = String(e.name || e.type || 'Enemy');
    plaque.hp.textContent = 'HP ' + num(e.hp) + '/' + num(e.maxHp);
    plaque.atk.textContent = 'ATK ' + statOf(e, 'atk');
    plaque.def.textContent = 'DEF ' + statOf(e, 'def');
  }
  function syncSpeaking() {
    const n = speakers(S.room);
    tokens.forEach((t) => { if (t.kind === 'npc') { const nm = String((t.obj && t.obj.name) || '').toLowerCase(); flag(t, 'is-speaking', !!n && (n === nm || nm.indexOf(n) === 0 || n.indexOf(nm) === 0)); } });
  }

  // ------------------------------------------------------------------ feedback

  function snap(room) {
    const o = { code: room.code, h: {}, e: {}, maxId: -Infinity, ids: null };
    const players = room.players && typeof room.players === 'object' ? room.players : {};
    Object.keys(players).forEach((id) => { const p = players[id]; if (p && p.cls) o.h[id] = { hp: num(p.hp), down: isDown(p), level: num(p.level) }; });
    const en = room.combat && Array.isArray(room.combat.enemies) ? room.combat.enemies : [];
    en.forEach((e) => { if (e && e.id != null) o.e[String(e.id)] = { hp: num(e.hp), dead: e.alive === false, maxHp: num(e.maxHp), name: e.name }; });
    const log = Array.isArray(room.log) ? room.log : [];
    let numeric = true;
    log.forEach((x) => { if (!x) return; if (typeof x.id === 'number') { if (x.id > o.maxId) o.maxId = x.id; } else numeric = false; });
    if (!numeric) o.ids = new Set(log.map((x) => x && x.id));
    if (typeof room.seq === 'number' && room.seq > o.maxId) o.maxId = room.seq;
    return o;
  }
  function screenOf(t) {
    const c = S.cam;
    return { x: c.tx + (t.px + 0.5 + (t.ox || 0)) * U * c.s, y: c.ty + (t.py + 0.5 + (t.oy || 0)) * U * c.s, r: U * c.s * 0.42 };
  }
  function floatText(t, text, cls) {
    if (!t || t.gone || !elFx || t.px == null) return;
    const n = el('span', 'tt-float ' + cls);
    n.textContent = text;
    const p = screenOf(t), W = stage.clientWidth || 0;
    n.style.left = clamp(p.x, 26, W - 26) + 'px';
    const delay = t.floats * 140;
    n.style.top = Math.max(26, p.y - p.r - 2 - t.floats * 25) + 'px';
    t.floats++;
    n.style.animationDelay = delay + 'ms';
    elFx.appendChild(n);
    setTimeout(() => { n.remove(); t.floats = Math.max(0, t.floats - 1); }, 1350 + delay);
  }
  function shake(t) {
    if (!t || t.gone) return;
    t.el.classList.remove('fx-shake', 'fx-flash');
    void t.el.offsetWidth;
    t.el.classList.add('fx-shake', 'fx-flash');
    setTimeout(() => t.el.classList.remove('fx-shake', 'fx-flash'), 520);
  }
  function hpEffects(t, was, now) {
    const d = now.hp - was.hp;
    if (d < 0) { shake(t); floatText(t, '-' + (-d), 'dmg'); } else if (d > 0) floatText(t, '+' + d, 'heal');
  }
  function effects(room, prev, cur) {
    Object.keys(cur.h).forEach((id) => {
      const was = prev.h[id], now = cur.h[id], t = tokens.get('h:' + id);
      if (!was || !t) return;
      hpEffects(t, was, now);
      if (now.level > was.level) floatText(t, 'Level up', 'lvl');
    });
    Object.keys(cur.e).forEach((id) => {
      const was = prev.e[id], now = cur.e[id], t = tokens.get('e:' + id);
      if (!was || !t || was.maxHp !== now.maxHp || was.name !== now.name) return;
      hpEffects(t, was, now);
    });
    const log = Array.isArray(room.log) ? room.log : [];
    for (let i = log.length - 1; i >= 0; i--) {
      const e = log[i];
      if (!e) continue;
      const fresh = typeof e.id === 'number' ? e.id > prev.maxId : !!(prev.ids && !prev.ids.has(e.id));
      if (!fresh) { if (typeof e.id === 'number') break; continue; }
      if (e.k === 'roll' && typeof e.die === 'number' && isFinite(e.die)) { rollDie(e.die, e.pass, e.who); break; }
    }
  }
  function rollDie(value, pass, who) {
    if (!elDie) return;
    dieTimers.forEach((id) => { clearTimeout(id); clearInterval(id); });
    dieTimers = [];
    const tint = pass === true ? ' pass' : pass === false ? ' fail' : '';
    const cap = (typeof who === 'string' && who ? who + ': ' : '') + (pass === true ? 'Success' : pass === false ? 'Failure' : '');
    const land = () => {
      elDieN.textContent = String(value);
      elDieN.style.fontSize = String(value).length > 2 ? '15px' : '';
      elDie.className = 'tt-die land' + tint;
      elDieCap.textContent = pass === true || pass === false ? cap : '';
    };
    elDie.hidden = false;
    elDieCap.textContent = '';
    elDieN.style.fontSize = '';
    if (reduced()) land();
    else {
      elDie.className = 'tt-die';
      void elDie.offsetWidth;
      elDie.className = 'tt-die spin';
      elDieN.textContent = String(1 + Math.floor(Math.random() * 20));
      dieTimers.push(setInterval(() => { elDieN.textContent = String(1 + Math.floor(Math.random() * 20)); }, 70));
      dieTimers.push(setTimeout(() => { clearInterval(dieTimers[0]); land(); }, 700));
    }
    dieTimers.push(setTimeout(() => elDie.classList.add('out'), 2200));
    dieTimers.push(setTimeout(() => { elDie.hidden = true; elDie.className = 'tt-die'; }, 2650));
  }

  // ------------------------------------------------------------------ update

  function validMap(m) {
    return !!(m && typeof m === 'object' && m.w > 0 && m.h > 0 && Array.isArray(m.tiles) && m.tiles.length === m.h && Array.isArray(m.seen) && m.seen.length === m.h);
  }
  function apply(room, me) {
    hook();
    if (!room || typeof room !== 'object') { S.room = null; S.prev = null; S.code = null; hide(); return; }
    S.room = room;
    if (me != null) S.me = me; else if (S.me == null && window.Net && window.Net.me) S.me = window.Net.me;
    if (room.code !== S.code) { S.code = room.code; S.prev = null; S.mapId = null; }
    const playing = room.phase === 'scene' || room.phase === 'combat' || room.phase === 'defeat';
    if (!playing || !validMap(room.map)) { hide(); S.prev = snap(room); return; }
    if (!mount()) return;
    const m = room.map;
    if (!Array.isArray(m.objects)) m.objects = [];
    S.map = m;
    const combat = room.combat && typeof room.combat === 'object' && Array.isArray(room.combat.enemies) ? room.combat : null;
    const battle = room.phase === 'combat' && !!combat && combat.enemies.length > 0;
    if (battle !== S.battle) { S.battle = battle; stage.classList.toggle('battle', battle); }
    box.classList.toggle('tt-battle-on', battle);
    box.classList.add('tt-on');
    const wasHidden = stage.hidden;
    stage.style.setProperty('--ar', (m.w / m.h).toFixed(4));
    if (wasHidden) stage.hidden = false;
    S.visible = true;
    S.firstPaint = S.prev == null || S.mapId == null;
    const newMap = S.mapId !== m.id;
    if (newMap) {
      // a new place: clear the board and fade the new map in
      Array.from(tokens.keys()).forEach((k) => { const t = tokens.get(k); t.el.remove(); tokens.delete(k); });
      Array.from(objs.keys()).forEach((k) => { objs.get(k).el.remove(); objs.delete(k); });
      S.firstPaint = true;
      S.cam.panX = S.cam.panY = 0;
      S.hover = null; S.hoverPath = null; elTip.hidden = true;
      if (S.mapId != null && !reduced()) { scene.classList.remove('enter'); void scene.offsetWidth; scene.classList.add('enter'); }
    }
    S.mapId = m.id;
    layout(false);
    renderBase(newMap);
    renderFog();

    const sc = room.scene && typeof room.scene === 'object' ? room.scene : {};
    const loc = typeof sc.location === 'string' ? sc.location : '';
    if (elLoc.textContent !== loc) elLoc.textContent = loc;
    elLoc.hidden = !loc;
    elRound.hidden = !battle;
    if (battle) { const r = 'Round ' + (num(combat.round) || 1); if (elRound.textContent !== r) elRound.textContent = r; }
    const mine = myTurn();
    elMove.hidden = !mine;
    if (mine) { const left = num(combat.left); const txt = left + ' square' + (left === 1 ? '' : 's') + ' of movement left'; if (elMove.dataset.t !== txt) { elMove.dataset.t = txt; elMove.innerHTML = ''; const b = el('b'); b.textContent = String(left); elMove.appendChild(b); elMove.appendChild(doc.createTextNode(' square' + (left === 1 ? '' : 's') + ' of movement left')); } }
    const label = 'Map of ' + (loc || 'the scene') + (battle ? ', battle' + (mine ? ', your turn' : '') : '');
    if (stage.getAttribute('aria-label') !== label) stage.setAttribute('aria-label', label);

    syncTokens(room);
    syncObjects(room);
    if (S.cam.zoom > 1.001) layout(false);
    syncSel();
    S.hover = S.hover ? { x: S.hover.x, y: S.hover.y, stale: true } : null;
    if (S.hover) { const h = S.hover; S.hover = null; setHover(h, null); }
    drawOverlay();
    syncSpeaking();
    const cur = snap(room);
    if (S.prev && !newMap) effects(room, S.prev, cur);
    S.prev = cur;
    S.firstPaint = false;
  }
  function update(room, me) {
    try { apply(room, me); } catch (e) { if (window.console && console.error) console.error('[tabletop]', e); }
  }

  function hook() {
    if (!subscribed && window.Net && typeof window.Net.onRoom === 'function') {
      subscribed = true;
      window.Net.onRoom((room, me) => update(room, me));
    }
    if (!audioSub && window.GameAudio && typeof window.GameAudio.onState === 'function') {
      audioSub = true;
      try {
        window.GameAudio.onState((st) => {
          S.audio = st && typeof st === 'object' ? { playing: st.playing, seg: st.seg } : { playing: null, seg: null };
          try { syncSpeaking(); } catch (e) { /* ignore */ }
        });
      } catch (e) { /* audio is optional */ }
    }
    return subscribed && audioSub;
  }

  window.GameTable = {
    version: 2,
    update,
    refresh: function () { try { layout(false); renderBase(true); drawOverlay(true); syncSel(); } catch (e) { /* ignore */ } },
    roll: function (value, pass, who) { try { if (stage && !stage.hidden) rollDie(value, pass, who); } catch (e) { /* ignore */ } },
    toast: mapToast,
    // for tests and tools: draw a map to a canvas without a room
    paint: function (m, R) { return paintMap(m, R || 48).canvas; },
  };

  injectStyle();
  if (!hook()) {
    doc.addEventListener('DOMContentLoaded', hook);
    window.addEventListener('load', hook);
  }
})();
