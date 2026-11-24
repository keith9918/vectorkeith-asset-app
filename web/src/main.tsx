import '@fontsource/orbitron/600.css';
import '@fontsource/orbitron/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/600.css';
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { startWalletDiscovery } from './lib/wallet';

// 尽早开始发现钱包（Phantom 等会在页面加载时注册自己）
startWalletDiscovery();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// PWA：生产环境注册 Service Worker（支持"添加到主屏幕"、离线打开外壳）
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
