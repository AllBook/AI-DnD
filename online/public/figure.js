/* AI-DnD Online: procedural character figures.
 *
 * One classic script, no dependencies, no image files. window.CharacterFigure paints the hero a
 * player made (race, body, colours, hair, beard, marks, class costume and equipped gear) as a flat,
 * painterly SVG illustration:
 *
 *   CharacterFigure.svg(player, opts)     -> SVGElement
 *   CharacterFigure.dataUrl(player, opts) -> 'data:image/svg+xml,...' (for <img>, canvas or <image>)
 *   CharacterFigure.markup(player, opts)  -> the same picture as an SVG string
 *   CharacterFigure.version               -> bumped whenever the art changes
 *
 *   player: { race, cls, look, eq, name }  (missing fields fall back to defaults; a player with no
 *           eq at all is shown with the class's starting gear)
 *   opts:   { view: 'full' | 'bust' | 'token', size: px (height for full/bust, diameter for token),
 *             pose: 'idle' | 'ready' | 'down', facing: 'right' | 'left', animate: boolean,
 *             frame: 'round' | 'shield' (bust only), rim: false (token without its own rim, for
 *             callers that draw their own ring) }
 *
 * Pure and deterministic: the same input always gives the same picture (ids inside the SVG come
 * from a hash of the input, so two different figures on one page never share a clip path). The
 * player name is never drawn. The picture is built as a small node tree first, so markup() and
 * dataUrl() work without a DOM (and in Node).
 */
(function (root) {
  'use strict';
  if (root && root.CharacterFigure) return;

  const VERSION = 1;
  const SVGNS = 'http://www.w3.org/2000/svg';
  const CX = 100, GY = 290, VW = 200, VH = 300;
  const OL = '#1b1411';

  // ------------------------------------------------------------------ data

  const LISTS = {
    body: ['slender', 'average', 'broad'], frame: ['feminine', 'masculine', 'neutral'],
    hairStyle: ['bald', 'short', 'cropped', 'long', 'braid', 'topknot', 'mohawk', 'curly', 'ponytail', 'hood'],
    beard: ['none', 'stubble', 'short', 'long', 'braided'],
    mark: ['none', 'scar', 'tattoo', 'freckles', 'warpaint', 'horns-small', 'eyepatch'],
  };
  const DEF = { body: 'average', frame: 'neutral', skin: '#e0ac85', hair: '#141011', eyes: '#3b2a1e', outfit: '#7a2e2e', accent: '#d1a94f', hairStyle: 'short', beard: 'none', mark: 'none' };

  // H: height crown to sole, head: crown to chin, hwf: head width / height, legF: share of the body below the shoulders
  const RACE = {
    Human: { H: 222, head: 44, hwf: 0.8, neck: 7, legF: 0.58, sw: 30, ww: 21, hp: 23, limb: 1 },
    Elf: { H: 240, head: 42, hwf: 0.74, neck: 9, legF: 0.6, sw: 27, ww: 18, hp: 21, limb: 0.86 },
    Dwarf: { H: 168, head: 44, hwf: 0.9, neck: 2, legF: 0.42, sw: 36, ww: 31, hp: 30, limb: 1.25 },
    Halfling: { H: 146, head: 40, hwf: 0.86, neck: 3, legF: 0.48, sw: 23, ww: 19, hp: 21, limb: 0.95 },
    'Half-Orc': { H: 232, head: 45, hwf: 0.88, neck: 6, legF: 0.56, sw: 36, ww: 27, hp: 27, limb: 1.2 },
    Tiefling: { H: 224, head: 44, hwf: 0.8, neck: 7, legF: 0.58, sw: 30, ww: 21, hp: 23, limb: 1 },
    Dragonborn: { H: 236, head: 46, hwf: 0.84, neck: 10, legF: 0.56, sw: 35, ww: 26, hp: 26, limb: 1.15 },
    Gnome: { H: 140, head: 41, hwf: 0.92, neck: 2, legF: 0.46, sw: 21, ww: 18, hp: 19, limb: 0.9 },
  };
  const FRAME = {
    feminine: { sw: 0.82, ww: 0.72, hp: 1.1, limb: 0.86 },
    masculine: { sw: 1.12, ww: 1.02, hp: 0.9, limb: 1.1 },
    neutral: { sw: 0.97, ww: 0.9, hp: 0.98, limb: 1 },
  };
  const BODY = {
    slender: { w: 0.86, waist: 0.84, hip: 0.88, limb: 0.84, head: 0.97 },
    average: { w: 1, waist: 1, hip: 1, limb: 1, head: 1 },
    broad: { w: 1.16, waist: 1.32, hip: 1.18, limb: 1.22, head: 1.04 },
  };
  // starting gear (mirrors Engine.CLASSES[*].equip) for players shown before they have an eq
  const CLASS_EQ = {
    Fighter: { weapon: 'longsword', armor: 'chainmail' }, Wizard: { weapon: 'quarterstaff' },
    Rogue: { weapon: 'dagger', armor: 'leather_armor' }, Cleric: { weapon: 'mace' },
    Barbarian: { weapon: 'greataxe', armor: 'leather_armor' }, Paladin: { weapon: 'longsword', armor: 'chainmail', offhand: 'buckler' },
    Ranger: { weapon: 'longbow', armor: 'leather_armor' }, Bard: { weapon: 'rapier', armor: 'leather_armor' },
    Warlock: { weapon: 'dagger', armor: 'leather_armor' }, Druid: { weapon: 'sickle', armor: 'leather_armor' },
    Monk: { weapon: 'hand_wraps' }, Sorcerer: { weapon: 'dagger' },
  };
  const WEAPON = {
    longsword: 'sword', iron_sword: 'sword', steel_longsword: 'sword', enchanted_blade: 'sword',
    dagger: 'dagger', rusty_dagger: 'dagger', mace: 'mace', quarterstaff: 'staff', greataxe: 'greataxe',
    longbow: 'bow', rapier: 'rapier', hand_wraps: 'wraps', sickle: 'sickle',
  };
  const SPARK = { '#d1a94f': '#ffd36b', '#c0c0c0': '#a8e1ff', '#b87333': '#ff9a4a', '#2f2f2f': '#c58bff', '#e8e0d0': '#fff1c9' };

  // ------------------------------------------------------------------ small helpers

  const own = (o, k) => o != null && typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);
  const f1 = (n) => Math.round(n * 10) / 10;
  function D(s) { let out = s[0]; for (let i = 1; i < arguments.length; i++) { const v = arguments[i]; out += (typeof v === 'number' ? f1(v) : v) + s[i]; } return out; }
  function rgb(h) { const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); if (!m) return [128, 128, 128]; const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function hex(c) { return '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join(''); }
  function mix(a, b, t) { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v + (y[i] - v) * t)); }
  const shade = (c, t) => mix(c, '#22141e', t == null ? 0.3 : t);
  const lite = (c, t) => mix(c, '#fff4de', t == null ? 0.2 : t);
  function lum(c) { const x = rgb(c); return (0.299 * x[0] + 0.587 * x[1] + 0.114 * x[2]) / 255; }
  function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
  const rad = (deg) => deg * Math.PI / 180;

  // node tree: {t, a, k} or {text}
  function N(t, a, k) { return { t: t, a: a || {}, k: k || [] }; }
  const G = (k, a) => N('g', a, k.filter(Boolean));
  function Ctx(prefix, lw) { this.p = prefix; this.n = 0; this.defs = []; this.lw = lw; }
  Ctx.prototype.id = function (tag) { return this.p + tag + (this.n++).toString(36); };

  function P(c, d, fill, o) { return N('path', Object.assign({ d: d, fill: fill, stroke: OL, 'stroke-width': c.lw, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, o)); }
  function F(d, fill, o) { return N('path', Object.assign({ d: d, fill: fill }, o)); }
  function S(d, stroke, w, o) { return N('path', Object.assign({ d: d, fill: 'none', stroke: stroke, 'stroke-width': w, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, o)); }
  function Ci(c, x, y, r, fill, o) { return N('circle', Object.assign({ cx: f1(x), cy: f1(y), r: f1(r), fill: fill, stroke: OL, 'stroke-width': c.lw }, o)); }
  function Cf(x, y, r, fill, o) { return N('circle', Object.assign({ cx: f1(x), cy: f1(y), r: f1(r), fill: fill }, o)); }
  function Ef(x, y, rx, ry, fill, o) { return N('ellipse', Object.assign({ cx: f1(x), cy: f1(y), rx: f1(rx), ry: f1(ry), fill: fill }, o)); }
  // a filled shape with cel shading clipped inside it and a clean outline on top
  function shaded(c, d, fill, shades, o) {
    const id = c.id('k');
    c.defs.push(N('clipPath', { id: id }, [N('path', { d: d })]));
    return N('g', o || {}, [F(d, fill), N('g', { 'clip-path': 'url(#' + id + ')' }, shades.filter(Boolean)), N('path', { d: d, fill: 'none', stroke: OL, 'stroke-width': c.lw, 'stroke-linejoin': 'round' })]);
  }
  // a tapered capsule from a (half width w1) to b (half width w2)
  function cap(a, b, w1, w2) {
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1, nx = -dy / L, ny = dx / L;
    return D`M${a[0] + nx * w1} ${a[1] + ny * w1}L${b[0] + nx * w2} ${b[1] + ny * w2}A${w2} ${w2} 0 0 0 ${b[0] - nx * w2} ${b[1] - ny * w2}L${a[0] - nx * w1} ${a[1] - ny * w1}A${w1} ${w1} 0 0 0 ${a[0] + nx * w1} ${a[1] + ny * w1}Z`;
  }
  function grad(c, kind, stops, attrs) {
    const id = c.id('g');
    c.defs.push(N(kind, Object.assign({ id: id }, attrs || {}), stops.map((s) => N('stop', { offset: s[0], 'stop-color': s[1], 'stop-opacity': s[2] == null ? 1 : s[2] }))));
    return 'url(#' + id + ')';
  }
  const glow = (c, col) => grad(c, 'radialGradient', [[0, '#ffffff', 0.95], [0.18, col, 0.9], [0.5, col, 0.35], [1, col, 0]]);
  function star(x, y, r, fill, o) {
    const q = r * 0.28;
    return F(D`M${x} ${y - r}Q${x + q} ${y - q} ${x + r} ${y}Q${x + q} ${y + q} ${x} ${y + r}Q${x - q} ${y + q} ${x - r} ${y}Q${x - q} ${y - q} ${x} ${y - r}Z`, fill, o);
  }
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

  // ------------------------------------------------------------------ input

  function normalize(player, opts) {
    const p = player && typeof player === 'object' ? player : {};
    const o = opts && typeof opts === 'object' ? opts : {};
    const race = own(RACE, p.race) ? p.race : 'Human';
    const cls = typeof p.cls === 'string' ? p.cls : '';
    const raw = p.look && typeof p.look === 'object' ? p.look : null;
    const look = {};
    Object.keys(DEF).forEach((k) => {
      const v = raw ? raw[k] : undefined;
      if (LISTS[k]) look[k] = LISTS[k].indexOf(v) >= 0 ? v : DEF[k];
      else look[k] = typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : DEF[k];
    });
    // dwarves wear a big beard unless the player explicitly chose none
    if (race === 'Dwarf' && !(raw && LISTS.beard.indexOf(raw.beard) >= 0)) look.beard = 'long';
    let eq;
    if (p.eq && typeof p.eq === 'object') {
      eq = {};
      ['weapon', 'armor', 'offhand', 'trinket'].forEach((k) => { eq[k] = typeof p.eq[k] === 'string' && p.eq[k] ? p.eq[k] : null; });
    } else {
      const d = CLASS_EQ[cls] || {};
      eq = { weapon: d.weapon || null, armor: d.armor || null, offhand: d.offhand || null, trinket: null };
    }
    const view = o.view === 'bust' || o.view === 'token' ? o.view : 'full';
    const pose = o.pose === 'ready' || o.pose === 'down' ? o.pose : 'idle';
    const size = Math.max(8, Math.min(2048, Number(o.size) || (view === 'full' ? 260 : view === 'bust' ? 160 : 64)));
    return {
      race: race, cls: cls, look: look, eq: eq, view: view, pose: pose, size: size,
      facing: o.facing === 'left' ? 'left' : 'right', animate: !!o.animate,
      frame: o.frame === 'shield' ? 'shield' : 'round', rim: o.rim !== false,
    };
  }

  function weaponKind(id) {
    if (!id) return null;
    if (own(WEAPON, id)) return WEAPON[id];
    const s = id.toLowerCase();
    if (/bow/.test(s)) return 'bow';
    if (/axe/.test(s)) return 'greataxe';
    if (/staff|stave|rod/.test(s)) return 'staff';
    if (/dagger|knife|shiv/.test(s)) return 'dagger';
    if (/mace|hammer|club|morning/.test(s)) return 'mace';
    if (/rapier|foil/.test(s)) return 'rapier';
    if (/sickle|scythe/.test(s)) return 'sickle';
    if (/wrap|fist|knuck/.test(s)) return 'wraps';
    return 'sword';
  }
  function armorKind(id, cls) {
    if (id) {
      const s = id.toLowerCase();
      if (/plate/.test(s)) return 'plate';
      if (/chain|mail|scale/.test(s)) return 'chain';
      return cls === 'Bard' ? 'doublet' : 'leather';
    }
    if (cls === 'Wizard' || cls === 'Sorcerer' || cls === 'Warlock') return 'robe';
    if (cls === 'Monk') return 'gi';
    if (cls === 'Bard') return 'doublet';
    if (cls === 'Cleric') return 'vestment';
    if (cls === 'Barbarian') return 'bare';
    return 'tunic';
  }
  function shieldKind(id) {
    if (!id) return null;
    const s = id.toLowerCase();
    if (/tower|pavise/.test(s)) return 'tower';
    if (/buckler/.test(s)) return 'buckler';
    if (/shield/.test(s)) return 'shield';
    return null;
  }
  function trinketKind(id) {
    if (!id) return null;
    const s = id.toLowerCase();
    if (/ring/.test(s)) return 'ring';
    if (/charm|foot|token|coin/.test(s)) return 'charm';
    return 'amulet';
  }

  // ------------------------------------------------------------------ model and skeleton

  function build(M) {
    const lk = M.look, cls = M.cls, race = M.race;
    const r = RACE[race], fr = FRAME[lk.frame], bd = BODY[lk.body];
    const g = {};
    g.H = r.H; g.crown = GY - r.H; g.headH = r.head; g.headW = r.head * r.hwf * bd.head;
    g.hx = CX + 3; g.chin = g.crown + g.headH; g.shY = g.chin + r.neck;
    g.legLen = (GY - g.shY) * r.legF; g.hipY = GY - g.legLen;
    g.waistY = g.shY + (g.hipY - g.shY) * 0.56;
    g.sw = r.sw * fr.sw * bd.w; g.ww = r.ww * fr.ww * bd.waist; g.hpw = r.hp * fr.hp * bd.hip;
    if (g.ww > g.sw * 0.98) g.ww = g.sw * 0.98;
    g.aw = 4.9 * r.limb * fr.limb * bd.limb; g.lg = 6.6 * r.limb * fr.limb * bd.limb;
    g.L = g.hx - g.headW / 2; g.R = g.hx + g.headW / 2;
    g.eyeY = g.crown + g.headH * 0.53; g.fx = g.hx + g.headW * 0.14;
    g.tx = CX + g.sw * 0.1;
    g.k = 0.62 + 0.38 * r.H / 222;
    g.fem = lk.frame === 'feminine'; g.masc = lk.frame === 'masculine';

    // colours
    let skin = lk.skin;
    if (race === 'Half-Orc') skin = mix(skin, '#7f9a66', 0.42);
    if (race === 'Tiefling') skin = mix(skin, '#b4505e', 0.2);
    const C = {
      skin: skin, skinS: mix(skin, '#40202c', 0.26), skinH: lite(skin, 0.2), skinD: mix(skin, '#2a1418', 0.5),
      hair: lk.hair, hairS: lum(lk.hair) < 0.12 ? lite(lk.hair, 0.1) : shade(lk.hair, 0.32), hairH: lite(lk.hair, lum(lk.hair) < 0.12 ? 0.26 : 0.3),
      eyes: lk.eyes, out: lk.outfit, outS: shade(lk.outfit, 0.34), outH: lite(lk.outfit, 0.16), outD: shade(lk.outfit, 0.55),
      acc: lk.accent, accS: shade(lk.accent, 0.3), accH: lite(lk.accent, 0.35),
      pants: mix(shade(lk.outfit, 0.45), '#3b3128', 0.5),
      lea: '#74502f', leaS: '#4c321d', leaH: '#9a6d43', boot: '#3f2b1e', bootH: '#6a4a33',
      steel: '#b4bcc3', steelS: '#6d767e', steelH: '#e9eef0', chain: '#8e969d', wood: '#8b5a32', woodS: '#5a391f', woodH: '#b07a48',
      fur: '#6e5640', furH: '#a68b6a',
    };
    C.brow = lum(lk.hair) > 0.75 ? shade(lk.hair, 0.35) : shade(lk.hair, 0.2);
    C.spark = SPARK[lk.accent] || lite(lk.accent, 0.4);

    const W = {
      weapon: weaponKind(M.eq.weapon), wid: M.eq.weapon || '', armor: armorKind(M.eq.armor, cls), shield: shieldKind(M.eq.offhand),
      trinket: trinketKind(M.eq.trinket), tid: M.eq.trinket || '',
    };
    if (race === 'Dragonborn' && W.armor === 'bare') W.armor = 'bare';
    const fl = {
      cloak: cls === 'Ranger' ? 'ranger' : cls === 'Druid' ? 'leaf' : null,
      mantle: cls === 'Barbarian', tabard: cls === 'Paladin', holy: cls === 'Cleric', cowl: cls === 'Rogue' && lk.hairStyle !== 'hood',
      pouches: cls === 'Rogue' || cls === 'Ranger', lute: cls === 'Bard', quiver: cls === 'Ranger' || W.weapon === 'bow',
      eldritch: cls === 'Warlock', sparks: cls === 'Sorcerer', book: cls === 'Wizard', beads: cls === 'Monk',
      pauldron: cls === 'Fighter' && W.armor !== 'plate',
      bareArms: cls === 'Barbarian' || W.armor === 'bare', bareFore: cls === 'Monk',
      twoHand: W.weapon === 'greataxe' || W.weapon === 'bow',
      dual: cls === 'Rogue' && W.weapon === 'dagger' && !W.shield,
    };
    if (fl.twoHand && W.shield) fl.shieldBack = true;
    return { M: M, g: g, C: C, W: W, fl: fl, lk: lk, race: race, cls: cls, pose: M.pose === 'down' ? 'idle' : M.pose, down: M.pose === 'down' };
  }

  // arm and leg positions for the pose
  function rig(X) {
    const g = X.g, W = X.W, ready = X.pose === 'ready';
    const sL = [CX - g.sw + g.aw * 0.95, g.shY + g.aw * 1.15], sR = [CX + g.sw - g.aw * 0.95, g.shY + g.aw * 1.15];
    const armLen = (g.hipY - g.shY) * 1.02 + 6, up = armLen * 0.5, fo = armLen * 0.5;
    const R = { sL: sL, sR: sR, up: up, fo: fo };
    let nE = [sL[0] - 4 - g.aw * 0.3, sL[1] + up], nH = [sL[0] - 3, sL[1] + up + fo];
    let fE = [sR[0] + 4 + g.aw * 0.3, sR[1] + up], fH = [sR[0] + 3, sR[1] + up + fo];
    let wpn = null, shield = null, pull = 0;
    const wk = W.weapon;
    if (!ready) {
      if (wk === 'staff' || wk === 'greataxe') {
        nE = [sL[0] - g.aw - 2, sL[1] + up * 0.92]; nH = [sL[0] - g.aw - 5, sL[1] + up + fo * 0.5];
        wpn = { x: nH[0], y: nH[1], rot: -3 };
      } else if (wk === 'bow') {
        wpn = { x: fH[0] + 1, y: fH[1], rot: -6, far: true, front: true }; R.farFront = true;
      } else if (wk && wk !== 'wraps') {
        wpn = { x: nH[0], y: nH[1], rot: wk === 'sickle' ? 168 : 196 };
      }
      if (W.shield && !X.fl.shieldBack) shield = { x: fH[0] + 3, y: fH[1] - (W.shield === 'tower' ? 26 : 12) };
      if (W.shield === 'tower' && shield) shield.y = Math.min(shield.y, GY - 44 * g.k - 2);
    } else {
      const midY = g.waistY;
      if (wk === 'bow') {
        fE = [sR[0] + 20, sR[1] + 4]; fH = [sR[0] + 44 * g.k + 6, sR[1] + 6];
        nE = [sL[0] - 4, sL[1] + up * 0.55]; nH = [g.tx + 2, sL[1] + 2];
        pull = fH[0] - nH[0] - 13;
        wpn = { x: fH[0], y: fH[1], rot: 0, far: true, front: true };
      } else if (wk === 'staff') {
        nE = [sL[0] - 6, midY + 4]; nH = [g.tx - g.sw * 0.2, midY - 2];
        wpn = { x: nH[0], y: nH[1], rot: 24 };
        fE = [sR[0] + 10, sR[1] + up * 0.7]; fH = [sR[0] + 20, sR[1] + up * 0.35];
      } else if (wk === 'greataxe') {
        nE = [sL[0] - 3, midY + 10]; nH = [CX - 8, g.hipY - 10];
        wpn = { x: nH[0], y: nH[1], rot: 36 };
        const a = rad(36), d = 30 * g.k;
        fH = [nH[0] + Math.sin(a) * d, nH[1] - Math.cos(a) * d]; fE = [sR[0] + 8, midY + 2];
        R.farFront = true;
      } else if (wk === 'wraps' || !wk) {
        nE = [sL[0] - 2, midY - 2]; nH = [g.tx + 4, g.shY + 8];
        fE = [sR[0] + 9, midY - 6]; fH = [sR[0] + 13, g.shY + 4];
        R.farFront = true;
      } else {
        nE = [sL[0] - g.aw * 0.4, midY + 4]; nH = [g.tx - 2, midY - 6];
        wpn = { x: nH[0], y: nH[1], rot: wk === 'dagger' ? 52 : wk === 'sickle' ? 30 : 40 };
        fE = [sR[0] + 10, sR[1] + up * 0.78]; fH = [sR[0] + 17, sR[1] + up * 0.5];
      }
      if (W.shield && !X.fl.shieldBack) {
        fE = [sR[0] + 8, sR[1] + up * 0.85]; fH = [sR[0] + 4, sR[1] + up * 0.75];
        shield = { x: CX + g.sw * 0.62, y: g.waistY - 4 };
        R.farFront = false;
      }
    }
    R.near = { s: sL, e: nE, h: nH }; R.far = { s: sR, e: fE, h: fH };
    R.wpn = wpn; R.shield = shield; R.pull = pull;
    // legs
    const hy = g.hipY - 4, ay = GY - 7, kn = g.hipY + g.legLen * 0.5;
    if (ready) {
      R.legN = { h: [CX - g.hpw * 0.42, hy], k: [CX - g.hpw * 0.78, kn], a: [CX - g.hpw * 1.12, ay] };
      R.legF = { h: [CX + g.hpw * 0.42, hy], k: [CX + g.hpw * 0.98, kn - 2], a: [CX + g.hpw * 1.25, ay] };
    } else {
      R.legN = { h: [CX - g.hpw * 0.44, hy], k: [CX - g.hpw * 0.5, kn], a: [CX - g.hpw * 0.52, ay] };
      R.legF = { h: [CX + g.hpw * 0.44, hy], k: [CX + g.hpw * 0.52, kn], a: [CX + g.hpw * 0.64, ay] };
    }
    return R;
  }

  // ------------------------------------------------------------------ body parts

  function torsoPath(g, extra) {
    const e = extra || 0, nw = g.headW * 0.22, sw = g.sw + e, ww = g.ww + e, hp = g.hpw + e, sy = g.shY - e * 0.4;
    return D`M${CX - nw} ${sy - 1}Q${CX - sw + 3} ${sy - 0.5} ${CX - sw} ${sy + 9}Q${CX - sw - 1} ${g.waistY - 16} ${CX - ww} ${g.waistY}` +
      D`Q${CX - hp - 1.5} ${(g.waistY + g.hipY) / 2 + 2} ${CX - hp} ${g.hipY + 2}L${CX + hp} ${g.hipY + 2}` +
      D`Q${CX + hp + 1.5} ${(g.waistY + g.hipY) / 2 + 2} ${CX + ww} ${g.waistY}Q${CX + sw + 1} ${g.waistY - 16} ${CX + sw} ${sy + 9}Q${CX + sw - 3} ${sy - 0.5} ${CX + nw} ${sy - 1}Z`;
  }
  function torsoShades(X, col) {
    const g = X.g;
    return [Ef(CX - g.sw * 1.05, g.waistY + 6, g.sw * 0.62, (g.hipY - g.shY) * 0.9, shade(col, 0.28)),
      Ef(CX + g.sw * 0.5, g.shY + 4, g.sw * 0.5, 7, lite(col, 0.14), { opacity: 0.8 }),
      Ef(CX, g.hipY + 2, g.hpw * 1.2, 6, shade(col, 0.22)),
      g.fem ? S(D`M${CX - g.sw * 0.62} ${g.shY + (g.waistY - g.shY) * 0.5}Q${CX - g.sw * 0.3} ${g.shY + (g.waistY - g.shY) * 0.68} ${g.tx - 1} ${g.shY + (g.waistY - g.shY) * 0.52}Q${CX + g.sw * 0.3} ${g.shY + (g.waistY - g.shY) * 0.66} ${CX + g.sw * 0.66} ${g.shY + (g.waistY - g.shY) * 0.48}`, shade(col, 0.3), 2.2, { opacity: 0.55 }) : null];
  }
  function skirt(g, top, hem, flare, wave) {
    const l = CX - g.hpw - flare, r = CX + g.hpw + flare, n = Math.max(3, Math.round((r - l) / 11));
    let d = D`M${CX - g.ww - 0.5} ${top}Q${CX - g.hpw - 2} ${(top + hem) / 2 - 6} ${l} ${hem}`;
    for (let i = 0; i < n; i++) { const x0 = l + (r - l) * i / n, x1 = l + (r - l) * (i + 1) / n; d += D`Q${(x0 + x1) / 2} ${hem + (i % 2 ? -wave : wave)} ${x1} ${hem}`; }
    return d + D`Q${CX + g.hpw + 2} ${(top + hem) / 2 - 6} ${CX + g.ww + 0.5} ${top}Z`;
  }

  function legs(c, X, R) {
    const g = X.g, C = X.C, W = X.W, out = [];
    const plate = W.armor === 'plate', robeLong = W.armor === 'robe';
    const gi = W.armor === 'gi', bare = X.race === 'Halfling' && !plate;
    const pantsCol = plate ? C.steel : gi ? C.outS : X.cls === 'Barbarian' ? C.lea : C.pants;
    [R.legF, R.legN].forEach((L, i) => {
      const near = i === 1, w = g.lg * (gi ? 1.15 : 1);
      const th = cap(L.h, L.k, w * 1.08, w * 0.86), sh = cap(L.k, L.a, w * 0.86, w * 0.62);
      out.push(shaded(c, th, pantsCol, [Ef(L.h[0] - w * 1.1, (L.h[1] + L.k[1]) / 2, w * 0.7, 40, shade(pantsCol, 0.3))]));
      // shin: boots, greaves, bare (halfling) or wrapped (monk)
      const shinCol = plate ? C.steel : bare ? C.pants : gi ? C.outS : C.boot;
      out.push(shaded(c, sh, shinCol, [Ef(L.k[0] - w * 0.9, (L.k[1] + L.a[1]) / 2, w * 0.6, 30, shade(shinCol, 0.32))]));
      if (plate) {
        out.push(Ci(c, L.k[0], L.k[1], w * 0.95, C.steel), Cf(L.k[0] + w * 0.3, L.k[1] - w * 0.3, w * 0.35, C.steelH, { opacity: 0.8 }));
        out.push(S(D`M${L.k[0] + w * 0.25} ${L.k[1] + w * 1.3}L${L.a[0] + w * 0.2} ${L.a[1] - 4}`, C.steelH, 1.4, { opacity: 0.7 }));
      } else if (bare) {
        // cropped trousers end mid-shin; hairy bare shins below
        const m = lerp(L.k, L.a, 0.45);
        out.push(P(c, cap(m, L.a, w * 0.78, w * 0.6), C.skin));
        out.push(S(D`M${m[0] - w * 0.85} ${m[1]}L${m[0] + w * 0.85} ${m[1]}`, shade(C.pants, 0.3), 2.2));
      } else if (gi) {
        const m = lerp(L.k, L.a, 0.7);
        out.push(P(c, cap(m, L.a, w * 0.7, w * 0.62), '#e6dcc4'));
        out.push(S(D`M${m[0] - w * 0.7} ${m[1] + 3}L${m[0] + w * 0.7} ${m[1] + 1}M${m[0] - w * 0.7} ${m[1] + 7}L${m[0] + w * 0.7} ${m[1] + 5}`, '#b8a988', 1));
      } else if (!robeLong) {
        const m = lerp(L.k, L.a, 0.18);
        out.push(S(D`M${m[0] - w * 0.9} ${m[1]}L${m[0] + w * 0.9} ${m[1] - 1}`, C.bootH, 2.4));
      }
      // foot
      const a = L.a, fw = w * (bare ? 1.15 : 0.95), fl = g.lg * (bare ? 2.5 : 2.1), toe = a[0] + fl * (near ? 0.78 : 0.86);
      const fd = D`M${a[0] - fw} ${a[1] - 3}Q${a[0] - fw - 1} ${GY} ${a[0] - fw + 3} ${GY}L${toe} ${GY}Q${toe + fw * 0.9} ${GY - 0.5} ${toe - 1} ${a[1] - fw * 0.6}Q${a[0] + fw * 0.6} ${a[1] - fw * 0.9} ${a[0] + fw * 0.5} ${a[1] - 5}Z`;
      const footCol = plate ? C.steel : bare ? C.skin : gi ? '#6b4a33' : C.boot;
      out.push(shaded(c, fd, footCol, [Ef(a[0] - fw * 0.2, GY + 1, fl, 3, shade(footCol, 0.3))]));
      if (bare) {
        out.push(S(D`M${toe - fw * 0.6} ${GY - 0.5}L${toe - fw * 0.6} ${GY - 3}M${toe - fw * 1.3} ${GY - 0.5}L${toe - fw * 1.3} ${GY - 3}`, C.skinS, 1));
        out.push(S(D`M${a[0] - fw * 0.2} ${a[1] - 3}l2 -3M${a[0] + fw * 0.4} ${a[1] - 2}l2 -3.5M${a[0] + fw} ${a[1] - 1}l2 -3`, C.hair, 1.6));
      } else if (plate) {
        out.push(S(D`M${a[0]} ${a[1] + 1}L${toe - 2} ${GY - 3}`, C.steelS, 1));
      }
    });
    return out;
  }

  function armPaths(c, X, A, near) {
    const g = X.g, C = X.C, W = X.W, fl = X.fl, out = [];
    const w = g.aw, a = W.armor;
    let upCol = C.out, foCol = C.out, handCol = C.skin;
    if (a === 'leather') { upCol = C.out; foCol = C.lea; }
    else if (a === 'chain') { upCol = C.chain; foCol = C.lea; }
    else if (a === 'plate') { upCol = C.steel; foCol = C.steel; handCol = C.steelS; }
    else if (a === 'robe' || a === 'vestment') { upCol = X.cls === 'Warlock' ? shade(C.out, 0.25) : C.out; foCol = upCol; }
    if (fl.bareArms) { upCol = C.skin; foCol = a === 'leather' ? C.lea : C.skin; }
    if (fl.bareFore) foCol = C.skin;
    if (X.race === 'Dragonborn' && (upCol === C.skin)) upCol = C.skin;
    const up = cap(A.s, A.e, w * 1.12, w * 0.9), fo = cap(A.e, A.h, w * 0.9, w * 0.78);
    out.push(shaded(c, up, upCol, [Ef(A.s[0] - w * 1.3, A.s[1] + 10, w * 0.9, 30, shade(upCol, 0.3))]));
    if (a === 'chain' && !fl.bareArms) out.push(F(up, 'url(#' + c.p + 'ring)', { opacity: 0.55 }));
    // bell sleeve for robes
    if (a === 'robe' || a === 'vestment') {
      const dx = A.h[0] - A.e[0], dy = A.h[1] - A.e[1], L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L, nx = -uy, ny = ux;
      const e = A.e, h = [A.h[0] - ux * w * 0.6, A.h[1] - uy * w * 0.6], bw = w * 1.75;
      const d = D`M${e[0] + nx * w * 0.95} ${e[1] + ny * w * 0.95}L${h[0] + nx * bw} ${h[1] + ny * bw}Q${h[0] + ux * 3} ${h[1] + uy * 3} ${h[0] - nx * bw} ${h[1] - ny * bw}L${e[0] - nx * w * 0.95} ${e[1] - ny * w * 0.95}Z`;
      out.push(shaded(c, d, foCol, [Ef(e[0] - w * 2, e[1] + 10, w * 1.3, 26, shade(foCol, 0.3))]));
      out.push(S(D`M${h[0] + nx * bw} ${h[1] + ny * bw}Q${h[0] + ux * 3} ${h[1] + uy * 3} ${h[0] - nx * bw} ${h[1] - ny * bw}`, C.acc, 2.4));
    } else {
      out.push(shaded(c, fo, foCol, [Ef(A.e[0] - w * 1.2, A.e[1] + 12, w * 0.8, 24, shade(foCol, 0.3))]));
      if (a === 'plate') out.push(Ci(c, A.e[0], A.e[1], w * 0.95, C.steel), Cf(A.e[0] + 1, A.e[1] - 1, w * 0.35, C.steelH));
      if (a === 'leather' || a === 'chain' || (fl.bareArms && a !== 'bare')) {
        const m = lerp(A.e, A.h, 0.3), n = lerp(A.e, A.h, 0.62);
        out.push(S(D`M${m[0] - w * 0.8} ${m[1]}L${m[0] + w * 0.8} ${m[1]}M${n[0] - w * 0.75} ${n[1]}L${n[0] + w * 0.75} ${n[1]}`, C.leaS, 1.2));
      }
      if (X.cls === 'Barbarian' && a === 'bare') {
        const m = lerp(A.e, A.h, 0.62);
        out.push(P(c, cap(m, lerp(A.e, A.h, 0.9), w * 0.95, w * 0.85), C.lea));
      }
      if (fl.bareFore || W.weapon === 'wraps') {
        const m0 = lerp(A.e, A.h, 0.45);
        out.push(P(c, cap(m0, A.h, w * 0.86, w * 0.84), '#e8dcc0'));
        [0.6, 0.75, 0.9].forEach((t) => { const m = lerp(A.e, A.h, t); out.push(S(D`M${m[0] - w * 0.8} ${m[1] + 1}L${m[0] + w * 0.8} ${m[1] - 1}`, '#b9a887', 1)); });
      }
    }
    if (X.race === 'Dragonborn' && foCol === C.skin) {
      const m = lerp(A.e, A.h, 0.4);
      out.push(S(D`M${m[0] - w * 0.5} ${m[1]}q2 2 4 0M${m[0] - w * 0.2} ${m[1] + 5}q2 2 4 0`, C.skinS, 1));
    }
    return out;
  }
  function hand(c, X, h, near) {
    const g = X.g, C = X.C, W = X.W, r = g.aw * 1.02;
    const col = W.armor === 'plate' ? C.steelS : (W.weapon === 'wraps' || X.fl.bareFore) ? '#e8dcc0' : C.skin;
    const out = [Ci(c, h[0], h[1], r, col), Cf(h[0] + r * 0.3, h[1] - r * 0.35, r * 0.38, lite(col, 0.3), { opacity: 0.7 })];
    if (X.race === 'Dragonborn' && col === C.skin) out.push(S(D`M${h[0] + r * 0.6} ${h[1] + r * 0.7}l2 2M${h[0]} ${h[1] + r}l1 2.5`, '#f0e6d0', 1.3));
    if (near && W.trinket === 'ring') {
      out.push(Cf(h[0] - r * 0.2, h[1] + r * 0.45, r * 0.32, 'none', { stroke: C.acc === '#2f2f2f' ? '#d1a94f' : C.acc, 'stroke-width': 1.4 }));
      out.push(star(h[0] - r * 0.6, h[1] + r * 0.1, r * 0.9, '#fffbe8', { class: X.M.animate ? 'cft' : null }));
    }
    return out;
  }

  // ------------------------------------------------------------------ gear

  function weaponArt(c, X, kind) {
    const C = X.C, k = X.g.k, out = [], id = X.W.wid;
    if (kind === 'sword') {
      const bl = (id === 'iron_sword' ? 58 : id === 'steel_longsword' ? 72 : id === 'enchanted_blade' ? 70 : 66) * k, bw = 3.5 * k;
      const blade = id === 'iron_sword' ? '#9aa2a6' : id === 'enchanted_blade' ? '#d6ecff' : id === 'steel_longsword' ? '#e1e8ec' : '#c4ccd1';
      const bd = D`M${-bw} -4L${-bw * 0.85} ${-bl + bw * 2.6}L0 ${-bl}L${bw * 0.85} ${-bl + bw * 2.6}L${bw} -4Z`;
      if (id === 'enchanted_blade') out.push(S(D`M0 -6L0 ${-bl + 4}`, '#7fd4ff', 11 * k, { opacity: 0.35, class: X.M.animate ? 'cfg' : null }));
      out.push(P(c, bd, blade), F(D`M0 -4L0 ${-bl}L${bw * 0.85} ${-bl + bw * 2.6}L${bw} -4Z`, lite(blade, 0.45), { opacity: 0.7 }));
      out.push(S(D`M0 -7L0 ${-bl + bw * 4}`, shade(blade, 0.35), 1.1));
      if (id === 'enchanted_blade') for (let i = 0; i < 4; i++) out.push(S(D`M-1.4 ${-14 - i * 12 * k}l2.8 -2.5l-2.8 -2.5`, '#7ff0ff', 1.2, { class: X.M.animate ? 'cfg' : null }));
      const gc = id === 'iron_sword' ? '#7a8086' : C.acc;
      out.push(P(c, D`M${-12 * k} -2Q0 -6.5 ${12 * k} -2L${12 * k} -5.4Q0 -9.5 ${-12 * k} -5.4Z`, gc));
      out.push(P(c, D`M-2 -2H2V${11 * k}H-2Z`, '#4a2f1f'), S(D`M-2 ${2 * k}L2 ${4 * k}M-2 ${6 * k}L2 ${8 * k}`, '#7a5536', 0.9));
      out.push(Ci(c, 0, 13.5 * k, 3 * k, gc));
    } else if (kind === 'dagger') {
      const rusty = id === 'rusty_dagger', bl = 26 * k, bw = 3 * k, blade = rusty ? '#8d7a68' : '#cfd6db';
      out.push(P(c, D`M${-bw} -3L${-bw * 0.6} ${-bl + 6}L0 ${-bl}L${bw * 0.6} ${-bl + 6}L${bw} -3Z`, blade), F(D`M0 -3L0 ${-bl}L${bw * 0.6} ${-bl + 6}L${bw} -3Z`, lite(blade, 0.4), { opacity: 0.6 }));
      if (rusty) out.push(Cf(-0.8, -10 * k, 1.3, '#9a4e22'), Cf(1, -16 * k, 1, '#9a4e22'), Cf(-0.6, -20 * k, 0.8, '#7a3a18'));
      out.push(P(c, D`M${-7 * k} -1.5H${7 * k}V-4H${-7 * k}Z`, rusty ? '#6b5a4a' : C.acc));
      out.push(P(c, D`M-1.8 -1.5H1.8V${8 * k}H-1.8Z`, '#3d2618'), Ci(c, 0, 9.5 * k, 2.2 * k, rusty ? '#6b5a4a' : C.acc));
    } else if (kind === 'mace') {
      out.push(P(c, D`M-2 ${14 * k}H2V${-34 * k}H-2Z`, C.wood), S(D`M-2 ${4 * k}L2 ${6 * k}M-2 ${8 * k}L2 ${10 * k}`, C.woodS, 1));
      const hy = -40 * k, r = 6.5 * k;
      for (let i = 0; i < 6; i++) {
        const a = i / 6 * Math.PI * 2 + 0.3, x = Math.cos(a) * r * 1.5, y = hy + Math.sin(a) * r * 1.5;
        out.push(P(c, D`M${Math.cos(a - 0.5) * r * 0.6} ${hy + Math.sin(a - 0.5) * r * 0.6}L${x} ${y}L${Math.cos(a + 0.5) * r * 0.6} ${hy + Math.sin(a + 0.5) * r * 0.6}Z`, C.steelS));
      }
      out.push(Ci(c, 0, hy, r, C.steel), Cf(1.6, hy - 2, r * 0.4, C.steelH), P(c, D`M-2 ${hy - r + 1}L0 ${hy - r - 5 * k}L2 ${hy - r + 1}Z`, C.steel));
      out.push(P(c, D`M-3.4 ${-31 * k}H3.4V${-35 * k}H-3.4Z`, C.acc));
    } else if (kind === 'staff') {
      const b = X.staffB, t = X.staffT;
      out.push(P(c, D`M-2.4 ${b}L-2.1 ${t + 6}Q0 ${t} 2.1 ${t + 6}L2.4 ${b}Z`, C.wood), S(D`M0.8 ${b - 4}L0.6 ${t + 10}`, C.woodH, 1, { opacity: 0.7 }));
      out.push(S(D`M-2.2 ${t + 30}l4.4 -2M-2.2 ${t + 34}l4.4 -2M-2.2 ${t + 38}l4.4 -2`, C.acc, 1.3));
      if (X.cls === 'Wizard' || X.cls === 'Sorcerer' || X.cls === 'Warlock') {
        const gc = X.cls === 'Warlock' ? '#b07cff' : X.cls === 'Sorcerer' ? C.spark : '#8fe0ff';
        out.push(Cf(0, t - 4, 15 * k, glow(c, gc), { class: X.M.animate ? 'cfg' : null, opacity: X.pose === 'ready' ? 1 : 0.75 }));
        out.push(S(D`M-2 ${t + 6}Q-7 ${t} -3.5 ${t - 9}M2 ${t + 6}Q7 ${t} 3.5 ${t - 9}`, C.woodS, 2.2));
        out.push(P(c, D`M0 ${t - 13}L4 ${t - 4}L0 ${t + 3}L-4 ${t - 4}Z`, lite(gc, 0.35)), F(D`M0 ${t - 13}L4 ${t - 4}L0 ${t + 3}Z`, '#ffffff', { opacity: 0.45 }));
      } else if (X.cls === 'Druid' || X.cls === 'Cleric') {
        out.push(S(D`M0 ${t + 4}Q-8 ${t - 4} -2 ${t - 10}Q5 ${t - 12} 4 ${t - 5}`, OL, 5.4), S(D`M0 ${t + 4}Q-8 ${t - 4} -2 ${t - 10}Q5 ${t - 12} 4 ${t - 5}`, C.wood, 3.2));
        out.push(P(c, D`M2 ${t + 2}q8 -4 10 2q-6 4 -10 -2Z`, '#6f9a4c'), P(c, D`M-4 ${t - 4}q-8 -4 -9 2q6 3 9 -2Z`, '#86ad5a'));
      } else {
        out.push(P(c, D`M-2.8 ${t + 6}H2.8V${t + 1}H-2.8Z`, C.steelS), P(c, D`M-2.8 ${b}H2.8V${b - 5}H-2.8Z`, C.steelS));
      }
    } else if (kind === 'greataxe') {
      const b = X.staffB, t = X.staffT, hy = t + 12;
      out.push(P(c, D`M-2.5 ${b}L-2.3 ${t}H2.3L2.5 ${b}Z`, C.woodS), S(D`M-2.4 ${b - 20}l4.8 -2M-2.4 ${b - 25}l4.8 -2M-2.4 ${b - 30}l4.8 -2`, C.lea, 1.4));
      const s = k * 1.05;
      const right = D`M2 ${hy - 9 * s}Q${13 * s} ${hy - 12 * s} ${24 * s} ${hy - 22 * s}Q${17 * s} ${hy} ${24 * s} ${hy + 22 * s}Q${13 * s} ${hy + 12 * s} 2 ${hy + 9 * s}Z`;
      const left = D`M-2 ${hy - 7 * s}Q${-10 * s} ${hy - 9 * s} ${-18 * s} ${hy - 16 * s}Q${-13 * s} ${hy} ${-18 * s} ${hy + 16 * s}Q${-10 * s} ${hy + 9 * s} -2 ${hy + 7 * s}Z`;
      out.push(shaded(c, right, C.steel, [F(D`M${18 * s} ${hy - 30 * s}Q${11 * s} ${hy} ${18 * s} ${hy + 30 * s}L${40 * s} ${hy}Z`, C.steelH)]));
      out.push(shaded(c, left, C.steel, [F(D`M${-12 * s} ${hy - 30 * s}Q${-8 * s} ${hy} ${-12 * s} ${hy + 30 * s}L${-30 * s} ${hy}Z`, C.steelH)]));
      out.push(P(c, D`M-3.5 ${hy - 10 * s}H3.5V${hy + 10 * s}H-3.5Z`, C.steelS), P(c, D`M-2 ${t + 1}L0 ${t - 8 * s}L2 ${t + 1}Z`, C.steel));
    } else if (kind === 'bow') {
      const L = 58 * k, pull = X.R.pull || 0;
      out.push(S(D`M-13 ${-L}L${-13 - pull} 0L-13 ${L}`, '#efe7d2', 1));
      out.push(S(D`M-13 ${-L}Q2 ${-L * 0.6} 0 0Q2 ${L * 0.6} -13 ${L}`, OL, 6.2), S(D`M-13 ${-L}Q2 ${-L * 0.6} 0 0Q2 ${L * 0.6} -13 ${L}`, C.wood, 3.8));
      out.push(S(D`M-12 ${-L + 4}Q1.5 ${-L * 0.6} 0.6 -6`, C.woodH, 1.1, { opacity: 0.8 }));
      out.push(P(c, D`M-2 -7H2.6V7H-2Z`, C.lea));
      if (pull) {
        out.push(S(D`M${-13 - pull} 0L12 0`, '#7a5536', 1.6), P(c, D`M12 0l-5 -2.6v5.2Z`, C.steel));
        out.push(F(D`M${-13 - pull + 1} 0l-6 -3.4l3 3.4l-3 3.4Z`, '#e8e0d0', { stroke: OL, 'stroke-width': 0.8 }));
      }
    } else if (kind === 'rapier') {
      const bl = 78 * k;
      out.push(P(c, D`M-1.6 -4L-0.5 ${-bl}L0.5 ${-bl}L1.6 -4Z`, '#dfe6ea'));
      out.push(S(D`M${8 * k} -3C${13 * k} ${4 * k} ${9 * k} ${12 * k} 1.5 ${13 * k}`, OL, 3.4), S(D`M${8 * k} -3C${13 * k} ${4 * k} ${9 * k} ${12 * k} 1.5 ${13 * k}`, C.acc, 1.8));
      out.push(P(c, D`M${-9 * k} -2.4H${9 * k}V-5H${-9 * k}Z`, C.acc), N('circle', { cx: 0, cy: f1(-7 * k), r: f1(3 * k), fill: 'none', stroke: C.acc, 'stroke-width': 1.5 }));
      out.push(P(c, D`M-1.7 -2.4H1.7V${10 * k}H-1.7Z`, '#3a2418'), Ci(c, 0, 11.5 * k, 2.4 * k, C.acc));
    } else if (kind === 'sickle') {
      out.push(P(c, D`M-2 ${12 * k}H2V-3H-2Z`, C.wood));
      out.push(P(c, D`M-1.6 -3C-3 ${-22 * k} ${9 * k} ${-34 * k} ${22 * k} ${-27 * k}C${11 * k} ${-28 * k} ${3 * k} ${-19 * k} 1.8 -3Z`, '#c9d0d4'), S(D`M0 -6C-1 ${-20 * k} ${8 * k} ${-29 * k} ${18 * k} ${-27 * k}`, '#f4f7f8', 0.9));
      out.push(P(c, D`M-2.6 -1.5H2.6V-4.5H-2.6Z`, C.acc));
    }
    return out;
  }
  function placed(kids, w) { return G(kids, { transform: D`translate(${w.x} ${w.y}) rotate(${w.rot})` }); }

  function shieldArt(c, X, kind) {
    const C = X.C, k = X.g.k, out = [], face = X.cls === 'Paladin' ? C.out : mix(C.out, '#6b4a2c', 0.35);
    if (kind === 'buckler') {
      const r = 13 * k;
      out.push(shaded(c, D`M${-r} 0A${r} ${r} 0 1 1 ${r} 0A${r} ${r} 0 1 1 ${-r} 0Z`, face, [Ef(-r * 0.5, r * 0.4, r * 0.9, r, shade(face, 0.3))]));
      out.push(N('circle', { cx: 0, cy: 0, r: f1(r - 1.6), fill: 'none', stroke: C.acc, 'stroke-width': 2.6 }), Ci(c, 0, 0, r * 0.32, C.steel), Cf(1, -1, r * 0.13, C.steelH));
    } else if (kind === 'shield') {
      const w = 19 * k, h = 24 * k;
      const d = D`M${-w} ${-h * 0.82}Q0 ${-h * 1.05} ${w} ${-h * 0.82}L${w} ${-h * 0.05}Q${w * 0.88} ${h * 0.62} 0 ${h}Q${-w * 0.88} ${h * 0.62} ${-w} ${-h * 0.05}Z`;
      out.push(shaded(c, d, face, [F(D`M${-w * 1.2} ${-h}L${-w * 0.2} ${-h}L${-w * 0.1} ${h * 1.2}L${-w * 1.2} ${h * 1.2}Z`, shade(face, 0.22)), F(D`M${w * 0.3} ${-h}L${w * 0.6} ${-h}L${w * 0.2} ${h}L${-w * 0.1} ${h}Z`, lite(face, 0.15))]));
      out.push(N('path', { d: d, fill: 'none', stroke: C.steelS, 'stroke-width': 2.4, transform: 'scale(.9)' }));
      if (X.cls === 'Paladin') out.push(sun(c, 0, -h * 0.15, 6 * k, C.acc));
      else if (X.cls === 'Cleric') out.push(P(c, D`M-2 ${-h * 0.6}H2V${-h * 0.25}H${w * 0.4}V${-h * 0.05}H2V${h * 0.5}H-2V${-h * 0.05}H${-w * 0.4}V${-h * 0.25}H-2Z`, C.acc));
      else out.push(P(c, D`M${-w * 0.9} ${-h * 0.25}L0 ${h * 0.25}L${w * 0.9} ${-h * 0.25}L${w * 0.9} ${h * 0.05}L0 ${h * 0.55}L${-w * 0.9} ${h * 0.05}Z`, C.acc));
    } else if (kind === 'tower') {
      const w = 20 * k, h = 44 * k;
      const d = D`M${-w} ${-h + 6}Q0 ${-h - 4} ${w} ${-h + 6}L${w} ${h - 8}Q0 ${h + 2} ${-w} ${h - 8}Z`;
      out.push(shaded(c, d, face, [F(D`M${-w * 1.2} ${-h - 6}H${-w * 0.25}V${h + 6}H${-w * 1.2}Z`, shade(face, 0.25)), F(D`M${w * 0.35} ${-h}H${w * 0.6}V${h}H${w * 0.35}Z`, lite(face, 0.12))]));
      out.push(N('path', { d: d, fill: 'none', stroke: C.steelS, 'stroke-width': 3, transform: 'scale(.9)' }));
      out.push(P(c, D`M-2.5 ${-h + 4}H2.5V${h - 6}H-2.5Z`, C.steel), P(c, D`M${-w + 3} -2.5H${w - 3}V2.5H${-w + 3}Z`, C.steel));
      [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach((q) => out.push(Ci(c, q[0] * w * 0.6, q[1] * h * 0.6, 1.8, C.acc)));
      if (X.cls === 'Paladin') out.push(sun(c, 0, 0, 7 * k, C.acc));
    }
    return out;
  }
  function sun(c, x, y, r, col) {
    let d = '';
    for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; d += D`M${x + Math.cos(a) * r * 1.25} ${y + Math.sin(a) * r * 1.25}L${x + Math.cos(a) * r * 1.95} ${y + Math.sin(a) * r * 1.95}`; }
    return G([S(d, OL, 3.6), S(d, col, 1.8), Ci(c, x, y, r, col), Cf(x + r * 0.3, y - r * 0.3, r * 0.35, lite(col, 0.5))]);
  }

  // ------------------------------------------------------------------ torso costume

  function torso(c, X) {
    const g = X.g, C = X.C, W = X.W, fl = X.fl, a = W.armor, out = [];
    const T = torsoPath(g);
    const belt = (y, col, buckle) => {
      const d = D`M${CX - g.ww - 3} ${y - 3}Q${CX} ${y - 1} ${CX + g.ww + 3} ${y - 3.5}L${CX + g.ww + 3.5} ${y + 3}Q${CX} ${y + 5} ${CX - g.ww - 3.5} ${y + 3.5}Z`;
      return [P(c, d, col || C.leaS), P(c, D`M${g.tx - 3.6} ${y - 3.6}H${g.tx + 3.6}V${y + 4}H${g.tx - 3.6}Z`, 'none', { stroke: buckle || C.acc, 'stroke-width': 1.8 })];
    };
    const beltY = g.waistY + (g.hipY - g.waistY) * 0.45;
    const vneck = (col, depth) => F(D`M${g.tx - g.headW * 0.16} ${g.shY - 1}L${g.tx + 1} ${g.shY + depth}L${g.tx + g.headW * 0.2} ${g.shY - 1}Z`, col);
    if (a === 'robe' || a === 'vestment') {
      const col = X.cls === 'Warlock' ? shade(C.out, 0.25) : C.out;
      const hem = a === 'robe' ? GY - 9 : g.hipY + g.legLen * 0.62;
      const sk = skirt(g, g.waistY - 2, hem, a === 'robe' ? 15 : 10, 2.4);
      out.push(shaded(c, sk, col, [F(D`M${CX - g.hpw - 30} ${g.waistY}L${CX - 4} ${g.waistY}L${CX - 10} ${GY}L${CX - g.hpw - 30} ${GY}Z`, shade(col, 0.28)),
        S(D`M${CX + 4} ${g.hipY}L${CX + 8} ${hem}M${CX + g.hpw * 0.7} ${g.hipY + 6}L${CX + g.hpw + 6} ${hem}`, shade(col, 0.22), 2.2)]));
      out.push(S(skirtHem(g, hem, a === 'robe' ? 15 : 10, 2.4), C.acc, 3));
      out.push(shaded(c, T, col, torsoShades(X, col)));
      out.push(vneck(C.skin, 8), S(D`M${g.tx - g.headW * 0.18} ${g.shY - 1}L${g.tx + 1} ${g.shY + 10}L${g.tx + g.headW * 0.22} ${g.shY - 1}`, C.acc, 2.6));
      out.push(S(D`M${g.tx + 1} ${g.shY + 10}L${g.tx + 3} ${hem}`, C.acc, 2.4));
      if (X.cls === 'Wizard') for (let i = 0; i < 4; i++) out.push(star(CX - g.hpw - 8 + i * (g.hpw * 2 + 16) / 3.4, hem - 8, 3, C.accH));
      if (X.cls === 'Warlock') for (let i = 0; i < 3; i++) out.push(S(D`M${CX - g.hpw - 4 + i * 14} ${hem - 10}l3 -4l3 4l-3 4Z`, '#b07cff', 1, { opacity: 0.8, class: X.M.animate ? 'cfg' : null }));
      if (X.cls === 'Sorcerer') out.push(S(D`M${CX - g.sw + 4} ${g.shY + 6}L${CX + g.ww} ${g.waistY + 2}`, C.acc, 5), S(D`M${CX - g.sw + 4} ${g.shY + 6}L${CX + g.ww} ${g.waistY + 2}`, C.accH, 1.2));
      if (a === 'vestment') {
        out.push(P(c, D`M${g.tx - 7} ${g.shY}L${g.tx - 8} ${hem - 6}H${g.tx - 2}L${g.tx - 2} ${g.shY + 10}Z`, C.acc), P(c, D`M${g.tx + 7} ${g.shY}L${g.tx + 8} ${hem - 6}H${g.tx + 2}L${g.tx + 2} ${g.shY + 10}Z`, C.acc));
        out.push(S(D`M${g.tx - 5} ${hem - 14}v-6M${g.tx - 7.5} ${hem - 17}h5M${g.tx + 5} ${hem - 14}v-6M${g.tx + 2.5} ${hem - 17}h5`, C.out, 1.4));
      }
      out.push(...belt(g.waistY + 2, a === 'robe' ? shade(C.acc, 0.35) : '#cbb98f', C.acc));
      if (fl.book) out.push(P(c, D`M${CX + g.ww - 2} ${g.waistY + 6}l11 2l-2 13l-11 -2Z`, '#5a2e2e'), S(D`M${CX + g.ww - 1} ${g.waistY + 8}l9 1.6`, C.acc, 1.2));
    } else if (a === 'gi') {
      out.push(shaded(c, T, C.out, torsoShades(X, C.out)));
      out.push(P(c, skirt(g, g.waistY + 2, g.hipY + 12, 3, 1.5), C.out));
      out.push(vneck(C.skin, 16));
      out.push(S(D`M${g.tx - g.headW * 0.2} ${g.shY - 1}L${g.tx + 6} ${g.waistY + 2}M${g.tx + g.headW * 0.22} ${g.shY - 1}L${g.tx - 1} ${g.shY + 16}`, C.outH, 4.2));
      out.push(...belt(g.waistY + 3, shade(C.acc, 0.25), shade(C.acc, 0.25)));
      out.push(P(c, D`M${g.tx - 6} ${g.waistY + 5}l-5 16l4 1l4 -15Z`, shade(C.acc, 0.25)));
      if (fl.beads) for (let i = 0; i < 9; i++) { const t = i / 8, x = g.tx - 8 + t * 16, y = g.shY + 4 + Math.sin(t * Math.PI) * 10; out.push(Ci(c, x, y, 1.6, '#6b3b22', { 'stroke-width': 0.8 })); }
    } else if (a === 'bare') {
      out.push(shaded(c, T, C.skin, torsoShades(X, C.skin).concat([S(D`M${g.tx} ${g.shY + 12}L${g.tx + 1} ${g.waistY + 8}M${g.tx - g.sw * 0.55} ${g.shY + 20}Q${g.tx - 3} ${g.shY + 26} ${g.tx} ${g.shY + 22}Q${g.tx + 4} ${g.shY + 26} ${g.tx + g.sw * 0.6} ${g.shY + 19}`, C.skinS, 1.6)])));
      out.push(S(D`M${CX - g.sw + 4} ${g.shY + 4}L${CX + g.ww - 2} ${g.waistY + 6}`, OL, 7.4), S(D`M${CX - g.sw + 4} ${g.shY + 4}L${CX + g.ww - 2} ${g.waistY + 6}`, C.lea, 5));
      out.push(P(c, skirt(g, beltY, g.hipY + 16, 4, 3), C.fur));
      out.push(...belt(beltY, C.leaS));
    } else {
      // tunic, leather, chain, plate, doublet
      let col = C.out;
      if (a === 'leather') col = C.lea;
      if (a === 'chain') col = C.chain;
      if (a === 'plate') col = grad(c, 'linearGradient', [[0, C.steelS], [0.45, C.steel], [0.75, C.steelH], [1, C.steel]], { x1: 0, x2: 1, y1: 0, y2: 0.2 });
      const base = a === 'plate' ? C.steel : col;
      if (a === 'chain') out.push(P(c, skirt(g, g.waistY, g.hipY + 22, 5, 1), C.chain), F(skirt(g, g.waistY, g.hipY + 22, 5, 1), 'url(#' + c.p + 'ring)', { opacity: 0.6 }));
      else if (a === 'tunic' || a === 'doublet') out.push(shaded(c, skirt(g, g.waistY, g.hipY + (a === 'doublet' ? 8 : 16), a === 'doublet' ? 4 : 5, 2), C.out, [Ef(CX - g.hpw - 6, g.hipY, 12, 30, C.outS)]));
      else if (a === 'leather') {
        for (let i = 0; i < 4; i++) {
          const x0 = CX - g.hpw - 2 + i * (g.hpw * 2 + 4) / 4, x1 = x0 + (g.hpw * 2 + 4) / 4 + 1;
          out.push(P(c, D`M${x0} ${g.hipY - 6}L${x0 - 1} ${g.hipY + 14}Q${(x0 + x1) / 2} ${g.hipY + 17} ${x1} ${g.hipY + 14}L${x1} ${g.hipY - 6}Z`, i === 0 ? C.leaS : C.lea));
        }
      } else if (a === 'plate') {
        for (let i = 2; i >= 0; i--) {
          const y = g.hipY - 4 + i * 6;
          out.push(P(c, D`M${CX - g.hpw - 3 - i} ${y}Q${CX} ${y + 4} ${CX + g.hpw + 3 + i} ${y}L${CX + g.hpw + 3 + i} ${y + 7}Q${CX} ${y + 11} ${CX - g.hpw - 3 - i} ${y + 7}Z`, C.steel));
        }
      }
      out.push(shaded(c, T, col, torsoShades(X, base)));
      if (a === 'chain') {
        out.push(F(T, 'url(#' + c.p + 'ring)', { opacity: 0.6 }));
        out.push(F(D`M${CX - g.headW * 0.26} ${g.shY - 1.5}Q${g.tx} ${g.shY + 9} ${CX + g.headW * 0.28} ${g.shY - 1.5}Q${g.tx} ${g.shY + 3} ${CX - g.headW * 0.26} ${g.shY - 1.5}Z`, C.out, { stroke: OL, 'stroke-width': c.lw }));
      } else if (a === 'leather') {
        out.push(vneck(C.out, 12), S(D`M${g.tx - g.headW * 0.16} ${g.shY - 1}L${g.tx + 1} ${g.shY + 12}L${g.tx + g.headW * 0.2} ${g.shY - 1}`, OL, c.lw));
        out.push(S(D`M${CX - g.sw + 4} ${g.shY + 12}Q${CX - g.ww} ${g.waistY} ${CX - g.ww + 3} ${beltY}M${CX + g.sw - 4} ${g.shY + 12}Q${CX + g.ww} ${g.waistY} ${CX + g.ww - 3} ${beltY}`, C.leaH, 1, { 'stroke-dasharray': '2 2' }));
        out.push(S(D`M${g.tx - 6} ${g.shY + 18}H${g.tx + 7}M${g.tx - 7} ${g.shY + 26}H${g.tx + 8}`, C.leaS, 1.4));
      } else if (a === 'plate') {
        out.push(S(D`M${g.tx} ${g.shY + 4}Q${g.tx + 2} ${g.waistY - 4} ${g.tx} ${g.hipY - 2}`, C.steelS, 1.4));
        out.push(S(D`M${CX - g.ww + 2} ${g.waistY + 2}Q${g.tx} ${g.waistY + 9} ${CX + g.ww - 2} ${g.waistY + 2}`, C.steelS, 1.2));
        out.push(S(D`M${CX - g.headW * 0.3} ${g.shY + 1}Q${g.tx} ${g.shY + 7} ${CX + g.headW * 0.32} ${g.shY + 1}`, C.acc, 2.4));
        out.push(F(D`M${g.tx + 3} ${g.shY + 8}Q${g.tx + g.sw * 0.6} ${g.shY + 10} ${g.tx + g.sw * 0.5} ${g.waistY - 6}Q${g.tx + 6} ${g.waistY - 10} ${g.tx + 3} ${g.shY + 8}Z`, '#ffffff', { opacity: 0.35 }));
      } else if (a === 'doublet') {
        out.push(vneck(C.skin, 6));
        for (let i = -2; i <= 2; i++) out.push(S(D`M${g.tx + i * g.ww * 0.38} ${g.shY + 8}Q${g.tx + i * g.ww * 0.42} ${g.waistY} ${g.tx + i * g.ww * 0.36} ${g.hipY}`, C.outS, 1));
        for (let i = 0; i < 5; i++) out.push(Ci(c, g.tx + 1, g.shY + 9 + i * (g.hipY - g.shY - 12) / 5, 1.5, C.acc, { 'stroke-width': 0.8 }));
        out.push(F(D`M${CX - g.headW * 0.3} ${g.shY - 3}Q${g.tx} ${g.shY + 4} ${CX + g.headW * 0.34} ${g.shY - 3}L${CX + g.headW * 0.36} ${g.shY + 1}Q${g.tx} ${g.shY + 8} ${CX - g.headW * 0.32} ${g.shY + 1}Z`, '#efe8d8', { stroke: OL, 'stroke-width': c.lw * 0.8 }));
        if (W.armor === 'doublet' && X.M.eq.armor) for (let i = 0; i < 6; i++) out.push(Cf(CX - g.ww + 4 + (i % 3) * g.ww * 0.35, g.shY + 16 + Math.floor(i / 3) * 12, 1.1, C.accH));
      } else {
        out.push(vneck(C.skin, 9), S(D`M${g.tx - 2} ${g.shY + 3}L${g.tx + 3} ${g.shY + 4}M${g.tx - 1} ${g.shY + 6}L${g.tx + 2.5} ${g.shY + 7}`, C.outD, 1));
      }
      if (fl.tabard) {
        const tw = g.ww * 0.62, top = g.shY + 7, bot = g.hipY + 24;
        const d = D`M${g.tx - tw} ${top}L${g.tx - tw - 1} ${bot}L${g.tx + 1} ${bot + 7}L${g.tx + tw + 2} ${bot}L${g.tx + tw} ${top}Q${g.tx} ${top + 4} ${g.tx - tw} ${top}Z`;
        out.push(shaded(c, d, C.out, [F(D`M${g.tx - tw - 4} ${top}H${g.tx - tw * 0.3}V${bot + 10}H${g.tx - tw - 4}Z`, C.outS)]));
        out.push(N('path', { d: d, fill: 'none', stroke: C.acc, 'stroke-width': 1.6, transform: D`translate(${g.tx} ${(top + bot) / 2}) scale(.84 .94) translate(${-g.tx} ${-(top + bot) / 2})` }));
        out.push(sun(c, g.tx + 0.5, g.shY + (g.waistY - g.shY) * 0.62, Math.min(6.5, tw * 0.36), C.acc));
      }
      out.push(...belt(beltY, a === 'plate' ? C.leaS : C.leaS));
    }
    if (fl.pouches) {
      out.push(P(c, D`M${CX - g.ww - 1} ${beltY + 2}h9v9q-4.5 2.5 -9 0Z`, C.lea), S(D`M${CX - g.ww - 1} ${beltY + 5}h9`, C.leaS, 1));
      out.push(P(c, D`M${CX + g.ww - 9} ${beltY + 2}h8v8q-4 2.5 -8 0Z`, C.lea));
    }
    if (W.trinket === 'charm') out.push(S(D`M${CX + g.ww - 3} ${beltY + 3}l1 7`, '#cbb98f', 1), P(c, D`M${CX + g.ww - 5} ${beltY + 10}q3 -2 5 1q1 5 -3 7q-4 -3 -2 -8Z`, '#d8cfc0'));
    return out;
  }
  function skirtHem(g, hem, flare, wave) {
    const l = CX - g.hpw - flare, r = CX + g.hpw + flare, n = Math.max(3, Math.round((r - l) / 11));
    let d = D`M${l} ${hem}`;
    for (let i = 0; i < n; i++) { const x0 = l + (r - l) * i / n, x1 = l + (r - l) * (i + 1) / n; d += D`Q${(x0 + x1) / 2} ${hem + (i % 2 ? -wave : wave)} ${x1} ${hem}`; }
    return d;
  }

  // shoulder pieces drawn over the torso and arms
  function shoulders(c, X, R) {
    const g = X.g, C = X.C, W = X.W, fl = X.fl, out = [];
    const paul = (s, side, col, big) => {
      const w = g.aw * (big ? 1.9 : 1.55), x = s[0] + side * 1, y = s[1] - 2;
      const d = D`M${x - w} ${y + w * 0.5}Q${x - w} ${y - w * 0.9} ${x} ${y - w * 0.95}Q${x + w} ${y - w * 0.9} ${x + w} ${y + w * 0.5}Q${x} ${y + w * 0.1} ${x - w} ${y + w * 0.5}Z`;
      const r = [shaded(c, d, col, [Ef(x - w * 0.7, y + w * 0.3, w * 0.6, w, shade(col, 0.3)), Ef(x + w * 0.3, y - w * 0.5, w * 0.4, w * 0.25, lite(col, 0.5))])];
      if (big) r.push(S(D`M${x - w * 0.95} ${y + w * 0.1}Q${x} ${y - w * 0.3} ${x + w * 0.95} ${y + w * 0.1}`, C.acc, 1.4));
      return r;
    };
    if (W.armor === 'plate') { out.push(...paul(R.near.s, -1, C.steel, true)); }
    else if (fl.pauldron) out.push(...paul(R.near.s, -1, C.steel, false));
    else if (W.armor === 'leather' && !fl.mantle) out.push(...paul(R.near.s, -1, C.leaS, false));
    else if (W.armor === 'doublet') out.push(P(c, D`M${R.near.s[0] - g.aw * 1.4} ${R.near.s[1] + 2}Q${R.near.s[0]} ${R.near.s[1] - g.aw * 2} ${R.near.s[0] + g.aw * 1.4} ${R.near.s[1] + 2}Q${R.near.s[0]} ${R.near.s[1] + g.aw * 1.2} ${R.near.s[0] - g.aw * 1.4} ${R.near.s[1] + 2}Z`, C.out), S(D`M${R.near.s[0] - 3} ${R.near.s[1] - 3}l1 6M${R.near.s[0] + 2} ${R.near.s[1] - 4}l0 6`, C.acc, 1.6));
    return out;
  }
  function farShoulder(c, X, R) {
    const g = X.g, C = X.C;
    if (X.W.armor !== 'plate') return [];
    const w = g.aw * 1.7, x = R.far.s[0] + 1, y = R.far.s[1] - 2;
    return [shaded(c, D`M${x - w} ${y + w * 0.5}Q${x - w} ${y - w * 0.9} ${x} ${y - w * 0.95}Q${x + w} ${y - w * 0.9} ${x + w} ${y + w * 0.5}Q${x} ${y + w * 0.1} ${x - w} ${y + w * 0.5}Z`, C.steel, [Ef(x + w * 0.3, y - w * 0.5, w * 0.5, w * 0.3, C.steelH)])];
  }

  // cloaks, mantles, hoods and straps worn over the shoulders (front)
  function drape(c, X) {
    const g = X.g, C = X.C, fl = X.fl, out = [];
    if (fl.cloak) {
      const col = fl.cloak === 'leaf' ? mix(C.out, '#3e5a32', 0.55) : mix(C.out, '#3d4a35', 0.5);
      const y = g.shY + 12, w = g.sw + 4;
      const d = D`M${CX - g.headW * 0.3} ${g.shY - 3}Q${CX - w - 2} ${g.shY - 1} ${CX - w} ${y + 4}Q${CX - w * 0.4} ${y + 10} ${g.tx} ${y + 2}Q${CX + w * 0.5} ${y + 9} ${CX + w} ${y + 3}Q${CX + w + 2} ${g.shY - 1} ${CX + g.headW * 0.32} ${g.shY - 3}Q${g.tx} ${g.shY + 4} ${CX - g.headW * 0.3} ${g.shY - 3}Z`;
      out.push(shaded(c, d, col, [Ef(CX - w, y, w * 0.5, 14, shade(col, 0.3))]));
      if (fl.cloak === 'leaf') for (let i = 0; i < 7; i++) {
        const t = i / 6, x = CX - w + t * w * 2, yy = y + 4 + Math.sin(t * Math.PI) * 4;
        out.push(P(c, D`M${x} ${yy - 1}q-4 4 0 9q4 -5 0 -9Z`, i % 2 ? '#6f9a4c' : '#86ad5a', { 'stroke-width': c.lw * 0.7 }));
      }
      out.push(Ci(c, g.tx, g.shY + 3, 3, fl.cloak === 'leaf' ? '#86ad5a' : C.acc));
    }
    if (fl.mantle) {
      const w = g.sw + 8, y = g.shY + 14;
      let d = D`M${CX - g.headW * 0.34} ${g.shY - 4}Q${CX - w} ${g.shY - 4} ${CX - w} ${y}`;
      const n = 9;
      for (let i = 0; i < n; i++) { const x0 = CX - w + (2 * w) * i / n, x1 = CX - w + (2 * w) * (i + 1) / n; d += D`L${(x0 + x1) / 2} ${y + 6 + (i % 2) * 3 - Math.sin((i + 0.5) / n * Math.PI) * 2}L${x1} ${y}`; }
      d += D`Q${CX + w} ${g.shY - 4} ${CX + g.headW * 0.36} ${g.shY - 4}Q${g.tx} ${g.shY + 5} ${CX - g.headW * 0.34} ${g.shY - 4}Z`;
      out.push(shaded(c, d, C.fur, [Ef(CX - w, y, w * 0.45, 14, shade(C.fur, 0.35)), S(D`M${CX - w * 0.6} ${y - 2}l2 6M${CX - w * 0.2} ${y}l1 6M${CX + w * 0.3} ${y - 1}l-1 6M${CX + w * 0.7} ${y - 3}l-2 6`, C.furH, 1.4)]));
      out.push(P(c, D`M${g.tx - 3} ${g.shY + 2}l3 7l3 -7Z`, '#efe6cf'));
    }
    if (fl.cowl) {
      const col = mix(C.out, '#1d1c22', 0.55), w = g.headW * 0.62;
      const d = D`M${CX - w - 6} ${g.shY + 6}Q${CX - w} ${g.shY - 6} ${CX - 2} ${g.shY - 4}Q${CX + w} ${g.shY - 6} ${CX + w + 6} ${g.shY + 5}Q${CX + w * 0.6} ${g.shY + 16} ${g.tx + 1} ${g.shY + 18}Q${CX - w * 0.6} ${g.shY + 16} ${CX - w - 6} ${g.shY + 6}Z`;
      out.push(shaded(c, d, col, [Ef(CX - w, g.shY + 10, w * 0.6, 10, shade(col, 0.35)), S(D`M${CX - w * 0.6} ${g.shY + 6}Q${g.tx} ${g.shY + 14} ${CX + w * 0.6} ${g.shY + 6}`, lite(col, 0.18), 1.4)]));
    }
    if (X.lk.hairStyle === 'hood') {
      const col = shade(C.out, 0.12), w = g.sw * 0.95;
      const d = D`M${CX - w} ${g.shY + 12}Q${CX - w - 1} ${g.shY - 3} ${CX - g.headW * 0.2} ${g.shY - 4}Q${g.tx} ${g.shY + 8} ${CX + g.headW * 0.4} ${g.shY - 4}Q${CX + w + 1} ${g.shY - 3} ${CX + w} ${g.shY + 12}Q${g.tx} ${g.shY + 22} ${CX - w} ${g.shY + 12}Z`;
      out.push(shaded(c, d, col, [Ef(CX - w, g.shY + 10, w * 0.5, 12, shade(col, 0.3))]));
    }
    if (fl.lute) out.push(S(D`M${CX - g.sw + 5} ${g.shY + 3}L${CX + g.ww + 1} ${g.hipY - 6}`, OL, 5.6), S(D`M${CX - g.sw + 5} ${g.shY + 3}L${CX + g.ww + 1} ${g.hipY - 6}`, '#8a3d2a', 3.4));
    if (fl.quiver) out.push(S(D`M${CX + g.sw - 6} ${g.shY + 3}L${CX - g.ww + 2} ${g.hipY - 8}`, OL, 5.2), S(D`M${CX + g.sw - 6} ${g.shY + 3}L${CX - g.ww + 2} ${g.hipY - 8}`, C.leaS, 3));
    // amulet / holy symbol
    const W = X.W;
    if (W.trinket === 'amulet' || fl.holy) {
      const y = g.shY + Math.min(16, (g.waistY - g.shY) * 0.5), x = g.tx + 1;
      out.push(S(D`M${x - g.headW * 0.24} ${g.shY}Q${x - 4} ${y - 2} ${x} ${y - 3}Q${x + 4} ${y - 2} ${x + g.headW * 0.26} ${g.shY}`, '#c9cfd4', 1));
      if (fl.holy) out.push(sun(c, x, y + 1, 3.6, C.acc === '#2f2f2f' ? '#d1a94f' : C.acc));
      if (W.trinket === 'amulet') {
        const ax = fl.holy ? x + 9 : x, ay = fl.holy ? y - 4 : y;
        out.push(P(c, D`M${ax} ${ay - 3.5}L${ax + 3.4} ${ay + 1}L${ax} ${ay + 5.5}L${ax - 3.4} ${ay + 1}Z`, '#d6dce0', { 'stroke-width': c.lw * 0.8 }), Cf(ax, ay + 1, 1.8, '#5fb0e8'), Cf(ax + 0.6, ay + 0.3, 0.6, '#ffffff'));
      }
    }
    return out;
  }

  // things behind the body: cloak backs, back hair, hoods, tail, lute, quiver, slung shield
  function backLayer(c, X, R) {
    const g = X.g, C = X.C, fl = X.fl, out = [];
    if (fl.cloak) {
      const col = fl.cloak === 'leaf' ? mix(C.out, '#3e5a32', 0.55) : mix(C.out, '#3d4a35', 0.5), inner = shade(col, 0.45);
      const hem = g.hipY + g.legLen * (fl.cloak === 'leaf' ? 0.82 : 0.62);
      const d = D`M${CX - g.sw - 2} ${g.shY + 6}Q${CX - g.sw - 16} ${(g.shY + hem) / 2} ${CX - g.sw - 18} ${hem}Q${CX - 8} ${hem + 6} ${CX + g.sw + 12} ${hem - 4}Q${CX + g.sw + 8} ${(g.shY + hem) / 2} ${CX + g.sw + 2} ${g.shY + 6}Z`;
      out.push(shaded(c, d, inner, [F(D`M${CX - g.sw - 30} ${g.shY}L${CX - g.sw - 4} ${g.shY}L${CX - g.sw - 6} ${hem + 10}L${CX - g.sw - 30} ${hem + 10}Z`, col)]));
      if (fl.cloak === 'leaf') for (let i = 0; i < 9; i++) {
        const t = i / 8, x = CX - g.sw - 18 + t * (g.sw * 2 + 30), y = hem + 1 - t * 4;
        out.push(P(c, D`M${x} ${y - 4}q-5 5 0 10q5 -5 0 -10Z`, i % 2 ? '#6f9a4c' : '#86ad5a', { 'stroke-width': c.lw * 0.7 }));
      }
      if (fl.cloak === 'ranger' && X.lk.hairStyle !== 'hood') out.push(shaded(c, D`M${g.hx - g.headW * 0.8} ${g.shY + 4}Q${g.hx - g.headW * 0.9} ${g.shY - 14} ${g.hx - g.headW * 0.2} ${g.shY - 10}Q${g.hx + g.headW * 0.3} ${g.shY - 8} ${g.hx + g.headW * 0.5} ${g.shY + 2}Z`, col, [Ef(g.hx - g.headW * 0.5, g.shY - 2, g.headW * 0.3, 6, shade(col, 0.3))]));
    }
    if (fl.mantle) {
      const w = g.sw + 10;
      out.push(P(c, D`M${CX - w} ${g.shY + 2}Q${CX} ${g.shY - 14} ${CX + w} ${g.shY + 2}L${CX + w - 2} ${g.shY + 24}L${CX - w + 2} ${g.shY + 24}Z`, shade(C.fur, 0.3)));
    }
    if (fl.cowl) {
      const col = mix(C.out, '#1d1c22', 0.55);
      out.push(P(c, D`M${g.hx - g.headW * 0.85} ${g.shY + 6}Q${g.hx - g.headW * 0.95} ${g.shY - 12} ${g.hx - g.headW * 0.2} ${g.shY - 8}L${g.hx} ${g.shY + 4}Z`, shade(col, 0.15)));
    }
    if (fl.shieldBack) {
      const k = X.W.shield;
      out.push(G(shieldArt(c, X, k), { transform: D`translate(${CX - g.sw * 0.4} ${g.waistY}) rotate(-12) scale(.9)` }));
    }
    if (fl.lute) {
      const bx = CX - g.sw * 0.55, by = g.waistY + 6, a = -24;
      const lute = [];
      lute.push(P(c, D`M2 -6L4 -66L-4 -66L-2 -6Z`, '#6b3f1f'), P(c, D`M-4.5 -66L5 -66L8 -80L-1 -78Z`, '#5a331a'));
      lute.push(S(D`M5 -70l4 -1M5.6 -74l4 -1M-3 -70l-4 -1`, '#e8e0d0', 1.4));
      lute.push(shaded(c, D`M0 -12C16 -12 19 6 16 18C12 30 -12 30 -16 18C-19 6 -16 -12 0 -12Z`, '#b06e34', [Ef(-9, 10, 10, 22, '#8a5226'), Ef(6, -2, 6, 8, '#cf8a4c', { opacity: 0.7 })]));
      lute.push(Ci(c, 0, 4, 4.6, '#2a1a10'), S(D`M-1 -10V22M1 -10V22`, '#efe7d2', 0.6));
      out.push(G(lute, { transform: D`translate(${bx} ${by}) rotate(${a}) scale(${g.k})` }));
    }
    if (fl.quiver) {
      const qx = CX - g.sw * 0.55, qy = g.shY + 2, k = g.k, q = [];
      [[-4, '#e8e0d0'], [0, '#b3402f'], [4, '#e8e0d0'], [-1.5, C.acc]].forEach((f, i) => {
        q.push(S(D`M${f[0]} -2L${f[0] + (i - 1.5) * 1.2} -18`, '#7a5536', 1.3), P(c, D`M${f[0] + (i - 1.5) * 1.2} -10l-2.6 -10l2.6 3l2.6 -3Z`, f[1], { 'stroke-width': 1 }));
      });
      q.push(shaded(c, D`M-7 -4H7L6 46H-6Z`, C.lea, [F('M-8 -6H-2V48H-8Z', C.leaS)]), P(c, 'M-7.5 -6H7.5V0H-7.5Z', C.leaS), S('M-6 20H6', C.acc, 1.6));
      out.push(G(q, { transform: D`translate(${qx} ${qy}) rotate(-22) scale(${k})` }));
    }
    if (X.race === 'Tiefling') {
      const s = [CX - g.hpw * 0.3, g.hipY - 4], e = [CX - g.hpw - 30, g.hipY + g.legLen * 0.25];
      const d = D`M${s[0]} ${s[1]}C${CX - g.hpw - 6} ${g.hipY + 34} ${CX - g.hpw - 40} ${GY - 4} ${CX - g.hpw - 38} ${g.hipY + g.legLen * 0.55}S${e[0] - 6} ${e[1] + 8} ${e[0]} ${e[1]}`;
      out.push(S(d, OL, 4.6 + c.lw * 2), S(d, X.C.skin, 4.6), S(d, X.C.skinS, 1.2, { opacity: 0.7, transform: 'translate(1 1)' }));
      out.push(P(c, D`M${e[0] - 1} ${e[1] + 4}Q${e[0] - 9} ${e[1] + 1} ${e[0] - 2} ${e[1] - 12}Q${e[0] + 9} ${e[1] - 1} ${e[0] + 3} ${e[1] + 4}Q${e[0] + 1} ${e[1] + 1} ${e[0] - 1} ${e[1] + 4}Z`, X.C.skinS));
    }
    out.push(...hairBack(c, X));
    return out;
  }

  // ------------------------------------------------------------------ head

  function hairCap(g, vol, front) {
    // a hair mass hugging the cranium; vol = how far it stands off the skull
    const L = g.L, R = g.R, top = g.crown, h = g.headH, w = g.headW, v = vol;
    return D`M${L - v * 0.6 + 1} ${g.eyeY + h * 0.1}` +
      D`C${L - v - 3} ${top - h * 0.14 - v} ${R - w * 0.1 + v} ${top - h * 0.2 - v * 1.2} ${R + v * 0.5} ${top + h * (front ? 0.36 : 0.3)}` +
      D`Q${R - w * 0.12} ${top + h * 0.2} ${g.fx - w * 0.02} ${top + h * 0.3}` +
      D`Q${g.fx - w * 0.22} ${top + h * 0.2} ${g.hx - w * 0.26} ${top + h * 0.33}` +
      D`Q${L + w * 0.14} ${top + h * 0.38} ${L + w * 0.16} ${g.eyeY - h * 0.02}Z`;
  }
  function hairBack(c, X) {
    const g = X.g, C = X.C, st = X.lk.hairStyle, out = [];
    if (X.race === 'Dragonborn') return out;
    const L = g.L, R = g.R, top = g.crown, h = g.headH, w = g.headW;
    if (st === 'long') {
      const bot = g.shY + (g.waistY - g.shY) * 0.75;
      const d = D`M${g.hx} ${top - 2}C${L - w * 0.3} ${top - 2} ${L - w * 0.35} ${g.eyeY} ${L - w * 0.3} ${g.chin}Q${L - w * 0.38} ${bot - 10} ${L - w * 0.1} ${bot}Q${g.hx} ${bot + 6} ${R + w * 0.12} ${bot - 6}Q${R + w * 0.22} ${g.chin} ${R + w * 0.1} ${g.eyeY}C${R} ${top} ${g.hx + w * 0.2} ${top - 2} ${g.hx} ${top - 2}Z`;
      out.push(shaded(c, d, C.hairS, [S(D`M${L - w * 0.1} ${g.chin}Q${L - w * 0.15} ${bot - 8} ${L + w * 0.05} ${bot}M${R} ${g.chin}Q${R + w * 0.1} ${bot - 10} ${R - w * 0.05} ${bot - 4}`, shade(C.hairS, 0.3), 1.4)]));
    } else if (st === 'ponytail') {
      const a = [L + w * 0.05, top + h * 0.4];
      const d = D`M${a[0] + 3} ${a[1] - 4}C${L - w * 0.6} ${a[1] - 2} ${L - w * 0.5} ${g.shY + 10} ${L - w * 0.15} ${g.shY + 26}C${L - w * 0.2} ${g.shY + 8} ${L - w * 0.25} ${a[1] + 10} ${a[0] + 2} ${a[1] + 6}Z`;
      out.push(shaded(c, d, C.hair, [S(D`M${L - w * 0.2} ${a[1] + 6}Q${L - w * 0.4} ${g.shY} ${L - w * 0.2} ${g.shY + 20}`, C.hairS, 1.2)]));
    } else if (st === 'braid') {
      // the braid itself is drawn in front (over the shoulder); add a little back volume
      out.push(P(c, D`M${L - 1} ${g.eyeY}Q${L - w * 0.15} ${g.chin} ${L + w * 0.1} ${g.chin + 4}L${L + w * 0.3} ${g.eyeY}Z`, C.hairS));
    } else if (st === 'curly' || (X.race === 'Halfling' && st === 'short')) {
      out.push(Ef(g.hx - w * 0.06, top + h * 0.42, w * 0.66, h * 0.52, C.hairS, { stroke: OL, 'stroke-width': c.lw }));
    } else if (st === 'hood') {
      const col = shade(C.out, 0.12);
      out.push(P(c, hoodOuter(g), shade(col, 0.55)));
    }
    return out;
  }
  function hoodOuter(g) {
    const L = g.L, R = g.R, top = g.crown, h = g.headH, w = g.headW;
    return D`M${R + w * 0.16} ${g.chin + 6}Q${R + w * 0.3} ${g.eyeY} ${R + w * 0.1} ${top + h * 0.1}Q${g.hx} ${top - h * 0.22} ${L - w * 0.12} ${top + h * 0.06}Q${L - w * 0.36} ${top + h * 0.2} ${L - w * 0.3} ${g.eyeY}Q${L - w * 0.3} ${g.chin} ${L - w * 0.2} ${g.chin + 8}Q${g.hx} ${g.chin + 14} ${R + w * 0.16} ${g.chin + 6}Z`;
  }

  function headPath(X) {
    const g = X.g, L = g.L, R = g.R, top = g.crown, h = g.headH, w = g.headW;
    const jaw = X.race === 'Half-Orc' || X.race === 'Dwarf' ? 0.12 : g.masc ? 0.06 : g.fem ? -0.04 : 0.02;
    const chx = g.hx + w * 0.12;
    return D`M${g.hx - w * 0.05} ${top}C${R - w * 0.05} ${top} ${R + 1} ${top + h * 0.22} ${R} ${g.eyeY - h * 0.04}` +
      D`C${R - 0.5} ${g.eyeY + h * (0.2 + jaw)} ${chx + w * (0.24 + jaw)} ${g.chin - 1 - jaw * 10} ${chx} ${g.chin}` +
      D`C${chx - w * (0.3 + jaw)} ${g.chin + 0.5} ${L + w * (0.1 - jaw * 0.5)} ${g.eyeY + h * (0.32 + jaw)} ${L} ${g.eyeY - h * 0.02}` +
      D`C${L - 1.5} ${top + h * 0.2} ${g.hx - w * 0.42} ${top} ${g.hx - w * 0.05} ${top}Z`;
  }

  function ear(c, X, near) {
    const g = X.g, C = X.C, out = [], race = X.race;
    const pointy = race === 'Elf' ? 1 : race === 'Gnome' ? 0.55 : race === 'Tiefling' ? 0.45 : race === 'Half-Orc' ? 0.3 : 0;
    const bx = near ? g.L + g.headW * 0.16 : g.R - g.headW * 0.06, by = g.eyeY + g.headH * 0.05, eh = g.headH * 0.13, s = near ? -1 : 1;
    if (!pointy) {
      out.push(P(c, D`M${bx + 2 * s * -1} ${by - eh}Q${bx + s * eh * 0.9} ${by - eh * 1.1} ${bx + s * eh * 0.75} ${by}Q${bx + s * eh * 0.6} ${by + eh} ${bx} ${by + eh * 0.9}Z`, C.skin));
      out.push(S(D`M${bx + s * eh * 0.15} ${by - eh * 0.5}Q${bx + s * eh * 0.55} ${by - eh * 0.4} ${bx + s * eh * 0.35} ${by + eh * 0.4}`, C.skinS, 1.1));
      return out;
    }
    const tx = bx + s * g.headW * (0.15 + 0.42 * pointy), ty = by - eh - g.headH * 0.36 * pointy;
    const d = D`M${bx - s * 1} ${by - eh * 0.9}Q${bx + s * g.headW * 0.12} ${by - eh * 1.3} ${tx} ${ty}Q${bx + s * g.headW * 0.2} ${by - eh * 0.2} ${bx + s * eh * 0.4} ${by + eh * 0.6}Q${bx + s * eh * 0.1} ${by + eh * 1.05} ${bx - s * 0.5} ${by + eh * 0.8}Z`;
    out.push(shaded(c, d, C.skin, [S(D`M${bx + s * 2} ${by - eh * 0.4}Q${bx + s * g.headW * 0.14} ${by - eh * 0.9} ${tx - s * 3} ${ty + 4}`, C.skinS, 1.6)]));
    return out;
  }

  function eye(c, X, x, y, w, far, id) {
    const C = X.C, out = [], h = w * 0.78, down = X.down;
    const lift = X.race === 'Elf' ? w * 0.35 : 0;
    if (down) {
      out.push(S(D`M${x - w} ${y}Q${x} ${y + h * 0.9} ${x + w} ${y - lift * 0.5}`, OL, 1.5));
      return out;
    }
    const d = D`M${x - w} ${y + lift * 0.2}Q${x - w * 0.1} ${y - h * 1.25} ${x + w} ${y - h * 0.15 - lift}Q${x + w * 0.1} ${y + h * 1.05} ${x - w} ${y + lift * 0.2}Z`;
    const tief = X.race === 'Tiefling';
    c.defs.push(N('clipPath', { id: id }, [N('path', { d: d })]));
    const iris = tief ? lite(C.eyes, 0.25) : C.eyes;
    out.push(F(d, tief ? iris : '#f3ede1'));
    const ix = x + (far ? w * 0.18 : w * 0.12);
    out.push(N('g', { 'clip-path': 'url(#' + id + ')' }, tief
      ? [Ef(x, y + h * 0.4, w * 1.2, h * 0.5, shade(iris, 0.3))]
      : [Cf(ix, y, h * 0.92, iris), Cf(ix, y, h * 0.92, 'none', { stroke: shade(iris, 0.45), 'stroke-width': 0.7 }), Cf(ix + 0.2, y, h * 0.45, '#120c0a'), Ef(x, y - h * 0.9, w * 1.2, h * 0.45, '#000', { opacity: 0.18 })]));
    if (tief) out.push(Ef(x, y - h * 0.1, w * 1.3, h * 1.1, iris, { opacity: 0.25 }));
    out.push(Cf(ix + w * 0.28, y - h * 0.35, Math.max(0.6, h * 0.26), '#ffffff'));
    out.push(S(D`M${x - w * 1.08} ${y + lift * 0.2 + 0.3}Q${x - w * 0.1} ${y - h * 1.3} ${x + w * 1.05} ${y - h * 0.15 - lift}`, OL, Math.max(1.2, w * 0.38)));
    if (X.g.fem && !far) out.push(S(D`M${x + w * 1.02} ${y - h * 0.15 - lift}l${w * 0.45} ${-h * 0.45}`, OL, 1.1));
    return out;
  }

  function face(c, X) {
    const g = X.g, C = X.C, lk = X.lk, out = [], race = X.race, w = g.headW, h = g.headH;
    const ew = w * (race === 'Elf' ? 0.115 : race === 'Halfling' || race === 'Gnome' ? 0.12 : 0.105);
    const e1 = [g.fx - w * 0.25, g.eyeY], e2 = [g.fx + w * 0.17, g.eyeY - 0.3];
    const ready = X.pose === 'ready';
    // blush and cheek light
    out.push(Ef(e1[0] - 1, g.eyeY + h * 0.17, w * 0.12, h * 0.05, '#e0705e', { opacity: g.fem ? 0.28 : 0.16 }));
    out.push(Ef(e2[0] + 1, g.eyeY + h * 0.16, w * 0.07, h * 0.04, '#e0705e', { opacity: g.fem ? 0.22 : 0.1 }));
    if (lk.mark === 'warpaint') {
      const wp = C.acc === '#2f2f2f' || C.acc === '#c0c0c0' ? '#a3262a' : mix(C.acc, '#a3262a', 0.6);
      out.push(F(D`M${g.L + 2} ${g.eyeY - h * 0.08}L${g.R + 1} ${g.eyeY - h * 0.12}L${g.R} ${g.eyeY + h * 0.06}L${g.L + 3} ${g.eyeY + h * 0.1}Z`, wp, { opacity: 0.85 }));
      out.push(F(D`M${e1[0] - 2} ${g.eyeY + h * 0.12}l2 ${h * 0.14}l2 ${-h * 0.14}Z`, wp, { opacity: 0.85 }));
    }
    if (lk.mark === 'tattoo') {
      const tc = '#24506a';
      out.push(S(D`M${e1[0] - w * 0.1} ${g.eyeY + h * 0.12}l${w * 0.08} ${h * 0.07}l${w * 0.08} ${-h * 0.07}M${e1[0] - w * 0.06} ${g.eyeY + h * 0.2}l${w * 0.05} ${h * 0.05}l${w * 0.05} ${-h * 0.05}`, tc, 1.2, { opacity: 0.9 }));
      out.push(S(D`M${g.fx - w * 0.06} ${g.crown + h * 0.36}l0 ${-h * 0.06}M${g.fx - w * 0.11} ${g.crown + h * 0.34}l${w * 0.1} 0`, tc, 1.2, { opacity: 0.9 }));
    }
    out.push(...eye(c, X, e1[0], e1[1], ew, false, c.id('e')));
    if (lk.mark !== 'eyepatch') out.push(...eye(c, X, e2[0], e2[1], ew * 0.8, true, c.id('e')));
    // brows
    const bw = race === 'Dwarf' ? 2.8 : g.masc ? 2.2 : 1.6, by = g.eyeY - h * 0.12;
    const tilt = ready ? 1.6 : 0;
    if (race !== 'Dragonborn') {
      out.push(S(D`M${e1[0] - ew * 1.2} ${by + 0.5 - tilt * 0.3}Q${e1[0]} ${by - h * 0.05} ${e1[0] + ew * 1.1} ${by + tilt}`, C.brow, bw));
      out.push(S(D`M${e2[0] - ew * 0.8} ${by + tilt}Q${e2[0] + ew * 0.2} ${by - h * 0.05} ${e2[0] + ew * 1} ${by - 0.2 - tilt * 0.3}`, C.brow, bw * 0.85));
    }
    // nose
    const ny = g.eyeY + h * 0.2;
    if (race === 'Gnome') {
      const nx = g.fx + w * 0.07, nyy = ny - h * 0.03, rx = w * 0.14, ry = h * 0.085;
      out.push(shaded(c, D`M${nx - rx} ${nyy}A${rx} ${ry} 0 1 1 ${nx + rx} ${nyy}A${rx} ${ry} 0 1 1 ${nx - rx} ${nyy}Z`, mix(C.skin, '#d0705a', 0.22), [Ef(nx - rx * 0.6, nyy + ry * 0.4, rx * 0.8, ry * 0.8, C.skinS, { opacity: 0.8 })]));
      out.push(Ef(nx + rx * 0.3, nyy - ry * 0.35, rx * 0.3, ry * 0.22, '#ffffff', { opacity: 0.55 }));
    } else if (race === 'Half-Orc') {
      out.push(S(D`M${g.fx} ${g.eyeY + 1}Q${g.fx + w * 0.08} ${ny - h * 0.02} ${g.fx + w * 0.07} ${ny + h * 0.02}Q${g.fx} ${ny + h * 0.06} ${g.fx - w * 0.1} ${ny + h * 0.02}`, C.skinD, 1.5));
      out.push(Cf(g.fx - w * 0.04, ny + h * 0.02, 1.1, C.skinD));
    } else {
      const big = race === 'Dwarf' ? 1.4 : 1;
      out.push(F(D`M${g.fx + w * 0.02} ${g.eyeY}Q${g.fx + w * 0.1 * big} ${ny - h * 0.03} ${g.fx + w * 0.09 * big} ${ny + h * 0.01}Q${g.fx + w * 0.02} ${ny + h * 0.05} ${g.fx - w * 0.06 * big} ${ny + h * 0.025}Q${g.fx - w * 0.02} ${ny - h * 0.04} ${g.fx + w * 0.02} ${g.eyeY}Z`, C.skinS, { opacity: 0.55 }));
      out.push(S(D`M${g.fx + w * 0.03} ${g.eyeY + h * 0.02}Q${g.fx + w * 0.1 * big} ${ny - h * 0.02} ${g.fx + w * 0.08 * big} ${ny + h * 0.01}Q${g.fx + w * 0.03} ${ny + h * 0.045} ${g.fx - w * 0.04 * big} ${ny + h * 0.02}`, C.skinD, 1.2));
    }
    // marks on top of skin
    if (lk.mark === 'freckles') {
      [[-0.3, 0.13], [-0.22, 0.17], [-0.14, 0.12], [-0.33, 0.2], [-0.08, 0.16], [0.18, 0.13], [0.24, 0.17], [0.12, 0.17], [0.0, 0.1], [0.05, 0.13]].forEach((q) => out.push(Cf(g.fx + w * q[0], g.eyeY + h * q[1], 0.75, C.skinD, { opacity: 0.6 })));
    }
    if (lk.mark === 'scar') {
      const a = [e1[0] - ew * 1.6, g.eyeY - h * 0.2], b = [e1[0] + ew * 0.9, g.eyeY + h * 0.2];
      out.push(S(D`M${a[0]} ${a[1]}L${b[0]} ${b[1]}`, mix(C.skin, '#f6d6cc', 0.55), 1.8), S(D`M${a[0]} ${a[1]}L${b[0]} ${b[1]}`, mix(C.skin, '#9a4a46', 0.5), 0.7));
      for (let i = 1; i < 4; i++) { const p = lerp(a, b, i / 4); out.push(S(D`M${p[0] - 1.6} ${p[1] + 1}l3.2 -2`, mix(C.skin, '#9a4a46', 0.5), 0.7)); }
    }
    if (lk.mark === 'eyepatch') {
      out.push(S(D`M${g.L + 1} ${g.eyeY - h * 0.18}L${g.R + 0.5} ${g.crown + h * 0.3}`, '#1a1210', 1.6));
      out.push(P(c, D`M${e1[0] - ew * 1.3} ${g.eyeY - h * 0.08}Q${e1[0]} ${g.eyeY - h * 0.14} ${e1[0] + ew * 1.3} ${g.eyeY - h * 0.08}Q${e1[0] + ew * 1.2} ${g.eyeY + h * 0.12} ${e1[0]} ${g.eyeY + h * 0.12}Q${e1[0] - ew * 1.2} ${g.eyeY + h * 0.1} ${e1[0] - ew * 1.3} ${g.eyeY - h * 0.08}Z`, '#221816', { 'stroke-width': 1 }));
      out.push(...eye(c, X, e2[0], e2[1], ew * 0.8, true, c.id('e')));
    }
    // mouth
    const mx = g.fx - w * 0.02, my = g.crown + h * 0.81, mw = w * (race === 'Half-Orc' ? 0.15 : 0.11);
    if (g.fem && !X.down) out.push(F(D`M${mx - mw * 0.75} ${my + 0.3}Q${mx} ${my + 3.4} ${mx + mw * 0.7} ${my}Z`, mix(C.skin, '#b04a4a', 0.4)));
    if (X.down) out.push(S(D`M${mx - mw * 0.6} ${my + 1}Q${mx} ${my - 1} ${mx + mw * 0.6} ${my + 1}`, C.skinD, 1.3));
    else if (ready) out.push(S(D`M${mx - mw} ${my}L${mx + mw * 0.8} ${my - 0.4}`, C.skinD, 1.4));
    else out.push(S(D`M${mx - mw} ${my - 0.6}Q${mx - mw * 0.1} ${my + 2} ${mx + mw * 0.85} ${my - 1}`, C.skinD, 1.35));
    return out;
  }

  function beard(c, X) {
    const g = X.g, C = X.C, b = X.lk.beard, out = [];
    if (b === 'none' || X.race === 'Dragonborn') return out;
    const w = g.headW, h = g.headH, dw = X.race === 'Dwarf';
    const chx = g.hx + w * 0.12, my = g.crown + h * 0.81;
    if (b === 'stubble') {
      const d = D`M${g.L + w * 0.14} ${g.eyeY + h * 0.06}Q${g.L + w * 0.12} ${g.chin - h * 0.05} ${chx} ${g.chin + 0.5}Q${g.R} ${g.chin - h * 0.15} ${g.R - 0.5} ${g.eyeY + h * 0.12}Q${g.fx + w * 0.1} ${my - h * 0.1} ${g.fx} ${my - h * 0.08}Q${g.fx - w * 0.2} ${my - h * 0.1} ${g.L + w * 0.3} ${g.eyeY + h * 0.16}Z`;
      out.push(F(d, C.hair, { opacity: 0.3 }));
      return out;
    }
    const len = b === 'short' ? (dw ? 0.42 : 0.14) : (dw ? 0.95 : 0.55) * (b === 'braided' ? 0.75 : 1);
    const wide = dw ? 0.22 : 0.06;
    const by = g.chin + h * len;
    const d = D`M${g.L + w * 0.14} ${g.eyeY + h * 0.02}` +
      D`Q${g.L - w * wide} ${g.chin - h * 0.05} ${chx - w * (0.16 + wide)} ${by - h * 0.06}` +
      D`Q${chx} ${by + h * 0.06} ${chx + w * (0.16 + wide * 0.6)} ${by - h * 0.08}` +
      D`Q${g.R + w * wide * 0.6} ${g.chin - h * 0.1} ${g.R - 0.5} ${g.eyeY + h * 0.12}` +
      D`Q${g.fx + w * 0.16} ${my} ${g.fx + w * 0.02} ${my + h * 0.06}Q${g.fx - w * 0.16} ${my + h * 0.04} ${g.L + w * 0.32} ${g.eyeY + h * 0.18}Z`;
    out.push(shaded(c, d, C.hair, [Ef(g.L + w * 0.1, g.chin, w * 0.3, h * 0.5, C.hairS), S(D`M${chx - w * 0.08} ${g.chin}Q${chx - w * 0.1} ${by - h * 0.1} ${chx - w * 0.04} ${by - h * 0.04}M${chx + w * 0.08} ${g.chin}Q${chx + w * 0.1} ${by - h * 0.12} ${chx + w * 0.08} ${by - h * 0.06}`, C.hairH, 1, { opacity: 0.7 })]));
    if (b === 'braided') {
      const n = dw ? 2 : 1;
      for (let j = 0; j < n; j++) {
        const x0 = n === 1 ? chx : chx + (j ? 1 : -1) * w * 0.14;
        for (let i = 0; i < 3; i++) out.push(Ef(x0, by + i * h * 0.12, w * 0.08, h * 0.075, C.hair, { stroke: OL, 'stroke-width': c.lw * 0.8 }));
        out.push(P(c, D`M${x0 - w * 0.07} ${by + h * 0.2}h${w * 0.14}v${h * 0.05}h${-w * 0.14}Z`, C.acc, { 'stroke-width': 0.8 }));
        out.push(P(c, D`M${x0 - w * 0.05} ${by + h * 0.25}L${x0} ${by + h * 0.36}L${x0 + w * 0.05} ${by + h * 0.25}Z`, C.hair, { 'stroke-width': 0.8 }));
      }
    }
    // moustache
    const m = D`M${g.fx - w * 0.2} ${my + h * 0.01}Q${g.fx - w * 0.16} ${my - h * 0.1} ${g.fx} ${my - h * 0.08}Q${g.fx + w * 0.16} ${my - h * 0.1} ${g.fx + w * 0.17} ${my + h * 0.01}Q${g.fx + w * 0.06} ${my - h * 0.03} ${g.fx} ${my - h * 0.03}Q${g.fx - w * 0.1} ${my - h * 0.03} ${g.fx - w * 0.2} ${my + h * 0.01}Z`;
    out.push(P(c, m, C.hair, { 'stroke-width': c.lw * 0.8 }));
    out.push(S(D`M${g.fx - w * 0.06} ${my + h * 0.02}Q${g.fx} ${my + h * 0.04} ${g.fx + w * 0.07} ${my + h * 0.015}`, C.skinD, 1.1));
    return out;
  }

  function hairFront(c, X) {
    const g = X.g, C = X.C, st = X.lk.hairStyle, out = [], w = g.headW, h = g.headH;
    const curly = st === 'curly' || (X.race === 'Halfling' && st === 'short');
    const hs = [S(D`M${g.L + w * 0.1} ${g.crown + h * 0.3}Q${g.hx - w * 0.1} ${g.crown + h * 0.05} ${g.R - w * 0.1} ${g.crown + h * 0.12}`, C.hairH, 1.6, { opacity: 0.7 }), Ef(g.L, g.eyeY - h * 0.08, w * 0.3, h * 0.3, C.hairS)];
    if (st === 'bald') {
      out.push(Ef(g.hx + w * 0.1, g.crown + h * 0.13, w * 0.18, h * 0.06, '#ffffff', { opacity: 0.25 }));
    } else if (curly) {
      const n = 9;
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1), a = Math.PI * (1.05 + t * 0.95), x = g.hx - w * 0.04 + Math.cos(a) * w * 0.56, y = g.crown + h * 0.4 + Math.sin(a) * h * 0.5;
        out.push(Ci(c, x, y, w * 0.15, i % 2 ? C.hair : lite(C.hair, 0.06)), S(D`M${x - w * 0.06} ${y + 1}q${w * 0.06} ${-w * 0.07} ${w * 0.1} 0`, C.hairS, 1));
      }
      out.push(Ci(c, g.hx + w * 0.06, g.crown + h * 0.08, w * 0.16, C.hair), Ci(c, g.hx - w * 0.2, g.crown + h * 0.06, w * 0.15, C.hair));
    } else if (st === 'mohawk') {
      out.push(F(hairCap(g, 0.5, false), C.hair, { opacity: 0.32 }));
      let d = D`M${g.R - w * 0.12} ${g.crown + h * 0.18}`;
      const pts = 5;
      for (let i = 0; i <= pts; i++) {
        const t = i / pts, a = Math.PI * (1.62 - t * 0.6), x = g.hx - w * 0.04 + Math.cos(a) * w * 0.48, y = g.crown + h * 0.42 + Math.sin(a) * h * 0.46;
        const ox = Math.cos(a) * h * 0.32, oy = Math.sin(a) * h * 0.32;
        d += D`L${x + ox} ${y + oy}L${x + Math.cos(a - 0.12) * 4} ${y + Math.sin(a - 0.12) * 4}`;
      }
      d += D`L${g.L + w * 0.14} ${g.crown + h * 0.4}Q${g.hx} ${g.crown + h * 0.02} ${g.R - w * 0.12} ${g.crown + h * 0.18}Z`;
      out.push(shaded(c, d, C.hair, [Ef(g.hx - w * 0.4, g.crown, w * 0.3, h * 0.4, C.hairS)]));
    } else if (st === 'hood') {
      const col = shade(C.out, 0.12), inner = D`M${g.fx - w * 0.06 - w * 0.44} ${g.eyeY + h * 0.1}a${w * 0.44} ${h * 0.56} 0 1 0 ${w * 0.88} 0a${w * 0.44} ${h * 0.56} 0 1 0 ${-w * 0.88} 0Z`;
      const outer = hoodOuter(g);
      const id = c.id('k');
      c.defs.push(N('clipPath', { id: id }, [N('path', { d: outer + inner, 'clip-rule': 'evenodd' })]));
      out.push(N('g', {}, [F(outer + inner, col, { 'fill-rule': 'evenodd' }),
        N('g', { 'clip-path': 'url(#' + id + ')' }, [Ef(g.L - w * 0.2, g.eyeY, w * 0.4, h * 0.8, shade(col, 0.3)), Ef(g.hx + w * 0.1, g.crown - h * 0.05, w * 0.3, h * 0.08, lite(col, 0.2))]),
        N('path', { d: outer + inner, fill: 'none', stroke: OL, 'stroke-width': c.lw, 'fill-rule': 'evenodd' })]));
      out.push(N('path', { d: inner, fill: 'none', stroke: shade(col, 0.6), 'stroke-width': 2.4, opacity: 0.5, transform: D`translate(${g.fx - w * 0.06} ${g.eyeY + h * 0.1}) scale(.97) translate(${-(g.fx - w * 0.06)} ${-(g.eyeY + h * 0.1)})` }));
    } else {
      const vol = st === 'cropped' || st === 'topknot' ? 0.6 : st === 'ponytail' ? 1.4 : st === 'long' || st === 'braid' ? 2.4 : 3;
      const d = hairCap(g, vol, st !== 'cropped');
      out.push(shaded(c, d, C.hair, st === 'cropped' ? [Ef(g.L, g.eyeY, w * 0.3, h * 0.3, C.hairS)] : hs));
      if (st === 'cropped') out.push(F(d, '#ffffff', { opacity: 0.06 }));
      if (st === 'short') out.push(P(c, D`M${g.R + 1} ${g.crown + h * 0.3}Q${g.R - w * 0.2} ${g.crown + h * 0.14} ${g.fx - w * 0.1} ${g.crown + h * 0.38}Q${g.fx + w * 0.05} ${g.crown + h * 0.18} ${g.R + 1} ${g.crown + h * 0.3}Z`, C.hair, { 'stroke-width': c.lw * 0.8 }));
      if (st === 'long') {
        // locks framing the face
        out.push(shaded(c, D`M${g.L + w * 0.02} ${g.eyeY - h * 0.15}Q${g.L - w * 0.18} ${g.chin} ${g.L + w * 0.05} ${g.shY + 16}Q${g.L + w * 0.12} ${g.chin} ${g.L + w * 0.25} ${g.eyeY - h * 0.05}Z`, C.hair, [Ef(g.L, g.chin, w * 0.15, h * 0.5, C.hairS)]));
        out.push(P(c, D`M${g.R + 1} ${g.crown + h * 0.3}Q${g.R + w * 0.15} ${g.eyeY + h * 0.2} ${g.R + w * 0.06} ${g.chin + 4}Q${g.R - w * 0.02} ${g.eyeY} ${g.R - w * 0.08} ${g.crown + h * 0.3}Z`, C.hair, { 'stroke-width': c.lw * 0.8 }));
      }
      if (st === 'topknot') {
        out.push(Ci(c, g.hx - w * 0.1, g.crown - h * 0.06, w * 0.21, C.hair), S(D`M${g.hx - w * 0.26} ${g.crown - h * 0.08}Q${g.hx - w * 0.1} ${g.crown - h * 0.2} ${g.hx + w * 0.06} ${g.crown - h * 0.08}`, C.hairH, 1.2), P(c, D`M${g.hx - w * 0.22} ${g.crown + h * 0.06}Q${g.hx - w * 0.1} ${g.crown + h * 0.02} ${g.hx + w * 0.02} ${g.crown + h * 0.06}L${g.hx + w * 0.01} ${g.crown + h * 0.1}Q${g.hx - w * 0.1} ${g.crown + h * 0.06} ${g.hx - w * 0.21} ${g.crown + h * 0.1}Z`, C.acc, { 'stroke-width': 0.9 }));
      }
      if (st === 'ponytail') out.push(P(c, D`M${g.L + w * 0.02} ${g.crown + h * 0.32}l5 -2l1 6l-5 2Z`, C.acc, { 'stroke-width': 0.9 }));
      if (st === 'braid') {
        const x0 = g.L + w * 0.1, y0 = g.eyeY + h * 0.05, n = 6;
        for (let i = 0; i < n; i++) {
          const t = i / (n - 1), x = x0 - w * 0.06 + Math.sin(t * 2) * w * 0.05, y = y0 + t * (g.waistY - g.shY + h * 0.4) * 0.8;
          out.push(Ef(x, y, w * 0.11 * (1 - t * 0.25), h * 0.1, i % 2 ? C.hair : lite(C.hair, 0.05), { stroke: OL, 'stroke-width': c.lw * 0.8 }));
          if (i === n - 1) out.push(P(c, D`M${x - 2.5} ${y + h * 0.08}h5v3h-5Z`, C.acc, { 'stroke-width': 0.8 }), P(c, D`M${x - 3} ${y + h * 0.08 + 3}L${x} ${y + h * 0.26}L${x + 3} ${y + h * 0.08 + 3}Z`, C.hair, { 'stroke-width': 0.8 }));
        }
      }
    }
    return out;
  }

  function horns(c, X, small) {
    const g = X.g, w = g.headW, h = g.headH, out = [];
    const col = '#3d2b2b', tip = '#9a8476';
    const gr = grad(c, 'linearGradient', [[0, col], [1, tip]], { x1: 0, y1: 1, x2: 0.3, y2: 0 });
    if (small) {
      [[g.fx - w * 0.28, 1], [g.fx + w * 0.18, 0.8]].forEach((q) => {
        const x = q[0], y = g.crown + h * 0.2, s = q[1];
        out.push(P(c, D`M${x - 3 * s} ${y + 2}Q${x - 2 * s} ${y - 7 * s} ${x + 2 * s} ${y - 9 * s}Q${x + 1 * s} ${y - 3 * s} ${x + 3 * s} ${y + 2}Z`, gr, { 'stroke-width': c.lw * 0.8 }));
      });
      return out;
    }
    const near = D`M${g.hx - w * 0.28} ${g.crown + h * 0.16}C${g.hx - w * 0.5} ${g.crown - h * 0.2} ${g.L - w * 0.5} ${g.crown - h * 0.2} ${g.L - w * 0.42} ${g.crown + h * 0.32}C${g.L - w * 0.38} ${g.crown + h * 0.06} ${g.hx - w * 0.36} ${g.crown + h * 0.04} ${g.hx - w * 0.08} ${g.crown + h * 0.2}Z`;
    const far = D`M${g.fx + w * 0.06} ${g.crown + h * 0.14}C${g.fx + w * 0.1} ${g.crown - h * 0.2} ${g.R + w * 0.15} ${g.crown - h * 0.22} ${g.R + w * 0.2} ${g.crown + h * 0.04}C${g.R} ${g.crown - h * 0.06} ${g.fx + w * 0.26} ${g.crown} ${g.fx + w * 0.26} ${g.crown + h * 0.18}Z`;
    out.push(P(c, far, gr), P(c, near, gr));
    out.push(S(D`M${g.hx - w * 0.36} ${g.crown + h * 0.06}l-2 3M${g.hx - w * 0.5} ${g.crown}l-1 4M${g.L - w * 0.1} ${g.crown + h * 0.02}l0 4`, '#1e1414', 1, { opacity: 0.6 }));
    return out;
  }

  function dragonHead(c, X) {
    const g = X.g, C = X.C, w = g.headW, h = g.headH, top = g.crown, out = [];
    const frill = mix(C.hair, C.skin, 0.25), frillS = shade(frill, 0.35);
    // frills behind the head
    [[0.62, -0.95, 0.1], [0.74, -1.05, 0.38], [0.86, -0.85, 0.62]].forEach((q, i) => {
      const bx = g.hx - w * 0.3, by = top + h * q[0];
      const tx = g.hx + w * q[1], ty = top + h * (q[2] - 0.08 * i) + h * 0.05;
      out.push(P(c, D`M${bx} ${by - h * 0.1}L${tx} ${ty}Q${tx + w * 0.2} ${ty + h * 0.18} ${bx + 2} ${by + h * 0.12}Z`, i % 2 ? frill : frillS));
      out.push(S(D`M${bx} ${by}L${tx + w * 0.08} ${ty + h * 0.06}`, frillS, 1));
    });
    // horns
    const hg = grad(c, 'linearGradient', [[0, '#b9a98a'], [1, '#f1e8d0']], { x1: 1, y1: 0, x2: 0, y2: 0 });
    out.push(P(c, D`M${g.hx - w * 0.05} ${top + h * 0.1}Q${g.hx - w * 0.6} ${top - h * 0.12} ${g.hx - w * 1.0} ${top + h * 0.02}Q${g.hx - w * 0.55} ${top + h * 0.04} ${g.hx - w * 0.15} ${top + h * 0.26}Z`, hg));
    const d = D`M${g.hx - w * 0.42} ${g.chin + 2}C${g.hx - w * 0.64} ${top + h * 0.6} ${g.hx - w * 0.52} ${top} ${g.hx} ${top + 1}` +
      D`C${g.hx + w * 0.36} ${top} ${g.hx + w * 0.48} ${top + h * 0.22} ${g.hx + w * 0.58} ${top + h * 0.36}` +
      D`L${g.hx + w * 0.95} ${top + h * 0.5}Q${g.hx + w * 1.06} ${top + h * 0.57} ${g.hx + w * 0.98} ${top + h * 0.66}` +
      D`L${g.hx + w * 0.5} ${top + h * 0.74}Q${g.hx + w * 0.74} ${top + h * 0.8} ${g.hx + w * 0.42} ${g.chin - 2}` +
      D`Q${g.hx + w * 0.05} ${g.chin + 5} ${g.hx - w * 0.42} ${g.chin + 2}Z`;
    out.push(shaded(c, d, C.skin, [Ef(g.hx - w * 0.5, top + h * 0.6, w * 0.4, h * 0.6, C.skinS),
      F(D`M${g.hx + w * 0.2} ${top + h * 0.76}L${g.hx + w * 1.1} ${top + h * 0.7}L${g.hx + w * 1.1} ${g.chin + 10}L${g.hx} ${g.chin + 10}Z`, shade(C.skin, 0.18)),
      Ef(g.hx + w * 0.4, top + h * 0.2, w * 0.3, h * 0.08, C.skinH, { opacity: 0.8 }),
      F(D`M${g.hx - w * 0.3} ${top + h * 0.15}h1z`, 'none')].concat(scales(g, C))));
    // brow ridge, eyes, nostril, mouth, teeth
    const ex = g.hx + w * 0.24, ey = top + h * 0.43;
    if (X.down) out.push(S(D`M${ex - 4} ${ey}Q${ex} ${ey + 3} ${ex + 4} ${ey - 0.5}`, OL, 1.6));
    else {
      out.push(P(c, D`M${ex - 5} ${ey}Q${ex} ${ey - 5} ${ex + 5.5} ${ey - 1}Q${ex} ${ey + 4.5} ${ex - 5} ${ey}Z`, lite(C.eyes, 0.35), { 'stroke-width': 1.2 }));
      out.push(Ef(ex + 0.6, ey - 0.5, 1, 3.2, '#120c0a'), Cf(ex + 2, ey - 2, 0.8, '#ffffff'));
      out.push(P(c, D`M${g.hx + w * 0.5} ${top + h * 0.38}Q${g.hx + w * 0.62} ${top + h * 0.4} ${g.hx + w * 0.64} ${top + h * 0.45}L${g.hx + w * 0.54} ${top + h * 0.45}Z`, C.skinS, { 'stroke-width': 1 }));
    }
    out.push(S(D`M${ex - 7} ${ey - 4.5}Q${ex} ${ey - 9} ${ex + 7} ${ey - 4}`, OL, X.pose === 'ready' ? 2.6 : 2));
    out.push(Ef(g.hx + w * 0.88, top + h * 0.55, 1.6, 1, C.skinD));
    out.push(S(D`M${g.hx + w * 0.97} ${top + h * 0.665}Q${g.hx + w * 0.6} ${top + h * 0.72} ${g.hx + w * 0.3} ${top + h * 0.7}`, C.skinD, 1.4));
    out.push(F(D`M${g.hx + w * 0.82} ${top + h * 0.675}l1.3 3l1.3 -3.2ZM${g.hx + w * 0.62} ${top + h * 0.705}l1.3 3l1.3 -3.1Z`, '#f3ecda'));
    // throat plates
    for (let i = 0; i < 3; i++) out.push(S(D`M${g.hx + w * (0.05 + i * 0.03)} ${g.chin - 1 + i * 4}q${w * 0.18} 2 ${w * 0.3} -3`, mix(C.skin, '#f2e2b8', 0.4), 1.6));
    return out;
  }
  function scales(g, C) {
    const out = [], col = shade(C.skin, 0.22);
    for (let r = 0; r < 4; r++) for (let i = 0; i < 4; i++) {
      const x = g.hx - g.headW * 0.4 + i * g.headW * 0.2 + (r % 2) * g.headW * 0.1, y = g.crown + g.headH * (0.16 + r * 0.15);
      out.push(S(D`M${x - 2.4} ${y}q2.4 2.6 4.8 0`, col, 0.9, { opacity: 0.8 }));
    }
    return out;
  }

  function head(c, X) {
    const g = X.g, C = X.C, lk = X.lk, out = [], race = X.race;
    const pointy = race === 'Elf' || race === 'Gnome' || race === 'Tiefling' || race === 'Half-Orc';
    const hood = lk.hairStyle === 'hood';
    if (race === 'Dragonborn') {
      out.push(...dragonHead(c, X));
      if (hood) out.push(...hairFront(c, X));
      if (lk.mark === 'scar') out.push(S(D`M${g.hx + g.headW * 0.1} ${g.crown + g.headH * 0.25}l${g.headW * 0.3} ${g.headH * 0.3}`, mix(C.skin, '#f6d6cc', 0.55), 1.6));
      if (lk.mark === 'tattoo' || lk.mark === 'warpaint') out.push(S(D`M${g.hx - g.headW * 0.25} ${g.crown + g.headH * 0.3}l${g.headW * 0.16} ${g.headH * 0.1}l${g.headW * 0.16} ${-g.headH * 0.1}`, lk.mark === 'warpaint' ? '#a3262a' : '#24506a', 1.8));
      if (lk.mark === 'eyepatch') out.push(Ef(g.hx + g.headW * 0.24, g.crown + g.headH * 0.43, 6, 5, '#221816', { stroke: OL, 'stroke-width': 1 }), S(D`M${g.hx - g.headW * 0.4} ${g.crown + g.headH * 0.25}L${g.hx + g.headW * 0.6} ${g.crown + g.headH * 0.5}`, '#1a1210', 1.5));
      return out;
    }
    if (race === 'Elf' && !hood) out.push(...ear(c, X, false));
    out.push(shaded(c, headPath(X), C.skin, [
      Ef(g.L - g.headW * 0.05, g.eyeY, g.headW * 0.34, g.headH * 0.62, C.skinS),
      Ef(g.fx, g.chin + 2, g.headW * 0.5, g.headH * 0.1, C.skinS, { opacity: 0.6 }),
      Ef(g.fx + g.headW * 0.1, g.crown + g.headH * 0.24, g.headW * 0.22, g.headH * 0.1, C.skinH, { opacity: 0.8 }),
    ]));
    if (!pointy && !hood) out.push(...ear(c, X, true));
    out.push(...face(c, X));
    if (race === 'Half-Orc' && !X.down) {
      const mx = g.fx - g.headW * 0.02, my = g.crown + g.headH * 0.81, mw = g.headW * 0.15;
      out.push(P(c, D`M${mx - mw * 0.75} ${my + 0.5}L${mx - mw * 0.82} ${my - 5}L${mx - mw * 0.45} ${my + 0.3}Z`, '#f1e8d2', { 'stroke-width': 0.9 }), P(c, D`M${mx + mw * 0.45} ${my}L${mx + mw * 0.6} ${my - 4.4}L${mx + mw * 0.78} ${my - 0.3}Z`, '#f1e8d2', { 'stroke-width': 0.9 }));
    }
    out.push(...beard(c, X));
    if (!hood) out.push(...hairFront(c, X));
    if (pointy && !hood) out.push(...ear(c, X, true));
    if (hood) out.push(...hairFront(c, X));
    if (race === 'Half-Orc' && !X.down && lk.beard !== 'none' && lk.beard !== 'stubble') {
      const mx = g.fx - g.headW * 0.02, my = g.crown + g.headH * 0.81, mw = g.headW * 0.15;
      out.push(P(c, D`M${mx - mw * 0.75} ${my + 0.5}L${mx - mw * 0.82} ${my - 5}L${mx - mw * 0.45} ${my + 0.3}Z`, '#f1e8d2', { 'stroke-width': 0.9 }));
    }
    if (race === 'Tiefling') out.push(...horns(c, X, false));
    else if (lk.mark === 'horns-small') out.push(...horns(c, X, true));
    return out;
  }

  // ------------------------------------------------------------------ assembly

  function figure(c, X) {
    const g = X.g, C = X.C, W = X.W, fl = X.fl, R = rig(X);
    X.R = R;
    const k = g.k;
    X.staffB = GY - 3 - (R.wpn ? R.wpn.y : g.waistY);
    X.staffT = -(g.H * (W.weapon === 'greataxe' ? 0.45 : 0.55)) - 10 * k;
    if (X.pose === 'ready' && (W.weapon === 'staff' || W.weapon === 'greataxe')) { X.staffB = 60 * k; X.staffT = -(W.weapon === 'staff' ? 120 : 92) * k; }
    if (X.pose === 'ready' && W.weapon === 'greataxe') { X.staffB = 34 * k; X.staffT = -84 * k; }
    const lower = [], upper = [], fxl = [];
    // shadow on the ground
    if (!X.down) lower.push(Ef(CX + 2, GY + 1, g.hpw * 2.2 + 12, 5.5, '#000', { opacity: 0.32 }));
    lower.push(...backLayer(c, X, R));
    // far arm behind the torso
    const farArm = armPaths(c, X, R.far, false);
    const farHand = hand(c, X, R.far.h, false);
    const wpnArt = R.wpn && W.weapon !== 'wraps' ? placed(weaponArt(c, X, W.weapon), R.wpn) : null;
    upper.push(...farShoulder(c, X, R));
    upper.push(...farArm);
    if (R.wpn && R.wpn.far && !R.wpn.front) upper.push(wpnArt);
    if (!R.farFront) upper.push(...farHand);
    if (fl.eldritch && !R.shield && !(R.wpn && R.wpn.far)) {
      const h = R.far.h, r = (X.pose === 'ready' ? 15 : 10) * k;
      fxl.push(Cf(h[0] + 1, h[1] - 2, r * 1.6, glow(c, '#a979ff'), { class: X.M.animate ? 'cfg' : null }));
      fxl.push(Cf(h[0] + 1, h[1] - 3, r * 0.42, '#e9dcff', { class: X.M.animate ? 'cfg' : null }));
      fxl.push(S(D`M${h[0] - 3} ${h[1] - 6}q3 -8 0 -14M${h[0] + 4} ${h[1] - 5}q4 -6 1 -12`, '#c7a6ff', 1.2, { opacity: 0.8, class: X.M.animate ? 'cfs' : null }));
    }
    const legsN = legs(c, X, R);
    const body = [];
    const nk = X.race === 'Dragonborn' ? 1.6 : X.race === 'Half-Orc' || X.race === 'Dwarf' ? 1.2 : 1;
    body.push(P(c, cap([g.hx - 1, g.chin - 6], [CX + 1, g.shY + 4], g.headW * 0.19 * nk, g.headW * 0.22 * nk), X.C.skin));
    body.push(Ef(CX + 1, g.chin + 3, g.headW * 0.22, 4, C.skinS, { opacity: 0.7 }));
    body.push(...torso(c, X));
    body.push(...drape(c, X));
    if (R.shield) body.push(G(shieldArt(c, X, W.shield), { transform: D`translate(${R.shield.x} ${R.shield.y}) scale(.86 1)` }));
    const headN = head(c, X);
    const nearArm = armPaths(c, X, R.near, true);
    const nearHand = hand(c, X, R.near.h, true);
    const front = [];
    front.push(...nearArm);
    front.push(...shoulders(c, X, R));
    if (R.wpn && !R.wpn.far) front.push(wpnArt);
    if (R.wpn && R.wpn.far && R.wpn.front) front.push(wpnArt);
    if (R.farFront) front.push(...farHand);
    front.push(...nearHand);
    if (fl.dual && !R.shield) {
      const dg = { x: R.far.h[0], y: R.far.h[1], rot: X.pose === 'ready' ? -150 : 170 };
      const dd = placed(weaponArt(c, X, 'dagger'), dg);
      if (R.farFront) front.push(dd); else { upper.push(dd); upper.push(...farHand); }
    }
    if (fl.sparks) {
      const h = X.pose === 'ready' ? R.far.h : [CX + g.sw + 8, g.waistY];
      [[0, -14, 3.2], [10, -6, 2.4], [-8, -22, 2], [6, -28, 2.6], [14, -18, 1.6]].forEach((q, i) => fxl.push(star(h[0] + q[0] * k, h[1] + q[1] * k, q[2] * k * (X.pose === 'ready' ? 1.4 : 1), i % 2 ? C.spark : '#ffffff', { class: X.M.animate ? 'cfs' : null, style: X.M.animate ? 'animation-delay:-' + (i * 0.55).toFixed(2) + 's' : null })));
      fxl.push(Cf(h[0], h[1] - 14 * k, 9 * k, glow(c, C.spark), { opacity: 0.6, class: X.M.animate ? 'cfg' : null }));
    }
    const top = G(upper.concat(body, headN, front), { class: X.M.animate && !X.down ? 'cfb' : null });
    return G(lower.concat([G(legsN)], [top], fxl));
  }

  function defsBase(c) {
    c.defs.push(N('pattern', { id: c.p + 'ring', width: 4, height: 3.4, patternUnits: 'userSpaceOnUse' }, [N('path', { d: 'M0 1.2Q2 4 4 1.2', fill: 'none', stroke: '#4e565d', 'stroke-width': 0.8 }), N('path', { d: 'M-2 2.9Q0 5.7 2 2.9M2 2.9Q4 5.7 6 2.9', fill: 'none', stroke: '#c9d0d5', 'stroke-width': 0.5 })]));
  }
  const CSS = '.cfb{animation:cf-br 3.8s ease-in-out infinite}@keyframes cf-br{0%,100%{transform:translateY(0)}50%{transform:translateY(-0.9px)}}' +
    '.cfg{animation:cf-gl 2.4s ease-in-out infinite}@keyframes cf-gl{0%,100%{opacity:.55}50%{opacity:1}}' +
    '.cfs{animation:cf-sp 2.8s ease-in-out infinite}@keyframes cf-sp{0%,100%{opacity:.2;transform:translateY(0)}50%{opacity:1;transform:translateY(-3px)}}' +
    '.cft{animation:cf-gl 1.9s ease-in-out infinite}' +
    '@media (prefers-reduced-motion:reduce){.cfb,.cfg,.cfs,.cft{animation:none}}';

  function render(player, opts) {
    const M = normalize(player, opts);
    const X = build(M);
    X.down = M.pose === 'down';
    const key = JSON.stringify([VERSION, M.race, M.cls, M.look, M.eq, M.view, M.pose, M.facing, M.animate, M.frame, M.rim]);
    const c = new Ctx('cf' + hash(key), M.view === 'full' ? 1.9 : M.view === 'bust' ? 1.5 : 1.7);
    defsBase(c);
    const g = X.g;
    let fig = figure(c, X);
    let vb, w, h, kids = [];
    if (M.view === 'full') {
      if (X.down) {
        const s = Math.min(1, 186 / g.H);
        fig = G([fig], { transform: D`translate(${VW / 2} ${GY - 52}) scale(${s}) rotate(-84) translate(${-CX} ${-(GY - g.H / 2)})` });
        kids.push(Ef(VW / 2, GY - 6, g.H * s * 0.5, 7, '#000', { opacity: 0.3 }));
      }
      if (M.facing === 'left') fig = G([fig], { transform: D`translate(${VW} 0) scale(-1 1)` });
      kids.push(fig);
      vb = [0, 0, VW, VH]; h = M.size; w = Math.round(M.size * VW / VH);
    } else {
      const extra = X.race === 'Dragonborn' ? g.headW * 0.2 : 0;
      const side = g.headH * (M.view === 'token' ? 2.35 : 2.6), cx = g.hx + extra, cy = g.crown + g.headH * 0.56;
      const x0 = cx - side / 2, y0 = cy - side * (M.view === 'token' ? 0.4 : 0.37);
      vb = [x0, y0, side, side]; w = h = M.size;
      if (X.down) fig = G([fig], { transform: D`rotate(-10 ${cx} ${cy})` });
      if (M.facing === 'left') fig = G([fig], { transform: D`translate(${2 * cx} 0) scale(-1 1)` });
      const ccx = x0 + side / 2, ccy = y0 + side / 2;
      const shieldD = D`M${x0 + side * 0.08} ${y0 + side * 0.06}H${x0 + side * 0.92}V${y0 + side * 0.48}Q${x0 + side * 0.9} ${y0 + side * 0.8} ${ccx} ${y0 + side * 0.97}Q${x0 + side * 0.1} ${y0 + side * 0.8} ${x0 + side * 0.08} ${y0 + side * 0.48}Z`;
      const round = M.view === 'token' || M.frame === 'round';
      const rr = side * (M.view === 'token' ? (M.rim ? 0.43 : 0.5) : 0.46);
      const clipD = round ? D`M${ccx - rr} ${ccy}A${rr} ${rr} 0 1 1 ${ccx + rr} ${ccy}A${rr} ${rr} 0 1 1 ${ccx - rr} ${ccy}Z` : shieldD;
      const cid = c.id('f');
      c.defs.push(N('clipPath', { id: cid }, [N('path', { d: clipD })]));
      const bg = grad(c, 'radialGradient', [[0, mix(X.C.out, '#3a3f45', 0.45)], [0.7, mix(X.C.out, '#15181b', 0.7)], [1, '#0d0f11']], { cx: 0.5, cy: 0.38, r: 0.7 });
      if (M.view === 'token' && M.rim) kids.push(Cf(ccx + side * 0.012, ccy + side * 0.025, rr + side * 0.06, '#000', { opacity: 0.45 }));
      kids.push(F(clipD, bg));
      kids.push(N('g', { 'clip-path': 'url(#' + cid + ')' }, [Ef(ccx, y0 + side * 0.25, side * 0.3, side * 0.22, lite(X.C.out, 0.2), { opacity: 0.18 }), fig]));
      if (M.view === 'token') {
        if (M.rim) {
          kids.push(Cf(ccx, ccy, rr + side * 0.03, 'none', { stroke: '#0b0e10', 'stroke-width': f1(side * 0.06) }));
          kids.push(Cf(ccx, ccy, rr + side * 0.035, 'none', { stroke: X.C.acc === '#2f2f2f' ? '#8a8f94' : X.C.acc, 'stroke-width': f1(side * 0.028) }));
          kids.push(Cf(ccx, ccy, rr + 0.5, 'none', { stroke: '#000', 'stroke-opacity': 0.5, 'stroke-width': 1.2 }));
          const hr = rr + side * 0.035;
          kids.push(F(D`M${ccx - hr * 0.94} ${ccy - hr * 0.34}A${hr} ${hr} 0 0 1 ${ccx + hr * 0.34} ${ccy - hr * 0.94}`, 'none', { stroke: '#fff', 'stroke-opacity': 0.28, 'stroke-width': 1.4, 'stroke-linecap': 'round' }));
        }
      } else {
        kids.push(F(clipD, 'none', { stroke: '#0b0e10', 'stroke-width': f1(side * 0.04) }));
        kids.push(F(clipD, 'none', { stroke: X.C.acc === '#2f2f2f' ? '#8a8f94' : X.C.acc, 'stroke-width': f1(side * 0.018) }));
      }
    }
    const svgKids = [N('defs', {}, c.defs)];
    if (M.animate) svgKids.push(N('style', {}, [{ text: CSS }]));
    const root = N('svg', { viewBox: vb.map(f1).join(' '), width: w, height: h, role: 'img', 'aria-hidden': 'true', focusable: 'false', class: 'cf-svg' }, svgKids.concat(kids));
    return root;
  }

  // ------------------------------------------------------------------ output

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  function toStr(n, top) {
    if (n.text != null) return esc(n.text);
    let s = '<' + n.t;
    if (top) s += ' xmlns="' + SVGNS + '"';
    const a = n.a;
    for (const k in a) if (a[k] != null) s += ' ' + k + '="' + esc(a[k]) + '"';
    if (!n.k.length) return s + '/>';
    s += '>';
    for (let i = 0; i < n.k.length; i++) s += toStr(n.k[i], false);
    return s + '</' + n.t + '>';
  }
  function toDom(n, doc) {
    if (n.text != null) return doc.createTextNode(n.text);
    const el = doc.createElementNS(SVGNS, n.t);
    const a = n.a;
    for (const k in a) if (a[k] != null) el.setAttribute(k, String(a[k]));
    for (let i = 0; i < n.k.length; i++) el.appendChild(toDom(n.k[i], doc));
    return el;
  }

  const cache = new Map();
  function markup(player, opts) {
    let key;
    try { key = JSON.stringify([player && player.race, player && player.cls, player && player.look, player && player.eq, opts]); } catch (e) { key = null; }
    if (key && cache.has(key)) return cache.get(key);
    const s = toStr(render(player, opts), true);
    if (key) { if (cache.size > 200) cache.clear(); cache.set(key, s); }
    return s;
  }

  const API = {
    version: VERSION,
    svg: function (player, opts) {
      const doc = root && root.document;
      if (!doc) throw new Error('CharacterFigure.svg needs a DOM; use markup() or dataUrl()');
      return toDom(render(player, opts), doc);
    },
    markup: markup,
    dataUrl: function (player, opts) { return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup(player, opts)); },
  };
  if (typeof module === 'object' && module.exports) module.exports = API;
  if (root) root.CharacterFigure = API;
})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : null);
