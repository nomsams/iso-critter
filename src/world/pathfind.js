// 4-directional A* over the tile grid. Small enough map that a binary heap is
// overkill, but the open list is kept sorted-on-insert so paths stay cheap even
// when the critter re-plans every few seconds.

const STEP_DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];

/**
 * @param world   provides isWalkable(gx,gy) and the grid bounds
 * @param start   [gx,gy]
 * @param goals   array of [gx,gy] — the path ends at whichever is cheapest
 * @param avoid   optional Set of "gx,gy" keys — other critters' current cells,
 *                treated as temporarily blocked so paths route around them
 *                instead of walking straight through/onto each other. The
 *                start cell is never treated as blocked even if it's in here.
 * @param transit optional Set of "gx,gy" keys — cells (currently the room
 *                rim) that are fine as the actual destination but not as a
 *                shortcut through: unlike `avoid`, these stay valid goals.
 * @param avoidEdges optional Set of world.edgeKey(...) values learned when a
 *                swept-body collision rejects an otherwise valid grid edge.
 * @returns array of [gx,gy] steps (excluding start), or null
 */
export function findPath(world, start, goals, avoid, transit, avoidEdges = null) {
  if (!goals.length) return null;
  const key = (x, y) => y * world.cols + x;
  const startKey = key(start[0], start[1]);
  const blocked = (x, y) => avoid && avoid.has(x + ',' + y) && key(x, y) !== startKey;
  const transitBlocked = (x, y) => transit && transit.has(x + ',' + y);
  const goalSet = new Set();
  for (const [gx, gy] of goals) {
    if (world.inBounds(gx, gy) && world.isWalkable(gx, gy) && !blocked(gx, gy)) goalSet.add(key(gx, gy));
  }
  if (!goalSet.size) return null;
  if (goalSet.has(key(start[0], start[1]))) return [];

  const h = (x, y) => {
    let best = Infinity;
    for (const [gx, gy] of goals) best = Math.min(best, Math.abs(gx - x) + Math.abs(gy - y));
    return best;
  };

  const came = new Map(), g = new Map();
  const open = [{ x: start[0], y: start[1], f: h(start[0], start[1]) }];
  g.set(key(start[0], start[1]), 0);
  let guard = 0;

  while (open.length && guard++ < 4000) {
    const cur = open.shift();
    const ck = key(cur.x, cur.y);
    if (goalSet.has(ck)) {
      const path = [];
      let k = ck, node = [cur.x, cur.y];
      while (came.has(k)) { path.push(node); node = came.get(k); k = key(node[0], node[1]); }
      return path.reverse();
    }
    const cg = g.get(ck);
    for (const [dx, dy] of STEP_DIRS) {
      const nx = cur.x + dx, ny = cur.y + dy;
      if (!world.inBounds(nx, ny) || !world.isWalkable(nx, ny) || blocked(nx, ny)) continue;
      const edge = world.edgeKey(cur.x, cur.y, nx, ny);
      if (world.edgeBlocked(cur.x, cur.y, nx, ny) || avoidEdges?.has(edge)) continue;
      const nk = key(nx, ny);
      if (transitBlocked(nx, ny) && !goalSet.has(nk)) continue;
      const ng = cg + world.stepCost(nx, ny);
      if (g.has(nk) && g.get(nk) <= ng) continue;
      g.set(nk, ng);
      came.set(nk, [cur.x, cur.y]);
      const f = ng + h(nx, ny);
      let i = 0;
      while (i < open.length && open[i].f <= f) i++;
      open.splice(i, 0, { x: nx, y: ny, f });
    }
  }
  return null;
}
