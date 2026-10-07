// Потомок, занявший 300 МиБ, для `watchdog_live.test.ts`: строка в stdout,
// когда память занята, затем минута ожидания — сторож убивает его раньше.
const eaten = new Uint8Array(300 * 1024 * 1024).fill(1);
console.log("съел", eaten.length);
await new Promise((resolve) => setTimeout(resolve, 60_000));
// Ссылка на массив живёт до конца ожидания: иначе сборщик Bun отдаёт
// память сразу после печати, и сторож видит не 300 МиБ.
console.log(eaten[0]);
