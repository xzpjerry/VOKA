import { defineConfig } from "vite";
export default defineConfig({
  build: {
    rollupOptions: {
      input: { background: "src/background/index.ts", options: "options.html" },
      output: { entryFileNames: "[name].js" },
    },
  },
});
