import { useRef, useEffect, useState, type KeyboardEvent } from 'react'
import { MessageBubble } from './MessageBubble'
import type { ChatMessage } from '../hooks/useAgent'

interface Props {
  messages: ChatMessage[]
  busy: boolean
  workspace: string
  onSend: (text: string) => void
  onApproval?: (id: string, approved: boolean) => void
}

export function Chat({ messages, busy, workspace, onSend, onApproval }: Props) {
  const [input, setInput] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleSend = () => {
    if (!input.trim() || busy) return
    onSend(input.trim())
    setInput('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleInput = (val: string) => {
    setInput(val)
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + 'px'
    }
  }

  const noWorkspace = !workspace

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-5 py-5">
        <div className="flex flex-col gap-5">
          {messages.length === 0 && (
            <div className="text-center py-20 text-zinc-500">
              <div className="text-5xl mb-4">⚡</div>
              <h2 className="text-2xl font-bold text-zinc-200 mb-2">Coding Agent</h2>
              <p className="text-base max-w-md mx-auto leading-relaxed mb-6">
                Автономный AI-агент для разработки.<br />
                Читает, пишет и редактирует код, запускает команды.
              </p>
              {noWorkspace ? (
                <div className="inline-flex items-center gap-2 px-4 py-2 bg-amber-500/10 border border-amber-500/30 rounded-lg text-sm text-amber-400">
                  <span>📁</span> Выбери рабочую директорию в боковой панели
                </div>
              ) : (
                <div className="space-y-2 text-sm text-zinc-500">
                  <p>Примеры задач:</p>
                  <div className="flex flex-wrap justify-center gap-2">
                    {[
                      'Изучи проект и опиши архитектуру',
                      'Найди и исправь баг в…',
                      'Добавь юнит-тесты',
                      'Отрефактори компонент…',
                    ].map((ex) => (
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
          {messages.map((msg) => (
            <MessageBubble
              key={msg.id}
              message={msg}
              onApprove={onApproval ? (id) => onApproval(id, true) : undefined}
              onDeny={onApproval ? (id) => onApproval(id, false) : undefined}
            />
          ))}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Input */}
      <div className="border-t border-zinc-800/60 bg-zinc-950/80 px-4 py-3">
        <div className="flex gap-2 items-end">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => handleInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={busy || noWorkspace}
            placeholder={noWorkspace ? 'Сначала выбери проект ←' : 'Опиши задачу… (Enter — отправить, Shift+Enter — новая строка)'}
            rows={1}
            className="flex-1 bg-zinc-900 border border-zinc-700/50 rounded-xl px-3.5 py-2.5 text-[13px] text-zinc-100 placeholder-zinc-600 resize-none focus:outline-none focus:border-blue-500/60 transition-colors disabled:opacity-50"
          />
          <button
            onClick={handleSend}
            disabled={busy || !input.trim() || noWorkspace}
            className="w-9 h-9 flex items-center justify-center rounded-lg bg-blue-600/80 text-white hover:bg-blue-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors shrink-0 cursor-pointer text-sm"
          >
            ➤
          </button>
        </div>
      </div>
    </div>
  )
}
