import { useState } from 'react';
import { SavedDeck, loadDecks, upsertDeck, deleteDeck, demoDeck } from './decks';
import { parseDecklist, resolveDeck, commanderWarnings } from './scryfall';

const EXAMPLE = `Commander
1 Atraxa, Praetors' Voice

Deck
1 Sol Ring
1 Arcane Signet
1 Command Tower
...`;

export function DeckManager({ onPick, pickLabel }: { onPick?: (d: SavedDeck) => void; pickLabel?: string }) {
  const [decks, setDecks] = useState<SavedDeck[]>(() => loadDecks());
  const [editing, setEditing] = useState<SavedDeck | null>(null);
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [progress, setProgress] = useState('');
  const [err, setErr] = useState('');
  const refresh = () => setDecks(loadDecks());

  const importDeck = async () => {
    setErr('');
    const lines = parseDecklist(text);
    if (!lines.length) { setErr('Não encontrei cartas nessa lista. Use uma linha por carta, como “1 Sol Ring”.'); return; }
    try {
      setProgress('Buscando cartas no Scryfall…');
      const { entries, missing } = await resolveDeck(lines, (d, t) => setProgress(`Buscando cartas no Scryfall… ${d} de ${t}`));
      const deck: SavedDeck = { id: crypto.randomUUID(), name: name.trim() || entries.find(e => e.commander)?.data.name || 'Deck sem nome', entries, updated: Date.now() };
      upsertDeck(deck); refresh(); setText(''); setName(''); setEditing(deck);
      setProgress(missing.length ? `Não encontrei: ${missing.join(', ')}. Confira a grafia e importe de novo.` : '');
    } catch (e: any) {
      setProgress(''); setErr(e?.message ?? 'Falha ao buscar no Scryfall.');
    }
  };

  const toggleCommander = (d: SavedDeck, i: number) => {
    const entries = d.entries.map((e, k) => k === i ? { ...e, commander: !e.commander } : e);
    const nd = { ...d, entries }; upsertDeck(nd); setEditing(nd); refresh();
  };

  return (
    <div className="decks">
      {decks.length > 0 && (
        <ul className="deck-list">
          {decks.map(d => {
            const cmd = d.entries.filter(e => e.commander).map(e => e.data.name).join(' + ');
            const total = d.entries.reduce((n, e) => n + e.count, 0);
            return (
              <li key={d.id} className="deck-row">
                <div className="deck-art" style={{ backgroundImage: d.entries.find(e => e.commander)?.data.image ? `url(${d.entries.find(e => e.commander)!.data.image})` : undefined }} />
                <div className="deck-meta">
                  <strong>{d.name}</strong>
                  <span className="muted">{cmd || 'sem comandante'}, {total} cartas</span>
                </div>
                <div className="deck-actions">
                  {onPick && <button className="btn primary" onClick={() => onPick(d)}>{pickLabel ?? 'Usar'}</button>}
                  <button className="btn ghost" onClick={() => setEditing(editing?.id === d.id ? null : d)}>Detalhes</button>
                  <button className="btn ghost danger" onClick={() => { if (confirm(`Apagar o deck ${d.name}?`)) { deleteDeck(d.id); refresh(); setEditing(null); } }}>Apagar</button>
                </div>
                {editing?.id === d.id && <DeckDetails deck={editing} onToggle={i => toggleCommander(editing, i)} />}
              </li>
            );
          })}
        </ul>
      )}
      <div className="import">
        <label className="field">
          <span>Nome do deck (opcional)</span>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Usa o nome do comandante se ficar vazio" />
        </label>
        <label className="field">
          <span>Lista</span>
          <textarea value={text} onChange={e => setText(e.target.value)} rows={8} placeholder={EXAMPLE} spellCheck={false} />
        </label>
        <div className="row">
          <button className="btn primary" onClick={importDeck} disabled={!!progress && !progress.startsWith('Não')}>Importar deck</button>
          <button className="btn ghost" onClick={() => { upsertDeck(demoDeck()); refresh(); }}>Adicionar deck de teste</button>
        </div>
        {progress && <p className="muted" aria-live="polite">{progress}</p>}
        {err && <p className="err" role="alert">{err}</p>}
      </div>
    </div>
  );
}

function DeckDetails({ deck, onToggle }: { deck: SavedDeck; onToggle: (i: number) => void }) {
  const warn = commanderWarnings(deck.entries);
  return (
    <div className="deck-details">
      {warn.length > 0 ? (
        <ul className="warn-list">{warn.slice(0, 8).map(w => <li key={w}>{w}</li>)}{warn.length > 8 && <li>e mais {warn.length - 8} avisos</li>}</ul>
      ) : <p className="ok">Deck legal em Commander.</p>}
      <p className="muted">Clique no nome de uma carta para marcar ou desmarcar como comandante.</p>
      <ul className="card-lines">
        {deck.entries.map((e, i) => (
          <li key={i}>
            <button className={`linkish ${e.commander ? 'is-cmd' : ''}`} onClick={() => onToggle(i)}>
              {e.count} {e.data.name}{e.commander ? ' — comandante' : ''}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
