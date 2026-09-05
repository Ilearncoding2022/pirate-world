import * as THREE from 'three';
import type { WorldEnv } from './env';
import { GLOBE_RADIUS } from './geo';

export interface Sky {
  group: THREE.Group;
  update(dt: number, env: WorldEnv): void;
}

/** Fresnel rim glow shell around the planet. */
function buildAtmosphere(): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(GLOBE_RADIUS * 1.055, 96, 64);

  const vertexShader = [
    'varying vec3 vNormalV;',
    'varying vec3 vViewDir;',
    'varying vec3 vDir;',
    'void main() {',
    '  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);',
    '  vNormalV = normalize(normalMatrix * normal);',
    '  vViewDir = normalize(-mvPosition.xyz);',
    '  vDir = normalize(position);',
    '  gl_Position = projectionMatrix * mvPosition;',
    '}',
  ].join('\n');

  const fragmentShader = [
    'uniform vec3 uColor;',
    'uniform vec3 uSunsetColor;',
    'uniform vec3 uSunDirection;',
    'uniform float uIntensity;',
    'uniform float uPower;',
    'varying vec3 vNormalV;',
    'varying vec3 vViewDir;',
    'varying vec3 vDir;',
    'void main() {',
    '  // BackSide normals point inward, so use the absolute dot to measure the rim.',
    '  float rim = 1.0 - abs(dot(normalize(vNormalV), normalize(vViewDir)));',
    '  float glow = pow(clamp(rim, 0.0, 1.0), uPower) * uIntensity;',
    '  // Fade the glow out on the night side and warm it near the terminator.',
    '  float sun = dot(normalize(vDir), normalize(uSunDirection));',
    '  float lit = smoothstep(-0.35, 0.25, sun);',
    '  float rimWarm = 1.0 - smoothstep(0.0, 0.45, abs(sun));',
    '  vec3 tint = mix(uColor, uSunsetColor, rimWarm * 0.75);',
    '  glow *= mix(0.12, 1.0, lit);',
    '  gl_FragColor = vec4(tint * glow, glow);',
    '}',
  ].join('\n');

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color('#4fbaff') },
      uSunsetColor: { value: new THREE.Color('#ff7a4f') },
      uSunDirection: { value: new THREE.Vector3(0.62, 0.42, 0.66).normalize() },
      uIntensity: { value: 1.15 },
      uPower: { value: 3.0 },
    },
    vertexShader,
    fragmentShader,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'atmosphere';
  return mesh;
}

function buildStars(): THREE.Points {
  const COUNT = 3000;
  const RADIUS = 2000;
  const positions = new Float32Array(COUNT * 3);
  const colors = new Float32Array(COUNT * 3);
  const c = new THREE.Color();

  for (let i = 0; i < COUNT; i++) {
    const u = Math.random() * 2 - 1;
    const th = Math.random() * Math.PI * 2;
    const s = Math.sqrt(Math.max(0, 1 - u * u));
    positions[i * 3] = Math.cos(th) * s * RADIUS;
    positions[i * 3 + 1] = u * RADIUS;
    positions[i * 3 + 2] = Math.sin(th) * s * RADIUS;

    const warm = Math.random();
    c.setHSL(warm < 0.8 ? 0.58 : 0.09, 0.35, 0.6 + Math.random() * 0.4);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const material = new THREE.PointsMaterial({
    size: 2,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
  });

  const points = new THREE.Points(geometry, material);
  points.name = 'starfield';
  return points;
}

export function createSky(): Sky {
  const group = new THREE.Group();
  group.name = 'sky';

  const atmosphere = buildAtmosphere();
  group.add(atmosphere);

  const starPivot = new THREE.Group();
  starPivot.name = 'starfield-pivot';
  starPivot.add(buildStars());
  group.add(starPivot);

  const atmoUniforms = (atmosphere.material as THREE.ShaderMaterial).uniforms;

  return {
    group,
    update(dt: number, env: WorldEnv): void {
      starPivot.rotation.y += dt * 0.004;
      atmoUniforms.uSunDirection.value.copy(env.sunDirection);
    },
  };
}
