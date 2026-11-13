import type { ArenaKey } from "../shared/arena/layout";
import type { BotProfile } from "../shared/design/presets";
import { pickRoster } from "../shared/modes";
import { NativeEncoder, CODE } from "../shared/native/events";
import type { SimModule } from "../shared/native/simModule";
import { NativeWorld, type Slot } from "../shared/native/world";
import type { LockState, NetEvent } from "../shared/net/protocol";
import type { Team } from "../shared/sim/entities";
import type { MatchRules } from "../shared/sim/match";
import type { WaveEntry } from "../shared/sim/wave";
import { ProgressBook } from "./progressBook";
import { MODE, RoomBase, type Player, type RoomOptions } from "./room";

/*
 * La salle du serveur sur la simulation portée en Rust (src/shared/native/world.ts) : la même salle
 * que `Room` (server/room.ts : les joueurs, la rotation des arènes, les parties, les crédits), dont la
 * simulation est celle du module. Un robot y est désigné par son rang dans le module (`Slot`) ; les
 * commandes de chaque joueur sont au rang de son numéro (`Player.id`), recopiées dans le module avant
 * chaque pas. Les images sont celles de `Room`, octet pour octet, pour un même hasard
 * (tests/nativeSession.test.ts) : `SIM=rust npm run server`.
 */
export class NativeRoom extends RoomBase<Slot> {
  private readonly world: NativeWorld;
  private readonly encoder = new NativeEncoder();

  constructor(module: SimModule, book = new ProgressBook(), options: RoomOptions = {}, seed = Math.floor(Math.random() * 4294967296)) {
    super(book, options);
    this.world = new NativeWorld(module, seed);
    this.world.on((e) => {
      this.encoder.record(e);
      // Les destructions de chaque joueur : un ennemi détruit par l'un de ses robots (ses commandes)
      if (e.code !== CODE.botKilled || e.killerSlot === null || e.killerSlot === undefined || e.killerTeam === e.team) return;
      for (const p of this.players) if (p.id === e.killerSlot) this.creditKill(p.input);
    });
    this.world.combat = MODE.combat;
    this.newMatch();
  }

  protected get time(): number {
    return this.world.time;
  }

  protected get arenaKey(): ArenaKey {
    return this.world.arena.id;
  }

  protected get winner(): Team | "draw" | null {
    return this.world.matchState().winner;
  }

  protected stepWorld(): void {
    for (const p of this.players) if (p.profile) this.world.setInput(p.id, p.input);
    this.world.step();
  }

  protected botOf(player: Player<Slot>): Slot | null {
    return this.world.botWithInput(player.id);
  }

  protected alive(bot: Slot): boolean {
    return this.world.alive(bot);
  }

  protected selfDestructBot(bot: Slot): void {
    this.world.selfDestruct(bot);
  }

  protected releaseBot(bot: Slot): void {
    this.world.releaseControl(bot);
  }

  protected replaceAiBot(player: Player<Slot>, profile: BotProfile): Slot | null {
    const old = this.world.roster().find((b) => b.team === player.team && !b.piloted);
    if (!old) return null;
    return this.world.replaceBot(old.slot, profile, player.team, player.id);
  }

  protected endMatchWorld(): void {
    this.world.endMatch();
  }

  protected loadArenaWorld(key: ArenaKey): void {
    this.world.loadArena(key);
  }

  protected drawRoster(): BotProfile[] {
    return this.world.draw(() => pickRoster(MODE));
  }

  protected spawnTeamsWorld(entries: WaveEntry[]): Slot[] {
    return this.world.spawnTeams(entries);
  }

  protected takeControlWorld(bot: Slot, player: Player<Slot>): void {
    this.world.setInput(player.id, player.input);
    this.world.takeControl(bot, player.id);
  }

  protected startMatchWorld(rules: MatchRules): void {
    this.world.startMatch(rules);
    this.encoder.push({ t: "match", rules });
  }

  protected takeEvents(): NetEvent[] {
    this.world.drain();
    return this.encoder.take((id) => this.world.describeBot(id));
  }

  protected snapshot(): Uint8Array {
    return this.world.snapshot();
  }

  protected describeWorld(): NetEvent[] {
    return this.world.describeWorld();
  }

  protected botId(bot: Slot): number {
    return this.world.botId(bot);
  }

  protected lockOf(bot: Slot): LockState | null {
    return this.world.lock(bot);
  }

  dispose(): void {
    this.world.dispose();
  }
}
