import type { CardInst } from '../shared/types';
import { effectivePT, isType } from '../shared/game';

export function cardImage(c: CardInst): string | undefined {
  if (c.faceDown || c.data.sid === 'hidden') return undefined;
  return c.transformed ? c.data.imageBack : c.data.image;
}

export function CardFace({ c, hidden }: { c?: CardInst; hidden?: boolean }) {
  if (!c || hidden || c.faceDown || c.data.sid === 'hidden') {
    return <div className="face back" aria-label="Carta virada para baixo"><span /></div>;
  }
  const img = cardImage(c);
  if (img) return <img className="face" src={img} alt={c.data.name} draggable={false} loading="lazy" />;
  const name = c.transformed && c.data.backName ? c.data.backName : c.data.name;
  return (
    <div className={`face text ${c.ability ? 'ability' : ''}`}>
      <div className="t-head"><span className="t-name">{name}</span><span className="t-cost">{fmtCost(c.data.manaCost)}</span></div>
      <div className="t-type">{c.data.typeLine}</div>
      <div className="t-oracle">{c.data.oracle}</div>
      {c.data.power !== undefined && <div className="t-pt">{c.data.power}/{c.data.toughness}</div>}
    </div>
  );
}

export function fmtCost(cost: string) { return cost.replace(/[{}]/g, ''); }

export function CardOverlays({ c }: { c: CardInst }) {
  const pt = c.zone === 'battlefield' && !c.faceDown && isType(c, 'creature') ? effectivePT(c) : null;
  const changed = pt && (c.ptMod[0] || c.ptMod[1] || c.counters['+1/+1'] || c.counters['-1/-1']);
  const counters = Object.entries(c.counters);
  return (
    <>
      {counters.length > 0 && (
        <div className="counters">
          {counters.map(([k, v]) => <span key={k} className={`ctr ${k === '+1/+1' ? 'plus' : k === '-1/-1' ? 'minus' : ''}`} title={k}>{k === '+1/+1' ? `+${v}` : k === '-1/-1' ? `−${v}` : `${v} ${k.slice(0, 8)}`}</span>)}
        </div>
      )}
      {changed && pt && <span className={`pt-badge ${pt[1] <= 0 ? 'dead' : ''}`}>{pt[0]}/{pt[1]}</span>}
      {c.isCommander && <span className="cmd-mark" title="Comandante">C</span>}
      {c.token && <span className="token-mark">token</span>}
    </>
  );
}
