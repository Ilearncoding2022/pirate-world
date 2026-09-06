import type { BufferAttribute, BufferGeometry, Material, Mesh, MeshStandardMaterial, Object3D, Texture } from 'three';

/**
 * Drives the parts `tools/build_ship.py` deliberately leaves as separate glTF
 * nodes.
 *
 * That script merges the ship by material -- 233 objects down to 26, one draw
 * call per material -- and exempts a short list of parts in its KEEP_SEPARATE
 * tuple "because the game may want to address them: the glows it can pulse,
 * and the two cloth pieces". This module is the other half of that bargain;
 * without it the merge is the only thing the rebuilt model buys us and all
 * that neon sits there dead.
 *
 * Only the three parts that need bespoke motion are found by node name
 * (`thruster_flame*`, `mainsail`, `flag`). The lamps are found by material
 * instead -- flat emissive, no emissive map -- so the build script can hang
 * another light off the rig without this file having to learn its name.
 *
 * Everything here is also modulated by the power plant, which `ship.ts` passes
 * through from `energy.ts`. That is deliberate: the charge is a number the
 * player has to watch, and a hull that dims as it drains, flares alongside a
 * berth and puts its flames out when the tank is dry says it without anyone
 * reading the HUD. It is a modulation on top of the motion below, never a
 * replacement for it -- the sail still bellies to the speed and the lamps still
 * beat at their own hashed rates while the whole ship is fading.
 *
 * Local axes inside the glTF root, which the model's 180-degree export yaw
 * makes counter-intuitive: local +Z is the bow and local +X is to port. So the
 * sail bellies and the flag streams along +Z, forward, which is the direction
 * the build script bellied the sail in -- the wind is over the stern.
 */

/* ------------------------------------------------------------------ */
/* Tuning                                                              */
/* ------------------------------------------------------------------ */

/** Fraction of its authored emissive strength a lamp swings through. */
const GLOW_DEPTH = 0.22;
/** Pulse rate band, rad/s. Each lamp draws from it by name hash, so no two beat together. */
const GLOW_RATE_MIN = 1.1;
const GLOW_RATE_SPAN = 1.7;

/** Extra belly, in model units, the mainsail takes on at full speed. */
const SAIL_BELLY = 0.16;
/** Amplitude of the luffing ripple crossing the cloth. */
const SAIL_LUFF = 0.045;
/** How far either side of its authored strength the sail's circuitry charges. */
const SAIL_CHARGE = 0.35;

/** Fly-end travel of the flag: forward under way, down at rest, plus flutter. */
const FLAG_STREAM = 0.3;
const FLAG_DROOP = 0.2;
const FLAG_FLUTTER = 0.075;

/** Thruster flame flicker, as a fraction of its authored strength. */
const THRUSTER_FLICKER = 0.13;

/**
 * Emissive left in the neon and the sail's circuitry on a flat battery, as a
 * fraction of the authored strength.
 *
 * They run CHARGE_FLOOR .. 1 linearly across the tank, so the hull is its own
 * fuel gauge and the level is legible from the chase camera. A floor rather
 * than a fade to nothing because a black ship at night is not a low ship, it
 * is a missing one: once the sun is down the model is lit almost entirely by
 * these emissives, and the bloom in `postfx.ts` has nothing else to catch.
 */
const CHARGE_FLOOR = 0.25;
/** The rest of that range. Derived so the pair cannot be edited into summing to something other than full. */
const CHARGE_SPAN = 1 - CHARGE_FLOOR;

/**
 * Multiplier on every emissive while a berth is charging the ship.
 *
 * It reads as the hull drinking from the shore, and it is the only
 * confirmation on the model itself that the berth has connected -- otherwise
 * the ship's own answer to "am I charging?" lives entirely in a HUD number
 * climbing.
 */
const DOCK_FLARE = 1.4;

/**
 * e-folding time, seconds, of the thruster flames dying and relighting.
 *
 * A hard cut on `canThrust` reads as a dropped frame or a missing mesh rather
 * than as an engine losing its supply, and the relight would be worse: the
 * plant recovers on a solar trickle, so the flames would appear fully formed
 * in the same frame the tank crossed RESTART_LEVEL. At 0.25 s the flame is
 * down to a third of its length a quarter second after the supply is cut, and
 * under FLAME_CUTOFF within one second.
 */
const FLAME_FADE_TIME = 0.25;

/**
 * e-folding time, seconds, of the dock flare, deliberately slower.
 *
 * The charging zone is entered under way, so stepping every lamp on the ship
 * up 40% inside one frame reads as a render glitch; a half-second swell reads
 * as a connection being made.
 */
const FLARE_FADE_TIME = 0.5;

/**
 * Gate below which the flames leave the frame entirely instead of being drawn
 * tiny. Their cone keeps its authored violet base colour once the emissive is
 * gone, so fading alone would leave two dull spikes hanging off the nozzles;
 * and scaling to exactly 0 leaves a degenerate mesh in the draw list.
 */
const FLAME_CUTOFF = 0.02;

/* ------------------------------------------------------------------ */
/* Parts                                                               */
/* ------------------------------------------------------------------ */

interface Glow {
  material: MeshStandardMaterial;
  /** emissiveIntensity as authored -- glTF KHR_materials_emissive_strength. */
  base: number;
  rate: number;
  phase: number;
}

interface Cloth {
  geometry: BufferGeometry;
  position: BufferAttribute;
  /** Rest pose. Every frame is computed from this, never from the frame before. */
  rest: Float32Array;
  minX: number;
  invSpanX: number;
  maxY: number;
  invSpanY: number;
}

export interface ShipFx {
  /**
   * Called only from `ship.ts`, which owns both halves of this signature: the
   * committed motion and the `EnergyState` it was handed for the same frame.
   *
   * @param speedFrac |speed| / MAX_FORWARD, clamped to [0, 1]
   * @param throttle  +1 ahead, -1 astern, 0 coasting. The key press, not the
   *   thrust -- `canThrust` is the only thing that gates the flames.
   * @param level     charge in [0, 1], `EnergyState.level`. Dims the neon and
   *   the sail's circuitry, never below CHARGE_FLOOR.
   * @param canThrust `EnergyState.canThrust`. False fades the flames out.
   * @param docked    `EnergyState.dock !== null`, ie. a berth is actually
   *   charging the ship rather than merely being sailed over. Flares everything.
   */
  update(
    dt: number,
    speedFrac: number,
    throttle: number,
    level: number,
    canThrust: boolean,
    docked: boolean,
  ): void;
}

/** FNV-1a folded to [0, 1). Gives each lamp a stable phase and rate from its node name. */
function hashUnit(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

/** First material of a mesh; every primitive in this model has exactly one. */
function standardMaterialOf(mesh: Mesh): MeshStandardMaterial | null {
  const material: Material | undefined = Array.isArray(mesh.material)
    ? mesh.material[0]
    : mesh.material;
  if (!material) return null;
  const std = material as MeshStandardMaterial & { isMeshStandardMaterial?: boolean };
  return std.isMeshStandardMaterial === true ? std : null;
}

/**
 * A flat neon emitter: emissive colour, no emissive map. The sail and the flag
 * carry their glow in a texture, which is exactly how they are told apart.
 */
function isNeon(material: MeshStandardMaterial): boolean {
  const e = material.emissive;
  return material.emissiveMap === null && material.emissiveIntensity > 0 && e.r + e.g + e.b > 0;
}

/**
 * Raises the anisotropy of every map on the model.
 *
 * The rebuilt model tiles its wood and metal maps through KHR_texture_transform
 * -- the deck runs its plank texture three times along the hull -- and the deck
 * is seen at a hard grazing angle from the chase camera, which is exactly where
 * isotropic filtering turns tiled planks into grey mush.
 */
function sharpenTextures(material: MeshStandardMaterial, maxAnisotropy: number): void {
  const maps: (Texture | null)[] = [
    material.map,
    material.normalMap,
    material.roughnessMap,
    material.metalnessMap,
    material.emissiveMap,
  ];
  for (const map of maps) {
    if (map && map.anisotropy < maxAnisotropy) map.anisotropy = maxAnisotropy;
  }
}

/** Snapshots a cloth mesh's rest pose and the extents its animation works in. */
function readCloth(mesh: Mesh): Cloth {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute('position') as BufferAttribute;
  const rest = Float32Array.from(position.array as ArrayLike<number>);

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < rest.length; i += 3) {
    if (rest[i] < minX) minX = rest[i];
    if (rest[i] > maxX) maxX = rest[i];
    if (rest[i + 1] < minY) minY = rest[i + 1];
    if (rest[i + 1] > maxY) maxY = rest[i + 1];
  }

  // The bounding sphere is computed once, at load, and these vertices move every
  // frame. Keeping culling honest would mean recomputing it per frame, which
  // costs more than the one draw call it could ever save on a ship this close.
  mesh.frustumCulled = false;

  return {
    geometry,
    position,
    rest,
    minX,
    invSpanX: maxX > minX ? 1 / (maxX - minX) : 0,
    maxY,
    invSpanY: maxY > minY ? 1 / (maxY - minY) : 0,
  };
}

/* ------------------------------------------------------------------ */
/* Factory                                                             */
/* ------------------------------------------------------------------ */

/**
 * Prepares a freshly loaded ship model and returns its per-frame driver.
 *
 * Has to run before `postfx.adopt` sees these materials. It clones the shared
 * neon materials so each lamp can beat on its own, and a clone taken after the
 * post-processing patch would inherit the "already encoded" userData flag
 * without the `onBeforeCompile` that flag stands for, and render a stop dark.
 */
export function createShipFx(model: Object3D, maxAnisotropy: number): ShipFx {
  const glows: Glow[] = [];
  const thrusters: Mesh[] = [];
  let thrusterMaterial: MeshStandardMaterial | null = null;
  let thrusterBase = 0;
  let sail: Cloth | null = null;
  let sailMaterial: MeshStandardMaterial | null = null;
  let sailBase = 0;
  let flag: Cloth | null = null;

  model.traverse((node) => {
    const mesh = node as Mesh;
    if ((mesh as { isMesh?: boolean }).isMesh !== true) return;
    const material = standardMaterialOf(mesh);
    if (!material) return;
    sharpenTextures(material, maxAnisotropy);

    if (mesh.name.startsWith('thruster_flame')) {
      // Both flames share one clone: they are one engine note, not two.
      if (thrusterMaterial === null) {
        thrusterMaterial = material.clone();
        thrusterBase = material.emissiveIntensity;
      }
      mesh.material = thrusterMaterial;
      thrusters.push(mesh);
      return;
    }

    if (mesh.name === 'mainsail') {
      sail = readCloth(mesh);
      sailBase = material.emissiveIntensity;
      sailMaterial = material.clone();
      mesh.material = sailMaterial;
      return;
    }

    if (mesh.name === 'flag') {
      flag = readCloth(mesh);
      return;
    }

    if (isNeon(material)) {
      const clone = material.clone();
      mesh.material = clone;
      const h = hashUnit(mesh.name);
      glows.push({
        material: clone,
        base: material.emissiveIntensity,
        rate: GLOW_RATE_MIN + h * GLOW_RATE_SPAN,
        phase: h * Math.PI * 2,
      });
    }
  });

  let elapsed = 0;

  // Smoothed followers for the two power states, which arrive as steps: the
  // tank runs dry between one frame and the next, and the charging zone is
  // crossed at speed. Started already powered and already undocked, because the
  // model streams in mid-voyage -- a hull that swelled up from dark on its
  // first visible frame would read as the ship booting rather than sailing.
  let flameGate = 1;
  let flare = 0;

  function updateSail(cloth: Cloth, drive: number): void {
    const out = cloth.position.array as Float32Array;
    const rest = cloth.rest;
    const belly = SAIL_BELLY * drive;
    const luff = SAIL_LUFF * (0.35 + 0.65 * drive);
    for (let i = 0; i < rest.length; i += 3) {
      const u = (rest[i] - cloth.minX) * cloth.invSpanX; // 0 luff .. 1 leech
      const v = (cloth.maxY - rest[i + 1]) * cloth.invSpanY; // 0 head .. 1 foot
      // The profile the build script bellied the cloth with, reused so this
      // adds to the baked shape instead of fighting it: pinned along both
      // edges, fullest a little below the yard.
      const span = Math.sin(Math.PI * u) * Math.sin(Math.min(1, v * 1.25) * Math.PI * 0.75);
      const ripple = Math.sin(elapsed * 2.3 + u * 3.1 + v * 2.0);
      out[i + 2] = rest[i + 2] + span * (belly + luff * ripple);
    }
    cloth.position.needsUpdate = true;
    cloth.geometry.computeVertexNormals();
  }

  function updateFlag(cloth: Cloth, drive: number): void {
    const out = cloth.position.array as Float32Array;
    const rest = cloth.rest;
    const stream = FLAG_STREAM * drive;
    const droop = FLAG_DROOP * (1 - drive);
    const flutter = FLAG_FLUTTER * (0.4 + 0.6 * drive);
    for (let i = 0; i < rest.length; i += 3) {
      // f = 0 at the hoist, bent to the masthead and so pinned, 1 at the fly.
      const f = (rest[i] - cloth.minX) * cloth.invSpanX;
      const wave = Math.sin(elapsed * 5.5 - f * 6.0);
      out[i + 1] =
        rest[i + 1] - f * f * droop + f * flutter * 0.4 * Math.cos(elapsed * 4.1 - f * 5.0);
      out[i + 2] = rest[i + 2] + f * (stream + flutter * wave);
    }
    cloth.position.needsUpdate = true;
    cloth.geometry.computeVertexNormals();
  }

  return {
    update(
      dt: number,
      speedFrac: number,
      throttle: number,
      level: number,
      canThrust: boolean,
      docked: boolean,
    ): void {
      elapsed += dt;

      // Exponential approach, so both ramps are frame-rate independent -- the
      // same idiom `ship.ts` banks its turns with.
      flameGate += ((canThrust ? 1 : 0) - flameGate) * (1 - Math.exp(-dt / FLAME_FADE_TIME));
      flare += ((docked ? 1 : 0) - flare) * (1 - Math.exp(-dt / FLARE_FADE_TIME));

      // What the plant does to the ship's light. `flareMul` is the berth alone,
      // which the flames take without the tank's dimming; `chargeGlow` is the
      // tank as well, for everything that is meant to read as stored charge.
      const flareMul = 1 + (DOCK_FLARE - 1) * flare;
      const chargeGlow = (CHARGE_FLOOR + CHARGE_SPAN * level) * flareMul;

      for (const glow of glows) {
        glow.material.emissiveIntensity =
          glow.base * (1 + GLOW_DEPTH * Math.sin(elapsed * glow.rate + glow.phase)) * chargeGlow;
      }

      if (thrusterMaterial !== null) {
        // Idling warm, brightest under power, banked right down astern -- then
        // faded out by `flameGate` when there is nothing left to burn. The
        // flame is a statement about the throttle, not about the reserve, so it
        // is the only emissive that does not take `chargeGlow`: dimming it with
        // the tank as well would leave a dry ship's flames fading twice over.
        const boost = throttle > 0 ? 1 : throttle < 0 ? 0.15 : 0;
        const heat = 0.2 + 0.5 * speedFrac + 0.4 * boost;
        const flicker = Math.sin(elapsed * 17.3) * Math.sin(elapsed * 6.1 + 1.7);
        thrusterMaterial.emissiveIntensity =
          thrusterBase * (heat + THRUSTER_FLICKER * flicker) * flameGate * flareMul;
        // The cone's axis is its local Y and it sits centred on the nozzle, so
        // scaling there is the flame lengthening astern. Scaled by the gate too,
        // so a flame losing its supply retracts into the nozzle as it dims
        // instead of hanging there at full length going dark.
        const stretch = (0.55 + 1.05 * heat + 0.1 * flicker) * flameGate;
        const lit = flameGate > FLAME_CUTOFF;
        for (const flame of thrusters) {
          flame.visible = lit;
          flame.scale.set(1, stretch, 1);
        }
      }

      // Cloth never goes fully slack: a dead sail at a standstill reads as a bug.
      const drive = 0.25 + 0.75 * speedFrac;
      if (sail !== null) updateSail(sail, drive);
      if (sailMaterial !== null) {
        // Speed decides how hard the traces run; the tank decides how much
        // light there is to run them with. Multiplied, not blended, so the
        // circuitry still answers to the helm on a nearly flat battery.
        sailMaterial.emissiveIntensity =
          sailBase * (1 - SAIL_CHARGE + SAIL_CHARGE * 2 * drive) * chargeGlow;
      }
      if (flag !== null) updateFlag(flag, drive);
    },
  };
}
