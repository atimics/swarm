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
    rollupOptions: {
      output: {
        // Avoid manual chunking that creates circular dependencies
        // Let Rollup handle the dependency graph automatically for Solana ecosystem
        // Only split out truly independent chunks
        manualChunks(id) {
          if (id.includes('node_modules')) {
            // Core React (react, react-dom only - NOT react-based libraries)
            if (id.includes('/react/') || id.includes('/react-dom/') || 
                id.includes('/scheduler/')) {
              return 'vendor-react-core';
            }
            // Everything else stays in default vendor chunk
            // This avoids circular chunk issues between Solana <-> React adapters
          }
        },
      },
    },
  },
});
