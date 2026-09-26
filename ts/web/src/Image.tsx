/**
 * Экран «Образ» (`web-image.md`): что изменит `image sync`, сведение базы
 * с файлами, конфликты кнопками. Вид итога решают потоки, а не код
 * выхода: `stdout` — отчёт, `stderr` — под кнопками, `refusal.hint` —
 * кнопка «Выполнить».
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type Outcome, rpc, type Snapshot } from "./api.ts";
import { Confirm } from "./Confirm.tsx";
import { type ReportLine, reportLines } from "./report.ts";
import { NoSession, Unreachable } from "./Rules.tsx";
import { useTransport } from "./transport.tsx";
import { keyOf } from "./tree.ts";
import { told, useLine } from "./useLine.ts";

const SYNC = ["ask", "image", "sync"];
const DRY = [...SYNC, "dry"];

interface RowProps {
  readonly line: ReportLine;
  readonly snapshot: Snapshot;
  readonly send: (words: readonly string[]) => void;
}

/** Строка отчёта: конфликт — с определением базы и кнопками, прочее — текст. */
function Row({ line, snapshot, send }: RowProps) {
  switch (line.kind) {
    case "text":
      return <li className="report-line">{line.text}</li>;
    case "conflict":
      return <Conflict {...line} snapshot={snapshot} send={send} />;
  }
}

interface ConflictProps {
  readonly method: string;
  readonly address: string;
  readonly snapshot: Snapshot;
  readonly send: (words: readonly string[]) => void;
}

function Conflict({ method, address, snapshot, send }: ConflictProps) {
  const node = snapshot.nodes.find((one) => keyOf(one.path) === method);
  return (
    <li className="report-line conflict">
      <span className="path">{method}</span>
      {node?.image === undefined
        ? <span className="definition">определения нет</span>
        : <code className="definition">{node.image.definition}</code>}
      <button type="button" onClick={() => send([...SYNC, "base:", address])}>
        взять базу
      </button>
      <button type="button" onClick={() => send([...SYNC, "files:", address])}>
        взять файлы
      </button>
    </li>
  );
}

/** Что показал последний итог: текст под кнопками и «Выполнить». */
function Said({ last, send }: {
  last: Outcome | undefined;
  send: (words: readonly string[]) => void;
}) {
  const said = told(last);
  const hint = last?.refusal?.hint ?? null;
  return (
    <>
      {said !== "" && <p className="said">{said}</p>}
      {hint !== null && (
        <button type="button" onClick={() => send(hint)}>
          Выполнить: mpu {hint.join(" ")}
        </button>
      )}
    </>
  );
}

export function Image() {
  const transport = useTransport();
  const client = useQueryClient();
  const snapshot = useQuery({
    queryKey: ["tree.snapshot"],
    queryFn: () => rpc<Snapshot>(transport, "tree.snapshot"),
  });
  const line = useLine(() => {
    client.invalidateQueries({ queryKey: ["policy.tree"] });
    client.invalidateQueries({ queryKey: ["tree.snapshot"] });
  });
  const reply = snapshot.data;
  if (reply?.kind === "no-session") return <NoSession />;
  if (reply?.kind === "unreachable") {
    return <Unreachable base={reply.base} retry={() => snapshot.refetch()} />;
  }
  if (reply === undefined) return <main aria-busy="true">Загрузка…</main>;
  const send = (words: readonly string[]) => line.send(words);
  return (
    <main>
      <h1>Образ</h1>
      <button type="button" onClick={() => send(DRY)}>Проверить</button>
      <button type="button" onClick={() => send(SYNC)}>Синхронизировать</button>
      <Said last={line.last} send={send} />
      {line.last === undefined
        ? <p>Отчёта ещё нет</p>
        : (
          <ul className="report" aria-label="отчёт">
            {reportLines(line.last.stdout).map((one, i) => (
              <Row key={i} line={one} snapshot={reply.value} send={send} />
            ))}
          </ul>
        )}
      {line.pending !== undefined && (
        <Confirm
          question={line.pending.question}
          onAnswer={(yes) => line.respond(yes)}
        />
      )}
    </main>
  );
}
