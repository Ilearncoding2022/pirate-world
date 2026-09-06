"""
Builds the beginner pirate ship model from assets/pirateship_beginner.png.

Run headless:
    blender --background --python tools/build_ship.py

Outputs:
    assets/pirateship_beginner.glb          the model
    assets/pirateship_beginner_preview.png  3/4 rear view - the game's camera
    assets/pirateship_beginner_side.png     side elevation
    assets/pirateship_beginner_detail.png   close on the deck

Axis convention. Blender is Z-up; the glTF exporter maps Blender (x, y, z) onto
glTF (x, z, -y). So Blender +Z becomes glTF +Y (up, as wanted) but Blender -Y
becomes glTF *+Z* - the opposite end from ship.ts's bow. We build bow-toward--Y
because that reads naturally alongside the three.js placeholder, then yaw the
root 180 degrees about Z before export. That is a rotation, not a mirror, so the
ship keeps its handedness and lands on ship.ts's convention exactly: bow -Z,
up +Y, starboard +X. Hull spans y -2.4 (bow) .. +2.6 (transom).

Three things carry the detail, in order of how much they matter:

1. Shading. Every part is smooth-shaded by angle and beveled, so edges catch a
   specular highlight instead of dying at a hard 90 degrees.
2. Texture. Procedural plank/metal/canvas maps from ship_textures.py, on real
   UVs - lofted parts get analytic UVs so planks run fore-aft rather than in
   whatever direction an automatic unwrap happened to pick.
3. Geometry. Enough sections that curves read as curves, plus trim that rides
   the hull surface via hull_point/hull_frame.

The QUALITY knobs below scale the whole model; halve them for a cheap LOD.
"""

import math
import os
import sys

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ASSETS = os.path.join(ROOT, "assets")

if HERE not in sys.path:
    sys.path.insert(0, HERE)
import ship_textures as tex  # noqa: E402  (needs the sys.path line above)

BOW_Y = -2.4
STERN_Y = 2.6

QUALITY = {
    "hull_stations": 46,     # lengthwise divisions of the hull loft
    "hull_section": 17,      # points per half section (bilge roundness)
    "cyl_verts": 28,         # sides on every cylinder
    "torus_major": 32,
    "torus_minor": 14,
    "rope_verts": 8,
    "sail_grid": (18, 14),
    "bevel_width": 0.009,
    "bevel_segments": 3,
    "smooth_angle": math.radians(41),
    "tex_wood": 512,
    "tex_metal": 512,
    "tex_sail": 768,
    "tex_flag": 512,
}

# Parts kept as their own objects through the merge, because the game may want
# to address them: the glows it can pulse, and the two cloth pieces.
KEEP_SEPARATE = (
    "thruster_flame", "porthole_glow", "pod_eye", "window_glow", "port_glow",
    "capstan_core", "lantern_glow", "mainsail", "flag",
)


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


# ----------------------------------------------------------------- materials


def make_mat(name, color, roughness=0.8, metallic=0.0, emission=None, strength=0.0):
    """Flat, untextured material - used for the neon emitters."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    if emission is not None:
        bsdf.inputs["Emission Color"].default_value = (*emission, 1.0)
        bsdf.inputs["Emission Strength"].default_value = strength
    return mat


def tex_mat(name, base_img, rough_img=None, normal_img=None, metallic=0.0,
            roughness=0.8, emissive_img=None, strength=0.0, scale=(1.0, 1.0),
            normal_strength=1.0, double_sided=False):
    """Textured material.

    `scale` drives a Mapping node, which the glTF exporter writes out as
    KHR_texture_transform - three.js honours it, so tiling stays a material
    setting rather than something baked into every UV.
    """
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    mat.use_backface_culling = not double_sided

    uv = nt.nodes.new("ShaderNodeUVMap")
    uv.uv_map = "UVMap"
    mapping = nt.nodes.new("ShaderNodeMapping")
    mapping.inputs["Scale"].default_value = (scale[0], scale[1], 1.0)
    nt.links.new(uv.outputs["UV"], mapping.inputs["Vector"])

    def image_node(img):
        node = nt.nodes.new("ShaderNodeTexImage")
        node.image = img
        nt.links.new(mapping.outputs["Vector"], node.inputs["Vector"])
        return node

    nt.links.new(image_node(base_img).outputs["Color"], bsdf.inputs["Base Color"])
    if rough_img is not None:
        nt.links.new(image_node(rough_img).outputs["Color"], bsdf.inputs["Roughness"])
    if normal_img is not None:
        nmap = nt.nodes.new("ShaderNodeNormalMap")
        nmap.inputs["Strength"].default_value = normal_strength
        nt.links.new(image_node(normal_img).outputs["Color"], nmap.inputs["Color"])
        nt.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
    if emissive_img is not None:
        nt.links.new(image_node(emissive_img).outputs["Color"], bsdf.inputs["Emission Color"])
        bsdf.inputs["Emission Strength"].default_value = strength
    return mat


def build_materials():
    wood_size = QUALITY["tex_wood"]
    metal_size = QUALITY["tex_metal"]

    _, wood_rough, wood_normal = tex.wood_maps(wood_size, normal_size=256)
    wood_arr = tex.wood_base_array(wood_size)
    _, metal_rough, metal_normal = tex.metal_maps(metal_size, normal_size=256)
    metal_arr = tex.metal_base_array(metal_size)
    rope_base, rope_normal = tex.rope_maps(256)
    sail_base, sail_emis, sail_normal = tex.sail_maps(QUALITY["tex_sail"], normal_size=256)
    flag_base, flag_emis = tex.flag_maps(QUALITY["tex_flag"])

    # One wood pass, one metal pass; the families differ only by tint, which
    # keeps the GLB down to two shared normal/roughness pairs.
    hull_base = tex.tinted("hull_base", wood_arr, (0.34, 0.20, 0.115))
    seam_base = tex.tinted("hull_seam_base", wood_arr, (0.19, 0.105, 0.060))
    deck_base = tex.tinted("deck_base", wood_arr, (0.62, 0.395, 0.205))
    trim_base = tex.tinted("wood_trim_base", wood_arr, (0.48, 0.290, 0.150))
    brass_base = tex.tinted("brass_base", metal_arr, (0.86, 0.560, 0.165))
    brass_dark_base = tex.tinted("brass_dark_base", metal_arr, (0.45, 0.265, 0.085))
    iron_base = tex.tinted("iron_base", metal_arr, (0.135, 0.130, 0.150))

    def wood(name, img, scale, double_sided=False):
        return tex_mat(name, img, wood_rough, wood_normal, scale=scale, normal_strength=0.9,
                       double_sided=double_sided)

    def metal(name, img, scale, metallic=0.85):
        return tex_mat(name, img, metal_rough, metal_normal, metallic=metallic,
                       scale=scale, normal_strength=0.6)

    return {
        # Double-sided: the follow camera looks down past the rail into the
        # hull, and a culled backface shows the sky through the ship.
        "hull": wood("hull_planks", hull_base, (3.0, 2.0), double_sided=True),
        "hull_dark": wood("hull_seam", seam_base, (6.0, 1.0)),
        "deck": wood("deck_planks", deck_base, (2.0, 0.4)),
        "wood": wood("wood_trim", trim_base, (1.6, 1.6)),
        "brass": metal("brass", brass_base, (1.4, 1.4)),
        "brass_dark": metal("brass_dark", brass_dark_base, (1.4, 1.4)),
        "iron": metal("iron", iron_base, (1.2, 1.2), metallic=0.9),
        "rope": tex_mat("rope", rope_base, None, rope_normal, roughness=0.95,
                        scale=(6.0, 1.0), normal_strength=0.8),
        "sail": tex_mat("sail_cloth", sail_base, None, sail_normal, roughness=0.92,
                        emissive_img=sail_emis, strength=2.2, normal_strength=0.5,
                        double_sided=True),
        "flag": tex_mat("flag_cloth", flag_base, None, None, roughness=0.95,
                        emissive_img=flag_emis, strength=2.4, double_sided=True),
        "cyan": make_mat("neon_cyan", (0.02, 0.09, 0.11), 0.35, 0.1, (0.10, 0.72, 1.0), 2.6),
        "violet": make_mat("neon_violet", (0.09, 0.02, 0.10), 0.35, 0.1, (0.62, 0.20, 1.0), 2.2),
        "lime": make_mat("neon_lime", (0.05, 0.10, 0.02), 0.35, 0.1, (0.48, 1.0, 0.16), 2.6),
        "thruster": make_mat("thruster_flame", (0.30, 0.22, 0.42), 0.20, 0.0,
                             (0.80, 0.60, 1.0), 3.5),
    }


# ------------------------------------------------------------ mesh utilities

PARTS = []


def finish(obj, bevel=True, width=None, segments=None):
    """Smooth-shade by angle, then bevel the hard edges.

    This is where the model stops reading as raw primitives: the bevel catches a
    specular line along every edge, and smoothing below the angle threshold keeps
    curved surfaces round while leaving genuine creases crisp.
    """
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    try:
        bpy.ops.object.shade_smooth_by_angle(angle=QUALITY["smooth_angle"])
    except (AttributeError, RuntimeError):
        bpy.ops.object.shade_smooth()
    if bevel:
        mod = obj.modifiers.new("bevel", "BEVEL")
        mod.width = QUALITY["bevel_width"] if width is None else width
        mod.segments = QUALITY["bevel_segments"] if segments is None else segments
        mod.limit_method = "ANGLE"
        mod.angle_limit = math.radians(30)
        mod.use_clamp_overlap = True
    PARTS.append(obj)
    return obj


def new_obj(name, verts, faces, mat, bevel=True, width=None, uvs=None):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.validate()
    mesh.update()
    mesh.materials.append(mat)
    if uvs is not None:
        layer = mesh.uv_layers.new(name="UVMap")
        for poly in mesh.polygons:
            for li in poly.loop_indices:
                layer.data[li].uv = uvs[mesh.loops[li].vertex_index]
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return finish(obj, bevel, width)


def loft(name, rings, mat, cap_start=True, cap_end=True, bevel=True, width=None, uv=(1.0, 1.0)):
    """Skins equal-length vertex rings into a tube, with analytic UVs.

    U follows the length of the loft and V wraps the section, so a plank texture
    laid on the hull runs fore-and-aft the way real planking does.
    """
    n, stations = len(rings[0]), len(rings)
    verts, faces, uvs = [], [], []
    for s, ring in enumerate(rings):
        verts.extend(ring)
        for i in range(n):
            uvs.append((s / max(stations - 1, 1) * uv[0], i / max(n - 1, 1) * uv[1]))
    for s in range(stations - 1):
        a, b = s * n, (s + 1) * n
        for i in range(n - 1):
            faces.append((a + i, a + i + 1, b + i + 1, b + i))
    if cap_start:
        faces.append(tuple(range(n - 1, -1, -1)))
    if cap_end:
        base = (stations - 1) * n
        faces.append(tuple(range(base, base + n)))
    return new_obj(name, verts, faces, mat, bevel, width, uvs)


def prim(kind, mat, name, loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1),
         bevel=True, width=None, **kwargs):
    getattr(bpy.ops.mesh, f"primitive_{kind}_add")(location=loc, rotation=rot, **kwargs)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(mat)
    if not obj.data.uv_layers:
        obj.data.uv_layers.new(name="UVMap")
    return finish(obj, bevel, width)


def box(mat, name, center, size, rot=(0, 0, 0), width=None):
    return prim("cube", mat, name, loc=center, rot=rot, width=width,
                scale=(size[0] / 2, size[1] / 2, size[2] / 2), size=2)


def cyl(mat, name, center, radius, depth, rot=(0, 0, 0), verts=None, width=None):
    return prim("cylinder", mat, name, loc=center, rot=rot, width=width,
                radius=radius, depth=depth, vertices=verts or QUALITY["cyl_verts"])


def rod(mat, name, p0, p1, radius, verts=None, width=0.004):
    """A cylinder spanning two points - rigging, spokes, anchor arms."""
    p0, p1 = Vector(p0), Vector(p1)
    d = p1 - p0
    return prim("cylinder", mat, name, loc=(p0 + p1) / 2,
                rot=d.to_track_quat("Z", "Y").to_euler(), width=width,
                radius=radius, depth=max(d.length, 1e-4),
                vertices=verts or QUALITY["rope_verts"])


def ring_of(fn, count, radius, center, axis="y"):
    """Places `count` copies around a circle - rivets, bolt patterns."""
    out = []
    for i in range(count):
        a = 2 * math.pi * i / count
        if axis == "y":
            p = (center[0] + radius * math.cos(a), center[1], center[2] + radius * math.sin(a))
        else:
            p = (center[0], center[1] + radius * math.cos(a), center[2] + radius * math.sin(a))
        out.append(fn(i, p))
    return out


# ------------------------------------------------------------------- the hull


def half_width(f):
    """Beam grows fast off the stem, then holds full width back to a wide transom."""
    return 0.085 + 0.94 * (f ** 0.55)


def keel_z(f):
    """Rocker: the keel lifts toward the stem and, less, toward the transom."""
    return -0.56 + 0.46 * (1 - f) ** 2.2 + 0.10 * f ** 3.0


def sheer_z(f):
    """Sheer line: gunwale rises at both ends, highest at the stern castle."""
    return 0.44 + 0.26 * (1 - f) ** 2.0 + 0.20 * f ** 2.4


def station_y(f):
    return BOW_Y + (STERN_Y - BOW_Y) * f


def hull_point(f, t, side=1):
    """A point on the hull skin. f runs bow(0)->transom(1), t keel(0)->sheer(1)."""
    w, zk, zs = half_width(f), keel_z(f), sheer_z(f)
    a = t * math.pi / 2
    x = side * w * math.sin(a) ** 0.62
    z = zk + (zs - zk) * (1 - math.cos(a) ** 1.7)
    return Vector((x, station_y(f), z))


def hull_frame(f, t, side=1):
    """Outward normal and along-section tangent at a point on the skin.

    Lets trim (planks, strakes, ribs) sit ON the curved hull rather than float
    beside it, which is most of why the topsides read as built rather than
    extruded.
    """
    d = 1e-3
    du = hull_point(min(f + d, 1.0), t, side) - hull_point(max(f - d, 0.0), t, side)
    dv = hull_point(f, min(t + d, 1.0), side) - hull_point(f, max(t - d, 0.0), side)
    n = du.cross(dv)
    if n.length < 1e-9:
        n = Vector((side, 0.0, 0.0))
    n.normalize()
    if n.x * side < 0:
        n = -n
    return n, dv.normalized()


def build_hull(mats):
    ns, npts = QUALITY["hull_stations"], QUALITY["hull_section"]
    rings = []
    for i in range(ns + 1):
        f = i / ns
        half = [hull_point(f, j / (npts - 1)) for j in range(npts)]
        rings.append([Vector((-p.x, p.y, p.z)) for p in reversed(half)] + half[1:])
    loft("hull", rings, mats["hull"], width=0.02, uv=(1.0, 1.0))


def build_planking(mats):
    """Raised plank battens wrapping the topsides - the main hull surface detail."""
    for side in (-1, 1):
        for i, t in enumerate((0.44, 0.58, 0.72, 0.86)):
            rings = []
            for k in range(29):
                f = 0.045 + 0.925 * (k / 28)
                p = hull_point(f, t, side)
                n, tan = hull_frame(f, t, side)
                rings.append([
                    p + tan * 0.028 - n * 0.005,
                    p + tan * 0.028 + n * 0.020,
                    p - tan * 0.028 + n * 0.020,
                    p - tan * 0.028 - n * 0.005,
                    p + tan * 0.028 - n * 0.005,
                ])
            loft(f"plank_{side}_{i}", rings, mats["hull_dark"], width=0.004, uv=(4.0, 0.3))


def build_rail(mats):
    """Brass-capped gunwale lofted along the sheer, with balusters beneath it."""
    for side in (-1, 1):
        rings = []
        for i in range(33):
            f = i / 32
            w, zs = half_width(f), sheer_z(f)
            y = station_y(f)
            cx, cz = side * (w - 0.03), zs + 0.06
            rings.append([
                Vector((cx - 0.075, y, cz - 0.10)),
                Vector((cx + 0.075, y, cz - 0.10)),
                Vector((cx + 0.075, y, cz + 0.10)),
                Vector((cx - 0.075, y, cz + 0.10)),
                Vector((cx - 0.075, y, cz - 0.10)),
            ])
        loft(f"rail_{'port' if side < 0 else 'stbd'}", rings, mats["brass"], width=0.006,
             uv=(5.0, 0.5))

        for i in range(13):
            f = 0.10 + 0.86 * (i / 12)
            w, zs = half_width(f), sheer_z(f)
            box(mats["wood"], f"baluster_{side}_{i}",
                (side * (w - 0.085), station_y(f), zs - 0.10), (0.055, 0.055, 0.30), width=0.006)


def build_deck(mats):
    """Deck laid as individual planks, so the seams are real geometry."""
    planks = 9
    for p in range(planks):
        u0 = -1 + 2 * (p / planks) + 0.012
        u1 = -1 + 2 * ((p + 1) / planks) - 0.012
        rings = []
        for i in range(25):
            f = 0.10 + 0.86 * (i / 24)
            w = half_width(f) * 0.90
            y = station_y(f)
            rings.append([
                Vector((u0 * w, y, 0.36)),
                Vector((u1 * w, y, 0.36)),
                Vector((u1 * w, y, 0.42)),
                Vector((u0 * w, y, 0.42)),
                Vector((u0 * w, y, 0.36)),
            ])
        loft(f"deck_plank_{p}", rings, mats["deck"], width=0.005, uv=(3.0, 0.15))


# ------------------------------------------------------------------- fittings


def build_stern(mats):
    """Transom furniture: the porthole eye, lit windows, engine pods, thrusters."""
    ty = STERN_Y - 0.02

    box(mats["wood"], "transom_panel", (0, ty - 0.06, -0.06), (1.55, 0.10, 0.86))
    box(mats["brass_dark"], "transom_moulding", (0, ty + 0.01, 0.34), (1.62, 0.09, 0.09))

    # Big brass porthole with a glowing violet iris. Built on -X here, which
    # the export yaw puts on starboard - the side it sits on in the art.
    cyl(mats["brass"], "porthole_ring", (-0.26, ty + 0.05, -0.02), 0.27, 0.14,
        rot=(math.pi / 2, 0, 0))
    cyl(mats["brass_dark"], "porthole_bezel", (-0.26, ty + 0.09, -0.02), 0.22, 0.10,
        rot=(math.pi / 2, 0, 0))
    cyl(mats["violet"], "porthole_glow", (-0.26, ty + 0.12, -0.02), 0.185, 0.06,
        rot=(math.pi / 2, 0, 0))
    ring_of(lambda i, p: cyl(mats["brass_dark"], f"porthole_rivet_{i}", p, 0.022, 0.05,
                             rot=(math.pi / 2, 0, 0), verts=8, width=0.002),
            8, 0.235, (-0.26, ty + 0.10, -0.02))

    # Square lime cabin windows.
    for i, x in enumerate((0.16, 0.46)):
        box(mats["brass_dark"], f"window_frame_{i}", (x, ty + 0.02, -0.10), (0.22, 0.10, 0.30))
        box(mats["lime"], f"window_glow_{i}", (x, ty + 0.07, -0.10), (0.16, 0.06, 0.23))
        box(mats["brass"], f"window_bar_{i}", (x, ty + 0.09, -0.10), (0.03, 0.03, 0.24),
            width=0.003)

    # Engine pods: brass barrels with violet glass bands, flanking the transom.
    for side in (-1, 1):
        x = side * 0.80
        cyl(mats["brass"], f"pod_{side}", (x, ty - 0.36, 0.02), 0.24, 1.05,
            rot=(math.pi / 2, 0, 0))
        cyl(mats["violet"], f"pod_glass_{side}", (x, ty - 0.36, 0.02), 0.25, 0.42,
            rot=(math.pi / 2, 0, 0))
        for j, oy in enumerate((-0.62, -0.10)):
            cyl(mats["brass_dark"], f"pod_band_{side}_{j}", (x, ty + oy, 0.02), 0.262, 0.07,
                rot=(math.pi / 2, 0, 0), width=0.004)
        cyl(mats["brass"], f"pod_cap_{side}", (x, ty + 0.16, 0.02), 0.27, 0.14,
            rot=(math.pi / 2, 0, 0))
        cyl(mats["violet"], f"pod_eye_{side}", (x, ty + 0.23, 0.02), 0.17, 0.06,
            rot=(math.pi / 2, 0, 0))
        ring_of(lambda i, p, s=side: cyl(mats["brass_dark"], f"pod_rivet_{s}_{i}", p, 0.02, 0.05,
                                         rot=(math.pi / 2, 0, 0), verts=8, width=0.002),
                8, 0.225, (x, ty + 0.20, 0.02))

    # Lower thruster nozzles + their flames. Named so ship.ts can drive them.
    for side in (-1, 1):
        x = side * 0.46
        cyl(mats["brass_dark"], f"nozzle_{side}", (x, ty + 0.10, -0.52), 0.17, 0.34,
            rot=(math.pi / 2, 0, 0))
        cyl(mats["iron"], f"nozzle_throat_{side}", (x, ty + 0.24, -0.52), 0.135, 0.10,
            rot=(math.pi / 2, 0, 0))
        prim("cone", mats["thruster"], f"thruster_flame_{side}",
             loc=(x, ty + 0.44, -0.52), rot=(-math.pi / 2, 0, 0), width=0.003,
             radius1=0.115, radius2=0.0, depth=0.46, vertices=QUALITY["cyl_verts"])

    box(mats["brass"], "lantern_body", (0.62, ty + 0.02, 0.52), (0.16, 0.16, 0.22))
    cyl(mats["violet"], "lantern_glow", (0.62, ty + 0.02, 0.52), 0.075, 0.20, width=0.003)


def build_rig(mats):
    """Mast, yard, crow's nest, sail, standing rigging and flag."""
    mast_y = -0.15
    mast_top = 3.95

    cyl(mats["wood"], "mast", (0, mast_y, 2.15), 0.085, 3.6)
    for z in (1.05, 2.30, 3.35):
        cyl(mats["brass"], f"mast_band_{z}", (0, mast_y, z), 0.10, 0.10, width=0.005)

    prim("torus", mats["brass"], "crows_nest", loc=(0, mast_y, 3.05), width=0.006,
         major_radius=0.26, minor_radius=0.05,
         major_segments=QUALITY["torus_major"], minor_segments=QUALITY["torus_minor"])
    ring_of(lambda i, p: rod(mats["wood"], f"nest_strut_{i}", p, (0, mast_y, 2.78), 0.018),
            6, 0.26, (0, mast_y, 3.05), axis="x")

    cyl(mats["wood"], "yard", (0, mast_y, 2.72), 0.055, 2.35, rot=(0, math.pi / 2, 0))
    for x in (-0.85, -0.35, 0.35, 0.85):
        cyl(mats["brass"], f"yard_band_{x}", (x, mast_y, 2.72), 0.07, 0.09,
            rot=(0, math.pi / 2, 0), width=0.004)
    for x in (-1.17, 1.17):
        prim("uv_sphere", mats["brass"], f"yard_tip_{x}", loc=(x, mast_y, 2.72), width=0.004,
             radius=0.065, segments=16, ring_count=10)

    # Mainsail: a grid bellied forward, since the wind is over the stern. The
    # circuit runes live in the texture now, not in floating geometry.
    cols, rows = QUALITY["sail_grid"]
    w, h, top = 2.30, 1.95, 2.64

    def sail_y(u, v):
        belly = math.sin(u * math.pi) * math.sin(min(1.0, v * 1.25) * math.pi * 0.75)
        return mast_y - 0.06 - 0.42 * belly

    verts, faces, uvs = [], [], []
    for r in range(rows + 1):
        for c in range(cols + 1):
            u, v = c / cols, r / rows
            # Scalloped foot, like cloth hanging between its corners.
            vv = v + (0.05 * math.sin(u * math.pi) if r == rows else 0.0)
            verts.append(Vector(((u - 0.5) * w, sail_y(u, v), top - vv * h)))
            uvs.append((u, 1.0 - v))
    for r in range(rows):
        for c in range(cols):
            a = r * (cols + 1) + c
            b = a + cols + 1
            faces.append((a, a + 1, b + 1, b))
    new_obj("mainsail", verts, faces, mats["sail"], bevel=False, uvs=uvs)

    # Standing rigging: shrouds to the rail with ratlines, plus fore/back stays.
    for side in (-1, 1):
        anchors = []
        for i, f in enumerate((0.36, 0.50, 0.64)):
            w_h, zs = half_width(f), sheer_z(f)
            foot = Vector((side * (w_h - 0.05), station_y(f), zs + 0.10))
            head = Vector((side * 0.05, mast_y, 3.02))
            rod(mats["rope"], f"shroud_{side}_{i}", foot, head, 0.016)
            anchors.append((foot, head))
        for r in range(7):
            t = 0.12 + 0.72 * (r / 6)
            rod(mats["rope"], f"ratline_{side}_{r}",
                anchors[0][0].lerp(anchors[0][1], t),
                anchors[-1][0].lerp(anchors[-1][1], t), 0.011)

    rod(mats["rope"], "forestay", (0, mast_y, mast_top - 0.30), (0, -3.30, 0.90), 0.017)
    rod(mats["rope"], "backstay", (0, mast_y, mast_top - 0.30), (0, STERN_Y - 0.10, 0.70), 0.017)
    for side in (-1, 1):
        rod(mats["rope"], f"yard_brace_{side}", (side * 1.15, mast_y, 2.72),
            (side * 0.55, STERN_Y - 0.35, 0.62), 0.012)

    # Jolly Roger. The glitched skull is painted into flag_emissive.
    fverts, ffaces, fuvs = [], [], []
    fc, fr = 10, 6
    for r in range(fr + 1):
        for c in range(fc + 1):
            u, v = c / fc, r / fr
            # Ripple, so the flag is cloth in the wind rather than a card.
            y = mast_y + 0.06 * math.sin(u * 5.0) * (0.25 + 0.75 * u)
            fverts.append(Vector((0.03 + u * 0.86, y, 3.95 - v * 0.46)))
            fuvs.append((u, 1.0 - v))
    for r in range(fr):
        for c in range(fc):
            a = r * (fc + 1) + c
            b = a + fc + 1
            ffaces.append((a, a + 1, b + 1, b))
    new_obj("flag", fverts, ffaces, mats["flag"], bevel=False, uvs=fuvs)


def build_deck_fittings(mats):
    # Ship's wheel: rim, hub, spokes and handles.
    wheel = (-0.28, 1.05, 0.86)
    prim("torus", mats["brass"], "wheel", loc=wheel, rot=(math.pi / 2, 0, 0), width=0.005,
         major_radius=0.24, minor_radius=0.045,
         major_segments=QUALITY["torus_major"], minor_segments=QUALITY["torus_minor"])
    cyl(mats["brass_dark"], "wheel_hub", wheel, 0.07, 0.10, rot=(math.pi / 2, 0, 0))
    for i in range(8):
        a = i * math.pi / 4
        rod(mats["brass"], f"wheel_spoke_{i}", wheel,
            (wheel[0] + 0.30 * math.cos(a), wheel[1], wheel[2] + 0.30 * math.sin(a)),
            0.017, verts=10)
    box(mats["wood"], "binnacle", (-0.28, 1.22, 0.62), (0.16, 0.16, 0.30))

    # Deck grating with real bars, and a hatch coaming.
    for i in range(7):
        box(mats["brass_dark"], f"grate_bar_{i}", (0.16, 0.30 + 0.11 * i, 0.44),
            (0.60, 0.05, 0.05), width=0.004)
    box(mats["wood"], "hatch", (-0.34, -0.62, 0.50), (0.42, 0.52, 0.16))
    box(mats["brass_dark"], "hatch_strap", (-0.34, -0.62, 0.59), (0.44, 0.08, 0.04), width=0.003)

    # Capstan with a violet core.
    cyl(mats["brass"], "capstan", (0.30, 0.02, 0.56), 0.17, 0.30)
    cyl(mats["violet"], "capstan_core", (0.30, 0.02, 0.73), 0.11, 0.05)
    ring_of(lambda i, p: rod(mats["wood"], f"capstan_bar_{i}", (0.30, 0.02, 0.66),
                             (p[0], p[1], 0.66), 0.022, verts=8),
            6, 0.28, (0.30, 0.02, 0.66), axis="x")

    # Barrels stowed forward.
    for i, (x, y) in enumerate(((0.34, -1.05), (-0.30, -1.32))):
        cyl(mats["wood"], f"barrel_{i}", (x, y, 0.58), 0.19, 0.36)
        for j, dz in enumerate((-0.10, 0.10)):
            cyl(mats["brass_dark"], f"barrel_band_{i}_{j}", (x, y, 0.58 + dz), 0.198, 0.05,
                width=0.004)

    # Raised aft deck.
    box(mats["wood"], "stern_castle", (0, 1.94, 0.47), (1.24, 0.95, 0.20))
    box(mats["brass"], "stern_castle_trim", (0, 1.46, 0.58), (1.30, 0.10, 0.09), width=0.005)

    # Bowsprit with the lime spear tip from the reference.
    cyl(mats["wood"], "bowsprit", (0, -3.00, 0.78), 0.055, 1.30, rot=(math.pi / 2 - 0.28, 0, 0))
    for i, y in enumerate((-2.65, -3.15)):
        cyl(mats["brass"], f"bowsprit_band_{i}", (0, y, 0.68 + 0.145 * (i + 1)), 0.068, 0.06,
            rot=(math.pi / 2 - 0.28, 0, 0), width=0.004)
    prim("cone", mats["lime"], "bowsprit_tip", loc=(0, -3.62, 0.96),
         rot=(-math.pi / 2 + 0.28, 0, 0), width=0.004,
         radius1=0.09, radius2=0.0, depth=0.42, vertices=QUALITY["cyl_verts"])

    # Anchor catted against the bow. Hung off the hull surface itself, not a
    # guessed x - at this station the topside is only ~0.6 wide, so a literal
    # coordinate left it floating in mid-air.
    fa, ta = 0.30, 0.74
    n_a, _ = hull_frame(fa, ta, 1)
    base = hull_point(fa, ta, 1) + n_a * 0.055
    up = Vector((0, 0, 1))
    rod(mats["iron"], "anchor_shank", base + up * 0.26, base - up * 0.34, 0.035, verts=12)
    box(mats["iron"], "anchor_stock", base + up * 0.22, (0.06, 0.52, 0.06), width=0.004)
    for side in (-1, 1):
        rod(mats["iron"], f"anchor_arm_{side}", base - up * 0.30,
            base + Vector((0.03, side * 0.24, -0.06)), 0.030, verts=10)
    prim("torus", mats["iron"], "anchor_ring", loc=base + up * 0.32, rot=(0, math.pi / 2, 0),
         width=0.003, major_radius=0.07, minor_radius=0.018,
         major_segments=18, minor_segments=8)

    # Brass rubbing strake along the topsides, riding the hull surface.
    for side in (-1, 1):
        rings = []
        for i in range(29):
            f = 0.06 + 0.90 * (i / 28)
            p = hull_point(f, 0.30, side)
            n, tan = hull_frame(f, 0.30, side)
            rings.append([
                p + tan * 0.06 - n * 0.005,
                p + tan * 0.05 + n * 0.045,
                p - tan * 0.05 + n * 0.045,
                p - tan * 0.06 - n * 0.005,
                p + tan * 0.06 - n * 0.005,
            ])
        loft(f"strake_{'port' if side < 0 else 'stbd'}", rings, mats["brass_dark"], width=0.005,
             uv=(6.0, 0.4))

    # Vertical brass ribs strapping the topsides.
    for side in (-1, 1):
        for i, f in enumerate((0.34, 0.50, 0.66, 0.82)):
            rings = []
            for k in range(9):
                t = 0.18 + 0.74 * (k / 8)
                p = hull_point(f, t, side)
                n, _ = hull_frame(f, t, side)
                rings.append([
                    p + Vector((0, 0.055, 0)) - n * 0.005,
                    p + Vector((0, 0.048, 0)) + n * 0.030,
                    p + Vector((0, -0.048, 0)) + n * 0.030,
                    p + Vector((0, -0.055, 0)) - n * 0.005,
                    p + Vector((0, 0.055, 0)) - n * 0.005,
                ])
            loft(f"rib_{side}_{i}", rings, mats["brass_dark"], width=0.004, uv=(1.0, 0.4))

    # Broadside portholes, glowing lime like the cabin windows.
    for side in (-1, 1):
        for i, f in enumerate((0.42, 0.58, 0.74)):
            w = half_width(f)
            y, z = station_y(f), sheer_z(f) - 0.52
            cyl(mats["brass"], f"port_ring_{side}_{i}", (side * (w + 0.01), y, z), 0.12, 0.06,
                rot=(0, math.pi / 2, 0), verts=18)
            cyl(mats["lime"], f"port_glow_{side}_{i}", (side * (w + 0.045), y, z), 0.082, 0.03,
                rot=(0, math.pi / 2, 0), verts=18)


# ------------------------------------------------------------ bake down + io


def apply_and_merge():
    """Applies every bevel, then joins static parts by material.

    Joining drops the draw calls from one per bolt to one per material. It has
    to happen after the modifiers are applied, because `join` keeps only the
    active object's modifier stack and would silently discard the rest.
    """
    for obj in PARTS:
        if not obj.modifiers:
            continue
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        for mod in list(obj.modifiers):
            bpy.ops.object.modifier_apply(modifier=mod.name)

    groups, kept = {}, []
    for obj in PARTS:
        if obj.name.startswith(KEEP_SEPARATE):
            kept.append(obj)
        else:
            groups.setdefault(obj.data.materials[0].name, []).append(obj)

    merged = []
    for mat_name, objs in groups.items():
        bpy.ops.object.select_all(action="DESELECT")
        for o in objs:
            o.select_set(True)
        bpy.context.view_layer.objects.active = objs[0]
        if len(objs) > 1:
            bpy.ops.object.join()
        objs[0].name = f"{mat_name}_parts"
        merged.append(objs[0])
    return merged + kept


def setup_render():
    scene = bpy.context.scene
    for name in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "CYCLES"):
        try:
            scene.render.engine = name
            break
        except TypeError:
            continue
    scene.render.resolution_x = 1100
    scene.render.resolution_y = 1100
    world = bpy.data.worlds.new("World")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.02, 0.03, 0.06, 1)
    scene.world = world

    bpy.ops.object.light_add(type="SUN", location=(-4, -6, 8))
    key = bpy.context.active_object
    key.data.energy = 4.0
    key.rotation_euler = (0.75, 0.15, -0.55)

    bpy.ops.object.light_add(type="AREA", location=(5, 5, 3))
    fill = bpy.context.active_object
    fill.data.energy = 260
    fill.data.size = 8
    fill.rotation_euler = (1.2, 0.0, 2.4)
    return scene


def render_from(scene, location, look_at, path, lens=42):
    bpy.ops.object.camera_add(location=location)
    cam = bpy.context.active_object
    cam.rotation_euler = (Vector(look_at) - Vector(location)).to_track_quat("-Z", "Y").to_euler()
    cam.data.lens = lens
    scene.camera = cam
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(cam, do_unlink=True)


def main():
    reset_scene()
    mats = build_materials()

    build_hull(mats)
    build_planking(mats)
    build_deck(mats)
    build_rail(mats)
    build_stern(mats)
    build_rig(mats)
    build_deck_fittings(mats)
    print(f"[build_ship] {len(PARTS)} parts authored")

    objects = apply_and_merge()
    print(f"[build_ship] merged to {len(objects)} objects (draw calls)")

    bpy.ops.object.empty_add(type="PLAIN_AXES", location=(0, 0, 0))
    root = bpy.context.active_object
    root.name = "pirateship_beginner"
    for obj in objects:
        obj.parent = root

    # Yaw 180 deg so the glTF (x, z, -y) conversion puts the bow on -Z. See the
    # module docstring; without this the ship exports sailing stern-first.
    root.rotation_euler = (0.0, 0.0, math.pi)
    bpy.context.view_layer.update()

    os.makedirs(ASSETS, exist_ok=True)
    glb = os.path.join(ASSETS, "pirateship_beginner.glb")

    bpy.ops.object.select_all(action="DESELECT")
    root.select_set(True)
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = root

    bpy.ops.export_scene.gltf(
        filepath=glb, export_format="GLB", use_selection=True,
        export_apply=True, export_yup=True,
    )
    print(f"[build_ship] wrote {glb}")

    scene = setup_render()
    render_from(scene, (-3.7, -8.5, 4.6), (0, -0.5, 1.45),
                os.path.join(ASSETS, "pirateship_beginner_preview.png"))
    render_from(scene, (-11.5, 0.0, 2.6), (0, -0.1, 1.7),
                os.path.join(ASSETS, "pirateship_beginner_side.png"))
    render_from(scene, (-1.9, -4.6, 1.6), (0, 1.9, 0.35),
                os.path.join(ASSETS, "pirateship_beginner_detail.png"), lens=60)
    print("[build_ship] wrote previews")


if __name__ == "__main__":
    main()
