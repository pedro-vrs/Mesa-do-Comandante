import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface MenuItem {
  label: string;
  hint?: string;          // atalho de teclado
  onClick?: () => void;
  sub?: MenuItem[];
  danger?: boolean;
  divider?: boolean;
}

export function ContextMenu({ x, y, title, items, onClose }: { x: number; y: number; title?: string; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [open, setOpen] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.max(8, Math.min(x, innerWidth - r.width - 8)), y: Math.max(8, Math.min(y, innerHeight - r.height - 8)) });
  }, [x, y]);

  useEffect(() => {
    const close = (e: Event) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    setTimeout(() => { addEventListener('pointerdown', close); }, 0);
    addEventListener('keydown', key);
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => { removeEventListener('pointerdown', close); removeEventListener('keydown', key); };
  }, [onClose]);

  return (
    <div ref={ref} className="menu" role="menu" style={{ left: pos.x, top: pos.y }} onContextMenu={e => e.preventDefault()}>
      {title && <div className="menu-title">{title}</div>}
      {items.map((it, i) => it.divider ? <div key={i} className="menu-div" /> : (
        <div key={i} className="menu-item-wrap">
          <button role="menuitem" className={`menu-item ${it.danger ? 'danger' : ''}`}
            onClick={() => { if (it.sub) setOpen(open === i ? null : i); else { it.onClick?.(); onClose(); } }}>
            <span>{it.label}</span>{it.hint && <kbd>{it.hint}</kbd>}{it.sub && <span className="caret">{open === i ? '▾' : '▸'}</span>}
          </button>
          {it.sub && open === i && (
            <div className="menu-sub">
              {it.sub.map((s, k) => (
                <button key={k} role="menuitem" className="menu-item" onClick={() => { s.onClick?.(); onClose(); }}>
                  <span>{s.label}</span>{s.hint && <kbd>{s.hint}</kbd>}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [onClose]);
  return (
    <div className="modal-back" onPointerDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head"><h2>{title}</h2><button className="btn ghost" onClick={onClose} aria-label="Fechar">Fechar</button></header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
