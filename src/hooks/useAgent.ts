import { useEffect, useRef, useCallback, useState } from 'react'
import type { AgentEvent, DownloadProgress, AppStatus, HunkReviewPayload } from '../../electron/types'
import type { SessionInfo } from '../../electron/agent'

export interface ToolCall {
  name: string
  args: Record<string, unknown>
  result?: string
  approvalId?: string
  approvalStatus?: 'pending' | 'approved' | 'denied'
  /** Shadow-git SHA captured right BEFORE this tool ran. Presence of this
   *  field is what enables the "Restore" button in the UI. */
  checkpointSha?: string
  /** Human-readable label for the snapshot (e.g. "before write_file src/App.tsx"). */
  checkpointLabel?: string
  /** If the user has restored to this checkpoint, we mark it so the UI can
   *  show a subtle "restored" state instead of another button. */
  checkpointRestored?: boolean
}

export interface StreamingFile {
  toolName: string
  path: string
  content: string
  done: boolean
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'status'
  content: string
  thinking?: string
  toolCalls?: ToolCall[]
  streamingFile?: StreamingFile
  done?: boolean
}

interface SessionState {
  messages: ChatMessage[]
  idCounter: number
}

type AgentMode = 'chat' | 'plan' | 'agent'

export function routeModeForMessage(text: string, current: AgentMode): AgentMode {
  const s = text.toLowerCase()
  if (/^\s*(продолжай|continue|go on|дальше|ок|давай|делай)\s*[.!?]*\s*$/i.test(text)) return current
  if (/выполни\s+(этот\s+)?план|выполняй\s+(этот\s+)?план|приступай\s+к\s+(выполнению|реализации)|начинай\s+(выполнение|реализацию)|apply\s+(the\s+)?plan|execute\s+(the\s+)?plan/.test(s)) return 'agent'
  if (/(^|\s)\/chat\b|обсуди|поговорим|что думаешь|объясни|поясни|explain|discuss|what do you think/.test(s)) return 'chat'
  if (/(^|\s)\/plan\b|спланируй|составь план|план\b|архитектур|дизайн|roadmap|design|plan\b|proposal|подход/.test(s)) return 'plan'
  if (/(^|\s)\/agent\b|сделай|реализуй|исправь|добавь|почини|удали|перепиши|создай|implement|fix|add|remove|refactor|write|update|build/.test(s)) return 'agent'
  return current
}

export function useAgent() {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)

  const sessionStates = useRef(new Map<string, SessionState>())

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<AppStatus | null>(null)
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null)
  const [buildStatus, setBuildStatus] = useState<string | null>(null)
  const [workspace, setWorkspaceState] = useState(() => localStorage.getItem('workspace') || '')
  const [contextUsage, setContextUsage] = useState<{ usedTokens: number; budgetTokens: number; maxContextTokens: number; percent: number } | null>(null)
  const [tokensPerSecond, setTokensPerSecond] = useState<number | null>(null)
  const [hunkReview, setHunkReview] = useState<HunkReviewPayload | null>(null)
  const [planArtifactPath, setPlanArtifactPath] = useState<string | null>(null)
  // Latest task-state snapshot pushed by the agent via `task_state`
  // events. Bumped whenever the agent calls `update_plan`, so the task
  // panel in the sidebar can re-render mid-turn (before any new chat
  // message lands) without us having to poll getTaskState on a timer.
  const [taskState, setTaskState] = useState<unknown>(null)
  const assistantRef = useRef<ChatMessage | null>(null)
  const idCounter = useRef(0)

  const nextId = () => String(++idCounter.current)

  function saveCurrentToMap() {
    if (activeSessionId && workspace) {
      sessionStates.current.set(activeSessionId, {
        messages,
        idCounter: idCounter.current,
      })
      window.api?.saveUiMessages(workspace, activeSessionId, messages).catch(() => {})
    }
  }

  async function loadFromMap(sessionId: string) {
    const state = sessionStates.current.get(sessionId)
    if (state) {
      idCounter.current = state.idCounter
      setMessages(state.messages)
    } else {
      if (!workspace || !window.api) return
      try {
        const saved = await window.api.getUiMessages(workspace, sessionId)
        if (saved && saved.length > 0) {
          const maxId = saved.reduce((max: number, m: any) => Math.max(max, parseInt(m.id) || 0), 0)
          idCounter.current = maxId
          setMessages(saved)
          sessionStates.current.set(sessionId, { messages: saved, idCounter: maxId })
        } else {
          idCounter.current = 0
          setMessages([])
        }
      } catch {
        idCounter.current = 0
        setMessages([])
      }
    }
    assistantRef.current = null
  }

  async function hydrateTaskState(sessionId: string | null) {
    if (!workspace || !window.api || !sessionId) {
      setTaskState(null)
      return
    }
    try {
      const ts = await window.api.getTaskState(workspace, sessionId)
      setTaskState(ts ?? null)
    } catch {
      setTaskState(null)
    }
  }

  // When workspace changes: load that project's sessions and active chat (no cross-project mixing)
  useEffect(() => {
    // Any live task-state snapshot belongs to the previous workspace —
    // drop it so the panel doesn't flash wrong data; the panel itself
    // will refetch via IPC as soon as the new workspace is set.
    setTaskState(null)
    if (!window.api || !workspace.trim()) {
      setSessions([])
      setActiveSessionId(null)
      setMessages([])
      return
    }
    sessionStates.current.clear()
    ;(async () => {
      let list = await window.api.listSessions(workspace)
      const activeId = await window.api.getActiveSessionId(workspace)

      if (list.length === 0) {
        await window.api.createSession(workspace)
        list = await window.api.listSessions(workspace)
      }

      setSessions(list)

      let targetId: string | null = null
      if (activeId && list.some((s: SessionInfo) => s.id === activeId)) {
        targetId = activeId
      } else if (list.length > 0) {
        targetId = list[0].id
        await window.api.switchSession(workspace, list[0].id)
      }

      if (targetId) {
        setActiveSessionId(targetId)
        await loadFromMap(targetId)
        await hydrateTaskState(targetId)
      } else {
        setActiveSessionId(null)
        setMessages([])
        setTaskState(null)
      }
    })()
  }, [workspace])

  useEffect(() => {
    if (!window.api) return
    const off1 = window.api.onAgentEvent((ev: AgentEvent) => {
      handleAgentEvent(ev)
    })
    const off2 = window.api.onDownloadProgress((p: DownloadProgress) => {
      setDownloadProgress(p)
    })
    const off3 = window.api.onBuildStatus((s: string) => {
      setBuildStatus(s)
    })
    return () => {
      off1(); off2(); off3()
      if (pendingRafRef.current) cancelAnimationFrame(pendingRafRef.current)
      if (throttleTimerRef.current) clearTimeout(throttleTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (!window.api) return
    pollStatus()
    const interval = setInterval(pollStatus, 5000)
    return () => clearInterval(interval)
  }, [])

  const pollStatus = async () => {
    try {
      const s = await window.api.getStatus()
      setStatus(s)
    } catch {}
  }

  const refreshSessions = useCallback(async () => {
    if (!workspace || !window.api) return
    try {
      let list = await window.api.listSessions(workspace)

      // Self-heal an empty session list. This can happen after deleting
      // every persisted chat (or after a race between delete/refresh).
      // The app works best with exactly one active empty chat instead of
      // a null active session that makes the "+" button look broken.
      if (list.length === 0) {
        const id = await window.api.createSession(workspace)
        list = await window.api.listSessions(workspace)
        setActiveSessionId(id)
        setMessages([])
        setTaskState(null)
        assistantRef.current = null
        idCounter.current = 0
        sessionStates.current.delete(id)
      } else {
        const activeId = await window.api.getActiveSessionId(workspace)
        if (!activeId || !list.some((s: SessionInfo) => s.id === activeId)) {
          const next = list[0]
          await window.api.switchSession(workspace, next.id)
          setActiveSessionId(next.id)
          await loadFromMap(next.id)
          await hydrateTaskState(next.id)
        }
      }

      setSessions(list)
    } catch {}
  }, [workspace])

  // Streaming events (thinking/response) are very frequent — batch with rAF and throttle to avoid blocking editor
  const pendingRafRef = useRef<number | null>(null)
  const throttleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dirtyRef = useRef(false)
  const lastFlushAtRef = useRef(0)
  const FLUSH_THROTTLE_MS = 100

  const flushMessages = useCallback(() => {
    if (!dirtyRef.current) return
    const now = Date.now()
    if (now - lastFlushAtRef.current < FLUSH_THROTTLE_MS) {
      if (!throttleTimerRef.current) {
        throttleTimerRef.current = setTimeout(() => {
          throttleTimerRef.current = null
          lastFlushAtRef.current = Date.now()
          dirtyRef.current = false
          setMessages((prev) => [...prev])
        }, FLUSH_THROTTLE_MS - (now - lastFlushAtRef.current))
      }
      return
    }
    lastFlushAtRef.current = now
    dirtyRef.current = false
    setMessages((prev) => [...prev])
  }, [])

  const handleAgentEvent = useCallback((ev: AgentEvent) => {
    // High-frequency events: mutate in place, batch React updates via rAF
    if (ev.type === 'thinking' || (ev.type === 'response' && !ev.done) || ev.type === 'tool_streaming') {
      const assistant = assistantRef.current
      if (!assistant) return
      if (ev.type === 'thinking') {
        assistant.thinking = (assistant.thinking ?? '') + ev.content
      } else if (ev.type === 'tool_streaming') {
        assistant.streamingFile = {
          toolName: ev.name ?? '',
          path: ev.toolStreamPath ?? '',
          content: ev.toolStreamContent ?? '',
          done: ev.done ?? false,
        }
        if (ev.done) {
          // Clear after a short delay so the UI can show the final state
          setTimeout(() => {
            if (assistant.streamingFile?.done) {
              assistant.streamingFile = undefined
              dirtyRef.current = true
              flushMessages()
            }
          }, 300)
        }
      } else {
        if (ev.content) assistant.content = ev.content
      }
      dirtyRef.current = true
      if (!pendingRafRef.current) {
        pendingRafRef.current = requestAnimationFrame(() => {
          pendingRafRef.current = null
          flushMessages()
        }) as unknown as number
      }
      return
    }

    if (ev.type === 'context_usage') {
      if (ev.contextUsage) setContextUsage(ev.contextUsage)
      return
    }
    if (ev.type === 'stream_stats') {
      if (ev.tokensPerSecond != null) setTokensPerSecond(ev.tokensPerSecond)
      return
    }
    if (ev.type === 'hunk_review') {
      // Show the inline-diff modal. The agent is now blocked inside
      // reviewAndApplyWrite until we call `respondHunkReview`.
      if (ev.hunkReview) setHunkReview(ev.hunkReview)
      return
    }
    if (ev.type === 'task_state') {
      // Live push from the backend after every `update_plan` tool call.
      // We just park the snapshot — the TaskStatePanel subscribes to it.
      if (ev.taskState !== undefined) setTaskState(ev.taskState)
      return
    }
    if (ev.type === 'plan_artifact') {
      if (typeof ev.planArtifactPath === 'string') setPlanArtifactPath(ev.planArtifactPath)
      return
    }

    // All other events: immediate state update
    setMessages((prev) => {
      const msgs = [...prev]
      let assistant = msgs.find((m) => m.id === assistantRef.current?.id)

      if (ev.type === 'new_turn') {
        // Finalize the current assistant message and start a fresh one
        if (assistant) {
          assistant.done = true
        }
        const newMsg: ChatMessage = { id: nextId(), role: 'assistant', content: '', toolCalls: [] }
        assistantRef.current = newMsg
        msgs.push(newMsg)
        return msgs
      }

      if (!assistant) {
        assistant = { id: nextId(), role: 'assistant', content: '', toolCalls: [] }
        assistantRef.current = assistant
        msgs.push(assistant)
      }

      switch (ev.type) {
        case 'status':
          msgs.push({ id: nextId(), role: 'status', content: ev.content ?? '' })
          break
        case 'tool_call':
          assistant.toolCalls = [
            ...(assistant.toolCalls ?? []),
            {
              name: ev.name ?? '',
              args: ev.args ?? {},
              checkpointSha: ev.checkpoint?.sha,
              checkpointLabel: ev.checkpoint?.label,
            },
          ]
          break
        case 'command_approval': {
          const calls = assistant.toolCalls ?? []
          if (calls.length > 0) {
            calls[calls.length - 1].approvalId = ev.approvalId
            calls[calls.length - 1].approvalStatus = 'pending'
          }
          break
        }
        case 'tool_result': {
          const calls = assistant.toolCalls ?? []
          if (calls.length > 0) {
            const last = calls[calls.length - 1]
            last.result = ev.result
            if (last.approvalStatus === 'pending') last.approvalStatus = 'approved'
          }
          break
        }
        case 'response':
          if (ev.content) assistant.content = ev.content
          if (ev.done) {
            assistant.done = true
            assistantRef.current = null
            setBusy(false)
          }
          break
        case 'error':
          msgs.push({ id: nextId(), role: 'status', content: `⚠ ${ev.content}` })
          assistantRef.current = null
          setBusy(false)
          break
      }

      return msgs
    })
  }, [flushMessages])

  const respondApproval = useCallback((approvalId: string, approved: boolean) => {
    window.api.respondApproval(approvalId, approved)
    setMessages((prev) =>
      prev.map((msg) => {
        if (msg.toolCalls) {
          const updated = msg.toolCalls.map((tc) =>
            tc.approvalId === approvalId
              ? { ...tc, approvalStatus: (approved ? 'approved' : 'denied') as 'approved' | 'denied' }
              : tc
          )
          return { ...msg, toolCalls: updated }
        }
        return msg
      })
    )
  }, [])

  const respondHunkReview = useCallback((
    approvalId: string,
    decision:
      | { decision: 'accept_all' }
      | { decision: 'accept_selected'; selectedHunkIds: number[] }
      | { decision: 'reject' },
  ) => {
    window.api.respondHunkReview(approvalId, decision)
    setHunkReview(null)
  }, [])

  // Per-session mode (chat/plan/agent). Derived from `sessions` via
  // `activeSessionId` — keeping it a derived constant means the chip
  // switcher in the UI auto-updates after every `refreshSessions` call
  // without us having to plumb an extra setter through.
  const activeMode: AgentMode = (() => {
    if (!activeSessionId) return 'agent'
    const s = sessions.find((x) => x.id === activeSessionId)
    return (s?.mode === 'chat' || s?.mode === 'plan' || s?.mode === 'agent') ? s.mode : 'agent'
  })()

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || busy) return
    const routedMode = routeModeForMessage(text, activeMode)
    if (workspace && activeSessionId && routedMode !== activeMode) {
      try {
        await window.api.setSessionMode(workspace, activeSessionId, routedMode)
        setSessions((prev) => prev.map((s) => s.id === activeSessionId ? { ...s, mode: routedMode } : s))
      } catch {}
    }
    setMessages((prev) => {
      const userMsg: ChatMessage = { id: nextId(), role: 'user', content: text }
      const assistantMsg: ChatMessage = { id: nextId(), role: 'assistant', content: '', toolCalls: [] }
      assistantRef.current = assistantMsg
      return [...prev, userMsg, assistantMsg]
    })
    setBusy(true)
    try {
      await window.api.sendMessage(text, workspace)
    } catch (e: any) {
      setMessages((prev) => [...prev, { id: nextId(), role: 'status', content: `⚠ ${e.message ?? e}` }])
      setBusy(false)
    }
    await refreshSessions()
    await hydrateTaskState(activeSessionId)
  }, [busy, workspace, activeSessionId, activeMode, refreshSessions])

  const cancel = useCallback(async () => {
    try {
      await window.api.cancelAgent()
    } catch {}
    setBusy(false)
  }, [])

  const setWorkspace = useCallback((ws: string) => {
    setWorkspaceState(ws)
    localStorage.setItem('workspace', ws)
    window.api.setWorkspace(ws)
  }, [])

  const resetChat = useCallback(() => {
    setMessages([])
    assistantRef.current = null
    idCounter.current = 0
    if (activeSessionId && workspace) {
      sessionStates.current.set(activeSessionId, { messages: [], idCounter: 0 })
      window.api.saveUiMessages(workspace, activeSessionId, []).catch(() => {})
    }
    window.api.resetAgent(workspace)
    refreshSessions()
  }, [activeSessionId, workspace, refreshSessions])

  // ---------------------------------------------------------------------------
  // Session actions
  // ---------------------------------------------------------------------------

  const newSession = useCallback(async () => {
    if (busy || !workspace) return
    saveCurrentToMap()
    try {
      const id = await window.api.createSession(workspace)
      setActiveSessionId(id)
      setMessages([])
      setTaskState(null)
      assistantRef.current = null
      idCounter.current = 0
      sessionStates.current.delete(id)
      await refreshSessions()
      await hydrateTaskState(id)
    } catch {
      // If creation failed because frontend/backend state drifted, force
      // one refresh; refreshSessions itself can recreate a missing chat.
      await refreshSessions()
    }
  }, [busy, workspace, activeSessionId, messages, refreshSessions])

  const switchToSession = useCallback(async (id: string) => {
    if (busy || !workspace || id === activeSessionId) return
    saveCurrentToMap()
    const ok = await window.api.switchSession(workspace, id)
    if (ok) {
      setActiveSessionId(id)
      await loadFromMap(id)
      await hydrateTaskState(id)
    }
  }, [busy, workspace, activeSessionId, messages])

  /** Change the mode of the active session. Persists server-side via
   *  IPC and refreshes the sessions list so the UI picks up the new
   *  value. Blocked while the agent is running — the mode is read at
   *  the start of each turn, and yanking it mid-turn would be confusing. */
  const setSessionMode = useCallback(async (mode: 'chat' | 'plan' | 'agent') => {
    if (!workspace || !activeSessionId || busy) return
    try {
      await window.api.setSessionMode(workspace, activeSessionId, mode)
      await refreshSessions()
    } catch {}
  }, [workspace, activeSessionId, busy, refreshSessions])

  const removeSession = useCallback(async (id: string) => {
    if (busy || !workspace) return
    await window.api.deleteSession(workspace, id)
    sessionStates.current.delete(id)

    if (id === activeSessionId) {
      const remaining = sessions.filter((s) => s.id !== id)
      if (remaining.length > 0) {
        const next = remaining[0]
        await window.api.switchSession(workspace, next.id)
        setActiveSessionId(next.id)
        await loadFromMap(next.id)
        await hydrateTaskState(next.id)
      } else {
        const newId = await window.api.createSession(workspace)
        setActiveSessionId(newId)
        setMessages([])
        setTaskState(null)
        assistantRef.current = null
        idCounter.current = 0
        sessionStates.current.delete(newId)
      }
    }
    await refreshSessions()
  }, [busy, workspace, activeSessionId, sessions, refreshSessions])

  /**
   * Revert the workspace files to the state captured in the given shadow-git
   * checkpoint. If mode === 'files+task', also truncate the chat so that the
   * conversation goes back to just before the assistant decision that made
   * the edit — i.e. the user's previous turn is the new "tail".
   *
   * Safe against concurrency: we block if the agent is currently running.
   */
  const restoreCheckpoint = useCallback(async (sha: string, mode: 'files' | 'files+task' = 'files') => {
    if (!workspace) throw new Error('No workspace')
    if (busy) throw new Error('Agent is currently running — cancel first')
    await window.api.restoreCheckpoint(workspace, sha)

    setMessages((prev) => {
      // Find the assistant message containing this SHA.
      const idx = prev.findIndex((m) => m.toolCalls?.some((tc) => tc.checkpointSha === sha))
      if (idx === -1) return prev

      if (mode === 'files') {
        // Mark the tool call as "restored" so the UI shows a checkmark, and
        // drop a status bubble explaining what happened.
        const next = prev.map((m) => {
          if (!m.toolCalls) return m
          const updated = m.toolCalls.map((tc) =>
            tc.checkpointSha === sha ? { ...tc, checkpointRestored: true } : tc
          )
          return { ...m, toolCalls: updated }
        })
        next.push({ id: nextId(), role: 'status', content: `↩ Files restored to checkpoint ${sha.slice(0, 8)}` })
        return next
      }

      // files+task: truncate messages to *before* the assistant turn that
      // produced this edit, so the user can re-ask the question.
      let truncateFrom = idx
      // Walk back to include the preceding "user" message index (assistant
      // messages are usually preceded by a user message — but status rows
      // may intervene).
      while (truncateFrom > 0 && prev[truncateFrom - 1].role === 'status') truncateFrom--
      const truncated = prev.slice(0, truncateFrom)
      truncated.push({ id: nextId(), role: 'status', content: `↩ Restored to checkpoint ${sha.slice(0, 8)} (files + chat)` })
      return truncated
    })

    // If we truncated chat, also reset the backend session so its message
    // buffer stays consistent with what the UI shows. Safe no-op for 'files'.
    if (mode === 'files+task' && activeSessionId) {
      try { await window.api.resetAgent(workspace) } catch {}
    }
  }, [workspace, busy, activeSessionId])

  const renameActiveSession = useCallback(async (title: string) => {
    if (!activeSessionId || !workspace) return
    await window.api.renameSession(workspace, activeSessionId, title)
    await refreshSessions()
  }, [activeSessionId, workspace, refreshSessions])

  // Persist messages to map + debounced disk save
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (activeSessionId && workspace) {
      sessionStates.current.set(activeSessionId, {
        messages,
        idCounter: idCounter.current,
      })

      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(() => {
        window.api?.saveUiMessages(workspace, activeSessionId, messages).catch(() => {})
      }, 500)
    }
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [messages, activeSessionId, workspace])

  return {
    messages, busy, status, downloadProgress, buildStatus,
    workspace, setWorkspace, contextUsage, tokensPerSecond,
    sendMessage, resetChat, pollStatus, respondApproval, cancel,
    sessions, activeSessionId,
    newSession, switchToSession, removeSession, renameActiveSession,
    restoreCheckpoint,
    hunkReview, respondHunkReview,
    taskState,
    planArtifactPath,
    clearPlanArtifactPath: () => setPlanArtifactPath(null),
    mode: activeMode, setMode: setSessionMode,
  }
}
