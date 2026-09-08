/**
 * Тела объявлений-функций: извлечение, нормализация и разница
 * (`specs/code-twins.md`).
 *
 * Нормализация делает ровно четыре вещи — снимает комментарии, сжимает
 * пробелы, переименовывает параметры и локальные имена по порядку
 * появления, заменяет литералы позиционными метками, — и ничего сверх
 * этого. Каждая из четырёх стирает различие, которое копия обычно и
 * несёт; пятая стирала бы различие, о котором никто не просил.
 *
 * Разбирается тело обходом узлов, а не сканером текста: сканер, начатый
 * с середины файла, не умеет добрать хвост шаблонного литерала — после
 * `` `${x}` `` он считает закрывающий апостроф началом нового литерала и
 * съедает весь остаток тела (замер 2026-09-08 на `ts.createScanner`
 * 5.9.3). Два тела, расходящиеся всем после шаблона, при этом
 * нормализовались бы в одно.
 *
 * Литералы нормализуются намеренно, и риск ложного сближения закрыт не
 * осторожностью, а печатью: раздел «похоже» отдельный, и разница
 * названа — решение остаётся за читателем.
 */

import type TS from "typescript";

/** Тело одного объявления-функции вместе с тем, чем его сравнивают. */
export interface Body {
  readonly path: string;
  /** Строка объявления, считая с единицы. */
  readonly line: number;
  /** Последняя строка тела: объявление охватывает строки до неё. */
  readonly endLine: number;
  readonly name: string;
  readonly signature: string;
  /** Текст от открывающей скобки до закрывающей включительно. */
  readonly text: string;
  /** Он же после нормализации: по нему ищутся «похожие». */
  readonly normalized: string;
  /** Тексты комментариев по порядку появления. */
  readonly comments: readonly string[];
  /** Тексты литералов по порядку появления, как они записаны. */
  readonly literals: readonly string[];
  /** Параметры и локальные имена по порядку появления, без повторов. */
  readonly names: readonly string[];
}

/**
 * Ответ операции «тела». Незнание — тоже ответ операции, а не её
 * отсутствие: текстовый анализатор тел не разбирает и говорит об этом
 * (`platform/code-analyzer.md`).
 */
export type Bodies =
  | { readonly kind: "known"; readonly bodies: readonly Body[] }
  | { readonly kind: "unknown"; readonly reason: string };

/** Узел-функция с телом-блоком: объявление, стрелка, метод. */
export type FunctionNode = TS.FunctionLikeDeclaration & {
  readonly body: TS.Block;
};

/**
 * Узел ли это функции с телом-блоком. Сигнатура без тела (перегрузка,
 * `declare`, объявление типа) телом не обладает, и сравнивать у неё
 * нечего.
 */
export function isFunctionWithBody(
  ts: typeof TS,
  node: TS.Node,
): node is FunctionNode {
  // `isFunctionLike` сужает до `SignatureDeclaration`, у которого поля
  // `body` нет: тело есть не у всякой сигнатуры. Проверяем наличие
  // поля, а не приводим тип на веру.
  if (!ts.isFunctionLike(node) || !("body" in node)) return false;
  const body: unknown = node.body;
  return body !== undefined && ts.isBlock(body as TS.Node);
}

/** Тела всех объявлений-функций файла. */
export function bodiesIn(
  ts: typeof TS,
  checker: TS.TypeChecker,
  file: TS.SourceFile,
  path: string,
): readonly Body[] {
  const found: Body[] = [];
  const visit = (node: TS.Node): void => {
    if (isFunctionWithBody(ts, node)) {
      found.push(bodyOf(ts, checker, node, file, path));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** Тело узла со всем, чем его сравнивают. */
export function bodyOf(
  ts: typeof TS,
  checker: TS.TypeChecker,
  node: FunctionNode,
  file: TS.SourceFile,
  path: string,
): Body {
  const parts = partsOf(ts, checker, node, file);
  return {
    path,
    line: lineAt(file, ownerOf(ts, node).getStart(file)),
    endLine: lineAt(file, node.body.getEnd()),
    name: nameOf(ts, node),
    signature: signatureOf(checker, node),
    text: node.body.getText(file),
    normalized: parts.normalized,
    comments: parts.comments,
    literals: parts.literals,
    names: parts.names,
  };
}

/** Узел, по которому считается строка объявления. */
function ownerOf(ts: typeof TS, node: FunctionNode): TS.Node {
  // У стрелки и функции-выражения объявляет имя не сам узел, а
  // переменная или свойство, в котором он лежит: строка нужна та, что
  // видит читатель.
  return ts.isVariableDeclaration(node.parent) ||
      ts.isPropertyAssignment(node.parent)
    ? node.parent
    : node;
}

/** Строка позиции, считая с единицы. */
function lineAt(file: TS.SourceFile, pos: number): number {
  return file.getLineAndCharacterOfPosition(pos).line + 1;
}

/** Имя объявления; безымянному телу имени не выдумывается. */
function nameOf(ts: typeof TS, node: FunctionNode): string {
  if (node.name !== undefined && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  const parent = node.parent;
  if (
    (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) &&
    ts.isIdentifier(parent.name)
  ) {
    return parent.name.text;
  }
  return "аноним";
}

/** Сигнатура объявления; вывести не удалось — пусто. */
function signatureOf(checker: TS.TypeChecker, node: FunctionNode): string {
  const signature = checker.getSignatureFromDeclaration(node);
  return signature === undefined ? "" : checker.signatureToString(signature);
}

/** Разобранное тело: нормальная форма и то, чем описывается разница. */
interface Parts {
  readonly normalized: string;
  readonly comments: readonly string[];
  readonly literals: readonly string[];
  readonly names: readonly string[];
}

/**
 * Разбирает тело обходом узлов: нормальная форма собирается из листьев
 * дерева, а не из потока токенов. Комментарии в листья не попадают —
 * они тривия, и снимаются самим этим устройством.
 */
function partsOf(
  ts: typeof TS,
  checker: TS.TypeChecker,
  node: FunctionNode,
  file: TS.SourceFile,
): Parts {
  const literals: string[] = [];
  const names: string[] = [];
  const marks = new Map<string, string>();
  const out: string[] = [];

  const visit = (child: TS.Node): void => {
    // `//` и `/* */` — тривия и в листья не попадают, а `/** */` —
    // полноценный узел дерева, и без этой строки док-комментарий уехал
    // бы в нормальную форму: два тела, различающиеся только им,
    // перестали бы быть похожими (замер 2026-09-08).
    if (isJsDoc(ts, child.kind)) return;
    const children = child.getChildren(file);
    if (children.length > 0) {
      for (const grand of children) visit(grand);
      return;
    }
    const text = child.getText(file);
    if (text === "") return;
    if (isLiteralKind(ts, child.kind)) {
      literals.push(text);
      out.push(`лит${literals.length}`);
      return;
    }
    if (!ts.isIdentifier(child) || !isLocal(checker, child, node)) {
      out.push(text);
      return;
    }
    if (!names.includes(text)) names.push(text);
    const known = marks.get(text);
    if (known !== undefined) {
      out.push(known);
      return;
    }
    const mark = `имя${marks.size + 1}`;
    marks.set(text, mark);
    out.push(mark);
  };
  visit(node.body);

  return {
    // Пробелы сжаты до одного между листьями: перенос строки и отступ
    // различием тел не считаются.
    normalized: out.join(" "),
    comments: commentsIn(ts, node.body, file),
    literals,
    names,
  };
}

/**
 * Локальное ли это имя — параметр или объявленное внутри узла. Сверка
 * идёт символом, а не написанием, и этим же снимается вопрос об именах
 * свойств: `box.start` при локальной `start` пишется так же, но
 * объявлено поле в другом месте, и переименовать его значило бы
 * сблизить тела, читающие разные поля. Отдельного запрета на имена
 * свойств не нужно — мутация показала, что он ничего не добавляет.
 */
function isLocal(
  checker: TS.TypeChecker,
  node: TS.Identifier,
  owner: FunctionNode,
): boolean {
  const symbol = checker.getSymbolAtLocation(node);
  const declaration = symbol?.declarations?.[0];
  if (declaration === undefined) return false;
  if (declaration.getSourceFile() !== owner.getSourceFile()) return false;
  return declaration.getStart() >= owner.getStart() &&
    declaration.getEnd() <= owner.getEnd();
}

/** Тексты комментариев тела по порядку появления. */
function commentsIn(
  ts: typeof TS,
  body: TS.Block,
  file: TS.SourceFile,
): readonly string[] {
  const found: { readonly pos: number; readonly text: string }[] = [];
  const seen = new Set<number>();
  const visit = (node: TS.Node): void => {
    const ranges = ts.getLeadingCommentRanges(file.text, node.getFullStart());
    for (const range of ranges ?? []) {
      if (range.pos < body.getStart(file) || seen.has(range.pos)) continue;
      seen.add(range.pos);
      found.push({
        pos: range.pos,
        text: file.text.slice(range.pos, range.end).trim(),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  // Закрывающая скобка — токен, а не потомок: комментарий перед ней
  // (в пустом блоке — единственный) виден только с этой стороны.
  const close = body.getLastToken(file);
  if (close !== undefined) visit(close);
  return found.sort((a, b) => a.pos - b.pos).map((entry) => entry.text);
}

/** Узел документирующего комментария — он же часть дерева, не тривия. */
function isJsDoc(ts: typeof TS, kind: TS.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstJSDocNode &&
    kind <= ts.SyntaxKind.LastJSDocNode;
}

function isLiteralKind(ts: typeof TS, kind: TS.SyntaxKind): boolean {
  return kind === ts.SyntaxKind.StringLiteral ||
    kind === ts.SyntaxKind.NumericLiteral ||
    kind === ts.SyntaxKind.BigIntLiteral ||
    kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
    kind === ts.SyntaxKind.RegularExpressionLiteral ||
    kind === ts.SyntaxKind.TemplateHead ||
    kind === ts.SyntaxKind.TemplateMiddle ||
    kind === ts.SyntaxKind.TemplateTail;
}

/**
 * Чем тело `other` расходится с телом `query`. Печатается всегда рядом
 * со строкой «похожего»: литералы нормализуются намеренно, и читатель
 * обязан видеть, что именно стёрто.
 */
export function difference(query: Body, other: Body): string {
  const parts = [
    ...commentDifference(query, other),
    ...literalDifference(query, other),
    ...nameDifference(query, other),
  ];
  // Ничего из перечисленного не разошлось — значит разошлись пробелы:
  // сказать «разницы нет» было бы неправдой, тела ведь не равны.
  return parts.length === 0 ? "форматирование" : parts.join("; ");
}

function commentDifference(query: Body, other: Body): readonly string[] {
  const same = query.comments.length === other.comments.length &&
    query.comments.every((text, index) => text === other.comments[index]);
  if (same) return [];
  if (other.comments.length === 0) return ["комментарий снят"];
  if (query.comments.length === 0) return ["комментарий добавлен"];
  return ["комментарии расходятся"];
}

/**
 * Расхождения литералов по позициям. Длины совпадают по построению:
 * разница считается только у тел с равной нормальной формой, а в ней
 * литералы стали позиционными метками.
 */
function literalDifference(query: Body, other: Body): readonly string[] {
  return query.literals
    .map((mine, index) => [mine, other.literals[index]] as const)
    .filter(([mine, theirs]) => mine !== theirs)
    .map(([mine, theirs]) => `литерал ${mine} против ${theirs}`);
}

function nameDifference(query: Body, other: Body): readonly string[] {
  const same = query.names.length === other.names.length &&
    query.names.every((name, index) => name === other.names[index]);
  return same ? [] : ["имена различаются"];
}
