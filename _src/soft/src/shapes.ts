// Cloth shapes. Each shape is a few grid pieces (a disc, an ellipse, a rectangle, a
// circle) laid out in the XY plane, then stitched at their edges into one piece of
// cloth. Pieces join where their edge particles sit one spacing apart.
import { BufferGeometry, Float32BufferAttribute } from 'three';

/** A grid of particles in the XY plane, `columns` × `rows` cells. */
export interface Piece {
  readonly columns: number;
  readonly rows: number;
  /** x, y of each vertex, row by row: (columns + 1) × (rows + 1) vertices. */
  readonly xy: Float32Array;
}

export type ShapeName = 'sun' | 'person' | 'horse' | 'random' | 'square';

/** Side of the square, in metres. Matches the cloth's size in main.ts. */
const SQUARE_SIDE = 1.1;

/** The pieces joined into one mesh, the seams that stitch them, and whether they form one piece. */
export interface Assembly {
  readonly geometry: BufferGeometry;
  /** First vertex of each piece, and its grid size. */
  readonly pieces: readonly { readonly start: number; readonly columns: number; readonly rows: number }[];
  /** Pairs of vertices held a fixed distance apart, which is their rest length. */
  readonly seams: readonly { readonly a: number; readonly b: number; readonly rest: number }[];
  /** True when every piece is joined to the others, directly or through a chain of seams. */
  readonly connected: boolean;
}

/** Two edge vertices closer than this many spacings are joined by a seam. */
const SEAM_REACH = 1.6;

/**
 * A disc or ellipse with its centre at (cx, cy). Its grid is the square-to-disc mapping
 * (Shirley & Chiu), so the grid keeps its topology and the square's edges become the rim.
 */
export function disk(cx: number, cy: number, rx: number, ry: number, h: number): Piece {
  const columns = Math.max(4, Math.round((2 * rx) / h));
  const rows = Math.max(4, Math.round((2 * ry) / h));
  const side = columns + 1;
  const xy = new Float32Array(side * (rows + 1) * 2);
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= columns; i++) {
      // Same layout as PlaneGeometry: x grows with the column, y falls with the row.
      const [u, v] = concentric(2 * (i / columns) - 1, 1 - 2 * (j / rows));
      const vertex = (j * side + i) * 2;
      xy[vertex] = cx + rx * u;
      xy[vertex + 1] = cy + ry * v;
    }
  }
  return { columns, rows, xy };
}

/** A circle of radius r centred at (cx, cy). */
export function circle(cx: number, cy: number, r: number, h: number): Piece {
  return disk(cx, cy, r, r, h);
}

/** A flat square of side `side`, centred on (cx, cy), with its edges parallel to the axes. */
export function square(cx: number, cy: number, side: number, h: number): Piece {
  return rectangle(cx, cy, side, side, h);
}

/** A flat rectangle `width` × `height`, centred on (cx, cy), with its edges parallel to the axes. */
export function rectangle(cx: number, cy: number, width: number, height: number, h: number): Piece {
  const columns = Math.max(4, Math.round(width / h));
  const rows = Math.max(4, Math.round(height / h));
  const side = columns + 1;
  const xy = new Float32Array(side * (rows + 1) * 2);
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= columns; i++) {
      const vertex = (j * side + i) * 2;
      xy[vertex] = cx + width * (i / columns - 0.5);
      xy[vertex + 1] = cy + height * (0.5 - j / rows);
    }
  }
  return { columns, rows, xy };
}

/**
 * A rectangle running out from a run of the parent's edge vertices, centred on
 * `angle` around the parent. It is `width` wide and `length` long, one spacing
 * from the edge, and runs along `direction` (the edge's outward normal by default).
 */
export function fin(
  parent: Piece,
  angle: number,
  width: number,
  length: number,
  h: number,
  direction?: readonly [number, number],
): Piece {
  const ring = perimeter(parent);
  const c = centre(parent, ring);
  let nearest = 0;
  let best = Infinity;
  ring.forEach((v, r) => {
    const gap = angleGap(Math.atan2(at(parent, v)[1] - c[1], at(parent, v)[0] - c[0]), angle);
    if (gap < best) {
      best = gap;
      nearest = r;
    }
  });
  const count = Math.max(1, Math.round(width / h));
  const first = nearest - Math.round(count / 2);
  const joints = Array.from({ length: count + 1 }, (_, k) => ring[(first + k + ring.length) % ring.length]!);

  // Unless given, run along the outward normal of the joint run: perpendicular to its chord.
  const [ax, ay] = at(parent, joints[0]!);
  const [bx, by] = at(parent, joints[count]!);
  const chordLength = Math.hypot(bx - ax, by - ay);
  const normal: [number, number] = [(by - ay) / chordLength, -(bx - ax) / chordLength];
  if (normal[0] * (c[0] - (ax + bx) / 2) + normal[1] * (c[1] - (ay + by) / 2) > 0) {
    normal[0] = -normal[0];
    normal[1] = -normal[1];
  }
  let [dx, dy] = direction ?? normal;
  const length2 = Math.hypot(dx, dy);
  dx /= length2;
  dy /= length2;
  // A direction that turns back into the parent would bury the piece in it.
  if (direction && dx * normal[0] + dy * normal[1] < 0.3) {
    throw new Error(`fin: direction (${dx.toFixed(2)}, ${dy.toFixed(2)}) points into the parent at angle ${angle}`);
  }

  const rows = Math.max(1, Math.round(length / h));
  const side = count + 1;
  const xy = new Float32Array(side * (rows + 1) * 2);
  for (let k = 0; k <= rows; k++) {
    for (let col = 0; col <= count; col++) {
      const [x, y] = at(parent, joints[col]!);
      const out = h * (k + 1);
      const vertex = (k * side + col) * 2;
      xy[vertex] = x + dx * out;
      xy[vertex + 1] = y + dy * out;
    }
  }
  return { columns: count, rows, xy };
}

/**
 * Unit normal of a piece's far edge, pointing away from its near edge. Along it, a
 * piece that runs straight out has its far edge square on.
 */
export function endNormal(p: Piece): [number, number] {
  const side = p.columns + 1;
  const [ax, ay] = at(p, p.rows * side);
  const [bx, by] = at(p, p.rows * side + p.columns);
  const length = Math.hypot(bx - ax, by - ay);
  let nx = (by - ay) / length;
  let ny = -(bx - ax) / length;
  // Point it away from the near edge, the first row, whose centre is the average of its vertices.
  const [nearX, nearY] = rowCentre(p, 0);
  const [ex, ey] = endCentre(p);
  if (nx * (ex - nearX) + ny * (ey - nearY) < 0) {
    nx = -nx;
    ny = -ny;
  }
  return [nx, ny];
}

/** Centre of a piece's far edge: the average of its last row. */
export function endCentre(p: Piece): [number, number] {
  return rowCentre(p, p.rows);
}

/** Average of one row of a piece's vertices. */
function rowCentre(p: Piece, row: number): [number, number] {
  const side = p.columns + 1;
  let x = 0;
  let y = 0;
  for (let i = 0; i <= p.columns; i++) {
    const [u, v] = at(p, row * side + i);
    x += u;
    y += v;
  }
  return [x / side, y / side];
}

/**
 * Point on a parent's edge nearest `angle`, with its outward normal. Used to hang
 * a circle off the edge.
 */
export function edgePoint(parent: Piece, angle: number): { point: [number, number]; normal: [number, number] } {
  const ring = perimeter(parent);
  const c = centre(parent, ring);
  let nearest = 0;
  let best = Infinity;
  ring.forEach((v, r) => {
    const gap = angleGap(Math.atan2(at(parent, v)[1] - c[1], at(parent, v)[0] - c[0]), angle);
    if (gap < best) {
      best = gap;
      nearest = r;
    }
  });
  const v = ring[nearest]!;
  const prev = at(parent, ring[(nearest - 1 + ring.length) % ring.length]!);
  const next = at(parent, ring[(nearest + 1) % ring.length]!);
  let nx = next[1] - prev[1];
  let ny = -(next[0] - prev[0]);
  const length = Math.hypot(nx, ny);
  nx /= length;
  ny /= length;
  const [px, py] = at(parent, v);
  if (nx * (px - c[0]) + ny * (py - c[1]) < 0) {
    nx = -nx;
    ny = -ny;
  }
  return { point: [px, py], normal: [nx, ny] };
}

/**
 * Joins the pieces into one mesh: vertices stacked piece by piece, two triangles per grid
 * cell, and a seam between each pair of edge vertices that sit close together. Each vertex
 * joins at most one seam, taking the closest partners first.
 */
export function assemble(pieces: readonly Piece[], h: number): Assembly {
  const starts: number[] = [];
  let total = 0;
  for (const p of pieces) {
    starts.push(total);
    total += (p.columns + 1) * (p.rows + 1);
  }
  const position = new Float32Array(total * 3);
  const owner = new Int32Array(total);
  const index: number[] = [];
  pieces.forEach((p, n) => {
    const start = starts[n]!;
    const side = p.columns + 1;
    for (let v = 0; v < side * (p.rows + 1); v++) {
      const [x, y] = at(p, v);
      position[(start + v) * 3] = x;
      position[(start + v) * 3 + 1] = y;
      owner[start + v] = n;
    }
    // Same winding as PlaneGeometry.
    for (let j = 0; j < p.rows; j++) {
      for (let i = 0; i < p.columns; i++) {
        const a = start + j * side + i,
          b = a + side,
          d = a + 1,
          e = b + 1;
        index.push(a, b, d, b, e, d);
      }
    }
  });

  const edges = pieces.map((p, n) => perimeter(p).map((v) => starts[n]! + v));
  const candidates: { a: number; b: number; d: number }[] = [];
  for (let n = 0; n < pieces.length; n++) {
    for (let m = n + 1; m < pieces.length; m++) {
      for (const a of edges[n]!) {
        for (const b of edges[m]!) {
          const d = Math.hypot(
            position[a * 3]! - position[b * 3]!,
            position[a * 3 + 1]! - position[b * 3 + 1]!,
            position[a * 3 + 2]! - position[b * 3 + 2]!,
          );
          if (d < SEAM_REACH * h) candidates.push({ a, b, d });
        }
      }
    }
  }
  candidates.sort((x, y) => x.d - y.d);
  const taken = new Set<number>();
  const seams: { a: number; b: number; rest: number }[] = [];
  for (const { a, b, d } of candidates) {
    if (taken.has(a) || taken.has(b)) continue;
    taken.add(a);
    taken.add(b);
    seams.push({ a, b, rest: d });
  }

  // Union-find over pieces, to tell whether the seams hold them all together.
  const parent = pieces.map((_, n) => n);
  const root = (n: number): number => (parent[n] === n ? n : (parent[n] = root(parent[n]!)));
  for (const { a, b } of seams) parent[root(owner[a]!)] = root(owner[b]!);
  const connected = pieces.every((_, n) => root(n) === root(0));

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(position, 3));
  geometry.setIndex(index);
  return {
    geometry,
    pieces: pieces.map((p, n) => ({ start: starts[n]!, columns: p.columns, rows: p.rows })),
    seams,
    connected,
  };
}

/** The shape with this name, as its pieces. Random is redrawn on every call. */
export function makeShape(name: ShapeName, h: number): Piece[] {
  switch (name) {
    case 'sun':
      return sun(h);
    case 'person':
      return person(h);
    case 'horse':
      return horse(h);
    case 'random':
      return randomShape(h);
    case 'square':
      return [square(0, 0, SQUARE_SIDE, h)];
  }
}

/** A disc with twelve strips fringing its rim. */
function sun(h: number): Piece[] {
  const body = disk(0, 0, 0.55, 0.55, h);
  const strips = Array.from({ length: 12 }, (_, s) =>
    fin(body, Math.PI / 2 + (2 * Math.PI * s) / 12, 0.1, 0.5, h),
  );
  return [body, ...strips];
}

/** An ellipse body, a head on top, two arms and two legs. */
function person(h: number): Piece[] {
  const body = disk(0, 0, 0.2, 0.27, h);
  // The head's bottom sits one spacing above the body's top edge.
  const head = circle(0, 0.27 + 0.1 + h, 0.1, h);
  // The legs run along the body's own normals, so they splay out from the hips.
  const legs = [-Math.PI / 2 - 0.45, -Math.PI / 2 + 0.45].map((angle) => fin(body, angle, 0.1, 0.45, h));
  const arms = [
    fin(body, 0.3, 0.08, 0.4, h, [0.9, -0.4]),
    fin(body, Math.PI - 0.3, 0.08, 0.4, h, [-0.9, -0.4]),
  ];
  return [body, head, ...legs, ...arms];
}

/** A horizontal ellipse body, four legs, a neck with a head, and a tail. */
function horse(h: number): Piece[] {
  const body = disk(0, 0, 0.42, 0.16, h);
  // Two legs toward each end of the body.
  const legs = [-0.35, -0.95, -Math.PI + 0.95, -Math.PI + 0.35].map((angle) => fin(body, angle, 0.05, 0.36, h));
  // The neck runs along its own edge normal, so its far edge is square to it and the
  // head can sit on that edge.
  const neck = fin(body, 0.28, 0.1, 0.25, h);
  const [tipX, tipY] = endCentre(neck);
  const [nx, ny] = endNormal(neck);
  const headRadius = 0.085;
  const head = circle(tipX + nx * (headRadius + h), tipY + ny * (headRadius + h), headRadius, h);
  // At the tip, where the edge faces left, so the tail leaves the body cleanly.
  const tail = fin(body, Math.PI, 0.03, 0.22, h, normalised(-0.95, -0.3));
  return [body, ...legs, neck, head, tail];
}

/**
 * An ellipse body with a random set of rectangles and circles hung off its edge.
 * Retries until every piece is attached.
 */
function randomShape(h: number): Piece[] {
  for (let attempt = 0; attempt < 50; attempt++) {
    const pieces = randomPieces(h, Math.random);
    if (assemble(pieces, h).connected) return pieces;
  }
  throw new Error('randomShape: could not draw a connected shape');
}

/** One draw of a random body: each of its eight edge slots gets a rectangle, a circle, or nothing. */
export function randomPieces(h: number, random: () => number): Piece[] {
  const body = disk(0, 0, 0.18 + 0.17 * random(), 0.18 + 0.17 * random(), h);
  const pieces = [body];
  const slots = 8;
  for (let s = 0; s < slots; s++) {
    if (random() > 0.75) continue;
    const angle = (2 * Math.PI * s) / slots + (random() - 0.5) * 0.2;
    if (random() < 0.5) {
      pieces.push(fin(body, angle, 0.05 + 0.03 * random(), 0.12 + 0.18 * random(), h));
    } else {
      const radius = 0.03 + 0.03 * random();
      const { point, normal } = edgePoint(body, angle);
      pieces.push(
        circle(
          point[0] + normal[0] * (radius + h),
          point[1] + normal[1] * (radius + h),
          radius,
          h,
        ),
      );
    }
  }
  return pieces;
}

/** Concentric square-to-disc mapping of a point in [-1, 1]²: a point in the unit disc. */
function concentric(a: number, b: number): [number, number] {
  let r: number, theta: number;
  if (Math.abs(a) > Math.abs(b)) {
    r = a;
    theta = (Math.PI / 4) * (b / (a || 1e-9));
  } else {
    r = b;
    theta = Math.PI / 2 - (Math.PI / 4) * (a / (b || 1e-9));
  }
  return [r * Math.cos(theta), r * Math.sin(theta)];
}

/** Vertices on a grid's outer edge, in order around its centre. */
function perimeter(p: Piece): number[] {
  const side = p.columns + 1;
  const found = new Set<number>();
  for (let i = 0; i <= p.columns; i++) {
    found.add(i);
    found.add(p.rows * side + i);
  }
  for (let j = 0; j <= p.rows; j++) {
    found.add(j * side);
    found.add(j * side + p.columns);
  }
  const ids = [...found];
  const c = centre(p, ids);
  const angleOf = (v: number): number => {
    const [x, y] = at(p, v);
    return Math.atan2(y - c[1], x - c[0]);
  };
  return ids.sort((u, v) => angleOf(u) - angleOf(v));
}

/** Mean of the given vertices. */
function centre(p: Piece, ids: readonly number[]): [number, number] {
  let x = 0;
  let y = 0;
  for (const v of ids) {
    const [u, w] = at(p, v);
    x += u;
    y += w;
  }
  return [x / ids.length, y / ids.length];
}

/** Position of vertex v in the XY plane. */
function at(p: Piece, v: number): [number, number] {
  return [p.xy[2 * v]!, p.xy[2 * v + 1]!];
}

/** Shortest distance between two angles, in radians. */
function angleGap(a: number, b: number): number {
  const d = Math.abs(a - b) % (2 * Math.PI);
  return Math.min(d, 2 * Math.PI - d);
}

function normalised(x: number, y: number): [number, number] {
  const length = Math.hypot(x, y);
  return [x / length, y / length];
}
