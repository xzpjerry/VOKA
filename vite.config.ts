import { defineConfig } from "vite";
export default defineConfig({
  define: {
    __VOKA_RPC_LOG__: JSON.stringify(process.env.VOKA_RPC_LOG === "1"),
  },
  build: {
    rollupOptions: {
      input: {
        background: "src/background/index.ts",
        options: "options.html",
        popup: "popup.html",
        reader: "reader.html",
      },
      output: { entryFileNames: "[name].js" },
    },
  },
});
