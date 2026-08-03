import { assertEquals, assertRejects } from "@std/assert";
import { unzip, ZipError } from "./zip.ts";

const encoder = new TextEncoder();

function le(value: number, bytes: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < bytes; i++) out.push((value >>> (8 * i)) & 0xff);
  return out;
}

interface RawEntry {
  readonly name: string;
  /** Исходное содержимое (для сверки после распаковки). */
  readonly data: Uint8Array;
  readonly method: number;
  /** Байты, лежащие в архиве (для stored совпадают с data). */
  readonly stored: Uint8Array;
}

// Параметр сужен до буфера, который принимает `Blob`: фикстуры теста
// строит `TextEncoder`, и обходить это копией, как в самом ридере, незачем.
async function deflate(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new Blob([data]).stream()
    .pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Собирает корректный zip вручную: local-заголовки, каталог, EOCD. */
function buildZip(entries: readonly RawEntry[], comment = ""): Uint8Array {
  const chunks: number[] = [];
  const central: number[] = [];
  for (const entry of entries) {
    const name = [...encoder.encode(entry.name)];
    const offset = chunks.length;
    chunks.push(
      ...le(0x04034b50, 4), // сигнатура local file header
      ...le(20, 2), // version needed
      ...le(0, 2), // flags
      ...le(entry.method, 2),
      ...le(0, 2), // время
      ...le(0, 2), // дата
      ...le(0, 4), // crc32 (ридер не проверяет)
      ...le(entry.stored.length, 4),
      ...le(entry.data.length, 4),
      ...le(name.length, 2),
      ...le(0, 2), // extra
      ...name,
      ...entry.stored,
    );
    central.push(
      ...le(0x02014b50, 4), // сигнатура central directory entry
      ...le(20, 2), // version made by
      ...le(20, 2), // version needed
      ...le(0, 2), // flags
      ...le(entry.method, 2),
      ...le(0, 2), // время
      ...le(0, 2), // дата
      ...le(0, 4), // crc32
      ...le(entry.stored.length, 4),
      ...le(entry.data.length, 4),
      ...le(name.length, 2),
      ...le(0, 2), // extra
      ...le(0, 2), // comment
      ...le(0, 2), // disk start
      ...le(0, 2), // internal attrs
      ...le(0, 4), // external attrs
      ...le(offset, 4),
      ...name,
    );
  }
  const commentBytes = [...encoder.encode(comment)];
  const eocd = [
    ...le(0x06054b50, 4), // сигнатура EOCD
    ...le(0, 2), // диск
    ...le(0, 2), // диск каталога
    ...le(entries.length, 2),
    ...le(entries.length, 2),
    ...le(central.length, 4),
    ...le(chunks.length, 4), // смещение каталога
    ...le(commentBytes.length, 2),
    ...commentBytes,
  ];
  return new Uint8Array([...chunks, ...central, ...eocd]);
}

function storedEntry(name: string, text: string): RawEntry {
  const data = encoder.encode(text);
  return { name, data, method: 0, stored: data };
}

Deno.test("unzip: stored-записи возвращаются по именам", async () => {
  const zip = buildZip([
    storedEntry("a.txt", "alpha"),
    storedEntry("dir/b.txt", "бета"),
  ]);
  const files = await unzip(zip);
  assertEquals([...files.keys()], ["a.txt", "dir/b.txt"]);
  assertEquals(new TextDecoder().decode(files.get("a.txt")), "alpha");
  assertEquals(new TextDecoder().decode(files.get("dir/b.txt")), "бета");
});

Deno.test("unzip: deflate-запись распаковывается", async () => {
  const data = encoder.encode("содержимое ".repeat(50));
  const zip = buildZip([
    { name: "sheet.xml", data, method: 8, stored: await deflate(data) },
  ]);
  const files = await unzip(zip);
  assertEquals(files.get("sheet.xml"), data);
});

Deno.test("unzip: EOCD ищется и при комментарии архива", async () => {
  const zip = buildZip([storedEntry("a.txt", "x")], "trailing comment");
  const files = await unzip(zip);
  assertEquals(new TextDecoder().decode(files.get("a.txt")), "x");
});

Deno.test("unzip: сигнатура EOCD в комментарии не обманывает", async () => {
  // Байты 50 4B 05 06 в комментарии — ложный кандидат ближе к концу;
  // настоящий EOCD распознаётся по согласованной длине комментария.
  const comment = "xx\x50\x4b\x05\x06" + "\x00".repeat(20);
  const zip = buildZip([storedEntry("a.txt", "данные")], comment);
  const files = await unzip(zip);
  assertEquals(new TextDecoder().decode(files.get("a.txt")), "данные");
});

Deno.test("unzip: не-zip и пустой ввод — «not a zip archive»", async (t) => {
  const cases: Record<string, Uint8Array> = {
    "текст": encoder.encode("this is not a zip archive"),
    "пусто": new Uint8Array(0),
    "короче EOCD": encoder.encode("PK"),
  };
  for (const [name, bytes] of Object.entries(cases)) {
    await t.step(name, async () => {
      await assertRejects(() => unzip(bytes), ZipError, "not a zip archive");
    });
  }
});

Deno.test("unzip: неизвестный метод сжатия — ошибка с номером", async () => {
  const data = encoder.encode("x");
  const zip = buildZip([{ name: "a", data, method: 12, stored: data }]);
  await assertRejects(() => unzip(zip), ZipError, "method 12");
});

Deno.test("unzip: битый deflate-поток — ошибка с именем записи", async () => {
  const data = encoder.encode("не deflate");
  const zip = buildZip([{ name: "bad.xml", data, method: 8, stored: data }]);
  await assertRejects(() => unzip(zip), ZipError, "bad.xml");
});

Deno.test("unzip: усечённый каталог — ошибка, не паника", async () => {
  const whole = buildZip([storedEntry("a.txt", "alpha")]);
  // Обрезаем часть central directory, EOCD приклеиваем обратно.
  const eocd = whole.subarray(whole.length - 22);
  const truncated = new Uint8Array([
    ...whole.subarray(0, whole.length - 30),
    ...eocd,
  ]);
  await assertRejects(() => unzip(truncated), ZipError);
});
