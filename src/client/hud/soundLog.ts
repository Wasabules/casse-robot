/**
 * Relevé des derniers sons joués (réglage « Afficher les sons joués ») : le nom de chacun, et sa
 * distance, sous le score. Pour repérer un son qui gêne et le régler.
 */
const LINES = 10;

export class SoundLog {
  private readonly el = document.createElement("div");
  private readonly lines: string[] = [];

  constructor() {
    this.el.className = "sound-log";
    this.el.hidden = true;
    document.body.append(this.el);
  }

  setVisible(on: boolean): void {
    this.el.hidden = !on;
    if (!on) {
      this.lines.length = 0;
      this.el.textContent = "";
    }
  }

  push(label: string): void {
    if (this.el.hidden) return;
    const now = new Date();
    const stamp = `${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
    this.lines.unshift(`${stamp}  ${label}`);
    this.lines.length = Math.min(this.lines.length, LINES);
    this.el.textContent = this.lines.join("\n");
  }
}
