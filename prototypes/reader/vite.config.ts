import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root,
  base: "./",
  publicDir: "public",
  build: {
    outDir: resolve(root, "../../.cache/reader-extension"),
    emptyOutDir: true,
    target: "chrome120",
    minify: "esbuild",
    sourcemap: false,
    rollupOptions: {
      input: {
        reader: resolve(root, "reader.html"),
        background: resolve(root, "background.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
