import { build as viteBuild, defineConfig, type Plugin } from "vite";

function youtubeMainEntry(): Plugin {
  return {
    name: "voka-youtube-main-entry",
    async closeBundle() {
      await viteBuild({
        configFile: false,
        publicDir: false,
        build: {
          emptyOutDir: false,
          lib: {
            entry: "src/youtube/main-world.ts",
            name: "VokaYouTubeMain",
            formats: ["iife"],
            fileName: () => "youtube-main.js",
          },
        },
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const auto = mode === "auto";
  const content = {
    publicDir: false,
    define: { __VOKA_AUTO_RUN__: JSON.stringify(auto) },
    plugins: auto ? [] : [youtubeMainEntry()],
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
  return content;
});
