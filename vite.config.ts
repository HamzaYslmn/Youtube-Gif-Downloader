import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base "./" works on GitHub Pages project paths and custom domains alike.
// mediabunny (~700 kB) is already lazy-loaded, only when video is involved, so its size warning is noise.
export default defineConfig({ base: "./", plugins: [react()], build: { chunkSizeWarningLimit: 800 } });
