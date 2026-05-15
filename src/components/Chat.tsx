import { useRef, useEffect, useState, useCallback, type KeyboardEvent } from 'react'
import { MessageBubble } from './MessageBubble'
import { TaskStatePanel } from './TaskStatePanel'
import type { ChatMessage } from '../hooks/useAgent'
import {
  SLASH_COMMANDS,
  filterSlashCommands,
  findSlashCommand,
  parseSlashInput,
  expandSlashTemplate,
  type SlashCommand,
} from '../slashCommands'

interface AttachedFile {
  path: string
  name: string
}

export interface CodeReference {
  filePath: string
  relativePath: string
  startLine: number
  endLine: number
  content: string
  language: string
}

interface ContextUsage {
  usedTokens: number
  budgetTokens: number
  maxContextTokens: number
  percent: number
}

interface Props {
  messages: ChatMessage[]
  busy: boolean
  workspace: string
  onSend: (text: string) => void
  onCancel?: () => void
  onApproval?: (id: string, approved: boolean) => void
  codeRefs?: CodeReference[]
  onRemoveCodeRef?: (index: number) => void
  contextUsage?: ContextUsage | null
  appLanguage?: 'ru' | 'en'
  onRestoreCheckpoint?: (sha: string, mode: 'files' | 'files+task') => void | Promise<void>
  /** Handler for slash-command actions like /clear, /new, /chat, /plan,
   *  /agent. Prompt-style slash commands are expanded in place and flow
   *  through onSend. */
  onSlashAction?: (
    actionId:
      | 'clear-chat'
      | 'new-session'
      | 'show-context'
      | 'mode-chat'
      | 'mode-plan'
      | 'mode-agent',
    arg: string,
  ) => void
  /** Live task-state snapshot from the most recent `task_state` agent
   *  event. When present, the task panel renders this immediately
   *  (no IPC roundtrip), so the plan updates mid-turn as the agent
   *  calls `update_plan`. Falls back to IPC fetch when undefined. */
  liveTaskState?: unknown
  /** Current operating mode of the active session (chat/plan/agent).
   *  Rendered as a chip strip under the textarea. */
  mode?: 'chat' | 'plan' | 'agent'
  /** Change the active session's mode. No-op while busy (useAgent
   *  guards that too). */
  onModeChange?: (mode: 'chat' | 'plan' | 'agent') => void
  /** "Apply plan" button handler in TaskStatePanel. Typically switches
   *  the session to agent mode and sends an execution prompt. */
  onApplyPlan?: () => void
  onSelectPlanOption?: (optionId: string) => void | Promise<void>
  /** Persist current plan as PLAN.md. */
  onSavePlan?: () => void
  /** Open a workspace file from agent activity cards. */
  onOpenFile?: (path: string) => void | Promise<void>
}

interface ContextBreakdown {
  usedTokens: number
  budgetTokens: number
  maxContextTokens: number
  percent: number
  categories: { key: string; label: string; tokens: number; messages: number }[]
  cache: { hits: number; misses: number; size: number }
}

interface CodeIndexStatus {
  indexed: boolean
  stale: boolean
  updatedAt: number | null
  files: number
  symbols: number
  truncated: boolean
}

export function Chat({
  messages,
  busy,
  workspace,
  onSend,
  onCancel,
  onApproval,
  codeRefs = [],
  onRemoveCodeRef,
  contextUsage,
  appLanguage = 'ru',
  onRestoreCheckpoint,
  onSlashAction,
  liveTaskState,
  mode = 'agent',
  onModeChange,
  onApplyPlan,
  onSelectPlanOption,
  onSavePlan,
  onOpenFile,
}: Props) {
  const L = appLanguage
  const t = (ru: string, en: string) => (L === 'ru' ? ru : en)
  const [input, setInput] = useState('')
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([])
  const [showMention, setShowMention] = useState(false)
  const [mentionQuery, setMentionQuery] = useState('')
  const [mentionFiles, setMentionFiles] = useState<{ path: string; name: string }[]>([])
  const [mentionIndex, setMentionIndex] = useState(0)
  const [expandedRef, setExpandedRef] = useState<number | null>(null)
  const [showSlash, setShowSlash] = useState(false)
  const [slashResults, setSlashResults] = useState<SlashCommand[]>(SLASH_COMMANDS)
  const [slashIndex, setSlashIndex] = useState(0)
  const [rulesInfo, setRulesInfo] = useState<{ files: { relativePath: string; bytes: number }[]; truncated: boolean; totalBytes: number } | null>(null)
  const [codeIndexStatus, setCodeIndexStatus] = useState<CodeIndexStatus | null>(null)
  const [contextModal, setContextModal] = useState<ContextBreakdown | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const lastScrollLenRef = useRef(0)
  const lastScrollIdRef = useRef<string | null>(null)

  useEffect(() => {
    const len = messages.length
    const lastId = len > 0 ? messages[len - 1].id : null
    const shouldScroll = len !== lastScrollLenRef.current || lastId !== lastScrollIdRef.current
    lastScrollLenRef.current = len
    lastScrollIdRef.current = lastId
    if (shouldScroll) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages])

  // Load AGENTS.md / CLAUDE.md / .cursorrules info for the current workspace.
  // Re-runs when the user picks a different project or when they reset chat
  // (the agent re-reads the files then too).
  useEffect(() => {
    if (!workspace || !window.api?.getProjectRulesInfo) {
      setRulesInfo(null)
      return
    }
    let cancelled = false
    window.api.getProjectRulesInfo(workspace).then((info) => {
      if (!cancelled) setRulesInfo(info && info.files.length ? info : null)
    }).catch(() => {
      if (!cancelled) setRulesInfo(null)
    })
    return () => { cancelled = true }
  }, [workspace])

  const refreshCodeIndexStatus = useCallback(() => {
    if (!workspace || !window.api?.getCodeIndexStatus) {
      setCodeIndexStatus(null)
      return
    }
    window.api.getCodeIndexStatus(workspace)
      .then((status) => setCodeIndexStatus(status))
      .catch(() => setCodeIndexStatus(null))
  }, [workspace])

  useEffect(() => {
    refreshCodeIndexStatus()
  }, [refreshCodeIndexStatus])

  useEffect(() => {
    if (!workspace || !window.api?.onWorkspaceFilesChanged) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = window.api.onWorkspaceFilesChanged(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(refreshCodeIndexStatus, 500)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [workspace, refreshCodeIndexStatus])

  const rebuildCodeIndex = useCallback(async () => {
    if (!workspace || !window.api?.rebuildCodeIndex) return
    const status = await window.api.rebuildCodeIndex(workspace).catch(() => null)
    if (status) setCodeIndexStatus(status)
  }, [workspace])

  const handleSend = useCallback(async () => {
    if (!input.trim() && attachedFiles.length === 0 && codeRefs.length === 0) return
    if (busy) return

    // ---- Slash-command expansion -----------------------------------------
    // Intercept BEFORE composing the full message. For "action" commands
    // (/clear, /new) we never send anything to the LLM; we just call the
    // parent handler and clear the input. For "prompt" commands we swap
    // the raw input with the expanded template — attachments still apply.
    const parsed = parseSlashInput(input)
    if (parsed) {
      const cmd = findSlashCommand(parsed.name)
      if (cmd) {
        if (cmd.kind === 'action' && cmd.actionId) {
          if (cmd.actionId === 'show-context') {
            if (window.api?.getContextBreakdown && workspace) {
              try {
                const b = await window.api.getContextBreakdown(workspace)
                if (b) setContextModal(b)
              } catch {}
            }
          } else {
            onSlashAction?.(cmd.actionId, parsed.arg)
          }
          setInput('')
          setShowSlash(false)
          if (textareaRef.current) textareaRef.current.style.height = 'auto'
          return
        }
        if (cmd.kind === 'prompt') {
          // Compose attachments THEN expanded template — keeps existing
          // UX where pinned files/code-refs still anchor context.
          const expanded = expandSlashTemplate(cmd, parsed.arg, appLanguage ?? 'ru')
          let fullMessage = ''
          if (codeRefs.length > 0) {
            fullMessage += codeRefs.map((ref) =>
              `[${ref.relativePath}:${ref.startLine}-${ref.endLine}]\n\`\`\`${ref.language}\n${ref.content}\n\`\`\``,
            ).join('\n\n') + '\n\n'
          }
          if (attachedFiles.length > 0) {
            const parts: string[] = []
            for (const f of attachedFiles) {
              try {
                const { content } = await window.api.readFileContent(f.path)
                const lines = content.split('\n').length
                parts.push(`[File: ${f.name}] (${lines} lines)\n\`\`\`\n${content}\n\`\`\``)
              } catch {
                parts.push(`[File: ${f.name}] (failed to read)`)
              }
            }
            fullMessage += parts.join('\n\n') + '\n\n'
          }
          fullMessage += expanded
          onSend(fullMessage)
          setInput('')
          setAttachedFiles([])
          setExpandedRef(null)
          if (onRemoveCodeRef) {
            for (let i = codeRefs.length - 1; i >= 0; i--) onRemoveCodeRef(i)
          }
          setShowSlash(false)
          if (textareaRef.current) textareaRef.current.style.height = 'auto'
          return
        }
      }
    }

    let fullMessage = ''

    // Code references first (more specific context)
    if (codeRefs.length > 0) {
      const parts: string[] = []
      for (const ref of codeRefs) {
        parts.push(
          `[${ref.relativePath}:${ref.startLine}-${ref.endLine}]\n\`\`\`${ref.language}\n${ref.content}\n\`\`\``
        )
      }
      fullMessage = parts.join('\n\n') + '\n\n'
    }

    // Then full files
    if (attachedFiles.length > 0) {
      const parts: string[] = []
      for (const f of attachedFiles) {
        try {
          const { content } = await window.api.readFileContent(f.path)
          const lines = content.split('\n').length
          parts.push(`[File: ${f.name}] (${lines} lines)\n\`\`\`\n${content}\n\`\`\``)
        } catch {
          parts.push(`[File: ${f.name}] (failed to read)`)
        }
      }
      fullMessage += parts.join('\n\n') + '\n\n'
    }

    fullMessage += input.trim()

    onSend(fullMessage)
    setInput('')
    setAttachedFiles([])
    setExpandedRef(null)
    // Clear code refs via parent
    if (onRemoveCodeRef) {
      for (let i = codeRefs.length - 1; i >= 0; i--) onRemoveCodeRef(i)
    }
    setShowMention(false)
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }, [input, attachedFiles, codeRefs, busy, onSend, onRemoveCodeRef, onSlashAction, appLanguage])

  const collectFiles = useCallback(async (query: string) => {
    if (!workspace || !window.api) return
    try {
      const tree = await window.api.listFiles(workspace)
      const results: { path: string; name: string }[] = []
      const q = query.toLowerCase()

      const walk = (entries: typeof tree, prefix: string) => {
        for (const e of entries) {
          const rel = prefix ? `${prefix}/${e.name}` : e.name
          if (!e.isDir && rel.toLowerCase().includes(q)) {
            results.push({ path: e.path, name: rel })
            if (results.length >= 12) return
          }
          if (e.isDir && e.children) walk(e.children, rel)
          if (results.length >= 12) return
        }
      }
      walk(tree, '')
      setMentionFiles(results)
      setMentionIndex(0)
    } catch {
      setMentionFiles([])
    }
  }, [workspace])

  const handleInput = (val: string) => {
    setInput(val)
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + 'px'
    }

    const cursor = textareaRef.current?.selectionStart ?? val.length
    const before = val.slice(0, cursor)
    const atMatch = before.match(/@([^\s@]*)$/)

    if (atMatch) {
      setShowMention(true)
      setMentionQuery(atMatch[1])
      collectFiles(atMatch[1])
      setShowSlash(false)
      return
    }
    setShowMention(false)

    // Slash-command popover: only surface while the user is still typing the
    // command name (first token). Once they add a space, they're typing
    // arguments — hide the picker to keep out of the way.
    const slashMatch = val.match(/^\s*\/([A-Za-z][\w-]*)$/)
    if (slashMatch) {
      const results = filterSlashCommands(slashMatch[1])
      setSlashResults(results)
      setSlashIndex(0)
      setShowSlash(results.length > 0)
    } else if (val.startsWith('/') && !val.includes(' ') && !val.includes('\n')) {
      // Just `/` — show full list.
      setSlashResults(SLASH_COMMANDS)
      setSlashIndex(0)
      setShowSlash(true)
    } else {
      setShowSlash(false)
    }
  }

  const insertSlashCommand = (cmd: SlashCommand) => {
    // Insert the command name followed by a space, so the user can start
    // typing additional context (it becomes `${arg}` in the template).
    // For pure actions (/clear) we leave no trailing space — pressing Enter
    // immediately runs the action.
    const next = cmd.kind === 'action' ? `/${cmd.name}` : `/${cmd.name} `
    setInput(next)
    setShowSlash(false)
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      if (ta) {
        ta.focus()
        const len = ta.value.length
        ta.setSelectionRange(len, len)
      }
    })
  }

  const insertFile = (file: { path: string; name: string }) => {
    if (attachedFiles.some((f) => f.path === file.path)) {
      setShowMention(false)
      return
    }
    setAttachedFiles((prev) => [...prev, { path: file.path, name: file.name }])

    const cursor = textareaRef.current?.selectionStart ?? input.length
    const before = input.slice(0, cursor)
    const after = input.slice(cursor)
    const cleaned = before.replace(/@[^\s@]*$/, '') + after
    setInput(cleaned)
    setShowMention(false)
    textareaRef.current?.focus()
  }

  const removeFile = (path: string) => {
    setAttachedFiles((prev) => prev.filter((f) => f.path !== path))
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (showMention && mentionFiles.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionIndex((i) => Math.min(i + 1, mentionFiles.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionIndex((i) => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        insertFile(mentionFiles[mentionIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setShowMention(false)
        return
      }
    }

    if (showSlash && slashResults.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashIndex((i) => Math.min(i + 1, slashResults.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashIndex((i) => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        insertSlashCommand(slashResults[slashIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setShowSlash(false)
        return
      }
      // Enter: if user already typed a full matching command name, fall
      // through to send. Otherwise accept the highlighted suggestion.
      if (e.key === 'Enter' && !e.shiftKey) {
        const parsed = parseSlashInput(input)
        const exact = parsed ? findSlashCommand(parsed.name) : null
        if (!exact) {
          e.preventDefault()
          insertSlashCommand(slashResults[slashIndex])
          return
        }
        // Fall through to normal send.
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const noWorkspace = !workspace
  const hasAttachments = attachedFiles.length > 0 || codeRefs.length > 0

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <TaskStatePanel
        workspace={workspace}
        refreshKey={messages.length}
        appLanguage={appLanguage}
        liveState={liveTaskState}
        mode={mode}
        onApplyPlan={onApplyPlan}
        onSelectPlanOption={onSelectPlanOption}
        onSavePlan={onSavePlan}
        busy={busy}
      />
      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-5 py-5 min-h-0">
        <div className="flex flex-col gap-5">
          {messages.length === 0 && (
            <div className="text-center py-20 text-zinc-500">
              <div className="text-5xl mb-4">⚡</div>
              <h2 className="text-2xl font-bold text-zinc-200 mb-2">Coding Agent</h2>
              <p className="text-base max-w-md mx-auto leading-relaxed mb-6">
                {L === 'ru' ? (
                  <>Автономный AI-агент для разработки.<br />Читает, пишет и редактирует код, запускает команды.</>
                ) : (
                  <>Autonomous AI coding agent.<br />Reads, writes, and edits code, runs commands.</>
                )}
              </p>
              {noWorkspace ? (
                <div className="inline-flex items-center gap-2 px-4 py-2 bg-amber-500/10 border border-amber-500/30 rounded-lg text-sm text-amber-400">
                  <span>📁</span> {t('Выбери рабочую директорию в боковой панели', 'Pick a working directory in the sidebar')}
                </div>
              ) : (
                <div className="space-y-2 text-sm text-zinc-500">
                  <p>{t('Примеры задач:', 'Example tasks:')}</p>
                  <div className="flex flex-wrap justify-center gap-2">
                    {(L === 'ru' ? [
                      'Изучи проект и опиши архитектуру',
                      'Найди и исправь баг в…',
                      'Добавь юнит-тесты',
                      'Отрефактори компонент…',
                    ] : [
                      'Explore the project and describe the architecture',
                      'Find and fix a bug in…',
                      'Add unit tests',
                      'Refactor the component…',
                    ]).map((ex) => (
                      <button
                        key={ex}
                        onClick={() => { setInput(ex); textareaRef.current?.focus() }}
                        className="px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg hover:border-blue-500 hover:text-blue-300 transition-colors cursor-pointer"
                      >
                        {ex}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          {messages.map((msg) => {
            const isDone = msg.role === 'status' || msg.done === true || msg.role === 'user'
            return (
              <div key={msg.id} className={isDone ? 'msg-auto-contain' : undefined}>
                <MessageBubble
                  message={msg}
                  onApprove={onApproval ? (id) => onApproval(id, true) : undefined}
                  onDeny={onApproval ? (id) => onApproval(id, false) : undefined}
                  appLanguage={L}
                  onRestoreCheckpoint={onRestoreCheckpoint}
                  workspace={workspace}
                  onOpenFile={onOpenFile}
                />
              </div>
            )
          })}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Context usage bar + project-rules pill. Lives right above the
          composer, so the user sees both pieces of "who's at the wheel"
          state without ever having to open settings. */}
      {(contextUsage || rulesInfo || codeIndexStatus) && (
        <div className="border-t border-zinc-800/40 bg-[#0d1117] px-3 py-1 flex items-center gap-2">
          {contextUsage && (
            <>
              <span className="text-[10px] text-zinc-400 shrink-0">{t('Контекст', 'Context')}</span>
              <div
                className="flex-1 h-1.5 bg-zinc-700/80 rounded-full overflow-hidden cursor-help"
                title={
                  t(
                    `Использовано ${contextUsage.usedTokens.toLocaleString('ru')} из ${contextUsage.maxContextTokens.toLocaleString('ru')} токенов (${contextUsage.percent}%).`
                    + (contextUsage.percent > 85
                      ? '\n⚠ Скоро лимит — подумай о /clear или /new.'
                      : contextUsage.percent > 60
                        ? '\nАгент начнёт автосжимать контекст после ~70%.'
                        : ''),
                    `Used ${contextUsage.usedTokens.toLocaleString('en')} of ${contextUsage.maxContextTokens.toLocaleString('en')} tokens (${contextUsage.percent}%).`
                    + (contextUsage.percent > 85
                      ? '\n⚠ Near the limit — consider /clear or /new.'
                      : contextUsage.percent > 60
                        ? '\nAgent auto-compacts context past ~70%.'
                        : ''),
                  )
                }
              >
                <div
                  className={`h-full rounded-full transition-all duration-500 ${
                    contextUsage.percent > 85 ? 'bg-red-500' :
                    contextUsage.percent > 60 ? 'bg-amber-500' :
                    'bg-emerald-500'
                  }`}
                  style={{ width: `${Math.min(contextUsage.percent, 100)}%` }}
                />
              </div>
              <span className={`text-[10px] font-mono tabular-nums shrink-0 ${
                contextUsage.percent > 85 ? 'text-red-400' :
                contextUsage.percent > 60 ? 'text-amber-400' :
                'text-zinc-300'
              }`}>
                {contextUsage.percent}%
              </span>
              <span className="text-[9px] text-zinc-400 font-mono tabular-nums shrink-0">
                {Math.round(contextUsage.usedTokens / 1024)}K / {Math.round(contextUsage.maxContextTokens / 1024)}K
              </span>
              {contextUsage.percent > 85 && onSlashAction && (
                <button
                  onClick={() => onSlashAction('clear-chat', '')}
                  className="text-[10px] px-1.5 py-[1px] rounded border border-red-500/30 text-red-300 hover:bg-red-500/10 cursor-pointer shrink-0"
                  title={t('Очистить чат (/clear)', 'Clear chat (/clear)')}
                >
                  {t('очистить', 'clear')}
                </button>
              )}
            </>
          )}
          {rulesInfo && rulesInfo.files.length > 0 && (
            <span
              className="ml-auto inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-emerald-500/25 bg-emerald-500/5 text-[10px] text-emerald-300/90 cursor-help shrink-0"
              title={
                t('Загруженные правила проекта', 'Loaded project rules')
                + ':\n' + rulesInfo.files.map((f) => `• ${f.relativePath} (${(f.bytes / 1024).toFixed(1)} KB)`).join('\n')
                + (rulesInfo.truncated ? '\n\n' + t('⚠ Обрезано по лимиту 16KB', '⚠ Truncated at 16KB limit') : '')
              }
            >
              <span>📋</span>
              <span className="font-mono">
                {rulesInfo.files.length === 1
                  ? rulesInfo.files[0].relativePath
                  : `${rulesInfo.files.length} ${t('правил', 'rules')}`}
              </span>
            </span>
          )}
          {codeIndexStatus && (
            <button
              type="button"
              onClick={rebuildCodeIndex}
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] shrink-0 ${
                codeIndexStatus.stale
                  ? 'border-amber-500/25 bg-amber-500/5 text-amber-300/90 hover:bg-amber-500/10'
                  : 'border-blue-500/25 bg-blue-500/5 text-blue-300/90 hover:bg-blue-500/10'
              } ${!rulesInfo && !contextUsage ? 'ml-auto' : ''}`}
              title={t(
                `Code index: ${codeIndexStatus.files} файлов, ${codeIndexStatus.symbols} символов.${codeIndexStatus.stale ? '\nИндекс устарел — нажми, чтобы пересобрать.' : '\nНажми, чтобы пересобрать.'}`,
                `Code index: ${codeIndexStatus.files} files, ${codeIndexStatus.symbols} symbols.${codeIndexStatus.stale ? '\nIndex is stale — click to rebuild.' : '\nClick to rebuild.'}`,
              )}
            >
              <span>{codeIndexStatus.stale ? '◌' : '◇'}</span>
              <span className="font-mono">
                {codeIndexStatus.indexed
                  ? `${t('индекс', 'index')} ${codeIndexStatus.files}/${codeIndexStatus.symbols}`
                  : t('индекс: нет', 'index: none')}
              </span>
            </button>
          )}
        </div>
      )}

      {/* Agent working indicator */}
      {busy && (
        <div className="flex items-center gap-2 px-4 py-1.5 border-t border-zinc-800/40 bg-[#0d1117]">
          <span className="flex gap-1">
            <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-[pulse-dot_1.4s_0s_infinite]" />
            <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-[pulse-dot_1.4s_0.2s_infinite]" />
            <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-[pulse-dot_1.4s_0.4s_infinite]" />
          </span>
          <span className="text-[11px] text-zinc-500">{t('Агент работает…', 'Agent is working…')}</span>
          {onCancel && (
            <button
              onClick={onCancel}
              className="ml-auto px-2.5 py-0.5 rounded-full border border-zinc-700 text-[11px] text-zinc-400 hover:text-red-400 hover:border-red-500/40 hover:bg-red-500/10 cursor-pointer transition-colors"
            >
              {t('⏹ Остановить', '⏹ Stop')}
            </button>
          )}
        </div>
      )}

      {/* Input area */}
      <div className="border-t border-zinc-800/60 bg-[#0d1117]">
        {/* Attached code references */}
        {codeRefs.length > 0 && (
          <div className="flex flex-col gap-1.5 px-3 pt-2.5 pb-1">
            {codeRefs.map((ref, i) => (
              <div key={`${ref.filePath}:${ref.startLine}:${ref.endLine}`} className="group">
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => setExpandedRef(expandedRef === i ? null : i)}
                    className="flex-1 min-w-0 inline-flex items-center gap-1.5 px-2.5 py-1 bg-purple-500/8 border border-purple-500/25 rounded text-[11px] font-mono text-left hover:bg-purple-500/12 transition-colors cursor-pointer"
                  >
                    <span className="text-purple-400 text-[10px]">{'<>'}</span>
                    <span className="text-purple-300 truncate">{ref.relativePath}</span>
                    <span className="text-purple-400/50">:</span>
                    <span className="text-purple-200/80">{ref.startLine === ref.endLine ? `L${ref.startLine}` : `L${ref.startLine}–${ref.endLine}`}</span>
                    <span className="text-zinc-600 text-[10px] ml-auto shrink-0">
                      {ref.endLine - ref.startLine + 1} {pluralLines(ref.endLine - ref.startLine + 1, L)}
                    </span>
                    <span className="text-zinc-600 text-[10px]">{expandedRef === i ? '▾' : '▸'}</span>
                  </button>
                  {onRemoveCodeRef && (
                    <button
                      onClick={() => onRemoveCodeRef(i)}
                      className="w-5 h-5 flex items-center justify-center rounded text-zinc-600 hover:text-red-400 hover:bg-red-500/10 cursor-pointer text-[10px] shrink-0 transition-colors"
                    >
                      ✕
                    </button>
                  )}
                </div>
                {expandedRef === i && (
                  <div className="mt-1 ml-0.5 rounded border border-purple-500/15 bg-[#0d1117] overflow-hidden">
                    <pre className="p-2 text-[11px] leading-[16px] font-mono text-zinc-400 overflow-x-auto max-h-[150px] overflow-y-auto">
                      {ref.content.split('\n').map((line, li) => (
                        <div key={li} className="flex">
                          <span className="text-zinc-700 select-none w-8 text-right pr-2 shrink-0">{ref.startLine + li}</span>
                          <span className="text-zinc-300">{line || '\u00A0'}</span>
                        </div>
                      ))}
                    </pre>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Attached files */}
        {attachedFiles.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-2.5 pb-1">
            {attachedFiles.map((f) => (
              <span
                key={f.path}
                className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-500/10 border border-blue-500/30 rounded text-[11px] text-blue-300 font-mono"
              >
                <span className="text-blue-400/60">@</span>
                <span className="max-w-[180px] truncate">{f.name}</span>
                <button
                  onClick={() => removeFile(f.path)}
                  className="ml-0.5 text-blue-400/50 hover:text-blue-300 cursor-pointer text-[10px]"
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Slash + mention dropdowns share one positioning wrapper so only
            one is ever visible at once. */}
        <div className="relative">
          {showSlash && slashResults.length > 0 && (
            <div className="absolute bottom-full left-0 right-0 mx-3 mb-1 bg-zinc-900 border border-zinc-700/60 rounded-lg shadow-xl overflow-hidden z-50 max-h-[280px] overflow-y-auto">
              <div className="px-2.5 py-1.5 text-[10px] text-zinc-500 uppercase tracking-wider border-b border-zinc-800/60 flex items-center justify-between">
                <span>{t('Команды', 'Commands')}</span>
                <span className="text-zinc-600 normal-case tracking-normal text-[10px]">
                  {t('↑↓ · Tab / Enter · Esc', '↑↓ · Tab / Enter · Esc')}
                </span>
              </div>
              {slashResults.map((c, i) => (
                <button
                  key={c.name}
                  onMouseDown={(e) => { e.preventDefault(); insertSlashCommand(c) }}
                  className={`w-full px-2.5 py-1.5 text-left text-[12px] flex items-center gap-2 cursor-pointer ${
                    i === slashIndex
                      ? 'bg-blue-500/15 text-blue-300'
                      : 'text-zinc-300 hover:bg-zinc-800/60'
                  }`}
                >
                  <span className="font-mono text-zinc-500 w-20 shrink-0">/{c.name}</span>
                  <span className="truncate text-zinc-400 text-[11.5px]">
                    {c.description[appLanguage ?? 'ru']}
                  </span>
                  {c.kind === 'action' && (
                    <span className="ml-auto text-[10px] text-amber-400/80 shrink-0">
                      {t('действие', 'action')}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
          {showMention && mentionFiles.length > 0 && (
            <div className="absolute bottom-full left-0 right-0 mx-3 mb-1 bg-zinc-900 border border-zinc-700/60 rounded-lg shadow-xl overflow-hidden z-50 max-h-[240px] overflow-y-auto">
              <div className="px-2.5 py-1.5 text-[10px] text-zinc-500 uppercase tracking-wider border-b border-zinc-800/60">
                {t('Файлы проекта', 'Project files')}
              </div>
              {mentionFiles.map((f, i) => (
                <button
                  key={f.path}
                  onMouseDown={(e) => { e.preventDefault(); insertFile(f) }}
                  className={`w-full px-2.5 py-1.5 text-left text-[12px] font-mono flex items-center gap-2 cursor-pointer ${
                    i === mentionIndex
                      ? 'bg-blue-500/15 text-blue-300'
                      : 'text-zinc-400 hover:bg-zinc-800/60'
                  }`}
                >
                  <span className="text-zinc-600">@</span>
                  <span className="truncate">{f.name}</span>
                </button>
              ))}
            </div>
          )}

          {/* Input row */}
          <div className="flex items-end">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => handleInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={busy || noWorkspace}
              placeholder={noWorkspace
                ? t('Сначала выбери проект ←', 'Pick a project first ←')
                : hasAttachments
                  ? t('Добавь описание задачи…', 'Add a task description…')
                  : mode === 'chat'
                    ? t('Обсуждение (без инструментов)… @ — прикрепить файл', 'Discussion (no tools)… @ — attach file')
                    : mode === 'plan'
                      ? t('Планирование и вопросы перед выполнением… @ — прикрепить файл', 'Planning and questions before execution… @ — attach file')
                      : t('Опиши задачу… @ — прикрепить файл', 'Describe the task… @ — attach file')}
              rows={1}
              className="flex-1 bg-transparent px-3 py-2.5 text-[13px] text-zinc-100 placeholder-zinc-600 resize-none focus:outline-none disabled:opacity-50"
            />
            <button
              onClick={handleSend}
              disabled={busy || (!input.trim() && !hasAttachments) || noWorkspace}
              className="w-8 h-8 flex items-center justify-center text-zinc-500 hover:text-blue-400 disabled:opacity-20 disabled:cursor-not-allowed transition-colors shrink-0 cursor-pointer text-sm mr-1.5 mb-1"
            >
              ➤
            </button>
          </div>

          {/* Mode switcher */}
          <ModeSwitcher
            mode={mode}
            disabled={busy || noWorkspace}
            onChange={(m) => onModeChange?.(m)}
            appLanguage={L}
          />
        </div>
      </div>
      {contextModal && (
        <ContextBreakdownModal
          breakdown={contextModal}
          onClose={() => setContextModal(null)}
          lang={L}
        />
      )}
    </div>
  )
}

function ContextBreakdownModal({
  breakdown,
  onClose,
  lang,
}: {
  breakdown: ContextBreakdown
  onClose: () => void
  lang: 'ru' | 'en'
}) {
  const t = (ru: string, en: string) => (lang === 'ru' ? ru : en)
  const total = breakdown.categories.reduce((a, c) => a + c.tokens, 0) || 1
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-zinc-900 border border-zinc-700/60 rounded-xl shadow-2xl w-[560px] max-w-[92vw] max-h-[80vh] overflow-y-auto"
      >
        <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
          <div className="text-sm font-medium text-zinc-200">
            {t('Распределение контекста', 'Context breakdown')}
          </div>
          <button
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-300 cursor-pointer text-lg leading-none"
          >
            ✕
          </button>
        </div>
        <div className="px-4 py-3 text-[12px] text-zinc-300 space-y-3">
          <div className="flex items-center gap-2">
            <div className="flex-1 h-2 bg-zinc-800 rounded overflow-hidden">
              <div
                className={`h-full ${breakdown.percent > 85 ? 'bg-red-500' : breakdown.percent > 60 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                style={{ width: `${Math.min(100, breakdown.percent)}%` }}
              />
            </div>
            <div className="text-[11px] text-zinc-400 tabular-nums shrink-0">
              {breakdown.usedTokens.toLocaleString()} / {breakdown.budgetTokens.toLocaleString()} ({breakdown.percent}%)
            </div>
          </div>
          <div className="text-[11px] text-zinc-500">
            {t('Максимум', 'Max')}: {breakdown.maxContextTokens.toLocaleString()} {t('токенов', 'tokens')}
          </div>
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-[10px] uppercase text-zinc-500 tracking-wider border-b border-zinc-800">
                <th className="text-left py-1.5 pr-2 font-normal">{t('Категория', 'Category')}</th>
                <th className="text-right py-1.5 px-2 font-normal">{t('Токены', 'Tokens')}</th>
                <th className="text-right py-1.5 px-2 font-normal">%</th>
                <th className="text-right py-1.5 pl-2 font-normal">{t('Сообщ.', 'Msgs')}</th>
              </tr>
            </thead>
            <tbody>
              {breakdown.categories.map((c) => (
                <tr key={c.key} className="border-b border-zinc-800/50">
                  <td className="py-1.5 pr-2 text-zinc-300">{c.label}</td>
                  <td className="py-1.5 px-2 text-right tabular-nums text-zinc-300">{c.tokens.toLocaleString()}</td>
                  <td className="py-1.5 px-2 text-right tabular-nums text-zinc-500">{Math.round((c.tokens / total) * 100)}</td>
                  <td className="py-1.5 pl-2 text-right tabular-nums text-zinc-500">{c.messages}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="text-[11px] text-zinc-500">
            {t('Кэш инструментов', 'Tool cache')}: {breakdown.cache.hits} hits · {breakdown.cache.misses} misses · {breakdown.cache.size} entries
          </div>
          <div className="text-[11px] text-zinc-600 pt-1 border-t border-zinc-800/60">
            {t(
              'Совет: если вы близки к лимиту — /clear или /new сбросят историю; большие tool-результаты ужимаются автоматически.',
              'Tip: if you\'re near the limit, /clear or /new reset history; large tool-results are compacted automatically.',
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Chip-strip mode switcher rendered under the composer textarea. Each
 * chip carries a short label + one-line tooltip (via `title`) so users
 * understand the trade-offs without opening the docs. Parent handles
 * persistence — we just fire `onChange`.
 *
 * Keep this component simple: it is intentionally stateless so the
 * parent's `mode` prop stays the single source of truth (the switcher
 * updates the moment an IPC round-trip returns via `refreshSessions`).
 */
function ModeSwitcher({
  mode,
  disabled,
  onChange,
  appLanguage,
}: {
  mode: 'chat' | 'plan' | 'agent'
  disabled: boolean
  onChange: (mode: 'chat' | 'plan' | 'agent') => void
  appLanguage: 'ru' | 'en'
}) {
  const t = (ru: string, en: string) => (appLanguage === 'ru' ? ru : en)
  const chips: {
    id: 'chat' | 'plan' | 'agent'
    label: string
    tip: string
  }[] = [
    {
      id: 'chat',
      label: t('Chat', 'Chat'),
      tip: t(
        'Обсуждение без инструментов. Модель отвечает только текстом.',
        'Discussion only. The model cannot use any tools.',
      ),
    },
    {
      id: 'plan',
      label: t('Plan', 'Plan'),
      tip: t(
        'Планирование (только чтение). Модель исследует проект, задаёт вопросы и готовит план на согласование.',
        'Planning (read-only). The model explores the project, asks questions, and drafts a plan for approval.',
      ),
    },
    {
      id: 'agent',
      label: t('Agent', 'Agent'),
      tip: t(
        'Полный агентский режим со всеми инструментами.',
        'Full agent mode with all tools enabled.',
      ),
    },
  ]
  return (
    <div className="flex items-center gap-1 px-2 pb-2 pt-0.5">
      <span className="text-[10px] uppercase tracking-wider text-zinc-600 mr-1">
        {t('Режим', 'Mode')}
      </span>
      {chips.map((c) => {
        const active = c.id === mode
        return (
          <button
            key={c.id}
            title={c.tip}
            disabled={disabled}
            onClick={() => onChange(c.id)}
            className={
              'px-2 py-0.5 rounded text-[11px] font-medium transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ' +
              (active
                ? 'bg-blue-500/20 text-blue-300 ring-1 ring-blue-500/40'
                : 'bg-zinc-800/60 text-zinc-400 hover:bg-zinc-700/60 hover:text-zinc-200')
            }
          >
            {c.label}
          </button>
        )
      })}
    </div>
  )
}

function pluralLines(n: number, lang: 'ru' | 'en' = 'ru'): string {
  if (lang === 'en') return n === 1 ? 'line' : 'lines'
  if (n % 10 === 1 && n % 100 !== 11) return 'строка'
  if ([2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100)) return 'строки'
  return 'строк'
}
