import {
  BLOCK_TYPES, type AeroSpec, type BlockTypeDef, type ExhaustSpec, type LightColor, type LightPattern, type LightSpec, type RepairSpec,
  type ShieldSpec, type SupportSpec, type ThrusterSpec, type TurretSpec,
} from "../../src/shared/catalog/blocks";
import {
  MELEE_WEAPONS, MOTOR_EFFICIENCY, type BiteSpec, type DriveSpec, type FieldSpec, type FlailSpec, type JawSpec, type LocalStun,
  type MeleeAxis, type MeleeHit, type MeleeSpec, type PlateSpec, type SpinSpec, type SweptRing, type SwingSpec, type ThrustSpec,
} from "../../src/shared/catalog/melee";
import { CAR_HALF, PROP_TYPES, type PropTypeDef } from "../../src/shared/catalog/props";
import { SHAPE_IDS, shapeFraction, shapePieces, shapeSwaps, type ShapeId } from "../../src/shared/catalog/shapes";
import {
  DAMAGE_TYPES, RESUME_HEAT, WEAPONS, type BarrierSpec, type DamageType, type EmpPulse, type Explosion, type ExplosionLook,
  type GroundFireSpec, type Guidance, type Handling, type MineSpec, type ProjectileSpec, type RepairShot, type SmokeSpec, type Weapon,
} from "../../src/shared/catalog/weapons";
import { WHEEL_TYPES, wheelKind, type CasterDef, type SteeringDef, type SuspensionDef, type WheelKind, type WheelTypeDef } from "../../src/shared/catalog/wheels";
import { BLOCK_SIZE, GENERATOR_POWER, GRAVITY, PLATE_THICKNESS } from "../../src/shared/config";
import { designCost, ROBOT_BUDGET } from "../../src/shared/design/budget";
import { designMass } from "../../src/shared/design/flight";
import { PRESET_BOTS, type Behavior, type BotProfile, type Mobility } from "../../src/shared/design/presets";
import { BLOCK_PRICES, WHEEL_PRICES } from "../../src/shared/design/progression";
import { bots as enBots } from "../../src/client/i18n/locales/en/bots";
import { catalog as enCatalog } from "../../src/client/i18n/locales/en/catalog";
import { bots as frBots } from "../../src/client/i18n/locales/fr/bots";
import { catalog as frCatalog } from "../../src/client/i18n/locales/fr/catalog";
import { robotSchema, type Schema } from "./schemas";

/*
 * Le catalogue du jeu en données ouvertes : content/catalog.json (blocs, formes, roues, armes et
 * leurs projectiles, armes de contact, accessoires, robots prédéfinis, avec leurs noms en français
 * et en anglais) et son schéma JSON, content/catalog.schema.json, aux descriptions en anglais. Ce
 * que liront d'autres outils (un éditeur, un wiki, une simulation compilée). Les catalogues
 * TypeScript restent la source : `npm run schemas` (tools/schemas/build.ts) réécrit ces fichiers
 * d'après eux, et tests/schemas.test.ts refuse des fichiers qui ne sont plus à jour ;
 * tests/content.test.ts vérifie que le catalogue suit son schéma, champ par champ.
 *
 * Le schéma suit les types du code : chaque objet est décrit par `fields<T>()`, que TypeScript
 * oblige à donner chaque champ du type `T` (et pas un de plus), facultatif (`may`) ou non (`need`)
 * comme dans le type. Un champ ajouté à un catalogue ne se publie donc pas sans sa description.
 */

const BASE = "https://raw.githubusercontent.com/Wasabules/casse-robot/main/content/";
export const CATALOG_SCHEMA_ID = `${BASE}catalog.schema.json`;
/** Version du format du catalogue : un changement qui casse ce que lisent les outils la fait monter. */
export const CATALOG_FORMAT = 1;

// --- Écrire le schéma d'après les types ---

interface Field<Optional extends boolean> {
  readonly schema: Schema;
  readonly optional: Optional;
}
const need = (schema: Schema): Field<false> => ({ schema, optional: false });
const may = (schema: Schema): Field<true> => ({ schema, optional: true });
/** Chaque champ de `T`, facultatif ou non comme dans le type. */
type Fields<T> = { readonly [K in keyof T]-?: Field<{} extends Pick<T, K> ? true : false> };

/** Un objet décrit champ par champ (les champs inconnus sont permis : un outil peut en ajouter). */
function fields<T>(description: string, f: Fields<T>, extra: Record<string, Field<boolean>> = {}): Schema {
  const all: Record<string, Field<boolean>> = { ...extra, ...(f as Record<string, Field<boolean>>) };
  const required = Object.keys(all).filter((k) => !all[k].optional);
  return {
    description,
    type: "object",
    properties: Object.fromEntries(Object.entries(all).map(([k, v]) => [k, v.schema])),
    ...(required.length ? { required } : {}),
  };
}

/** Les valeurs d'une union de textes, toutes (TypeScript refuse un oubli ou une valeur en trop). */
const all = <U extends string>(values: Record<U, 0>): U[] => Object.keys(values) as U[];

const ref = (name: string, description?: string): Schema => (description ? { description, $ref: `#/$defs/${name}` } : { $ref: `#/$defs/${name}` });
const num = (description: string): Schema => ({ description, type: "number" });
const pos = (description: string): Schema => ({ description, type: "number", minimum: 0 });
const share = (description: string): Schema => ({ description, type: "number", minimum: 0, maximum: 1 });
const int = (description: string): Schema => ({ description, type: "integer", minimum: 0 });
const bool = (description: string): Schema => ({ description, type: "boolean" });
const str = (description: string): Schema => ({ description, type: "string" });
const choice = (values: readonly (string | number)[], description: string): Schema => ({ description, enum: [...values] });
const vec = (n: number, description: string, items: Schema = { type: "number" }): Schema => ({ description, type: "array", minItems: n, maxItems: n, items });
/** Un catalogue : un objet dont les clés sont les identifiants, chaque valeur une entrée. */
const byId = (ids: readonly string[], entry: string, description: string): Schema => ({
  description, type: "object", propertyNames: { enum: [...ids] }, additionalProperties: ref(entry),
});

// --- Les listes de valeurs (exhaustives sur les types du code) ---

const BLOCK_IDS = Object.keys(BLOCK_TYPES);
const WHEEL_IDS = Object.keys(WHEEL_TYPES);
const WEAPON_IDS = Object.keys(WEAPONS);
const MELEE_IDS = Object.keys(MELEE_WEAPONS);
const PROP_IDS = Object.keys(PROP_TYPES);
const ROBOT_IDS = PRESET_BOTS.map((b) => b.id);
const EXPLOSION_LOOKS = all<ExplosionLook>({ shell: 0, missile: 0, rocket: 0, flak: 0, mine: 0, bomb: 0, napalm: 0, warhead: 0, barrel: 0, gas: 0, car: 0 });
const PROJECTILE_LOOKS = all<ProjectileSpec["look"]>({
  bullet: 0, pellet: 0, shell: 0, missile: 0, rocket: 0, warhead: 0, mine: 0, bomb: 0, flame: 0, plasma: 0, orb: 0, grenade: 0, beam: 0, rail: 0,
  repair: 0, flare: 0, nanites: 0, barrier: 0,
});
const LIGHT_COLORS = all<LightColor>({ warm: 0, white: 0, red: 0, amber: 0, blue: 0, team: 0, side: 0, police: 0 });
const LIGHT_PATTERNS = all<LightPattern>({ steady: 0, pulse: 0, beacon: 0, strobe: 0, wigwag: 0, rotate: 0 });
const MELEE_LOOKS = all<MeleeSpec["look"]>({
  bar: 0, hammer: 0, saber: 0, whip: 0, lance: 0, field: 0, disc: 0, drum: 0, shell: 0, propeller: 0, saw: 0, drill: 0, plate: 0, flail: 0, jaw: 0,
});
const MELEE_MOTIONS = all<MeleeSpec["motion"]>({ spin: 0, driven: 0, swing: 0, thrust: 0, field: 0, flip: 0, flail: 0, grip: 0 });
const MELEE_AXES = all<MeleeAxis>({ up: 0, left: 0, forward: 0 });
const WHEEL_KINDS = all<WheelKind>({ fixed: 0, steered: 0, caster: 0, track: 0 });
const BEHAVIORS = all<Behavior>({ flee: 0, charge: 0 });
const MOBILITIES = all<Mobility>({ ground: 0, hover: 0, plane: 0 });
const BLOCK_SHAPES = ["cube", "plate", ...all<ShapeId>({ wedge: 0, corner: 0, innerCorner: 0, round: 0, roundCorner: 0, slopeLow: 0, slopeHigh: 0, slab: 0 })];

// --- Le schéma ---

/**
 * Où va une définition : dans le catalogue (content/catalog.json, chaque entrée avec ses noms et ce
 * qui s'en déduit), ou dans le fichier d'un élément (content/<famille>/<id>.json, que lit le jeu).
 */
type Target = "catalog" | "file";

/** Les champs d'un fichier d'élément qui ne sont pas des données : le jeu les ignore (catalog/content.ts). */
const FILE_NOTES = {
  $schema: may(str("The schema of this file's family (content/schemas/<family>.schema.json), relative to the file, for the editor of whoever "
    + "edits it. The game ignores it, like every field whose name starts with `$`.")),
  $comment: may(str("A note for whoever edits this file (why the values are what they are). The game ignores it.")),
};

/** Les définitions partagées du schéma du catalogue, ou de ceux des fichiers des éléments. */
function contentDefs(target: Target): Record<string, Schema> {
  /**
   * Ce qu'une entrée ajoute aux champs de sa définition : dans le catalogue, ses noms (les catalogues
   * de messages du client) et ce qui s'en déduit ; dans son fichier, `$schema`, `$comment` et les
   * données de l'élément qui ne sont pas dans sa définition (le prix d'une pièce).
   */
  const extra = (catalog: Record<string, Field<boolean>>, file: Record<string, Field<boolean>> = {}): Record<string, Field<boolean>> =>
    target === "catalog" ? catalog : { ...FILE_NOTES, ...file };
  const price = need(int("Unlock price (credits); 0: available from the start."));
  const robot = robotSchema();
  const props = robot.properties as Record<string, Schema>;
  return {
    names: {
      description: "The display name in each language (the game's message catalogs, src/client/i18n/locales/<language>/).",
      type: "object",
      properties: { fr: str("In French (the source language)."), en: str("In English.") },
      required: ["fr", "en"],
    },
    damageType: choice(DAMAGE_TYPES, "A kind of damage: kinetic (bullets), pierce (armor-piercing), explosive, impact (collisions, hammers), "
      + "fire, energy (lasers: heavy armor doesn't stop it better), cut (blades)."),
    resistances: {
      description: "Damage factor per kind of damage (1 when absent; below 1 it resists, above 1 it is sensitive).",
      type: "object",
      propertyNames: { enum: [...DAMAGE_TYPES] },
      additionalProperties: pos("Factor applied to the damage of this kind."),
    },
    groundFire: fields<GroundFireSpec>("A puddle of fire on the ground: it burns what stands in it (fire damage, and it may set it ablaze) and sets wood alight.", {
      radius: need(pos("Radius (m).")),
      life: need(pos("How long it burns (s).")),
    }),
    explosion: fields<Explosion>("An explosion: area damage decreasing linearly to its edge, and a blast that pushes bodies.", {
      look: need(choice(EXPLOSION_LOOKS, "Its look (effect and sound in the client).")),
      radius: need(pos("Radius of the damage area (m).")),
      damage: need(pos("Damage at the center, decreasing to 0 at the edge (explosive damage).")),
      blastRadius: need(pos("Radius of the blast (m).")),
      power: need(pos("Impulse of the blast at the center (N·s per block hit).")),
      lift: need(num("Vertical component added to the blast's direction.")),
      ignite: may(share("Chance to set fire to each block left whole in the damage area.")),
      puddle: may(ref("groundFire", "A puddle of fire left on the ground (napalm).")),
    }),
    // Blocs
    thruster: fields<ThrusterSpec>("An engine: it pushes toward the top of its block (up: lift; forward: propulsion; sideways: a tail rotor).", {
      maxThrust: need(pos("Maximum thrust (N).")),
      spoolTime: need(pos("Response time (s): the thrust follows the setting with this lag.")),
      torqueRatio: need(num("Reaction torque of the propeller per newton of thrust (N·m/N): on a multirotor they cancel out.")),
      power: need(pos("Electric power drawn at full thrust (kW), from the batteries.")),
      gimbal: may(pos("Tilt rotor: the thrust can tilt up to this angle (rad) on each side of the block's axis.")),
      look: may(choice(["rotor", "propeller", "jet"], "Its look and sound: rotor blades, an airplane propeller in front of its block, a turbojet nacelle; a flame when absent.")),
      topSpeed: may(pos("Propeller: its thrust falls as the air comes along its axis, down to 0 at this speed (m/s).")),
      exhaust: may(ref("exhaust", "Flame jet of a flame engine: what is behind its nozzle heats up.")),
    }),
    exhaust: fields<ExhaustSpec>("The flame jet of an engine: its length follows the engine's speed (a quarter of `reach` at idle); fire damage, strongest at the nozzle.", {
      nozzle: need(pos("Distance from the block's center to the end of the nozzle (m).")),
      reach: need(pos("Length of the jet at full speed, beyond the nozzle (m).")),
      dps: need(pos("Damage per second (before resistance) at the nozzle, at full speed.")),
      radius: need(pos("Radius of the jet at the nozzle (m).")),
      flare: need(pos("What the radius gains per meter (m/m).")),
      afterburner: may(share("Engine speed (share of the maximum thrust) beyond which the afterburner lengthens the jet by half and makes it a third hotter.")),
    }),
    aero: fields<AeroSpec>("A lifting surface (a flat plate one cell wide): lift = ½·ρ·V²·area·CL(α), CL = slope·α up to the stall.", {
      area: need(pos("Area (m²).")),
      liftSlope: need(pos("Lift slope (per rad).")),
      stallAngle: need(pos("Stall angle of attack (rad).")),
      dragMin: need(pos("Drag coefficient at zero lift.")),
      inducedDrag: need(pos("Induced drag: CD = dragMin + inducedDrag·CL².")),
      maxDeflection: may(pos("Maximum deflection (rad) of a control surface.")),
    }),
    turret: fields<TurretSpec>("A turret: a head that turns independently of the robot (yaw around the block's top, pitch above its horizon) and carries a weapon.", {
      weapon: need(choice(WEAPON_IDS, "The weapon it carries (`weapons`).")),
      yawRate: need(pos("Yaw speed (rad/s).")),
      pitchRate: need(pos("Pitch speed (rad/s).")),
      minPitch: need(num("Lowest pitch (rad), relative to the block's plane.")),
      maxPitch: need(num("Highest pitch (rad).")),
      height: need(num("Height of the head's axis above the block's center (m; negative: the head hangs below).")),
      barrel: need(pos("Length of the barrel from the head's axis to the muzzle (m).")),
      head: need(vec(3, "Dimensions of the head (m: width, height, depth), centered on its axis: its hitbox.")),
      caliber: need(pos("Diameter of the barrel (m): the hitbox of the barrel.")),
      fixed: may(choice(["back", "down"], "A fixed turret: it drops its ammunition behind the block (mine layer) or under it (bomb bay), without aiming.")),
    }),
    support: fields<SupportSpec>("A support without a wheel: a hover pad (it glides, it draws power) or a leg (it grips, it steps over obstacles).", {
      kind: need(choice(["hover", "leg"], "Hover pad or leg.")),
      height: need(pos("Height kept above the ground (m).")),
      reach: need(pos("How far down it measures the ground (m).")),
      ratedLoad: need(pos("Rated load (kg), for which its spring is tuned.")),
      frequency: need(pos("Natural frequency of its spring (Hz).")),
      dampingRatio: need(pos("Damping ratio (1: critical).")),
      traction: need(pos("Grip: maximum horizontal force, as a share of the bearing force.")),
      power: need(pos("Power drawn under the rated load (kW).")),
    }),
    repair: fields<RepairSpec>("A repair module: when the robot hasn't been hit for `delay` s, it mends its damaged blocks and wheels nearby, and regrows lost blocks.", {
      rate: need(pos("Hit points restored per second, in all.")),
      radius: need(pos("Reach (m).")),
      delay: need(pos("Time without being hit before it works (s).")),
    }),
    shield: fields<ShieldSpec>("A shield generator: while the robot has energy, it absorbs a share of the damage taken by its blocks nearby.", {
      radius: need(pos("Reach (m).")),
      absorb: need(share("Share of the damage absorbed.")),
      cost: need(pos("Energy per point absorbed (kJ).")),
    }),
    light: fields<LightSpec>("A light (headlight, beacon, aircraft lights): no effect in the simulation; at night it lights the scene.", {
      kind: need(choice(["spot", "point", "sweep"], "A cone along the top of the block, all around, or a cone that turns around the top of the block (a rotating light).")),
      range: need(pos("How far it reaches (m).")),
      cone: may(pos("Full angle of the cone (rad).")),
      color: need(choice(LIGHT_COLORS, "Its color: warm, white, red, amber, blue; team: its team's; side: red on the robot's left, green on its right, white in the middle; police: blue and red.")),
      pattern: need(choice(LIGHT_PATTERNS, "Its rhythm: steady, a slow pulse, short flashes, a double flash, alternating, rotating.")),
    }),
    blockType: fields<BlockTypeDef>(
      "A block type: a 0.5 m cell of a robot (or a thinner plate, or a shape cut out of the cube). A block is destroyed when its hit points reach 0.",
      {
        mass: need(pos("Mass (kg).")),
        hp: need(pos("Hit points.")),
        tinted: need(bool("It takes the robot's color.")),
        cost: need(pos("Build cost: a robot's blocks and wheels must stay within the budget (`constants.robotBudget`).")),
        bond: need(pos("Strength of its links with its neighbors (N·m·s): the shock a single link (a neck, a one-block-wide arm) withstands before it breaks; a link is as strong as the weaker of its two blocks.")),
        resist: may(ref("resistances", "Damage factor per kind of damage.")),
        shape: may(choice(BLOCK_SHAPES, "Its shape: a full cube (the default), a thin plate perpendicular to the block's top (wings), or a shape cut out of the cube (`shapes`).")),
        thruster: may(ref("thruster")),
        aero: may(ref("aero")),
        turret: may(ref("turret")),
        battery: may(fields<NonNullable<BlockTypeDef["battery"]>>("A battery.", { capacity: need(pos("Energy stored (kJ), for the engines, the electric weapons, the shield…")) })),
        repair: may(ref("repair")),
        shield: may(ref("shield")),
        radar: may(fields<NonNullable<BlockTypeDef["radar"]>>("A radar: its team spots enemies within its range, through walls and smoke.", { range: need(pos("Range (m).")) })),
        jammer: may(fields<NonNullable<BlockTypeDef["jammer"]>>("A jammer: an enemy radar no longer spots the robot beyond this range.", { range: need(pos("Range (m).")) })),
        flares: may(fields<NonNullable<BlockTypeDef["flares"]>>("A flare launcher: salvos of flares that decoy enemy missiles.", {
          charges: need(int("Salvos.")),
          reload: need(pos("Each salvo comes back after this time (s).")),
        })),
        light: may(ref("light")),
        support: may(ref("support")),
        melee: may(choice(MELEE_IDS, "The melee weapon whose motor and hub it is (`melee`).")),
      },
      extra({ names: need(ref("names")), price }, { price }),
    ),
    shape: {
      description: "A block shape other than the cube, in the block's frame (left +x, up +y, forward +z), in a cube of half-side 1 (scale by half a block, "
        + `${BLOCK_SIZE / 2} m): the intersection of the cube and half-spaces, one or two convex pieces. Its underside is always full; its slope faces up and forward.`,
      type: "object",
      properties: {
        fraction: share("Share of the cube it fills: the mass, hit points and cost of its blocks follow from it."),
        swapsLeftAndFront: bool("Its mirror image swaps its left and its front (the corners); otherwise it is symmetrical from left to right."),
        pieces: {
          description: "Its convex pieces (the physics takes the convex hull of each).",
          type: "array",
          minItems: 1,
          items: {
            description: "A convex piece: its faces.",
            type: "object",
            properties: {
              faces: {
                description: "Its faces.",
                type: "array",
                items: {
                  description: "A face: its outward normal and its outline (counter-clockwise seen from outside).",
                  type: "object",
                  properties: { normal: vec(3, "Outward unit normal."), points: { description: "Its corners, [x, y, z] each.", type: "array", items: vec(3, "A corner.") } },
                  required: ["normal", "points"],
                },
              },
            },
            required: ["faces"],
          },
        },
      },
      required: ["fraction", "swapsLeftAndFront", "pieces"],
    },
    // Roues
    suspension: fields<SuspensionDef>("A suspension: a vertical spring and damper between the chassis and the wheel.", {
      travelUp: need(pos("Travel in compression (m).")),
      travelDown: need(pos("Travel in extension (m).")),
      frequency: need(pos("Natural frequency under the rated load (Hz): it sets the spring's stiffness.")),
      dampingRatio: need(pos("Damping ratio (1: critical, no bounce).")),
    }),
    wheelType: fields<WheelTypeDef>(
      "A wheel type: the motor is in the wheel (torque falls linearly from `stallTorque` at rest to 0 at `freeSpeed`).",
      {
        cost: need(pos("Build cost.")),
        radius: need(pos("Radius (m).")),
        width: need(pos("Width (m).")),
        mass: need(pos("Mass of the wheel and its motor (kg).")),
        hp: need(pos("Hit points: at 0 the wheel is torn off.")),
        grip: need(pos("Grip (the tire's friction coefficient).")),
        stallTorque: need(pos("Maximum torque at rest (N·m); 0: no motor (a caster).")),
        freeSpeed: need(pos("Free-running speed of the motor (rad/s).")),
        ratedLoad: need(pos("Rated load per wheel (kg): the suspension is tuned for it, and sags beyond.")),
        suspension: need(ref("suspension")),
        steering: may(fields<SteeringDef>("A steered wheel: it pivots around a vertical axis through its center.", {
          maxAngle: need(pos("Maximum steering angle on each side (rad).")),
          rate: need(pos("Steering speed (rad/s).")),
        })),
        caster: may(fields<CasterDef>("A caster: a free wheel that swivels to follow the motion.", { trail: need(pos("Trail (m): how far the pivot is ahead of the wheel.")) })),
        track: may(bool("A track roller: the neighboring rollers of a side form a track.")),
        drop: may(pos("The hub hangs this far below its block's center (m): ground clearance.")),
      },
      extra({ names: need(ref("names")), price, kind: need(choice(WHEEL_KINDS, "Fixed, steered, caster or track roller.")) }, { price }),
    ),
    // Armes
    guidance: fields<Guidance>("A missile's guidance: `command`, it follows its launcher's aim; `homing`, it chases its target on its own; `piloted`, the player who fired it flies it.", {
      mode: need(choice(["command", "homing", "piloted"], "Guidance mode.")),
      turnRate: need(pos("Maximum turn rate (rad/s).")),
      airOnly: may(bool("It only targets flying robots (anti-air).")),
      launch: may(pos("It first flies straight along the weapon's axis for this time (s), then its guidance takes over.")),
      maxAccel: may(pos("Momentum: it doesn't turn tighter than this lateral acceleration (m/s²).")),
      bleed: may(pos("Share of its speed lost per radian of turn.")),
      recover: may(pos("Rate at which its motor gives the speed back (1/s).")),
    }),
    mine: fields<MineSpec>("A mine: it lands where it falls, arms after `armDelay` s, then waits for what triggers it.", {
      armDelay: need(pos("Time before it arms (s).")),
      trigger: need(choice(["ground", "air", "remote", "none"], "An enemy on the ground within `radius`, an enemy in flight within `radius`, its layer's order, or nothing (a sensor).")),
      radius: need(pos("Trigger radius (m).")),
      action: may({
        description: "What it does when triggered, instead of bursting on the spot.",
        anyOf: [
          fields<Extract<NonNullable<MineSpec["action"]>, { kind: "bounce" }>>("It jumps and bursts in the air.", {
            kind: need({ const: "bounce" }), height: need(pos("Height of the jump (m).")),
          }),
          fields<Extract<NonNullable<MineSpec["action"]>, { kind: "launch" }>>("It launches a projectile of another weapon at its target.", {
            kind: need({ const: "launch" }), weapon: need(choice(WEAPON_IDS, "The weapon whose projectile it launches.")),
          }),
          fields<Extract<NonNullable<MineSpec["action"]>, { kind: "stick" }>>("It sticks to its target and bursts later.", {
            kind: need({ const: "stick" }), fuse: need(pos("Delay before it bursts (s).")),
          }),
        ],
      }),
      sense: may(pos("A sensor: its team spots enemies within this radius (m), through everything.")),
    }),
    projectile: fields<ProjectileSpec>("What a shot launches: it flies with its speed and gravity, may be guided, pierces or explodes on impact.", {
      look: need(choice(PROJECTILE_LOOKS, "Its look in the client.")),
      speed: need(pos("Muzzle speed (m/s).")),
      gravity: need(num("Share of gravity it undergoes: 0, a straight line (a propelled missile); 1, ballistic.")),
      life: need(pos("Maximum flight time (s); an explosive projectile explodes at the end of its course.")),
      damage: need(pos("Damage on a direct hit.")),
      damageType: need(ref("damageType", "The kind of that damage.")),
      penetrating: need(bool("If it destroys what it hits, it goes on with the damage it has left.")),
      impulse: need(pos("Impulse given to what it hits (N·s).")),
      explosion: may(ref("explosion")),
      guidance: may(ref("guidance")),
      proximity: may(pos("Proximity fuse: it explodes when a target passes within this radius (m).")),
      mine: may(ref("mine")),
      hull: may(fields<NonNullable<ProjectileSpec["hull"]>>("It can be shot down: a sphere that bullets and explosions hit.", {
        radius: need(pos("Radius (m).")),
        hp: need(pos("Hit points.")),
      })),
      decoy: may(bool("A flare: enemy missiles that see it may follow it.")),
      repair: may(fields<RepairShot>("A repair shot: on an ally, the blocks and wheels near the impact regain hit points; on an enemy, it drains life.", {
        amount: need(pos("Hit points regained by each block and wheel.")),
        radius: need(pos("Radius (m).")),
        drain: may(pos("Energy damage to the enemy block hit.")),
        steal: may(share("Share of what the enemy really lost that repairs the shooter.")),
        swarm: may(int("Nanites: they spread over the whole robot and mend its this-many most damaged blocks.")),
      })),
      barrier: may(fields<BarrierSpec>("An energy wall: it flies `reach` m then unfolds into a vertical rectangle that stops enemy shots.", {
        width: need(pos("Width (m).")),
        height: need(pos("Height (m).")),
        hp: need(pos("Hit points.")),
        life: need(pos("Lifetime (s).")),
        reach: need(pos("Distance before it unfolds (m).")),
      })),
      ignite: may(share("Chance to set fire to the block hit.")),
      puddle: may(fields<NonNullable<ProjectileSpec["puddle"]>>("A flame jet that touches the ground or the scenery may leave a puddle of fire.", {
        radius: need(pos("Radius (m).")),
        life: need(pos("How long it burns (s).")),
        chance: need(share("Chance to leave one.")),
      })),
      emp: may(fields<EmpPulse>("An electromagnetic pulse on impact: engines, rotors and turrets nearby cut out.", {
        radius: need(pos("Radius (m).")),
        duration: need(pos("Stun at the center (s); half as long at the edge.")),
      })),
      smoke: may(fields<SmokeSpec>("A smoke cloud on impact (or at the end of its course): it hides what is behind it.", {
        radius: need(pos("Final radius (m).")),
        duration: need(pos("Time before it clears (s).")),
      })),
      pellets: may(fields<NonNullable<ProjectileSpec["pellets"]>>("A spread (shotgun): each shot launches several pellets.", {
        count: need(int("Pellets per shot.")),
        spread: need(pos("Maximum deviation of each pellet (rad).")),
      })),
      fan: may(pos("A fan (rocket salvo): each projectile leaves up to this angle (rad) off the aim, then its guidance brings it back.")),
    }),
    weapon: fields<Weapon>(
      "A weapon, carried by a turret block. Every shot launches a projectile.",
      {
        cooldown: need(pos("Minimum time between two shots (s).")),
        automatic: need(bool("It fires as long as the trigger is held.")),
        spread: need(pos("Dispersion with the scope, robot still (rad): its best accuracy.")),
        handling: need(fields<Handling>("What degrades its accuracy.", {
          hip: need(pos("Factor on the dispersion without the scope.")),
          move: need(pos("Added dispersion per m/s of the robot's speed (rad).")),
          turn: need(pos("Added dispersion per rad/s of the robot's rotation (rad).")),
        })),
        recoil: need(pos("Impulse sent back on the robot that fires (N·s).")),
        range: need(pos("Useful range (m): the AI engages closer targets.")),
        engage: may(pos("Distance at which the AI likes to fight with it (m).")),
        heat: may(fields<NonNullable<Weapon["heat"]>>("Overheating: each shot heats it; overheated, it waits until it cools down to `constants.resumeHeat`.", {
          perShot: need(share("Heat per shot (1: overheat).")),
          cooling: need(pos("Cooling per second.")),
        })),
        ammo: may(fields<NonNullable<Weapon["ammo"]>>("A magazine that regains one round at a time.", {
          capacity: need(int("Rounds.")),
          reload: need({ description: "Time to regain one round (s); null: it never reloads (one shot per life).", type: ["number", "null"], minimum: 0 }),
        })),
        minRange: may(pos("The AI doesn't fire at a closer target (m): the explosion would hit itself.")),
        scopeOnly: may(bool("The player can only fire it with the scope.")),
        power: may(pos("An electric weapon: each shot takes this much energy from the batteries (kJ).")),
        lock: may(fields<NonNullable<Weapon["lock"]>>("Lock-on: an enemy must stay in a cone around the aim before the weapon can fire; its missiles then chase it.", {
          time: need(pos("Time to lock (s).")),
          cone: need(pos("Half angle of the cone (rad).")),
        })),
        dropped: may(bool("Dropped (bombs): released under the robot without aiming.")),
        autoSupport: may(bool("Automatic support weapon: its turrets pick the ally to heal and fire on their own.")),
        projectile: need(ref("projectile")),
      },
      extra({ names: need(ref("names")) }),
    ),
    // Armes de contact
    blade: fields<SweptRing>("The volume a rotor's blade sweeps: a thick ring around its axis.", {
      inner: need(pos("Inner radius (m); 0 for a bar or a disc.")),
      outer: need(pos("Outer radius (m).")),
      half: need(pos("Half thickness along the axis (m). Longer than `outer`: a drill bit, its hub in the middle of its length.")),
      arms: may(fields<NonNullable<SweptRing["arms"]>>("The blade's arms (a bar: two; a propeller: three): its hitbox turns with them.", {
        count: need(int("Arms.")),
        width: need(pos("Width of each arm (m).")),
      })),
      web: may(fields<NonNullable<SweptRing["web"]>>("The web joining a ring to its hub (a shell spinner's spokes): a disc of radius `outer`, that doesn't strike.", {
        at: need(num("Center along the axis from the hub (m).")),
        half: need(pos("Half thickness (m).")),
      })),
    }),
    spin: fields<SpinSpec>("A rotor: its inertia and full speed give its stored energy (½·I·ω²) and its angular momentum.", {
      inertia: need(pos("Moment of inertia (kg·m²).")),
      speed: need(pos("Full speed (rad/s).")),
      spinUp: need(pos("Time from rest to full speed at full motor power (s): the motor's power follows from it.")),
      spinDown: need(pos("Free spin: the speed loses two thirds (1/e) in this time (s); holding full speed costs these losses.")),
      gyro: need(pos("Factor of the gyroscopic effect on the robot (1: physical; 0: none).")),
      unbalance: need(pos("Imbalance: offset (m) of the spinning mass of a rotor at 0 hit points.")),
      mass: need(pos("Spinning mass (kg), for the imbalance (included in the block's mass).")),
      direction: may(choice([1, -1], "Direction of rotation around the axis (1: counter-clockwise seen from the end of the axis).")),
      reaction: may(share("Share of its motor's reaction the robot receives (1: physical; 0: nothing really spins, an energy blade).")),
    }),
    meleeHit: fields<MeleeHit>("What a hit does.", {
      damageType: need(ref("damageType")),
      damage: need(pos("Damage per kJ of the hit (before resistance).")),
      bite: need(share("Share of a rotor's stored energy a clean hit takes.")),
      fling: need(share("Share of the hit's energy that throws the target (the rest tears it).")),
      push: need(fields<MeleeHit["push"]>("Direction of the impulse at the point hit.", {
        tangent: need(num("Along the blade's motion.")),
        radial: need(num("Outward from the hub.")),
        axial: need(num("Along the axis.")),
        lift: need(num("Toward the world's up.")),
      })),
      recoil: need(share("Share of the impulse sent back to its own robot, at the hub.")),
      spread: need(share("Share of the damage the neighboring blocks receive.")),
      wheels: may(pos("Damage factor on wheels and track rollers.")),
      wear: need(pos("Wear: hit points the weapon loses per kJ of hit, divided by the resistance of what it hits.")),
      gap: need(pos("Minimum time between two hits (s).")),
      minSpeed: need(pos("Speed below which a rotor no longer bites (share of full speed); for a flail, the speed of the ball (m/s) below which it only pushes.")),
      ground: may(pos("Share of a clean hit a rotor's hit on the ground takes (0.4 when absent).")),
      ignite: may(share("Chance to set fire to the block hit.")),
      stun: may(fields<LocalStun>("A local stun of the organs around the point hit.", {
        radius: need(pos("Radius (m).")),
        duration: need(pos("Duration (s).")),
      })),
    }),
    meleeWeapon: fields<MeleeSpec>(
      "A melee weapon: a mass that spins or an arm that strikes, carried by a block (nothing is fired).",
      {
        look: need(choice(MELEE_LOOKS, "Its look (drawing, sound, effects in the client).")),
        motion: need(choice(MELEE_MOTIONS, "Its motion: a rotor, a rotor driven by its block's engine, a triggered arm, a point that thrusts, a field around the hull, "
          + "a plate that lifts, a ball on a chain, a jaw that grips.")),
        axis: need(choice(MELEE_AXES, "Axis of the rotor or of the arm's pivot, in the block's frame (up +y, left +x, forward +z).")),
        hub: need(vec(3, "The hub (center of the rotor, or the arm's pivot), in the block's frame (m).")),
        blade: may(ref("blade")),
        spin: may(ref("spin")),
        drive: may(fields<DriveSpec>("A rotor driven by an engine: its speed follows the thrust.", {
          idle: need(share("Speed at idle (share of full speed).")),
          stop: need(share("Below this share of the maximum thrust (engine off), it stops.")),
        })),
        bite: may(fields<BiteSpec>("A rotor that bites continuously instead of striking (saw, drill).", {
          power: need(pos("Cutting power at full speed (kW).")),
          feed: need(choice(["radial", "axial"], "Where the bite goes into the target: the edge of a disc, or the point of a bit.")),
          grab: need(pos("Factor of the cutting force that drags the target along the blade (0: nothing; 1: physical).")),
          gear: need(pos("Reduction between the rotor and the tool (1: direct drive).")),
          depth: need(pos("Depth (m) to which the damage left by a pierced block goes on to the next.")),
        })),
        swing: may(fields<SwingSpec>("A triggered arm: its head goes from `rest` to `end` around the axis (angles: 0 straight ahead, π/2 toward the block's top), then comes back.", {
          reach: need(pos("Distance from the pivot to the head (m).")),
          radius: need(pos("Radius of the head (m).")),
          rest: need(num("Angle at rest (rad).")),
          end: need(num("Angle at the end of the strike (rad).")),
          strike: need(pos("Duration of the strike (s).")),
          recover: need(pos("Duration of the return (s).")),
          energy: need(pos("Energy of the head at the end of its course (J).")),
          cost: need(pos("Energy a strike takes from the batteries (kJ).")),
        })),
        plate: may(fields<PlateSpec>("A flipper's plate: a ram lifts it from `rest` to `end` and throws what is on it.", {
          length: need(pos("Length from its pivot (m).")),
          half: need(pos("Half width along the pivot (m).")),
          rest: need(num("Angle at rest (rad; negative: wedged toward the ground).")),
          end: need(num("Angle at the end of the lift (rad).")),
          strike: need(pos("Duration of the lift (s).")),
          lower: need(pos("Time to come down (s).")),
          reload: need(pos("The ram is ready again this long after the lift (s).")),
          energy: need(pos("Work of the ram over its whole course (J).")),
          cost: need(pos("Energy a lift takes from the batteries (kJ).")),
        })),
        flail: may(fields<FlailSpec>("A flail: a ball on a chain hung from a crank that the motor turns.", {
          crank: need(pos("Radius of the crank (m).")),
          inertia: need(pos("Inertia of the crank and hub (kg·m²): its gyroscope.")),
          speed: need(pos("Speed of the crank at full (rad/s).")),
          spinUp: need(pos("Time to launch the ball (s).")),
          chain: need(pos("Length of the chain (m).")),
          links: need(int("Links drawn.")),
          mass: need(pos("Mass of the ball (kg).")),
          radius: need(pos("Radius of the ball (m).")),
          restitution: need(share("Bounce of the ball (0: soft; 1: elastic).")),
          friction: need(share("Share of its speed along what it hits that it keeps.")),
          drag: need(pos("Air drag on the ball (share of its speed lost per second).")),
        })),
        jaw: may(fields<JawSpec>("A crusher jaw: two jaws that close on what is in their mouth, crush it and drag it.", {
          length: need(pos("Length of the jaws from their pivot (m).")),
          half: need(pos("Half width along the pivot (m).")),
          open: need(pos("Half opening, open (rad).")),
          shut: need(pos("Half opening, closed on nothing (rad).")),
          close: need(pos("Time to close (s).")),
          reopen: need(pos("Time to reopen (s).")),
          cooldown: need(pos("Pause before a new bite (s).")),
          mouth: need(vec(2, "The mouth: between these distances from the pivot (m), what is there can be gripped.")),
          strength: need(pos("Force the grip holds (N); beyond, it slips.")),
          slip: need(pos("After this much slipping (s), it lets go.")),
          tear: need(pos("Gap (m) between the two points of the grip beyond which it tears off.")),
          crush: need(pos("Damage per second of the crushing.")),
          bite: need(pos("Damage of the bite that grips.")),
          power: need(pos("Power of the ram while it squeezes (kW).")),
          hold: need(pos("Longest grip (s).")),
        })),
        thrust: may(fields<ThrustSpec>("A point that thrusts out along the block's front, then retracts.", {
          retracted: need(pos("Distance of the point from the hub, retracted (m).")),
          reach: need(pos("Distance of the point from the hub, out (m).")),
          radius: need(pos("Radius of the point (m).")),
          strike: need(pos("Time to thrust (s).")),
          recover: need(pos("Time to retract (s).")),
          energy: need(pos("Energy of the hit (J).")),
          cost: need(pos("Energy a thrust takes from the batteries (kJ).")),
        })),
        field: may(fields<FieldSpec>("A field around the hull of its part: it strikes what comes into a margin around the blocks.", {
          margin: need(pos("Margin around the blocks covered (m).")),
          radius: need(pos("It covers the blocks within this radius of the projector (m).")),
          contacts: need(int("Contacts struck per hit, at most.")),
          drain: need(share("Share of its energy an enemy rotor rubbing against it loses per hit.")),
          repel: need(pos("Impulse that pushes back an enemy melee weapon, per hit (N·s).")),
        })),
        quench: may(bool("An energy weapon that goes out without power or under water.")),
        hit: need(ref("meleeHit")),
        engage: need(pos("Distance at which the AI engages with it (m, between the robots' centers).")),
      },
      extra({ names: need(ref("names")) }),
    ),
    // Accessoires
    propType: fields<PropTypeDef>(
      "A prop of the scenery: a physical body that can be pushed, broken, that reacts. Its 3D look can come from a glTF model (docs/models.md).",
      {
        shape: need({
          description: "Its collision shape.",
          anyOf: [
            fields<Extract<PropTypeDef["shape"], { kind: "box" }>>("A cube.", { kind: need({ const: "box" }), half: need(pos("Half side (m).")) }),
            fields<Extract<PropTypeDef["shape"], { kind: "cylinder" }>>("An upright cylinder (a map spot may scale it).", {
              kind: need({ const: "cylinder" }), radius: need(pos("Radius (m).")), halfHeight: need(pos("Half height (m).")),
            }),
            fields<Extract<PropTypeDef["shape"], { kind: "slab" }>>(`A box whose dimensions each spot gives (a wall, a roof; a car is ${CAR_HALF.x * 2} × ${CAR_HALF.y * 2} × ${CAR_HALF.z * 2} m).`, {
              kind: need({ const: "slab" }),
            }),
          ],
        }),
        mass: need(pos("Mass (kg); for a slab, density (kg/m³).")),
        friction: need(pos("Friction coefficient.")),
        hp: need(pos("Hit points (for a slab, per m² of its largest face): at 0 it breaks, explodes or bolts.")),
        resist: may(ref("resistances")),
        explosion: may(ref("explosion", "Explosion when it gives way (after `fuse` s): neighboring explosions can set it off in a chain.")),
        fuse: may(pos("Delay between the break and the explosion (s).")),
        vent: may(fields<NonNullable<PropTypeDef["vent"]>>("A gas leak: once punctured, the jet propels it along its axis, spinning, then it explodes.", {
          thrust: need(pos("Thrust (N).")),
          duration: need(pos("Duration (s).")),
        })),
        shatters: may(bool("It breaks into pieces when it gives way.")),
        anchored: may(bool("Anchored: a fixed body that nothing pushes, until it is released or topples.")),
        topples: may(share("It topples instead of breaking the first time it gives way, keeping this share of its hit points.")),
        burns: may(fields<NonNullable<PropTypeDef["burns"]>>("Wood: it catches fire, loses hit points, chars, and goes out if not rekindled.", {
          time: need(pos("Time before it goes out (s).")),
          reach: need(pos("Reach of its flames beyond its surface (m): the neighbors it can set alight.")),
        })),
      },
      extra({ names: need(ref("names")) }),
    ),
    // Robots
    robot: fields<Omit<BotProfile, "id" | "name" | "design">>(
      "A preset robot: its design, its color and its driving settings.",
      {
        color: need({ description: "Color of its tinted blocks, #rrggbb.", type: "string", pattern: "^#[0-9a-fA-F]{6}$" }),
        speed: need(pos("Target cruise speed (m/s): on the ground, its wheels and weight limit it; hovering, its top horizontal speed; a plane, its airspeed.")),
        turn: need(pos("Differential steering: speed difference between its left and right sides to turn (m/s).")),
        behavior: need(choice(BEHAVIORS, "What its AI does when hit: flee, or charge (a robot made for melee).")),
        mobility: need(choice(MOBILITIES, "How it moves, which picks its AI pilot: on the ground, hovering (rotors), or flying like a plane.")),
      },
      extra({
        names: need(ref("names")),
        traits: need(ref("names", "Its short description in each language.")),
        cost: need(pos("Build cost of its design (blocks and wheels).")),
        mass: need(pos("Mass of its design (kg).")),
        design: need(ref("design")),
      }, { design: need(ref("design")) }),
    ),
    design: {
      description: "A robot design, as the garage saves it (the same as schemas/robot.schema.json): blocks on a grid of 0.5 m cells, wheels on their faces. "
        + "Frame: +z forward, +x left, +y up.",
      type: "object",
      properties: { blocks: props.blocks, wheels: props.wheels },
      required: ["blocks", "wheels"],
    },
    ...(robot.$defs as Record<string, Schema>),
  };
}

/** Le schéma de content/catalog.json. */
export function catalogSchema(): Schema {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: CATALOG_SCHEMA_ID,
    title: "Casse-Robot content catalog",
    description: "The game's elements as data: blocks, block shapes, wheels, weapons and their projectiles, melee weapons, props, preset robots, "
      + "with their display names in French and English. Generated from the game's TypeScript catalogs (npm run schemas), which remain the source: "
      + "read it, don't edit it. Units: meters, kilograms, seconds, radians, newtons; energies in kJ unless noted (J for a few strike energies); "
      + "frames: a block's or robot's +z is forward, +x left, +y up.",
    type: "object",
    properties: {
      $schema: str("The URL of this schema."),
      format: { description: "Version of the catalog's format: it goes up when a change breaks what tools read.", const: CATALOG_FORMAT },
      constants: {
        description: "Constants of the game the entries refer to.",
        type: "object",
        properties: {
          blockSize: pos("Side of a block's cell (m)."),
          plateThickness: pos("Thickness of a plate block (wings, control surfaces) (m)."),
          gravity: pos("Gravity (m/s²)."),
          robotBudget: pos("Build budget of a robot: the sum of its blocks' and wheels' costs may not exceed it."),
          generatorPower: pos("Power of every robot's generator (kW), which recharges its batteries."),
          motorEfficiency: share("Efficiency of a rotor's motor (melee weapons): what doesn't go into the blade is lost."),
          resumeHeat: share("Heat at which an overheated weapon can fire again."),
        },
        required: ["blockSize", "plateThickness", "gravity", "robotBudget", "generatorPower", "motorEfficiency", "resumeHeat"],
      },
      damageTypes: {
        description: "The kinds of damage.",
        type: "object",
        propertyNames: { enum: [...DAMAGE_TYPES] },
        additionalProperties: { description: "A kind of damage.", type: "object", properties: { names: ref("names") }, required: ["names"] },
      },
      shapes: byId(SHAPE_IDS, "shape", "The block shapes cut out of the cube (a block type's `shape`)."),
      blocks: byId(BLOCK_IDS, "blockType", "The block types, by identifier (a robot design's `type`)."),
      wheels: byId(WHEEL_IDS, "wheelType", "The wheel types, by identifier."),
      weapons: byId(WEAPON_IDS, "weapon", "The weapons, by identifier (a turret's `weapon`)."),
      melee: byId(MELEE_IDS, "meleeWeapon", "The melee weapons, by identifier (a block type's `melee`)."),
      props: byId(PROP_IDS, "propType", "The props of the scenery, by identifier (a map's `props[].type`)."),
      robots: byId(ROBOT_IDS, "robot", "The preset robots, by identifier."),
    },
    required: ["format", "constants", "damageTypes", "shapes", "blocks", "wheels", "weapons", "melee", "props", "robots"],
    $defs: contentDefs("catalog"),
  };
}

// --- Les schémas des fichiers des éléments ---

/**
 * Les familles d'éléments en fichiers de données, que lit le jeu : content/<famille>/<id>.json, un
 * fichier par élément, qui suit content/schemas/<famille>.schema.json (la définition `def` du
 * catalogue, sans ses noms : ils sont dans les catalogues de messages du client).
 */
export const CONTENT_FAMILIES = {
  props: {
    def: "propType",
    title: "Casse-Robot prop type",
    description: "One file per prop type: content/props/<type>.json, named after the type's identifier (a map's "
      + "`props[].type`), read by the game as it is (src/shared/catalog/props.ts). Adding a type also takes its look and its name in each "
      + "language in the client (docs/architecture.md, \"Architecture rules\").",
  },
  wheels: {
    def: "wheelType",
    title: "Casse-Robot wheel type",
    description: "One file per wheel type: content/wheels/<type>.json, named after the type's identifier (a robot design's "
      + "`wheels[].type`), read by the game as it is (src/shared/catalog/wheels.ts), with its unlock price. Adding a type also takes its look "
      + "and its name in each language in the client (docs/architecture.md, \"Architecture rules\").",
  },
  weapons: {
    def: "weapon",
    title: "Casse-Robot weapon",
    description: "One file per weapon: content/weapons/<id>.json, named after the weapon's identifier (a turret's `weapon`), read by the game "
      + "as it is (src/shared/catalog/weapons.ts), in the order of the weapon keys. Adding a weapon also takes its sounds, its sight, its muzzle "
      + "flash and its name in each language in the client, and a block whose turret carries it (docs/architecture.md, \"Architecture rules\").",
  },
  melee: {
    def: "meleeWeapon",
    title: "Casse-Robot melee weapon",
    description: "One file per melee weapon: content/melee/<id>.json, named after the weapon's identifier (a block type's `melee`), read by "
      + "the game as it is (src/shared/catalog/melee.ts). Adding a melee weapon also takes its block, its models, its sight, its sounds and its "
      + "name in each language in the client (docs/architecture.md, \"Architecture rules\").",
  },
  blocks: {
    def: "blockType",
    title: "Casse-Robot block type",
    description: "One file per block type: content/blocks/<type>.json, named after the type's identifier (a robot design's "
      + "`blocks[].type`), read by the game as it is (src/shared/catalog/blocks.ts), with its unlock price. The shaped blocks (wedges, "
      + "corners, rounds…) have no file: the game cuts them out of the light, normal and heavy armors, their mass, hit points and cost in "
      + "proportion to their volume. Adding a type also takes its look, its name in each language and its sentence in the garage "
      + "(docs/architecture.md, \"Architecture rules\").",
  },
} as const;
export type ContentFamily = keyof typeof CONTENT_FAMILIES;
export const CONTENT_FAMILY_IDS = Object.keys(CONTENT_FAMILIES) as ContentFamily[];

/** Où est le schéma des fichiers d'une famille, depuis la racine du dépôt et depuis un de ses fichiers (son `$schema`). */
export const familySchemaPath = (family: ContentFamily): string => `content/schemas/${family}.schema.json`;
export const familySchemaRef = (family: ContentFamily): string => `../schemas/${family}.schema.json`;

/** Les définitions qu'emploie un schéma (« #/$defs/… »), de proche en proche, dans l'ordre de `defs`. */
function usedDefs(root: Schema, defs: Readonly<Record<string, Schema>>): Record<string, Schema> {
  const used = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") {
      for (const [key, x] of Object.entries(value)) {
        if (key !== "$ref" || typeof x !== "string") visit(x);
        else if (x.startsWith("#/$defs/") && !used.has(x.slice(8))) {
          used.add(x.slice(8));
          visit(defs[x.slice(8)]);
        }
      }
    }
  };
  visit(root);
  return Object.fromEntries(Object.keys(defs).filter((name) => used.has(name)).map((name) => [name, defs[name]]));
}

/** Le schéma des fichiers d'une famille (content/schemas/<famille>.schema.json). */
export function familySchema(family: ContentFamily): Schema {
  const { def, title, description } = CONTENT_FAMILIES[family];
  const defs = contentDefs("file");
  const { description: what, ...entry } = defs[def];
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `${BASE}schemas/${family}.schema.json`,
    title,
    description: `${what} ${description} Generated from the game's code (npm run schemas). Units: meters, kilograms, seconds, radians, newtons.`,
    ...entry,
    $defs: usedDefs(entry, defs),
  };
}

// --- Les données ---

type Messages = Readonly<Record<string, unknown>>;

/** Un nom dans chaque langue, d'après les catalogues de messages du client. */
function names(fr: Messages, en: Messages, key: string): { fr: string; en: string } {
  const pick = (messages: Messages): string => {
    const text = messages[key];
    if (typeof text !== "string") throw new Error(`Pas de texte simple pour ${key}`);
    return text;
  };
  return { fr: pick(fr), en: pick(en) };
}
const catalogName = (key: string): { fr: string; en: string } => names(frCatalog, enCatalog, key);
const botText = (key: string): { fr: string; en: string } => names(frBots, enBots, key);

/** Arrondi à 6 décimales (les sommets des formes, calculés). */
const round = (x: number): number => Math.round(x * 1e6) / 1e6 + 0;

/** Une valeur JSON : un nombre infini devient null (`Weapon.ammo.reload` : jamais), comme le ferait JSON.stringify. */
function plain(value: unknown): unknown {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  return value;
}

const entries = <T>(record: Readonly<Record<string, T>>, extra: (id: string, entry: T) => object): Record<string, unknown> =>
  Object.fromEntries(Object.entries(record).map(([id, entry]) => [id, { ...extra(id, entry), ...entry }]));

/** Le catalogue (content/catalog.json). */
export function catalogData(): Record<string, unknown> {
  return plain({
    $schema: CATALOG_SCHEMA_ID,
    format: CATALOG_FORMAT,
    constants: {
      blockSize: BLOCK_SIZE, plateThickness: PLATE_THICKNESS, gravity: GRAVITY, robotBudget: ROBOT_BUDGET, generatorPower: GENERATOR_POWER,
      motorEfficiency: MOTOR_EFFICIENCY, resumeHeat: RESUME_HEAT,
    },
    damageTypes: Object.fromEntries(DAMAGE_TYPES.map((type: DamageType) => [type, { names: catalogName(`damage.${type}`) }])),
    shapes: Object.fromEntries(SHAPE_IDS.map((id) => [id, {
      fraction: round(shapeFraction(id)),
      swapsLeftAndFront: shapeSwaps(id),
      pieces: shapePieces(id).map((piece) => ({
        faces: piece.faces.map((face) => ({
          normal: [face.normal.x, face.normal.y, face.normal.z].map(round),
          points: face.points.map((p) => [p.x, p.y, p.z].map(round)),
        })),
      })),
    }])),
    blocks: entries<BlockTypeDef>(BLOCK_TYPES, (id) => ({ names: catalogName(`block.${id}`), price: BLOCK_PRICES[id as keyof typeof BLOCK_PRICES] })),
    wheels: entries<WheelTypeDef>(WHEEL_TYPES, (id, def) => ({
      names: catalogName(`wheel.${id}`), price: WHEEL_PRICES[id as keyof typeof WHEEL_PRICES], kind: wheelKind(def),
    })),
    weapons: entries<Weapon>(WEAPONS, (id) => ({ names: catalogName(`weapon.${id}`) })),
    melee: entries<MeleeSpec>(MELEE_WEAPONS, (id) => ({ names: catalogName(`melee.${id}`) })),
    props: entries<PropTypeDef>(PROP_TYPES, (id) => ({ names: catalogName(`prop.${id}`) })),
    robots: Object.fromEntries(PRESET_BOTS.map((bot) => [bot.id, {
      names: botText(`bot.${bot.id}`),
      traits: botText(`botTrait.${bot.id}`),
      cost: designCost(bot.design),
      mass: round(designMass(bot.design)),
      color: bot.color,
      speed: bot.speed,
      turn: bot.turn,
      behavior: bot.behavior,
      mobility: bot.mobility,
      design: bot.design,
    }])),
  }) as Record<string, unknown>;
}

/**
 * Le texte du catalogue : du JSON indenté, mais un objet ou une liste qui tient sur une ligne y
 * reste (un bloc d'un plan, un vecteur) : un fichier lisible, pas trop long.
 */
export function catalogText(value: unknown): string {
  const WIDTH = 120;
  /** Sur une ligne, aéré : `{ "x": 1, "y": [0, 1] }`. */
  const inline = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(inline).join(", ")}]`;
    if (v && typeof v === "object") {
      const fields = Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`);
      return fields.length ? `{ ${fields.join(", ")} }` : "{}";
    }
    return JSON.stringify(v);
  };
  const write = (v: unknown, indent: string, prefix: number): string => {
    const flat = inline(v);
    if (v === null || typeof v !== "object" || flat.length + indent.length + prefix <= WIDTH) return flat;
    const inner = `${indent}  `;
    if (Array.isArray(v)) return `[\n${v.map((x) => inner + write(x, inner, 0)).join(",\n")}\n${indent}]`;
    const lines = Object.entries(v).map(([k, x]) => {
      const key = `${JSON.stringify(k)}: `;
      return inner + key + write(x, inner, key.length);
    });
    return `{\n${lines.join(",\n")}\n${indent}}`;
  };
  return `${write(value, "", 0)}\n`;
}
