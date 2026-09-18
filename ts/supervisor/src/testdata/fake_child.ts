// Поддельный дочерний супервизора: поведение — первым аргументом.
//   crash    — строка в stdout и stderr, выход с кодом 1;
//   live     — строка с PID, живёт до SIGTERM;
//   stubborn — SIGTERM игнорирует (гасится только SIGKILL), строка с PID —
//              после того, как обработчик стоит: по ней тест знает, что
//              SIGTERM уже не убьёт.
const [mode, ...rest] = Deno.args;
if (mode === "stubborn") Deno.addSignalListener("SIGTERM", () => {});
console.log(`${mode} pid ${Deno.pid} ${rest.join(" ")}`);
if (mode === "crash") {
  console.error("упал");
  Deno.exit(1);
}
setInterval(() => {}, 60_000);
