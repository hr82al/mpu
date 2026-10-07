/**
 * Файл интерфейса домена: `interface.json` и `INTERFACE.md` по графу
 * домена. Описание и справка — те же, что у отражения.
 */

import type { Description } from "./description.ts";
import { Graph, type Node, type Root } from "./graph.ts";

export type { Root } from "./graph.ts";

/** Интерфейс домена данными: путь корня и получатели по имени класса. */
export interface InterfaceFile {
	readonly path: string;
	readonly receivers: Readonly<Record<string, Description>>;
}

/** Интерфейс домена данными. */
export function interfaceOf<T>(domain: Root<T>): InterfaceFile {
	return {
		path: domain.path.join(" "),
		receivers: Object.fromEntries(
			Graph.of(domain)
				.nodes()
				.map((node) => [node.name, node.describe()]),
		),
	};
}

/** `interface.json`: два пробела, перевод строки в конце. */
export function interfaceJson<T>(domain: Root<T>): string {
	return `${JSON.stringify(interfaceOf(domain), null, 2)}\n`;
}

/** `INTERFACE.md` — справка каждого метода по классам. */
export function interfaceMarkdown<T>(domain: Root<T>): string {
	const lines = [
		`# Интерфейс ${domain.path.join(" ")}`,
		"",
		"Собран из `about` командой `bun run interface`; руками не правится.",
	];
	for (const node of Graph.of(domain).nodes()) {
		lines.push(...receiverMarkdown(node));
	}
	return `${lines.join("\n")}\n`;
}

function receiverMarkdown(node: Node): string[] {
	const lines = [
		"",
		`## ${node.name} — \`${node.path.join(" ")}\``,
		"",
		node.describe().comment,
	];
	for (const { selector, description, help } of node.pages()) {
		lines.push(
			"",
			`### ${selector}`,
			"",
			`эффект: ${description.effect} · возвращает: ${description.returns}`,
			"",
			"```text",
			help,
			"```",
		);
	}
	return lines;
}
