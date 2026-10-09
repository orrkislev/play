// The cloth on its own: a black satin rectangle, the same shape as the window and a little
// larger, staked at its four corners just outside the window's corners. No buttons or panel.
// Autoplay runs by itself. Grabbing and dragging the cloth stops it; it resumes once the cloth
// has been left alone for a few seconds. Resizing the window rebuilds the cloth to the new shape.
import {
  Color,
  DoubleSide,
  NoToneMapping,
  OrthographicCamera,
  Plane,
  PointLight,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
} from 'three';
import { MeshPhysicalNodeMaterial, PostProcessing } from 'three/webgpu';
import { float, luminance, pass, smoothstep, uniform, vec3, vec4 } from 'three/tsl';
import {
  ClothSystem,
  ParticleSystem,
  SDFCollider,
  SimLoop,
  createClothGraph,
  createClothSurface,
  createParticleRenderer,
} from './index.js';
import { createAutoplay } from './autoplay.js';
import { createPull, type Pull } from './pull.js';
import { assemble, rectangle } from './shapes.js';
import { STAKE_SCALE, relaxTarp, tarpCorners } from './tarp.js';
import { FLOOR, buildTerrain } from './terrain.js';

/** Height of the cloth before it is staked, in metres. Its width follows the window's shape. */
const SIZE = 1.1;
const SEGMENTS = 99;
/** How much larger the cloth is than the window, so its edges are never on screen. */
const OVERSIZE = 1.1;
/** Cloth weight per area, kg/m², as in main.ts. */
const WEIGHT = 50;
/** Softness of the cloth, 0 to 1, as the main page starts it. */
const SOFTNESS = 1.0;
const SMOOTHING = 1.0;
const STATIC_FRICTION = 0.35;
const KINETIC_FRICTION = 0.3;
const GRAVITY = 6;
const DRAG = 0.04;
const LIFT = 0.005;
const SUBSTEPS = 12;
/** Brightness cutoff of the threshold pass, 0 to 1, as in main.ts. */
const THRESHOLD = 0.3;
/** Seconds between the simulation starting and autoplay taking over. */
const AUTOPLAY_DELAY = 1;
/** Seconds the cloth must be left alone before autoplay starts again. */
const IDLE_DELAY = 5;
/** How often the CPU copy of the particle positions is refreshed for picking and autoplay, in seconds. */
const POSITION_REFRESH = 0.25;
/** Mouse grabs pick the cloth particle nearest the pointer ray, within this distance (m). */
const PICK_RADIUS = 0.03;
/** Quiet time after the last resize before the cloth is rebuilt, in milliseconds. */
const REBUILD_DELAY = 250;

/**
 * Half the view's height, in metres. The cloth is OVERSIZE times the view, and the stakes sit
 * at its corners, so the stakes land just outside the window's corners.
 */
const HALF_HEIGHT = ((SIZE / 2) * STAKE_SCALE) / OVERSIZE;

const renderer = await createParticleRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
// Flat white on screen: no tone mapping, so the background stays pure white.
renderer.toneMapping = NoToneMapping;
document.body.append(renderer.domElement);
const canvas = renderer.domElement;

const scene = new Scene();
scene.background = new Color(0xffffff);

// Straight down, with no perspective: an orthographic camera looking at -y.
const camera = new OrthographicCamera(-HALF_HEIGHT, HALF_HEIGHT, HALF_HEIGHT, -HALF_HEIGHT, 0.01, 50);
camera.up.set(0, 0, -1);
camera.position.set(0, 3, 0);
camera.lookAt(0, 0, 0);

/** The canvas fills the window, and the view keeps the window's shape. */
function fitView(): void {
  renderer.setSize(innerWidth, innerHeight);
  const half = HALF_HEIGHT * (innerWidth / innerHeight);
  Object.assign(camera, { left: -half, right: half, top: HALF_HEIGHT, bottom: -HALF_HEIGHT });
  camera.updateProjectionMatrix();
}
fitView();

// A white light, so the glossy cloth reflects it back at the viewer.
const light = new PointLight(0xffffff, 200, 0, 1);
light.position.set(1, 2, 1);
scene.add(light);

const light2 = new PointLight(0xffffff, 200, 0, 1);
light2.position.set(1, 2, -1);
scene.add(light2);

const light3 = new PointLight(0xffffff, 200, 0, 1);
light3.position.set(-1, 2, 1);
scene.add(light3);

const light4 = new PointLight(0xffffff, 200, 0, 1);
light4.position.set(-1, 2, -1);
scene.add(light4);

// Threshold pass: the scene is reduced to pure black and white by brightness.
const threshold = uniform(THRESHOLD);
const post = new PostProcessing(renderer);
const sceneColor = pass(scene, camera);
const brightness = luminance(sceneColor.rgb);
const edge = float(0.01);
post.outputNode = vec4(vec3(smoothstep(threshold.sub(edge), threshold.add(edge), brightness)), 1);

// Black satin: almost no diffuse colour, with a glossy coat that mirrors the light.
const satin = new MeshPhysicalNodeMaterial({
  color: 0x050505,
  side: DoubleSide,
  roughness: 0.26,
  metalness: 0.2,
  clearcoat: 1,
  clearcoatRoughness: 0.2,
  specularIntensity: 1,
});

// The floor is flat here, so only its collision field is needed, not its surface.
const terrain = buildTerrain();

/** Bending compliance for the softness and grid, as main.ts computes it. */
const bendCompliance = (softness: number, segments: number): number =>
  10 ** (-1 + softness * 5) * (segments / 30) ** 4 * (0.35 / 0.08);

/** Everything the solver and the picture need for the cloth at one window shape. */
interface World {
  /** Window width over height that the cloth was built for. */
  readonly aspect: number;
  readonly particles: ParticleSystem;
  readonly cloth: ClothSystem;
  readonly surface: ReturnType<typeof createClothSurface>;
  readonly floor: SDFCollider;
  readonly loop: SimLoop;
  readonly pull: Pull;
  readonly stakes: readonly number[];
  readonly range: { readonly start: number; readonly count: number };
}

/** Builds the cloth as a rectangle of the window's shape, staked at its corners, and the solver for it. */
function build(): World {
  const aspect = innerWidth / innerHeight;
  const spacing = SIZE / SEGMENTS;
  const piece = rectangle(0, 0, SIZE * aspect, SIZE, spacing);
  const { columns, rows } = piece;
  const geometry = assemble([piece], spacing).geometry;
  // Lay the cloth flat on the floor, unrotated, so its corners stay on the window's corners.
  geometry.rotateX(-Math.PI / 2).translate(0, FLOOR, 0);
  const position = geometry.getAttribute('position');
  relaxTarp(position.array as Float32Array, columns, rows, FLOOR);
  position.needsUpdate = true;
  const stakes = tarpCorners(columns, rows);
  const graph = createClothGraph(geometry, { surfaceDensity: WEIGHT, pinnedIndices: stakes });
  geometry.dispose();
  const count = (columns + 1) * (rows + 1);
  if (graph.positions.length !== count) {
    throw new Error('Cloth graph merged vertices; the surface would read the wrong particles');
  }

  const particles = new ParticleSystem(renderer, count, 0.45 * spacing);
  const cloth = new ClothSystem(particles, {
    graph,
    stretchTolerance: 0.06,
    bendCompliance: bendCompliance(SOFTNESS, SEGMENTS),
    drag: DRAG,
    lift: LIFT,
    damping: SMOOTHING,
  });
  const range = { start: 0, count };
  const surface = createClothSurface(
    { particles, range },
    { columns: columns + 1, rows: rows + 1, material: satin, subdivisions: 3 },
  );
  scene.add(surface);
  const floor = new SDFCollider(particles, terrain.sdf, {
    // Sparse cloth leaves gaps between particles that thin peaks slip through.
    thickness: 1.3 * spacing - particles.particleRadius,
    muS: STATIC_FRICTION,
    muK: KINETIC_FRICTION,
  });

  // Autoplay grabs a random particle, which may be a stake. The stakes stay put, so grabs on them are skipped.
  // The mouse may grab a stake too; that is skipped the same way.
  const stakeSet = new Set(stakes);
  const pullAny = createPull(particles);
  const pull: Pull = {
    ...pullAny,
    grab: (index, point) => {
      if (!stakeSet.has(index)) pullAny.grab(index, point);
    },
  };
  const loop = new SimLoop(particles, {
    substeps: SUBSTEPS,
    iterations: 2,
    gravity: new Vector3(0, -GRAVITY, 0),
    materials: [cloth, pull.material],
    colliders: [floor],
    contact: { muS: 0.3, muK: 0.2 },
  });
  return { aspect, particles, cloth, surface, floor, loop, pull, stakes, range };
}

/** Frees a cloth's GPU buffers and removes its surface. */
function teardown(old: World): void {
  // The loop's kernels read the cloth buffers, so it goes first.
  old.loop.dispose();
  old.cloth.dispose();
  old.floor.dispose();
  old.particles.dispose();
  scene.remove(old.surface);
  old.surface.geometry.dispose();
}

let world = build();

// Autoplay: on after a short delay at the start, off while the user grabs the cloth, and back on
// after IDLE_DELAY seconds with no grab.
const player = createAutoplay();
let autoplaying = false;
let autoplayTimer: ReturnType<typeof setTimeout> | undefined;
function resumeAutoplayAfter(seconds: number): void {
  clearTimeout(autoplayTimer);
  autoplayTimer = setTimeout(() => {
    autoplaying = true;
  }, seconds * 1000);
}
resumeAutoplayAfter(AUTOPLAY_DELAY);

// Mouse grab, as on the main page: one particle is held under the pointer while the button is down.
const raycaster = new Raycaster();
const pointer = new Vector2();
const point = new Vector3();
const hit = new Vector3();
const target = new Vector3();
const normal = new Vector3();
const grabPlane = new Plane();
let grab: { index: number; offset: Vector3 } | undefined;

let positions = new Float32Array(0);
let readback: Promise<void> | undefined;
let sinceRefresh = POSITION_REFRESH;

function refreshPositions(): void {
  if (readback) return;
  const current = world;
  readback = (async () => {
    try {
      const snapshot = await current.particles.readback();
      if (current === world) positions = snapshot.positions;
    } finally {
      readback = undefined;
    }
  })();
}

function aim(event: PointerEvent): void {
  const rect = canvas.getBoundingClientRect();
  pointer.set(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(pointer, camera);
}

/** The cloth particle nearest the pointer ray, or -1 if none is close enough. */
function pick(): number {
  let best = -1;
  let bestDistance = PICK_RADIUS * PICK_RADIUS;
  const { range } = world;
  for (let i = range.start; i < range.start + range.count; i++) {
    const d = raycaster.ray.distanceSqToPoint(
      point.set(positions[i * 4]!, positions[i * 4 + 1]!, positions[i * 4 + 2]!),
    );
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  }
  return best;
}

canvas.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || positions.length === 0) return;
  aim(event);
  const index = pick();
  if (index < 0) return;
  // The user takes over: autoplay lets go and stays off until the cloth is left alone.
  clearTimeout(autoplayTimer);
  autoplaying = false;
  player.stop(world.pull, false);
  const held = point.set(positions[index * 4]!, positions[index * 4 + 1]!, positions[index * 4 + 2]!);
  // The grab moves in a horizontal plane through the held particle.
  grabPlane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(normal), held);
  raycaster.ray.intersectPlane(grabPlane, hit);
  // Keep the particle's offset from the pointer, so it doesn't jump on grab.
  grab = { index, offset: held.clone().sub(hit) };
  world.pull.grab(index, held);
  canvas.setPointerCapture(event.pointerId);
  canvas.style.cursor = 'grabbing';
});

canvas.addEventListener('pointermove', (event) => {
  aim(event);
  if (!grab) {
    canvas.style.cursor = positions.length > 0 && pick() >= 0 ? 'grab' : '';
    return;
  }
  if (raycaster.ray.intersectPlane(grabPlane, hit)) world.pull.move(target.copy(hit).add(grab.offset));
});

/** Lets go of the cloth, and starts the idle count before autoplay resumes. */
function endGrab(): void {
  if (!grab) return;
  grab = undefined;
  world.pull.release();
  canvas.style.cursor = '';
  resumeAutoplayAfter(IDLE_DELAY);
}
canvas.addEventListener('pointerup', endGrab);
canvas.addEventListener('pointercancel', endGrab);

let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
let rebuildPending = false;
addEventListener('resize', () => {
  fitView();
  // Rebuild once the resizing settles, and only if the window's shape has changed.
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    rebuildPending = Math.abs(innerWidth / innerHeight - world.aspect) > 1e-3;
  }, REBUILD_DELAY);
});

/** Replaces the cloth with one for the window's current shape. The old one is freed once no readback reads it. */
async function rebuild(): Promise<void> {
  if (readback) await readback;
  endGrab();
  player.reset();
  teardown(world);
  world = build();
  positions = new Float32Array(0);
}

// Frame loop: a fixed 1/60 s step per frame, then a render.
async function frame(): Promise<void> {
  if (rebuildPending) {
    rebuildPending = false;
    await rebuild();
  }
  if (autoplaying && positions.length > 0) player.update(1 / 60, world.pull, positions, world.range, grab !== undefined);
  await world.loop.step(1 / 60);
  sinceRefresh += 1 / 60;
  if (sinceRefresh >= POSITION_REFRESH) {
    sinceRefresh = 0;
    refreshPositions();
  }
  await post.renderAsync();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
