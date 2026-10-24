import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Tauri erwartet festen Port; zwei Einstiegsseiten: App + Cursor-Overlay.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/**', '**/website/**'] } },
  build: {
    target: 'es2022',
    rollupOptions: { input: { main: resolve('index.html'), overlay: resolve('overlay.html') } },
  },
});
