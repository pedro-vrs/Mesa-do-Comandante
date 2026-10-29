// Mesa do modo XMage: o motor no computador do anfitrião é o juiz; aqui só desenhamos e respondemos.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Room } from './net';
import { Modal } from './Menu';
import { getPref, setPref } from './decks';

type XCard = {
  id: string; name: string; set?: string; num?: string; cost?: string; type?: string; rules?: string[];
  power?: string; toughness?: string; loyalty?: string; defense?: string; counters?: Record<string, number>;
  faceDown?: boolean; token?: boolean; ability?: boolean; transformed?: boolean; land?: boolean; creature?: boolean;
  targets?: string[]; back?: { name: string; set?: string; num?: string; type?: string; rules?: string[] }; source?: string;
  tapped?: boolean; damage?: number; sick?: boolean; attachedTo?: string | null; controller?: string; owner?: string; phasedOut?: boolean;
};
type XPlayer = {
  id: string; name: string; isMe: boolean; life: number; library: number; hand: number; active: boolean; hasPriority: boolean;
  left: boolean; monarch: boolean; initiative: boolean; counters: Record<string, number>; pool: Record<string, number>;
  graveyard: XCard[]; exile: XCard[]; battlefield: XCard[]; command: XCard[];
};

const SEAT_COLORS = ['#e4572e', '#3b82f6', '#22a06b', '#a855f7', '#f59e0b', '#ec4899'];
const MANA_TYPE: Record<string, string> = { W: 'WHITE', U: 'BLUE', B: 'BLACK', R: 'RED', G: 'GREEN', C: 'COLORLESS' };
const MANA_LABEL: Record<string, string> = { W: 'branca', U: 'azul', B: 'preta', R: 'vermelha', G: 'verde', C: 'incolor' };

const STEP_LABELS: [string, string][] = [
  ['UNTAP', 'Desvirar'], ['UPKEEP', 'Manutenção'], ['DRAW', 'Compra'], ['PRECOMBAT_MAIN', 'Principal 1'],
  ['BEGIN_COMBAT', 'Combate'], ['DECLARE_ATTACKERS', 'Atacantes'], ['DECLARE_BLOCKERS', 'Bloqueadores'],
  ['FIRST_COMBAT_DAMAGE', 'Dano (iniciativa)'], ['COMBAT_DAMAGE', 'Dano'], ['END_COMBAT', 'Fim combate'],
  ['POSTCOMBAT_MAIN', 'Principal 2'], ['END_TURN', 'Final'], ['CLEANUP', 'Limpeza'],
];

/** Mensagens frequentes do XMage em português; o resto fica como veio. */
const PHRASES: [RegExp, string][] = [
  [/^Play spells and abilities\.?$/i, 'Sua prioridade: jogue mágicas e habilidades, ou passe.'],
  [/^Select attackers\.?$/i, 'Escolha quem ataca (clique nas criaturas) e confirme.'],
  [/^Select blockers\.?$/i, 'Escolha quem bloqueia (clique na sua criatura e depois no atacante) e confirme.'],
  [/^Mulligan down to (\d+) cards?\?$/i, 'Fazer mulligan e ficar com $1 cartas?'],
  [/^Select a starting player\.?$/i, 'Escolha quem começa a partida.'],
  [/^Select a card to discard\.?$/i, 'Escolha uma carta para descartar.'],
  [/^Pay (.+)$/i, 'Pague $1: clique nos terrenos ou na mana da reserva.'],
];
function pt(text?: string) {
  if (!text) return '';
  for (const [re, out] of PHRASES) if (re.test(text)) return text.replace(re, out);
  return text;
}

export function cardImage(c: { set?: string; num?: string; faceDown?: boolean }, back = false) {
  if (!c.set || !c.num || c.faceDown) return undefined;
  return `https://api.scryfall.com/cards/${c.set.toLowerCase()}/${encodeURIComponent(c.num)}?format=image&version=normal${back ? '&face=back' : ''}`;
}

function XFace({ c, back }: { c: XCard; back?: boolean }) {
  const [broken, setBroken] = useState(false);
  if (c.faceDown) return <div className="face back" aria-label="Carta virada para baixo"><span /></div>;
  const img = !broken && !c.ability ? cardImage(c, back || c.transformed) : undefined;
  if (img) return <img className="face" src={img} alt={c.name} draggable={false} loading="lazy" onError={() => setBroken(true)} />;
  return (
    <div className={`face text ${c.ability ? 'ability' : ''}`}>
      <div className="t-head"><span className="t-name">{c.ability && c.source ? c.source : c.name}</span><span className="t-cost">{(c.cost ?? '').replace(/[{}]/g, '')}</span></div>
      <div className="t-type">{c.type}</div>
      <div className="t-oracle">{(c.rules ?? []).join('\n')}</div>
      {c.power !== undefined && c.power !== '' && c.creature && <div className="t-pt">{c.power}/{c.toughness}</div>}
    </div>
  );
}

function Overlays({ c, attacking }: { c: XCard; attacking?: string }) {
  const counters = Object.entries(c.counters ?? {});
  return (
    <>
      {counters.length > 0 && (
        <div className="counters">
          {counters.map(([k, v]) => <span key={k} className={`ctr ${k === '+1/+1' ? 'plus' : k === '-1/-1' ? 'minus' : ''}`} title={k}>
            {k === '+1/+1' ? `+${v}` : k === '-1/-1' ? `−${v}` : `${v} ${k.slice(0, 8)}`}</span>)}
        </div>
      )}
      {c.creature && c.power !== undefined && c.power !== '' && <span className={`pt-badge ${(c.damage ?? 0) > 0 ? 'hurt' : ''}`}>{c.power}/{c.toughness}{c.damage ? ` · ${c.damage} dano` : ''}</span>}
      {c.sick && c.creature && <span className="sick-mark" title="Enjoo de invocação">zz</span>}
      {attacking && <span className="atk-mark" title={`Atacando ${attacking}`}>⚔ {attacking}</span>}
      {c.token && <span className="token-mark">token</span>}
    </>
  );
}

export function XTable({ room }: { room: Room }) {
  const v = room.view!;
  const xm = room.xm;
  const g = xm.game;
  const p = xm.prompt;
  const [modal, setModal] = useState<{ title: string; cards: XCard[] } | null>(null);
  const [preview, setPreview] = useState<XCard | null>(null);
  const [sideOpen, setSideOpen] = useState(getPref('side', 'open') !== 'closed');
  const [drawer, setDrawer] = useState(false);
  const [oppFocus, setOppFocus] = useState(0);
  const host = v.you === v.hostId;

  // sem estado ainda: o motor está montando a partida
  if (!g) {
    return (
      <main className="home narrow xm-wait">
        <h1 className="brand small">Mesa do Comandante</h1>
        <p className="lede">{v.xmage?.connected ? (v.xmage.status || 'O motor do XMage está preparando a partida…') : 'O motor do XMage desconectou.'}</p>
        {v.xmage?.error && <p className="err">{v.xmage.error}</p>}
        <p className="muted small">Na primeira partida o XMage monta o banco de cartas no computador do anfitrião; isso pode levar alguns minutos.</p>
        {host && <button className="btn" onClick={() => room.send({ type: 'restart' })}>Voltar ao lobby</button>}
      </main>
    );
  }

  const players: XPlayer[] = g.players;
  const me = players.find(x => x.isMe);
  const meIdx = Math.max(0, players.findIndex(x => x.isMe));
  const seatOrder = [...players.slice(meIdx + 1), ...players.slice(0, meIdx)].filter(x => !x.isMe);
  const main = me ?? players[0];
  const colorOf = (id: string) => SEAT_COLORS[players.findIndex(x => x.id === id) % SEAT_COLORS.length];

  const targets = new Set<string>(p?.targets ?? []);
  const chosen = new Set<string>(p?.chosen ?? []);
  const playable = new Set<string>(p?.type === 'select' ? (g.canPlay ?? []) : []);
  const attackOk = new Set<string>(p?.attackers ?? []);
  const blockOk = new Set<string>(p?.blockers ?? []);
  const attackers = new Map<string, string>();
  for (const grp of g.combat ?? []) for (const a of grp.attackers) attackers.set(a, grp.defender);

  const canClick = (id: string) => !!p && (targets.has(id) || playable.has(id) || attackOk.has(id) || blockOk.has(id) || p.type === 'mana' || p.type === 'xmana');
  const click = (id: string) => {
    if (!p) { room.setToast('Espere o XMage pedir a sua decisão.'); return; }
    if (p.type === 'target' && targets.size && !targets.has(id)) { room.setToast('Esse não é um alvo válido agora.'); return; }
    xm.respond('uuid', id);
  };

  const cardProps = (c: XCard) => ({
    onClick: () => click(c.id),
    onPointerEnter: () => !c.faceDown && setPreview(c),
    onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); if (!c.faceDown) setModal({ title: c.name, cards: [c] }); },
    className: `card ${c.tapped ? 'tapped' : ''} ${canClick(c.id) && (targets.has(c.id) || playable.has(c.id) || attackOk.has(c.id) || blockOk.has(c.id)) ? 'pickable' : ''} ${chosen.has(c.id) ? 'selected' : ''} ${targets.has(c.id) ? 'targetable' : ''}`,
    role: 'button', tabIndex: 0, 'aria-label': c.faceDown ? 'Carta virada para baixo' : c.name,
    onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter') click(c.id); },
  });

  const focusOpp = seatOrder[Math.min(oppFocus, Math.max(0, seatOrder.length - 1))];
  const stepIdx = STEP_LABELS.findIndex(([k]) => k === g.step);
  const toggleSide = () => setSideOpen(o => { setPref('side', o ? 'closed' : 'open'); return !o; });

  return (
    <div className={`table xm ${sideOpen ? '' : 'side-closed'} opp-${Math.min(seatOrder.length, 5)}`}>
      <div className="opponents">
        {seatOrder.length > 1 && (
          <div className="opp-tabs" role="tablist" aria-label="Oponentes">
            {seatOrder.map((o, i) => <button key={o.id} role="tab" aria-selected={o.id === focusOpp?.id} style={{ '--seat': colorOf(o.id) } as any} onClick={() => setOppFocus(i)}>{o.name} <b>{o.life}</b></button>)}
          </div>
        )}
        {seatOrder.map(o => (
          <XMat key={o.id} pl={o} g={g} color={colorOf(o.id)} compact focused={o.id === focusOpp?.id} attackers={attackers} cardProps={cardProps}
            playerTarget={targets.has(o.id)} onPlayer={() => click(o.id)} onZone={(t, cards) => setModal({ title: t, cards })} />
        ))}
      </div>

      <nav className="rail" aria-label="Passos do turno" style={{ '--seat': colorOf(g.activePlayerId) } as any}>
        <div className="rail-who"><span className="seat-dot" />Turno {g.turn} · <strong>{g.activeName}</strong></div>
        <ol className="steps">
          {STEP_LABELS.filter(([k]) => k !== 'FIRST_COMBAT_DAMAGE' || g.step === k).map(([k, label], i) => (
            <li key={k}><span className={`step ${g.step === k ? 'now' : ''} ${STEP_LABELS.findIndex(([x]) => x === k) < stepIdx ? 'done' : ''}`}>{label}</span></li>
          ))}
        </ol>
        <div className="rail-actions">
          <span className="muted small">Prioridade: <b>{g.priorityName}</b></span>
          {!sideOpen && <button className="btn side-tab" onClick={toggleSide}>Pilha e registro{g.stack.length > 0 && <b>{g.stack.length}</b>}</button>}
        </div>
      </nav>

      <XMat pl={main} g={g} color={colorOf(main.id)} isMain attackers={attackers} cardProps={cardProps}
        playerTarget={targets.has(main.id)} onPlayer={() => click(main.id)} onZone={(t, cards) => setModal({ title: t, cards })}
        onMana={p?.type === 'mana' || p?.type === 'xmana' ? (m => xm.respond('mana', MANA_TYPE[m])) : undefined} />

      <div className="hand xm-hand">
        <div className="hand-cards">
          {(g.hand as XCard[]).map(c => (
            <div key={c.id} {...cardProps(c)} className={`${cardProps(c).className} in-hand`}><XFace c={c} /></div>
          ))}
          {g.hand.length === 0 && <span className="muted hand-empty">Mão vazia</span>}
        </div>
        <PromptBar room={room} prompt={p} onShowCards={(t, cards) => setModal({ title: t, cards })} />
      </div>

      <aside className={`side ${drawer ? 'open' : ''}`} aria-label="Pilha e registro">
        <div className="side-head">
          <span className="rules-chip on">Regras completas: XMage</span>
          <button className="btn ghost small side-collapse" onClick={toggleSide}>Recolher</button>
          <button className="btn ghost small side-close" onClick={() => setDrawer(false)}>Fechar</button>
        </div>
        <div className="stack">
          <h3>Pilha {g.stack.length > 0 && <span className="muted">({g.stack.length})</span>}</h3>
          <p className="muted small stack-help">{g.stack.length ? 'A de cima resolve primeiro, quando todos passarem a prioridade.' : 'Nada esperando para resolver.'}</p>
          {g.stack.length > 0 && (
            <ol>
              {(g.stack as XCard[]).map((c, i) => (
                <li key={c.id} className={i === 0 ? 'top' : ''}>
                  <div className={`card in-stack ${targets.has(c.id) ? 'targetable pickable' : ''}`} onClick={() => click(c.id)} onPointerEnter={() => setPreview(c)}><XFace c={c} /></div>
                  <div className="stack-meta">
                    <strong>{c.ability && c.source ? `${c.source}: habilidade` : c.name}</strong>
                    <span className="muted small">{(c.rules ?? []).join(' ').slice(0, 140)}</span>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
        <XLog room={room} />
        {preview && <div className="preview" aria-hidden="true"><XFace c={preview} /></div>}
      </aside>
      {drawer && <div className="drawer-back" onPointerDown={() => setDrawer(false)} />}
      <button className="btn xm-drawer-btn" onClick={() => setDrawer(d => !d)}>Pilha{g.stack.length ? ` (${g.stack.length})` : ''}</button>

      {modal && (
        <Modal title={modal.title} onClose={() => setModal(null)} wide={modal.cards.length > 1}>
          {modal.cards.length === 1 ? (
            <div className="xm-detail">
              <div className="big-preview"><XFace c={modal.cards[0]} />{modal.cards[0].back && <XFace c={{ ...modal.cards[0], ...modal.cards[0].back, id: 'b' } as XCard} back />}</div>
              <div className="oracle">{(modal.cards[0].rules ?? []).map((r, i) => <p key={i}>{r}</p>)}</div>
            </div>
          ) : modal.cards.length === 0 ? <p className="muted">Nada aqui ainda.</p> : (
            <div className="grid-cards">
              {modal.cards.map(c => (
                <button key={c.id} className={`card in-grid ${targets.has(c.id) ? 'targetable' : ''}`} onClick={() => { if (targets.has(c.id) || playable.has(c.id)) { click(c.id); setModal(null); } }} aria-label={c.name}><XFace c={c} /></button>
              ))}
            </div>
          )}
        </Modal>
      )}

      {xm.over && (
        <div className="game-over" role="dialog" aria-label="Fim de partida">
          <p className="go-title">{xm.won === true ? 'Você venceu' : xm.won === false ? 'Fim de jogo' : 'Fim de partida'}</p>
          <p className="muted">{pt(xm.over)}</p>
          {host ? <button className="btn primary big" onClick={() => room.send({ type: 'restart' })}>Voltar ao lobby</button>
            : <p className="muted">O anfitrião pode começar outra partida.</p>}
        </div>
      )}
      {!v.xmage?.connected && !xm.over && <div className="toast warn" role="status">O motor do XMage desconectou. A partida volta quando o anfitrião religar o motor.</div>}
      {room.toast && <div className="toast" role="status">{room.toast.text}</div>}
    </div>
  );
}

function XMat({ pl, g, color, compact, focused, isMain, attackers, cardProps, playerTarget, onPlayer, onZone, onMana }: {
  pl: XPlayer; g: any; color: string; compact?: boolean; focused?: boolean; isMain?: boolean; attackers: Map<string, string>;
  cardProps: (c: XCard) => Record<string, any>; playerTarget: boolean; onPlayer: () => void;
  onZone: (title: string, cards: XCard[]) => void; onMana?: (m: string) => void;
}) {
  const perms = pl.battlefield.filter(c => !c.phasedOut);
  const attached = new Map<string, XCard[]>();
  for (const c of perms) if (c.attachedTo) attached.set(c.attachedTo, [...(attached.get(c.attachedTo) ?? []), c]);
  const loose = perms.filter(c => !c.attachedTo || !perms.some(h => h.id === c.attachedTo));
  const rows: [string, XCard[]][] = [
    ['criaturas', loose.filter(c => c.creature)],
    ['outras', loose.filter(c => !c.creature && !c.land)],
    ['terrenos', loose.filter(c => c.land && !c.creature)],
  ];
  const poolEntries = Object.entries(pl.pool ?? {}).filter(([, n]) => n > 0);
  const counters = Object.entries(pl.counters ?? {});
  const renderPerm = (c: XCard) => {
    const props = cardProps(c);
    const atk = attackers.get(c.id);
    return (
      <div key={c.id} className="xm-perm">
        {(attached.get(c.id) ?? []).map(a => <div key={a.id} {...cardProps(a)} className={`${cardProps(a).className} xm-attached`}><XFace c={a} /></div>)}
        <div {...props} className={`${props.className} on-xfield ${atk ? 'attacking' : ''}`}><XFace c={c} /><Overlays c={c} attacking={atk} /></div>
      </div>
    );
  };
  return (
    <section className={`mat ${compact ? 'compact' : 'main'} ${focused ? 'focused' : ''} ${pl.active ? 'active' : ''} ${pl.left ? 'lost' : ''}`} style={{ '--seat': color } as any} aria-label={`Mesa de ${pl.name}`}>
      <header className="mat-head">
        <button className={`who xm-who ${playerTarget ? 'targetable' : ''}`} onClick={onPlayer} disabled={!playerTarget} title={playerTarget ? 'Escolher este jogador' : undefined}>
          <span className="seat-dot" aria-hidden="true" />
          <strong>{pl.name}</strong>
          {pl.active && <span className="tag turn">turno</span>}
          {pl.hasPriority && <span className="tag prio">prioridade</span>}
          {pl.monarch && <span className="tag">monarca</span>}
          {pl.initiative && <span className="tag">iniciativa</span>}
          {pl.left && <span className="tag bad">saiu</span>}
        </button>
        <div className="life" aria-label={`Vida ${pl.life}`}><span className={`life-num ${pl.life <= 10 ? 'low' : ''}`}>{pl.life}</span></div>
        <div className="stats">
          {counters.map(([k, n]) => <span key={k} className={`chip ${k === 'poison' && n >= 7 ? 'hot' : ''}`}>{k === 'poison' ? 'veneno' : k} <b>{n}</b></span>)}
          {poolEntries.length > 0 && (
            <span className="pool" aria-label="Reserva de mana">
              {poolEntries.map(([m, n]) => onMana
                ? <button key={m} className={`mana m-${m}`} onClick={() => onMana(m)} title={`Pagar com mana ${MANA_LABEL[m]}`}>{n}</button>
                : <span key={m} className={`mana m-${m}`} title={`Mana ${MANA_LABEL[m]}`}>{n}</span>)}
            </span>
          )}
        </div>
      </header>
      <div className="mat-body">
        <div className="xm-field">
          {rows.map(([k, cards]) => cards.length > 0 && <div key={k} className={`xm-row xm-${k}`}>{cards.map(renderPerm)}</div>)}
          {perms.length === 0 && isMain && <p className="field-empty">Clique numa carta da mão que esteja destacada para jogá-la.</p>}
        </div>
        <div className="zones">
          <div className="zone command" title="Zona de comando">
            {pl.command.map(c => <div key={c.id} {...cardProps(c)} className={`${cardProps(c).className} in-zone`}><XFace c={c} /></div>)}
            {pl.command.length === 0 && <span className="zone-label">comando</span>}
          </div>
          <div className="zone pile" aria-label={`Grimório, ${pl.library} cartas`}><div className="face back"><span /></div><b className="count">{pl.library}</b><span className="zone-label">grimório</span></div>
          {!pl.isMe && <div className="zone pile hand-count" aria-label={`Mão, ${pl.hand} cartas`}><span className="count">{pl.hand}</span><span className="zone-label">mão</span></div>}
          <button className="zone pile" onClick={() => onZone(`Cemitério de ${pl.name}`, pl.graveyard)} aria-label={`Cemitério, ${pl.graveyard.length} cartas`}>
            {pl.graveyard[0] ? <XFace c={pl.graveyard[pl.graveyard.length - 1]} /> : <div className="face empty" />}<b className="count">{pl.graveyard.length}</b><span className="zone-label">cemitério</span>
          </button>
          <button className="zone pile" onClick={() => onZone(`Exílio de ${pl.name}`, pl.exile)} aria-label={`Exílio, ${pl.exile.length} cartas`}>
            <div className="face empty exile" /><b className="count">{pl.exile.length}</b><span className="zone-label">exílio</span>
          </button>
        </div>
      </div>
    </section>
  );
}

function PromptBar({ room, prompt: p, onShowCards }: { room: Room; prompt: any; onShowCards: (t: string, c: XCard[]) => void }) {
  const xm = room.xm;
  const [amount, setAmount] = useState(0);
  const [parts, setParts] = useState<number[]>([]);
  const [filter, setFilter] = useState('');
  const shownCardsFor = useRef<any>(null);

  useEffect(() => {
    if (!p) return;
    setAmount(p.min ?? 0);
    setParts((p.parts ?? []).map((x: any) => x.default ?? x.min ?? 0));
    setFilter('');
    // escolher entre cartas fora do campo (grimório, mão revelada...): abre a grade sozinho
    if (p.type === 'target' && p.cards?.length && shownCardsFor.current !== p) { shownCardsFor.current = p; onShowCards(pt(p.message), p.cards); }
  }, [p]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!p) {
    return (
      <div className="prompt-bar idle">
        <span className="muted">Esperando os outros jogadores…</span>
        <div className="row">
          <button className="btn ghost small" onClick={() => xm.respond('action', 'UNDO')} title="Desfazer a sua última ação, se o XMage permitir">Desfazer</button>
        </div>
      </div>
    );
  }
  const choices: { key: string; label: string }[] = p.choices ?? [];
  const shown = filter ? choices.filter(c => c.label.toLowerCase().includes(filter.toLowerCase())) : choices;
  const priority = p.type === 'select' && /play spells and abilities/i.test(p.message ?? '');

  return (
    <div className={`prompt-bar ${p.type}`} role="region" aria-label="Decisão do XMage">
      <div className="prompt-text">
        <strong>{pt(p.message)}</strong>
        {p.sub && <span className="muted small">{pt(p.sub)}</span>}
        {p.hint && <span className="muted small">{p.hint}</span>}
      </div>

      {p.type === 'amount' && (
        <form className="row" onSubmit={e => { e.preventDefault(); xm.respond('int', Math.max(p.min, Math.min(p.max, amount))); }}>
          <input type="number" min={p.min} max={p.max} value={amount} onChange={e => setAmount(Number(e.target.value))} aria-label="Quantidade" style={{ width: 90 }} autoFocus />
          <span className="muted small">de {p.min} a {p.max}</span>
          <button className="btn primary">Confirmar</button>
        </form>
      )}

      {p.type === 'multiAmount' && (
        <form className="multi" onSubmit={e => { e.preventDefault(); xm.respond('string', parts.join(' ')); }}>
          {(p.parts ?? []).map((x: any, i: number) => (
            <label key={i} className="row small">{x.text}
              <input type="number" min={x.min} max={x.max} value={parts[i] ?? 0} onChange={e => setParts(a => a.map((v, k) => k === i ? Number(e.target.value) : v))} style={{ width: 70 }} />
            </label>
          ))}
          <button className="btn primary">Confirmar</button>
        </form>
      )}

      {(p.type === 'choice' || p.type === 'ability') && (
        <div className="choices">
          {choices.length > 8 && <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filtrar" aria-label="Filtrar opções" />}
          <div className="choice-list">
            {shown.map(c => <button key={c.key} className="btn" onClick={() => xm.respond(p.type === 'ability' ? 'uuid' : 'string', c.key)}>{c.label}</button>)}
          </div>
        </div>
      )}

      {p.type === 'pile' && (
        <div className="row">
          <button className="btn" onClick={() => onShowCards('Pilha 1', p.pile1)}>Ver pilha 1 ({p.pile1.length})</button>
          <button className="btn" onClick={() => onShowCards('Pilha 2', p.pile2)}>Ver pilha 2 ({p.pile2.length})</button>
          <button className="btn primary" onClick={() => xm.respond('bool', true)}>Escolher pilha 1</button>
          <button className="btn primary" onClick={() => xm.respond('bool', false)}>Escolher pilha 2</button>
        </div>
      )}

      {p.type === 'target' && p.cards?.length > 0 && <button className="btn" onClick={() => onShowCards(pt(p.message), p.cards)}>Ver as cartas</button>}

      <div className="row prompt-buttons">
        {p.left && <button className="btn primary" onClick={() => xm.respond('bool', true)}>{p.left}</button>}
        {p.right && <button className={`btn ${p.left ? '' : 'primary'}`} onClick={() => xm.respond('bool', false)}>{priority && p.right === 'Pronto' ? 'Passar' : p.right}</button>}
        {p.special && <button className="btn" onClick={() => xm.respond('string', 'special')}>{p.special}</button>}
        {priority && <button className="btn ghost" onClick={() => xm.respond('action', 'PASS_PRIORITY_UNTIL_NEXT_TURN')} title="Passa até o próximo turno, a menos que algo precise de você">Passar a vez</button>}
        {(priority || p.type === 'mana') && <button className="btn ghost small" onClick={() => xm.respond('action', 'UNDO')}>Desfazer</button>}
      </div>
    </div>
  );
}

function XLog({ room }: { room: Room }) {
  const xm = room.xm;
  const ref = useRef<HTMLOListElement>(null);
  const [text, setText] = useState('');
  const [filter, setFilter] = useState<'all' | 'game' | 'chat'>(() => (getPref('logFilter', 'all') as any));
  const pick = (f: typeof filter) => { setFilter(f); setPref('logFilter', f); };
  const isChat = (t: string) => /TALK|WHISPER|USER_INFO/i.test(t);
  const shown = useMemo(() => xm.log.filter(l => filter === 'all' || (filter === 'chat' ? isChat(l.type) : !isChat(l.type))).slice(-200), [xm.log, filter]);
  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight }); }, [shown.length, filter]);
  return (
    <div className="log">
      <div className="log-head">
        <h3>Registro</h3>
        <div className="seg" role="tablist" aria-label="Filtrar registro">
          {(['all', 'game', 'chat'] as const).map(f => <button key={f} role="tab" aria-selected={filter === f} onClick={() => pick(f)}>{{ all: 'Tudo', game: 'Jogo', chat: 'Chat' }[f]}</button>)}
        </div>
      </div>
      <ol ref={ref} aria-live="polite">
        {shown.map(l => <li key={l.id} className={isChat(l.type) ? 'chat' : ''}>{isChat(l.type) && l.user ? `${l.user}: ` : ''}{l.text}</li>)}
        {shown.length === 0 && <li className="muted">Nada por aqui ainda.</li>}
      </ol>
      {room.view?.you && (
        <form onSubmit={e => { e.preventDefault(); if (text.trim()) { xm.chat(text); setText(''); } }}>
          <input value={text} onChange={e => setText(e.target.value)} placeholder="Mensagem para a mesa" aria-label="Mensagem" />
        </form>
      )}
    </div>
  );
}
