import { padStyle, stickDeadzone, type PadStyle } from "./bindings";

/** Une gâchette analogique (LT, RT) compte comme appuyée au-delà de cette course. */
const TRIGGER_PRESS = 0.35;
/** Gâchettes de la disposition standard (des boutons analogiques). */
const TRIGGERS = new Set([6, 7]);

/** Ce qu'on lit d'une manette (l'interface `Gamepad` du navigateur, ou une manette simulée dans les essais). */
interface PadState {
  readonly id: string;
  readonly index: number;
  readonly connected: boolean;
  readonly buttons: readonly { readonly pressed: boolean; readonly value: number }[];
  readonly axes: readonly number[];
}

/**
 * Manette (Gamepad API), relevée à chaque image : ses boutons (et ceux qui viennent d'être
 * appuyés ou relâchés), ses sticks (zone morte appliquée), et laquelle suivre. Le navigateur ne
 * montre une manette qu'après un premier appui sur l'un de ses boutons ; elle est repérée au
 * relevé (branchement, débranchement), sans compter sur ses événements.
 */
export class GamepadInput {
  /** Zone morte des sticks (part de leur course), réglage du joueur. */
  deadzone = 0.15;
  /** Nom de la manette suivie (null : aucune) et sa disposition (noms de ses boutons). */
  id: string | null = null;
  style: PadStyle = "xbox";
  /** La manette a servi en dernier, plutôt que le clavier ou la souris : on vise au réticule, les aides la nomment (tenu par `Controls`). */
  active = false;
  /** Un bouton vient d'être appuyé, ou un stick est poussé, à ce relevé. */
  touched = false;
  /** Sticks, de -1 à 1 (y > 0 : vers le bas). */
  readonly left = { x: 0, y: 0 };
  readonly right = { x: 0, y: 0 };
  /** Une manette est branchée (`id`) ou débranchée (null). */
  onChange: ((id: string | null) => void) | null = null;
  private index = -1;
  private buttons: boolean[] = [];
  private previous: boolean[] = [];

  /** Relève la manette suivie (la première branchée, si elle a disparu). */
  poll(): void {
    let pads: readonly (PadState | null)[] = [];
    try {
      pads = (navigator.getGamepads?.() ?? []) as readonly (PadState | null)[];
    } catch {
      // Refusé (politique de permissions) : pas de manette
    }
    let pad = this.index >= 0 ? pads[this.index] ?? null : null;
    if (!pad?.connected) pad = pads.find((p): p is PadState => !!p?.connected) ?? null;
    this.previous = this.buttons;
    const id = pad?.id ?? null;
    if (id !== this.id) {
      this.id = id;
      this.style = padStyle(id);
      this.onChange?.(id);
    }
    if (!pad) {
      this.index = -1;
      this.buttons = [];
      this.touched = false;
      this.left.x = this.left.y = this.right.x = this.right.y = 0;
      return;
    }
    this.index = pad.index;
    this.buttons = pad.buttons.map((b, i) => (TRIGGERS.has(i) ? b.value > TRIGGER_PRESS : b.pressed));
    const [lx, ly] = stickDeadzone(pad.axes[0] ?? 0, pad.axes[1] ?? 0, this.deadzone);
    const [rx, ry] = stickDeadzone(pad.axes[2] ?? 0, pad.axes[3] ?? 0, this.deadzone);
    this.left.x = lx;
    this.left.y = ly;
    this.right.x = rx;
    this.right.y = ry;
    this.touched = !!(lx || ly || rx || ry) || this.buttons.some((on, i) => on && !this.previous[i]);
  }

  /** Bouton tenu ("Pad7"). */
  held(code: string): boolean {
    const i = buttonIndex(code);
    return i >= 0 && !!this.buttons[i];
  }

  /** Boutons tout juste appuyés à ce relevé. */
  pressed(): string[] {
    const out: string[] = [];
    this.buttons.forEach((on, i) => {
      if (on && !this.previous[i]) out.push(`Pad${i}`);
    });
    return out;
  }

  /** Boutons tout juste relâchés à ce relevé. */
  released(): string[] {
    const out: string[] = [];
    this.previous.forEach((on, i) => {
      if (on && !this.buttons[i]) out.push(`Pad${i}`);
    });
    return out;
  }
}

function buttonIndex(code: string): number {
  const m = /^Pad(\d{1,2})$/.exec(code);
  return m ? Number(m[1]) : -1;
}
