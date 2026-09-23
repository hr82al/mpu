/**
 * Пересборка голденов образа `src/line/testdata/image/`
 * (`docs/specs/platform/image.md`, «Golden-примеры»): снимок `kiten
 * messages` и справки метода после определения — прогоном на стенде.
 *
 *   deno run --allow-all back/scripts/gen-image-cases.ts
 */

import { IMAGE_DIR, imageGoldens } from "../src/line/testimage.ts";

await Deno.mkdir(IMAGE_DIR, { recursive: true });
const taken = await imageGoldens();
for (const [name, text] of Object.entries(taken)) {
  await Deno.writeTextFile(new URL(name, IMAGE_DIR), text);
}
console.log(`файлов: ${Object.keys(taken).length}`);
