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
  toast: string;
  setToast: (t: string) => void;
}

export function useRoom(roomId: string, name: string, spectate: boolean): Room {
  const [view, setView] = useState<GameView | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState<Room['status']>('connecting');
  const [toast, setToast] = useState('');
  const sock = useRef<Socket | null>(null);

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
    s.on('state', (v: GameView) => setView(v));
    return () => { s.disconnect(); };
  }, [roomId, name, spectate]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 3800);
    return () => clearTimeout(t);
  }, [toast]);

  const send = useCallback((a: Action) => new Promise<boolean>(resolve => {
    sock.current?.emit('action', a, (r: any) => {
      if (!r?.ok) setToast(r?.error ?? 'Ação recusada.');
      resolve(!!r?.ok);
    });
  }), []);

  const undo = useCallback(() => {
    sock.current?.emit('undo', (r: any) => { if (!r?.ok) setToast(r?.error ?? 'Nada para desfazer.'); });
  }, []);

  const peek = useCallback((n: number) => new Promise<CardInst[]>(resolve => {
    sock.current?.emit('peek', n, (r: any) => {
      if (!r?.ok) { setToast(r?.error ?? 'Indisponível.'); resolve([]); } else resolve(r.cards);
    });
  }), []);

  return { view, error, status, send, undo, peek, toast, setToast };
}
