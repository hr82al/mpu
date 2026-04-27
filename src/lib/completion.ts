import type { Command } from 'commander';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type Shell = 'bash' | 'fish' | 'zsh';
export const SHELLS: readonly Shell[] = ['bash', 'fish', 'zsh'];

export interface ProviderContext {
  /** Positional args уже введённые для текущей команды (без опций и без самой subcommand-цепочки). */
  args: string[];
  /** Слово, которое пользователь сейчас набирает (может быть ''). */
  cursor: string;
}

export type CompletionProvider = (
  ctx: ProviderContext,
) => string[] | Promise<string[]>;

const PROVIDER_KEY = Symbol.for('mpu.completionProvider');

type WithProvider = Record<typeof PROVIDER_KEY, CompletionProvider | undefined>;

export function setProvider(cmd: Command, provider: CompletionProvider): Command {
  (cmd as unknown as WithProvider)[PROVIDER_KEY] = provider;
  return cmd;
}

function getProvider(cmd: Command): CompletionProvider | undefined {
  return (cmd as unknown as WithProvider)[PROVIDER_KEY];
}

function isHidden(cmd: Command): boolean {
  return (cmd as unknown as { _hidden?: boolean })._hidden === true;
}

/**
 * Возвращает список кандидатов автодополнения для текущей позиции курсора.
 * `args` — всё, что идёт ПОСЛЕ имени `mpu`, включая слово под курсором как последнее.
 */
export async function complete(root: Command, args: string[]): Promise<string[]> {
  const tokens = args.length === 0 ? [''] : args;
  const cursor = tokens[tokens.length - 1] ?? '';
  const prior = tokens.slice(0, -1);

  // Спускаемся по дереву subcommand, потребляя совпадающие non-flag токены.
  let current = root;
  let consumed = 0;
  for (let i = 0; i < prior.length; i++) {
    const tok = prior[i]!;
    if (tok.startsWith('-')) continue;
    const sub = current.commands.find(
      (c) => !isHidden(c) && (c.name() === tok || c.aliases().includes(tok)),
    );
    if (!sub) break;
    current = sub;
    consumed = i + 1;
  }

  // Позиционные аргументы уже введённые для текущей команды.
  const positional = prior.slice(consumed).filter((t) => !t.startsWith('-'));

  // Курсор начинается с '-' → опции текущей команды + --help/-h.
  if (cursor.startsWith('-')) {
    const flags = new Set<string>(['--help', '-h']);
    for (const o of current.options) {
      if (o.long) flags.add(o.long);
      if (o.short) flags.add(o.short);
    }
    return [...flags].filter((f) => f.startsWith(cursor)).sort();
  }

  const candidates: string[] = [];

  // Subcommand-кандидаты только если ещё не введён ни один позиционный arg.
  if (positional.length === 0) {
    for (const c of current.commands) {
      if (isHidden(c)) continue;
      candidates.push(c.name());
    }
  }

  // Кастомный provider текущей команды.
  const provider = getProvider(current);
  if (provider) {
    const vals = await provider({ args: positional, cursor });
    candidates.push(...vals);
  }

  return Array.from(new Set(candidates))
    .filter((c) => c.startsWith(cursor))
    .sort();
}

/**
 * Shell-скрипты делегируют в `new-mpu __complete <shell> -- <words...>` и
 * фильтруют кандидатов на стороне shell'а. Сам скрипт — минимальный.
 */
const SCRIPTS: Record<Shell, string> = {
  bash: `# mpu bash completion
_new_mpu() {
  local IFS=$'\\n'
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  local candidates
  candidates="$(new-mpu __complete bash -- "\${COMP_WORDS[@]:1}" 2>/dev/null)"
  COMPREPLY=( $(compgen -W "$candidates" -- "$cur") )
}
complete -F _new_mpu new-mpu
`,
  fish: `# new-mpu.fish completion
function __new_mpu_complete
  set -l tokens (commandline -opc) (commandline -ct)
  set -e tokens[1]
  new-mpu __complete fish -- $tokens 2>/dev/null
end
complete -c new-mpu -f -a '(__new_mpu_complete)'
`,
  zsh: `#compdef new-mpu
_new_mpu() {
  local -a candidates
  candidates=(\${(f)"$(new-mpu __complete zsh -- "\${words[@]:1}" 2>/dev/null)"})
  compadd -a candidates
}
compdef _new_mpu new-mpu
`,
};

export function emit(shell: Shell): string {
  const s = SCRIPTS[shell];
  if (!s) throw new Error(`unsupported shell: ${shell}`);
  return s;
}

export function installPath(shell: Shell): string {
  const home = homedir();
  switch (shell) {
    case 'bash':
      return join(
        process.env['XDG_DATA_HOME'] ?? join(home, '.local/share'),
        'bash-completion/completions/new-mpu',
      );
    case 'fish':
      return join(
        process.env['XDG_CONFIG_HOME'] ?? join(home, '.config'),
        'fish/completions/new-mpu.fish',
      );
    case 'zsh':
      return join(home, '.zfunc/_new-mpu');
  }
}

export function install(shell: Shell): string {
  const path = installPath(shell);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, emit(shell), { mode: 0o644 });
  return path;
}

export function detectShell(): Shell | null {
  const s = process.env['SHELL'] ?? '';
  if (s.endsWith('/fish')) return 'fish';
  if (s.endsWith('/zsh')) return 'zsh';
  if (s.endsWith('/bash')) return 'bash';
  return null;
}

export function assertShell(s: string): Shell {
  if ((SHELLS as readonly string[]).includes(s)) return s as Shell;
  throw new Error(`unsupported shell: "${s}". Supported: ${SHELLS.join(', ')}`);
}
