import { describe, it, expect } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { createCourse, pickCourse } from '../../src/course';
import { behindGlobe, createDoubleTap, pickHarbour } from '../../src/harbourpick';
import { GLOBE_RADIUS } from '../../src/geo';

describe('course store', () => {
  it('sets, clears and only notifies on a real change', () => {
    const course = createCourse(null);
    let fired = 0;
    course.onChange(() => fired++);
    course.set('Rustwharf');
    course.set('Rustwharf');
    expect(course.destination).toBe('Rustwharf');
    course.set(null);
    course.set('');
    expect(course.destination).toBeNull();
    expect(fired).toBe(2);
  });

  it('starts from a saved name', () => {
    expect(createCourse('Ionport').destination).toBe('Ionport');
    expect(createCourse('').destination).toBeNull();
  });
});

describe('pickCourse', () => {
  const known = new Set(['Rustwharf', 'Ionport']);

  it('refuses a harbour never moored at', () => {
    expect(pickCourse(null, 'Neon Reach', known).kind).toBe('uncharted');
    expect(pickCourse('Rustwharf', 'Neon Reach', known).kind).toBe('uncharted');
  });

  it('sets, switches and toggles off', () => {
    expect(pickCourse(null, 'Rustwharf', known)).toEqual({ kind: 'set', name: 'Rustwharf' });
    expect(pickCourse('Ionport', 'Rustwharf', known)).toEqual({ kind: 'set', name: 'Rustwharf' });
    expect(pickCourse('Rustwharf', 'Rustwharf', known)).toEqual({ kind: 'clear', name: 'Rustwharf' });
  });
});

describe('double tap', () => {
  it('pairs two close presses and consumes them', () => {
    const tap = createDoubleTap(350, 30);
    expect(tap.tap(100, 100, 0)).toBe(false);
    expect(tap.tap(110, 105, 200)).toBe(true);
    // A third press starts over rather than making a second double.
    expect(tap.tap(110, 105, 300)).toBe(false);
  });

  it('rejects presses too slow or too far apart', () => {
    const tap = createDoubleTap(350, 30);
    tap.tap(100, 100, 0);
    expect(tap.tap(100, 100, 500)).toBe(false);
    expect(tap.tap(200, 100, 600)).toBe(false);
  });
});

describe('harbour picking', () => {
  // A lens 60 units above the north pole, looking straight down.
  function overhead(): PerspectiveCamera {
    const camera = new PerspectiveCamera(55, 1, 0.1, 6000);
    camera.position.set(0, GLOBE_RADIUS + 60, 0);
    camera.up.set(0, 0, -1);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    return camera;
  }

  function beacon(name: string, dir: Vector3) {
    const d = dir.clone().normalize();
    const foot = d.clone().multiplyScalar(GLOBE_RADIUS);
    return { name, foot, top: foot.clone().addScaledVector(d, 10) };
  }

  it('hides a point on the far side of the planet', () => {
    const eye = new Vector3(0, GLOBE_RADIUS + 60, 0);
    expect(behindGlobe(eye, new Vector3(0, -GLOBE_RADIUS, 0))).toBe(true);
    expect(behindGlobe(eye, new Vector3(0, GLOBE_RADIUS, 0))).toBe(false);
  });

  it('takes the beacon under the click, and nothing off to the side', () => {
    const camera = overhead();
    const targets = [beacon('Pole', new Vector3(0, 1, 0)), beacon('Far', new Vector3(0, -1, 0))];
    // The pole is dead centre of an 800x800 view.
    expect(pickHarbour(targets, camera, 400, 400, 800, 800)).toBe('Pole');
    expect(pickHarbour(targets, camera, 400 + 60, 400, 800, 800)).toBeNull();
  });

  it('never picks through the planet', () => {
    const camera = overhead();
    const targets = [beacon('Far', new Vector3(0, -1, 0))];
    expect(pickHarbour(targets, camera, 400, 400, 800, 800)).toBeNull();
  });
});
