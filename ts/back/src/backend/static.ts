/**
 * Статика фронта (`specs/web.md`, «Статика (10a)»): `/` и маршруты
 * приложения (путь без расширения) — `index.html`, `/assets/*` — файл.
 * Без токена; `Content-Security-Policy: default-src 'self'`.
 */

const CSP = { "Content-Security-Policy": "default-src 'self'" };

const NOT_INSTALLED = "mpu-back: фронт не установлен\n";

/** Тип по расширению: то, что кладёт сборка приложения. */
const TYPES: Readonly<Record<string, string>> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  woff2: "font/woff2",
  map: "application/json",
};

function typeOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return TYPES[path.slice(dot + 1)] ?? "application/octet-stream";
}

async function file(path: string): Promise<Response | undefined> {
  try {
    const bytes = await Deno.readFile(path);
    return new Response(bytes, {
      headers: { ...CSP, "Content-Type": typeOf(path) },
    });
  } catch {
    // Нет файла, нет права, каталог вместо файла — отдавать нечего.
    return undefined;
  }
}

/**
 * Ответ статики на путь запроса.
 *
 * @param root каталог собранного фронта
 * @param pathname путь запроса
 */
export async function staticFile(
  root: string,
  pathname: string,
): Promise<Response> {
  let segments: string[];
  try {
    segments = decodeURIComponent(pathname).split("/").filter((one) =>
      one !== ""
    );
  } catch {
    // Путь не раскодировался — такого файла нет.
    return new Response(null, { status: 404 });
  }
  // Выход за каталог — не путь фронта.
  if (segments.some((one) => one === ".." || one === ".")) {
    return new Response(null, { status: 404 });
  }
  const last = segments.at(-1) ?? "";
  const route = segments.length === 0 || !last.includes(".");
  if (route) {
    const index = await file(`${root}/index.html`);
    return index ?? new Response(NOT_INSTALLED, {
      headers: { ...CSP, "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  if (segments[0] !== "assets") return new Response(null, { status: 404 });
  return (await file(`${root}/${segments.join("/")}`)) ??
    new Response(null, { status: 404 });
}
