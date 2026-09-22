import { defineConfig } from "vite";

export default defineConfig({
  base: process.env.GITHUB_PAGES === "true" ? "/roaring-static-search/" : "/",
  root: new URL("./demo", import.meta.url).pathname,
  build: {
    outDir: new URL("../dist", import.meta.url).pathname,
    emptyOutDir: true,
    rollupOptions: { output: { manualChunks: { hightable: ["react", "react-dom", "hightable"] } } },
  },
});
