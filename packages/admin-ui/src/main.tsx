import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import { WalletProvider } from './components/WalletProvider';
import { CrossmintProvider } from './components/CrossmintProvider';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <CrossmintProvider>
      <WalletProvider>
        <App />
      </WalletProvider>
    </CrossmintProvider>
  </React.StrictMode>,
);
