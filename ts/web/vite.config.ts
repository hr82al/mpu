/**
 * Сборка фронта (`specs/web.md`, «Приложение (10b)»): JSX — через
 * esbuild, тесты — vitest в jsdom, dev-сервер ходит к `mpu-back` через
 * прокси (адрес — `MPU_BACK_URL`, по умолчанию 7338).
 */

import { defineConfig } from "vitest/config";

const back = Deno.env.get("MPU_BACK_URL") ?? "http://127.0.0.1:7338";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  build: { emptyOutDir: true },
  server: {
    host: "mpu.localhost",
    proxy: {
      "/rpc": back,
      "/line": { target: back, ws: true },
      "/web": back,
    },
  },
  test: { environment: "jsdom" },
});
