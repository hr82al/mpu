import type { Command } from 'commander';

export interface Example {
  /** Полная командная строка пользователя, e.g. `mpu config cache.ttl 300`. */
  cmd: string;
  /** Короткий комментарий справа через `#`. */
  note?: string;
}

export interface HelpSpec {
  /** Одна строка для показа в списке subcommand у родителя. */
  summary: string;
  /** Полное описание для `--help` самой команды. Если опущено — используется summary. */
  description?: string;
  /** Примеры, рендерятся блоком `Examples:` после Options. */
  examples?: Example[];
}

export function describe(cmd: Command, spec: HelpSpec): Command {
  cmd.summary(spec.summary);
  cmd.description(spec.description ?? spec.summary);
  if (spec.examples && spec.examples.length > 0) {
    cmd.addHelpText('after', '\n' + formatExamples(spec.examples));
  }
  return cmd;
}

function formatExamples(examples: Example[]): string {
  const width = Math.max(...examples.map((e) => e.cmd.length));
  const lines = examples.map((e) => {
    if (!e.note) return `  ${e.cmd}`;
    const pad = ' '.repeat(width - e.cmd.length);
    return `  ${e.cmd}${pad}  # ${e.note}`;
  });
  return 'Examples:\n' + lines.join('\n');
}
