import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  optimizeDeps: {
    // Pre-bundle Solana deps to avoid circular dependency issues
    include: [
      '@solana/web3.js',
      '@solana/wallet-adapter-base',
      '@solana/wallet-adapter-react',
      '@solana/wallet-adapter-react-ui',
      '@solana/wallet-adapter-wallets',
    ],
  },
  build: {
    outDir: 'dist',
    sourcemap: false, // Disable sourcemaps to reduce memory usage in CI
    chunkSizeWarningLimit: 2000, // Increase limit since we're combining chunks
    // Let Rollup handle chunk splitting automatically.
    // Manual chunking of React causes createContext errors due to
    // chunk load ordering issues with Privy and other React-dependent libs.
  },
});
