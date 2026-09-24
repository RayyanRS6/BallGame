import { defineConfig } from 'vite';

const serverPort = Number(process.env.PORT ?? 8787);

export default defineConfig({
  root: '.',
  publicDir: 'public',
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    port: Number(process.env.CLIENT_PORT ?? 5173),
    host: true,
    proxy: {
      '/ws': { target: `ws://localhost:${serverPort}`, ws: true },
      '/api': { target: `http://localhost:${serverPort}` },
    },
  },
});
