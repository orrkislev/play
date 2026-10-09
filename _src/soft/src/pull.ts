import { Vector3 } from 'three';
import { Fn, If, uniform, vec4 } from 'three/tsl';
import type { Material, ParticleSystem } from './core/index.js';

/** A mouse grab: one particle is held at a target point while the grab lasts. */
export interface Pull {
  /** Add to `SimLoop` materials. Put it last so it has the final word on the held particle. */
  readonly material: Material;
  grab(index: number, point: Vector3): void;
  move(point: Vector3): void;
  release(): void;
}

/**
 * Holds one cloth particle at a point, as a kinematic constraint. The target
 * lives in GPU uniforms, so moving it every frame costs no buffer upload.
 */
export function createPull(particles: ParticleSystem): Pull {
  const index = uniform(0, 'float');
  const target = uniform(new Vector3());
  const active = uniform(0, 'float');
  const apply = Fn(() => {
    If(active.greaterThan(0), () => {
      const predicted = particles.predictedPositions.element(index.toUint());
      predicted.assign(vec4(target, predicted.w));
    });
  })()
    .compute(1)
    .setName('pull.apply');
  return {
    material: { particles, build: () => ({ solve: [apply] }) },
    grab(i, point) {
      index.value = i;
      target.value.copy(point);
      active.value = 1;
    },
    move(point) {
      target.value.copy(point);
    },
    release() {
      active.value = 0;
    },
  };
}
