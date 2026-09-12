/**
 * hunttells.ts — the in-world tells: circling birds and a spout.
 *
 * What makes a shoal something a player finds by looking at the SEA rather
 * than at the scope. The hunt is the only activity whose target has to be
 * sighted before it can be steered to, and a dot on an instrument is not a
 * sighting — it is a waypoint, and following one is not hunting.
 *
 * Birds circle the head; a spout goes up on the sim's own seeded timer. Both
 * fade with the shoal's envelope and leave on any ending.
 *
 * Same rules as `huntfx.ts`: no new lights, `postFx.adopt` the group, disable
 * `frustumCulled` on bare meshes, fixed pools, frame `dt` only.
 */

import {
  AdditiveBlending,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Vector3,
} from 'three';
import type { Object3D, Scene } from 'three';
import type { HuntCue, HuntState } from './types';
import type { PostFx } from './postfx';
import { GLOBE_RADIUS } from './geo';

/** How many birds, how high they circle and how wide, world units. */
const BIRDS = 5;
const BIRD_HEIGHT = 4;
const BIRD_RADIUS = 3.4;
const BIRD_RATE = 0.55;

/** The spout: how long it lasts and how high it throws, seconds and units. */
const SPOUT_LIFE = 1.2;
const SPOUT_HEIGHT = 7;

const _right = new Vector3();
const _up = new Vector3();
const _astern = new Vector3();
const _basis = new Matrix4();
const _at = new Vector3();

export interface HuntTells {
  cue(cue: HuntCue): void;
  update(dt: number, state: HuntState, night: number): void;
  dispose(): void;
}

export function createHuntTells(scene: Scene, postFx?: Pick<PostFx, 'adopt'>): HuntTells {
  const group = new Group();
  group.name = 'hunt-tells';
  group.visible = false;
  scene.add(group);

  /* ---- Birds ---------------------------------------------------------- */

  const birdMaterial = new MeshBasicMaterial({
    color: 0xe8eef2,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  const birds: Mesh[] = [];
  for (let i = 0; i < BIRDS; i++) {
    // A tiny quad. At chase distance a bird is three pixels, and three pixels
    // that move in a circle read as a bird without being one.
    const mesh = new Mesh(new PlaneGeometry(0.5, 0.22), birdMaterial);
    mesh.frustumCulled = false;
    group.add(mesh);
    birds.push(mesh);
  }

  /* ---- Spout ---------------------------------------------------------- */

  const spoutMaterial = new MeshBasicMaterial({
    color: 0xdff2ff,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  const spout = new Mesh(new PlaneGeometry(1.4, 1), spoutMaterial);
  spout.frustumCulled = false;
  spout.visible = false;
  group.add(spout);

  let spoutAge = SPOUT_LIFE;
  const spoutAt = new Vector3();

  postFx?.adopt(group as unknown as Object3D);

  let elapsed = 0;

  return {
    cue(cue: HuntCue): void {
      if (cue.kind !== 'spout' || !cue.position) return;
      spoutAge = 0;
      spoutAt.copy(cue.position);
    },

    update(dt: number, state: HuntState, night: number): void {
      if (!(dt > 0)) return;
      elapsed += dt;

      const head = state.shadows[0];
      /*
       * Gone the instant a hunt ends, rather than fading with the body.
       *
       * Birds over an animal that has sounded would be the single most
       * misleading thing on the water: they are the tell that says "it is
       * HERE", and leaving them for two and a half seconds after it left would
       * send a player toward nothing.
       */
      const live = state.phase === 'drifting' && head !== undefined;
      group.visible = live;
      if (!live || head === undefined) {
        spout.visible = false;
        return;
      }

      // Dimmer at night, because a bird is lit by the sun and there is no
      // second light here to say otherwise.
      const daylight = 1 - Math.max(0, Math.min(1, night));
      birdMaterial.opacity = 0.55 * head.envelope * (0.25 + 0.75 * daylight);

      _up.copy(head.position);
      _right.crossVectors(head.forward, head.position);
      if (_right.lengthSq() < 1e-12) return;
      _right.normalize();
      _astern.copy(head.forward).negate();
      _basis.makeBasis(_right, _up, _astern);

      for (let i = 0; i < birds.length; i++) {
        const bird = birds[i];
        // Evenly spaced around one orbit, each at its own height so the flock
        // has depth rather than reading as a ring drawn on the sky.
        const phase = elapsed * BIRD_RATE + (i / birds.length) * Math.PI * 2;
        const radius = BIRD_RADIUS * (0.7 + 0.3 * Math.sin(phase * 1.7 + i));
        const height = BIRD_HEIGHT + Math.sin(phase * 2.3 + i * 1.3) * 0.9;

        _at.copy(head.position).multiplyScalar(GLOBE_RADIUS + height);
        _at.addScaledVector(_right, Math.cos(phase) * radius);
        _at.addScaledVector(_astern, Math.sin(phase) * radius);
        bird.position.copy(_at);
        bird.quaternion.setFromRotationMatrix(_basis);
        // Banked into the turn, which is most of what makes a quad a bird.
        bird.rotateZ(Math.sin(phase) * 0.6);
      }

      /* ---- The spout ---------------------------------------------------- */
      if (spoutAge >= SPOUT_LIFE) {
        spout.visible = false;
        return;
      }
      spoutAge += dt;
      const t = Math.min(1, spoutAge / SPOUT_LIFE);
      // Up fast, then falls away. A column that grew linearly would read as a
      // bar rising out of the sea rather than as water thrown.
      const rise = 1 - (1 - t) * (1 - t);
      const height = SPOUT_HEIGHT * rise;

      _up.copy(spoutAt);
      _astern.copy(head.forward).negate();
      _astern.addScaledVector(_up, -_astern.dot(_up));
      if (_astern.lengthSq() > 1e-12) {
        _astern.normalize();
        _right.crossVectors(_up, _astern).normalize();
        _basis.makeBasis(_right, _up, _astern);
        spout.quaternion.setFromRotationMatrix(_basis);
      }
      spout.position.copy(spoutAt).multiplyScalar(GLOBE_RADIUS + height * 0.5);
      spout.scale.set(1 + t * 0.6, Math.max(0.001, height), 1);
      spoutMaterial.opacity = 0.7 * (1 - t) * head.envelope;
      spout.visible = true;
    },

    dispose(): void {
      scene.remove(group);
      for (const bird of birds) bird.geometry.dispose();
      birdMaterial.dispose();
      spout.geometry.dispose();
      spoutMaterial.dispose();
    },
  };
}
