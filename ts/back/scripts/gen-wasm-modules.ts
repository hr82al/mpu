/**
 * Модуль байтов wasm криптографии MTProto `back/src/telegram/wasm_modules.ts`
 * (`docs/specs/platform/node-runtime.md`, [S.8], [S.9b]) из
 * установленного `node_modules/@mtcute/wasm`. Зовётся установкой
 * (`postinstall`) и сборкой: модуль не коммитится, а выводится из пакета,
 * поэтому бамп `@mtcute/wasm` пересобирает его сам. Совпадение байтов с
 * манифестом пакета сверяет `telegram/crypto.test.ts`.
 *
 *   bun back/scripts/gen-wasm-modules.ts
 */

import { readFile, writeFile } from "node:fs/promises";

const PACKAGE = new URL("../../node_modules/@mtcute/wasm/", import.meta.url);
const TARGET = new URL("../src/telegram/wasm_modules.ts", import.meta.url);

const version = (
  JSON.parse(await readFile(new URL("package.json", PACKAGE), "utf8")) as {
    version: string;
  }
).version;
const base64 = async (name: string) =>
  (await readFile(new URL(name, PACKAGE))).toString("base64");

await writeFile(
  TARGET,
  `/**
 * Байты wasm криптографии MTProto — \`mtcute-simd.wasm\` и \`mtcute.wasm\` из
 * \`@mtcute/wasm@${version}\`, base64 (\`docs/specs/platform/node-runtime.md\`, [S.8]).
 *
 * Модулем, а не файлом рядом: файл читается API рантайма или по
 * \`import.meta.url\`, и у собранной программы его нет (замер этапа 2:
 * бинарь Bun — «Cannot find module '@mtcute/wasm/mtcute-simd.wasm'»).
 * Порождён \`back/scripts/gen-wasm-modules.ts\` из \`node_modules/@mtcute/wasm\`
 * и не коммитится; совпадение с пакетом сверяет \`crypto.test.ts\`.
 */

/** \`mtcute-simd.wasm\` — сборка для движков с SIMD. */
export const MTCUTE_SIMD_WASM =
  "${await base64("mtcute-simd.wasm")}";

/** \`mtcute.wasm\` — сборка без SIMD. */
export const MTCUTE_WASM =
  "${await base64("mtcute.wasm")}";
`,
);
