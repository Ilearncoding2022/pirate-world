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
   * @param speedFrac |speed| / MAX_FORWARD, clamped to [0, 1]
   * @param throttle  +1 ahead, -1 astern, 0 coasting
   */
  update(dt: number, speedFrac: number, throttle: number): void;
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
    update(dt: number, speedFrac: number, throttle: number): void {
      elapsed += dt;

      for (const glow of glows) {
        glow.material.emissiveIntensity =
          glow.base * (1 + GLOW_DEPTH * Math.sin(elapsed * glow.rate + glow.phase));
      }

      if (thrusterMaterial !== null) {
        // Idling warm, brightest under power, banked right down astern.
        const boost = throttle > 0 ? 1 : throttle < 0 ? 0.15 : 0;
        const heat = 0.2 + 0.5 * speedFrac + 0.4 * boost;
        const flicker = Math.sin(elapsed * 17.3) * Math.sin(elapsed * 6.1 + 1.7);
        thrusterMaterial.emissiveIntensity = thrusterBase * (heat + THRUSTER_FLICKER * flicker);
        // The cone's axis is its local Y and it sits centred on the nozzle, so
        // scaling there is the flame lengthening astern.
        const stretch = 0.55 + 1.05 * heat + 0.1 * flicker;
        for (const flame of thrusters) flame.scale.set(1, stretch, 1);
      }

      // Cloth never goes fully slack: a dead sail at a standstill reads as a bug.
      const drive = 0.25 + 0.75 * speedFrac;
      if (sail !== null) updateSail(sail, drive);
      if (sailMaterial !== null) {
        sailMaterial.emissiveIntensity = sailBase * (1 - SAIL_CHARGE + SAIL_CHARGE * 2 * drive);
      }
      if (flag !== null) updateFlag(flag, drive);
    },
  };
}
