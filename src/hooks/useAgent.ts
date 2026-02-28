import { useEffect, useRef, useCallback, useState } from 'react'
import type { AgentEvent, DownloadProgress, AppStatus } from '../../electron/types'

export interface ToolCall {
  name: string
  args: Record<string, unknown>
  result?: string
  approvalId?: string
  approvalStatus?: 'pending' | 'approved' | 'denied'
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'status'
  content: string
  thinking?: string
  toolCalls?: ToolCall[]
  done?: boolean
}

export function useAgent() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<AppStatus | null>(null)
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null)
  const [buildStatus, setBuildStatus] = useState<string | null>(null)
  const [workspace, setWorkspaceState] = useState(() => localStorage.getItem('workspace') || '')
  const assistantRef = useRef<ChatMessage | null>(null)
  const idCounter = useRef(0)

  const nextId = () => String(++idCounter.current)

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
    return () => { off1(); off2(); off3() }
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

  const handleAgentEvent = useCallback((ev: AgentEvent) => {
    setMessages((prev) => {
      const msgs = [...prev]
      let assistant = msgs.find((m) => m.id === assistantRef.current?.id)

      if (!assistant) {
        assistant = { id: nextId(), role: 'assistant', content: '', toolCalls: [] }
        assistantRef.current = assistant
        msgs.push(assistant)
      }

      switch (ev.type) {
        case 'status':
          msgs.push({ id: nextId(), role: 'status', content: ev.content ?? '' })
          break
        case 'thinking':
          assistant.thinking = (assistant.thinking ?? '') + ev.content
          break
        case 'tool_call':
          assistant.toolCalls = [
            ...(assistant.toolCalls ?? []),
            { name: ev.name ?? '', args: ev.args ?? {} },
          ]
          break
        case 'command_approval': {
          // Mark the last tool call as waiting for approval
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
  }, [])

  const respondApproval = useCallback((approvalId: string, approved: boolean) => {
    window.api.respondApproval(approvalId, approved)
    // Update the tool call status in UI immediately
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

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || busy) return
    setMessages((prev) => [...prev, { id: nextId(), role: 'user', content: text }])
    setBusy(true)
    try {
      await window.api.sendMessage(text, workspace)
    } catch (e: any) {
      setMessages((prev) => [...prev, { id: nextId(), role: 'status', content: `⚠ ${e.message ?? e}` }])
      setBusy(false)
    }
  }, [busy, workspace])

  const setWorkspace = useCallback((ws: string) => {
    setWorkspaceState(ws)
    localStorage.setItem('workspace', ws)
    window.api.setWorkspace(ws)
  }, [])

  const resetChat = useCallback(() => {
    setMessages([])
    assistantRef.current = null
    window.api.resetAgent()
  }, [])

  return {
    messages, busy, status, downloadProgress, buildStatus,
    workspace, setWorkspace,
    sendMessage, resetChat, pollStatus, respondApproval,
  }
}
