// Поддельный дочерний супервизора: поведение — первым аргументом.
//   crash    — строка в stdout и stderr, выход с кодом 1;
//   live     — строка с PID, живёт до SIGTERM;
//   stubborn — SIGTERM игнорирует (гасится только SIGKILL), строка с PID —
//              после того, как обработчик стоит: по ней тест знает, что
//              SIGTERM уже не убьёт.
import process from "node:process";

const [mode, ...rest] = process.argv.slice(2);
if (mode === "stubborn") process.on("SIGTERM", () => {});
console.log(`${mode} pid ${process.pid} ${rest.join(" ")}`);
if (mode === "crash") {
  console.error("упал");
  process.exit(1);
}
setInterval(() => {}, 60_000);
