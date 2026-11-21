// Sokoban solver for make.fun's "Build the best Sokoban solver" bounty.
//
// How the levels are built (from the competition rules): one 1-wide hallway
// across the board with one to four independent rooms off it, each room
// holding 3-4 boxes and as many goals, and the level's push-optimal count
// P* is the sum of the rooms' optima. So the solver works room by room:
//
//   1. Split the level: the hallway is the row the player starts on; every
//      connected component of floor off that row is one room, opening onto
//      the hallway through a single door cell.
//   2. Solve each room on its own with a push-optimal A* search over box
//      configurations. The player is canonicalised to the smallest cell of
//      the region it can reach, the heuristic is the cheapest assignment of
//      boxes to goals under lone-box push distances, and states are pruned
//      with dead-square and 2x2-block deadlock checks. A room's boxes never
//      leave the room and the player stays in the room plus the hallway
//      square outside its door, which matches how the rooms were built.
//   3. Stitch the room solutions together with walks along the hallway.
//      Finishing a room never shuts the player in, so it can always walk
//      back out through its door to the next room.
//
// If a level does not split the way above, a whole-level push-space A*
// (same machinery, sum-of-minimum heuristic) is tried as a fallback. Every
// instance always gets an answer file, even if it is an empty one.
//
// Determinism: no clock, no randomness, no environment input besides the
// input/output directory variables. Search is bounded by fixed expansion
// counts, never by elapsed time, so two runs write identical bytes.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IN_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Directions in one fixed order: up, down, left, right.
const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const LETTER = ['u', 'd', 'l', 'r'];

// Work budgets (expansions). Fixed counts, never wall time, so runs agree.
const ROOM_MAX_EXPAND = 200_000;
const GLOBAL_MAX_EXPAND = 300_000;
const INSTANCE_BUDGET = 900_000;

interface Parsed {
  w: number;
  h: number;
  wall: Uint8Array;
  goal: Uint8Array;
  boxes: number[];
  player: number;
}

function parseLevel(text: string): Parsed {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goal = new Uint8Array(w * h);
  const boxes: number[] = [];
  let player = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < rows[y].length; x++) {
      const c = rows[y][x];
      if (c === '#') continue;
      const i = y * w + x;
      wall[i] = 0;
      if (c === '.' || c === '*' || c === '+') goal[i] = 1;
      if (c === '$' || c === '*') boxes.push(i);
      if (c === '@' || c === '+') player = i;
    }
  }
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goal, boxes, player };
}

function occupancy(w: number, h: number, boxes: number[]): Uint8Array {
  const occ = new Uint8Array(w * h);
  for (const b of boxes) occ[b] = 1;
  return occ;
}

// The cells the player can reach from `from`, avoiding walls, the cells
// marked in `blocked`, and (when given) cells outside `allow`.
function reachable(
  w: number,
  h: number,
  wall: Uint8Array,
  blocked: Uint8Array,
  from: number,
  allow: Uint8Array | null,
): Uint8Array {
  const seen = new Uint8Array(w * h);
  const queue: number[] = [from];
  seen[from] = 1;
  for (let head = 0; head < queue.length; head++) {
    const c = queue[head];
    const x = c % w;
    const y = (c / w) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const q = ny * w + nx;
      if (wall[q] || blocked[q] || seen[q]) continue;
      if (allow !== null && !allow[q]) continue;
      seen[q] = 1;
      queue.push(q);
    }
  }
  return seen;
}

// Shortest walk (move letters) from `from` to `to`, or null when unreachable.
// Neighbours are tried in the fixed direction order, so the walk is unique.
function walkPath(
  w: number,
  h: number,
  wall: Uint8Array,
  blocked: Uint8Array,
  from: number,
  to: number,
  allow: Uint8Array | null,
): string | null {
  if (from === to) return '';
  const prev = new Int32Array(w * h).fill(-1);
  const prevDir = new Int8Array(w * h);
  const queue: number[] = [from];
  prev[from] = -2;
  for (let head = 0; head < queue.length; head++) {
    const c = queue[head];
    const x = c % w;
    const y = (c / w) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const q = ny * w + nx;
      if (wall[q] || blocked[q] || prev[q] !== -1) continue;
      if (allow !== null && !allow[q]) continue;
      prev[q] = c;
      prevDir[q] = d;
      if (q === to) {
        const letters: string[] = [];
        let cur = q;
        while (cur !== from) {
          letters.push(LETTER[prevDir[cur]]);
          cur = prev[cur];
        }
        letters.reverse();
        return letters.join('');
      }
      queue.push(q);
    }
  }
  return null;
}

// For each goal, the fewest pushes a lone box needs to reach it, ignoring
// other boxes. A box at `a` can be pushed to `a + dir` when the player can
// stand at `a - dir` (a floor cell in `walkable`). Computed backwards from
// each goal over the box cells in `boxOk`.
function pushDistances(
  w: number,
  h: number,
  walkable: Uint8Array,
  boxOk: Uint8Array,
  goals: number[],
): Int32Array[] {
  const out: Int32Array[] = [];
  for (const g of goals) {
    const dist = new Int32Array(w * h).fill(-1);
    dist[g] = 0;
    const queue: number[] = [g];
    for (let head = 0; head < queue.length; head++) {
      const a = queue[head];
      const ax = a % w;
      const ay = (a / w) | 0;
      for (let d = 0; d < 4; d++) {
        // Predecessor cell b: a box at b pushed in direction d lands on a.
        const bx = ax - DX[d];
        const by = ay - DY[d];
        if (bx < 0 || by < 0 || bx >= w || by >= h) continue;
        const b = by * w + bx;
        if (!boxOk[b] || dist[b] !== -1) continue;
        // The pusher must stand at b - d.
        const px = bx - DX[d];
        const py = by - DY[d];
        if (px < 0 || py < 0 || px >= w || py >= h) continue;
        if (!walkable[py * w + px]) continue;
        dist[b] = dist[a] + 1;
        queue.push(b);
      }
    }
    out.push(dist);
  }
  return out;
}

// All orderings of n items, in lexicographic order (deterministic).
function allPermutations(n: number): number[][] {
  const out: number[][] = [];
  const used = new Array<boolean>(n).fill(false);
  const cur: number[] = [];
  const gen = () => {
    if (cur.length === n) {
      out.push(cur.slice());
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = true;
      cur.push(i);
      gen();
      cur.pop();
      used[i] = false;
    }
  };
  gen();
  return out;
}

// 2x2 blocks with no goal in them: a block of walls and boxes only, holding
// a box, can never be left, so any state containing one is dead.
function deadQuads(w: number, h: number, goal: Uint8Array): number[][] {
  const quads: number[][] = [];
  for (let y = 0; y + 1 < h; y++) {
    for (let x = 0; x + 1 < w; x++) {
      const q = [y * w + x, y * w + x + 1, (y + 1) * w + x, (y + 1) * w + x + 1];
      if (q.some((c) => goal[c])) continue;
      quads.push(q);
    }
  }
  return quads;
}

function hasDeadQuad(quads: number[][], wall: Uint8Array, occ: Uint8Array): boolean {
  for (const q of quads) {
    let boxes = 0;
    let closed = true;
    for (const c of q) {
      if (wall[c]) continue;
      if (occ[c]) {
        boxes++;
        continue;
      }
      closed = false;
      break;
    }
    if (closed && boxes > 0) return true;
  }
  return false;
}

interface SearchOpts {
  w: number;
  h: number;
  wall: Uint8Array;
  goalMask: Uint8Array;
  walkable: Uint8Array; // cells the player may stand on
  boxOk: Uint8Array; // cells a box may occupy
  goals: number[]; // sorted
  boxes: number[]; // sorted, initial
  player: number; // initial player cell
  matching: boolean; // min-cost matching heuristic (rooms) vs sum-of-min (fallback)
  maxExpand: number;
  budget: { used: number; limit: number };
}

interface SearchResult {
  moves: string;
  pushes: number;
  endPlayer: number;
}

interface ANode {
  boxes: number[];
  player: number;
  g: number;
  h: number;
  f: number;
  seq: number;
  key: bigint;
  parent: ANode | null;
  from: number; // box cell before the push that led here
  dir: number; // direction of that push
}

function cmpNode(a: ANode, b: ANode): number {
  return a.f - b.f || a.h - b.h || a.seq - b.seq;
}

function heapPush(heap: ANode[], node: ANode): void {
  heap.push(node);
  let i = heap.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (cmpNode(heap[i], heap[p]) < 0) {
      const t = heap[i];
      heap[i] = heap[p];
      heap[p] = t;
      i = p;
    } else break;
  }
}

function heapPop(heap: ANode[]): ANode {
  const top = heap[0];
  const last = heap.pop() as ANode;
  if (heap.length > 0) {
    heap[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < heap.length && cmpNode(heap[l], heap[m]) < 0) m = l;
      if (r < heap.length && cmpNode(heap[r], heap[m]) < 0) m = r;
      if (m === i) break;
      const t = heap[i];
      heap[i] = heap[m];
      heap[m] = t;
      i = m;
    }
  }
  return top;
}

// Push-optimal A* over box configurations. The player position is stored as
// the cell it actually stands on, but states are keyed by the box set plus
// the smallest cell of the player's reachable region, so two states that
// differ only by where the player stands inside one region merge.
function astarPush(opts: SearchOpts): SearchResult | null {
  const { w, h, wall, goalMask, walkable, boxOk, goals } = opts;
  const n = goals.length;
  const size = w * h;
  const dist = pushDistances(w, h, walkable, boxOk, goals);
  // live[c]: fewest pushes for a lone box at c to reach any goal, or -1.
  const live = new Int32Array(size).fill(-1);
  for (let c = 0; c < size; c++) {
    let m = -1;
    for (let g = 0; g < n; g++) {
      const d = dist[g][c];
      if (d >= 0 && (m < 0 || d < m)) m = d;
    }
    live[c] = m;
  }
  for (const b of opts.boxes) if (live[b] < 0) return null;
  const quads = deadQuads(w, h, goalMask);
  const startOcc = occupancy(w, h, opts.boxes);
  if (hasDeadQuad(quads, wall, startOcc)) return null;

  const perms = opts.matching ? allPermutations(n) : null;
  const hCache = new Map<string, number>();
  const heuristic = (boxes: number[]): number => {
    const key = boxes.join(',');
    const hit = hCache.get(key);
    if (hit !== undefined) return hit;
    let v: number;
    if (perms !== null) {
      v = Infinity;
      for (const perm of perms) {
        let s = 0;
        for (let i = 0; i < n; i++) {
          const d = dist[perm[i]][boxes[i]];
          if (d < 0) {
            s = Infinity;
            break;
          }
          s += d;
        }
        if (s < v) v = s;
      }
    } else {
      v = 0;
      for (const b of boxes) {
        const d = live[b];
        if (d < 0) {
          v = Infinity;
          break;
        }
        v += d;
      }
    }
    hCache.set(key, v);
    return v;
  };

  const keyOf = (boxes: number[], canon: number): bigint => {
    let k = BigInt(canon);
    for (const b of boxes) k = k * 256n + BigInt(b);
    return k;
  };
  const canonOf = (boxes: number[], player: number): number => {
    const reach = reachable(w, h, wall, occupancy(w, h, boxes), player, walkable);
    for (let c = 0; c < size; c++) if (reach[c]) return c;
    return player;
  };
  const sameBoxes = (a: number[]): boolean => {
    for (let i = 0; i < n; i++) if (a[i] !== goals[i]) return false;
    return true;
  };

  let seq = 0;
  const startH = heuristic(opts.boxes);
  if (startH === Infinity) return null;
  const startKey = keyOf(opts.boxes, canonOf(opts.boxes, opts.player));
  const start: ANode = {
    boxes: opts.boxes.slice(),
    player: opts.player,
    g: 0,
    h: startH,
    f: startH,
    seq: seq++,
    key: startKey,
    parent: null,
    from: -1,
    dir: -1,
  };
  const heap: ANode[] = [start];
  const best = new Map<bigint, number>();
  best.set(startKey, 0);

  let expansions = 0;
  while (heap.length > 0) {
    const node = heapPop(heap);
    if (best.get(node.key) !== node.g) continue; // superseded entry
    if (sameBoxes(node.boxes)) {
      // Rebuild the move string from the parent chain.
      const segments: string[] = [];
      let cur: ANode | null = node;
      while (cur !== null && cur.parent !== null) {
        const parent = cur.parent;
        const fx = cur.from % w;
        const fy = (cur.from / w) | 0;
        const px = fx - DX[cur.dir];
        const py = fy - DY[cur.dir];
        const pusher = py * w + px;
        const occ = occupancy(w, h, parent.boxes);
        const walk = walkPath(w, h, wall, occ, parent.player, pusher, walkable);
        if (walk === null) return null;
        segments.push(walk + LETTER[cur.dir]);
        cur = parent;
      }
      segments.reverse();
      return { moves: segments.join(''), pushes: node.g, endPlayer: node.player };
    }
    if (expansions >= opts.maxExpand || opts.budget.used >= opts.budget.limit) return null;
    expansions++;
    opts.budget.used++;
    const occ = occupancy(w, h, node.boxes);
    const reach = reachable(w, h, wall, occ, node.player, walkable);
    for (let bi = 0; bi < n; bi++) {
      const b = node.boxes[bi];
      const bx = b % w;
      const by = (b / w) | 0;
      for (let d = 0; d < 4; d++) {
        const px = bx - DX[d];
        const py = by - DY[d];
        const tx = bx + DX[d];
        const ty = by + DY[d];
        if (px < 0 || py < 0 || px >= w || py >= h) continue;
        if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
        const pusher = py * w + px;
        const dest = ty * w + tx;
        if (!reach[pusher]) continue;
        if (!boxOk[dest] || occ[dest]) continue;
        if (live[dest] < 0) continue;
        const nb = node.boxes.slice();
        nb[bi] = dest;
        nb.sort((a, b2) => a - b2);
        const nocc = occupancy(w, h, nb);
        if (hasDeadQuad(quads, wall, nocc)) continue;
        const hh = heuristic(nb);
        if (hh === Infinity) continue;
        const key = keyOf(nb, canonOf(nb, b));
        const g2 = node.g + 1;
        const prev = best.get(key);
        if (prev !== undefined && prev <= g2) continue;
        best.set(key, g2);
        heapPush(heap, {
          boxes: nb,
          player: b,
          g: g2,
          h: hh,
          f: g2 + hh,
          seq: seq++,
          key,
          parent: node,
          from: b,
          dir: d,
        });
      }
    }
  }
  return null;
}

interface Room {
  cells: number[];
  boxes: number[];
  goals: number[];
  door: number;
  entry: number;
}

// Whole-level fallback: the same search over the entire board.
function solveGlobal(text: string, budget: { used: number; limit: number }): string {
  const L = parseLevel(text);
  const { w, h } = L;
  const floor = new Uint8Array(w * h);
  for (let c = 0; c < w * h; c++) if (!L.wall[c]) floor[c] = 1;
  const res = astarPush({
    w,
    h,
    wall: L.wall,
    goalMask: L.goal,
    walkable: floor,
    boxOk: floor,
    goals: sortedGoals(L),
    boxes: L.boxes.slice(),
    player: L.player,
    matching: false,
    maxExpand: GLOBAL_MAX_EXPAND,
    budget,
  });
  return res === null ? '' : res.moves;
}

function sortedGoals(L: Parsed): number[] {
  const out: number[] = [];
  for (let c = 0; c < L.w * L.h; c++) if (L.goal[c]) out.push(c);
  return out;
}

// Solve one level: split into rooms, solve each, stitch with hallway walks.
function solveLevel(text: string): string {
  const budget = { used: 0, limit: INSTANCE_BUDGET };
  const L = parseLevel(text);
  const { w, h } = L;
  const hallRow = (L.player / w) | 0;

  // Connected components of floor off the hallway row.
  const seen = new Uint8Array(w * h);
  const rooms: Room[] = [];
  let decomposed = true;
  for (let c = 0; c < w * h; c++) {
    const y = (c / w) | 0;
    if (L.wall[c] || y === hallRow || seen[c]) continue;
    const cells: number[] = [c];
    seen[c] = 1;
    for (let head = 0; head < cells.length; head++) {
      const cur = cells[head];
      const x = cur % w;
      const cy = (cur / w) | 0;
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d];
        const ny = cy + DY[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || ny === hallRow) continue;
        const q = ny * w + nx;
        if (L.wall[q] || seen[q]) continue;
        seen[q] = 1;
        cells.push(q);
      }
    }
    const inRoom = new Uint8Array(w * h);
    for (const q of cells) inRoom[q] = 1;
    const boxes = L.boxes.filter((b) => inRoom[b]);
    const goals: number[] = [];
    for (const q of cells) if (L.goal[q]) goals.push(q);
    goals.sort((a, b) => a - b);
    // The room's one door: its only cell next to a hallway floor cell.
    let door = -1;
    let entry = -1;
    let adjacencies = 0;
    for (const q of cells) {
      const x = q % w;
      const y = (q / w) | 0;
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d];
        const ny = y + DY[d];
        if (ny !== hallRow || nx < 0 || nx >= w) continue;
        const e = ny * w + nx;
        if (L.wall[e]) continue;
        adjacencies++;
        door = q;
        entry = e;
      }
    }
    if (adjacencies !== 1 || boxes.length === 0 || boxes.length !== goals.length) {
      decomposed = false;
      break;
    }
    rooms.push({ cells, boxes, goals, door, entry });
  }
  // Every box and goal must sit inside some room.
  if (decomposed) {
    const covered = rooms.reduce((s, r) => s + r.boxes.length, 0);
    if (covered !== L.boxes.length) decomposed = false;
    const coveredGoals = rooms.reduce((s, r) => s + r.goals.length, 0);
    if (coveredGoals !== sortedGoals(L).length) decomposed = false;
  }
  if (!decomposed) return solveGlobal(text, budget);

  rooms.sort((a, b) => a.door - b.door);
  const hallWalk = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    const c = hallRow * w + x;
    if (!L.wall[c]) hallWalk[c] = 1;
  }
  // Current box positions across the whole level, updated as rooms finish.
  const boxPos = L.boxes.slice();
  let moves = '';
  let cur = L.player;
  for (let ri = 0; ri < rooms.length; ri++) {
    const room = rooms[ri];
    const occ = occupancy(w, h, boxPos);
    const walk = walkPath(w, h, L.wall, occ, cur, room.entry, hallWalk);
    if (walk === null) return solveGlobal(text, budget);
    moves += walk;
    cur = room.entry;

    const walkable = new Uint8Array(w * h);
    for (const c of room.cells) walkable[c] = 1;
    walkable[room.entry] = 1;
    const boxOk = new Uint8Array(w * h);
    for (const c of room.cells) boxOk[c] = 1;
    const res = astarPush({
      w,
      h,
      wall: L.wall,
      goalMask: L.goal,
      walkable,
      boxOk,
      goals: room.goals,
      boxes: room.boxes.slice(),
      player: room.entry,
      matching: true,
      maxExpand: ROOM_MAX_EXPAND,
      budget,
    });
    if (res === null) return solveGlobal(text, budget);
    moves += res.moves;
    cur = res.endPlayer;
    // The room's boxes now sit on its goals.
    for (let i = 0; i < room.boxes.length; i++) {
      const idx = boxPos.indexOf(room.boxes[i]);
      if (idx >= 0) boxPos[idx] = room.goals[i];
    }
    // Walk back out through the door, unless this was the last room.
    if (ri + 1 < rooms.length) {
      const occAfter = occupancy(w, h, boxPos);
      const out = walkPath(w, h, L.wall, occAfter, cur, room.door, walkable);
      if (out === null) return solveGlobal(text, budget);
      moves += out;
      cur = room.door;
      const dx = (room.entry % w) - (room.door % w);
      const dy = ((room.entry / w) | 0) - ((room.door / w) | 0);
      let d = -1;
      for (let k = 0; k < 4; k++) if (DX[k] === dx && DY[k] === dy) d = k;
      if (d < 0) return solveGlobal(text, budget);
      moves += LETTER[d];
      cur = room.entry;
    }
  }
  return moves;
}

for (const id of readdirSync(IN_DIR).sort()) {
  let moves = '';
  try {
    moves = solveLevel(readFileSync(join(IN_DIR, id, 'level.txt'), 'utf8'));
  } catch {
    moves = '';
  }
  mkdirSync(join(OUT_DIR, id), { recursive: true });
  writeFileSync(join(OUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
