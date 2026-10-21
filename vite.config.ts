import { defineConfig } from 'vite';

export default defineConfig({
  build: { target: 'es2022', rollupOptions: { output: { manualChunks: { three: ['three'] } } } },
  server: { host: process.env.HOST ?? '127.0.0.1', hmr: { port: Number(process.env.HMR_PORT ?? Number(process.env.PORT ?? 4173) + 100) } },
});
