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
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Split vendor chunks to reduce memory pressure during build
          if (id.includes('node_modules')) {
            // React ecosystem
            if (id.includes('react')) {
              return 'vendor-react';
            }
            // Solana + Crossmint must stay together - they have circular deps
            // Using a single chunk avoids TDZ (Temporal Dead Zone) errors
            if (id.includes('@solana') || id.includes('solana') ||
                id.includes('@crossmint') || id.includes('crossmint') ||
                id.includes('bs58') || id.includes('buffer') ||
                id.includes('borsh') || id.includes('bn.js') ||
                id.includes('rpc-websockets') || id.includes('superstruct')) {
              return 'vendor-web3';
            }
            // All other node_modules
            return 'vendor';
          }
        },
      },
    },
  },
});
