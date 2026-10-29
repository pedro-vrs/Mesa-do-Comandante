import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Action, CardInst, CardData, GameView, PlayerState, Step, ZoneName } from '../shared/types';
import { STEPS, STEP_LABEL, ZONE_LABEL } from '../shared/types';
import { commanderIdentity, isLand, isType, warnings } from '../shared/game';
import { MANA, MANA_NAME, manaOptions, parseCost, poolTotal, type Mana } from '../shared/mana';
import { getPref, setPref } from './decks';
import type { Room } from './net';
import { CardFace, CardOverlays } from './Card';
import { ContextMenu, MenuItem, Modal } from './Menu';
import { searchTokens } from './scryfall';

type MenuState = { x: number; y: number; title?: string; items: MenuItem[] } | null;
type ZoneModal = { kind: 'zone'; playerId: string; zone: 'graveyard' | 'exile' } | { kind: 'peek'; cards: CardInst[]; all: boolean } | { kind: 'token' } | { kind: 'preview'; c: CardInst } | { kind: 'ask'; title: string; label: string; initial: string; onOk: (v: string) => void } | null;

interface Drag { iid: string; sx: number; sy: number; ox: number; oy: number; w: number; h: number; moved: boolean; pointerId: number; timer?: number }

export function Table({ room }: { room: Room }) {
  const v = room.view!;
  const { send } = room;
  const me = v.players.find(p => p.id === v.you);
  const [menu, setMenu] = useState<MenuState>(null);
  const [modal, setModal] = useState<ZoneModal>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreview] = useState<CardInst | null>(null);
  const [attachFrom, setAttachFrom] = useState<string | null>(null);
  const [ghost, setGhost] = useState<{ iid: string; x: number; y: number; w: number; h: number } | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [oppFocus, setOppFocus] = useState(0);
  const [sideOpen, setSideOpen] = useState(getPref('side', 'open') !== 'closed');
  const lastPointer = useRef({ x: innerWidth / 2, y: innerHeight / 2 });
  const drag = useRef<Drag | null>(null);
  const hovered = useRef<string | null>(null);

  const warns = useMemo(() => warnings(v), [v]);
  const warnIds = useMemo(() => new Set(warns.map(w => w.iid).filter(Boolean) as string[]), [warns]);
  const mainPlayer = me ?? v.players[0];
  const others = v.players.filter(p => p.id !== mainPlayer.id);
  // ordem de assento a partir de mim
  const seatOrder = useMemo(() => {
    const i = v.players.findIndex(p => p.id === mainPlayer.id);
    return [...v.players.slice(i + 1), ...v.players.slice(0, i)];
  }, [v.players, mainPlayer.id]);

  const act = useCallback((a: Action) => send(a), [send]);
  const ask = (title: string, label: string, initial: string, onOk: (v: string) => void) => setModal({ kind: 'ask', title, label, initial, onOk });
  const toggleSide = () => setSideOpen(o => { setPref('side', o ? 'closed' : 'open'); return !o; });

  /** Conjurar: vai para a pilha; com as regras ligadas o custo é pago sozinho. Pergunta X quando tem. */
  const cast = (c: CardInst) => {
    if (v.settings.enforce && parseCost(c.data.manaCost).x)
      ask(`Conjurar ${c.data.name}`, 'Valor de X', '1', n => act({ type: 'move', iids: [c.iid], to: 'stack', xValue: Math.max(0, Math.floor(Number(n)) || 0) }));
    else act({ type: 'move', iids: [c.iid], to: 'stack' });
  };

  /** Virar: se a carta gera mais de uma cor, pergunta qual. */
  const tapCards = (iids: string[], x?: number, y?: number) => {
    if (iids.length === 1 && me && v.settings.enforce) {
      const c = v.cards[iids[0]];
      if (c && !c.tapped && c.controllerId === me.id) {
        const opts = manaOptions(c, commanderIdentity(v, me.id));
        if (opts.length > 1) {
          setMenu({
            x: x ?? lastPointer.current.x, y: y ?? lastPointer.current.y, title: `Virar ${c.data.name} para gerar`,
            items: [
              ...opts.map(o => ({ label: `Mana ${o.map(m => MANA_NAME[m]).join(' + ')}`, onClick: () => act({ type: 'tap', iids, mana: o.join('') }) })),
              { label: 'Só virar, sem gerar mana', onClick: () => act({ type: 'tap', iids, mana: '-' }) },
            ],
          });
          return;
        }
      }
    }
    act({ type: 'tap', iids });
  };

  const manaMenu = (x: number, y: number) => setMenu({
    x, y, title: 'Reserva de mana', items: [
      ...MANA.map(m => ({ label: `+1 ${MANA_NAME[m]}`, onClick: () => act({ type: 'addMana', mana: m, delta: 1 }) })),
      ...(me && poolTotal(me.pool as any) ? [{ divider: true, label: '' }, ...MANA.filter(m => me.pool[m]).map(m => ({ label: `−1 ${MANA_NAME[m]}`, onClick: () => act({ type: 'addMana', mana: m, delta: -1 }) }))] : []),
    ],
  });

  // ---------- menus ----------

  const moveItems = (iids: string[], from: ZoneName): MenuItem[] => {
    const to = (z: ZoneName, label: string, position?: 'top' | 'bottom', hint?: string): MenuItem | null =>
      z === from && !position ? null : { label, hint, onClick: () => act({ type: 'move', iids, to: z, position }) };
    return [
      to('hand', 'Para a mão', undefined, 'H'),
      to('graveyard', 'Para o cemitério', undefined, 'G'),
      to('exile', 'Exilar', undefined, 'X'),
      to('library', 'Topo do grimório', 'top'),
      to('library', 'Fundo do grimório', 'bottom'),
      to('command', 'Zona de comando'),
    ].filter(Boolean) as MenuItem[];
  };

  const openCardMenu = (c: CardInst, x: number, y: number) => {
    const mine = me && (c.zone === 'battlefield' || c.zone === 'stack' ? c.controllerId === me.id : c.ownerId === me.id);
    const iids = selected.includes(c.iid) && c.zone === 'battlefield' ? selected : [c.iid];
    const items: MenuItem[] = [];
    const name = c.faceDown && !mine ? 'Carta virada para baixo' : (c.transformed && c.data.backName) || c.data.name;
    if (!(c.faceDown && !mine)) items.push({ label: 'Ampliar', hint: 'V', onClick: () => setModal({ kind: 'preview', c }) });
    if (mine && me) {
      if (c.zone === 'battlefield') {
        items.push(
          { label: c.tapped ? 'Desvirar' : 'Virar', hint: 'T', onClick: () => tapCards(iids, x, y) },
          { label: 'Marcador +1/+1', hint: '+', onClick: () => act({ type: 'counter', iid: c.iid, kind: '+1/+1', delta: 1 }) },
          { label: 'Marcador −1/−1', hint: '−', onClick: () => act({ type: 'counter', iid: c.iid, kind: '-1/-1', delta: 1 }) },
          {
            label: 'Outros marcadores', sub: [
              ...Object.keys(c.counters).flatMap(k => [
                { label: `+1 ${k}`, onClick: () => act({ type: 'counter', iid: c.iid, kind: k, delta: 1 }) },
                { label: `−1 ${k}`, onClick: () => act({ type: 'counter', iid: c.iid, kind: k, delta: -1 }) },
              ]),
              ...(isType(c, 'planeswalker') && !('loyalty' in c.counters) ? [{ label: `Lealdade inicial (${c.data.loyalty ?? 0})`, onClick: () => act({ type: 'counter', iid: c.iid, kind: 'loyalty', delta: Number(c.data.loyalty ?? 0) || 1 }) }] : []),
              { label: 'Novo marcador…', onClick: () => ask('Novo marcador', 'Nome do marcador (ex.: lealdade, carga, tempo)', 'carga', k => act({ type: 'counter', iid: c.iid, kind: k, delta: 1 })) },
            ],
          },
          {
            label: 'P/R até o fim do turno', sub: [
              { label: '+1/+1', onClick: () => act({ type: 'pt', iid: c.iid, dp: 1, dt: 1 }) },
              { label: '−1/−1', onClick: () => act({ type: 'pt', iid: c.iid, dp: -1, dt: -1 }) },
              { label: '+1/+0', onClick: () => act({ type: 'pt', iid: c.iid, dp: 1, dt: 0 }) },
              { label: '+0/+1', onClick: () => act({ type: 'pt', iid: c.iid, dp: 0, dt: 1 }) },
              { label: 'Zerar modificador', onClick: () => act({ type: 'pt', iid: c.iid, dp: -c.ptMod[0], dt: -c.ptMod[1] }) },
            ],
          },
          { label: 'Habilidade na pilha…', hint: 'A', onClick: () => ask('Habilidade na pilha', 'O que a habilidade faz?', '', t => act({ type: 'ability', text: t, sourceIid: c.iid })) },
          ...(c.data.imageBack || c.data.backName ? [{ label: 'Transformar', hint: 'R', onClick: () => act({ type: 'transform', iid: c.iid }) }] : []),
          { label: c.faceDown ? 'Revelar' : 'Virar para baixo', hint: 'F', onClick: () => act({ type: 'faceDown', iid: c.iid }) },
          c.attachedTo
            ? { label: 'Desanexar', onClick: () => act({ type: 'attach', iid: c.iid, to: null }) }
            : { label: 'Anexar a…', onClick: () => { setAttachFrom(c.iid); room.setToast('Agora clique na carta que vai receber o anexo.'); } },
          { label: 'Criar cópia (token)', onClick: () => act({ type: 'clone', iid: c.iid }) },
          ...(others.length ? [{ label: 'Dar controle', sub: others.map(p => ({ label: p.name, onClick: () => act({ type: 'control', iid: c.iid, to: p.id }) })) }] : []),
          { divider: true, label: '' },
          ...moveItems(iids, 'battlefield'),
        );
      } else if (c.zone === 'hand') {
        items.push(
          { label: isLand(c) ? 'Baixar terreno' : 'Conjurar (pilha)', hint: 'duplo clique', onClick: () => playFromHand(c) },
          { label: 'Pôr direto no campo', onClick: () => act({ type: 'move', iids: [c.iid], to: 'battlefield', ...nextSpot(c) }) },
          { label: 'Jogar virada para baixo', onClick: () => act({ type: 'move', iids: [c.iid], to: 'battlefield', faceDown: true, ...nextSpot(c) }) },
          { label: 'Revelar', onClick: () => act({ type: 'reveal', iids: [c.iid] }) },
          { divider: true, label: '' },
          ...moveItems([c.iid], 'hand'),
        );
      } else if (c.zone === 'stack') {
        const top = v.stack.at(-1) === c.iid;
        if (top) items.push({ label: 'Resolver', onClick: () => act({ type: 'resolve' }) });
        items.push({ label: 'Para o campo', onClick: () => act({ type: 'move', iids: [c.iid], to: 'battlefield', ...nextSpot(c) }) }, ...moveItems([c.iid], 'stack'));
      } else {
        items.push(
          { label: c.zone === 'command' && c.isCommander ? `Conjurar (imposto +${(me.cmdCasts[c.iid] ?? 0) * 2})` : 'Conjurar (pilha)', onClick: () => cast(c) },
          { label: 'Pôr direto no campo', onClick: () => act({ type: 'move', iids: [c.iid], to: 'battlefield', ...nextSpot(c) }) },
          ...moveItems([c.iid], c.zone),
        );
      }
    }
    if (me && c.isCommander && c.ownerId !== me.id) {
      items.push({ divider: true, label: '' },
        { label: 'Sofri dano deste comandante', sub: [1, 2, 3, 5, 10].map(n => ({ label: `+${n}`, onClick: () => act({ type: 'cmdDamage', commanderIid: c.iid, delta: n }) })) });
    }
    if (items.length) setMenu({ x, y, title: name, items });
  };

  const nextSpot = (c: CardInst) => {
    if (!me) return {};
    const mine = v.battlefield.map(i => v.cards[i]).filter(x => x && x.controllerId === me.id);
    const land = isLand(c);
    const row = mine.filter(x => isLand(x) === land).length;
    return { x: 0.02 + (row % 12) * 0.08, y: land ? 0.72 - Math.floor(row / 12) * 0.08 : 0.06 + Math.floor(row / 12) * 0.1 };
  };

  const playFromHand = (c: CardInst) => {
    if (isLand(c)) act({ type: 'move', iids: [c.iid], to: 'battlefield', ...nextSpot(c) });
    else cast(c);
  };

  const libraryMenu = (x: number, y: number) => {
    if (!me) return;
    setMenu({
      x, y, title: `Grimório (${me.zones.library.length})`, items: [
        { label: 'Comprar 1', hint: 'D', onClick: () => act({ type: 'draw', n: 1 }) },
        { label: 'Comprar…', onClick: () => ask('Comprar cartas', 'Quantas?', '2', n => act({ type: 'draw', n: Number(n) || 1 })) },
        { label: 'Embaralhar', hint: 'S', onClick: () => act({ type: 'shuffle' }) },
        { label: 'Olhar o topo…', onClick: () => ask('Olhar o topo', 'Quantas cartas?', '3', async n => { const cards = await room.peek(Number(n) || 1); if (cards.length) setModal({ kind: 'peek', cards, all: false }); }) },
        { label: 'Procurar no grimório', onClick: async () => { const cards = await room.peek(-1); if (cards.length) setModal({ kind: 'peek', cards, all: true }); } },
        { divider: true, label: '' },
        { label: 'Mulligan (compra 7 novas)', onClick: () => { if (confirm('Embaralhar a mão no grimório e comprar 7?')) act({ type: 'mulligan' }); } },
      ],
    });
  };

  // ---------- arrastar e soltar ----------

  const onCardPointerDown = (e: React.PointerEvent, c: CardInst) => {
    if (e.button === 2) return;
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    const d: Drag = { iid: c.iid, sx: e.clientX, sy: e.clientY, ox: e.clientX - r.left, oy: e.clientY - r.top, w: r.width, h: r.height, moved: false, pointerId: e.pointerId };
    if (e.pointerType !== 'mouse') {
      d.timer = window.setTimeout(() => { if (drag.current && !drag.current.moved) { drag.current = null; openCardMenu(c, e.clientX, e.clientY); } }, 480);
    }
    drag.current = d;
  };

  useEffect(() => {
    const move = (e: PointerEvent) => {
      lastPointer.current = { x: e.clientX, y: e.clientY };
      const d = drag.current;
      if (!d || e.pointerId !== d.pointerId) return;
      if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 6) { d.moved = true; clearTimeout(d.timer); }
      if (d.moved) setGhost({ iid: d.iid, x: e.clientX - d.ox, y: e.clientY - d.oy, w: d.w, h: d.h });
    };
    const up = (e: PointerEvent) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.pointerId) return;
      clearTimeout(d.timer);
      drag.current = null; setGhost(null);
      const c = room.view?.cards[d.iid];
      if (!c) return;
      if (!d.moved) { clickCard(c, e.shiftKey || e.metaKey || e.ctrlKey); return; }
      const under = document.elementsFromPoint(e.clientX, e.clientY).map(n => (n as HTMLElement).closest?.('[data-drop]') as HTMLElement | null).find(Boolean);
      if (!under) return;
      const zone = under.dataset.drop as ZoneName;
      const owner = under.dataset.owner;
      if (zone === 'battlefield') {
        const r = under.getBoundingClientRect();
        const x = (e.clientX - d.ox - r.left) / Math.max(1, r.width - d.w);
        const y = (e.clientY - d.oy - r.top) / Math.max(1, r.height - d.h);
        const toPlayer = owner && owner !== me?.id ? owner : undefined;
        // com regras ligadas, soltar uma mágica no campo é conjurar
        if (v.settings.enforce && (c.zone === 'hand' || c.zone === 'command') && !isLand(c)) { cast(c); return; }
        if (c.zone === 'battlefield' && toPlayer && c.controllerId === me?.id) {
          act({ type: 'control', iid: c.iid, to: toPlayer }).then(() => act({ type: 'move', iids: [c.iid], to: 'battlefield', x, y }));
          return;
        }
        const ids = c.zone === 'battlefield' && selected.includes(c.iid) ? selected : [c.iid];
        if (ids.length > 1) {
          // move o grupo mantendo as distâncias
          const dx = x - c.x, dy = y - c.y;
          ids.forEach(i => { const o = room.view!.cards[i]; if (o) act({ type: 'move', iids: [i], to: 'battlefield', x: o.x + dx, y: o.y + dy }); });
        } else act({ type: 'move', iids: ids, to: 'battlefield', x, y, toPlayer });
      } else if (zone === 'library') {
        act({ type: 'move', iids: [c.iid], to: 'library', position: e.altKey ? 'bottom' : 'top' });
      } else if (zone !== c.zone || zone === 'hand') {
        if (zone !== c.zone) act({ type: 'move', iids: selected.includes(c.iid) && c.zone === 'battlefield' ? selected : [c.iid], to: zone });
      }
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
    return () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up); };
  });

  const clickCard = (c: CardInst, multi: boolean) => {
    if (attachFrom) {
      if (attachFrom !== c.iid) act({ type: 'attach', iid: attachFrom, to: c.iid });
      setAttachFrom(null); return;
    }
    if (c.zone !== 'battlefield') { setSelected([]); return; }
    setSelected(s => multi ? (s.includes(c.iid) ? s.filter(x => x !== c.iid) : [...s, c.iid]) : (s.length === 1 && s[0] === c.iid ? [] : [c.iid]));
  };

  const dblCard = (c: CardInst) => {
    if (!me) return;
    if (c.zone === 'battlefield' && c.controllerId === me.id) tapCards(selected.includes(c.iid) ? selected : [c.iid]);
    else if (c.zone === 'hand' && c.ownerId === me.id) playFromHand(c);
    else if (c.zone === 'command' && c.ownerId === me.id) cast(c);
  };

  // ---------- teclado ----------

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [role=dialog]') || !me) return;
      const h = hovered.current ? room.view?.cards[hovered.current] : undefined;
      const mineH = h && (h.zone === 'battlefield' ? h.controllerId === me.id : h.ownerId === me.id);
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); room.undo(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const targets = h && selected.includes(h.iid) ? selected : h ? [h.iid] : selected;
      switch (k) {
        case 'd': act({ type: 'draw', n: 1 }); break;
        case 's': act({ type: 'shuffle' }); break;
        case 'u': act({ type: 'untapAll' }); break;
        case 'n': act({ type: 'nextStep' }); break;
        case 'e': act({ type: 'endTurn' }); break;
        case 'k': setModal({ kind: 'token' }); break;
        case ' ': if (v.settings.priority) { e.preventDefault(); act({ type: 'pass' }); } break;
        case 't': if (targets.length && (mineH || !h)) tapCards(targets); break;
        case 'v': if (h) setModal({ kind: 'preview', c: h }); break;
        case 'f': if (h && mineH) act({ type: 'faceDown', iid: h.iid }); break;
        case 'r': if (h && mineH) act({ type: 'transform', iid: h.iid }); break;
        case 'g': if (targets.length && (mineH || !h)) act({ type: 'move', iids: targets, to: 'graveyard' }); break;
        case 'x': if (targets.length && (mineH || !h)) act({ type: 'move', iids: targets, to: 'exile' }); break;
        case 'h': if (targets.length && (mineH || !h)) act({ type: 'move', iids: targets, to: 'hand' }); break;
        case 'a': if (h && mineH) ask('Habilidade na pilha', 'O que a habilidade faz?', '', txt => act({ type: 'ability', text: txt, sourceIid: h.iid })); break;
        case '+': case '=': if (h && mineH) act({ type: 'counter', iid: h.iid, kind: '+1/+1', delta: 1 }); break;
        case '-': if (h && mineH) act({ type: 'counter', iid: h.iid, kind: '-1/-1', delta: 1 }); break;
        case 'escape': setSelected([]); setAttachFrom(null); break;
        default: return;
      }
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  });

  // ---------- render ----------

  const cardProps = (c: CardInst) => ({
    onPointerDown: (e: React.PointerEvent) => onCardPointerDown(e, c),
    onDoubleClick: () => dblCard(c),
    onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); openCardMenu(c, e.clientX, e.clientY); },
    onPointerEnter: () => { hovered.current = c.iid; if (!(c.faceDown && c.controllerId !== v.you) && c.data.sid !== 'hidden') setPreview(c); },
    onPointerLeave: () => { if (hovered.current === c.iid) hovered.current = null; },
  });

  const prompts = me?.prompts ?? [];
  const winner = v.winnerId ? v.players.find(p => p.id === v.winnerId) : null;
  const focusOpp = seatOrder[Math.min(oppFocus, seatOrder.length - 1)];

  return (
    <div className={`table ${attachFrom ? 'attaching' : ''} ${sideOpen ? '' : 'side-closed'} opp-${Math.min(seatOrder.length, 5)}`} onContextMenu={e => e.preventDefault()}>
      <div className="opponents">
        {seatOrder.length > 1 && (
          <div className="opp-tabs" role="tablist" aria-label="Oponentes">
            {seatOrder.map((p, i) => <button key={p.id} role="tab" aria-selected={p.id === focusOpp?.id} style={{ '--seat': p.color } as any} onClick={() => setOppFocus(i)}>{p.name} <b>{p.life}</b></button>)}
          </div>
        )}
        {seatOrder.map(p => (
          <Mat key={p.id} p={p} v={v} compact me={me} focused={p.id === focusOpp?.id} warnIds={warnIds} selected={selected} cardProps={cardProps} act={act}
            onZone={(zone) => setModal({ kind: 'zone', playerId: p.id, zone })} onLibrary={() => {}} />
        ))}
      </div>

      <TurnRail v={v} me={me} act={act}>
        {!sideOpen && (
          <button className="btn side-tab" onClick={toggleSide} title="Mostrar a barra lateral">
            Pilha e registro{(v.stack.length > 0 || prompts.length > 0) && <b>{v.stack.length || '!'}</b>}
          </button>
        )}
      </TurnRail>

      <Mat p={mainPlayer} v={v} me={me} focused warnIds={warnIds} selected={selected} cardProps={cardProps} act={act}
        onZone={(zone) => setModal({ kind: 'zone', playerId: mainPlayer.id, zone })} onLibrary={libraryMenu} onMana={manaMenu} isMain />

      {me && (
        <div className="hand" data-drop="hand" data-owner={me.id}>
          <div className="hand-cards">
            {me.zones.hand.map(iid => {
              const c = v.cards[iid];
              if (!c) return null;
              return (
                <div key={iid} className={`card in-hand ${ghost?.iid === iid ? 'dragging' : ''}`} {...cardProps(c)} tabIndex={0} aria-label={c.data.name}
                  onKeyDown={e => { if (e.key === 'Enter') playFromHand(c); }}>
                  <CardFace c={c} />
                </div>
              );
            })}
            {me.zones.hand.length === 0 && <span className="muted hand-empty">Mão vazia</span>}
          </div>
          <div className="my-piles">
            <Piles p={me} v={v} isMe onZone={zone => setModal({ kind: 'zone', playerId: me.id, zone })} onLibrary={libraryMenu} />
          </div>
          <div className="hand-tools">
            <button className="btn ghost" onClick={() => setModal({ kind: 'token' })} title="Criar token (K)">Token</button>
            <button className="btn ghost" onClick={() => ask('Habilidade na pilha', 'O que a habilidade faz?', '', t => act({ type: 'ability', text: t }))}>Habilidade</button>
            <button className="btn ghost" onClick={() => act({ type: 'untapAll' })} title="Desvirar tudo (U)">Desvirar tudo</button>
            <button className="btn ghost" onClick={room.undo} disabled={!v.canUndo} title="Desfazer (Ctrl+Z)">Desfazer</button>
          </div>
          <div className="hand-tools-mobile">
            <button className="btn" onClick={() => setDrawer(d => !d)}>
              Pilha{v.stack.length ? ` (${v.stack.length})` : ''}{prompts.length || warns.length ? ' •' : ''}
            </button>
            <button className="btn ghost" onClick={e => setMenu({
              x: e.clientX, y: e.clientY, title: 'Mais ações', items: [
                { label: 'Criar token', onClick: () => setModal({ kind: 'token' }) },
                { label: 'Habilidade na pilha', onClick: () => ask('Habilidade na pilha', 'O que a habilidade faz?', '', t => act({ type: 'ability', text: t })) },
                { label: 'Desvirar tudo', onClick: () => act({ type: 'untapAll' }) },
                ...(v.canUndo ? [{ label: 'Desfazer', onClick: room.undo }] : []),
                ...(me.id === v.hostId ? [{ label: v.settings.enforce ? 'Desligar regras de turno e mana' : 'Ligar regras de turno e mana', onClick: () => act({ type: 'settings', settings: { enforce: !v.settings.enforce } }) }] : []),
              ],
            })}>Mais</button>
          </div>
        </div>
      )}

      <aside className={`side ${drawer ? 'open' : ''}`} aria-label="Pilha e registro">
        <div className="side-head">
          <button className={`rules-chip ${v.settings.enforce ? 'on' : ''}`} disabled={me?.id !== v.hostId}
            onClick={() => act({ type: 'settings', settings: { enforce: !v.settings.enforce } })}
            title={me?.id === v.hostId ? 'Clique para ligar ou desligar' : 'Só o anfitrião muda'}>
            Regras de turno e mana: {v.settings.enforce ? 'ligadas' : 'desligadas'}
          </button>
          <button className="btn ghost small side-collapse" onClick={toggleSide} title="Recolher a barra lateral">Recolher</button>
          <button className="btn ghost small side-close" onClick={() => setDrawer(false)}>Fechar</button>
        </div>
        <Stack v={v} me={me} act={act} cardProps={cardProps} />
        {prompts.map(pr => {
          const c = v.cards[pr.iid];
          return (
            <div key={pr.id} className="prompt" role="alert">
              <p><b>{c?.data.name ?? 'Seu comandante'}</b> foi para {ZONE_LABEL[pr.from]}. Voltar para a zona de comando?</p>
              <div className="row">
                <button className="btn primary" onClick={() => act({ type: 'prompt', promptId: pr.id, accept: true })}>Voltar</button>
                <button className="btn ghost" onClick={() => act({ type: 'prompt', promptId: pr.id, accept: false })}>Deixar</button>
              </div>
            </div>
          );
        })}
        {warns.length > 0 && (
          <div className="warns">
            <h3>Conferir</h3>
            <ul>{warns.map((w, i) => <li key={i} onPointerEnter={() => w.iid && setPreview(v.cards[w.iid])}>{w.text}</li>)}</ul>
          </div>
        )}
        <Log v={v} act={act} canChat={!!me} />
        {preview && <div className="preview" aria-hidden="true"><CardFace c={preview} /><CardOverlays c={preview} /></div>}
      </aside>
      {drawer && <div className="drawer-back" onPointerDown={() => setDrawer(false)} />}


      {ghost && v.cards[ghost.iid] && (
        <div className="card ghost" style={{ left: ghost.x, top: ghost.y, width: ghost.w, height: ghost.h }}><CardFace c={v.cards[ghost.iid]} /></div>
      )}

      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}

      {modal?.kind === 'zone' && <ZoneView v={v} me={me} playerId={modal.playerId} zone={modal.zone} onClose={() => setModal(null)} openMenu={openCardMenu} />}
      {modal?.kind === 'peek' && <PeekView cards={modal.cards} all={modal.all} act={act} onClose={() => setModal(null)} />}
      {modal?.kind === 'token' && <TokenMaker act={act} onClose={() => setModal(null)} />}
      {modal?.kind === 'preview' && (
        <Modal title={modal.c.data.name} onClose={() => setModal(null)}>
          <div className="big-preview"><CardFace c={modal.c} />{modal.c.data.imageBack && <img className="face" src={modal.c.data.imageBack} alt={modal.c.data.backName} />}</div>
          {modal.c.data.oracle && <p className="oracle">{modal.c.data.oracle}</p>}
        </Modal>
      )}
      {modal?.kind === 'ask' && <AskModal {...modal} onClose={() => setModal(null)} />}

      {v.phase === 'over' && (
        <div className="game-over" role="dialog" aria-label="Fim de partida">
          <p className="go-title">{winner ? `${winner.name} venceu` : 'Empate'}</p>
          <p className="muted">Turno {v.turn.number}</p>
          {me?.id === v.hostId ? <button className="btn primary big" onClick={() => act({ type: 'restart' })}>Nova partida com os mesmos decks</button>
            : <p className="muted">Quem criou a mesa pode começar outra partida.</p>}
        </div>
      )}

      {room.toast && (
        <div className={`toast ${room.toast.retry ? 'has-action' : ''}`} role="status">
          <span>{room.toast.text}</span>
          {room.toast.retry && <span className="toast-actions">
            <button className="btn primary small" onClick={room.toast.retry}>Fazer assim mesmo</button>
            <button className="btn ghost small" onClick={() => room.setToast(null)}>Cancelar</button>
          </span>}
        </div>
      )}
      {room.status === 'offline' && <div className="toast warn" role="status">Sem conexão com a mesa. Tentando reconectar…</div>}
    </div>
  );
}

// ---------- tapete de um jogador ----------

type CardPropsFn = (c: CardInst) => Record<string, any>;

function Mat({ p, v, me, compact, focused, isMain, warnIds, selected, cardProps, act, onZone, onLibrary, onMana }: {
  p: PlayerState; v: GameView; me?: PlayerState; compact?: boolean; focused?: boolean; isMain?: boolean; warnIds: Set<string>; selected: string[];
  cardProps: CardPropsFn; act: (a: Action) => Promise<boolean>; onZone: (z: 'graveyard' | 'exile') => void; onLibrary: (x: number, y: number) => void;
  onMana?: (x: number, y: number) => void;
}) {
  const isMe = me?.id === p.id;
  const active = v.turn.activeId === p.id;
  const perms = v.battlefield.map(i => v.cards[i]).filter(c => c && c.controllerId === p.id);
  const byId = new Map(perms.map(c => [c.iid, c]));
  // comandantes dos outros que podem me causar dano
  const enemyCmds = isMe ? Object.values(v.cards).filter(c => c.isCommander && c.ownerId !== p.id) : [];
  const dmgTaken = Object.entries(p.cmdDamage).filter(([, n]) => n > 0);

  return (
    <section className={`mat ${compact ? 'compact' : 'main'} ${focused ? 'focused' : ''} ${active ? 'active' : ''} ${p.lost ? 'lost' : ''}`} style={{ '--seat': p.color } as any} aria-label={`Mesa de ${p.name}`}>
      <header className="mat-head">
        <div className="who">
          <span className="seat-dot" aria-hidden="true" />
          <strong>{p.name}</strong>
          {!p.connected && <span className="tag">desconectado</span>}
          {p.lost && <span className="tag bad">{p.lossReason ?? 'fora'}</span>}
          {active && <span className="tag turn">turno</span>}
          {v.settings.priority && v.turn.priorityId === p.id && <span className="tag prio">prioridade</span>}
        </div>
        <div className="life" aria-label={`Vida ${p.life}`}>
          {isMe && <button className="life-btn" onClick={() => act({ type: 'life', delta: -1 })} onContextMenu={e => { e.preventDefault(); act({ type: 'life', delta: -5 }); }} aria-label="Perder 1 de vida (clique direito: 5)">−</button>}
          <span className={`life-num ${p.life <= 10 ? 'low' : ''}`}>{p.life}</span>
          {isMe && <button className="life-btn" onClick={() => act({ type: 'life', delta: 1 })} onContextMenu={e => { e.preventDefault(); act({ type: 'life', delta: 5 }); }} aria-label="Ganhar 1 de vida (clique direito: 5)">+</button>}
        </div>
        <div className="stats">
          <Stat label="veneno" value={p.poison} danger={p.poison >= 7} onPlus={isMe ? () => act({ type: 'playerCounter', kind: 'poison', delta: 1 }) : undefined} onMinus={isMe ? () => act({ type: 'playerCounter', kind: 'poison', delta: -1 }) : undefined} hideZero={!isMe} />
          {Object.entries(p.counters).filter(([k, n]) => k !== 'mulligan' && n > 0).map(([k, n]) => <Stat key={k} label={k} value={n} onPlus={isMe ? () => act({ type: 'playerCounter', kind: k, delta: 1 }) : undefined} onMinus={isMe ? () => act({ type: 'playerCounter', kind: k, delta: -1 }) : undefined} />)}
          {(poolTotal(p.pool as any) > 0 || (isMe && v.settings.enforce)) && (
            <span className="pool" aria-label="Reserva de mana">
              {MANA.filter(m => p.pool[m] > 0).map(m => <span key={m} className={`mana m-${m}`} title={`Mana ${MANA_NAME[m]}`}>{p.pool[m]}</span>)}
              {isMe && onMana && <button className="pool-add" onClick={e => onMana(e.clientX, e.clientY)} title="Adicionar mana à mão (para cartas que a mesa não lê)" aria-label="Ajustar reserva de mana">{poolTotal(p.pool as any) ? '±' : 'mana ±'}</button>}
            </span>
          )}
          {isMe && v.settings.enforce && active && <span className={`chip ${p.landsPlayed >= 1 ? 'used' : ''}`} title="Terrenos baixados neste turno">terreno {p.landsPlayed}/1</span>}
          {!isMe && dmgTaken.map(([cid, n]) => <span key={cid} className={`chip ${n >= 15 ? 'hot' : ''}`} title={`Dano de ${v.cards[cid]?.data.name}`}>{shortName(v.cards[cid]?.data.name)} {n}/21</span>)}
        </div>
        {isMe && enemyCmds.length > 0 && (
          <div className="cmd-dmg" aria-label="Dano de comandante sofrido">
            {enemyCmds.map(c => {
              const n = p.cmdDamage[c.iid] ?? 0;
              const owner = v.players.find(q => q.id === c.ownerId);
              return (
                <span key={c.iid} className={`chip cmd ${n >= 15 ? 'hot' : ''}`} style={{ '--seat': owner?.color } as any} title={`Dano de ${c.data.name}`}>
                  <button onClick={() => act({ type: 'cmdDamage', commanderIid: c.iid, delta: -1 })} aria-label={`Menos 1 de dano de ${c.data.name}`}>−</button>
                  {enemyCmds.filter(o => o.data.name === c.data.name).length > 1 ? owner?.name : shortName(c.data.name)} <b>{n}</b>/21
                  <button onClick={() => act({ type: 'cmdDamage', commanderIid: c.iid, delta: 1 })} aria-label={`Mais 1 de dano de ${c.data.name}`}>+</button>
                </span>
              );
            })}
          </div>
        )}
      </header>

      <div className="mat-body">
        <div className="battlefield" data-drop="battlefield" data-owner={p.id}>
          {perms.map((c, idx) => {
            const host = c.attachedTo ? byId.get(c.attachedTo) : undefined;
            const x = host ? host.x : c.x, y = host ? host.y : c.y;
            const style = {
              '--x': x, '--y': y, zIndex: host ? idx : idx + 100,
              ...(host ? { translate: '-10% -16%' } : {}),
            } as any;
            return (
              <div key={c.iid} className={`card on-field ${c.tapped ? 'tapped' : ''} ${selected.includes(c.iid) ? 'selected' : ''} ${warnIds.has(c.iid) ? 'warn' : ''} ${c.controllerId !== c.ownerId ? 'stolen' : ''}`}
                style={style} {...cardProps(c)} tabIndex={0} aria-label={c.faceDown ? 'Carta virada para baixo' : c.data.name}>
                <CardFace c={c} />
                <CardOverlays c={c} />
              </div>
            );
          })}
          {perms.length === 0 && isMain && isMe && <p className="field-empty">Arraste cartas da mão para cá. Duplo clique numa carta da mão para conjurar; num terreno, para baixar.</p>}
        </div>

        <div className="zones">
          <div className="zone command" data-drop={isMe ? 'command' : undefined} title="Zona de comando">
            {p.zones.command.map(iid => {
              const c = v.cards[iid];
              if (!c) return null;
              const tax = (p.cmdCasts[iid] ?? 0) * 2;
              return (
                <div key={iid} className="card in-zone" {...cardProps(c)} tabIndex={0} aria-label={`${c.data.name}, imposto ${tax}`}>
                  <CardFace c={c} />
                  {c.isCommander && <span className="tax" title="Imposto de comandante">+{tax}</span>}
                </div>
              );
            })}
            {p.zones.command.length === 0 && <span className="zone-label">comando</span>}
          </div>
          {!(isMain && isMe) && <Piles p={p} v={v} isMe={isMe} onZone={onZone} onLibrary={onLibrary} />}
        </div>
      </div>
    </section>
  );
}

/** Grimório, mão (dos outros), cemitério e exílio. Os meus ficam na barra da mão. */
function Piles({ p, v, isMe, onZone, onLibrary }: { p: PlayerState; v: GameView; isMe: boolean; onZone: (z: 'graveyard' | 'exile') => void; onLibrary: (x: number, y: number) => void }) {
  const topGy = p.zones.graveyard[0] ? v.cards[p.zones.graveyard[0]] : undefined;
  return (
    <>
      <button className="zone pile library" data-drop={isMe ? 'library' : undefined} onClick={e => isMe && onLibrary(e.clientX, e.clientY)} aria-label={`Grimório, ${p.zones.library.length} cartas`} disabled={!isMe} title={isMe ? 'Clique para comprar, embaralhar, olhar o topo' : undefined}>
        <div className="face back"><span /></div><b className="count">{p.zones.library.length}</b><span className="zone-label">grimório</span>
      </button>
      {!isMe && <div className="zone pile hand-count" aria-label={`Mão, ${p.zones.hand.length} cartas`}><span className="count">{p.zones.hand.length}</span><span className="zone-label">mão</span></div>}
      <button className="zone pile" data-drop={isMe ? 'graveyard' : undefined} onClick={() => onZone('graveyard')} aria-label={`Cemitério, ${p.zones.graveyard.length} cartas`}>
        {topGy ? <CardFace c={topGy} /> : <div className="face empty" />}<b className="count">{p.zones.graveyard.length}</b><span className="zone-label">cemitério</span>
      </button>
      <button className="zone pile" data-drop={isMe ? 'exile' : undefined} onClick={() => onZone('exile')} aria-label={`Exílio, ${p.zones.exile.length} cartas`}>
        <div className="face empty exile" /><b className="count">{p.zones.exile.length}</b><span className="zone-label">exílio</span>
      </button>
    </>
  );
}

function shortName(n?: string) { return (n ?? '?').split(/[,\s]/)[0]; }

function Stat({ label, value, onPlus, onMinus, danger, hideZero }: { label: string; value: number; onPlus?: () => void; onMinus?: () => void; danger?: boolean; hideZero?: boolean }) {
  if (hideZero && !value) return null;
  return (
    <span className={`chip ${danger ? 'hot' : ''}`}>
      {onMinus && <button onClick={onMinus} aria-label={`Menos 1 ${label}`}>−</button>}
      {label} <b>{value}</b>
      {onPlus && <button onClick={onPlus} aria-label={`Mais 1 ${label}`}>+</button>}
    </span>
  );
}

// ---------- régua de turno ----------

function TurnRail({ v, me, act, children }: { v: GameView; me?: PlayerState; act: (a: Action) => Promise<boolean>; children?: React.ReactNode }) {
  const active = v.players.find(p => p.id === v.turn.activeId);
  const mine = me?.id === v.turn.activeId;
  const prio = v.players.find(p => p.id === v.turn.priorityId);
  return (
    <nav className="rail" aria-label="Passos do turno" style={{ '--seat': active?.color } as any}>
      <div className="rail-who"><span className="seat-dot" />Turno {v.turn.number} · <strong>{active?.name}</strong></div>
      <ol className="steps">
        {STEPS.map(s => (
          <li key={s}>
            <button className={`step ${v.turn.step === s ? 'now' : ''} ${STEPS.indexOf(s) < STEPS.indexOf(v.turn.step) ? 'done' : ''}`}
              disabled={!mine} onClick={() => act({ type: 'setStep', step: s as Step })} aria-current={v.turn.step === s ? 'step' : undefined} title={STEP_LABEL[s]}>
              {STEP_LABEL[s]}
            </button>
          </li>
        ))}
      </ol>
      <div className="rail-actions">
        {v.settings.priority && me && (
          <button className="btn prio-btn" disabled={v.turn.priorityId !== me.id} onClick={() => act({ type: 'pass' })} title="Passar prioridade (espaço)">
            {v.turn.priorityId === me.id ? 'Passar prioridade' : `Prioridade: ${prio?.name}`}
          </button>
        )}
        {mine && <button className="btn" onClick={() => act({ type: 'nextStep' })} title="Próximo passo (N)">Próximo passo</button>}
        {mine && <button className="btn primary" onClick={() => act({ type: 'endTurn' })} title="Passar a vez (E)">Passar a vez</button>}
        {children}
      </div>
    </nav>
  );
}

// ---------- pilha ----------

function Stack({ v, me, act, cardProps }: { v: GameView; me?: PlayerState; act: (a: Action) => Promise<boolean>; cardProps: CardPropsFn }) {
  const items = [...v.stack].reverse();
  return (
    <div className="stack" data-drop="stack" aria-label="Pilha">
      <h3>Pilha {items.length > 0 && <span className="muted">({items.length})</span>}</h3>
      <p className="muted small stack-help">
        {items.length === 0
          ? 'Quando alguém conjura uma mágica ou ativa uma habilidade, ela espera aqui até resolver. Nada esperando agora.'
          : 'Esperando para resolver. A de cima resolve primeiro; antes disso, qualquer um pode responder.'}
      </p>
      {items.length > 0 && (
        <ol>
          {items.map((iid, i) => {
            const c = v.cards[iid];
            if (!c) return null;
            const owner = v.players.find(p => p.id === c.controllerId);
            return (
              <li key={iid} className={i === 0 ? 'top' : ''} style={{ '--seat': owner?.color } as any}>
                <div className="card in-stack" {...cardProps(c)}><CardFace c={c} /></div>
                <div className="stack-meta">
                  <strong>{c.data.name}</strong>
                  <span className="muted small">{owner?.name}</span>
                  {i === 0 && me && <button className="btn small primary" onClick={() => act({ type: 'resolve' })}>Resolver</button>}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

// ---------- log e chat ----------

function Log({ v, act, canChat }: { v: GameView; act: (a: Action) => Promise<boolean>; canChat: boolean }) {
  const ref = useRef<HTMLOListElement>(null);
  const [text, setText] = useState('');
  const [filter, setFilter] = useState<'all' | 'game' | 'chat'>(() => (getPref('logFilter', 'all') as any));
  const pick = (f: typeof filter) => { setFilter(f); setPref('logFilter', f); };
  const shown = v.log.filter(l => filter === 'all' || (filter === 'chat' ? l.kind === 'chat' : l.kind !== 'chat')).slice(-150);
  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight }); }, [shown.length, filter]);
  const color = (pid?: string) => v.players.find(p => p.id === pid)?.color;
  const labels = { all: 'Tudo', game: 'Jogo', chat: 'Chat' } as const;
  return (
    <div className="log">
      <div className="log-head">
        <h3>Registro</h3>
        <div className="seg" role="tablist" aria-label="Filtrar registro">
          {(['all', 'game', 'chat'] as const).map(f => (
            <button key={f} role="tab" aria-selected={filter === f} onClick={() => pick(f)}>{labels[f]}</button>
          ))}
        </div>
      </div>
      <ol ref={ref} aria-live="polite">
        {shown.map(l => <li key={l.id} className={l.kind === 'chat' ? 'chat' : ''} style={{ '--seat': color(l.playerId) ?? 'transparent' } as any}>{l.text}</li>)}
        {shown.length === 0 && <li className="muted">{filter === 'chat' ? 'Ninguém falou nada ainda.' : 'Nada por aqui ainda.'}</li>}
      </ol>
      {canChat && (
        <form onSubmit={e => { e.preventDefault(); if (text.trim()) { act({ type: 'chat', text }); setText(''); } }}>
          <input value={text} onChange={e => setText(e.target.value)} placeholder="Mensagem para a mesa" aria-label="Mensagem" />
        </form>
      )}
    </div>
  );
}

// ---------- janelas ----------

function ZoneView({ v, me, playerId, zone, onClose, openMenu }: { v: GameView; me?: PlayerState; playerId: string; zone: 'graveyard' | 'exile'; onClose: () => void; openMenu: (c: CardInst, x: number, y: number) => void }) {
  const p = v.players.find(q => q.id === playerId)!;
  const cards = p.zones[zone].map(i => v.cards[i]).filter(Boolean);
  return (
    <Modal title={`${ZONE_LABEL[zone][0].toUpperCase()}${ZONE_LABEL[zone].slice(1)} de ${p.name} (${cards.length})`} onClose={onClose} wide>
      {cards.length === 0 ? <p className="muted">Nada aqui ainda.</p> : (
        <div className="grid-cards">
          {cards.map(c => (
            <button key={c.iid} className="card in-grid" onClick={e => openMenu(c, e.clientX, e.clientY)} onContextMenu={e => { e.preventDefault(); openMenu(c, e.clientX, e.clientY); }} aria-label={c.data.name}>
              <CardFace c={c} />
            </button>
          ))}
        </div>
      )}
      {me?.id === playerId && <p className="muted small">Clique numa carta para movê-la.</p>}
    </Modal>
  );
}

function PeekView({ cards, all, act, onClose }: { cards: CardInst[]; all: boolean; act: (a: Action) => Promise<boolean>; onClose: () => void }) {
  const [list, setList] = useState(cards);
  const [filter, setFilter] = useState('');
  const move = (c: CardInst, to: ZoneName, position?: 'top' | 'bottom', extra: Partial<Action> = {}) => {
    act({ type: 'move', iids: [c.iid], to, position, ...extra } as Action);
    setList(l => l.filter(x => x.iid !== c.iid));
  };
  const shown = filter ? list.filter(c => `${c.data.name} ${c.data.typeLine}`.toLowerCase().includes(filter.toLowerCase())) : list;
  return (
    <Modal title={all ? 'Procurar no grimório' : `Topo do grimório (${list.length})`} onClose={() => { if (all) act({ type: 'shuffle' }); onClose(); }} wide>
      {all && <input className="search" autoFocus value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filtrar por nome ou tipo" aria-label="Filtrar" />}
      <div className="grid-cards">
        {shown.map((c, i) => (
          <div key={c.iid} className="peek-item">
            <div className="card in-grid"><CardFace c={c} /></div>
            {!all && <span className="muted small">{i + 1}º do topo</span>}
            <div className="peek-actions">
              <button className="btn small" onClick={() => move(c, 'hand')}>Mão</button>
              <button className="btn small" onClick={() => move(c, 'battlefield', undefined, { x: 0.4, y: 0.4 })}>Campo</button>
              <button className="btn small" onClick={() => move(c, 'graveyard')}>Cemitério</button>
              <button className="btn small" onClick={() => move(c, 'exile')}>Exílio</button>
              {!all && <button className="btn small" onClick={() => move(c, 'library', 'bottom')}>Fundo</button>}
            </div>
          </div>
        ))}
      </div>
      <p className="muted small">{all ? 'Ao fechar, o grimório é embaralhado.' : 'As cartas que você não mover ficam no topo, na mesma ordem.'}</p>
    </Modal>
  );
}

const TOKEN_PRESETS: (Partial<CardData> & { name: string })[] = [
  { name: 'Treasure', typeLine: 'Token Artifact — Treasure', oracle: '{T}, Sacrifice this token: Add one mana of any color.' },
  { name: 'Soldier', typeLine: 'Token Creature — Soldier', power: '1', toughness: '1' },
  { name: 'Zombie', typeLine: 'Token Creature — Zombie', power: '2', toughness: '2' },
  { name: 'Beast', typeLine: 'Token Creature — Beast', power: '3', toughness: '3' },
  { name: 'Saproling', typeLine: 'Token Creature — Saproling', power: '1', toughness: '1' },
  { name: 'Clue', typeLine: 'Token Artifact — Clue', oracle: '{2}, Sacrifice this token: Draw a card.' },
  { name: 'Food', typeLine: 'Token Artifact — Food', oracle: '{2}, {T}, Sacrifice this token: You gain 3 life.' },
  { name: 'Spirit', typeLine: 'Token Creature — Spirit', power: '1', toughness: '1', oracle: 'Flying' },
];

function TokenMaker({ act, onClose }: { act: (a: Action) => Promise<boolean>; onClose: () => void }) {
  const [name, setName] = useState('');
  const [pt, setPt] = useState('');
  const [count, setCount] = useState(1);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<CardData[]>([]);
  const [msg, setMsg] = useState('');
  const make = (data: Partial<CardData> & { name: string }) => { act({ type: 'token', data, count }); onClose(); };
  const custom = () => {
    if (!name.trim()) return;
    const [p, t] = pt.split('/').map(s => s.trim());
    make({ name: name.trim(), typeLine: p ? 'Token Creature' : 'Token', power: p || undefined, toughness: t || undefined });
  };
  const search = async () => {
    setMsg('Buscando…');
    try { const r = await searchTokens(q); setFound(r); setMsg(r.length ? '' : 'Nenhum token com esse nome.'); }
    catch (e: any) { setMsg(e.message); }
  };
  return (
    <Modal title="Criar token" onClose={onClose} wide>
      <div className="token-grid">
        <div>
          <label className="field"><span>Quantidade</span><input type="number" min={1} max={30} value={count} onChange={e => setCount(Number(e.target.value) || 1)} /></label>
          <div className="presets">
            {TOKEN_PRESETS.map(t => <button key={t.name} className="btn" onClick={() => make(t)}>{t.name}{t.power ? ` ${t.power}/${t.toughness}` : ''}</button>)}
          </div>
          <div className="row">
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Nome (ex.: Elfo Guerreiro)" aria-label="Nome do token" />
            <input value={pt} onChange={e => setPt(e.target.value)} placeholder="P/R" aria-label="Poder e resistência" style={{ width: 70 }} />
            <button className="btn primary" onClick={custom}>Criar</button>
          </div>
        </div>
        <div>
          <form className="row" onSubmit={e => { e.preventDefault(); search(); }}>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Buscar arte no Scryfall" aria-label="Buscar token" />
            <button className="btn">Buscar</button>
          </form>
          {msg && <p className="muted small">{msg}</p>}
          <div className="grid-cards small">
            {found.map(t => <button key={t.sid} className="card in-grid" onClick={() => make(t)} aria-label={t.name}><img className="face" src={t.image} alt={t.name} /></button>)}
          </div>
        </div>
      </div>
    </Modal>
  );
}

function AskModal({ title, label, initial, onOk, onClose }: { title: string; label: string; initial: string; onOk: (v: string) => void; onClose: () => void }) {
  const [val, setVal] = useState(initial);
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={e => { e.preventDefault(); if (val.trim()) { onOk(val.trim()); onClose(); } }}>
        <label className="field"><span>{label}</span><input autoFocus value={val} onChange={e => setVal(e.target.value)} /></label>
        <button className="btn primary">Confirmar</button>
      </form>
    </Modal>
  );
}
