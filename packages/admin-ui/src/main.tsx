import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import { WalletProvider } from './components/WalletProvider';
import { PrivyProvider } from './components/PrivyProvider';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PrivyProvider>
      <WalletProvider>
        <App />
      </WalletProvider>
    </PrivyProvider>
  </React.StrictMode>,
);
