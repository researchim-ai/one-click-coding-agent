import { useAgent } from './hooks/useAgent'
import { useEditor } from './hooks/useEditor'
import { useResizable } from './hooks/useResizable'
import { Sidebar } from './components/Sidebar'
import { EditorTabs } from './components/EditorTabs'
import { CodeEditor } from './components/CodeEditor'
import { Chat } from './components/Chat'
import { SetupWizard } from './components/SetupWizard'
import { StatusBar } from './components/StatusBar'
import { useState } from 'react'

export function App() {
  const {
    messages, busy, status, downloadProgress, buildStatus,
    workspace, setWorkspace,
    sendMessage, resetChat, pollStatus, respondApproval,
  } = useAgent()

  const {
    openFiles, activeFile, activeFilePath,
    openFile, closeFile, setActiveFilePath,
  } = useEditor()

  const [setupDone, setSetupDone] = useState(false)

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

  const serverOnline = status?.serverRunning === true && status?.serverHealth?.status === 'ok'
  const showSetup = !setupDone && !serverOnline

  const handleSetupComplete = () => {
    setSetupDone(true)
    pollStatus()
  }

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
            />
          </div>
        )}

        {/* Sidebar resize handle */}
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
            {/* Editor panel */}
            <div className="flex-1 flex flex-col overflow-hidden min-w-0 bg-[#0d1117]">
              <EditorTabs
                files={openFiles}
                activeFilePath={activeFilePath}
                onSelect={setActiveFilePath}
                onClose={closeFile}
              />
              {activeFile ? (
                <CodeEditor file={activeFile} />
              ) : (
                <div className="flex-1 flex items-center justify-center text-zinc-600">
                  <div className="text-center">
                    <div className="text-4xl mb-3 opacity-30">⚡</div>
                    <p className="text-sm">Выбери файл слева</p>
                  </div>
                </div>
              )}
            </div>

            {/* Chat resize handle */}
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
                />
              </div>
            )}
          </>
        )}
      </div>

      <StatusBar status={status} />
    </div>
  )
}
