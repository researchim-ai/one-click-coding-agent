/**
 * Slash-command catalogue.
 *
 * Each command is one of:
 *   - `prompt` — the user's chat input is *replaced* with `template` before
 *     being sent to the agent. `${arg}` inside the template is filled with
 *     whatever the user typed after the slash command (may be empty).
 *   - `action` — purely client-side action (e.g. clear chat). No message
 *     is sent; the UI handles it directly.
 *
 * Everything is defined in one catalogue so we can:
 *   - show consistent names/descriptions in both chat popover and future
 *     command-palette,
 *   - keep labels ready for i18n (ru/en) from day one.
 */

export type SlashCommandKind = 'prompt' | 'action'

export interface SlashCommand {
  /** Typed name, without the leading slash. */
  name: string
  /** Extra aliases (also without slash), so `/tests` hits `/test`. */
  aliases?: string[]
  kind: SlashCommandKind
  /** Short description shown in the popover. Keys are language codes. */
  description: { ru: string; en: string }
  /** For kind='prompt': the template to send. `${arg}` is replaced with the
   *  text the user typed after the command (trimmed; may be empty). */
  template?: { ru: string; en: string }
  /** For kind='action': a stable identifier your UI branches on. */
  actionId?:
    | 'clear-chat'
    | 'new-session'
    | 'show-context'
    | 'mode-chat'
    | 'mode-plan'
    | 'mode-agent'
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: 'explain',
    kind: 'prompt',
    description: {
      ru: 'Подробно объяснить код / выделенный фрагмент',
      en: 'Explain the code / selection in detail',
    },
    template: {
      ru: 'Объясни подробно, что делает этот код, и какие у него сильные/слабые стороны.${arg}',
      en: 'Explain in detail what this code does, and what its strong/weak points are.${arg}',
    },
  },
  {
    name: 'fix',
    aliases: ['bug'],
    kind: 'prompt',
    description: {
      ru: 'Найти и исправить баги',
      en: 'Find and fix bugs',
    },
    template: {
      ru: 'Найди баги в текущем коде и исправь их. После каждого fix-а объясни кратко причину.${arg}',
      en: 'Find bugs in the current code and fix them. After each fix, briefly explain the root cause.${arg}',
    },
  },
  {
    name: 'refactor',
    kind: 'prompt',
    description: {
      ru: 'Улучшить структуру кода, не меняя поведения',
      en: 'Improve code structure without changing behaviour',
    },
    template: {
      ru: 'Отрефактори код: убрать дублирование, улучшить именование, разбить большие функции. Поведение должно остаться идентичным.${arg}',
      en: 'Refactor the code: remove duplication, improve naming, split large functions. Behaviour must stay identical.${arg}',
    },
  },
  {
    name: 'test',
    aliases: ['tests'],
    kind: 'prompt',
    description: {
      ru: 'Написать тесты',
      en: 'Write tests',
    },
    template: {
      ru: 'Напиши тесты для текущего кода. Покрой happy-path, граничные случаи и типичные ошибки. Используй фреймворк, принятый в проекте.${arg}',
      en: 'Write tests for the current code. Cover the happy path, edge cases, and typical failure modes. Use the project\'s chosen test framework.${arg}',
    },
  },
  {
    name: 'review',
    kind: 'prompt',
    description: {
      ru: 'Code review: баги, читаемость, безопасность',
      en: 'Code review: bugs, readability, security',
    },
    template: {
      ru: 'Сделай полный код-ревью: баги, читаемость, производительность, безопасность. Приведи конкретные предложения, не абстрактные советы.${arg}',
      en: 'Do a full code review: bugs, readability, performance, security. Give concrete suggestions, not abstract advice.${arg}',
    },
  },
  {
    name: 'commit',
    kind: 'prompt',
    description: {
      ru: 'Собрать коммит из текущих изменений',
      en: 'Craft a commit from the current changes',
    },
    template: {
      ru: 'Посмотри `git status` и `git diff`, затем предложи сообщение коммита в формате Conventional Commits. Обсуди только что стоит закоммитить и что стоит оставить отдельно. Не выполняй commit без явного подтверждения.${arg}',
      en: 'Inspect `git status` and `git diff`, then propose a Conventional Commits-style message. Discuss which hunks should go together vs. be split. Do NOT commit without explicit confirmation.${arg}',
    },
  },
  {
    name: 'docs',
    aliases: ['doc', 'document'],
    kind: 'prompt',
    description: {
      ru: 'Написать документацию / docstrings',
      en: 'Write documentation / docstrings',
    },
    template: {
      ru: 'Напиши понятную документацию: docstrings для публичных функций, README-раздел с примерами использования, если нужно.${arg}',
      en: 'Write clear documentation: docstrings for public functions, a README section with usage examples where warranted.${arg}',
    },
  },
  // Mode switchers. These are the canonical way (alongside the chip
  // switcher under the composer) to flip the current session between
  // chat / plan / agent modes. Placed high in the catalogue because
  // they're among the most useful commands and they used to collide
  // with the old `/plan` prompt.
  {
    name: 'chat',
    kind: 'action',
    actionId: 'mode-chat',
    description: {
      ru: 'Переключиться в режим Chat (без инструментов)',
      en: 'Switch to Chat mode (no tools)',
    },
  },
  {
    name: 'plan',
    kind: 'action',
    actionId: 'mode-plan',
    description: {
      ru: 'Переключиться в режим Plan (только чтение, планирование)',
      en: 'Switch to Plan mode (read-only, planning)',
    },
  },
  {
    name: 'agent',
    kind: 'action',
    actionId: 'mode-agent',
    description: {
      ru: 'Переключиться в режим Agent (все инструменты)',
      en: 'Switch to Agent mode (full tools)',
    },
  },
  {
    name: 'clear',
    aliases: ['reset'],
    kind: 'action',
    actionId: 'clear-chat',
    description: {
      ru: 'Очистить текущий чат',
      en: 'Clear the current chat',
    },
  },
  {
    name: 'new',
    kind: 'action',
    actionId: 'new-session',
    description: {
      ru: 'Начать новую сессию',
      en: 'Start a new session',
    },
  },
  {
    name: 'context',
    aliases: ['ctx'],
    kind: 'action',
    actionId: 'show-context',
    description: {
      ru: 'Показать распределение контекста (что сколько занимает)',
      en: 'Show context breakdown (what\'s using your budget)',
    },
  },
]

export function findSlashCommand(name: string): SlashCommand | null {
  const lower = name.toLowerCase()
  return (
    SLASH_COMMANDS.find(
      (c) => c.name === lower || c.aliases?.includes(lower),
    ) ?? null
  )
}

/** Parse a chat input like "/fix the off-by-one bug" into
 *  { name: 'fix', arg: 'the off-by-one bug' }, or null if not a slash cmd. */
export function parseSlashInput(input: string): { name: string; arg: string } | null {
  const m = input.match(/^\s*\/([A-Za-z][\w-]*)\s*(.*)$/s)
  if (!m) return null
  return { name: m[1], arg: m[2] }
}

/** Fuzzy-filter the catalogue by a typed prefix (without leading slash). */
export function filterSlashCommands(prefix: string): SlashCommand[] {
  const p = prefix.toLowerCase()
  if (!p) return SLASH_COMMANDS
  return SLASH_COMMANDS.filter((c) => {
    if (c.name.startsWith(p)) return true
    if (c.aliases?.some((a) => a.startsWith(p))) return true
    return false
  })
}

/** Substitute `${arg}` in a prompt template. */
export function expandSlashTemplate(cmd: SlashCommand, arg: string, lang: 'ru' | 'en'): string {
  if (!cmd.template) return arg
  const tmpl = cmd.template[lang] ?? cmd.template.en
  const trimmed = arg.trim()
  return tmpl.replace('${arg}', trimmed ? `\n\n${trimmed}` : '')
}
