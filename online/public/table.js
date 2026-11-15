/* AI-DnD Online: the visual tabletop.
 *
 * One classic script, no dependencies, no image files. It draws a stage inside #sceneBox:
 * a painted backdrop for the scene's ambience, round game-piece tokens for the party, the
 * people who are speaking and the enemies in a fight, plus hit numbers and an animated d20.
 *
 * It only reads room state (Net.onRoom or GameTable.update) and never sends actions itself.
 * Targeting goes through the app's own buttons: a token click calls .click() on the element
 * with data-k="foe-<id>" / "pc-<id>", and the selection is read back from aria-pressed.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined' || window.GameTable) return;
  const doc = document;

  // ------------------------------------------------------------------ styles

  const CSS = [
    '.tabletop{position:relative;display:block;width:100%;margin-top:10px;aspect-ratio:16/6;max-height:min(320px,max(230px,36vh));min-height:190px;',
    'border:1px solid var(--line,#34424a);border-radius:10px;overflow:hidden;background:#0c1013;isolation:isolate;',
    'user-select:none;-webkit-user-select:none;color:var(--vellum,#ebe4d2);font-family:var(--font-body,system-ui,sans-serif)}',
    '.tabletop[hidden]{display:none!important}',
    '@media (max-width:700px){.tabletop{aspect-ratio:4/3;max-height:250px;min-height:236px;margin-top:8px}}',
    '#sceneBox.tt-battle-on #foes{display:none!important}',
    '.tt-bg,.tt-layer,.tt-mat,.tt-shade,.tt-tokens,.tt-fx{position:absolute;inset:0}',
    '.tt-bg{z-index:0}.tt-mat{z-index:1}.tt-shade{z-index:2}.tt-tokens{z-index:3}.tt-fx{z-index:6;pointer-events:none}',
    '.tt-layer{opacity:0;transition:opacity .9s ease}.tt-layer.on{opacity:1}',
    '.tt-layer svg,.tt-mat svg{display:block;width:100%;height:100%}',
    '.tt-mat{opacity:0;transition:opacity .5s ease;pointer-events:none}',
    '.tabletop.battle .tt-mat{opacity:1}',
    '.tt-shade{pointer-events:none;background:linear-gradient(180deg,rgba(8,11,13,.5) 0,rgba(8,11,13,0) 20%,rgba(8,11,13,0) 52%,rgba(8,11,13,.6) 100%);',
    'box-shadow:inset 0 0 0 1px rgba(0,0,0,.55),inset 0 0 70px rgba(0,0,0,.55);border-radius:9px;transition:background-color .5s}',
    '.tabletop.battle .tt-shade{background-color:rgba(10,8,9,.3)}',

    /* plaques */
    '.tt-loc,.tt-round{position:absolute;top:7px;z-index:4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
    'background:rgba(12,16,19,.86);border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,.5);pointer-events:none}',
    '.tt-loc{left:8px;max-width:calc(100% - 16px);padding:2px 10px 3px;font:400 13px/1.2 var(--font-display,Georgia,serif);letter-spacing:.05em;',
    'color:var(--brass,#d1a94f);border:1px solid rgba(209,169,79,.55);outline:1px solid rgba(209,169,79,.16);outline-offset:-4px}',
    '.tabletop.battle .tt-loc{max-width:calc(100% - 104px)}','.tabletop.sm.rows2 .tt-loc{display:none}',
    '.tt-round{right:8px;padding:3px 9px;font:700 10px/1.3 var(--font-mono,monospace);letter-spacing:.12em;text-transform:uppercase;',
    'color:var(--vellum,#ebe4d2);border:1px solid var(--line,#34424a)}',
    '.tt-plaque{position:absolute;left:50%;bottom:5px;transform:translateX(-50%);z-index:4;max-width:calc(100% - 14px);display:flex;align-items:center;gap:9px;',
    'padding:2px 11px 2px 8px;border-radius:999px;background:rgba(12,16,19,.9);border:1px solid rgba(200,73,61,.6);',
    'font:11px/1.45 var(--font-mono,monospace);color:var(--muted,#9aa7a4);white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.5);pointer-events:none}',
    '.tt-plaque b{font:700 12px/1.3 var(--font-body,sans-serif);color:#f2b9b0;min-width:0;overflow:hidden;text-overflow:ellipsis}',
    '.tt-plaque i{flex:none;width:9px;height:9px;border-radius:50%;border:2px solid var(--blood,#c8493d);box-shadow:0 0 0 1px rgba(12,16,19,.9),0 0 5px var(--blood,#c8493d)}',
    '.tt-plaque span{flex:none}.tt-plaque .v{color:var(--vellum,#ebe4d2)}',
    '.tt-plaque.idle{border-color:var(--line,#34424a)}.tt-plaque.idle i{display:none}.tt-plaque.idle b{color:var(--muted,#9aa7a4);font-weight:400}',

    /* tokens */
    '.tabletop .tk{position:absolute;left:0;top:0;width:var(--tk,52px);height:var(--tk,52px);margin:calc(var(--tk,52px)/-2) 0 0 calc(var(--tk,52px)/-2);',
    'padding:0;border:0;background:none;border-radius:50%;color:inherit;font:inherit;line-height:1;overflow:visible;cursor:pointer;',
    '-webkit-tap-highlight-color:transparent;transition:left .45s cubic-bezier(.2,.8,.2,1),top .45s cubic-bezier(.2,.8,.2,1),opacity .35s ease}',
    '.tabletop div.tk{cursor:default}',
    '.tabletop .tk:disabled{opacity:1;cursor:default}',
    '.tabletop .tk:focus-visible{outline:2px solid var(--brass,#d1a94f);outline-offset:4px}',
    '.tk-shk,.tk-body{position:absolute;inset:0;display:block}',
    '.tk-body{transform-origin:50% 50%;transition:transform .55s cubic-bezier(.3,1.35,.5,1),filter .5s ease,opacity .5s ease}',
    '.tk-svg{display:block;width:100%;height:100%;overflow:visible}',
    '.tabletop button.tk:hover:not(:disabled):not(.is-down) .tk-body{transform:translateY(-3%) scale(1.05)}',
    '.tk-hp{transition:stroke-dashoffset .5s ease,stroke .3s ease}',
    '.tk-name{position:absolute;left:50%;top:100%;transform:translateX(-50%);margin-top:2px;max-width:var(--nm,84px);padding:1px 6px 2px;border-radius:7px;',
    'background:rgba(10,13,15,.82);box-shadow:0 0 0 1px rgba(52,66,74,.7);font:600 12px/1.2 var(--font-body,sans-serif);color:var(--vellum,#ebe4d2);',
    'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;transition:color .3s,opacity .3s}',
    '.tabletop.sm .tk-name{font-size:11px;padding:0 5px 1px}',
    '.tk-tag{display:none;position:absolute;left:50%;bottom:calc(100% - 4px);transform:translateX(calc(-50% + var(--tg,0px)));padding:1px 6px;border-radius:999px;',
    'background:var(--brass,#d1a94f);color:var(--brass-ink,#1c1608);font:700 9px/1.35 var(--font-body,sans-serif);letter-spacing:.08em;text-transform:uppercase;',
    'white-space:nowrap;pointer-events:none;box-shadow:0 1px 5px rgba(0,0,0,.6)}',
    '.tk.is-turn .tk-tag{display:block}',
    '.tk.is-turn{z-index:5!important}',
    '.tk.is-turn .tk-svg{filter:drop-shadow(0 0 4px rgba(209,169,79,.95)) drop-shadow(0 0 11px rgba(209,169,79,.55));animation:tk-turn 1.6s ease-in-out infinite}',
    '.tk.is-me::before{content:"";position:absolute;left:50%;top:-9px;margin-left:-5px;border:5px solid transparent;border-top:7px solid var(--brass,#d1a94f);border-bottom:0;',
    'filter:drop-shadow(0 1px 2px rgba(0,0,0,.8));animation:tk-bob 1.8s ease-in-out infinite}',
    '.tk.is-me.is-turn::before{display:none}',
    '.tk.is-me .tk-name{color:var(--brass,#d1a94f);box-shadow:0 0 0 1px rgba(209,169,79,.65)}',
    '.tk.is-off .tk-body{opacity:.48;filter:saturate(.35)}',
    '.tk.is-off .tk-name{opacity:.6}',
    '.tk.is-down .tk-body{transform:translateY(20%) rotate(-11deg) scale(.98,.5);filter:grayscale(1) brightness(.66)}',
    '.tk.is-down .tk-name{color:var(--muted,#9aa7a4)}',
    '.tk.is-dead{cursor:default;z-index:0!important}',
    '.tk.is-dead .tk-body{transform:translateY(20%) rotate(9deg) scale(.92,.46);filter:grayscale(1) brightness(.55);opacity:.5}',
    '.tk.is-dead .tk-name{opacity:.45;text-decoration:line-through}',
    '.tk-ring{stroke:none;fill:none}',
    '.tk.is-target .tk-ring{stroke:var(--blood,#c8493d);stroke-width:2.6;stroke-dasharray:7 5.04;transform-box:fill-box;transform-origin:center;',
    'animation:tk-rot 7s linear infinite;filter:drop-shadow(0 0 3px var(--blood,#c8493d))}',
    '.tk.is-target .tk-name{box-shadow:0 0 0 1px var(--blood,#c8493d);color:#f6c9c2}',
    '.tk.is-ally .tk-ring{stroke:var(--moss,#77b06c);stroke-width:1.8;stroke-opacity:.9;filter:drop-shadow(0 0 2px var(--moss,#77b06c))}',
    '.tk.is-speaking{z-index:5!important}',
    '.tk.is-speaking .tk-body{animation:tk-speak 1.1s ease-in-out infinite}',
    '.tk.is-speaking::after{content:"";position:absolute;inset:-3px;border-radius:50%;border:2px solid var(--brass,#d1a94f);animation:tk-ripple 1.1s ease-out infinite;pointer-events:none}',
    '.tk.is-speaking .tk-name{color:var(--brass,#d1a94f)}',
    '.tk.tk-in .tk-shk{animation:tk-in .45s cubic-bezier(.2,.9,.3,1.2) both}',
    '.tk.tk-out{opacity:0;pointer-events:none}',
    '.tk.fx-shake .tk-shk{animation:tk-shake .45s ease}',
    '.tk.fx-flash .tk-svg{animation:tk-flash .45s ease}',
    '@keyframes tk-in{from{opacity:0;transform:translateY(-14px) scale(.6)}to{opacity:1;transform:none}}',
    '@keyframes tk-shake{0%,100%{transform:translateX(0)}15%{transform:translateX(-12%) rotate(-5deg)}35%{transform:translateX(10%) rotate(4deg)}55%{transform:translateX(-7%) rotate(-3deg)}75%{transform:translateX(4%)}}',
    '@keyframes tk-flash{0%,100%{filter:none}30%{filter:brightness(1.9) saturate(1.6) drop-shadow(0 0 6px #c8493d)}}',
    '@keyframes tk-rot{to{transform:rotate(360deg)}}',
    '@keyframes tk-turn{0%,100%{filter:drop-shadow(0 0 4px rgba(209,169,79,.95)) drop-shadow(0 0 11px rgba(209,169,79,.55))}50%{filter:drop-shadow(0 0 2px rgba(209,169,79,.7)) drop-shadow(0 0 5px rgba(209,169,79,.25))}}',
    '@keyframes tk-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}',
    '@keyframes tk-speak{0%,100%{transform:scale(1)}50%{transform:scale(1.09)}}',
    '@keyframes tk-ripple{from{transform:scale(.95);opacity:.9}to{transform:scale(1.4);opacity:0}}',

    /* floating numbers */
    '.tt-float{position:absolute;transform:translate(-50%,-100%);padding:0 6px;border-radius:6px;background:rgba(10,13,15,.7);',
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

    /* backdrop life */
    '.tt-flick{transform-box:fill-box;transform-origin:50% 100%;animation:tt-flick .85s ease-in-out infinite}',
    '.tt-glow{animation:tt-glow 2.6s ease-in-out infinite}.tt-glow.slow{animation-duration:5s}',
    '.tt-fog{animation:tt-drift 18s ease-in-out infinite alternate}',
    '.tt-cloud{animation:tt-drift 40s ease-in-out infinite alternate}',
    '.tt-shaft{animation:tt-shaft 7s ease-in-out infinite}',
    '.tt-twinkle{animation:tt-twinkle 3.2s ease-in-out infinite}',
    '.tt-rain{animation:tt-rain .55s linear infinite}.tt-rain.far{animation-duration:.9s}',
    '.tt-bolt{opacity:0;animation:tt-bolt 7s linear infinite}',
    '.tt-sheet{opacity:0;animation:tt-sheet 7s linear infinite}',
    '.tt-wave{animation:tt-wave 6s linear infinite}',
    '.tt-bob{transform-box:fill-box;transform-origin:50% 100%;animation:tt-ship 4s ease-in-out infinite}',
    '.tt-beam{animation:tt-beam 6s ease-in-out infinite}',
    '.tt-spark{opacity:0;animation:tt-spark 2.6s ease-out infinite}',
    '.tt-drip{opacity:0;animation:tt-drip 4.5s ease-in infinite}',
    '.tt-smoke{opacity:0;transform-box:fill-box;transform-origin:center;animation:tt-smoke 9s linear infinite}',
    '@keyframes tt-flick{0%,100%{transform:scale(1,1)}22%{transform:scale(.92,1.1) skewX(3deg)}48%{transform:scale(1.06,.92)}74%{transform:scale(.95,1.06) skewX(-3deg)}}',
    '@keyframes tt-glow{0%,100%{opacity:1}40%{opacity:.72}70%{opacity:.9}}',
    '@keyframes tt-drift{from{transform:translateX(-50px)}to{transform:translateX(50px)}}',
    '@keyframes tt-shaft{0%,100%{opacity:1}50%{opacity:.55}}',
    '@keyframes tt-twinkle{0%,100%{opacity:.9}50%{opacity:.15}}',
    '@keyframes tt-rain{to{transform:translate(-60px,300px)}}',
    '@keyframes tt-bolt{0%,90%,100%{opacity:0}91%{opacity:1}92.5%{opacity:.15}94%{opacity:.9}96.5%{opacity:0}}',
    '@keyframes tt-sheet{0%,90%,100%{opacity:0}91%{opacity:.3}92.5%{opacity:.05}94%{opacity:.22}96.5%{opacity:0}}',
    '@keyframes tt-wave{to{transform:translateX(var(--w,-80px))}}',
    '@keyframes tt-ship{0%,100%{transform:translateY(0) rotate(-3deg)}50%{transform:translateY(3px) rotate(3deg)}}',
    '@keyframes tt-beam{0%,100%{opacity:1}50%{opacity:.35}}',
    '@keyframes tt-spark{0%{transform:translate(0,0);opacity:0}12%{opacity:1}100%{transform:translate(var(--dx,8px),-64px);opacity:0}}',
    '@keyframes tt-drip{0%,70%{transform:translateY(0);opacity:0}72%{opacity:.9}100%{transform:translateY(140px);opacity:.2}}',
    '@keyframes tt-smoke{0%{transform:translate(0,0) scale(.6);opacity:0}15%{opacity:.3}100%{transform:translate(22px,-44px) scale(1.7);opacity:0}}',
    '@media (prefers-reduced-motion:reduce){.tabletop,.tabletop *,.tabletop *::before,.tabletop *::after{animation:none!important;transition:none!important}}',
  ].join('');

  // ------------------------------------------------------------------ art helpers

  const f1 = (n) => Math.round(n * 10) / 10;
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
  const rad = (id, color, a0) => '<radialGradient id="' + id + '"><stop offset="0" stop-color="' + color + '" stop-opacity="' + a0 + '"/>' +
    '<stop offset=".45" stop-color="' + color + '" stop-opacity="' + f1(a0 * 3.5) / 10 + '"/><stop offset="1" stop-color="' + color + '" stop-opacity="0"/></radialGradient>';
  const lin = (id, stops, x2, y2) => '<linearGradient id="' + id + '" x1="0" y1="0" x2="' + (x2 == null ? 0 : x2) + '" y2="' + (y2 == null ? 1 : y2) + '">' +
    stops.map((s) => '<stop offset="' + s[0] + '" stop-color="' + s[1] + '"' + (s[2] != null ? ' stop-opacity="' + s[2] + '"' : '') + '/>').join('') + '</linearGradient>';
  // A flame with its base at (x, y); s scales it (1 = 32 units tall).
  const flame = (x, y, s, i, c1, c2) => '<g transform="translate(' + x + ' ' + y + ') scale(' + s + ')"><g class="tt-flick" style="animation-delay:' + f1(-(i || 0) * 0.31) + 's">' +
    '<path d="M0 0C-9 0-13-8-9-17C-8-12-5-11-4-14C-3-22 1-26 0-32C7-26 12-18 9-11C11-12 12-14 12-17C16-9 10 0 0 0Z" fill="' + (c1 || '#e0813a') + '"/>' +
    '<path d="M0 0C-5 0-7-5-5-10C-3-8-2-10-1-16C4-11 7-6 5-2C4-.5 2 0 0 0Z" fill="' + (c2 || '#f6cf75') + '"/></g></g>';
  const glow = (id, cx, cy, rx, ry, delay, slow) => '<g class="tt-glow' + (slow ? ' slow' : '') + '" style="animation-delay:' + (delay || 0) + 's"><ellipse cx="' + cx + '" cy="' + cy +
    '" rx="' + rx + '" ry="' + (ry || rx) + '" fill="url(#' + id + ')"/></g>';
  const pool = (cx, cy, rx, ry, color, op, delay) => '<g class="tt-glow" style="animation-delay:' + (delay || 0) + 's"><ellipse cx="' + cx + '" cy="' + cy + '" rx="' + rx + '" ry="' + ry +
    '" fill="' + color + '" opacity="' + op + '"/></g>';
  const fog = (id, items) => items.map((f, i) => '<g class="tt-fog" style="animation-delay:' + (-i * 5) + 's;animation-duration:' + (15 + i * 6) + 's"><ellipse cx="' + f[0] + '" cy="' + f[1] +
    '" rx="' + f[2] + '" ry="' + f[3] + '" fill="url(#' + id + ')"/></g>').join('');
  // A three-tier fir tree as one sub-path: x = centre, base = ground y, h = height, w = width.
  const fir = (x, base, h, w) => {
    const p = (dx, dy) => f1(x + dx * w) + ' ' + f1(base - dy * h);
    return 'M' + p(0, 1) + 'L' + p(0.3, 0.66) + 'L' + p(0.14, 0.66) + 'L' + p(0.46, 0.36) + 'L' + p(0.24, 0.36) + 'L' + p(0.6, 0.06) + 'L' + p(0.08, 0.06) + 'L' + p(0.08, 0) +
      'L' + p(-0.08, 0) + 'L' + p(-0.08, 0.06) + 'L' + p(-0.6, 0.06) + 'L' + p(-0.24, 0.36) + 'L' + p(-0.46, 0.36) + 'L' + p(-0.14, 0.66) + 'L' + p(-0.3, 0.66) + 'Z';
  };
  const stars = (R, n, maxY, color) => {
    let s = '';
    for (let i = 0; i < n; i++) {
      const tw = R() < 0.4;
      s += '<circle' + (tw ? ' class="tt-twinkle" style="animation-delay:' + f1(-R() * 4) + 's"' : '') + ' cx="' + f1(R() * 800) + '" cy="' + f1(R() * maxY) + '" r="' + f1(0.5 + R() * 1.1) +
        '" fill="' + color + '" opacity="' + f1(0.35 + R() * 0.55) + '"/>';
    }
    return s;
  };

  // ------------------------------------------------------------------ backdrops (viewBox 800 x 300)
  // Phones crop the picture to roughly x 195..605, so each scene keeps its landmark in the middle.

  function tavern() {
    const R = rng(19);
    const defs = lin('tt-tv-wall', [[0, '#30231a'], [1, '#1f1611']]) + rad('tt-tv-glow', '#f0a040', 0.5) + rad('tt-tv-lamp', '#f2c46b', 0.42);
    let s = '<rect width="800" height="300" fill="url(#tt-tv-wall)"/>';
    let l = '';
    for (let x = 38; x < 800; x += 38) l += 'M' + x + ' 20V146';
    s += '<path d="' + l + '" stroke="#1a120d" stroke-width="2" fill="none" opacity=".75"/>';
    s += '<rect y="146" width="800" height="58" fill="#1d140f"/><rect y="143" width="800" height="5" fill="#3d2b1f"/>';
    // window with the night outside
    s += '<g transform="translate(62 44)"><rect x="-6" y="-6" width="76" height="86" rx="3" fill="#3d2b1f"/><rect width="64" height="74" fill="#0f1b29"/>' +
      '<circle cx="45" cy="20" r="8" fill="#cfd6d4" opacity=".75"/><path d="M32 0V74M0 37H64" stroke="#3d2b1f" stroke-width="4"/></g>';
    // barrels under the window
    const barrel = (x, y) => '<g transform="translate(' + x + ' ' + y + ')"><rect x="-22" width="44" height="54" rx="9" fill="#4d3523"/><path d="M-22 12H22M-22 42H22" stroke="#231811" stroke-width="4"/>' +
      '<path d="M-8 0V54M8 0V54" stroke="#3a2718" stroke-width="2"/></g>';
    s += barrel(30, 150) + barrel(78, 150);
    // shelves and bottles behind the bar
    const cols = ['#3f5a45', '#5a3a2a', '#2f4a5a', '#6a5a2a', '#4a2f3a', '#59615a'];
    [74, 112].forEach((y) => {
      s += '<rect x="528" y="' + y + '" width="262" height="5" fill="#3d2b1f"/>';
      for (let x = 540; x < 780; x += 13 + R() * 9) {
        const h = 13 + R() * 11, w = 6 + R() * 3, c = cols[Math.floor(R() * cols.length)];
        s += '<rect x="' + f1(x) + '" y="' + f1(y - h) + '" width="' + f1(w) + '" height="' + f1(h) + '" rx="1.5" fill="' + c + '"/>' +
          '<rect x="' + f1(x + w / 2 - 1.3) + '" y="' + f1(y - h - 5) + '" width="2.6" height="6" fill="' + c + '"/>';
      }
    });
    // hearth
    s += glow('tt-tv-glow', 330, 166, 200, 132, 0);
    s += '<path d="M258 204V98Q258 84 272 84H388Q402 84 402 98V204Z" fill="#3b3733"/>';
    s += '<path d="M258 118H288M372 118H402M258 150H286M374 150H402M258 180H286M374 180H402M300 84V102M330 84V104M360 84V102" stroke="#2a2623" stroke-width="2" fill="none"/>';
    s += '<path d="M286 204V134Q286 108 330 108Q374 108 374 134V204Z" fill="#0d0907"/>';
    s += '<rect x="248" y="74" width="164" height="12" rx="2" fill="#5a3f2a"/><rect x="248" y="84" width="164" height="3" fill="#2a1c13"/>';
    s += '<circle cx="330" cy="46" r="18" fill="#4a3a2a"/><circle cx="330" cy="46" r="18" fill="none" stroke="#8a6c3a" stroke-width="3"/><circle cx="330" cy="46" r="4.5" fill="#8a6c3a"/>' +
      '<path d="M330 28V64M312 46H348" stroke="#8a6c3a" stroke-width="1.5" opacity=".6"/>';
    s += '<rect x="302" y="193" width="56" height="8" rx="4" fill="#2b1a10"/><rect x="310" y="187" width="42" height="7" rx="3.5" fill="#3a2414" transform="rotate(-7 331 190)"/>';
    s += flame(319, 194, 1.05, 0) + flame(336, 193, 1.45, 1) + flame(350, 194, 0.9, 2);
    // floor
    s += '<rect y="204" width="800" height="96" fill="#1b130e"/>';
    l = '';
    for (let k = -9; k <= 9; k++) l += 'M' + (400 + k * 58) + ' 204L' + (400 + k * 124) + ' 300';
    s += '<path d="' + l + '" stroke="#120c08" stroke-width="2" fill="none"/><rect y="204" width="800" height="5" fill="#0d0806" opacity=".7"/>';
    s += pool(330, 232, 180, 26, '#e0813a', 0.13, 0);
    // posts and beams
    [198, 586].forEach((x) => {
      s += '<rect x="' + x + '" y="0" width="16" height="206" fill="#1c130d"/><rect x="' + x + '" y="0" width="4" height="206" fill="#2a1d14"/>';
      s += '<path d="M' + (x + 16) + ' 72L' + (x + 60) + ' 22H' + (x + 42) + 'L' + (x + 16) + ' 52Z" fill="#1c130d"/>' +
        '<path d="M' + x + ' 72L' + (x - 44) + ' 22H' + (x - 26) + 'L' + x + ' 52Z" fill="#1c130d"/>';
    });
    s += '<rect width="800" height="22" fill="#140d09"/><rect y="22" width="800" height="4" fill="#0c0705" opacity=".6"/>';
    // bar
    s += '<rect x="520" y="178" width="290" height="80" fill="#2c1e14"/><path d="M560 184V252M620 184V252M680 184V252M740 184V252" stroke="#1d130c" stroke-width="2"/>' +
      '<rect x="520" y="238" width="290" height="3" fill="#6a5327"/><rect x="510" y="166" width="300" height="13" rx="2" fill="#5a3f2a"/><rect x="510" y="177" width="300" height="3" fill="#2a1c13"/>';
    const mug = (x) => '<rect x="' + x + '" y="152" width="11" height="14" rx="1.5" fill="#8a6639"/><path d="M' + (x + 11) + ' 155q6 4 0 8" stroke="#8a6639" stroke-width="2" fill="none"/>' +
      '<rect x="' + (x - 0.5) + '" y="150" width="12" height="4" rx="2" fill="#e8dcc0" opacity=".85"/>';
    s += mug(540) + mug(640) + mug(664);
    // hanging lantern
    s += glow('tt-tv-lamp', 470, 62, 70, 70, -1.2);
    s += '<path d="M470 22V50" stroke="#0c0705" stroke-width="2"/><rect x="461" y="50" width="18" height="22" rx="3" fill="#f2c46b"/>' +
      '<path d="M461 50h18M461 72h18M470 50v22" stroke="#3d2b1f" stroke-width="2"/><path d="M459 50l11-7 11 7z" fill="#3d2b1f"/>';
    // table with a candle
    s += '<rect x="142" y="238" width="16" height="62" fill="#22160e"/><path d="M76 230v7a74 13 0 0 0 148 0v-7z" fill="#2f2016"/><ellipse cx="150" cy="230" rx="74" ry="13" fill="#4d3626"/>';
    s += glow('tt-tv-lamp', 150, 204, 40, 40, -0.6) + '<rect x="147" y="212" width="6" height="15" fill="#e8dcc0"/>' + flame(150, 212, 0.34, 3);
    s += '<rect x="176" y="214" width="11" height="14" rx="1.5" fill="#8a6639"/><ellipse cx="60" cy="262" rx="24" ry="7" fill="#3a2819"/><rect x="54" y="264" width="12" height="36" fill="#22160e"/>' +
      '<ellipse cx="246" cy="268" rx="22" ry="6" fill="#3a2819"/><rect x="240" y="270" width="12" height="30" fill="#22160e"/>';
    return [defs, s];
  }

  function town() {
    const R = rng(8);
    const defs = lin('tt-tn-sky', [[0, '#0f1620'], [0.7, '#243241'], [1, '#3b3a48']]) + rad('tt-tn-lamp', '#f2c46b', 0.5) + rad('tt-tn-moon', '#e8ead8', 0.3) + rad('tt-tn-smoke', '#aab6b8', 0.9);
    let s = '<rect width="800" height="300" fill="url(#tt-tn-sky)"/>' + stars(R, 34, 110, '#ece6d0');
    s += '<circle cx="640" cy="44" r="50" fill="url(#tt-tn-moon)"/><circle cx="640" cy="44" r="13" fill="#e8ead8" opacity=".9"/>';
    // far skyline with a clock tower at the end of the street
    s += '<path d="M0 210V124H44V104H74V132H118L132 100L146 132H190V112H236V140H300V96H316V72L328 40L340 72V96H356V140H444V118H470V140H520V112H562L576 86L590 112H640V132H700V96H712V84H724V96H736V84H748V96H760V132H800V210Z" fill="#18232d"/>';
    s += '<rect x="384" y="66" width="32" height="144" fill="#1c2833"/><path d="M376 68L400 22L424 68Z" fill="#16202a"/><circle cx="400" cy="92" r="9" fill="#e2b65a" opacity=".8"/>' +
      '<path d="M400 92V86M400 92H404" stroke="#16202a" stroke-width="1.5"/>';
    // houses either side of the street
    const win = (x, y, lit, d) => {
      const w = '<rect x="' + x + '" y="' + y + '" width="13" height="17" rx="1" fill="' + (lit ? '#e2b65a' : '#0d1318') + '"' + (lit ? ' opacity=".9"' : '') + '/>' +
        '<path d="M' + (x + 6.5) + ' ' + y + 'v17M' + x + ' ' + (y + 8.5) + 'h13" stroke="#161d23" stroke-width="1.5"/>';
      return lit ? '<g class="tt-glow" style="animation-delay:' + d + 's">' + w + '</g>' : w;
    };
    const house = (x, w, top, rh, wall, roof, wins) => {
      let o = '<rect x="' + x + '" y="' + top + '" width="' + w + '" height="' + (206 - top) + '" fill="' + wall + '"/>';
      o += '<path d="M' + x + ' ' + (top + 44) + 'H' + (x + w) + 'M' + (x + w / 2) + ' ' + top + 'V' + (top + 44) + 'M' + x + ' ' + (top + 44) + 'L' + (x + w / 2) + ' ' + top + 'L' + (x + w) + ' ' + (top + 44) +
        '" stroke="#11171c" stroke-width="3" fill="none" opacity=".55"/>';
      o += '<path d="M' + (x - 9) + ' ' + (top + 3) + 'L' + (x + w / 2) + ' ' + (top - rh) + 'L' + (x + w + 9) + ' ' + (top + 3) + 'Z" fill="' + roof + '"/>';
      wins.forEach((v, i) => { o += win(x + v[0], top + v[1], v[2], -i * 0.9); });
      return o;
    };
    s += '<rect x="214" y="44" width="14" height="30" fill="#221c1f"/>';
    s += house(-12, 150, 112, 44, '#1c252c', '#2a2226', [[30, 14, 1], [96, 14, 0], [30, 58, 0], [96, 58, 1]]);
    s += house(150, 164, 96, 54, '#202a31', '#261f23', [[26, 14, 0], [120, 14, 1], [26, 62, 1], [120, 62, 0]]);
    s += house(486, 160, 102, 50, '#202a31', '#2a2226', [[24, 14, 1], [118, 14, 0], [24, 60, 0], [118, 60, 1]]);
    s += house(660, 152, 116, 42, '#1c252c', '#261f23', [[28, 14, 0], [104, 14, 1], [28, 56, 1]]);
    // doors and a hanging sign
    s += '<path d="M216 206V172Q216 160 228 160Q240 160 240 172V206Z" fill="#0d1216"/><path d="M552 206V174Q552 162 564 162Q576 162 576 174V206Z" fill="#0d1216"/>';
    s += '<path d="M486 150h-26" stroke="#0d1216" stroke-width="3"/><path d="M465 150v6M479 150v6" stroke="#0d1216" stroke-width="1.5"/><rect x="460" y="156" width="24" height="16" rx="2" fill="#4a3526"/>' +
      '<circle cx="472" cy="164" r="4" fill="#d1a94f" opacity=".8"/>';
    // chimney smoke
    [0, 1, 2].forEach((i) => { s += '<circle class="tt-smoke" style="animation-delay:' + (-i * 3) + 's" cx="221" cy="38" r="12" fill="url(#tt-tn-smoke)"/>'; });
    // ground and street
    s += '<rect y="206" width="800" height="94" fill="#141b20"/><path d="M316 206H484L660 300H140Z" fill="#1c262c"/>';
    let c = '';
    [214, 226, 242, 262, 286].forEach((y, r) => {
      const half = 84 + (y - 206) * 1.86;
      for (let x = 400 - half + (r % 2) * 9; x < 400 + half - 14; x += 22 + r * 3) c += 'M' + f1(x) + ' ' + y + 'q' + (5 + r) + ' -' + (3 + r * 0.6) + ' ' + (10 + r * 2) + ' 0';
    });
    s += '<path d="' + c + '" stroke="#2c3941" stroke-width="1.5" fill="none" opacity=".8"/>';
    // lantern posts flanking the street
    [[304, 1], [496, -1]].forEach((p, i) => {
      const x = p[0], m = p[1], lx = x + m * 15;
      s += glow('tt-tn-lamp', lx, 132, 62, 62, -i * 1.3) + pool(lx, 222, 70, 11, '#e2b65a', 0.1, -i * 1.3);
      s += '<rect x="' + (x - 2) + '" y="118" width="4" height="90" fill="#0b1014"/><rect x="' + (x - 5) + '" y="200" width="10" height="8" fill="#0b1014"/>' +
        '<path d="M' + x + ' 120H' + lx + 'V126" stroke="#0b1014" stroke-width="3" fill="none"/><rect x="' + (lx - 6) + '" y="125" width="12" height="15" rx="2" fill="#f2c46b"/>' +
        '<path d="M' + (lx - 7) + ' 125h14l-7-6z" fill="#0b1014"/>';
    });
    // well (left) and market stall (right)
    s += '<path d="M72 250V226H136V250Z" fill="#2a343a"/><ellipse cx="104" cy="226" rx="32" ry="7" fill="#39454c"/><ellipse cx="104" cy="226" rx="22" ry="4" fill="#0a0e11"/>' +
      '<path d="M76 226V190M132 226V190" stroke="#3a2a1f" stroke-width="4"/><path d="M66 192L104 172L142 192Z" fill="#33262a"/>';
    s += '<path d="M622 252V196M736 252V196" stroke="#3a2a1f" stroke-width="4"/><rect x="620" y="232" width="118" height="26" fill="#2f2219"/>';
    for (let i = 0; i < 6; i++) s += '<path d="M' + (610 + i * 23) + ' 180h23l-3 22h-23z" fill="' + (i % 2 ? '#3a3028' : '#6a2a24') + '"/>';
    s += '<rect x="640" y="222" width="18" height="12" fill="#5a4630"/><rect x="664" y="218" width="20" height="16" fill="#4a3a28"/><circle cx="704" cy="228" r="6" fill="#77603a"/><circle cx="716" cy="229" r="5" fill="#6a2a24"/>';
    return [defs, s];
  }

  function forest() {
    const R = rng(5);
    const defs = lin('tt-fr-sky', [[0, '#16241d'], [0.55, '#2b4531'], [1, '#131c17']]) + rad('tt-fr-sun', '#d6e9a0', 0.55) +
      lin('tt-fr-shaft', [[0, '#e6f2b0', 0.36], [1, '#e6f2b0', 0]]) + rad('tt-fr-fog', '#dfeedd', 0.22);
    let s = '<rect width="800" height="300" fill="url(#tt-fr-sky)"/><ellipse cx="430" cy="70" rx="260" ry="200" fill="url(#tt-fr-sun)"/>';
    let d = '';
    for (let x = -10; x < 830; x += 28 + R() * 22) d += fir(x, 208, 100 + R() * 62, 44 + R() * 20);
    s += '<path d="' + d + '" fill="#243b2c"/>';
    d = '';
    for (let x = -30; x < 850; x += 56 + R() * 44) d += fir(x, 216, 168 + R() * 70, 72 + R() * 30);
    s += '<path d="' + d + '" fill="#182a20"/>';
    s += '<g class="tt-shaft"><path d="M430 -10H506L378 300H246Z" fill="url(#tt-fr-shaft)"/></g>' +
      '<g class="tt-shaft" style="animation-delay:-3s"><path d="M528 -10H570L528 300H446Z" fill="url(#tt-fr-shaft)"/></g>' +
      '<g class="tt-shaft" style="animation-delay:-5s"><path d="M350 -10H384L232 300H168Z" fill="url(#tt-fr-shaft)"/></g>';
    s += '<path d="M0 212Q200 198 400 208T800 204V300H0Z" fill="#15221a"/>';
    s += '<path d="M352 300C366 262 424 252 412 232C406 222 386 218 392 207H412C410 218 432 224 438 236C450 258 474 270 486 300Z" fill="#2a3b2c" opacity=".9"/>';
    // near trunks
    const trunk = (x, w, fill) => '<path d="M' + f1(x - w * 0.6) + ' 300L' + f1(x - w * 0.4) + ' 150L' + f1(x - w * 0.44) + ' -5H' + f1(x + w * 0.44) + 'L' + f1(x + w * 0.38) + ' 160L' + f1(x + w * 0.66) + ' 300Z" fill="' + fill + '"/>';
    s += trunk(128, 24, '#111c16') + trunk(668, 22, '#111c16');
    s += '<path d="M222 96L268 62L270 70L224 112Z" fill="#101a14"/><path d="M580 110L536 78L535 86L578 126Z" fill="#101a14"/>';
    s += trunk(215, 30, '#101a14') + trunk(585, 36, '#101a14') + trunk(36, 74, '#0c1410') + trunk(756, 84, '#0c1410');
    s += '<path d="M0 0H800V26Q760 54 700 34Q650 60 590 36Q540 52 500 22Q440 42 380 20Q320 46 270 30Q220 58 160 34Q90 62 40 40Q20 50 0 44Z" fill="#0c1410"/>';
    // undergrowth
    const tuft = (x, y, k, fill) => '<path d="M' + x + ' ' + y + 'Q' + f1(x - 10 * k) + ' ' + f1(y - 9 * k) + ' ' + f1(x - 17 * k) + ' ' + f1(y - 17 * k) + 'Q' + f1(x - 5 * k) + ' ' + f1(y - 13 * k) + ' ' + x + ' ' + y +
      'Q' + f1(x - 3 * k) + ' ' + f1(y - 16 * k) + ' ' + f1(x + 2 * k) + ' ' + f1(y - 27 * k) + 'Q' + f1(x + 5 * k) + ' ' + f1(y - 14 * k) + ' ' + x + ' ' + y +
      'Q' + f1(x + 6 * k) + ' ' + f1(y - 13 * k) + ' ' + f1(x + 18 * k) + ' ' + f1(y - 16 * k) + 'Q' + f1(x + 10 * k) + ' ' + f1(y - 8 * k) + ' ' + x + ' ' + y + 'Z" fill="' + fill + '"/>';
    [[250, 222, 1], [300, 214, 0.7], [520, 218, 0.8], [556, 226, 1.1], [160, 232, 1.2], [640, 230, 1.2], [448, 214, 0.6]].forEach((t) => { s += tuft(t[0], t[1], t[2], '#22402b'); });
    s += '<path d="M0 262Q200 244 420 258T800 250V300H0Z" fill="#0e1712"/>';
    [[90, 268, 1.5], [300, 264, 1.3], [500, 266, 1.4], [712, 262, 1.6], [404, 262, 0.9]].forEach((t) => { s += tuft(t[0], t[1], t[2], '#16281c'); });
    s += fog('tt-fr-fog', [[220, 214, 240, 22], [560, 226, 260, 26], [400, 200, 200, 16]]);
    for (let i = 0; i < 10; i++) {
      s += '<circle class="tt-twinkle" style="animation-delay:' + f1(-R() * 3) + 's;animation-duration:' + f1(1.6 + R() * 2) + 's" cx="' + f1(180 + R() * 440) + '" cy="' + f1(120 + R() * 90) + '" r="1.7" fill="#e9f29a"/>';
    }
    return [defs, s];
  }

  function cave() {
    const R = rng(21);
    const defs = lin('tt-cv-bg', [[0, '#0c1116'], [1, '#131b22']]) + rad('tt-cv-pool', '#3fb7c4', 0.42) + rad('tt-cv-fun', '#6ff0d8', 0.5);
    let s = '<rect width="800" height="300" fill="url(#tt-cv-bg)"/>';
    s += '<path d="M40 300C10 190 90 70 260 52C380 30 540 34 650 84C770 138 790 230 770 300Z" fill="#19242c"/>';
    s += '<path d="M150 300C130 210 190 120 300 104C400 90 520 96 600 136C680 176 690 250 676 300Z" fill="#1f2d36"/>';
    s += '<path d="M326 206C318 164 348 128 400 126C454 124 482 164 474 206Z" fill="#0a0e12"/><path d="M350 206C346 178 366 152 400 150C436 148 454 178 450 206Z" fill="#050709"/>';
    s += '<path d="M120 170Q220 150 300 160M500 118Q600 108 680 150M560 178Q620 170 690 190M190 130Q250 112 310 118" stroke="#2b3b47" stroke-width="2" fill="none" opacity=".75"/>';
    const tite = (x, w, len, fill) => '<path d="M' + f1(x - w / 2) + ' -2H' + f1(x + w / 2) + 'L' + f1(x + w * 0.12) + ' ' + f1(len * 0.7) + 'L' + f1(x) + ' ' + f1(len) + 'L' + f1(x - w * 0.14) + ' ' + f1(len * 0.62) + 'Z" fill="' + fill + '"/>';
    let x = -10;
    while (x < 820) { const w = 16 + R() * 26; s += tite(x, w, 40 + R() * 66, '#151e25'); x += w * (0.7 + R() * 0.8); }
    x = -20;
    while (x < 830) { const w = 26 + R() * 40, edge = Math.abs(x - 400) / 400; s += tite(x, w, 26 + R() * 44 + edge * 76, '#080b0e'); x += w * (0.8 + R()); }
    s += '<path d="M0 0H800V16Q600 30 400 20Q200 30 0 16Z" fill="#080b0e"/>';
    s += '<path d="M0 204Q200 192 400 200T800 196V300H0Z" fill="#121a20"/>';
    // pool
    s += glow('tt-cv-pool', 556, 196, 220, 80, 0, true);
    s += '<ellipse cx="556" cy="214" rx="164" ry="17" fill="#153a44"/><ellipse cx="552" cy="212" rx="134" ry="11" fill="#1f5a66"/><ellipse cx="530" cy="210" rx="76" ry="5" fill="#49a3ad" opacity=".5"/>';
    s += '<path d="M470 217q26 -4 52 0M580 219q36 -5 72 0M520 207q18 -3 36 0" stroke="#8fdbe0" stroke-width="1.4" fill="none" opacity=".45"/>';
    s += '<circle class="tt-drip" cx="520" cy="66" r="2.2" fill="#8fdbe0"/><circle class="tt-drip" style="animation-delay:-2.2s" cx="604" cy="74" r="2" fill="#8fdbe0"/>';
    // crystals
    s += '<path d="M684 204L694 164L706 204Z" fill="#4f93d6" opacity=".85"/><path d="M700 204L714 176L722 204Z" fill="#74aee4" opacity=".75"/><path d="M670 204L677 182L687 204Z" fill="#3b78b8" opacity=".8"/>';
    // glowing fungus
    const shroom = (sx, sy, k) => '<rect x="' + f1(sx - 1.2 * k) + '" y="' + f1(sy - 7 * k) + '" width="' + f1(2.4 * k) + '" height="' + f1(7 * k) + '" fill="#c4f2e6" opacity=".8"/>' +
      '<path d="M' + f1(sx - 6 * k) + ' ' + f1(sy - 6.5 * k) + 'Q' + sx + ' ' + f1(sy - 17 * k) + ' ' + f1(sx + 6 * k) + ' ' + f1(sy - 6.5 * k) + 'Z" fill="#6ff0d8"/>';
    const patch = (px, py, dl, k) => glow('tt-cv-fun', px + 4, py - 10, 46 * k, 40 * k, dl) + shroom(px - 13 * k, py, k) + shroom(px, py + 2, 1.5 * k) + shroom(px + 13 * k, py + 1, 0.9 * k) + shroom(px + 23 * k, py + 3, 1.2 * k);
    s += '<path d="M226 150h64l-8 8h-48z" fill="#141d24"/>' + patch(248, 150, -0.6, 0.8);
    s += patch(262, 208, 0, 1) + patch(388, 204, -1.9, 0.6);
    // stalagmites
    const mite = (mx, w, h, fill, base) => '<path d="M' + f1(mx - w / 2) + ' ' + base + 'L' + f1(mx - w * 0.1) + ' ' + f1(base - h * 0.6) + 'L' + mx + ' ' + f1(base - h) + 'L' + f1(mx + w * 0.14) + ' ' + f1(base - h * 0.55) + 'L' + f1(mx + w / 2) + ' ' + base + 'Z" fill="' + fill + '"/>';
    s += mite(214, 22, 44, '#0f161b', 212) + mite(330, 16, 26, '#0f161b', 206) + mite(470, 14, 22, '#0f161b', 204);
    s += '<path d="M0 262Q220 240 420 256T800 246V300H0Z" fill="#0b1014"/>';
    s += mite(130, 44, 84, '#0d1317', 290) + mite(686, 40, 76, '#0d1317', 288) + mite(56, 66, 136, '#080b0e', 302) + mite(748, 76, 146, '#080b0e', 302);
    s += patch(120, 262, -1.2, 1.1) + patch(690, 268, -2.4, 1);
    return [defs, s];
  }

  function dungeon() {
    const R = rng(7);
    const arch = (x, w, top) => 'M' + (x - w) + ' 204V' + (top + w) + 'Q' + (x - w) + ' ' + top + ' ' + x + ' ' + top + 'Q' + (x + w) + ' ' + top + ' ' + (x + w) + ' ' + (top + w) + 'V204Z';
    const A = [[150, 44, 80], [400, 52, 62], [650, 44, 80]];
    const defs = rad('tt-dg-torch', '#f0a040', 0.55) + lin('tt-dg-dark', [[0, '#000', 0.6], [0.6, '#000', 0]]) +
      A.map((a, i) => '<clipPath id="tt-dg-c' + i + '"><path d="' + arch(a[0], a[1], a[2]) + '"/></clipPath>').join('');
    let s = '<rect width="800" height="300" fill="#12181c"/>';
    const tones = ['#222b30', '#1f272c', '#263036', '#1c2429', '#232c31', '#20292e'];
    for (let row = 0; row < 9; row++) {
      const y = row * 24 - 6, off = row % 2 ? -34 : 0;
      for (let x = off; x < 800; x += 68) s += '<rect x="' + (x + 1.5) + '" y="' + (y + 1.5) + '" width="65" height="21" rx="2" fill="' + tones[Math.floor(R() * tones.length)] + '"/>';
    }
    s += '<rect width="800" height="206" fill="url(#tt-dg-dark)"/>';
    s += glow('tt-dg-torch', 275, 106, 130, 130, 0) + glow('tt-dg-torch', 525, 106, 130, 130, -1.1);
    A.forEach((a) => {
      s += '<path d="' + arch(a[0], a[1] + 10, a[2] - 10) + '" fill="#313c43"/><path d="' + arch(a[0], a[1], a[2]) + '" fill="#06080a"/>' +
        '<path d="M' + (a[0] - 8) + ' ' + (a[2] - 13) + 'h16l-3 15h-10z" fill="#3e4a52"/>';
    });
    // left: a banded door. centre: a portcullis over a corridor. right: steps going down.
    s += '<g clip-path="url(#tt-dg-c0)"><rect x="104" y="78" width="92" height="128" fill="#2c2018"/><path d="M127 78V206M150 78V206M173 78V206" stroke="#1a120d" stroke-width="2"/>' +
      '<path d="M104 116H196M104 174H196" stroke="#3d484f" stroke-width="6"/><circle cx="183" cy="148" r="4.5" fill="#5d6970"/></g>';
    let bars = '';
    for (let x = 364; x <= 436; x += 18) bars += 'M' + x + ' 60V204';
    s += '<g clip-path="url(#tt-dg-c1)"><path d="M348 204L382 150H418L452 204Z" fill="#141b20"/><path d="M382 150H418V120Q400 108 382 120Z" fill="#0d1216"/>' +
      '<path d="' + bars + 'M346 100H454M346 138H454M346 176H454" stroke="#3b464d" stroke-width="4" fill="none"/></g>';
    s += '<g clip-path="url(#tt-dg-c2)"><path d="M604 204H696V190H604Z" fill="#1c252a"/><path d="M614 190H686V178H614Z" fill="#161d22"/><path d="M624 178H676V168H624Z" fill="#11171b"/><path d="M632 168H668V160H632Z" fill="#0c1114"/></g>';
    // torches
    [275, 525].forEach((x, i) => {
      s += '<path d="M' + x + ' 152v10h-13" stroke="#4a555c" stroke-width="3" fill="none"/><rect x="' + (x - 3) + '" y="124" width="6" height="30" rx="2" fill="#4a3526"/>' +
        '<path d="M' + (x - 9) + ' 118h18l-4 9h-10z" fill="#56626a"/>' + flame(x, 120, 0.82, i * 2);
    });
    // chains and a banner at the edges
    s += '<path d="M44 0V92M62 0V66" stroke="#3d484f" stroke-width="3" stroke-dasharray="5 3"/><circle cx="44" cy="97" r="6" fill="none" stroke="#3d484f" stroke-width="3"/><circle cx="62" cy="71" r="6" fill="none" stroke="#3d484f" stroke-width="3"/>';
    s += '<rect x="716" y="24" width="60" height="4" rx="2" fill="#4a555c"/><path d="M722 28H770V124L746 106L722 124Z" fill="#4f201d"/><path d="M746 50l10 14-10 14-10-14z" fill="#8a3f33"/>';
    // floor
    s += '<rect y="204" width="800" height="96" fill="#151b1f"/><rect y="198" width="800" height="8" fill="#2b353b"/>';
    let g = 'M0 218H800M0 236H800M0 260H800M0 288H800';
    for (let k = -10; k <= 10; k++) g += 'M' + (400 + k * 62) + ' 206L' + (400 + k * 126) + ' 300';
    s += '<path d="' + g + '" stroke="#0c1114" stroke-width="2" fill="none"/>';
    s += pool(275, 226, 120, 16, '#e0813a', 0.11, 0) + pool(525, 226, 120, 16, '#e0813a', 0.11, -1.1);
    s += '<ellipse cx="232" cy="204" rx="16" ry="4" fill="#3d5a3a" opacity=".6"/><ellipse cx="560" cy="205" rx="20" ry="4" fill="#3d5a3a" opacity=".5"/><ellipse cx="96" cy="205" rx="14" ry="3.5" fill="#3d5a3a" opacity=".5"/>';
    return [defs, s];
  }

  function crypt() {
    const defs = rad('tt-cr-pale', '#a8e0d6', 0.5) + rad('tt-cr-fog', '#cfe8e4', 0.17) + rad('tt-cr-cndl', '#d9f2e6', 0.45);
    let s = '<rect width="800" height="300" fill="#11151b"/><rect width="800" height="206" fill="#191e26"/>';
    [[-85, 85], [115, 285], [315, 485], [515, 685], [715, 885]].forEach((b, i) => {
      const a = b[0], z = b[1], m = (a + z) / 2;
      s += '<path d="M' + a + ' 206V104Q' + a + ' 44 ' + m + ' 22Q' + z + ' 44 ' + z + ' 104V206Z" fill="' + (i === 2 ? '#10161c' : '#0c1015') + '"/>' +
        '<path d="M' + a + ' 104Q' + a + ' 44 ' + m + ' 22Q' + z + ' 44 ' + z + ' 104" fill="none" stroke="#2e3743" stroke-width="5"/>';
    });
    // the pale window and its light
    s += glow('tt-cr-pale', 400, 110, 170, 150, 0, true);
    s += '<path d="M385 152V84Q385 60 400 48Q415 60 415 84V152Z" fill="#c9eee6" opacity=".8"/><path d="M400 48V152M385 100H415" stroke="#10161c" stroke-width="3"/>';
    s += '<path d="M385 152H415L500 300H300Z" fill="#a8e0d6" opacity=".07"/>';
    // skull niches
    const skull = (x, y) => '<path d="M' + (x - 15) + ' ' + (y + 12) + 'V' + (y - 5) + 'Q' + x + ' ' + (y - 22) + ' ' + (x + 15) + ' ' + (y - 5) + 'V' + (y + 12) + 'Z" fill="#07090c"/>' +
      '<circle cx="' + x + '" cy="' + y + '" r="6.5" fill="#8b9693"/><rect x="' + (x - 4) + '" y="' + (y + 4) + '" width="8" height="5" rx="1" fill="#8b9693"/>' +
      '<circle cx="' + (x - 2.5) + '" cy="' + y + '" r="1.7" fill="#07090c"/><circle cx="' + (x + 2.5) + '" cy="' + y + '" r="1.7" fill="#07090c"/>';
    s += skull(168, 100) + skull(232, 100) + skull(568, 100) + skull(632, 100) + skull(36, 100) + skull(764, 100);
    // cobwebs
    s += '<path d="M115 104L158 104M115 104L146 78M115 104L122 66M130 104Q134 92 126 84M146 104Q152 84 132 74" stroke="#9aa7a4" stroke-width="1" fill="none" opacity=".28"/>' +
      '<path d="M685 104L642 104M685 104L654 78M685 104L678 66M670 104Q666 92 674 84M654 104Q648 84 668 74" stroke="#9aa7a4" stroke-width="1" fill="none" opacity=".28"/>';
    // pillars
    [100, 300, 500, 700].forEach((x) => {
      s += '<path d="M' + (x - 13) + ' 88V0H' + (x + 13) + 'V88Z" fill="#1f2630"/><rect x="' + (x - 15) + '" y="96" width="30" height="104" fill="#27303a"/>' +
        '<rect x="' + (x - 15) + '" y="96" width="8" height="104" fill="#323d4a"/><path d="M' + (x - 2) + ' 100V196M' + (x + 7) + ' 100V196" stroke="#1d242d" stroke-width="2"/>' +
        '<rect x="' + (x - 22) + '" y="86" width="44" height="12" rx="2" fill="#364250"/><rect x="' + (x - 22) + '" y="196" width="44" height="12" rx="2" fill="#364250"/>';
    });
    const sarc = (x, w, y, h) => '<rect x="' + (x - w / 2) + '" y="' + y + '" width="' + w + '" height="' + h + '" fill="#2a323c"/>' +
      '<path d="M' + (x - w / 2 + 8) + ' ' + (y - 8) + 'Q' + x + ' ' + (y - 24) + ' ' + (x + w / 2 - 8) + ' ' + (y - 8) + 'Z" fill="#343e49"/>' +
      '<rect x="' + (x - w / 2 - 6) + '" y="' + (y - 9) + '" width="' + (w + 12) + '" height="9" rx="1.5" fill="#3c4753"/>' +
      '<path d="M' + x + ' ' + (y + 6) + 'V' + (y + h - 6) + 'M' + (x - 9) + ' ' + (y + 14) + 'H' + (x + 9) + '" stroke="#1a2028" stroke-width="3"/>';
    s += sarc(200, 112, 172, 34) + sarc(600, 112, 172, 34);
    // floor
    s += '<rect y="206" width="800" height="94" fill="#0f1318"/>';
    let t = '';
    for (let k = -3; k <= 13; k++) t += 'M' + (k * 80) + ' 206L' + (k * 80 + 180) + ' 300M' + (k * 80) + ' 206L' + (k * 80 - 180) + ' 300';
    s += '<path d="' + t + '" stroke="#192029" stroke-width="1.5" fill="none"/>';
    s += '<path d="M318 204H482L494 216H306Z" fill="#232a33"/>' + sarc(400, 136, 166, 38);
    // candles
    [[304, 0], [496, 1], [140, 2], [660, 3]].forEach((c) => {
      s += glow('tt-cr-cndl', c[0], 188, 30, 30, -c[1] * 0.7) + '<rect x="' + (c[0] - 2.5) + '" y="192" width="5" height="16" fill="#d8d2bd"/>' + flame(c[0], 192, 0.3, c[1], '#bfe9dc', '#f2fff9');
    });
    s += fog('tt-cr-fog', [[200, 240, 230, 28], [580, 252, 270, 30], [400, 226, 190, 18]]);
    return [defs, s];
  }

  function mountain() {
    const R = rng(13);
    const defs = lin('tt-mt-sky', [[0, '#111a24'], [0.6, '#2a3b48'], [1, '#56696f']]) + rad('tt-mt-moon', '#e8ead8', 0.36) + lin('tt-mt-far', [[0, '#3a4b57'], [1, '#283540']]);
    let s = '<rect width="800" height="300" fill="url(#tt-mt-sky)"/>' + stars(R, 26, 100, '#ece6d0');
    s += '<circle cx="612" cy="54" r="64" fill="url(#tt-mt-moon)"/><circle cx="612" cy="54" r="15" fill="#e8ead8" opacity=".92"/>';
    s += '<path d="M-20 214L70 128L128 160L236 66L300 126L344 104L420 44L492 122L548 96L640 150L716 92L820 170V232H-20Z" fill="url(#tt-mt-far)"/>';
    s += '<path d="M236 66L268 96L256 92L248 106L238 93L226 104L218 91L208 90Z" fill="#d7ddda" opacity=".92"/>' +
      '<path d="M420 44L461 88L446 84L438 100L426 86L414 102L402 86L388 96L369 84Z" fill="#d7ddda" opacity=".92"/>' +
      '<path d="M716 92L753 120L738 117L730 130L718 118L706 130L696 118L682 118Z" fill="#d7ddda" opacity=".9"/>' +
      '<path d="M548 96L575 112L562 110L554 120L544 110L532 118L518 110Z" fill="#d7ddda" opacity=".85"/>' +
      '<path d="M70 128L103 146L88 144L80 154L70 144L60 152L51 146Z" fill="#d7ddda" opacity=".85"/>';
    // shaded faces
    s += '<path d="M236 66L300 126L262 150L244 104Z" fill="#1d2832" opacity=".4"/><path d="M420 44L492 122L452 150L430 96Z" fill="#1d2832" opacity=".4"/><path d="M716 92L820 170V200L740 150Z" fill="#1d2832" opacity=".4"/>';
    const cloud = (x, y, k, op, dur, dl) => '<g class="tt-cloud" style="animation-duration:' + dur + 's;animation-delay:' + dl + 's" fill="#6f838b" opacity="' + op + '">' +
      '<ellipse cx="' + x + '" cy="' + y + '" rx="' + 60 * k + '" ry="' + 11 * k + '"/><ellipse cx="' + (x - 34 * k) + '" cy="' + (y + 4 * k) + '" rx="' + 40 * k + '" ry="' + 8 * k + '"/>' +
      '<ellipse cx="' + (x + 38 * k) + '" cy="' + (y + 5 * k) + '" rx="' + 46 * k + '" ry="' + 9 * k + '"/><ellipse cx="' + (x + 6 * k) + '" cy="' + (y - 8 * k) + '" rx="' + 30 * k + '" ry="' + 9 * k + '"/></g>';
    s += cloud(170, 62, 1.1, 0.45, 46, 0) + cloud(520, 34, 0.8, 0.35, 60, -20) + cloud(330, 150, 1.5, 0.3, 52, -30) + cloud(690, 160, 1.2, 0.28, 44, -8);
    s += '<path d="M-20 240L50 178L120 204L210 150L290 206L372 172L460 214L556 160L636 204L716 166L820 206V300H-20Z" fill="#1d2932"/>';
    s += '<path d="M210 150L234 165L222 164L213 174L200 163Z" fill="#c3ccca" opacity=".55"/><path d="M556 160L580 173L568 173L559 182L546 171Z" fill="#c3ccca" opacity=".55"/>' +
      '<path d="M716 166L738 177L726 177L718 185L707 175Z" fill="#c3ccca" opacity=".45"/><path d="M372 172L392 184L381 184L374 191L363 181Z" fill="#c3ccca" opacity=".45"/>';
    s += '<path d="M0 252Q180 206 420 232T800 216V300H0Z" fill="#151e25"/>';
    // the winding path
    s += '<path d="M326 300C348 276 450 272 441 254C434 240 388 240 397 228C404 219 446 222 457 215L467 216C461 226 418 224 415 230C410 240 470 240 476 256C484 276 424 280 414 300Z" fill="#8c9995" opacity=".55"/>';
    let d = '';
    [[60, 262, 76, 34], [108, 254, 54, 26], [706, 246, 84, 36], [760, 250, 58, 28], [236, 240, 40, 18], [612, 236, 44, 20], [20, 270, 60, 28]].forEach((p) => { d += fir(p[0], p[1], p[2], p[3]); });
    s += '<path d="' + d + '" fill="#0c1317"/>';
    s += '<path d="M0 284Q260 258 520 278T800 264V300H0Z" fill="#0f161b"/>';
    return [defs, s];
  }

  function storm() {
    const R = rng(11);
    const defs = lin('tt-st-sky', [[0, '#090d12'], [1, '#1b2731']]) + lin('tt-st-beam', [[0, '#f6e6a8', 0.5], [1, '#f6e6a8', 0]], 1, 0) +
      lin('tt-st-beam2', [[0, '#f6e6a8', 0], [1, '#f6e6a8', 0.4]], 1, 0) + rad('tt-st-lamp', '#f6dc8a', 0.6);
    let s = '<rect width="800" height="300" fill="url(#tt-st-sky)"/>';
    const blob = (x, y, rx, ry, fill) => '<ellipse cx="' + x + '" cy="' + y + '" rx="' + rx + '" ry="' + ry + '" fill="' + fill + '"/>';
    s += blob(120, 30, 190, 48, '#19232c') + blob(420, 14, 240, 54, '#1d2832') + blob(700, 36, 200, 50, '#19232c') + blob(260, 62, 150, 30, '#141c23') + blob(560, 70, 170, 30, '#141c23') +
      blob(60, 78, 110, 24, '#10171d') + blob(760, 86, 120, 24, '#10171d') + blob(410, 84, 120, 20, '#10171d');
    s += '<rect class="tt-sheet" width="800" height="300" fill="#bcd6ea"/>';
    s += '<path class="tt-bolt" d="M462 60L438 106L454 108L422 154L440 156L410 200" fill="none" stroke="#eef6ff" stroke-width="3" stroke-linejoin="round"/>' +
      '<path class="tt-bolt" d="M440 156L462 176L456 190" fill="none" stroke="#eef6ff" stroke-width="2" stroke-linejoin="round"/>';
    const wave = (y, amp, len) => {
      let d = 'M-120 ' + y;
      for (let x = -120; x < 1020; x += len) d += 'q' + f1(len / 4) + ' ' + (-amp) + ' ' + f1(len / 2) + ' 0t' + f1(len / 2) + ' 0';
      return d + 'V300H-120Z';
    };
    s += '<g class="tt-wave" style="--w:-60px;animation-duration:5s"><path d="' + wave(196, 5, 60) + '" fill="#16242e"/></g>';
    // the light on the headland
    s += '<g class="tt-beam"><path d="M294 96L820 20V160Z" fill="url(#tt-st-beam)"/><path d="M270 96L-20 60V130Z" fill="url(#tt-st-beam2)"/></g>';
    s += '<path d="M150 240L196 198L232 202L262 172L300 174L338 200L372 206L414 240Z" fill="#090d11"/>';
    s += '<path d="M268 174L273 104H291L296 174Z" fill="#26323b"/><path d="M270.5 150H293.5M272 128H292" stroke="#090d11" stroke-width="6"/>';
    s += glow('tt-st-lamp', 282, 96, 46, 46, 0);
    s += '<rect x="270" y="89" width="24" height="15" fill="#f6dc8a"/><path d="M278 89v15M286 89v15" stroke="#090d11" stroke-width="1.5"/><path d="M265 90H299L282 74Z" fill="#090d11"/><rect x="266" y="103" width="32" height="3.5" fill="#090d11"/>';
    // a ship riding it out
    s += '<g class="tt-bob"><path d="M500 204H590L578 222H512Z" fill="#090d11"/><path d="M532 204V146M558 204V158" stroke="#090d11" stroke-width="3"/>' +
      '<path d="M534 150L554 174L534 196Z" fill="#2a3640"/><path d="M560 162L574 180L560 198Z" fill="#2a3640"/><path d="M512 204L532 156M590 204L558 162" stroke="#090d11" stroke-width="1.2"/></g>';
    s += '<g class="tt-wave" style="--w:-84px;animation-duration:4.2s;animation-delay:-2s"><path d="' + wave(222, 7, 84) + '" fill="#111c24"/>' +
      '<path d="M96 222q12 -6 24 0M348 223q12 -6 24 0M600 222q12 -6 24 0M852 223q12 -6 24 0" stroke="#a9bfd0" stroke-width="1.5" fill="none" opacity=".4"/></g>';
    s += '<g class="tt-wave" style="--w:-112px;animation-duration:3.4s"><path d="' + wave(252, 9, 112) + '" fill="#0b1319"/>' +
      '<path d="M40 252q16 -8 32 0M376 252q16 -8 32 0M712 252q16 -8 32 0" stroke="#a9bfd0" stroke-width="1.5" fill="none" opacity=".3"/></g>';
    const rain = (n, len, op, cls) => {
      let d = '';
      for (let i = 0; i < n; i++) {
        const x = -40 + R() * 940, y = R() * 300, seg = 'l' + f1(-len * 0.2) + ' ' + len;
        d += 'M' + f1(x) + ' ' + f1(y) + seg + 'M' + f1(x + 60) + ' ' + f1(y - 300) + seg;
      }
      return '<g class="' + cls + '"><path d="' + d + '" stroke="#a9bfd0" stroke-width="1.2" stroke-linecap="round" opacity="' + op + '" fill="none"/></g>';
    };
    s += rain(50, 13, 0.3, 'tt-rain far') + rain(36, 24, 0.45, 'tt-rain');
    return [defs, s];
  }

  function camp() {
    const R = rng(3);
    const defs = lin('tt-cp-sky', [[0, '#0a0f17'], [1, '#1b2733']]) + rad('tt-cp-fire', '#f0a040', 0.6) + rad('tt-cp-moon', '#e8ead8', 0.3);
    let s = '<rect width="800" height="300" fill="url(#tt-cp-sky)"/>' + stars(R, 80, 176, '#ece6d0');
    s += '<circle cx="645" cy="52" r="52" fill="url(#tt-cp-moon)"/><path d="M650 36A18 18 0 1 0 654.7 64.7A16 16 0 0 1 650 36Z" fill="#ece6d0"/>';
    s += '<path d="M0 194Q120 158 260 182T520 174T800 188V300H0Z" fill="#121b23"/>';
    let d = '';
    for (let x = -10; x < 830; x += 17 + R() * 15) d += fir(x, 208, 26 + R() * 36, 18 + R() * 8);
    s += '<path d="' + d + '" fill="#0b1217"/>';
    s += '<path d="M0 206Q400 192 800 206V300H0Z" fill="#10181c"/>';
    s += glow('tt-cp-fire', 400, 186, 250, 150, 0) + pool(400, 226, 220, 30, '#e0813a', 0.14, 0);
    const tent = (x, flip) => {
      const m = flip ? -1 : 1, X = (dx) => x + dx * m;
      return '<path d="M' + X(-80) + ' 214L' + X(0) + ' 122L' + X(80) + ' 214Z" fill="#22262a"/><path d="M' + X(0) + ' 122L' + X(80) + ' 214H' + X(22) + 'Z" fill="#6a5236"/>' +
        '<path d="M' + X(0) + ' 152L' + X(22) + ' 214H' + X(-12) + 'Z" fill="#090b0c"/><path d="M' + X(0) + ' 122L' + X(-5) + ' 110M' + X(0) + ' 122L' + X(5) + ' 110" stroke="#22262a" stroke-width="2"/>' +
        '<path d="M' + X(-80) + ' 214L' + X(-96) + ' 220M' + X(80) + ' 214L' + X(96) + ' 220" stroke="#3a3f42" stroke-width="1.5"/>';
    };
    s += tent(240, false) + tent(566, true);
    // the fire
    s += '<ellipse cx="400" cy="212" rx="32" ry="7" fill="#090b0c"/>';
    for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; s += '<ellipse cx="' + f1(400 + Math.cos(a) * 30) + '" cy="' + f1(212 + Math.sin(a) * 6.5) + '" rx="6" ry="4" fill="#50575b"/>'; }
    s += '<rect x="378" y="204" width="44" height="7" rx="3.5" fill="#3a2414" transform="rotate(13 400 208)"/><rect x="378" y="204" width="44" height="7" rx="3.5" fill="#2b1a10" transform="rotate(-13 400 208)"/>';
    s += flame(390, 209, 1.05, 0) + flame(401, 208, 1.6, 1) + flame(411, 209, 0.95, 2);
    for (let i = 0; i < 7; i++) {
      s += '<circle class="tt-spark" style="--dx:' + f1(-14 + R() * 28) + 'px;animation-delay:' + f1(-R() * 2.6) + 's;animation-duration:' + f1(1.8 + R() * 1.4) + 's" cx="' + f1(392 + R() * 18) + '" cy="' + f1(160 + R() * 14) + '" r="1.5" fill="#f6cf75"/>';
    }
    // seats and a bedroll
    s += '<rect x="300" y="222" width="64" height="13" rx="6.5" fill="#35251a"/><ellipse cx="364" cy="228.5" rx="4" ry="6.5" fill="#5a4030"/>' +
      '<rect x="446" y="224" width="62" height="12" rx="6" fill="#3d4a3c"/><rect x="498" y="224" width="12" height="12" rx="6" fill="#586853"/>';
    s += '<path d="M0 270Q300 252 520 266T800 256V300H0Z" fill="#0b1114"/>';
    return [defs, s];
  }

  const BACKDROPS = { tavern: tavern, town: town, forest: forest, cave: cave, dungeon: dungeon, crypt: crypt, mountain: mountain, storm: storm, camp: camp };
  function backdropSvg(name) {
    const r = (BACKDROPS[name] || dungeon)();
    return '<svg viewBox="0 0 800 300" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false"><defs>' + r[0] + '</defs>' + r[1] + '</svg>';
  }

  // The battle mat: a perspective grid laid over the backdrop.
  function matSvg() {
    const vy = -230, top = 44, bot = 300, span = (y) => 760 * (y - vy) / (bot - vy);
    let d = '';
    for (let k = -9; k <= 9; k++) { const xb = 400 + k * 84, xt = 400 + (xb - 400) * (top - vy) / (bot - vy); d += 'M' + f1(xt) + ' ' + top + 'L' + xb + ' ' + bot; }
    [44, 66, 92, 124, 164, 214, 272].forEach((y) => { const h = span(y); d += 'M' + f1(400 - h) + ' ' + y + 'H' + f1(400 + h); });
    const t = span(top);
    return '<svg viewBox="0 0 800 300" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">' +
      '<defs><linearGradient id="tt-mat-f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0a0d0f" stop-opacity=".25"/><stop offset="1" stop-color="#0a0d0f" stop-opacity=".5"/></linearGradient></defs>' +
      '<path d="M' + f1(400 - t) + ' ' + top + 'H' + f1(400 + t) + 'L1160 300H-360Z" fill="url(#tt-mat-f)"/>' +
      '<path d="' + d + '" stroke="#ebe4d2" stroke-opacity=".13" stroke-width="1.2" fill="none"/>' +
      '<path d="M' + f1(400 - t) + ' ' + top + 'H' + f1(400 + t) + '" stroke="#d1a94f" stroke-opacity=".4" stroke-width="1.5"/>' +
      '<path d="M' + f1(400 - span(143)) + ' 143H' + f1(400 + span(143)) + '" stroke="#c8493d" stroke-opacity=".4" stroke-width="1.5" stroke-dasharray="10 8"/></svg>';
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
    Fighter: { face: '#a3463a', fg: '#f6eedb' },
    Wizard: { face: '#4f62bd', fg: '#f6eedb' },
    Rogue: { face: '#3b8361', fg: '#f6eedb' },
    Cleric: { face: '#ddd3b4', fg: '#7a5712' },
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
    let s = '<ellipse cx="32" cy="61" rx="21" ry="3.6" fill="#000" opacity=".5"/>';
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
    return tokenSvg({ face: a.face, rim: '#8d9aa0', glyph: (GLYPH[cls] || GLYPH.hero)(a.fg) });
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
  function npcArt(mood) {
    return tokenSvg({ face: '#2c363d', rim: '#56646c', glyph: GLYPH.npc('#e6dfcc'), mood: MOOD[mood] || MOOD.neutral });
  }

  const DIE_SVG = '<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">' +
    '<polygon points="50,3 91,26.5 91,73.5 50,97 9,73.5 9,26.5" fill="#0b0e10" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/>' +
    [['50,25 76,68 24,68', 0.96], ['9,26.5 50,3 50,25', 0.56], ['50,3 91,26.5 50,25', 0.72], ['9,26.5 50,25 24,68', 0.66], ['91,26.5 76,68 50,25', 0.82], ['9,26.5 24,68 9,73.5', 0.4],
      ['91,26.5 91,73.5 76,68', 0.52], ['9,73.5 24,68 50,97', 0.3], ['91,73.5 50,97 76,68', 0.4], ['24,68 76,68 50,97', 0.48]]
      .map((f) => '<polygon points="' + f[0] + '" fill="currentColor" fill-opacity="' + f[1] + '"/>').join('') +
    '<path d="M50 3V25M9 26.5L50 25L91 26.5M9 26.5L24 68L9 73.5M91 26.5L76 68L91 73.5M24 68H76M24 68L50 97L76 68M50 25L24 68M50 25L76 68" fill="none" stroke="#0b0e10" stroke-width="1.6" stroke-linejoin="round" stroke-opacity=".85"/>' +
    '<text class="tt-die-n" x="50" y="62.5" text-anchor="middle">20</text></svg>';

  // ------------------------------------------------------------------ state and DOM

  const S = {
    room: null, me: null, code: null, prev: null,
    amb: null, shownAmb: null, battle: false, visible: false,
    sel: { foe: null, ally: null }, audio: { playing: null, seg: null },
    heroIds: [], foeIds: [], npcKeys: [], layoutSig: '',
  };
  const tokens = new Map();
  let stage = null, elBg = null, elLoc = null, elRound = null, elPlaque = null, elTokens = null, elFx = null, elDie = null, elDieN = null, elDieCap = null;
  let plaque = null, box = null, layoutRaf = 0, selRaf = 0, obsFoes = null, obsParty = null, dieTimers = [], subscribed = false, audioSub = false;

  const el = (tag, cls) => { const n = doc.createElement(tag); if (cls) n.className = cls; return n; };
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);
  const reduced = () => { try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; } };
  const raf = (fn) => (window.requestAnimationFrame ? window.requestAnimationFrame(fn) : setTimeout(fn, 16));
  const selEsc = (v) => String(v).replace(/["\\]/g, '\\$&');

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
    stage.setAttribute('aria-label', 'Tabletop');
    stage.hidden = true;
    elBg = el('div', 'tt-bg');
    const mat = el('div', 'tt-mat');
    mat.innerHTML = matSvg();
    const shade = el('div', 'tt-shade');
    elTokens = el('div', 'tt-tokens');
    elLoc = el('div', 'tt-loc');
    elRound = el('div', 'tt-round');
    elRound.hidden = true;
    elPlaque = el('div', 'tt-plaque');
    elPlaque.hidden = true;
    plaque = { name: el('b'), hp: el('span', 'v'), atk: el('span'), def: el('span') };
    elPlaque.appendChild(el('i'));
    [plaque.name, plaque.hp, plaque.atk, plaque.def].forEach((n) => elPlaque.appendChild(n));
    elFx = el('div', 'tt-fx');
    elDie = el('div', 'tt-die');
    elDie.hidden = true;
    elDie.innerHTML = DIE_SVG;
    elDieN = elDie.querySelector('.tt-die-n');
    elDieCap = el('span', 'tt-die-cap');
    elDie.appendChild(elDieCap);
    [elBg, mat, shade, elTokens, elLoc, elRound, elPlaque, elFx, elDie].forEach((n) => stage.appendChild(n));
    if (typeof window.ResizeObserver === 'function') new window.ResizeObserver(() => queueLayout(true)).observe(stage);
    else window.addEventListener('resize', () => queueLayout(true));
  }

  // Put the stage right after #sceneBox's first child. Returns false while there is no #sceneBox.
  function mount() {
    const b = doc.getElementById('sceneBox');
    if (!b) return false;
    if (!stage) { injectStyle(); build(); }
    if (stage.parentNode !== b || (b.firstElementChild && b.firstElementChild !== stage && b.firstElementChild.nextElementSibling !== stage)) {
      const first = b.firstElementChild === stage ? null : b.firstElementChild;
      if (first) first.insertAdjacentElement('afterend', stage); else b.insertBefore(stage, b.firstChild);
    }
    box = b;
    watchSelection();
    return true;
  }

  function hide() {
    S.visible = false;
    if (stage) stage.hidden = true;
    if (box) box.classList.remove('tt-battle-on');
  }

  function setBackdrop(name) {
    S.shownAmb = name;
    const layer = el('div', 'tt-layer');
    layer.innerHTML = backdropSvg(name);
    const old = Array.prototype.slice.call(elBg.children);
    elBg.appendChild(layer);
    stage.setAttribute('data-ambience', name);
    if (!old.length || reduced()) {
      layer.classList.add('on');
      old.forEach((o) => o.remove());
      return;
    }
    void layer.offsetWidth;
    layer.classList.add('on');
    setTimeout(() => { old.forEach((o) => o.remove()); }, 1000);
  }

  // ------------------------------------------------------------------ tokens

  function makeToken(kind, id) {
    const node = el(kind === 'npc' ? 'div' : 'button', 'tk tk-' + kind + ' tk-in');
    if (kind === 'npc') node.setAttribute('role', 'img'); else node.type = 'button';
    const shk = el('span', 'tk-shk'), body = el('span', 'tk-body'), tag = el('span', 'tk-tag'), name = el('span', 'tk-name');
    shk.appendChild(body);
    node.appendChild(shk); node.appendChild(tag); node.appendChild(name);
    const t = { kind: kind, id: id, el: node, body: body, name: name, tag: tag, hp: null, c: {}, x: -1, y: -1, size: 0, floats: 0, gone: false };
    if (kind === 'foe') node.addEventListener('click', () => proxyClick('foe-' + id));
    if (kind === 'hero') node.addEventListener('click', () => proxyClick('pc-' + id));
    elTokens.appendChild(node);
    setTimeout(() => node.classList.remove('tk-in'), 600);
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
  function dropToken(key) {
    const t = tokens.get(key);
    if (!t) return;
    tokens.delete(key);
    t.gone = true;
    t.el.classList.add('tk-out');
    if (t.el.tagName === 'BUTTON') t.el.disabled = true;
    setTimeout(() => t.el.remove(), 380);
  }

  function speakers(room) {
    const log = Array.isArray(room.log) ? room.log : [];
    for (let i = log.length - 1; i >= 0; i--) {
      const e = log[i];
      if (!e || e.k !== 'dm') continue;
      const out = [];
      (Array.isArray(e.segs) ? e.segs : []).forEach((sg) => {
        const n = sg && typeof sg.speaker === 'string' ? sg.speaker.trim() : '';
        if (!n || n.toLowerCase() === 'narrator') return;
        if (!out.some((o) => o.toLowerCase() === n.toLowerCase())) out.push(n);
      });
      return out.slice(0, 3);
    }
    return [];
  }
  function moodOf(room, name) {
    const list = room.story && Array.isArray(room.story.npcs) ? room.story.npcs : [];
    const n = name.toLowerCase();
    const hit = list.find((x) => x && typeof x.name === 'string' && x.name.toLowerCase() === n) ||
      list.find((x) => x && typeof x.name === 'string' && x.name && (n.indexOf(x.name.toLowerCase()) >= 0 || x.name.toLowerCase().indexOf(n) >= 0));
    return hit && MOOD[hit.mood] ? hit.mood : 'neutral';
  }
  const isDown = (p) => p.alive === false || (typeof p.hp === 'number' && p.hp <= 0);

  function syncTokens(room) {
    const want = new Set();
    const players = room.players && typeof room.players === 'object' ? room.players : {};
    const order = Array.isArray(room.order) ? room.order : Object.keys(players);
    const combat = room.combat && typeof room.combat === 'object' ? room.combat : null;
    const turn = S.battle && combat ? combat.turn : null;

    S.heroIds = order.filter((id) => players[id] && players[id].cls).slice(0, 6);
    S.heroIds.forEach((id) => {
      const p = players[id], key = 'h:' + id;
      want.add(key);
      let t = tokens.get(key);
      if (!t) { t = makeToken('hero', id); tokens.set(key, t); }
      const down = isDown(p), me = id === S.me, acting = turn === id && !down;
      setArt(t, String(p.cls), heroArt(p.cls));
      put(t, 'name', String(p.name || 'Hero'), (v) => { t.name.textContent = v; });
      setHp(t, num(p.hp), num(p.maxHp));
      flag(t, 'is-me', me); flag(t, 'is-down', down); flag(t, 'is-off', p.online === false); flag(t, 'is-turn', acting);
      put(t, 'tag', acting ? (me ? 'Your turn' : 'Turn') : '', (v) => { t.tag.textContent = v; });
      put(t, 'label', (p.name || 'Hero') + ', ' + p.cls + (p.level ? ' level ' + p.level : '') + ', HP ' + num(p.hp) + ' of ' + num(p.maxHp) + (me ? ', your character' : '') +
        (down ? ', down' : '') + (p.online === false ? ', offline' : '') + (acting ? ', acting now' : ''), (v) => { t.el.setAttribute('aria-label', v); });
    });

    S.foeIds = [];
    if (S.battle) {
      combat.enemies.forEach((e) => {
        if (!e || e.id == null) return;
        const id = String(e.id), key = 'e:' + id;
        if (want.has(key)) return;
        want.add(key);
        S.foeIds.push(id);
        let t = tokens.get(key);
        if (!t) { t = makeToken('foe', id); tokens.set(key, t); }
        const dead = e.alive === false || num(e.hp) <= 0, type = foeType(e);
        t.boss = !!e.boss;
        setArt(t, type + (e.boss ? '!' : ''), foeArt(type, !!e.boss));
        put(t, 'name', String(e.name || e.type || 'Enemy'), (v) => { t.name.textContent = v; });
        setHp(t, num(e.hp), num(e.maxHp));
        flag(t, 'is-dead', dead); flag(t, 'is-boss', !!e.boss);
        put(t, 'dis', dead, (v) => { t.el.disabled = v; });
        t.c.base = (e.name || e.type || 'Enemy') + (e.boss ? ', boss' : '') + (dead ? ', defeated' : ', HP ' + num(e.hp) + ' of ' + num(e.maxHp));
      });
    }

    S.npcKeys = [];
    if (!S.battle) {
      speakers(room).forEach((name) => {
        const key = 'n:' + name.toLowerCase();
        want.add(key);
        S.npcKeys.push(key);
        let t = tokens.get(key);
        if (!t) { t = makeToken('npc', name); tokens.set(key, t); }
        const mood = moodOf(room, name);
        setArt(t, mood, npcArt(mood));
        put(t, 'name', name, (v) => { t.name.textContent = v; });
        put(t, 'label', name + ', ' + mood, (v) => { t.el.setAttribute('aria-label', v); });
      });
    }
    Array.from(tokens.keys()).forEach((key) => { if (!want.has(key)) dropToken(key); });
  }

  // ------------------------------------------------------------------ layout

  function queueLayout(force) {
    if (force) S.layoutSig = '';
    if (layoutRaf) return;
    layoutRaf = raf(() => { layoutRaf = 0; layout(); });
  }
  function place(t, x, y, size, nameW, z) {
    if (!t) return;
    x = Math.round(x); y = Math.round(y);
    t.W = stage.clientWidth;
    if (t.x !== x || t.y !== y) { t.el.style.left = x + 'px'; t.el.style.top = y + 'px'; t.x = x; t.y = y; }
    if (t.size !== size) { t.el.style.setProperty('--tk', size + 'px'); t.size = size; }
    put(t, 'nm', Math.round(nameW), (v) => { t.el.style.setProperty('--nm', v + 'px'); });
    put(t, 'tg', x < 44 ? 44 - x : x > t.W - 44 ? t.W - 44 - x : 0, (v) => { t.el.style.setProperty('--tg', v + 'px'); });
    put(t, 'z', z, (v) => { t.el.style.zIndex = v; });
  }
  function layout() {
    if (!stage || stage.hidden) return;
    const W = stage.clientWidth, H = stage.clientHeight;
    if (!W || !H) return;
    const battle = S.battle, heroes = S.heroIds, foes = S.foeIds, npcs = S.npcKeys;
    const sig = W + 'x' + H + '|' + (battle ? 1 : 0) + '|' + heroes.join(',') + '|' + foes.map((id) => id + (tokens.get('e:' + id) && tokens.get('e:' + id).boss ? '!' : '')).join(',') + '|' + npcs.join(',');
    if (sig === S.layoutSig) return;
    S.layoutSig = sig;

    const small = W < 480;
    stage.classList.toggle('sm', small);
    const topPad = 30, nameH = small ? 15 : 17, hud = battle ? 26 : 0, gap = 5;
    let foeRows = 1, perRow = foes.length;
    if (battle) {
      const maxPer = Math.max(2, Math.floor(W / 82));
      if (foes.length > maxPer) { foeRows = 2; perRow = Math.ceil(foes.length / 2); }
    }
    const rows = battle ? foeRows + 1 : 2;
    const cols = Math.max(1, heroes.length, battle ? perRow + (foeRows > 1 ? 0.5 : 0) : npcs.length);
    let tk = (H - topPad - hud - rows * nameH - (rows + 1) * gap) / rows;
    tk = Math.max(40, Math.floor(Math.min(tk, W / (cols * 1.3), W * 0.16, 60)));
    const maxSp = tk * 2.3;
    const nameW = (sp, x) => Math.max(34, Math.min(sp - 8, 2 * Math.min(x, W - x) - 8, 132));

    // heroes along the bottom
    const heroY = H - hud - (battle ? 5 : 9) - nameH - tk / 2;
    const hsp = Math.min(W / Math.max(1, heroes.length), maxSp);
    heroes.forEach((id, i) => {
      const x = W / 2 + (i - (heroes.length - 1) / 2) * hsp;
      place(tokens.get('h:' + id), x, heroY, tk, nameW(hsp, x), 3);
    });
    const heroTop = heroY - tk / 2;

    const tok = (id) => tokens.get('e:' + id);
    stage.classList.toggle('rows2', battle && foeRows === 2);
    if (battle) {
      if (foeRows === 1) {
        const sp = Math.min(W / Math.max(1, foes.length), maxSp);
        const boss = foes.some((id) => tok(id) && tok(id).boss);
        const cy = topPad + Math.max(0, heroTop - 10 - topPad - (tk + nameH)) * (boss ? 0.55 : 0.3) + tk / 2;
        foes.forEach((id, i) => {
          const t = tok(id), x = W / 2 + (i - (foes.length - 1) / 2) * sp;
          place(t, x, cy, t && t.boss ? Math.round(tk * 1.3) : tk, nameW(sp, x), 2);
        });
      } else {
        // Two staggered ranks. A boss stands in the middle of the back rank, where its crown has room.
        const list = foes.slice(), nA = perRow, nB = list.length - perRow, mid = Math.floor((nA - 1) / 2);
        const bi = list.findIndex((id) => tok(id) && tok(id).boss);
        if (bi >= 0 && bi !== mid) list.splice(mid, 0, list.splice(bi, 1)[0]);
        const even = nA === nB;
        const sp = Math.min(W / (nA + (even ? 0.5 : 0)), maxSp);
        const free = Math.max(0, heroTop - 8 - topPad - 2 * (tk + nameH) - gap);
        list.forEach((id, i) => {
          const r = i < nA ? 0 : 1, n = r === 0 ? nA : nB, j = r === 0 ? i : i - nA;
          const t = tok(id), x = W / 2 + (j - (n - 1) / 2) * sp + (even ? (r === 0 ? -1 : 1) * sp / 4 : 0);
          const cy = topPad + free * 0.3 + tk / 2 + r * (tk + nameH + gap);
          place(t, x, cy, t && t.boss ? Math.round(tk * 1.14) : tk, nameW(sp, x), 1 + r);
        });
      }
    } else {
      const sp = Math.min(W / Math.max(1, npcs.length), tk * 2.7);
      const cy = topPad + Math.max(0, heroTop - 10 - topPad - (tk + nameH)) * 0.36 + tk / 2;
      npcs.forEach((key, i) => {
        const x = W / 2 + (i - (npcs.length - 1) / 2) * sp;
        place(tokens.get(key), x, cy, tk, nameW(sp, x), 2);
      });
    }
  }

  // ------------------------------------------------------------------ targeting (through the app's own buttons)

  function findStub(k) {
    try { return doc.querySelector('[data-k="' + selEsc(k) + '"]'); } catch (e) { return null; }
  }
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
    if (foes && (!obsFoes || obsFoes.node !== foes)) {
      if (obsFoes) obsFoes.mo.disconnect();
      obsFoes = { node: foes, mo: new window.MutationObserver(queueSel) };
      obsFoes.mo.observe(foes, opts);
    }
    if (party && (!obsParty || obsParty.node !== party)) {
      if (obsParty) obsParty.mo.disconnect();
      obsParty = { node: party, mo: new window.MutationObserver(queueSel) };
      obsParty.mo.observe(party, opts);
    }
  }
  function statOf(e, name) {
    try {
      const fn = window.Engine && window.Engine[name === 'atk' ? 'atkOf' : 'defOf'];
      if (typeof fn === 'function') { const v = fn(e); if (typeof v === 'number' && isFinite(v)) return v; }
    } catch (err) { /* fall back to the raw stat */ }
    return num(e[name]);
  }
  function syncSel() {
    if (!stage) return;
    const sel = readSel();
    S.sel = sel;
    const room = S.room;
    tokens.forEach((t) => {
      if (t.kind === 'foe') {
        const on = S.battle && sel.foe === t.id && !t.c.dis;
        flag(t, 'is-target', on);
        put(t, 'pressed', on, (v) => t.el.setAttribute('aria-pressed', String(v)));
        put(t, 'label', (t.c.base || '') + (on ? ', targeted' : ''), (v) => t.el.setAttribute('aria-label', v));
      } else if (t.kind === 'hero') {
        const on = sel.ally === t.id;
        flag(t, 'is-ally', on);
        put(t, 'pressed', on, (v) => t.el.setAttribute('aria-pressed', String(v)));
      }
    });
    // the plaque
    const enemies = S.battle && room && room.combat ? room.combat.enemies : null;
    if (!enemies) { elPlaque.hidden = true; return; }
    const e = enemies.find((x) => x && String(x.id) === sel.foe && x.alive !== false);
    elPlaque.hidden = false;
    elPlaque.classList.toggle('idle', !e);
    if (!e) {
      const left = enemies.some((x) => x && x.alive !== false);
      plaque.name.textContent = left ? 'Choose a target' : 'The field is clear';
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

  // ------------------------------------------------------------------ narration highlight

  function syncSpeaking() {
    let key = null;
    const a = S.audio || {}, room = S.room;
    if (room && a.playing != null && a.seg != null && Array.isArray(room.log)) {
      const e = room.log.find((x) => x && x.id === a.playing);
      const sg = e && Array.isArray(e.segs) ? e.segs[a.seg] : null;
      const n = sg && typeof sg.speaker === 'string' ? sg.speaker.trim().toLowerCase() : '';
      if (n && n !== 'narrator') key = 'n:' + n;
    }
    tokens.forEach((t, k) => { if (t.kind === 'npc') flag(t, 'is-speaking', k === key); });
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
  function floatText(t, text, cls) {
    if (!t || t.gone || !elFx || t.x < 0) return;
    const n = el('span', 'tt-float ' + cls);
    n.textContent = text;
    const W = stage.clientWidth || 0;
    n.style.left = Math.max(26, Math.min(W - 26, t.x)) + 'px';
    const delay = t.floats * 140;
    n.style.top = Math.max(26, t.y - t.size / 2 + 4 - (t.c['f:is-turn'] ? 12 : 0) - t.floats * 25) + 'px';
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
    if (d < 0) { shake(t); floatText(t, '-' + (-d), 'dmg'); }
    else if (d > 0) floatText(t, '+' + d, 'heal');
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
    // the newest dice roll
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

  function apply(room, me) {
    hook();
    if (!room || typeof room !== 'object') {
      S.room = null; S.prev = null; S.code = null; S.amb = null;
      hide();
      return;
    }
    S.room = room;
    if (me != null) S.me = me; else if (S.me == null && window.Net && window.Net.me) S.me = window.Net.me;
    if (room.code !== S.code) { S.code = room.code; S.prev = null; S.amb = null; }
    if (room.phase === 'lobby' || !room.phase) {
      hide();
      S.prev = snap(room);
      return;
    }
    if (!mount()) return;                      // no #sceneBox yet: try again on the next update

    const scene = room.scene && typeof room.scene === 'object' ? room.scene : {};
    if (BACKDROPS[scene.ambience]) S.amb = scene.ambience;   // 'combat', 'none' and unknown names keep the last backdrop
    if (!S.amb) S.amb = 'dungeon';
    if (S.amb !== S.shownAmb) setBackdrop(S.amb);

    const combat = room.combat && typeof room.combat === 'object' && Array.isArray(room.combat.enemies) ? room.combat : null;
    const battle = room.phase === 'combat' && !!combat && combat.enemies.length > 0;
    if (battle !== S.battle) { S.battle = battle; stage.classList.toggle('battle', battle); }
    box.classList.toggle('tt-battle-on', battle);
    if (stage.hidden) { stage.hidden = false; S.layoutSig = ''; }
    S.visible = true;

    const loc = typeof scene.location === 'string' ? scene.location : '';
    if (elLoc.textContent !== loc) elLoc.textContent = loc;
    elLoc.hidden = !loc;
    elRound.hidden = !battle;
    if (battle) { const r = 'Round ' + (num(combat.round) || 1); if (elRound.textContent !== r) elRound.textContent = r; }
    const label = 'Tabletop: ' + (loc || 'the scene') + (battle ? ', battle' : '');
    if (stage.getAttribute('aria-label') !== label) stage.setAttribute('aria-label', label);

    syncTokens(room);
    layout();
    syncSel();
    syncSpeaking();

    const cur = snap(room);
    if (S.prev) effects(room, S.prev, cur);
    S.prev = cur;
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
    version: 1,
    update: update,
    refresh: function () { try { S.layoutSig = ''; layout(); syncSel(); } catch (e) { /* ignore */ } },
    roll: function (value, pass, who) { try { if (stage && !stage.hidden) rollDie(value, pass, who); } catch (e) { /* ignore */ } },
    ambiences: Object.keys(BACKDROPS),
  };

  injectStyle();
  if (!hook()) {
    doc.addEventListener('DOMContentLoaded', hook);
    window.addEventListener('load', hook);
  }
})();
