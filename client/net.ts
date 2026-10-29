// Conexão com o servidor de sala.
import { io, Socket } from 'socket.io-client';
import { useEffect, useRef, useState, useCallback } from 'react';
import type { Action, CardInst, GameView } from '../shared/types';
import { getPref, setPref } from './decks';

export interface Room {
  view: GameView | null;
  error: string;
  status: 'connecting' | 'online' | 'offline';
  send: (a: Action) => Promise<boolean>;
  undo: () => void;
  peek: (n: number) => Promise<CardInst[]>;
  toast: Toast | null;
  setToast: (t: string | Toast | null) => void;
  xm: XmClient;
}

/** Estado da partida no modo XMage, como o motor manda (ver motor/ViewMapper.java). */
export interface XmClient {
  game: any | null;
  prompt: any | null;
  log: { id: number; user: string; text: string; type: string }[];
  over: string;
  won: boolean | null;
  respond: (kind: 'uuid' | 'bool' | 'int' | 'string' | 'mana' | 'action', value?: string | number | boolean | null) => void;
  chat: (text: string) => void;
}

/** Aviso na tela. `retry` aparece como "Fazer assim mesmo" quando a regra pode ser ignorada. */
export interface Toast { text: string; retry?: () => void }

export function useRoom(roomId: string, name: string, spectate: boolean): Room {
  const [view, setView] = useState<GameView | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState<Room['status']>('connecting');
  const [toast, setToastRaw] = useState<Toast | null>(null);
  const setToast = useCallback((t: string | Toast | null) => setToastRaw(typeof t === 'string' ? (t ? { text: t } : null) : t), []);
  const sock = useRef<Socket | null>(null);
  const [xmGame, setXmGame] = useState<any>(null);
  const [xmPrompt, setXmPrompt] = useState<any>(null);
  const [xmLog, setXmLog] = useState<XmClient['log']>([]);
  const [xmOver, setXmOver] = useState('');
  const [xmWon, setXmWon] = useState<boolean | null>(null);

  useEffect(() => {
    const s = io({ transports: ['websocket', 'polling'] });
    sock.current = s;
    const join = () => {
      const key = getPref(`key.${roomId}`) || undefined;
      s.emit('join', { roomId, name, key, spectate }, (r: any) => {
        if (!r.ok) { setError(r.error); return; }
        if (r.key) setPref(`key.${roomId}`, r.key);
        setError('');
      });
    };
    s.on('connect', () => { setStatus('online'); join(); });
    s.on('disconnect', () => setStatus('offline'));
    s.on('state', (v: GameView) => {
      setView(v);
      if (v.phase !== 'xmage') { setXmGame(null); setXmPrompt(null); setXmOver(''); setXmWon(null); }
    });
    s.on('xm', (m: any) => {
      switch (m.kind) {
        case 'state': setXmGame(m.game); break;
        case 'prompt': setXmPrompt(m.prompt); break;
        case 'info': if (m.text) setToast(m.text); break;
        case 'over': setXmOver(m.text || 'Fim da partida'); setXmPrompt(null); break;
        case 'result': setXmWon(!!m.won); break;
      }
    });
    s.on('xmlog', (entries: XmClient['log']) => setXmLog(l => {
      const seen = new Set(l.map(e => e.id));
      const add = entries.filter(e => !seen.has(e.id));
      return add.length ? [...l, ...add].slice(-400) : (entries.length && entries[0].id === 1 && l.length && l[0].id !== 1 ? entries : l);
    }));
    return () => { s.disconnect(); };
  }, [roomId, name, spectate]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.retry ? 9000 : 3800);
    return () => clearTimeout(t);
  }, [toast]);

  const send = useCallback((a: Action): Promise<boolean> => new Promise<boolean>(resolve => {
    sock.current?.emit('action', a, (r: any) => {
      if (!r?.ok) {
        const retry = r?.overridable ? () => { setToast(null); send({ ...a, force: true } as Action); } : undefined;
        setToast({ text: r?.error ?? 'Ação recusada.', retry });
      }
      resolve(!!r?.ok);
    });
  }), [setToast]);

  const undo = useCallback(() => {
    sock.current?.emit('undo', (r: any) => { if (!r?.ok) setToast(r?.error ?? 'Nada para desfazer.'); });
  }, []);

  const peek = useCallback((n: number) => new Promise<CardInst[]>(resolve => {
    sock.current?.emit('peek', n, (r: any) => {
      if (!r?.ok) { setToast(r?.error ?? 'Indisponível.'); resolve([]); } else resolve(r.cards);
    });
  }), []);

  const xmRespond = useCallback((kind: Parameters<XmClient['respond']>[0], value?: string | number | boolean | null) => {
    setXmPrompt(null);
    sock.current?.emit('xmresp', { kind, value: value ?? null });
  }, []);
  const xmChat = useCallback((text: string) => { sock.current?.emit('xmchat', text); }, []);
  const xm: XmClient = { game: xmGame, prompt: xmPrompt, log: xmLog, over: xmOver, won: xmWon, respond: xmRespond, chat: xmChat };

  return { view, error, status, send, undo, peek, toast, setToast, xm };
}
