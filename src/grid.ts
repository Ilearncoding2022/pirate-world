import * as THREE from 'three';
import { GLOBE_RADIUS } from './geo';

/** Neon latitude/longitude grid floating just above the surface. */
export function createGrid(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'globe-grid';
  const r = GLOBE_RADIUS + 0.6;
  const STEP = 15;
  const SEG = 180;

  const faint: number[] = [];
  const bright: number[] = [];

  // Parallels: constant latitude.
  for (let lat = -75; lat <= 75; lat += STEP) {
    const arr = lat === 0 ? bright : faint;
    const phi = (lat * Math.PI) / 180;
    const y = Math.sin(phi) * r;
    const rad = Math.cos(phi) * r;
    for (let i = 0; i < SEG; i++) {
      const t0 = (i / SEG) * Math.PI * 2;
      const t1 = ((i + 1) / SEG) * Math.PI * 2;
      arr.push(Math.sin(t0) * rad, y, Math.cos(t0) * rad);
      arr.push(Math.sin(t1) * rad, y, Math.cos(t1) * rad);
    }
  }

  // Meridians: constant longitude.
  for (let lon = 0; lon < 360; lon += STEP) {
    const arr = lon === 0 || lon === 180 ? bright : faint;
    const th = (lon * Math.PI) / 180;
    for (let i = 0; i < SEG; i++) {
      const a0 = -Math.PI / 2 + (i / SEG) * Math.PI;
      const a1 = -Math.PI / 2 + ((i + 1) / SEG) * Math.PI;
      arr.push(Math.cos(a0) * Math.sin(th) * r, Math.sin(a0) * r, Math.cos(a0) * Math.cos(th) * r);
      arr.push(Math.cos(a1) * Math.sin(th) * r, Math.sin(a1) * r, Math.cos(a1) * Math.cos(th) * r);
    }
  }

  const make = (verts: number[], opacity: number, colorHex: string): THREE.LineSegments => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    const m = new THREE.LineBasicMaterial({
      color: new THREE.Color(colorHex),
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    return new THREE.LineSegments(g, m);
  };

  group.add(make(faint, 0.14, '#3fe0ff'));
  group.add(make(bright, 0.38, '#7ff0ff'));
  return group;
}
