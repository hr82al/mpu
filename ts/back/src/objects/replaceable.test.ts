import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  DATA,
  type Doc,
  type Loader,
  origin,
  Replaceable,
  runChain,
  Shape,
  unary,
} from "./mod.ts";

const DOC: Doc = { purpose: "проба", help: "Справка: проба." };

class Probe {
  #calls = 0;

  touch() {
    this.#calls++;
  }

  calls(): number {
    return this.#calls;
  }
}

/** Функция метода из загруженного модуля; иная форма модуля — ошибка. */
function methodOf(mod: unknown): (self: Probe) => string {
  if (typeof mod !== "object" || mod === null || !("default" in mod)) {
    throw new Error("в модуле нет экспорта по умолчанию");
  }
  const run = mod.default;
  if (typeof run !== "function") {
    throw new Error("экспорт по умолчанию — не функция");
  }
  return (self) => String(run(self));
}

const load: Loader<Probe, string> = async (url) =>
  methodOf(await import(url.href));

async function writeModule(
  dir: string,
  name: string,
  answer: string,
): Promise<URL> {
  const path = `${dir}/${name}`;
  await writeFile(path, `export default () => ${JSON.stringify(answer)};\n`);
  return new URL(`file://${path}`);
}

it("новая версия метода отвечает следующему сообщению", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const ping = await Replaceable.load(
      load,
      await writeModule(dir, "a.ts", "A"),
    );
    const probeShape = new Shape<Probe>([
      unary("ping", DOC, DATA, (p) => {
        p.touch();
        return ping.run(p);
      }),
      unary("calls", DOC, DATA, (p) => p.calls()),
    ]);
    const root = origin(
      DOC,
      new Shape<Probe>([unary("probe", DOC, probeShape, (p) => p)]),
      new Probe(),
    );

    expect(await runChain(["probe", "ping"], root)).toStrictEqual({
      path: ["probe", "ping"],
      value: "A",
    });
    await ping.use(await writeModule(dir, "b.ts", "B"));
    expect(await runChain(["probe", "ping"], root)).toStrictEqual({
      path: ["probe", "ping"],
      value: "B",
    });
    expect(await runChain(["probe", "calls"], root)).toStrictEqual({
      path: ["probe", "calls"],
      value: 2,
    });
  } finally {
    await rm(dir, { recursive: true });
  }
});
