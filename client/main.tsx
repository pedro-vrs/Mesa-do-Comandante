import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Home } from './Home';
import { RoomPage } from './Room';
import './styles.css';

function App() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    addEventListener('popstate', on);
    return () => removeEventListener('popstate', on);
  }, []);
  const go = (p: string) => { history.pushState(null, '', p); setPath(p); };
  const m = /^\/r\/([a-z0-9]+)/i.exec(path);
  return m ? <RoomPage key={m[1]} roomId={m[1].toLowerCase()} go={go} /> : <Home go={go} />;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
