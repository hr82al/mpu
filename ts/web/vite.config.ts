/**
 * Сборка фронта (`specs/web.md`, «Приложение (10b)»): JSX — через
 * esbuild, тесты — vitest в jsdom, dev-сервер ходит к `mpu-back` через
 * прокси (адрес — `MPU_BACK_URL`, по умолчанию 7338).
 */

import process from "node:process";
import { defineConfig } from "vitest/config";

const back = process.env.MPU_BACK_URL ?? "http://127.0.0.1:7338";

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
  test: {
    environment: "jsdom",
    // Каждый файл — в своём контексте `vm`: под Bun у общего контекста
    // разбор CSS в jsdom (`cssstyle` → `splitValue("inset")`) после
    // нескольких случаев уходит в «Out of memory» (проба 2026-10-07:
    // поодиночке случаи зелёные, файлом — четыре красных за 170 с; в
    // `vmForks` — зелёные за 4 с). Под Node — тоже зелёные; Deno
    // `vm.SourceTextModule` не умеет, но фронт и гоняется под Bun
    // (`platform/node-runtime.md`, [S.14]).
    pool: "vmForks",
  },
});
