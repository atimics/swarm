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
  build: {
    outDir: 'dist',
    sourcemap: false, // Disable sourcemaps to reduce memory usage in CI
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Split vendor chunks more aggressively to reduce memory pressure
          if (id.includes('node_modules')) {
            // Group Solana and Crossmint together - Crossmint depends on @solana/web3.js
            // Separating them breaks module initialization order (TDZ errors)
            if (id.includes('@solana') || id.includes('solana') ||
                id.includes('@crossmint') || id.includes('crossmint')) {
              return 'vendor-web3';
            }
            if (id.includes('react')) {
              return 'vendor-react';
            }
            // Group remaining node_modules into a vendor chunk
            return 'vendor';
          }
        },
      },
    },
  },
});
