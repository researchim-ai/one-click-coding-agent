import { memo, useMemo } from 'react'
import Markdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCallBlock } from './ToolCallBlock'
import type { ChatMessage } from '../hooks/useAgent'

interface Props {
  message: ChatMessage
  onApprove?: (id: string) => void
  onDeny?: (id: string) => void
  pending?: boolean
  onCancel?: () => void
}

const rehypePlugins = [rehypeHighlight] as any[]

const MemoMarkdown = memo(function MemoMarkdown({ content }: { content: string }) {
  return <Markdown rehypePlugins={rehypePlugins}>{content}</Markdown>
})

export const MessageBubble = memo(function MessageBubble({ message, onApprove, onDeny, pending, onCancel }: Props) {
  if (message.role === 'status') {
    return (
      <div className="text-center text-zinc-600 text-[11px] py-0.5 animate-[fadeIn_0.2s] font-mono">
        {message.content}
      </div>
    )
  }

  if (message.role === 'user') {
    return (
      <div className="self-end max-w-[85%] animate-[fadeIn_0.2s]">
        <div className="relative">
          <div className="bg-blue-600/90 text-white px-4 py-2.5 rounded-2xl rounded-br-sm text-[13.5px] leading-relaxed whitespace-pre-wrap">
            {message.content}
          </div>
          {pending && (
            <div className="flex items-center gap-1.5 justify-end mt-1 text-[10px] text-blue-200/80">
              <span className="w-1.5 h-1.5 bg-blue-300 rounded-full animate-[pulse-dot_1.4s_0s_infinite]" />
              <span className="w-1.5 h-1.5 bg-blue-300 rounded-full animate-[pulse-dot_1.4s_0.2s_infinite]" />
              <span className="w-1.5 h-1.5 bg-blue-300 rounded-full animate-[pulse-dot_1.4s_0.4s_infinite]" />
              {onCancel && (
                <button
                  onClick={onCancel}
                  className="ml-1 px-2 py-0.5 rounded-full border border-blue-300/40 text-[10px] text-blue-50 hover:bg-blue-500/20 cursor-pointer"
                >
                  ⏹ Остановить
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    )
  }

  // Assistant message
  const hasContent = !!message.content
  const hasTools = !!(message.toolCalls?.length)
  const hasThinking = !!message.thinking
  const isLoading = !message.done && !hasContent && !hasTools && !hasThinking
  const thinkingLive = hasThinking && !message.done && !hasContent

  return (
    <div className="self-start max-w-full animate-[fadeIn_0.2s]">
      {hasThinking && <ThinkingBlock content={message.thinking!} live={thinkingLive} />}

      {hasTools && (
        <div className="space-y-1 my-1">
          {message.toolCalls!.map((tc, i) => (
            <ToolCallBlock
              key={i}
              name={tc.name}
              args={tc.args}
              result={tc.result}
              approvalId={tc.approvalId}
              approvalStatus={tc.approvalStatus}
              onApprove={onApprove}
              onDeny={onDeny}
            />
          ))}
        </div>
      )}

      {hasContent && (
        <div className="agent-prose mt-1">
          <MemoMarkdown content={message.content} />
        </div>
      )}

      {isLoading && (
        <div className="flex gap-1.5 py-2 px-1">
          <span className="w-1.5 h-1.5 bg-zinc-600 rounded-full animate-[pulse-dot_1.4s_0s_infinite]" />
          <span className="w-1.5 h-1.5 bg-zinc-600 rounded-full animate-[pulse-dot_1.4s_0.2s_infinite]" />
          <span className="w-1.5 h-1.5 bg-zinc-600 rounded-full animate-[pulse-dot_1.4s_0.4s_infinite]" />
        </div>
      )}
    </div>
  )
})
