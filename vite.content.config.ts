import { defineConfig } from "vite";
export default defineConfig(({ mode }) => {
  const auto = mode === "auto";
  return {
    publicDir: false,
    define: { __VOKA_AUTO_RUN__: JSON.stringify(auto) },
    build: {
      emptyOutDir: false,
      lib: {
        entry: "src/content.ts",
        name: auto ? "VokaContentAuto" : "VokaContent",
        formats: ["iife"],
        fileName: () => (auto ? "content-auto.js" : "content.js"),
      },
    },
  };
});
