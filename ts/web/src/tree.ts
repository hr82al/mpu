/**
 * Дерево экрана «Правила» (`specs/web.md`, «Приложение (10b)»): узлы
 * `policy.tree` с назначениями из `tree.snapshot`. Решения — только с
 * сервера: фронт их не вычисляет, «смешанно» лишь сводит пришедшие.
 */

import type { NodeRuling, SnapshotNode } from "./api.ts";

/** Узел экрана. */
export interface RuleNode {
  readonly path: readonly string[];
  /** Путь текстом: `kiten card`; корень — `*`. */
  readonly key: string;
  readonly summary: string;
  readonly verdict: string;
  readonly rule: string | null;
  readonly own: boolean;
  /** У потомков разные действующие решения. */
  readonly mixed: boolean;
  readonly children: readonly RuleNode[];
}

export function keyOf(path: readonly string[]): string {
  return path.length === 0 ? "*" : path.join(" ");
}

/** Решения поддерева: своё и всех потомков. */
function verdicts(node: RuleNode): string[] {
  return [node.verdict, ...node.children.flatMap(verdicts)];
}

/**
 * Дерево из ответов сервера: корень — узел с пустым путём; дети — по
 * порядку `policy.tree` (обход в глубину, дети по алфавиту).
 */
export function buildTree(
  rulings: readonly NodeRuling[],
  snapshot: readonly SnapshotNode[],
): RuleNode | undefined {
  const summaries = new Map(
    snapshot.map((node) => [keyOf(node.path), node.summary]),
  );
  const byParent = new Map<string, NodeRuling[]>();
  for (const ruling of rulings) {
    if (ruling.path.length === 0) continue;
    const parent = keyOf(ruling.path.slice(0, -1));
    byParent.set(parent, [...byParent.get(parent) ?? [], ruling]);
  }
  const build = (ruling: NodeRuling): RuleNode => {
    const key = keyOf(ruling.path);
    const children = (byParent.get(key) ?? []).map(build);
    const below = new Set(children.flatMap(verdicts));
    return {
      path: ruling.path,
      key,
      summary: summaries.get(key) ?? "",
      verdict: ruling.verdict,
      rule: ruling.rule,
      own: ruling.own,
      mixed: below.size > 1,
      children,
    };
  };
  const root = rulings.find((ruling) => ruling.path.length === 0);
  return root === undefined ? undefined : build(root);
}

/**
 * Отбор по поиску: узел остаётся, если его путь содержит строку поиска
 * или остался кто-то из потомков. Пустой поиск — дерево как есть.
 */
export function filterTree(
  node: RuleNode,
  search: string,
): RuleNode | undefined {
  const needle = search.trim().toLowerCase();
  if (needle === "") return node;
  const children = node.children
    .map((child) => filterTree(child, needle))
    .filter((child): child is RuleNode => child !== undefined);
  if (children.length > 0 || node.key.toLowerCase().includes(needle)) {
    return { ...node, children };
  }
  return undefined;
}

/** Откуда решение: путь правила или «по умолчанию: ask». */
export function originOf(node: RuleNode): string {
  return node.rule === null ? "по умолчанию: ask" : `правило «${node.rule}»`;
}
