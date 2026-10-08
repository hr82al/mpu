/**
 * Экран «Правила» (`specs/web.md`, «Приложение (10b)»): дерево команд с
 * действующими решениями сервера, поиск, действия узла с подтверждением.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  type MessageLine,
  type NodeRuling,
  rpc,
  type Snapshot,
} from "./api.ts";
import { Confirm } from "./Confirm.tsx";
import { loadExpanded, saveExpanded } from "./expanded.ts";
import { useTransport } from "./transport.tsx";
import { buildTree, filterTree, originOf, type RuleNode } from "./tree.ts";
import { told, useLine } from "./useLine.ts";

const VERDICTS = ["allow", "ask", "deny"] as const;

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    // Доступ к хранилищу запрещён — раскрытые узлы не помнятся.
    return undefined;
  }
}

export function NoSession() {
  return (
    <main>
      <h1>mpu</h1>
      <p>
        Откройте ссылку из <code>mpu web</code>.
      </p>
    </main>
  );
}

export function Unreachable({
  base,
  retry,
}: {
  base: string;
  retry: () => void;
}) {
  return (
    <main>
      <h1>mpu</h1>
      <p role="alert">mpu-back недоступен на {base}</p>
      <button type="button" onClick={retry}>
        Повторить
      </button>
    </main>
  );
}

interface RowProps {
  readonly node: RuleNode;
  readonly depth: number;
  readonly expanded: ReadonlySet<string>;
  readonly searching: boolean;
  readonly toggle: (key: string) => void;
  readonly change: (words: string[]) => void;
}

function Row(props: RowProps) {
  const { node, depth, expanded, searching, toggle, change } = props;
  const open = depth === 0 || searching || expanded.has(node.key);
  const target = node.path.length === 0 ? "*" : node.key;
  return (
    <li>
      <div className="node" data-verdict={node.verdict}>
        {node.children.length > 0 && depth > 0 && (
          <button
            type="button"
            aria-expanded={open}
            aria-label={`${open ? "свернуть" : "раскрыть"} ${node.key}`}
            onClick={() => toggle(node.key)}
          >
            {open ? "−" : "+"}
          </button>
        )}
        <span className="path">{node.key}</span>
        <span className="summary">{node.summary}</span>
        <span className={`verdict verdict-${node.verdict}`}>
          {node.verdict}
        </span>
        <span className="origin">{originOf(node)}</span>
        {node.own && <span className="own">своё</span>}
        {node.mixed && <span className="mixed">смешанно</span>}
        <span className="actions">
          {VERDICTS.map((verdict) => (
            <button
              key={verdict}
              type="button"
              aria-label={`${verdict} для ${node.key}`}
              onClick={() => change([`${verdict}:`, "--", target])}
            >
              {verdict}
            </button>
          ))}
          {node.own && (
            <button
              type="button"
              aria-label={`сбросить ${node.key}`}
              onClick={() => change(["forget:", "--", target])}
            >
              сбросить
            </button>
          )}
        </span>
      </div>
      {open && node.children.length > 0 && (
        <ul>
          {node.children.map((child) => (
            <Row
              key={child.key}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              searching={searching}
              toggle={toggle}
              change={change}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/** Протокол, который понимает любой объект: один блок, у корня. */
function Protocol({ lines }: { lines: readonly MessageLine[] }) {
  return (
    <section aria-label="понимает любой объект">
      <h2>Понимает любой объект</h2>
      <ul className="protocol">
        {lines.map((line) => (
          <li key={line.selector}>
            <code>{line.selector}</code> — {line.purpose}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Rules() {
  const transport = useTransport();
  const client = useQueryClient();
  const rulings = useQuery({
    queryKey: ["policy.tree"],
    queryFn: () => rpc<NodeRuling[]>(transport, "policy.tree"),
  });
  const snapshot = useQuery({
    queryKey: ["tree.snapshot"],
    queryFn: () => rpc<Snapshot>(transport, "tree.snapshot"),
  });
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState(() => loadExpanded(storage()));
  const reread = () => {
    client.invalidateQueries({ queryKey: ["policy.tree"] });
    client.invalidateQueries({ queryKey: ["tree.snapshot"] });
  };
  const change = useLine(reread);
  const tree = useMemo(() => {
    if (rulings.data?.kind !== "loaded" || snapshot.data?.kind !== "loaded") {
      return undefined;
    }
    return buildTree(rulings.data.value, snapshot.data.value.nodes);
  }, [rulings.data, snapshot.data]);

  const replies = [rulings.data, snapshot.data];
  if (replies.some((reply) => reply?.kind === "no-session")) {
    return <NoSession />;
  }
  const down = replies.find((reply) => reply?.kind === "unreachable");
  if (down?.kind === "unreachable") {
    return (
      <Unreachable
        base={down.base}
        retry={() => {
          rulings.refetch();
          snapshot.refetch();
        }}
      />
    );
  }
  if (tree === undefined) return <main aria-busy="true">Загрузка…</main>;

  const toggle = (key: string) => {
    const next = new Set(expanded);
    if (!next.delete(key)) next.add(key);
    setExpanded(next);
    saveExpanded(storage(), next);
  };
  const shown = filterTree(tree, search);
  const said = told(change.last);
  const protocol =
    snapshot.data?.kind === "loaded" ? snapshot.data.value.protocol : [];
  return (
    <main>
      <h1>Правила подтверждения</h1>
      <label>
        Поиск по пути{" "}
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      {said !== "" && <p role="alert">{said}</p>}
      <Protocol lines={protocol} />
      <ul className="tree">
        {shown !== undefined && (
          <Row
            node={shown}
            depth={0}
            expanded={expanded}
            searching={search.trim() !== ""}
            toggle={toggle}
            change={(words) => change.send(words)}
          />
        )}
      </ul>
      {change.pending !== undefined && (
        <Confirm
          question={change.pending.question}
          onAnswer={(yes) => change.respond(yes)}
        />
      )}
    </main>
  );
}
