import { copyFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const reviewerDist = resolve(import.meta.dirname, "dist");
const notices = resolve(import.meta.dirname, "../../THIRD_PARTY_NOTICES.md");

export default defineConfig({
  plugins: [
    react(),
    {
      name: "trajpack-third-party-notices",
      apply: "build",
      async closeBundle() {
        await mkdir(reviewerDist, { recursive: true });
        await copyFile(notices, join(reviewerDist, "THIRD_PARTY_NOTICES.md"));
      },
    },
  ],
  build: {
    sourcemap: false,
    target: "es2023",
  },
  server: {
    host: "127.0.0.1",
    strictPort: false,
  },
  preview: {
    host: "127.0.0.1",
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    css: true,
    restoreMocks: true,
  },
});
