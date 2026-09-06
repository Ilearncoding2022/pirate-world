import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createPostFx } from '../../src/postfx';
import type { Quality } from '../../src/quality';

/**
 * postfx.ts's `selfEncodeToSRGB` used to `throw` the moment a material
 * already had an `onBeforeCompile` hook -- see docs/RENDER_PLAN.md, Phase 0 /
 * Q. Stream C needs to extend `land.ts`'s `MeshStandardMaterial` with its own
 * hook, so this proves the two now chain: the prior hook runs first, on the
 * same shader object, and the sRGB encode replacement runs after it -- and
 * that `customProgramCacheKey` stays unique per combination of hooks rather
 * than collapsing every hooked material onto one compiled program.
 *
 * `createPostFx` needs a `THREE.WebGLRenderer` to construct, but the only
 * method under test here -- `adopt()` -- never touches it beyond
 * construction (`getContext()` for the GPU timer, `getSize()` for the initial
 * viewport, and `info.autoReset`), so a minimal stand-in is enough; nothing
 * here builds a real WebGL context.
 */

const STUB_QUALITY: Quality = {
  tier: 'high',
  pixelRatioCap: 2,
  waveChop: true,
  bloomMaxWidth: 1280,
  wakeMapSize: 512,
  patchSegments: 160,
  reflectionSize: 256,
  reflectionFacesPerFrame: 2,
};

function stubRenderer(): THREE.WebGLRenderer {
  return {
    getSize: (target: THREE.Vector2) => target.set(800, 600),
    getContext: () => ({}) as unknown as WebGLRenderingContext,
    info: { autoReset: true },
  } as unknown as THREE.WebGLRenderer;
}

/** A fake shader object, shaped like what `onBeforeCompile` actually receives. */
function fakeShader(): { vertexShader: string; fragmentShader: string; uniforms: Record<string, unknown> } {
  return {
    vertexShader: 'void main() { gl_Position = vec4(0.0); }',
    fragmentShader: ['void main() {', '  #include <colorspace_fragment>', '}'].join('\n'),
    uniforms: {},
  };
}

describe('postfx-chain', () => {
  it('runs a prior onBeforeCompile hook before the sRGB encode replacement, in order', () => {
    const material = new THREE.MeshStandardMaterial();
    const calls: string[] = [];
    material.onBeforeCompile = (shader) => {
      calls.push('prior');
      shader.fragmentShader = shader.fragmentShader.replace('void main() {', 'void main() {\n  // prior hook ran');
    };

    const postFx = createPostFx(stubRenderer(), STUB_QUALITY);
    postFx.adopt(new THREE.Mesh(new THREE.BoxGeometry(), material));

    const shader = fakeShader();
    material.onBeforeCompile(shader, stubRenderer());

    expect(calls).toEqual(['prior']);
    expect(shader.fragmentShader).toContain('// prior hook ran');
    expect(shader.fragmentShader).toContain('gl_FragColor = sRGBTransferOETF( gl_FragColor );');

    // Order: the prior hook's edit must land before the encode replacement's.
    const priorIndex = shader.fragmentShader.indexOf('// prior hook ran');
    const encodeIndex = shader.fragmentShader.indexOf('sRGBTransferOETF');
    expect(priorIndex).toBeGreaterThanOrEqual(0);
    expect(encodeIndex).toBeGreaterThan(priorIndex);

    // The #include marker itself must be gone -- the encode actually ran, not
    // just left a matching substring somewhere else in the shader.
    expect(shader.fragmentShader).not.toContain('#include <colorspace_fragment>');
  });

  it('does not clobber a material with no prior hook', () => {
    const material = new THREE.MeshStandardMaterial();
    const postFx = createPostFx(stubRenderer(), STUB_QUALITY);
    postFx.adopt(new THREE.Mesh(new THREE.BoxGeometry(), material));

    const shader = fakeShader();
    material.onBeforeCompile(shader, stubRenderer());

    expect(shader.fragmentShader).toContain('sRGBTransferOETF');
    expect(material.customProgramCacheKey()).toBe('pirate-world/srgb-self-encode');
  });

  it('keeps customProgramCacheKey unique per combination of hooks', () => {
    const plain = new THREE.MeshStandardMaterial();

    const hookedA = new THREE.MeshStandardMaterial();
    hookedA.onBeforeCompile = (shader) => {
      shader.fragmentShader += '\n// hook A';
    };

    const hookedB = new THREE.MeshStandardMaterial();
    hookedB.onBeforeCompile = (shader) => {
      shader.fragmentShader += '\n// hook B';
    };

    const postFx = createPostFx(stubRenderer(), STUB_QUALITY);
    postFx.adopt(new THREE.Mesh(new THREE.BoxGeometry(), plain));
    postFx.adopt(new THREE.Mesh(new THREE.BoxGeometry(), hookedA));
    postFx.adopt(new THREE.Mesh(new THREE.BoxGeometry(), hookedB));

    const keys = new Set([
      plain.customProgramCacheKey(),
      hookedA.customProgramCacheKey(),
      hookedB.customProgramCacheKey(),
    ]);

    // Three distinct materials, three distinct hook combinations -- a shared
    // key here is exactly the bug this chaining change exists to prevent,
    // since Three would then reuse one compiled program for shaders that
    // actually differ.
    expect(keys.size).toBe(3);
  });

  it('leaves a ShaderMaterial alone -- raw shaders keep their own hand-written encode', () => {
    const material = new THREE.ShaderMaterial({
      vertexShader: 'void main() { gl_Position = vec4(0.0); }',
      fragmentShader: 'void main() { gl_FragColor = vec4(1.0); }',
    });

    const postFx = createPostFx(stubRenderer(), STUB_QUALITY);
    postFx.adopt(new THREE.Mesh(new THREE.BoxGeometry(), material));

    expect(material.onBeforeCompile).toBe(THREE.Material.prototype.onBeforeCompile);
  });
});
