//! Les événements de la simulation (`SimEvent`, src/shared/sim/events.ts), notés au moment où ils se
//! produisent, dans l'ordre où le TypeScript les émet : la session de la simulation portée
//! (src/shared/native/session.ts) en fait les événements réseau de ses images, comme l'encodeur du
//! TypeScript (src/shared/net/encoder.ts) les fait des siens. Chacun est écrit tel que l'encodeur le
//! lit à l'instant où il est émis (les points de structure d'un bloc touché, le morceau d'un bloc
//! déplacé…) : un état relu plus tard aurait pu changer entre-temps.
//!
//! Le journal (`Sim.events`) n'est tenu que si on le demande (`log_events`) : les essais de parité
//! (tests/nativeSim.test.ts) n'en ont pas besoin. Son format : un octet (le code de l'événement), puis
//! ses champs, des nombres de 8 octets (petit-boutistes) et des textes (leur longueur sur 4 octets,
//! puis leur UTF-8) ; un robot, un bloc, une roue sont nommés par leur numéro d'entité (`id`), et
//! chaque événement qui concerne un robot (`subjectOf`) le nomme en dernier.

use super::vec::V3;
use super::world::Sim;

/// Les codes des événements (l'ordre est celui de src/shared/native/events.ts : ne pas renuméroter).
pub mod code {
    pub const BOT_ADDED: u8 = 1;
    pub const BOT_REMOVED: u8 = 2;
    pub const PART_ADDED: u8 = 3;
    pub const PART_REMOVED: u8 = 4;
    pub const BLOCK_ATTACHED: u8 = 5;
    pub const BLOCK_DAMAGED: u8 = 6;
    pub const BLOCK_REPAIRED: u8 = 7;
    pub const BLOCK_DESTROYED: u8 = 8;
    pub const BLOCK_REBUILT: u8 = 9;
    pub const WHEEL_REMOVED: u8 = 10;
    pub const DEBRIS_ADDED: u8 = 11;
    pub const DEBRIS_REMOVED: u8 = 12;
    pub const PROP_ADDED: u8 = 13;
    pub const PROP_REMOVED: u8 = 14;
    pub const PROP_RELEASED: u8 = 15;
    pub const PROP_FIRE: u8 = 16;
    pub const GROUND_FIRE_ADDED: u8 = 17;
    pub const GROUND_FIRE_REMOVED: u8 = 18;
    pub const PROJECTILE_ADDED: u8 = 19;
    pub const PROJECTILE_REMOVED: u8 = 20;
    pub const SHOT: u8 = 21;
    pub const MINE: u8 = 22;
    pub const IMPACT: u8 = 23;
    pub const EXPLOSION: u8 = 24;
    pub const MELEE_HIT: u8 = 25;
    pub const COLLISION: u8 = 26;
    pub const LINK_BROKEN: u8 = 27;
    pub const FIRE_STARTED: u8 = 28;
    pub const FIRE_ENDED: u8 = 29;
    pub const EMP_BURST: u8 = 30;
    pub const STUNNED: u8 = 31;
    pub const ORGANS_STUNNED: u8 = 32;
    pub const SHIELD_HIT: u8 = 33;
    pub const BARRIER_ADDED: u8 = 34;
    pub const BARRIER_HIT: u8 = 35;
    pub const BARRIER_REMOVED: u8 = 36;
    pub const SMOKE_ADDED: u8 = 37;
    pub const SMOKE_REMOVED: u8 = 38;
    pub const HIT: u8 = 39;
    pub const BOT_KILLED: u8 = 40;
    pub const ARENA_CHANGED: u8 = 41;
    pub const ZONE_CHANGED: u8 = 42;
    pub const MATCH_OVER: u8 = 43;
    pub const DAMAGE: u8 = 44;
    pub const WHEEL_ADDED: u8 = 45;
}

/// Ce que touche un projectile ou une lame (`ImpactSurface`), dans l'ordre du TypeScript.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Surface {
    Robot = 0,
    Prop = 1,
    Scenery = 2,
    Projectile = 3,
}

/// Ce que fait une mine (`MineAction`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MineAction {
    Bounce = 0,
    Stick = 1,
    Ping = 2,
}

/// L'écriture d'un événement : ses champs, à la suite.
pub struct Writer<'a>(&'a mut Vec<u8>);

impl<'a> Writer<'a> {
    pub fn new(log: &'a mut Vec<u8>) -> Self {
        Writer(log)
    }

    pub fn num(&mut self, x: f64) -> &mut Self {
        self.0.extend_from_slice(&x.to_le_bytes());
        self
    }

    /// Un numéro d'entité (ou -1 : aucun).
    pub fn id(&mut self, id: Option<u64>) -> &mut Self {
        self.num(id.map_or(-1.0, |i| i as f64))
    }

    pub fn flag(&mut self, on: bool) -> &mut Self {
        self.num(if on { 1.0 } else { 0.0 })
    }

    pub fn vec(&mut self, v: V3) -> &mut Self {
        self.num(v.x).num(v.y).num(v.z)
    }

    pub fn text(&mut self, s: &str) -> &mut Self {
        self.0.extend_from_slice(&(s.len() as u32).to_le_bytes());
        self.0.extend_from_slice(s.as_bytes());
        self
    }

    /// Un texte ou rien (une longueur de 0xffffffff).
    pub fn maybe(&mut self, s: Option<&str>) -> &mut Self {
        match s {
            Some(s) => self.text(s),
            None => {
                self.0.extend_from_slice(&u32::MAX.to_le_bytes());
                self
            }
        }
    }
}

impl Sim {
    /// Le journal est-il tenu ?
    pub fn logging(&self) -> bool {
        self.events.is_some()
    }

    /// Note un événement de code `code` ; `fields` écrit ses champs (rien si le journal n'est pas tenu).
    pub fn emit(&mut self, code: u8, fields: impl FnOnce(&Sim, &mut Writer)) {
        let Some(mut log) = self.events.take() else { return };
        log.push(code);
        fields(self, &mut Writer(&mut log));
        self.events = Some(log);
    }

    /// Le numéro d'entité d'un robot.
    pub fn bot_id(&self, bot: usize) -> u64 {
        self.bots[bot].id
    }

    /// Le numéro d'entité d'un robot, ou rien.
    pub fn bot_id_of(&self, bot: Option<usize>) -> Option<u64> {
        bot.map(|b| self.bots[b].id)
    }

    /// Un bloc est touché, réparé, détruit, prend feu, s'éteint, son bouclier brille : son numéro (et
    /// ses points de structure), puis son robot.
    pub fn emit_block(&mut self, code: u8, bot: usize, block: usize) {
        self.emit(code, |s, w| {
            let b = &s.bots[bot].blocks[block];
            w.id(Some(b.id));
            if code == code::BLOCK_DAMAGED || code == code::BLOCK_REPAIRED {
                w.num(b.hp);
            }
            w.id(Some(s.bots[bot].id));
        });
    }

    /// Un bloc fixé sur un morceau (`blockAttached`).
    pub fn emit_attached(&mut self, bot: usize, block: usize) {
        self.emit(code::BLOCK_ATTACHED, |s, w| {
            let b = &s.bots[bot].blocks[block];
            w.id(Some(b.id)).id(Some(s.part(b.part).id)).id(Some(s.bots[bot].id));
        });
    }

    /// Un morceau né ou retiré (son numéro, son robot).
    pub fn emit_part(&mut self, code: u8, part_id: u64, bot: usize) {
        self.emit(code, |s, w| {
            w.id(Some(part_id)).id(Some(s.bots[bot].id));
        });
    }

    /// Un point, ou un point et un nombre (`linkBroken`, `collision`, `empBurst`).
    pub fn emit_point(&mut self, code: u8, point: V3, value: Option<f64>) {
        self.emit(code, |_, w| {
            w.vec(point);
            if let Some(v) = value {
                w.num(v);
            }
        });
    }

    /// Un impact sans explosion (`impact`).
    pub fn emit_impact(&mut self, point: V3, surface: Surface) {
        self.emit(code::IMPACT, |_, w| {
            w.vec(point).num(surface as u8 as f64);
        });
    }

    /// Une entité qui disparaît, nommée par son seul numéro (débris, accessoire, flaque, projectile, fumée).
    pub fn emit_gone(&mut self, code: u8, id: u64) {
        self.emit(code, |_, w| {
            w.id(Some(id));
        });
    }

    /// Des robots touchés : fin d'un impact ou d'une explosion (`damage`).
    pub fn emit_damage(&mut self, bots: &[usize]) {
        self.emit(code::DAMAGE, |s, w| {
            w.num(bots.len() as f64);
            for &b in bots {
                w.id(Some(s.bots[b].id));
            }
        });
    }
}
