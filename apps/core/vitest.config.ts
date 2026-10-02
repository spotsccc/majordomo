import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Same `@/*` alias as tsconfig, so tests can import route modules.
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
});
