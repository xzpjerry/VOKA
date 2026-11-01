import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));
const manifestSource = readFileSync(path.join(root, 'manifest.json'), 'utf8');

export default defineConfig({
  root,
  base: './',
  publicDir: false,
  build: {
    target: 'chrome111',
    outDir: path.join(root, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        'main-world': path.join(root, 'main-world.ts'),
        content: path.join(root, 'content.ts'),
        summary: path.join(root, 'summary.html'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  plugins: [{
    name: 'youtube-probe-manifest',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'manifest.json', source: manifestSource });
    },
  }],
});
