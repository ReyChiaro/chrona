"""Ground a shot description in observed geometry, rather than serializing state."""
import colorsys
import math
import re
from collections import Counter

from chrona.rendering.prompting import clean

NAMES = {"pine": ("a pine tree", "pine trees"), "birch": ("a birch tree", "birch trees"),
         "shrub": ("a low shrub", "low shrubs"), "rock": ("a rock", "rocks"),
         "house": ("a village house", "village houses"), "bridge": ("a wooden bridge", "wooden bridges"),
         "dynamic-crate": ("a wooden crate", "wooden crates")}
BIOMES = {"river": "a river valley", "meadow": "open meadowland", "forest": "wooded slopes", "mountain": "mountainous terrain",
          "village": "a rural settlement", "alpine": "high mountain slopes", "highland": "rolling uplands", "valley": "a valley",
          "snowfield": "snow-covered mountain ridges and snowfields", "volcanic": "a volcanic cone with a depressed crater and dark rock slopes", "urban": "an urban district with paved streets and tall buildings",
          "ocean": "a coastal seascape with uninterrupted water and sandy shores", "lake": "a lake meeting its natural shoreline"}


def name(obj, plural=False):
    label, kind = clean(obj.get("label", "")), obj.get("kind", "")
    if kind in NAMES and label in ("", kind, "physical wooden crate"):
        return NAMES[kind][int(plural)]
    return label or "an object visible in the reference"


def region(obj):
    bounds = obj.get("bounds")
    side = ""
    if bounds:
        x = (bounds[0] + bounds[2]) / 2
        side = " on the left" if x < 0.38 else " on the right" if x > 0.62 else " near the center of the frame"
    depth = {"near": "in the foreground", "middle": "in the middle distance", "far": "in the background"}.get(obj.get("band"), "in view")
    return depth + side


def color_name(value):
    try:
        r, g, b = [int(value[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    except (ValueError, TypeError):
        return ""
    h, s, v = colorsys.rgb_to_hsv(r, g, b)
    if v < 0.16: return "near-black"
    if s < 0.15: return "white" if v > 0.85 else "gray"
    hue = h * 360
    if hue < 18 or hue >= 345: return "pink" if v > 0.65 and s < 0.65 else "red"
    if hue < 48: return "brown" if v < 0.72 else "warm amber"
    if hue < 75: return "yellow"
    if hue < 170: return "green"
    if hue < 200: return "cyan"
    if hue < 260: return "blue"
    return "pink" if hue >= 300 else "purple"


def appearance(obj, paused=False):
    data = obj.get("appearance") or {}
    colors = list(dict.fromkeys(filter(None, (color_name(c) for c in data.get("colors", [])))))[:3]
    parts = [f"visible surfaces in {' and '.join(colors)}" ] if colors else []
    roughness = data.get("roughness")
    if isinstance(roughness, (int, float)):
        parts.append("matte, rough surfaces" if roughness > 0.65 else "smooth reflective surfaces" if roughness < 0.3 else "softly textured surfaces")
    if data.get("emissiveColors"):
        parts.append("localized self-emitting surfaces have a gentle glow")
    for material in data.get('materials', [])[:4]:
        look = [clean(material.get('label', ''))]
        if (material.get('metalness') or 0) >= 0.5:
            look.append('metallic surfaces with light-dependent highlights')
        if (material.get('opacity') if material.get('opacity') is not None else 1) < 1:
            look.append('partially transparent surfaces')
        texture = (material.get('texture') or {}).get('pattern')
        pattern = {'wood': 'directional wood grain', 'stone': 'mottled stone texture', 'brick': 'staggered brickwork and mortar joints',
                   'fabric': 'a fine woven fabric texture', 'noise': 'subtle surface variation'}.get(texture)
        if pattern: look.append(pattern)
        if material.get('emissive') and (material.get('emissiveIntensity') if material.get('emissiveIntensity') is not None else 1) > 0:
            look.append('a localized luminous finish')
        if len(look) > 1: parts.append(': '.join(filter(None, [look[0], ', '.join(look[1:])])))
    effect = data.get("effect")
    if obj.get("kind") == "moving-vehicle": parts.append("the road vehicle remains stationary while the world is paused" if paused else "the vehicle drives along the road, independently of the camera")
    if effect == "petals": parts.append("petals hang motionless around it and lie on the ground beneath it" if paused else "petals drift down around it and lie scattered on the ground beneath it")
    if effect == "fireflies": parts.append("small warm fireflies remain still around this object" if paused else "small warm fireflies hover around this object in world space")
    return "; ".join(parts)


def _latest_edits(snapshots):
    latest = {}
    for snapshot in snapshots:
        for event in snapshot.get("edits", []):
            if event.get("revision", 0) >= latest.get(event["objectId"], {}).get("revision", -1):
                latest[event["objectId"]] = event
    return latest


def deleted_ids(snapshots):
    return {key for key, event in _latest_edits(snapshots).items() if event.get("action") == "delete"}


def _motion(snapshots):
    poses = [s["camera"] for s in snapshots if s.get("camera")]
    if len(poses) < 2:
        return "One continuous first-person viewpoint follows the reference camera exactly."
    distance = sum(math.dist([a[k] for k in ("x", "y", "z")], [b[k] for k in ("x", "y", "z")]) for a, b in zip(poses, poses[1:]))
    turns = [(b["yaw"] - a["yaw"] + math.pi) % (2 * math.pi) - math.pi for a, b in zip(poses, poses[1:])]
    tilts = [b["pitch"] - a["pitch"] for a, b in zip(poses, poses[1:])]
    travel = "The first-person camera moves through the scene" if distance > 0.3 else "The first-person camera remains at the same location"
    if sum(abs(t) for t in turns) > 0.12:
        travel += ", turning " + ("left and right" if min(turns) < -0.05 and max(turns) > 0.05 else "left" if sum(turns) > 0 else "right")
    if sum(abs(t) for t in tilts) > 0.12:
        travel += ", tilting " + ("up and down" if min(tilts) < -0.05 and max(tilts) > 0.05 else "upward" if sum(tilts) > 0 else "downward")
    if sum(abs(t) for t in turns + tilts) <= 0.12:
        travel += " with a steady viewing direction"
    dy = poses[-1]["y"] - poses[0]["y"]
    if distance > 0.3 and abs(dy) > 1.5:
        travel += " while rising with the terrain" if dy > 0 else " while descending with the terrain"
    return travel + ". Match its exact path, framing and timing in the reference video."


def describe_shot(snapshots, objects, *, continuity=None, reference_bindings=()):
    env = (snapshots[0].get("environment") or {}) if snapshots else {}
    latest = _latest_edits(snapshots)
    absent = deleted_ids(snapshots)
    objects = [o for o in objects if o["id"] not in absent]
    biomes = Counter(c.get("biome") for s in snapshots for c in s.get("distantChunks", []) if c.get("visible") is True)
    water_level = env.get('waterLevel')
    camera_y = (snapshots[0].get('camera') or {}).get('y') if snapshots else None
    underwater = isinstance(water_level, (int, float)) and isinstance(camera_y, (int, float)) and camera_y < water_level - 0.1
    scenery = [('an underwater landscape above the seabed, beneath the water surface' if underwater and b in ('ocean', 'lake') else BIOMES[b])
               for b, _ in biomes.most_common() if b in BIOMES][:3]
    scene = "A continuous first-person view" + (" through " + ", ".join(scenery) if scenery else " of the landscape shown in the reference video") + "."
    constrained = [o for o in objects if o.get("constraint") or o.get("appearance")]
    constrained.sort(key=lambda o: (not bool(o.get("constraint")), o.get("distance", 0)))
    subjects, bindings = [], []
    supplied = {b["objectId"] for b in reference_bindings}
    for obj in constrained[:4]:
        text = f"{name(obj)} {region(obj)}."
        constraint = obj.get("constraint") or {}
        if constraint.get("text"):
            # IDs are retained in bindings, never offered to the video encoder as visual tokens.
            description = constraint["text"].replace(obj["id"], name(obj))
            description = re.sub(r"[a-f0-9]{64}", "the local reference", description)
            text += " " + clean(description)
        look = appearance(obj, env.get("paused", False))
        if look: text += " " + look + "."
        if obj["id"] in supplied:
            text += " Match the appearance hint at this location in the supplied first image; keep it local to this subject."
        subjects.append(text)
        bindings.append({"objectId": obj["id"], "description": text, "bounds": obj.get("bounds"), "referenceIds": constraint.get("referenceIds", [])})
    grouped = {}
    focal_ids = {b["objectId"] for b in bindings}
    for obj in objects:
        if obj["id"] not in focal_ids:
            grouped.setdefault((obj.get("kind"), obj.get("label"), obj["band"]), []).append(obj)
    # Group common vegetation; do not count budget-limited samples as the whole forest.
    background = [f"{name(group[0], len(group) > 1)} {region(group[0])}" for group in list(grouped.values())[:4]]
    if background: scene += " Visible surroundings include " + "; ".join(background) + "."
    changes = []
    for event in list(latest.values())[-12:]:
        if event.get("action") != "delete": continue
        camera = snapshots[0].get("camera") if snapshots else None
        point = event.get("position")
        if camera and point:
            forward = -(point['x'] - camera['x']) * math.sin(camera['yaw']) - (point['z'] - camera['z']) * math.cos(camera['yaw'])
            if forward < -1: continue
        subject = event.get("subject")
        label = name(subject) if subject else "the removed object"
        changes.append(f"The former location of {label} is now clear, showing the exposed background visible in the reference. Keep this space empty throughout this shot.")
    hour = env.get("hour")
    lighting = ""
    if isinstance(hour, (float, int)):
        lighting = ("Nighttime, with a dark blue sky and subdued ambient light." if hour < 5 or hour >= 20 else
                    "Low morning sunlight with long soft shadows." if hour < 9 else
                    "Daylight with natural illumination and stable ground shadows." if hour < 17 else
                    "Low evening sunlight with warm highlights and long shadows.")
    weather = {w.get("kind") for s in snapshots for w in s.get("weather", [])}
    effects = []
    if "snow" in weather: effects.append("Snowflakes hang motionless in the air." if env.get("paused") else "Snowflakes fall across the visible landscape.")
    if "fireflies" in weather: effects.append("Fireflies remain still above the terrain." if env.get("paused") else "Fireflies hover above the terrain.")
    if env.get("paused"): effects.insert(0, "World animation is frozen; particles and physical objects remain still.")
    lighting = " ".join([*effects, lighting]).strip()
    continuity = continuity or {}
    mode = continuity.get("mode")
    match = ""
    if mode in ("previous-generated-frame", "spatial-memory"):
        match = "The supplied first image establishes the same material colors, texture detail and lighting for this continuous view."
    elif mode == "edited-world-proxy":
        match = "This shot starts with the updated scene in the reference; keep its new appearance throughout."
    return {"scene": scene, "subjects": subjects, "changes": changes, "motion": _motion(snapshots),
            "lighting": lighting, "continuity": match, "bindings": bindings}
