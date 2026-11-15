/*
 * AI-DnD Online — the tabletop map: generation, movement, fog of war.
 *
 * A map is a small grid of characters (legend in README / the renderer).
 * Pure functions over plain JSON so the same code runs in Node and in the
 * browser. Randomness is seeded from the location name, so every client
 * and the server agree on the layout.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GameMaps = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const W = 22, H = 14;
  const LAYOUTS = ['tavern', 'town', 'docks', 'forest', 'mountain', 'camp', 'cave', 'mine', 'dungeon', 'crypt', 'shore'];
  const THEME = { tavern: 'wood', town: 'grass', docks: 'wood', forest: 'grass', mountain: 'snow', camp: 'grass', cave: 'cave', mine: 'cave', dungeon: 'stone', crypt: 'stone', shore: 'sand' };
  const FROM_AMBIENCE = { tavern: 'tavern', town: 'town', forest: 'forest', cave: 'cave', dungeon: 'dungeon', crypt: 'crypt', mountain: 'mountain', storm: 'shore', camp: 'camp' };
  const EXIT_NAME = { tavern: 'Front door', town: 'Road out of town', docks: 'Harbour road', forest: 'Trail onward', mountain: 'Mountain path', camp: 'Trail onward', cave: 'Deeper passage', mine: 'Shaft downward', dungeon: 'Stair down', crypt: 'Inner stair', shore: 'Path along the shore' };
  const OUTDOOR = new Set(['town', 'docks', 'forest', 'mountain', 'camp', 'shore']);

  // Tiles a hero can stand on. Everything else blocks movement.
  const WALK = new Set(['.', ',', ':', 'r', 'c', 'R', 'S', "'", '_']);
  // Tiles that stop the fog-of-war flood (you cannot see through them).
  const OPAQUE = new Set(['#', '+', ' ', 'k', 'x']);

  // ---------------------------------------------------------------- helpers

  function hash(str) { let h = 2166136261; for (const ch of String(str)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
  function rng(seed) {
    let a = hash(seed) || 1;
    return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const grid = (w, h, ch) => Array.from({ length: h }, () => Array(w).fill(ch));
  const rows = (g) => g.map((r) => r.join(''));
  const inb = (m, x, y) => x >= 0 && y >= 0 && x < m.w && y < m.h;
  const at = (m, x, y) => (inb(m, x, y) ? m.tiles[y][x] : ' ');
  const dist = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  const key = (x, y) => x + ',' + y;
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

  function walkable(m, x, y) { return !!m && WALK.has(at(m, x, y)); }
  function setTile(m, x, y, ch) { if (!inb(m, x, y)) return; const r = m.tiles[y]; m.tiles[y] = r.slice(0, x) + ch + r.slice(x + 1); }

  /** Can you step diagonally from (x,y) by (dx,dy)? Not through the corner of a wall. */
  function stepOk(m, x, y, dx, dy) { return !dx || !dy || (walkable(m, x + dx, y) && walkable(m, x, y + dy)); }

  /**
   * Breadth-first search over walkable squares. `blocked` is a Set of keys
   * nobody may enter; `passThrough` keys may be crossed but not ended on.
   * Returns a Map key -> {x, y, d, prev}.
   */
  function bfs(m, start, opts) {
    opts = opts || {};
    const max = opts.max == null ? 99 : opts.max;
    const seen = new Map([[key(start.x, start.y), { x: start.x, y: start.y, d: 0, prev: null }]]);
    const q = [start];
    while (q.length) {
      const c = q.shift();
      const cur = seen.get(key(c.x, c.y));
      if (cur.d >= max) continue;
      for (const [dx, dy] of DIRS) {
        const x = c.x + dx, y = c.y + dy, k = key(x, y);
        if (seen.has(k) || !walkable(m, x, y) || !stepOk(m, c.x, c.y, dx, dy)) continue;
        if (opts.blocked && opts.blocked.has(k)) continue;
        seen.set(k, { x, y, d: cur.d + 1, prev: key(c.x, c.y) });
        q.push({ x, y });
      }
    }
    return seen;
  }
  function trace(seen, k) {
    const out = [];
    for (let n = seen.get(k); n && n.prev; n = seen.get(n.prev)) out.unshift({ x: n.x, y: n.y });
    return out;
  }

  // ---------------------------------------------------------------- fog of war

  function reveal(m, from) {
    if (!m || m.outdoor) return;
    const seen = m.seen.map((r) => r.split(''));
    const q = [];
    const mark = (x, y) => { if (inb(m, x, y)) seen[y][x] = '1'; };
    const done = new Set();
    (from || []).forEach((p) => { if (p && inb(m, p.x, p.y)) { q.push(p); done.add(key(p.x, p.y)); } });
    while (q.length) {
      const c = q.shift();
      mark(c.x, c.y);
      for (const [dx, dy] of DIRS) {
        const x = c.x + dx, y = c.y + dy, k = key(x, y);
        if (!inb(m, x, y)) continue;
        mark(x, y);
        if (done.has(k) || OPAQUE.has(at(m, x, y))) continue;
        done.add(k);
        q.push({ x, y });
      }
    }
    m.seen = seen.map((r) => r.join(''));
  }

  // ---------------------------------------------------------------- generators

  const TAVERN = [
    '######################',
    '#kk..b#x.hhh..x#w...w#',
    '#.....#........#.....#',
    '#..S..+.c=c..c=c+....#',
    "#.....#.c=c..c=c#w...#",
    "###+###.........##'###",
    '#....................#',
    '#.c=c.....rrrr...BBB.#',
    '#.c=c.....rrrr...B.b.#',
    '#..........rr....B.bb#',
    '#.c=c............B...#',
    '#.c=c..............k.#',
    '#.........::.........#',
    "##########''##########",
  ];

  function tavern(r) {
    const tiles = TAVERN.slice();
    const m = { tiles, w: W, h: H };
    // A little variety: move a table group, swap a rug for chairs.
    if (r() < 0.5) { setTile(m, 11, 9, '.'); setTile(m, 12, 9, '.'); }
    if (r() < 0.5) { setTile(m, 1, 1, '.'); setTile(m, 2, 1, 'b'); }
    return {
      tiles: m.tiles, spawn: { x: 10, y: 12 },
      exit: { x: 10, y: 13 }, chests: [{ x: 1, y: 4 }],
      spots: { npc: [{ x: 18, y: 8 }, { x: 18, y: 10 }, { x: 12, y: 3 }, { x: 6, y: 9 }] },
    };
  }

  /** Open ground with a winding path from left to right and scattered obstacles. */
  function outdoor(layout, r) {
    const base = { forest: ',', mountain: '.', camp: ',', town: ',', docks: '.', shore: '.' }[layout];
    const g = grid(W, H, base);
    const obstacle = { forest: 'T', mountain: '^', camp: 'T', town: 'T', docks: 'b', shore: '^' }[layout];
    const density = { forest: 0.26, mountain: 0.17, camp: 0.12, town: 0.06, docks: 0.05, shore: 0.1 }[layout];
    // Frame the edges.
    for (let x = 0; x < W; x++) { g[0][x] = obstacle; g[H - 1][x] = obstacle; }
    for (let y = 0; y < H; y++) { g[y][0] = obstacle; g[y][W - 1] = obstacle; }
    // Water for the coast and the harbour.
    if (layout === 'shore' || layout === 'docks') {
      for (let x = 0; x < W; x++) {
        const depth = layout === 'docks' ? 4 : 3 + Math.round(Math.sin(x / 3 + r() * 2) * 1.2);
        for (let y = H - depth; y < H; y++) g[y][x] = y === H - depth && layout === 'shore' ? '_' : '~';
      }
    }
    if (layout === 'mountain') for (let i = 0; i < 4; i++) { const cx = 3 + Math.floor(r() * 16), cy = 2 + Math.floor(r() * 9); for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [-1, 0], [0, -1]]) if (r() < 0.8) g[cy + dy][cx + dx] = ','; }
    // Scatter obstacles.
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) if (g[y][x] === base && r() < density) g[y][x] = obstacle;
    if (layout === 'forest') for (let i = 0; i < 6; i++) { const x = 2 + Math.floor(r() * 18), y = 2 + Math.floor(r() * 9); if (g[y][x] === base) g[y][x] = '^'; }
    // The path.
    let y = 4 + Math.floor(r() * 5);
    const pathRows = [];
    for (let x = 0; x < W; x++) {
      if (x > 1 && x < W - 2 && r() < 0.3) y = Math.max(2, Math.min(H - (layout === 'docks' ? 6 : 4), y + (r() < 0.5 ? -1 : 1)));
      pathRows[x] = y;
      g[y][x] = ':';
      if (g[y + 1] && g[y + 1][x] !== '~' && y + 1 < H - 1 && layout !== 'mountain') g[y + 1][x] = ':';
      for (const dy of [-1, 2]) if (g[y + dy] && x > 0 && x < W - 1 && g[y + dy][x] === obstacle) g[y + dy][x] = base;
    }
    // Town: a few buildings along the road, doors facing it.
    if (layout === 'town' || layout === 'docks') {
      const lots = [[2, 1], [9, 1], [15, 1]];
      if (layout === 'town') lots.push([4, 9], [13, 9]);
      for (const [lx, ly] of lots) {
        const bw = 5 + Math.floor(r() * 2), bh = 3;
        if (ly + bh + 1 >= pathRows[lx] && ly < pathRows[lx]) continue;
        if (ly > pathRows[lx] && ly <= pathRows[lx] + 2) continue;
        for (let yy = ly; yy <= ly + bh; yy++) for (let xx = lx; xx < Math.min(W - 1, lx + bw); xx++) {
          if (g[yy][xx] === '~') continue;
          const edge = yy === ly || yy === ly + bh || xx === lx || xx === lx + bw - 1;
          g[yy][xx] = edge ? '#' : '.';
        }
        const doorY = ly < pathRows[lx] ? ly + bh : ly;
        const doorX = lx + 2;
        if (g[doorY] && g[doorY][doorX] === '#') g[doorY][doorX] = '+';
        if (g[ly + 1] && g[ly + 1][lx + 1] === '.') g[ly + 1][lx + 1] = r() < 0.5 ? 'b' : 'k';
      }
      for (let i = 0; i < 4; i++) { const x = 2 + Math.floor(r() * 18); const yy = pathRows[x] + (r() < 0.5 ? -1 : 2); if (g[yy] && g[yy][x] === base) g[yy][x] = 'b'; }
      if (layout === 'docks') { for (const px of [6, 14]) for (let yy = H - 5; yy < H - 1; yy++) if (g[yy][px] === '~') g[yy][px] = ':'; }
    }
    // Camp: a fire, tents and bedrolls in a clearing beside the road.
    if (layout === 'camp') {
      const cx = 6 + Math.floor(r() * 10), cy = pathRows[cx] < 7 ? pathRows[cx] + 4 : pathRows[cx] - 3;
      for (let yy = cy - 2; yy <= cy + 2; yy++) for (let xx = cx - 3; xx <= cx + 3; xx++) if (g[yy] && g[yy][xx] && g[yy][xx] !== ':' && yy > 0 && yy < H - 1 && xx > 0 && xx < W - 1) g[yy][xx] = ',';
      g[cy][cx] = 'F';
      [[cx - 2, cy - 2], [cx + 2, cy - 2]].forEach(([xx, yy]) => { if (g[yy] && yy > 0) g[yy][xx] = 'n'; });
      [[cx - 2, cy + 1], [cx + 2, cy + 1]].forEach(([xx, yy]) => { if (g[yy] && yy < H - 1) g[yy][xx] = 'w'; });
    }
    const tiles = rows(g);
    const spawn = { x: 1, y: pathRows[1] };
    const exit = { x: W - 1, y: pathRows[W - 1] };
    const m = { tiles, w: W, h: H };
    setTile(m, 0, spawn.y, ':');
    const chests = [];
    for (let tries = 0; tries < 40 && chests.length < (layout === 'town' ? 0 : 1); tries++) {
      const x = 4 + Math.floor(r() * 14), yy = 2 + Math.floor(r() * 9);
      if (at(m, x, yy) === base && Math.abs(yy - pathRows[x]) > 1) chests.push({ x, y: yy });
    }
    return { tiles: m.tiles, spawn, exit, chests, spots: {} };
  }

  /** Rooms joined by corridors, with doors. Dungeons, crypts and mines. */
  function rooms(layout, r) {
    const g = grid(W, H, '#');
    const list = [];
    for (let tries = 0; tries < 200 && list.length < 6; tries++) {
      const w = 4 + Math.floor(r() * 4), h = 3 + Math.floor(r() * 3);
      const x = 1 + Math.floor(r() * (W - w - 2)), y = 1 + Math.floor(r() * (H - h - 2));
      if (list.some((o) => x < o.x + o.w + 2 && x + w + 2 > o.x && y < o.y + o.h + 2 && y + h + 2 > o.y)) continue;
      list.push({ x, y, w, h, cx: x + Math.floor(w / 2), cy: y + Math.floor(h / 2) });
    }
    list.sort((a, b) => a.cx - b.cx);
    const floor = layout === 'mine' ? '.' : '.';
    list.forEach((o) => { for (let y = o.y; y < o.y + o.h; y++) for (let x = o.x; x < o.x + o.w; x++) g[y][x] = floor; });
    const corridor = layout === 'mine' ? 'R' : ',';
    const carve = (x, y) => { if (g[y][x] === '#') g[y][x] = corridor; };
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1], b = list[i];
      if (r() < 0.5) { for (let x = Math.min(a.cx, b.cx); x <= Math.max(a.cx, b.cx); x++) carve(x, a.cy); for (let y = Math.min(a.cy, b.cy); y <= Math.max(a.cy, b.cy); y++) carve(b.cx, y); } else { for (let y = Math.min(a.cy, b.cy); y <= Math.max(a.cy, b.cy); y++) carve(a.cx, y); for (let x = Math.min(a.cx, b.cx); x <= Math.max(a.cx, b.cx); x++) carve(x, b.cy); }
    }
    // Doors where a corridor meets a room's edge.
    const inRoom = (x, y) => list.some((o) => x >= o.x && x < o.x + o.w && y >= o.y && y < o.y + o.h);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      if (g[y][x] !== corridor) continue;
      const horiz = g[y][x - 1] === '#' && g[y][x + 1] === '#';
      const vert = g[y - 1][x] === '#' && g[y + 1][x] === '#';
      const touchesRoom = DIRS.slice(0, 4).some(([dx, dy]) => inRoom(x + dx, y + dy));
      if ((horiz || vert) && touchesRoom && layout !== 'mine' && r() < 0.6) g[y][x] = r() < 0.55 ? '+' : "'";
    }
    // Decor.
    const deco = { dungeon: ['b', 'k', 'o'], crypt: ['s', 'o', 's'], mine: ['b', '^', 'b'] }[layout];
    list.forEach((o, i) => {
      if (i === 0) return;
      for (let n = 0; n < 2 + Math.floor(r() * 2); n++) {
        const x = o.x + 1 + Math.floor(r() * Math.max(1, o.w - 2)), y = o.y + 1 + Math.floor(r() * Math.max(1, o.h - 2));
        if (g[y][x] === floor && x !== o.cx && y !== o.cy) g[y][x] = deco[Math.floor(r() * deco.length)];
      }
      if (layout !== 'mine') { const tx = o.x + Math.floor(o.w / 2); if (g[o.y - 1][tx] === '#') g[o.y - 1][tx] = 'x'; }
    });
    const first = list[0], last = list[list.length - 1];
    if (layout === 'crypt') g[last.y][last.cx] = 'a';
    g[first.cy][first.x] = 'S';
    const exit = { x: last.x + last.w - 1, y: last.cy };
    g[exit.y][exit.x] = 'S';
    const mid = list[Math.floor(list.length / 2)];
    const chests = mid && mid !== first ? [{ x: mid.x, y: mid.y }] : [];
    if (chests[0] && g[chests[0].y][chests[0].x] !== floor) chests.length = 0;
    return { tiles: rows(g), spawn: { x: first.x + 1, y: first.cy }, exit, chests, spots: {} };
  }

  /** A cave: cellular automata, keep the largest connected area. */
  function cave(r) {
    let g = grid(W, H, '#');
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) g[y][x] = r() < 0.43 ? '#' : '.';
    for (let it = 0; it < 4; it++) {
      const n = grid(W, H, '#');
      for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        let walls = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (g[y + dy][x + dx] === '#') walls++;
        n[y][x] = walls >= 5 ? '#' : '.';
      }
      g = n;
    }
    // Guarantee a passage from left to right.
    let y = 5 + Math.floor(r() * 4);
    for (let x = 1; x < W - 1; x++) { g[y][x] = '.'; if (r() < 0.3) y = Math.max(2, Math.min(H - 3, y + (r() < 0.5 ? -1 : 1))); g[y][x] = '.'; }
    const m = { tiles: rows(g), w: W, h: H };
    let start = null;
    for (let x = 1; x < W && !start; x++) for (let yy = 1; yy < H - 1 && !start; yy++) if (walkable(m, x, yy)) start = { x, y: yy };
    const reach = bfs(m, start);
    for (let yy = 0; yy < H; yy++) for (let x = 0; x < W; x++) if (g[yy][x] === '.' && !reach.has(key(x, yy))) g[yy][x] = '#';
    const cells = [...reach.values()];
    // Pools, puddles, rubble and glowing spots.
    cells.forEach((c) => { const v = r(); if (v < 0.04) g[c.y][c.x] = '_'; else if (v < 0.07) g[c.y][c.x] = '^'; else if (v < 0.1) g[c.y][c.x] = ','; });
    const exitCell = cells.reduce((a, b) => (b.x > a.x ? b : a), cells[0]);
    g[start.y][start.x] = '.';
    g[exitCell.y][exitCell.x] = 'S';
    const tiles = rows(g);
    const m2 = { tiles, w: W, h: H };
    // Re-check connectivity after rubble.
    const ok = bfs(m2, start);
    if (!ok.has(key(exitCell.x, exitCell.y))) { cells.forEach((c) => { if (g[c.y][c.x] === '^') g[c.y][c.x] = ','; }); }
    const chestCell = cells.find((c, i) => i % 7 === 3 && g[c.y][c.x] === '.' && dist(c, start) > 5);
    return { tiles: rows(g), spawn: start, exit: exitCell, chests: chestCell ? [chestCell] : [], spots: {} };
  }

  /** Build a map for a location. Same inputs always give the same map. */
  function build(layout, r) {
    if (layout === 'tavern') return tavern(r);
    if (layout === 'cave') return cave(r);
    if (layout === 'dungeon' || layout === 'crypt' || layout === 'mine') return rooms(layout, r);
    return outdoor(layout, r);
  }
  /** Every exit and chest can be reached from the entrance once doors are opened. */
  function connected(g) {
    const open = { w: W, h: H, tiles: g.tiles.map((row) => row.replace(/\+/g, "'")) };
    if (!walkable(open, g.spawn.x, g.spawn.y)) return false;
    // Chests block the square they sit on, so a chest must never plug a passage.
    const reach = bfs(open, g.spawn, { blocked: new Set((g.chests || []).map((c) => key(c.x, c.y))) });
    const near = (p) => [[0, 0]].concat(DIRS).some(([dx, dy]) => reach.has(key(p.x + dx, p.y + dy)));
    return reach.size >= 40 && (!g.exit || near(g.exit)) && (g.chests || []).every(near);
  }

  function generate(layout, seed, id) {
    if (!LAYOUTS.includes(layout)) layout = 'dungeon';
    let g = null;
    for (let i = 0; i < 12 && (!g || !connected(g)); i++) g = build(layout, rng(layout + '|' + seed + (i ? '|' + i : '')));
    if (!connected(g)) { g = tavern(rng(seed)); layout = 'tavern'; }
    const open = OUTDOOR.has(layout);
    const m = {
      id: id || 1, layout, theme: THEME[layout], w: W, h: H, tiles: g.tiles, outdoor: open,
      seen: Array.from({ length: H }, () => (open ? '1' : '0').repeat(W)),
      objects: [], spawn: g.spawn, next: 1,
    };
    const add = (o) => { o.id = 'o' + m.next++; m.objects.push(o); return o; };
    if (g.exit) add({ kind: 'exit', x: g.exit.x, y: g.exit.y, name: EXIT_NAME[layout], used: false });
    (g.chests || []).forEach((c) => add({ kind: 'chest', x: c.x, y: c.y, name: 'Chest', used: false }));
    m.spots = g.spots || {};
    return m;
  }

  // ---------------------------------------------------------------- placement

  /** Squares that are free to stand on (walkable, not taken). */
  function freeNear(m, origin, taken, count, minD) {
    const out = [];
    const seen = bfs(m, origin, { max: 40 });
    const sorted = [...seen.values()].sort((a, b) => a.d - b.d);
    for (const c of sorted) {
      if (out.length >= count) break;
      if ((minD || 0) > c.d) continue;
      if (taken.has(key(c.x, c.y))) continue;
      out.push({ x: c.x, y: c.y });
      taken.add(key(c.x, c.y));
    }
    return out;
  }

  /** Squares at a fighting distance from the party for enemies to appear on. */
  function enemySpots(m, center, taken, count, r) {
    const seen = bfs(m, center, { max: 40 });
    const all = [...seen.values()].filter((c) => !taken.has(key(c.x, c.y)));
    let band = all.filter((c) => c.d >= 5 && c.d <= 9);
    if (band.length < count) band = all.filter((c) => c.d >= 3).sort((a, b) => b.d - a.d).slice(0, Math.max(count * 3, 6));
    if (band.length < count) band = all.filter((c) => c.d >= 1);
    // Prefer a cluster: start from one far square and take its nearest neighbours.
    const anchor = band[Math.floor((r ? r() : 0.5) * band.length)] || all[all.length - 1];
    if (!anchor) return [];
    band.sort((a, b) => dist(a, anchor) - dist(b, anchor));
    const out = [];
    for (const c of band) { if (out.length >= count) break; if (taken.has(key(c.x, c.y))) continue; out.push({ x: c.x, y: c.y }); taken.add(key(c.x, c.y)); }
    return out;
  }

  /** A free floor square near a wall, for a feature the story mentioned. */
  function featureSpot(m, center, taken, r) {
    const seen = bfs(m, center, { max: 30 });
    const cands = [...seen.values()].filter((c) => c.d >= 2 && !taken.has(key(c.x, c.y)) && DIRS.some(([dx, dy]) => !walkable(m, c.x + dx, c.y + dy)) && m.seen[c.y][c.x] === '1');
    const pool = cands.length ? cands : [...seen.values()].filter((c) => c.d >= 1 && !taken.has(key(c.x, c.y)));
    if (!pool.length) return null;
    pool.sort((a, b) => a.d - b.d);
    const pick = pool[Math.floor((r ? r() : 0) * Math.min(pool.length, 8))];
    taken.add(key(pick.x, pick.y));
    return { x: pick.x, y: pick.y };
  }

  return {
    W, H, LAYOUTS, THEME, FROM_AMBIENCE, OUTDOOR, WALK,
    hash, rng, key, dist, at, inb, walkable, setTile, stepOk, bfs, trace, reveal, generate, freeNear, enemySpots, featureSpot,
  };
});
