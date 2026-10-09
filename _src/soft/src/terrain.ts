import { Mesh, MeshBasicMaterial, PlaneGeometry } from 'three';
import type { SDFData } from './core/index.js';

/** Side of the hilly patch on the floor, in metres. */
const TERRAIN_SIZE = 1.6;
/** Largest hill or valley, in metres. */
const MAX_HEIGHT = 0.00;
/**
 * Height of the flat ground around the hills. Valleys dip by up to MAX_HEIGHT,
 * so this keeps the whole surface above the ground plane at y = 0, which would
 * otherwise hide the cloth in them.
 */
export const FLOOR = MAX_HEIGHT + 0.005;
/** Width of the band where the hills fade into the flat floor, in metres. */
const EDGE = 0.15;
/** Largest hill or valley, in metres, and how many there are. */
const HILL_COUNT = 7;
/** Collision field: nodes per side and layers in height. Signed distance is linear in height. */
const SDF_NODES = 256;
const SDF_LAYERS = 8;
const SDF_Y_MIN = -0.05;
const SDF_Y_MAX = 0.95;

interface Hill {
  readonly x: number;
  readonly z: number;
  /** Width of the hill, in metres. Each hill is a smooth gaussian bump. */
  readonly sigma: number;
  /** Positive for a hill, negative for a valley. */
  readonly height: number;
}

/** Large, smooth hills and valleys, placed deterministically so every run is the same. */
const HILLS: readonly Hill[] = makeHills(7, HILL_COUNT);

/**
 * Hills and valleys across the floor, with no fine detail. Returns the visible
 * surface and a signed distance field of it for the cloth to collide with.
 */
export function buildTerrain(): { mesh: Mesh; sdf: SDFData } {
  // The visible surface: white like the floor, so only the cloth shows its shape.
  const geometry = new PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, 200, 200).rotateX(-Math.PI / 2);
  const positions = geometry.getAttribute('position');
  for (let i = 0; i < positions.count; i++) {
    positions.setY(i, terrainHeight(positions.getX(i), positions.getZ(i)));
  }
  positions.needsUpdate = true;
  const mesh = new Mesh(geometry, new MeshBasicMaterial({ color: 0xffffff }));

  // The collision field: the vertical distance from each point to the surface,
  // scaled by the slope so that pushes don't stop short on steep ground.
  const half = TERRAIN_SIZE / 2;
  const step = TERRAIN_SIZE / (SDF_NODES - 1);
  const dy = (SDF_Y_MAX - SDF_Y_MIN) / (SDF_LAYERS - 1);
  const data = new Float32Array(SDF_NODES * SDF_NODES * SDF_LAYERS);
  for (let k = 0; k < SDF_NODES; k++) {
    const z = -half + k * step;
    for (let i = 0; i < SDF_NODES; i++) {
      const x = -half + i * step;
      const h = terrainHeight(x, z);
      const slopeX = (terrainHeight(x + step, z) - terrainHeight(x - step, z)) / (2 * step);
      const slopeZ = (terrainHeight(x, z + step) - terrainHeight(x, z - step)) / (2 * step);
      const scale = Math.sqrt(1 + slopeX * slopeX + slopeZ * slopeZ);
      for (let j = 0; j < SDF_LAYERS; j++) {
        data[(k * SDF_LAYERS + j) * SDF_NODES + i] = (SDF_Y_MIN + j * dy - h) / scale;
      }
    }
  }
  const sdf: SDFData = {
    data,
    resolution: [SDF_NODES, SDF_LAYERS, SDF_NODES],
    // The sampler reads node i at origin + (i + 0.5) × voxelSize, so the origin
    // is the corner of the first cell, half a voxel before the first node.
    origin: [-half - step / 2, SDF_Y_MIN - dy / 2, -half - step / 2],
    voxelSize: [step, dy, step],
  };
  return { mesh, sdf };
}

/** Height of the floor at a point: the sum of the hills, faded out before the edge of the patch. */
function terrainHeight(x: number, z: number): number {
  let height = 0;
  for (const hill of HILLS) {
    const dx = x - hill.x,
      dz = z - hill.z;
    height += hill.height * Math.exp(-(dx * dx + dz * dz) / (2 * hill.sigma * hill.sigma));
  }
  const edge = TERRAIN_SIZE / 2 - Math.max(Math.abs(x), Math.abs(z));
  return FLOOR + height * smoothstep(0, EDGE, edge);
}

/** Seeded hills and valleys: centres inside the cloth's footprint, widths 10 to 22 cm. */
function makeHills(seed: number, count: number): Hill[] {
  let state = seed;
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
  return Array.from({ length: count }, () => ({
    x: (random() - 0.5) * 0.7,
    z: (random() - 0.5) * 0.7,
    sigma: 0.1 + random() * 0.12,
    height: (random() < 0.5 ? -1 : 1) * MAX_HEIGHT * (0.4 + 0.6 * random()),
  }));
}

function smoothstep(a: number, b: number, t: number): number {
  const u = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return u * u * (3 - 2 * u);
}
