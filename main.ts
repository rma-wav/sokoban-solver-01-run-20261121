// Sokoban solver: push-optimal per-room A*.
//
// Each level is a hallway with rooms hanging off it, one door per room, and
// boxes never leave their room, so a level splits into independent rooms.
// Every room is solved on its own with A* over pushes (state = sorted box
// cells + the player's reachable region), an admissible Hungarian heuristic
// over floor-graph distances box to goal, and dead-square pruning found by
// a reverse pull search from the goals. A* with an admissible heuristic
// returns a push-optimal room solution when the goal state is popped.
// Rooms are then stitched together with plain walks through the hallway.
// No clock, no randomness, no environment input: the search budget is a
// fixed number of expansions, so two runs write identical bytes.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IN_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// dx, dy, letter. Fixed order everywhere, so every search is deterministic.
const DIRS: { dx: number; dy: number; ch: string }[] = [
  { dx: 0, dy: -1, ch: 'u' },
  { dx: 0, dy: 1, ch: 'd' },
  { dx: -1, dy: 0, ch: 'l' },
  { dx: 1, dy: 0, ch: 'r' },
];

interface Parsed {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

function parseLevel(text: string): Parsed {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = 0;
  rows.forEach((row, y) => {
    for (let x = 0; x < w; x++) {
      const ch = row[x] ?? '#';
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

// Breadth-first distances from one start cell over cells where open[i] is 1.
// Returns -1 where unreachable.
function bfsDist(w: number, open: Uint8Array, start: number): Int32Array {
  const dist = new Int32Array(open.length).fill(-1);
  if (!open[start]) return dist;
  const q: number[] = [start];
  dist[start] = 0;
  for (let head = 0; head < q.length; head++) {
    const c = q[head]!;
    const cx = c % w;
    const cy = Math.floor(c / w);
    for (const d of DIRS) {
      const nx = cx + d.dx;
      const ny = cy + d.dy;
      if (nx < 0 || nx >= w || ny < 0) continue;
      const n = ny * w + nx;
      if (n >= open.length || !open[n] || dist[n] >= 0) continue;
      dist[n] = dist[c]! + 1;
      q.push(n);
    }
  }
  return dist;
}

// All cells the player can walk to from `from`, treating `boxes` as walls.
// open marks the floor this search may use. Returns a Uint8Array mask.
function reachable(w: number, open: Uint8Array, boxes: Set<number>, from: number): Uint8Array {
  const seen = new Uint8Array(open.length);
  if (!open[from]) return seen;
  const q: number[] = [from];
  seen[from] = 1;
  for (let head = 0; head < q.length; head++) {
    const c = q[head]!;
    const cx = c % w;
    const cy = Math.floor(c / w);
    for (const d of DIRS) {
      const nx = cx + d.dx;
      const ny = cy + d.dy;
      if (nx < 0 || nx >= w || ny < 0) continue;
      const n = ny * w + nx;
      if (n >= open.length || !open[n] || seen[n] || boxes.has(n)) continue;
      seen[n] = 1;
      q.push(n);
    }
  }
  return seen;
}

// Shortest walk from `from` to `to` over open cells, boxes as walls.
// Returns the move letters, or null when unreachable. Fixed dir order.
function walkPath(
  w: number,
  open: Uint8Array,
  boxes: Set<number>,
  from: number,
  to: number,
): string | null {
  if (from === to) return '';
  const prev = new Int32Array(open.length).fill(-2);
  const prevCh = new Array<string>(open.length).fill('');
  const q: number[] = [from];
  prev[from] = -1;
  for (let head = 0; head < q.length; head++) {
    const c = q[head]!;
    const cx = c % w;
    const cy = Math.floor(c / w);
    for (const d of DIRS) {
      const nx = cx + d.dx;
      const ny = cy + d.dy;
      if (nx < 0 || nx >= w || ny < 0) continue;
      const n = ny * w + nx;
      if (n >= open.length || !open[n] || prev[n] !== -2 || boxes.has(n)) continue;
      prev[n] = c;
      prevCh[n] = d.ch;
      if (n === to) {
        let out = '';
        for (let t = n; t !== from; t = prev[t]!) out = prevCh[t] + out;
        return out;
      }
      q.push(n);
    }
  }
  return null;
}

interface Room {
  // Floor the player may walk on inside this room: room cells + entry cell.
  open: Uint8Array;
  // Cells a box may be pushed onto (room cells only, never the hallway).
  roomOnly: Uint8Array;
  goals: number[];
  boxes: number[];
  entry: number;
  door: number;
}

// Dead squares: cells a single box can never be pushed from onto a goal,
// found by a reverse pull search starting at every goal. A pull moves the
// box into the player's old cell while the player steps away from the box;
// the player may also walk freely around the box. Cells never visited by
// any box in that search are dead, ignoring the other boxes, which can
// only obstruct more.
function deadSquares(w: number, room: Room): Uint8Array {
  const dead = new Uint8Array(room.open.length).fill(1);
  const seen = new Set<string>();
  const q: { b: number; p: number }[] = [];
  for (const g of room.goals) {
    const gx = g % w;
    const gy = Math.floor(g / w);
    for (const d of DIRS) {
      const p = (gy + d.dy) * w + (gx + d.dx);
      if (p < 0 || p >= room.open.length || !room.open[p]) continue;
      const k = g + ':' + p;
      if (seen.has(k)) continue;
      seen.add(k);
      q.push({ b: g, p });
    }
  }
  for (let head = 0; head < q.length; head++) {
    const { b, p } = q[head]!;
    dead[b] = 0;
    const bx = b % w;
    const by = Math.floor(b / w);
    const px = p % w;
    const py = Math.floor(p / w);
    // Player walks to a neighbouring floor cell that is not the box.
    for (const d of DIRS) {
      const nx = px + d.dx;
      const ny = py + d.dy;
      if (nx < 0 || nx >= w || ny < 0) continue;
      const n = ny * w + nx;
      if (n < 0 || n >= room.open.length || !room.open[n] || n === b) continue;
      const k = b + ':' + n;
      if (seen.has(k)) continue;
      seen.add(k);
      q.push({ b, p: n });
    }
    // Pull: the player stands next to the box and steps away from it,
    // the box follows into the player's old cell.
    const dx = px - bx;
    const dy = py - by;
    if (Math.abs(dx) + Math.abs(dy) === 1) {
      const ax = px + dx;
      const ay = py + dy;
      if (ax < 0 || ax >= w || ay < 0) continue;
      const away = ay * w + ax;
      if (away >= 0 && away < room.open.length && room.open[away]) {
        const k = p + ':' + away;
        if (!seen.has(k)) {
          seen.add(k);
          q.push({ b: p, p: away });
        }
      }
    }
  }
  return dead;
}

// Is this box arrangement already lost? A box on a dead square, a full
// 2x2 block of walls and boxes holding a box off its goal, or a box frozen
// against a wall with a wall or box on both sides along it.
function isDead(
  w: number,
  h: number,
  room: Room,
  dead: Uint8Array,
  boxes: number[],
  boxSet: Set<number>,
): boolean {
  const goalSet = new Set(room.goals);
  for (const b of boxes) {
    if (dead[b]) return true;
    if (goalSet.has(b)) continue;
    const bx = b % w;
    const by = Math.floor(b / w);
    // Frozen against a wall: one side is a wall and both cells along the
    // wall next to the box are a wall or another box.
    for (const d of DIRS) {
      const side = (by + d.dy) * w + (bx + d.dx);
      const sideWall = side < 0 || side >= room.open.length || !room.open[side];
      if (!sideWall) continue;
      // Cells along the wall, on both sides of the box.
      const ax = bx - d.dy;
      const ay = by + d.dx;
      const cx2 = bx + d.dy;
      const cy2 = by - d.dx;
      const a = ay * w + ax;
      const c = cy2 * w + cx2;
      const blocked = (cell: number): boolean =>
        cell < 0 || cell >= room.open.length || !room.open[cell] || boxSet.has(cell);
      if (blocked(a) && blocked(c)) return true;
    }
  }
  // Full 2x2 blocks.
  for (let y = 0; y + 1 < h; y++) {
    for (let x = 0; x + 1 < w; x++) {
      const cells = [y * w + x, y * w + x + 1, (y + 1) * w + x, (y + 1) * w + x + 1];
      let floorCount = 0;
      let boxCount = 0;
      let offGoal = false;
      for (const c of cells) {
        if (!room.open[c]) continue;
        floorCount++;
        if (boxSet.has(c)) {
          boxCount++;
          if (!goalSet.has(c)) offGoal = true;
        }
      }
      if (floorCount > 0 && boxCount === floorCount && offGoal) return true;
    }
  }
  return false;
}

// Minimum total floor-graph distance from each box to a distinct goal
// (brute-force assignment, at most 4 boxes). Admissible: one push moves
// one box one cell, so it shortens that box's distance by at most one.
function heuristic(distGoal: Int32Array[], boxes: number[]): number {
  const n = boxes.length;
  const m = distGoal.length;
  if (n === 0) return 0;
  let best = Infinity;
  const used = new Array<boolean>(m).fill(false);
  const rec = (i: number, total: number): void => {
    if (total >= best) return;
    if (i === n) {
      best = total;
      return;
    }
    for (let g = 0; g < m; g++) {
      if (used[g]) continue;
      const d = distGoal[g]![boxes[i]!]!;
      if (d < 0) continue;
      used[g] = true;
      rec(i + 1, total + d);
      used[g] = false;
    }
  };
  rec(0, 0);
  return best;
}

interface PushStep {
  box: number;
  dir: number;
}

interface RoomSolution {
  pushes: PushStep[];
  endPlayer: number;
}

// A* over pushes for one room (or, with room covering the whole level,
// for the whole level). `needExit` requires the final player to be able
// to walk to the door; `weight` scales the heuristic (1 = exact, optimal).
function solveRoom(
  w: number,
  h: number,
  room: Room,
  maxExpansions: number,
  weight: number,
  needExit: boolean,
): RoomSolution | null {
  const dead = deadSquares(w, room);
  const distGoal = room.goals.map((g) => bfsDist(w, room.open, g));
  const goalSet = new Set(room.goals);
  const startBoxes = room.boxes.slice().sort((a, b) => a - b);
  if (startBoxes.some((b) => dead[b])) return null;

  const boxArr: number[][] = [startBoxes];
  const playerArr: number[] = [room.entry];
  const gArr: number[] = [0];
  const parentArr: number[] = [-1];
  const pushBoxArr: number[] = [-1];
  const pushDirArr: number[] = [-1];
  const best = new Map<string, number>();
  const canon = (boxes: number[], player: number): string => {
    const reach = reachable(w, room.open, new Set(boxes), player);
    let rep = -1;
    for (let i = 0; i < reach.length; i++) {
      if (reach[i]) {
        rep = i;
        break;
      }
    }
    return rep + '|' + boxes.join(',');
  };
  best.set(canon(startBoxes, room.entry), 0);

  // Binary heap of [f, -g, seq, node]. seq breaks ties deterministically.
  const heap: [number, number, number, number][] = [];
  let seq = 0;
  const heapLess = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(heap[i]!, heap[p]!)) break;
      const t = heap[i]!;
      heap[i] = heap[p]!;
      heap[p] = t;
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heapLess(heap[c + 1]!, heap[c]!)) c++;
        if (!heapLess(heap[c]!, heap[i]!)) break;
        const t = heap[i]!;
        heap[i] = heap[c]!;
        heap[c] = t;
        i = c;
      }
    }
    return top;
  };

  const h0 = heuristic(distGoal, startBoxes);
  if (h0 === Infinity) return null;
  heapPush([weight * h0, 0, seq++, 0]);

  let expanded = 0;
  while (heap.length > 0 && expanded < maxExpansions) {
    const [, negG, , node] = heapPop();
    const g = -negG;
    const boxes = boxArr[node]!;
    if (best.get(canon(boxes, playerArr[node]!)) !== node) continue;
    const player = playerArr[node]!;
    // Goal: every box on a goal, and (when asked) the player can walk out.
    if (boxes.every((b) => goalSet.has(b))) {
      if (!needExit) {
        return { pushes: tracePushes(node), endPlayer: player };
      }
      const reach = reachable(w, room.open, new Set(boxes), player);
      if (reach[room.door]) {
        return { pushes: tracePushes(node), endPlayer: player };
      }
    }
    expanded++;
    const boxSet = new Set(boxes);
    const reach = reachable(w, room.open, boxSet, player);
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi]!;
      const bx = b % w;
      const by = Math.floor(b / w);
      for (let di = 0; di < DIRS.length; di++) {
        const d = DIRS[di]!;
        if (bx - d.dx < 0 || bx - d.dx >= w || bx + d.dx < 0 || bx + d.dx >= w) continue;
        const behind = (by - d.dy) * w + (bx - d.dx);
        const dest = (by + d.dy) * w + (bx + d.dx);
        if (behind < 0 || behind >= room.open.length || !reach[behind]) continue;
        if (dest < 0 || dest >= room.open.length || !room.roomOnly[dest]) continue;
        if (boxSet.has(dest)) continue;
        const nb = boxes.slice();
        nb[bi] = dest;
        nb.sort((a, b2) => a - b2);
        const nbSet = new Set(nb);
        if (isDead(w, h, room, dead, nb, nbSet)) continue;
        const hh = heuristic(distGoal, nb);
        if (hh === Infinity) continue;
        const key = canon(nb, b);
        const prev = best.get(key);
        if (prev !== undefined && gArr[prev]! <= g + 1) continue;
        const id = boxArr.length;
        boxArr.push(nb);
        playerArr.push(b);
        gArr.push(g + 1);
        parentArr.push(node);
        pushBoxArr.push(b);
        pushDirArr.push(di);
        best.set(key, id);
        heapPush([g + 1 + weight * hh, -(g + 1), seq++, id]);
      }
    }
  }
  return null;

  function tracePushes(node: number): PushStep[] {
    const out: PushStep[] = [];
    for (let t = node; t > 0; t = parentArr[t]!) {
      out.push({ box: pushBoxArr[t]!, dir: pushDirArr[t]! });
    }
    out.reverse();
    return out;
  }
}

// Turn a room's push list into player moves, walking between pushes.
function roomMoves(
  w: number,
  room: Room,
  sol: RoomSolution,
): { moves: string; endPlayer: number } | null {
  let moves = '';
  let player = room.entry;
  const boxes = room.boxes.slice().sort((a, b) => a - b);
  for (const step of sol.pushes) {
    const d = DIRS[step.dir]!;
    const bx = step.box % w;
    const by = Math.floor(step.box / w);
    const behind = (by - d.dy) * w + (bx - d.dx);
    const dest = (by + d.dy) * w + (bx + d.dx);
    const walk = walkPath(w, room.open, new Set(boxes), player, behind);
    if (walk === null) return null;
    moves += walk + d.ch;
    const at = boxes.indexOf(step.box);
    if (at < 0) return null;
    boxes[at] = dest;
    boxes.sort((a, b) => a - b);
    player = step.box;
  }
  if (player !== sol.endPlayer) return null;
  return { moves, endPlayer: player };
}

// Split a level into its hallway and its rooms. The hallway is the row
// the player starts on; every other floor component touching that row
// through exactly one door cell is a room.
function splitRooms(p: Parsed): Room[] | null {
  const hy = Math.floor(p.player / p.w);
  const seen = new Uint8Array(p.w * p.h);
  const rooms: Room[] = [];
  for (let i = 0; i < p.w * p.h; i++) {
    if (p.wall[i] || seen[i]) continue;
    if (Math.floor(i / p.w) === hy) continue;
    // One connected component of non-hallway floor.
    const comp: number[] = [];
    const q: number[] = [i];
    seen[i] = 1;
    for (let head = 0; head < q.length; head++) {
      const c = q[head]!;
      comp.push(c);
      const cx = c % p.w;
      const cy = Math.floor(c / p.w);
      for (const d of DIRS) {
        const nx = cx + d.dx;
        const ny = cy + d.dy;
        if (nx < 0 || nx >= p.w || ny < 0 || ny >= p.h) continue;
        const n = ny * p.w + nx;
        if (p.wall[n] || seen[n] || ny === hy) continue;
        seen[n] = 1;
        q.push(n);
      }
    }
    const compSet = new Set(comp);
    const boxes = p.boxes.filter((b) => compSet.has(b));
    if (boxes.length === 0) continue;
    const goals = p.goals.filter((g) => compSet.has(g));
    if (goals.length !== boxes.length) return null;
    // Door cells: component cells next to a hallway floor cell.
    const doors = comp.filter((c) => {
      const cx = c % p.w;
      const cy = Math.floor(c / p.w);
      const n = hy * p.w + cx;
      return Math.abs(cy - hy) === 1 && !p.wall[n];
    });
    if (doors.length === 0) return null;
    doors.sort((a, b) => a - b);
    const door = doors[0]!;
    const entry = hy * p.w + (door % p.w);
    const open = new Uint8Array(p.w * p.h);
    const roomOnly = new Uint8Array(p.w * p.h);
    for (const c of comp) {
      open[c] = 1;
      roomOnly[c] = 1;
    }
    open[entry] = 1;
    rooms.push({ open, roomOnly, goals, boxes, entry, door });
  }
  if (rooms.length === 0) return null;
  rooms.sort((a, b) => a.door - b.door);
  return rooms;
}

function solveLevel(text: string): string {
  const p = parseLevel(text);
  const globalOpen = new Uint8Array(p.w * p.h);
  for (let i = 0; i < globalOpen.length; i++) globalOpen[i] = p.wall[i] ? 0 : 1;

  const rooms = splitRooms(p);
  if (rooms !== null) {
    let moves = '';
    let player = p.player;
    const globalBoxes = p.boxes.slice().sort((a, b) => a - b);
    let ok = true;
    for (let ri = 0; ri < rooms.length; ri++) {
      const room = rooms[ri]!;
      const last = ri === rooms.length - 1;
      // Exact A* first; a weighted run still solves the room when the
      // exact search runs out of its fixed expansion budget.
      let sol = solveRoom(p.w, p.h, room, 200_000, 1, !last);
      if (sol === null) sol = solveRoom(p.w, p.h, room, 200_000, 2, !last);
      if (sol === null) sol = solveRoom(p.w, p.h, room, 200_000, 4, !last);
      if (sol === null) {
        ok = false;
        break;
      }
      const walk = walkPath(p.w, globalOpen, new Set(globalBoxes), player, room.entry);
      if (walk === null) {
        ok = false;
        break;
      }
      moves += walk;
      const rm = roomMoves(p.w, room, sol);
      if (rm === null) {
        ok = false;
        break;
      }
      moves += rm.moves;
      // The room's boxes now sit on its goals.
      for (let i = globalBoxes.length - 1; i >= 0; i--) {
        if (room.boxes.includes(globalBoxes[i]!)) globalBoxes.splice(i, 1);
      }
      globalBoxes.push(...room.goals);
      globalBoxes.sort((a, b) => a - b);
      player = rm.endPlayer;
      if (!last) {
        const exit = walkPath(p.w, room.open, new Set(room.goals), player, room.door);
        if (exit === null) {
          ok = false;
          break;
        }
        moves += exit;
        const dx = (room.entry % p.w) - (room.door % p.w);
        const dy = Math.floor(room.entry / p.w) - Math.floor(room.door / p.w);
        const step = DIRS.find((d) => d.dx === dx && d.dy === dy);
        if (!step) {
          ok = false;
          break;
        }
        moves += step.ch;
        player = room.entry;
      }
    }
    if (ok) return moves;
  }

  // Fallback: one push A* over the whole level.
  const whole: Room = {
    open: globalOpen,
    roomOnly: globalOpen,
    goals: p.goals,
    boxes: p.boxes,
    entry: p.player,
    door: p.player,
  };
  let sol = solveRoom(p.w, p.h, whole, 300_000, 1, false);
  if (sol === null) sol = solveRoom(p.w, p.h, whole, 300_000, 3, false);
  if (sol === null) return '';
  const rm = roomMoves(p.w, whole, sol);
  return rm === null ? '' : rm.moves;
}

for (const id of readdirSync(IN_DIR).sort()) {
  const moves = solveLevel(readFileSync(join(IN_DIR, id, 'level.txt'), 'utf8'));
  mkdirSync(join(OUT_DIR, id), { recursive: true });
  writeFileSync(join(OUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
