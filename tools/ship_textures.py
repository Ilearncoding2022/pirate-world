"""
Procedural texture maps for the beginner pirate ship.

Everything here is generated with numpy and packed straight into the .blend as
image datablocks, so the glTF exporter embeds them in the GLB. No Cycles bake
pass is involved - these are authored maps, not captures of a shader.

Maps are deliberately shared where they can be: one wood normal/roughness pair
serves the hull, deck and trim (only the base colour differs), and one metal
pair serves brass, dark brass and iron. Sharing an image datablock across
materials exports as a single glTF image.
"""

import numpy as np
import bpy

# --------------------------------------------------------------------- helpers


def _to_image(name, arr, non_color=False):
    """Wraps an (h, w, 3|4) float array in a packed Blender image."""
    h, w = arr.shape[:2]
    rgba = np.ones((h, w, 4), np.float32)
    rgba[..., : arr.shape[2]] = arr
    img = bpy.data.images.new(name, w, h, alpha=False)
    if non_color:
        img.colorspace_settings.name = "Non-Color"
    img.pixels.foreach_set(np.clip(rgba, 0.0, 1.0).reshape(-1))
    img.pack()
    return img


def _noise(h, w, freq, seed, octaves=4):
    """Tiling value noise - the base for grain, mottling and weave."""
    rng = np.random.default_rng(seed)
    total = np.zeros((h, w), np.float32)
    amp, norm = 1.0, 0.0
    for o in range(octaves):
        f = max(2, freq * (2 ** o))
        g = rng.random((f + 1, f + 1)).astype(np.float32)
        g[-1, :] = g[0, :]          # wrap so the map tiles
        g[:, -1] = g[:, 0]
        ys = np.linspace(0, f, h, endpoint=False)
        xs = np.linspace(0, f, w, endpoint=False)
        y0, x0 = np.floor(ys).astype(int), np.floor(xs).astype(int)
        ty, tx = (ys - y0)[:, None], (xs - x0)[None, :]
        ty, tx = ty * ty * (3 - 2 * ty), tx * tx * (3 - 2 * tx)
        g0, g1 = g[y0], g[y0 + 1]
        v = ((g0[:, x0] * (1 - tx) + g0[:, x0 + 1] * tx) * (1 - ty)
             + (g1[:, x0] * (1 - tx) + g1[:, x0 + 1] * tx) * ty)
        total += amp * v
        norm += amp
        amp *= 0.5
    return total / norm


def _streaks(h, w, freq, seed, stretch=10):
    """Noise stretched along U - wood grain, brushed metal, rope fibre."""
    # Round the column count UP, or the repeat lands short of w and every
    # downstream broadcast against a full-width array fails.
    cols = max(4, -(-w // stretch))
    return np.repeat(_noise(h, cols, freq, seed), stretch, axis=1)[:, :w]


def _normal_from_height(height, strength=2.0):
    dy, dx = np.gradient(height.astype(np.float32))
    n = np.dstack((-dx * strength * height.shape[1] / 64.0,
                   -dy * strength * height.shape[0] / 64.0,
                   np.ones_like(height)))
    n /= np.linalg.norm(n, axis=2, keepdims=True)
    return n * 0.5 + 0.5


def _resize(arr, size):
    """Nearest-neighbour resample - normals do not need the albedo's resolution."""
    h, w = arr.shape[:2]
    ys = (np.linspace(0, h, size, endpoint=False)).astype(int)
    xs = (np.linspace(0, w, size, endpoint=False)).astype(int)
    return arr[ys][:, xs]


def _grid(h, w):
    v = np.linspace(0, 1, h, endpoint=False)[:, None] * np.ones((1, w), np.float32)
    u = np.linspace(0, 1, w, endpoint=False)[None, :] * np.ones((h, 1), np.float32)
    return u, v


def _disc(u, v, cx, cy, r, soft=0.004):
    d = np.sqrt((u - cx) ** 2 + (v - cy) ** 2)
    return np.clip((r - d) / soft, 0, 1)


def _bar(u, v, x0, y0, x1, y1, half, soft=0.004):
    """Anti-aliased capsule between two points - circuit traces, bones."""
    dx, dy = x1 - x0, y1 - y0
    ll = max(dx * dx + dy * dy, 1e-9)
    t = np.clip(((u - x0) * dx + (v - y0) * dy) / ll, 0, 1)
    d = np.sqrt((u - x0 - t * dx) ** 2 + (v - y0 - t * dy) ** 2)
    return np.clip((half - d) / soft, 0, 1)


# ------------------------------------------------------------------ wood + rope


def wood_maps(size=512, seed=7, normal_size=256):
    """Plank base/roughness/normal. Planks run along U so lofts read fore-aft."""
    h = w = size
    u, v = _grid(h, w)
    planks = 7
    row = np.floor(v * planks).astype(int)
    frac = v * planks - row

    rng = np.random.default_rng(seed)
    tint = rng.uniform(0.78, 1.22, planks + 1)[row]
    shift = rng.uniform(0.0, 1.0, planks + 1)[row]

    grain = _streaks(h, w, 10, seed, stretch=14)
    grain = 0.55 + 0.5 * grain + 0.12 * np.sin((v * planks * 40) + shift * 6.3)
    speck = _noise(h, w, 48, seed + 1)

    seam = np.clip(np.minimum(frac, 1 - frac) / 0.045, 0, 1)
    nails = np.zeros((h, w), np.float32)
    for i in range(planks + 1):
        for uu in (0.08, 0.5, 0.92):
            nails += _disc(u, v, uu, i / planks + 0.5 / planks, 0.006, 0.003)
    nails = np.clip(nails, 0, 1)

    shade = tint * grain * (0.40 + 0.60 * seam) * (0.88 + 0.24 * speck)
    base = np.dstack([shade, shade * 0.94, shade * 0.86])
    base = base / max(base.max(), 1e-6)

    rough = 0.72 + 0.22 * (1 - grain * 0.6) - 0.25 * nails
    height = 0.65 * seam + 0.25 * grain + 0.9 * nails
    return (
        _to_image("wood_base", base),
        _to_image("wood_rough", np.dstack([rough] * 3), non_color=True),
        _to_image("wood_normal",
                  _normal_from_height(_resize(height, normal_size), 1.6), non_color=True),
    )


def tinted(name, source_arr, colour):
    """A recoloured copy of a base map - keeps generation cost at one pass."""
    return _to_image(name, source_arr * np.array(colour, np.float32))


def wood_base_array(size=512, seed=7):
    """The wood albedo as a raw array, so trims can be tinted from one source."""
    h = w = size
    u, v = _grid(h, w)
    planks = 7
    row = np.floor(v * planks).astype(int)
    frac = v * planks - row
    rng = np.random.default_rng(seed)
    tint = rng.uniform(0.78, 1.22, planks + 1)[row]
    shift = rng.uniform(0.0, 1.0, planks + 1)[row]
    grain = _streaks(h, w, 10, seed, stretch=14)
    grain = 0.55 + 0.5 * grain + 0.12 * np.sin((v * planks * 40) + shift * 6.3)
    speck = _noise(h, w, 48, seed + 1)
    seam = np.clip(np.minimum(frac, 1 - frac) / 0.045, 0, 1)
    shade = tint * grain * (0.40 + 0.60 * seam) * (0.88 + 0.24 * speck)
    shade = shade / max(shade.max(), 1e-6)
    return np.dstack([shade, shade * 0.93, shade * 0.84])


def rope_maps(size=256, seed=21):
    """Twisted fibre: diagonal lay lines plus fuzz."""
    h = w = size
    u, v = _grid(h, w)
    lay = 0.5 + 0.5 * np.sin((u * 26 + v * 8) * np.pi)
    fuzz = _noise(h, w, 40, seed)
    shade = 0.45 + 0.35 * lay * (0.8 + 0.4 * fuzz)
    base = np.dstack([shade * 0.44, shade * 0.35, shade * 0.21])
    return (
        _to_image("rope_base", base),
        _to_image("rope_normal", _normal_from_height(lay * 0.8 + fuzz * 0.2, 1.1),
                  non_color=True),
    )


# ----------------------------------------------------------------------- metal


def metal_maps(size=512, seed=13, normal_size=256):
    """Brushed, slightly pitted metal shared by brass, dark brass and iron."""
    h = w = size
    brush = _streaks(h, w, 14, seed, stretch=18)
    pits = _noise(h, w, 64, seed + 3)
    patina = _noise(h, w, 6, seed + 5)

    shade = 0.72 + 0.28 * brush
    shade *= 0.86 + 0.28 * patina
    base = np.dstack([shade, shade * 0.97, shade * 0.93])
    base = base / max(base.max(), 1e-6)

    # Scratches read as roughness breaks, not colour changes.
    rough = 0.30 + 0.34 * (1 - brush) + 0.18 * (pits > 0.72)
    height = 0.35 * brush + 0.65 * np.clip(pits - 0.55, 0, 1)
    return (
        _to_image("metal_base", base),
        _to_image("metal_rough", np.dstack([rough] * 3), non_color=True),
        _to_image("metal_normal",
                  _normal_from_height(_resize(height, normal_size), 1.0), non_color=True),
    )


def metal_base_array(size=512, seed=13):
    h = w = size
    brush = _streaks(h, w, 14, seed, stretch=18)
    patina = _noise(h, w, 6, seed + 5)
    shade = (0.72 + 0.28 * brush) * (0.86 + 0.28 * patina)
    shade = shade / max(shade.max(), 1e-6)
    return np.dstack([shade, shade * 0.97, shade * 0.93])


# ------------------------------------------------------------------ sail + flag


def _circuit_mask(h, w):
    """The glowing trace layout - traces, junction nodes and a central ring.

    Drawing this into a texture replaces 18 floating rune boxes with pixels, so
    the pattern can carry far more detail than geometry could at this size.
    """
    u, v = _grid(h, w)
    m = np.zeros((h, w), np.float32)
    half = 0.0055

    traces = [
        (0.14, 0.22, 0.86, 0.22), (0.14, 0.22, 0.14, 0.74),
        (0.86, 0.22, 0.86, 0.74), (0.14, 0.74, 0.36, 0.74),
        (0.86, 0.74, 0.64, 0.74), (0.30, 0.40, 0.70, 0.40),
        (0.50, 0.14, 0.50, 0.30), (0.50, 0.62, 0.50, 0.86),
        (0.30, 0.40, 0.30, 0.22), (0.70, 0.40, 0.70, 0.22),
        (0.22, 0.56, 0.38, 0.56), (0.62, 0.56, 0.78, 0.56),
        (0.22, 0.36, 0.22, 0.56), (0.78, 0.36, 0.78, 0.56),
        (0.36, 0.86, 0.64, 0.86), (0.36, 0.74, 0.36, 0.86),
        (0.64, 0.74, 0.64, 0.86), (0.08, 0.48, 0.14, 0.48),
        (0.92, 0.48, 0.86, 0.48),
    ]
    for x0, y0, x1, y1 in traces:
        m = np.maximum(m, _bar(u, v, x0, y0, x1, y1, half))

    # Central ring, the reference art's hero motif.
    d = np.sqrt((u - 0.5) ** 2 + (v - 0.46) ** 2)
    m = np.maximum(m, np.clip((0.012 - np.abs(d - 0.145)) / 0.004, 0, 1))
    for a in range(8):
        th = a * np.pi / 4
        m = np.maximum(m, _bar(u, v, 0.5 + 0.145 * np.cos(th), 0.46 + 0.145 * np.sin(th),
                               0.5 + 0.185 * np.cos(th), 0.46 + 0.185 * np.sin(th), 0.004))

    nodes = [(0.14, 0.22), (0.86, 0.22), (0.14, 0.74), (0.86, 0.74), (0.50, 0.14),
             (0.50, 0.86), (0.30, 0.40), (0.70, 0.40), (0.22, 0.56), (0.78, 0.56),
             (0.36, 0.86), (0.64, 0.86), (0.36, 0.74), (0.64, 0.74)]
    for cx, cy in nodes:
        m = np.maximum(m, _disc(u, v, cx, cy, 0.018))
    return np.clip(m, 0, 1)


def sail_maps(size=1024, seed=31, normal_size=256):
    """Patched indigo canvas with stitched seams and glowing circuit traces."""
    h = w = size
    u, v = _grid(h, w)

    weave = (0.5 + 0.5 * np.sin(u * np.pi * size / 3)) * (0.5 + 0.5 * np.sin(v * np.pi * size / 3))
    dirt = _noise(h, w, 8, seed)
    wear = _noise(h, w, 24, seed + 2)

    shade = 0.55 + 0.16 * weave + 0.22 * dirt + 0.08 * wear
    base = np.dstack([shade * 0.21, shade * 0.18, shade * 0.42])

    # Cloth patches with stitched borders, as in the reference art.
    patches = [(0.06, 0.06, 0.30, 0.26), (0.70, 0.62, 0.94, 0.88), (0.40, 0.80, 0.62, 0.96)]
    for x0, y0, x1, y1 in patches:
        inside = ((u > x0) & (u < x1) & (v > y0) & (v < y1)).astype(np.float32)
        base *= (1.0 - 0.22 * inside)[..., None]
        border = np.zeros((h, w), np.float32)
        for a, b, c, d2 in ((x0, y0, x1, y0), (x0, y1, x1, y1),
                            (x0, y0, x0, y1), (x1, y0, x1, y1)):
            border = np.maximum(border, _bar(u, v, a, b, c, d2, 0.004))
        # Dash the border so it reads as stitching, not a drawn line.
        dash = (np.sin((u + v) * np.pi * 150) > 0).astype(np.float32)
        base += (border * dash * 0.05)[..., None]

    seams = np.clip((0.003 - np.abs(((v * 5) % 1.0) - 0.5) * 0.006) / 0.002, 0, 1)
    base *= (1.0 - 0.12 * seams)[..., None]

    circuit = _circuit_mask(h, w)
    base += np.dstack([circuit * 0.05, circuit * 0.22, circuit * 0.30])

    emis = np.dstack([circuit * 0.12, circuit * 0.80, circuit * 1.0])
    height = 0.35 * weave + 0.5 * seams + 0.25 * wear
    return (
        _to_image("sail_base", np.clip(base, 0, 1)),
        _to_image("sail_emissive", emis),
        _to_image("sail_normal",
                  _normal_from_height(_resize(height, normal_size), 0.5), non_color=True),
    )


def flag_maps(size=512, seed=41):
    """Jolly Roger: glitched skull and crossbones in glowing cyan."""
    h = w = size
    u, v = _grid(h, w)

    weave = _noise(h, w, 30, seed)
    shade = 0.55 + 0.45 * weave
    base = np.dstack([shade * 0.30, shade * 0.24, shade * 0.72])

    mask = np.zeros((h, w), np.float32)
    # Crossbones behind the skull.
    for x0, y0, x1, y1 in ((0.22, 0.30, 0.78, 0.72), (0.22, 0.72, 0.78, 0.30)):
        mask = np.maximum(mask, _bar(u, v, x0, y0, x1, y1, 0.035))
        for cx, cy in ((x0, y0), (x1, y1)):
            mask = np.maximum(mask, _disc(u, v, cx, cy, 0.055))
    # Cranium, jaw, and the dark features knocked back out of them.
    skull = np.maximum(_disc(u, v, 0.5, 0.56, 0.20), 0.0)
    jaw = ((u > 0.40) & (u < 0.60) & (v > 0.30) & (v < 0.56)).astype(np.float32)
    mask = np.maximum(mask, np.maximum(skull, jaw))
    holes = np.zeros((h, w), np.float32)
    holes = np.maximum(holes, _disc(u, v, 0.43, 0.60, 0.055))
    holes = np.maximum(holes, _disc(u, v, 0.57, 0.60, 0.055))
    holes = np.maximum(holes, _bar(u, v, 0.50, 0.50, 0.50, 0.54, 0.018))
    for i in range(3):
        holes = np.maximum(holes, _bar(u, v, 0.44 + i * 0.06, 0.30, 0.44 + i * 0.06, 0.42, 0.008))
    mask = np.clip(mask - holes, 0, 1)

    # Horizontal glitch tearing along the fly, like the source art.
    rng = np.random.default_rng(seed)
    for _ in range(9):
        y = rng.uniform(0.1, 0.9)
        band = ((v > y) & (v < y + rng.uniform(0.006, 0.02))).astype(np.float32)
        shift = int(rng.integers(-size // 18, size // 18))
        mask = np.maximum(mask * (1 - band), np.roll(mask, shift, axis=1) * band)

    base += np.dstack([mask * 0.10, mask * 0.55, mask * 0.70])
    emis = np.dstack([mask * 0.14, mask * 0.82, mask * 1.0])
    return _to_image("flag_base", np.clip(base, 0, 1)), _to_image("flag_emissive", emis)
