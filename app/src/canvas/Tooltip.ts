/**
 * Hover tooltip (PRD §5): small informative popup over modules, ports, wires,
 * controls. DOM overlay so text stays crisp at any canvas zoom.
 */

const SHOW_DELAY_MS = 400;

export class Tooltip {
  private el: HTMLDivElement;
  private timer: number | null = null;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'kk-tooltip';
    this.el.style.display = 'none';
    parent.appendChild(this.el);
  }

  /** Schedule the tooltip; call hide() to cancel. Pass html lines. */
  show(lines: string[], clientX: number, clientY: number): void {
    this.cancel();
    this.timer = window.setTimeout(() => {
      this.el.innerHTML = lines
        .map((l, i) => `<div class="${i === 0 ? 'kk-tooltip-title' : 'kk-tooltip-line'}">${l}</div>`)
        .join('');
      this.el.style.display = 'block';
      const pad = 12;
      const rect = this.el.parentElement!.getBoundingClientRect();
      let x = clientX - rect.left + pad;
      let y = clientY - rect.top + pad;
      // Keep inside the canvas area.
      if (x + this.el.offsetWidth > rect.width) x = rect.width - this.el.offsetWidth - pad;
      if (y + this.el.offsetHeight > rect.height) y = clientY - rect.top - this.el.offsetHeight - pad;
      this.el.style.left = `${x}px`;
      this.el.style.top = `${y}px`;
    }, SHOW_DELAY_MS);
  }

  hide(): void {
    this.cancel();
    this.el.style.display = 'none';
  }

  private cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
