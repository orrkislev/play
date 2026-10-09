// Plays with the cloth on its own: grabs a point, drags it along a random walk, lets go,
// rests, then grabs another point. It drives the same pull a mouse grab does.
import { Vector3 } from 'three';
import type { ParticleRange } from './core/index.js';
import type { Pull } from './pull.js';

/** How far a dragged point may wander from the middle of the cloth, in metres. */
const REACH = 0.45;
/** Walking speed of a dragged point, in m/s. */
const SPEED: [number, number] = [0.15, 0.4];
/** How long one drag lasts, in seconds. */
const DRAG_TIME: [number, number] = [1, 2.5];
/** How long to rest between drags, in seconds. */
const REST_TIME: [number, number] = [0.2, 0.7];
/** Rest after a person lets go of the cloth, before autoplay grabs again, in seconds. */
const YIELD_TIME = 0.3;
/** Largest turn the walk aims for, in radians per second. */
const TURN_GOAL = 2.5;
/** How long the walk keeps one turn before picking another, in seconds. */
const TURN_TIME: [number, number] = [0.6, 1.6];
/** How quickly the turn rate follows its goal, per second. Slower following makes wider arcs. */
const TURN_FOLLOW = 1.5;
/** Fraction of a drag spent easing in at the start and easing out at the end. */
const EASE = 0.25;
/** Sideways wobble on top of the walk: its speed (m/s) and how often it swings (Hz). */
const WOBBLE_SPEED = 0.05;
const WOBBLE_HZ = 2.5;

type Phase =
  | { readonly kind: 'rest'; timer: number }
  | {
      readonly kind: 'drag';
      elapsed: number;
      readonly duration: number;
      readonly target: Vector3;
      heading: number;
      turnRate: number;
      turnGoal: number;
      turnTimer: number;
      readonly speed: number;
      readonly wobblePhase: number;
    };

export interface Autoplay {
  /**
   * Advances the play by `dt` seconds. `positions` is the latest CPU copy of the
   * particles, `range` the cloth's. `busy` is true while a person holds the cloth;
   * autoplay then steps aside and leaves their grab alone.
   */
  update(dt: number, pull: Pull, positions: Float32Array, range: ParticleRange, busy: boolean): void;
  /** Lets go of whatever autoplay holds, and stops. Leaves a person's grab alone. */
  stop(pull: Pull, busy: boolean): void;
  /** Forgets the current drag without touching the pull, for when its cloth is replaced. */
  reset(): void;
  /** What autoplay is doing now, in words. */
  describe(): string;
}

/** Smooth 0-to-1 step: starts and ends with no speed, so motion eases in and out. */
function smoothstep(x: number): number {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
}

/** An angle wrapped into [-π, π). */
function wrapAngle(a: number): number {
  return ((((a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
}

export function createAutoplay(): Autoplay {
  let phase: Phase = { kind: 'rest', timer: 0 };
  const between = ([lo, hi]: [number, number]): number => lo + Math.random() * (hi - lo);

  return {
    update(dt, pull, positions, range, busy) {
      if (busy) {
        // A person has grabbed: their grab stands, and autoplay waits until they let go.
        phase = { kind: 'rest', timer: YIELD_TIME };
        return;
      }

      if (phase.kind === 'rest') {
        phase.timer -= dt;
        if (phase.timer > 0 || positions.length === 0) return;
        const index = range.start + Math.floor(Math.random() * range.count);
        const target = new Vector3(positions[index * 4]!, positions[index * 4 + 1]!, positions[index * 4 + 2]!);
        pull.grab(index, target);
        phase = {
          kind: 'drag',
          elapsed: 0,
          duration: between(DRAG_TIME),
          target,
          heading: Math.random() * 2 * Math.PI,
          turnRate: 0,
          turnGoal: (Math.random() * 2 - 1) * TURN_GOAL,
          turnTimer: between(TURN_TIME),
          speed: between(SPEED),
          wobblePhase: Math.random() * 2 * Math.PI,
        };
        return;
      }

      phase.elapsed += dt;
      const progress = phase.elapsed / phase.duration;
      // Speed eases in at the start and out at the end, so the point never snaps.
      const ease = smoothstep(progress / EASE) * smoothstep((1 - progress) / EASE);

      // Arcs: the turn rate eases toward a goal that changes every second or so.
      phase.turnTimer -= dt;
      if (phase.turnTimer <= 0) {
        phase.turnGoal = (Math.random() * 2 - 1) * TURN_GOAL;
        phase.turnTimer = between(TURN_TIME);
      }
      const { target } = phase;
      const radius = Math.hypot(target.x, target.z);
      if (radius > REACH) {
        // At the edge, steer back toward the middle.
        const toMiddle = wrapAngle(Math.atan2(-target.z, -target.x) - phase.heading);
        phase.turnGoal = Math.max(-TURN_GOAL, Math.min(TURN_GOAL, toMiddle * 2));
      }
      phase.turnRate += (phase.turnGoal - phase.turnRate) * Math.min(1, TURN_FOLLOW * dt);
      phase.heading += phase.turnRate * dt;

      // Walk forward, with a small sideways wobble across the heading.
      const forward = phase.speed * ease;
      const wobble = WOBBLE_SPEED * ease * Math.sin(2 * Math.PI * WOBBLE_HZ * phase.elapsed + phase.wobblePhase);
      const fx = Math.cos(phase.heading),
        fz = Math.sin(phase.heading);
      target.x += (fx * forward - fz * wobble) * dt;
      target.z += (fz * forward + fx * wobble) * dt;
      const clamped = Math.hypot(target.x, target.z);
      if (clamped > REACH) {
        target.x *= REACH / clamped;
        target.z *= REACH / clamped;
      }
      pull.move(target);

      if (phase.elapsed >= phase.duration) {
        pull.release();
        phase = { kind: 'rest', timer: between(REST_TIME) };
      }
    },

    stop(pull, busy) {
      if (phase.kind === 'drag' && !busy) pull.release();
      phase = { kind: 'rest', timer: 0 };
    },

    reset() {
      phase = { kind: 'rest', timer: YIELD_TIME };
    },

    describe() {
      if (phase.kind === 'drag') return `dragging, ${(phase.duration - phase.elapsed).toFixed(1)} s left`;
      return 'resting';
    },
  };
}
