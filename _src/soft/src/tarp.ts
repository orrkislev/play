// A square or rectangle of cloth staked to the ground at its four corners. The stakes sit closer together
// than the cloth is long, so the cloth has slack between them. Its rest lengths don't change,
// so this relaxes the sheet into the shape it takes with no tension: bowed up between stakes.

/** Stakes sit at this fraction of the corner's distance from the centre: [.5, .5] goes to [.4, .4]. */
export const STAKE_SCALE = 0.55 / 0.55;
/** Height the free cloth starts at before relaxing, in metres. */
const START_LIFT = 0.1;
/** Relaxation passes over every edge. */
const ITERATIONS = 1500;

/** Vertices of a grid of `columns` × `rows` cells that hold the four corners. */
export function tarpCorners(columns: number, rows: number): number[] {
  const side = columns + 1;
  return [0, columns, rows * side, (rows + 1) * side - 1];
}

/**
 * Relaxes a grid of cloth in place. `positions` holds x, y, z per vertex, row by row, laid
 * flat on the ground at height `ground`. The corners move in to their stakes; the rest of the
 * sheet relaxes against the cloth's own edge lengths, held above the ground.
 */
export function relaxTarp(positions: Float32Array, columns: number, rows: number, ground: number): void {
  const side = columns + 1;
  const count = side * (rows + 1);
  const corners = tarpCorners(columns, rows);

  // Every grid edge, plus one diagonal per cell: the same edges the cloth graph holds.
  const pairs: number[] = [];
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= columns; i++) {
      const v = j * side + i;
      if (i < columns) pairs.push(v, v + 1);
      if (j < rows) pairs.push(v, v + side);
      if (i < columns && j < rows) pairs.push(v + side, v + 1);
    }
  }
  const rest = new Float32Array(pairs.length / 2);
  for (let e = 0; e < rest.length; e++) {
    rest[e] = distance(positions, pairs[2 * e]!, pairs[2 * e + 1]!);
  }

  // Stakes first, then the free cloth lifted off the ground.
  const pinned = new Set(corners);
  for (let v = 0; v < count; v++) {
    if (pinned.has(v)) {
      positions[v * 3]! *= STAKE_SCALE;
      positions[v * 3 + 1] = ground;
      positions[v * 3 + 2]! *= STAKE_SCALE;
    } else {
      positions[v * 3 + 1] = ground + START_LIFT;
    }
  }

  // Position-based relaxation: each edge is pushed back to its rest length, the stakes stay put.
  const weight = new Float32Array(count).fill(1);
  for (const v of corners) weight[v] = 0;
  for (let pass = 0; pass < ITERATIONS; pass++) {
    for (let e = 0; e < rest.length; e++) {
      const a = pairs[2 * e]!;
      const b = pairs[2 * e + 1]!;
      const wa = weight[a]!;
      const wb = weight[b]!;
      if (wa + wb === 0) continue;
      const d = distance(positions, a, b);
      if (d < 1e-9) continue;
      const push = ((d - rest[e]!) / d) / (wa + wb);
      for (let k = 0; k < 3; k++) {
        const delta = (positions[b * 3 + k]! - positions[a * 3 + k]!) * push;
        positions[a * 3 + k]! += delta * wa;
        positions[b * 3 + k]! -= delta * wb;
      }
    }
    // The cloth can't sink through the ground.
    for (let v = 0; v < count; v++) {
      if (weight[v] !== 0 && positions[v * 3 + 1]! < ground) positions[v * 3 + 1] = ground;
    }
  }
}

function distance(p: Float32Array, a: number, b: number): number {
  return Math.hypot(p[b * 3]! - p[a * 3]!, p[b * 3 + 1]! - p[a * 3 + 1]!, p[b * 3 + 2]! - p[a * 3 + 2]!);
}
