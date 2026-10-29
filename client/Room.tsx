import { useState } from 'react';
import { useRoom } from './net';
import { Table } from './Table';
import { DeckManager } from './DeckManager';
import { getPref, setPref } from './decks';

export function RoomPage({ roomId, go }: { roomId: string; go: (p: string) => void }) {
  const [name, setName] = useState(getPref('name'));
  const [confirmed, setConfirmed] = useState(!!getPref('name'));
  const [spectate, setSpectate] = useState(false);

  if (!confirmed) {
    return (
      <main className="home narrow">
        <h1 className="brand small">Mesa do Comandante</h1>
        <p className="lede">Você foi chamado para a mesa <b>{roomId}</b>.</p>
        <form className="join-card" onSubmit={e => { e.preventDefault(); if (name.trim()) { setPref('name', name.trim()); setConfirmed(true); } }}>
          <label className="field"><span>Seu nome</span><input autoFocus value={name} maxLength={24} onChange={e => setName(e.target.value)} /></label>
          <button className="btn primary big">Sentar à mesa</button>
          <button type="button" className="btn ghost" onClick={() => { setSpectate(true); setConfirmed(true); }}>Só assistir</button>
        </form>
      </main>
    );
  }
  return <Joined roomId={roomId} name={name} spectate={spectate} go={go} />;
}

function Joined({ roomId, name, spectate, go }: { roomId: string; name: string; spectate: boolean; go: (p: string) => void }) {
  const room = useRoom(roomId, name, spectate);
  const v = room.view;
  const [copied, setCopied] = useState(false);

  if (room.error && !v) return (
    <main className="home narrow"><h1 className="brand small">Mesa do Comandante</h1><p className="err">{room.error}</p><button className="btn" onClick={() => go('/')}>Voltar ao início</button></main>
  );
  if (!v) return <main className="home narrow"><p className="muted">Entrando na mesa {roomId}…</p></main>;
  if (v.phase !== 'lobby') return <Table room={room} />;

  const me = v.players.find(p => p.id === v.you);
  const host = me?.id === v.hostId;
  const link = `${location.origin}/r/${roomId}`;
  const copy = async () => { try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { prompt('Copie o link:', link); } };
  const allDecks = v.players.length > 0 && v.players.every(p => p.deckSize > 0);

  return (
    <main className="lobby">
      <header className="lobby-head">
        <button className="linkish" onClick={() => go('/')}>Mesa do Comandante</button>
        <div className="share">
          <span className="muted">Chame os amigos com o link</span>
          <code>{link}</code>
          <button className="btn" onClick={copy}>{copied ? 'Copiado' : 'Copiar link'}</button>
        </div>
      </header>

      <section className="seats" aria-label="Jogadores">
        {v.players.map(p => (
          <div key={p.id} className="seat" style={{ '--seat': p.color } as any}>
            <span className="seat-dot" />
            <div>
              <strong>{p.name}{p.id === v.you ? ' (você)' : ''}{p.id === v.hostId ? ' · anfitrião' : ''}</strong>
              <span className="muted">{p.deckName ? `${p.deckName}, ${p.deckSize} cartas` : 'escolhendo deck…'}{!p.connected ? ' · desconectado' : ''}</span>
            </div>
          </div>
        ))}
        {Array.from({ length: Math.max(0, Math.min(4, v.settings.maxPlayers) - v.players.length) }).map((_, i) => (
          <div key={`e${i}`} className="seat empty"><span className="seat-dot" /><span className="muted">Lugar livre</span></div>
        ))}
        {v.spectators > 0 && <p className="muted">{v.spectators} assistindo</p>}
      </section>

      <div className="lobby-grid">
        <section>
          <h2>{me ? 'Escolha seu deck' : 'Você está assistindo'}</h2>
          {me ? <DeckManager pickLabel={me.deckName ? 'Trocar para este' : 'Usar este deck'} onPick={d => room.send({ type: 'loadDeck', name: d.name, entries: d.entries })} />
            : <p className="muted">A partida começa quando o anfitrião der início.</p>}
        </section>
        <section className="settings">
          <h2>Regras da mesa</h2>
          <fieldset disabled={!host}>
            <label className="field inline"><span>Vida inicial</span>
              <input type="number" min={1} max={999} value={v.settings.startingLife} onChange={e => room.send({ type: 'settings', settings: { startingLife: Number(e.target.value) } })} />
            </label>
            <label className="check"><input type="checkbox" checked={v.settings.autoUntap} onChange={e => room.send({ type: 'settings', settings: { autoUntap: e.target.checked } })} />
              <span>Desvirar sozinho no início do turno</span></label>
            <label className="check"><input type="checkbox" checked={v.settings.autoDraw} onChange={e => room.send({ type: 'settings', settings: { autoDraw: e.target.checked } })} />
              <span>Comprar sozinho no passo de compra</span></label>
            <label className="check"><input type="checkbox" checked={v.settings.enforce} onChange={e => room.send({ type: 'settings', settings: { enforce: e.target.checked } })} />
              <span>Regras de turno e mana: um terreno por turno, mágicas só no momento certo e custo pago com mana (a mesa vira os terrenos sozinha). Quando uma carta muda a regra, aparece “Fazer assim mesmo”.</span></label>
            <label className="check"><input type="checkbox" checked={v.settings.priority} onChange={e => room.send({ type: 'settings', settings: { priority: e.target.checked } })} />
              <span>Modo prioridade, como no XMage: cada um passa a vez de responder; quando todos passam, a pilha resolve ou o turno avança</span></label>
          </fieldset>
          {!host && <p className="muted small">Só o anfitrião muda as regras.</p>}
          {host && (
            <>
              <button className="btn primary big" disabled={!allDecks} onClick={() => room.send({ type: 'start' })}>Começar partida</button>
              {!allDecks && <p className="muted small">Todos precisam escolher um deck.</p>}
            </>
          )}
          <details className="shortcuts">
            <summary>Atalhos de teclado</summary>
            <dl>
              <dt>D</dt><dd>comprar</dd><dt>S</dt><dd>embaralhar</dd><dt>T</dt><dd>virar a carta sob o mouse</dd>
              <dt>U</dt><dd>desvirar tudo</dd><dt>N</dt><dd>próximo passo</dd><dt>E</dt><dd>passar a vez</dd>
              <dt>G / X / H</dt><dd>cemitério, exílio, mão</dd><dt>+ / −</dt><dd>marcadores +1/+1 e −1/−1</dd>
              <dt>A</dt><dd>habilidade na pilha</dd><dt>K</dt><dd>criar token</dd><dt>V</dt><dd>ampliar</dd>
              <dt>Ctrl+Z</dt><dd>desfazer</dd><dt>Espaço</dt><dd>passar prioridade</dd>
            </dl>
          </details>
        </section>
      </div>
      {room.toast && <div className="toast" role="status">{room.toast.text}</div>}
    </main>
  );
}
