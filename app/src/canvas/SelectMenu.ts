/**
 * Lightweight floating select menu for canvas modules.
 *
 * The patch canvas is PixiJS, so native <select> elements aren't available on
 * tiles. This renders a small DOM popup at screen coordinates (a pointer
 * event's clientX/clientY), lists options, and resolves the pick. One menu at
 * a time; clicking elsewhere or pressing Escape dismisses it.
 */

export interface SelectMenuItem {
  label: string;
  value: string;
  selected?: boolean;
}

let openMenu: HTMLElement | null = null;

/** Close any menu currently on screen. */
export function closeSelectMenu(): void {
  openMenu?.remove();
  openMenu = null;
}

export function openSelectMenu(opts: {
  x: number;
  y: number;
  items: SelectMenuItem[];
  onPick: (value: string) => void;
}): void {
  closeSelectMenu();

  const menu = document.createElement('div');
  menu.className = 'kk-select-menu';
  Object.assign(menu.style, {
    position: 'fixed',
    left: `${opts.x}px`,
    top: `${opts.y}px`,
    zIndex: '200',
    minWidth: '160px',
    maxWidth: '320px',
    maxHeight: '50vh',
    overflowY: 'auto',
    padding: '4px',
    background: 'var(--panel, #1c1c24)',
    border: '1px solid var(--panel-border, #3a3a46)',
    borderRadius: '8px',
    boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
    font: '12px system-ui, sans-serif',
    color: 'var(--text, #e6e6ec)',
  } satisfies Partial<CSSStyleDeclaration>);

  for (const item of opts.items) {
    const row = document.createElement('button');
    row.type = 'button';
    row.textContent = (item.selected ? '✓ ' : '') + item.label;
    Object.assign(row.style, {
      display: 'block',
      width: '100%',
      textAlign: 'left',
      padding: '6px 10px',
      border: 'none',
      borderRadius: '5px',
      background: item.selected ? 'var(--accent, #4b6cff)' : 'transparent',
      color: 'inherit',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    } satisfies Partial<CSSStyleDeclaration>);
    row.onmouseenter = () => {
      if (!item.selected) row.style.background = 'var(--hover, rgba(255,255,255,0.08))';
    };
    row.onmouseleave = () => {
      if (!item.selected) row.style.background = 'transparent';
    };
    row.onclick = (e) => {
      e.stopPropagation();
      closeSelectMenu();
      opts.onPick(item.value);
    };
    menu.appendChild(row);
  }

  document.body.appendChild(menu);
  openMenu = menu;

  // Nudge back on-screen if it would overflow the viewport edges.
  const r = menu.getBoundingClientRect();
  if (r.right > window.innerWidth) menu.style.left = `${Math.max(4, window.innerWidth - r.width - 4)}px`;
  if (r.bottom > window.innerHeight) menu.style.top = `${Math.max(4, window.innerHeight - r.height - 4)}px`;

  // Dismiss on outside click / Escape (deferred so the opening click doesn't
  // immediately close it).
  setTimeout(() => {
    const onDoc = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) dismiss();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss();
    };
    const dismiss = () => {
      document.removeEventListener('pointerdown', onDoc, true);
      document.removeEventListener('keydown', onKey, true);
      if (openMenu === menu) closeSelectMenu();
    };
    document.addEventListener('pointerdown', onDoc, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);
}
