import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import Player from './pages/Player';
import Host from './pages/Host';
import Board from './pages/Board';

const path = location.pathname.replace(/\/+$/, '') || '/';
const Page = path === '/host' ? Host : path === '/board' ? Board : Player;
document.body.dataset.page = path === '/host' ? 'host' : path === '/board' ? 'board' : 'player';
if (path === '/board') document.title = '축제 퀴즈 — 전광판';
if (path === '/host') document.title = '축제 퀴즈 — 진행자';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
