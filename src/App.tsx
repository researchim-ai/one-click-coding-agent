import { useAgent } from './hooks/useAgent'
import { useEditor } from './hooks/useEditor'
import { useResizable } from './hooks/useResizable'
import { Sidebar } from './components/Sidebar'
import { EditorTabs } from './components/EditorTabs'
import { CodeEditor } from './components/CodeEditor'
import { Chat, type CodeReference } from './components/Chat'
import { Terminal } from './components/Terminal'
import { SetupWizard } from './components/SetupWizard'
import { StatusBar } from './components/StatusBar'
import { useState, useEffect, useCallback } from 'react'

export function App() {
  const {
    messages, busy, status, downloadProgress, buildStatus,
    workspace, setWorkspace,
    sendMessage, resetChat, pollStatus, respondApproval,
  } = useAgent()

  const {
    openFiles, activeFile, activeFilePath,
    openFile, closeFile, closeAll, closeOthers, setActiveFilePath,
  } = useEditor()

  const [setupDone, setSetupDone] = useState(false)
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [codeRefs, setCodeRefs] = useState<CodeReference[]>([])

  const addCodeRef = useCallback((ref: CodeReference) => {
    setCodeRefs((prev) => {
      const key = `${ref.filePath}:${ref.startLine}:${ref.endLine}`
      if (prev.some((r) => `${r.filePath}:${r.startLine}:${r.endLine}` === key)) return prev
      return [...prev, ref]
    })
  }, [])

  const removeCodeRef = useCallback((index: number) => {
    setCodeRefs((prev) => prev.filter((_, i) => i !== index))
  }, [])

  const sidebar = useResizable({
    direction: 'left',
    initialSize: 240,
    minSize: 160,
    maxSize: 480,
    collapsedSize: 0,
    collapseThreshold: 100,
  })

  const chat = useResizable({
    direction: 'right',
    initialSize: 420,
    minSize: 280,
    maxSize: 800,
    collapsedSize: 40,
    collapseThreshold: 180,
  })

  const onBottomDragStart = useCallback(() => {
    setTerminalOpen(true)
  }, [])

  const bottomPanel = useResizable({
    direction: 'down',
    initialSize: 250,
    minSize: 120,
    maxSize: 600,
    collapsedSize: 0,
    collapseThreshold: 80,
    onDragStart: onBottomDragStart,
  })

  const serverOnline = status?.serverRunning === true && status?.serverHealth?.status === 'ok'
  const showSetup = !setupDone && !serverOnline

  const handleSetupComplete = () => {
    setSetupDone(true)
    pollStatus()
  }

  const toggleTerminal = () => {
    if (!terminalOpen || bottomPanel.collapsed) {
      bottomPanel.setCollapsed(false)
      setTerminalOpen(true)
    } else {
      bottomPanel.setCollapsed(true)
      setTerminalOpen(false)
    }
  }

  const closeTerminal = () => {
    bottomPanel.setCollapsed(true)
    setTerminalOpen(false)
  }

  const showTerminal = terminalOpen && !bottomPanel.collapsed

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === '`') {
        e.preventDefault()
        toggleTerminal()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  return (
    <div className="h-screen flex flex-col bg-zinc-950 text-zinc-50">
      <div className="flex flex-1 overflow-hidden">
        {/* File tree sidebar */}
        {sidebar.collapsed ? (
          <button
            onClick={() => sidebar.setCollapsed(false)}
            className="w-10 bg-[#010409] border-r border-zinc-800/60 flex flex-col items-center pt-3 gap-2 shrink-0 cursor-pointer hover:bg-zinc-900/50 transition-colors"
            title="Развернуть панель"
          >
            <span className="text-sm">⚡</span>
            <span className="text-[10px] text-zinc-600 [writing-mode:vertical-lr] rotate-180">Файлы</span>
          </button>
        ) : (
          <div style={{ width: sidebar.size }} className="shrink-0 flex flex-col overflow-hidden">
            <Sidebar
              workspace={workspace}
              onWorkspaceChange={setWorkspace}
              onFileClick={openFile}
              serverOnline={serverOnline}
              onReset={resetChat}
              onOpenTerminalAt={(dir) => {
                bottomPanel.setCollapsed(false)
                setTerminalOpen(true)
              }}
            />
          </div>
        )}

        <div className="resize-handle" onMouseDown={sidebar.onMouseDown} />

        {showSetup ? (
          <main className="flex-1 flex flex-col overflow-hidden">
            <SetupWizard
              status={status}
              downloadProgress={downloadProgress}
              buildStatus={buildStatus}
              onComplete={handleSetupComplete}
            />
          </main>
        ) : (
          <>
            {/* Center: editor + bottom terminal */}
            <div className="flex-1 flex flex-col overflow-hidden min-w-0">
              {/* Editor */}
              <div className="flex-1 flex flex-col overflow-hidden bg-[#0d1117]">
                <EditorTabs
                  files={openFiles}
                  activeFilePath={activeFilePath}
                  workspace={workspace}
                  onSelect={setActiveFilePath}
                  onClose={closeFile}
                  onCloseAll={closeAll}
                  onCloseOthers={closeOthers}
                />
                {activeFile ? (
                  <CodeEditor file={activeFile} workspace={workspace} onAttachCode={addCodeRef} />
                ) : (
                  <div className="flex-1 flex items-center justify-center text-zinc-600">
                    <div className="text-center">
                      <div className="text-4xl mb-3 opacity-30">⚡</div>
                      <p className="text-sm">Выбери файл слева</p>
                    </div>
                  </div>
                )}
              </div>

              {/* Resize handle — always between editor and terminal area */}
              <div className="resize-handle-h" onMouseDown={bottomPanel.onMouseDown} />

              {/* Bottom panel: terminal */}
              {showTerminal && (
                <div
                  style={{ height: bottomPanel.size }}
                  className="shrink-0 flex flex-col overflow-hidden"
                >
                  <div className="flex items-center justify-between px-3 py-1 bg-[#010409] border-b border-zinc-800/40 shrink-0">
                    <span className="text-[11px] text-zinc-400 font-semibold">Терминал</span>
                    <button
                      onClick={closeTerminal}
                      className="w-5 h-5 flex items-center justify-center rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-200 cursor-pointer text-[10px]"
                      title="Закрыть терминал"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="flex-1 overflow-hidden">
                    <Terminal workspace={workspace} visible={showTerminal} />
                  </div>
                </div>
              )}
            </div>

            <div className="resize-handle" onMouseDown={chat.onMouseDown} />

            {/* Chat panel */}
            {chat.collapsed ? (
              <button
                onClick={() => chat.setCollapsed(false)}
                className="w-10 bg-[#010409] border-l border-zinc-800/60 flex flex-col items-center pt-3 gap-2 shrink-0 cursor-pointer hover:bg-zinc-900/50 transition-colors"
                title="Развернуть чат"
              >
                <span className="text-sm">💬</span>
                <span className="text-[10px] text-zinc-600 [writing-mode:vertical-lr] rotate-180">Агент</span>
              </button>
            ) : (
              <div
                style={{ width: chat.size }}
                className="border-l border-zinc-800/60 flex flex-col shrink-0 overflow-hidden"
              >
                <div className="flex items-center justify-between px-3 py-1.5 border-b border-zinc-800/60 bg-[#010409] shrink-0">
                  <span className="text-xs text-zinc-400 font-semibold">💬 Агент</span>
                  <button
                    onClick={() => chat.setCollapsed(true)}
                    className="w-6 h-6 flex items-center justify-center rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-200 cursor-pointer text-xs"
                    title="Свернуть чат"
                  >
                    ▶
                  </button>
                </div>
                <Chat
                  messages={messages}
                  busy={busy}
                  workspace={workspace}
                  onSend={sendMessage}
                  onApproval={(id, approved) => respondApproval(id, approved)}
                  codeRefs={codeRefs}
                  onRemoveCodeRef={removeCodeRef}
                />
              </div>
            )}
          </>
        )}
      </div>

      {/* Status bar */}
      <div className="flex items-center shrink-0">
        <div className="flex-1">
          <StatusBar status={status} />
        </div>
        {!showSetup && (
          <button
            onClick={toggleTerminal}
            className={`px-3 h-6 text-[10px] border-t border-zinc-800/60 flex items-center gap-1.5 cursor-pointer transition-colors shrink-0 ${
              showTerminal
                ? 'bg-zinc-800/60 text-zinc-300'
                : 'bg-zinc-950 text-zinc-500 hover:text-zinc-300'
            }`}
            title="Ctrl+` — Терминал"
          >
            <span className="text-[9px]">▸</span>
            Терминал
          </button>
        )}
      </div>
    </div>
  )
}
