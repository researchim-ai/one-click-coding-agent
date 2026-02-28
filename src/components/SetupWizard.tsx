import { useState, useEffect, useRef } from 'react'
import type { AppStatus, DownloadProgress } from '../../electron/types'

interface Props {
  status: AppStatus | null
  downloadProgress: DownloadProgress | null
  buildStatus: string | null
  onComplete: () => void
}

type Phase = 'idle' | 'installing' | 'downloading' | 'starting' | 'done' | 'error'

export function SetupWizard({ status, downloadProgress, buildStatus, onComplete }: Props) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [startTime, setStartTime] = useState<number | null>(null)
  const logRef = useRef<HTMLDivElement>(null)

  const addLog = (msg: string) => {
    setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`])
  }

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [logs])

  useEffect(() => {
    if (buildStatus && (phase === 'installing' || phase === 'starting')) addLog(buildStatus)
  }, [buildStatus])

  useEffect(() => {
    if (downloadProgress && phase === 'downloading') {
      if (downloadProgress.totalMb > 0) {
        addLog(`\u{1F4E5} ${downloadProgress.status}`)
      } else if (downloadProgress.status) {
        addLog(downloadProgress.status)
      }
    }
  }, [downloadProgress?.status])

  const handleStart = async () => {
    setPhase('installing')
    setError(null)
    setLogs([])
    setStartTime(Date.now())

    try {
      if (!status?.llamaReady) {
        addLog('\u{1F50D} Определение оптимального бинарника для вашей системы…')
        await window.api.ensureLlama()
        addLog('\u2705 llama-server установлен!')
      } else {
        addLog('\u2705 llama-server уже установлен — пропускаем')
      }

      setPhase('downloading')
      if (!status?.modelDownloaded) {
        addLog('\u{1F4E5} Начинаем скачивание модели…')
        const modelPath = await window.api.downloadModel()
        addLog(`\u2705 Модель скачана: ${modelPath.split(/[\\/]/).pop()}`)
      } else {
        addLog('\u2705 Модель уже скачана — пропускаем')
      }

      setPhase('starting')
      addLog('\u{1F680} Запускаем llama-server…')
      await window.api.startServer()
      addLog('\u2705 Сервер запущен и готов к работе!')

      setPhase('done')
    } catch (e: any) {
      const msg = e.message ?? String(e)
      setError(msg)
      addLog(`\u274C Ошибка: ${msg}`)
      setPhase('error')
    }
  }

  const elapsed = startTime ? Math.round((Date.now() - startTime) / 1000) : 0
  const elapsedStr = elapsed > 0 ? `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}` : ''

  const steps = [
    {
      key: 'install',
      label: 'Скачивание llama-server',
      desc: 'Готовый бинарник с GitHub Releases (~30–200 МБ)',
      active: phase === 'installing',
      done: phase !== 'idle' && phase !== 'installing' && phase !== 'error',
      detail: phase === 'installing' ? buildStatus : null,
    },
    {
      key: 'download',
      label: 'Скачивание модели',
      desc: 'Qwen3.5-35B-A3B — UD-Q4_K_XL (~19 ГБ)',
      active: phase === 'downloading',
      done: ['starting', 'done'].includes(phase),
      detail: phase === 'downloading' ? downloadProgress?.status : null,
    },
    {
      key: 'server',
      label: 'Запуск inference-сервера',
      desc: 'Загрузка модели в VRAM и старт API',
      active: phase === 'starting',
      done: phase === 'done',
      detail: phase === 'starting' ? (buildStatus ?? 'Ожидание готовности…') : null,
    },
  ]

  return (
    <div className="flex-1 flex items-center justify-center p-6 overflow-y-auto">
      <div className="max-w-2xl w-full">

        {/* Header */}
        <div className="text-center mb-8">
          <div className="text-6xl mb-3">{'⚡'}</div>
          <h1 className="text-3xl font-bold text-zinc-100 mb-2">One-Click Coding Agent</h1>
          <p className="text-zinc-400">
            Qwen3.5-35B-A3B <span className="text-zinc-500">{'·'}</span> UD-Q4_K_XL <span className="text-zinc-500">{'·'}</span> llama.cpp
          </p>
        </div>

        {/* Steps */}
        <div className="space-y-3 mb-6">
          {steps.map((step, i) => (
            <div
              key={step.key}
              className={`relative flex items-start gap-4 px-5 py-4 rounded-xl border transition-all duration-300 ${
                step.done
                  ? 'border-emerald-500/40 bg-emerald-500/5'
                  : step.active
                    ? 'border-blue-500/40 bg-blue-500/5 shadow-lg shadow-blue-500/5'
                    : 'border-zinc-800 bg-zinc-900/50'
              }`}
            >
              <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold shrink-0 transition-all duration-300 ${
                step.done
                  ? 'bg-emerald-500 text-white'
                  : step.active
                    ? 'bg-blue-500 text-white animate-pulse'
                    : 'bg-zinc-800 text-zinc-500'
              }`}>
                {step.done ? '✓' : i + 1}
              </div>

              <div className="flex-1 min-w-0">
                <p className={`text-sm font-semibold transition-colors ${
                  step.done ? 'text-emerald-400' : step.active ? 'text-blue-300' : 'text-zinc-400'
                }`}>
                  {step.label}
                </p>
                <p className="text-xs text-zinc-500 mt-0.5">{step.desc}</p>

                {step.active && step.detail && (
                  <p className="text-xs text-blue-400 mt-2 font-mono animate-pulse">{step.detail}</p>
                )}

                {step.key === 'download' && step.active && downloadProgress && downloadProgress.totalMb > 0 && (
                  <div className="mt-3">
                    <div className="flex justify-between text-xs text-zinc-500 mb-1">
                      <span>{downloadProgress.downloadedMb.toLocaleString()} / {downloadProgress.totalMb.toLocaleString()} МБ</span>
                      <span>{downloadProgress.percent.toFixed(1)}%</span>
                    </div>
                    <div className="w-full h-2.5 bg-zinc-800 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-blue-600 to-blue-400 rounded-full transition-all duration-500 ease-out"
                        style={{ width: `${Math.min(downloadProgress.percent, 100)}%` }}
                      />
                    </div>
                  </div>
                )}

                {step.key === 'install' && step.active && (
                  <div className="mt-2 flex items-center gap-2">
                    <div className="w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                    <span className="text-xs text-zinc-500">Обычно это занимает менее минуты…</span>
                  </div>
                )}

                {step.key === 'server' && step.active && (
                  <div className="mt-2 flex items-center gap-2">
                    <div className="w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                    <span className="text-xs text-zinc-500">Загрузка модели в память…</span>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Error */}
        {error && (
          <div className="mb-4 px-4 py-3 bg-red-500/10 border border-red-500/30 rounded-xl text-sm text-red-400">
            <span className="font-semibold">Ошибка:</span> {error}
          </div>
        )}

        {/* Log viewer */}
        {logs.length > 0 && (
          <div className="mb-6">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-zinc-500 uppercase tracking-wider font-semibold">Лог</span>
              {elapsedStr && <span className="text-xs text-zinc-600 font-mono">{elapsedStr}</span>}
            </div>
            <div
              ref={logRef}
              className="bg-zinc-950 border border-zinc-800 rounded-xl p-3 max-h-48 overflow-y-auto font-mono text-xs leading-relaxed"
            >
              {logs.map((line, i) => (
                <div
                  key={i}
                  className={`${
                    line.includes('\u2705') ? 'text-emerald-400' :
                    line.includes('\u274C') ? 'text-red-400' :
                    line.includes('\u{1F4E5}') ? 'text-blue-400' :
                    line.includes('\u{1F50D}') || line.includes('\u{1F680}') ? 'text-amber-400' :
                    'text-zinc-500'
                  }`}
                >
                  {line}
                </div>
              ))}
              {phase !== 'idle' && phase !== 'done' && phase !== 'error' && (
                <div className="text-zinc-600 animate-pulse">{'▍'}</div>
              )}
            </div>
          </div>
        )}

        {/* Action buttons */}
        {phase === 'idle' && (
          <div>
            <button
              onClick={handleStart}
              className="w-full py-4 rounded-xl font-semibold text-base bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 text-white shadow-lg shadow-blue-500/20 hover:shadow-blue-500/30 transition-all cursor-pointer active:scale-[0.98]"
            >
              {'🚀'} Запустить автонастройку
            </button>
            <button
              onClick={onComplete}
              className="w-full mt-3 py-2.5 text-sm text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
            >
              Пропустить (если всё уже настроено)
            </button>
          </div>
        )}

        {phase === 'done' && (
          <button
            onClick={onComplete}
            className="w-full py-4 rounded-xl font-semibold text-base bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 text-white shadow-lg shadow-emerald-500/20 transition-all cursor-pointer active:scale-[0.98]"
          >
            {'✨'} Начать работу
          </button>
        )}

        {phase === 'error' && (
          <div className="flex gap-3">
            <button
              onClick={handleStart}
              className="flex-1 py-3 rounded-xl font-semibold text-sm bg-blue-600 hover:bg-blue-500 text-white transition-colors cursor-pointer"
            >
              {'🔄'} Попробовать снова
            </button>
            <button
              onClick={onComplete}
              className="flex-1 py-3 rounded-xl font-semibold text-sm bg-zinc-800 border border-zinc-700 hover:border-zinc-500 text-zinc-300 transition-colors cursor-pointer"
            >
              Пропустить
            </button>
          </div>
        )}

        {['installing', 'downloading', 'starting'].includes(phase) && (
          <div className="text-center text-xs text-zinc-600 mt-4">
            Не закрывай окно. {elapsedStr && `Прошло: ${elapsedStr}`}
          </div>
        )}
      </div>
    </div>
  )
}
