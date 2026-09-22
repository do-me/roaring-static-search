import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [tailwindcss()],
  base: process.env.GITHUB_PAGES === "true" ? "/roaring-static-search/" : "/",
  root: new URL("./demo", import.meta.url).pathname,
  build: {
    outDir: new URL("../dist", import.meta.url).pathname,
    emptyOutDir: true,
    rollupOptions: { output: { manualChunks: { hightable: ["react", "react-dom", "hightable"] } } },
  },
});
