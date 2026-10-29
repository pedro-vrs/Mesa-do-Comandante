import { useState } from 'react';
import { getPref, setPref } from './decks';
import { DeckManager } from './DeckManager';

export function Home({ go }: { go: (path: string) => void }) {
  const [name, setName] = useState(getPref('name'));
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const create = async () => {
    if (!name.trim()) { setErr('Escreva seu nome para os amigos saberem quem é você.'); return; }
    setPref('name', name.trim()); setBusy(true);
    try {
      const r = await fetch('/api/new-room').then(r => r.json());
      go(`/r/${r.roomId}`);
    } catch { setErr('O servidor não respondeu. Confira a conexão e tente de novo.'); setBusy(false); }
  };
  const join = () => {
    const id = code.trim().toLowerCase().replace(/.*\/r\//, '').replace(/[^a-z0-9]/g, '');
    if (!name.trim()) { setErr('Escreva seu nome antes de entrar.'); return; }
    if (!id) { setErr('Cole o código ou o link da mesa.'); return; }
    setPref('name', name.trim()); go(`/r/${id}`);
  };

  return (
    <main className="home">
      <section className="home-hero">
        <h1 className="brand">Mesa do<br />Comandante</h1>
        <p className="lede">Commander no navegador para jogar com os amigos. A mesa conta a vida, o dano de comandante e o imposto; vocês decidem o resto.</p>
        <div className="join-card">
          <label className="field">
            <span>Seu nome</span>
            <input value={name} maxLength={24} onChange={e => setName(e.target.value)} placeholder="Como aparece na mesa" autoComplete="nickname" />
          </label>
          <button className="btn primary big" onClick={create} disabled={busy}>Criar mesa</button>
          <div className="or-row">
            <input value={code} onChange={e => setCode(e.target.value)} placeholder="Código ou link da mesa" onKeyDown={e => e.key === 'Enter' && join()} aria-label="Código da mesa" />
            <button className="btn" onClick={join}>Entrar</button>
          </div>
          {err && <p className="err" role="alert">{err}</p>}
        </div>
      </section>
      <section className="home-decks">
        <h2>Seus decks</h2>
        <p className="muted">Ficam salvos neste navegador. Cole a lista exportada do Moxfield, do Archidekt ou escrita à mão.</p>
        <DeckManager />
      </section>
    </main>
  );
}
