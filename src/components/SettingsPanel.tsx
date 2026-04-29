import { useState, useEffect, useRef } from 'react'
import type { ModelVariantInfo, ToolInfo, SystemResources, GpuMode, ModelFamily, WebSearchStatus, LlamaReleaseInfo } from '../../electron/types'
import type { AppConfig, CustomTool, McpServerConfig, WebSearchProvider } from '../../electron/config'
import type { McpServerStatus } from '../../electron/mcp'

interface Props {
  open: boolean
  onClose: () => void
  initialTab?: string
  appLanguage?: 'ru' | 'en'
}

type Tab = 'model' | 'agent' | 'tools' | 'mcp' | 'prompts' | 'web-search'

function tr(ru: string, en: string, lang: 'ru' | 'en'): string {
  return lang === 'ru' ? ru : en
}

const CTX_OPTIONS = [
  { value: 262144, label: '262K' },
  { value: 131072, label: '131K' },
  { value: 65536,  label: '65K' },
  { value: 32768,  label: '32K' },
  { value: 24576,  label: '24K' },
  { value: 16384,  label: '16K' },
  { value: 12288,  label: '12K' },
  { value: 8192,   label: '8K' },
  { value: 4096,   label: '4K' },
]

const BITS_COLOR: Record<number, string> = {
  2: 'text-red-400',
  3: 'text-orange-400',
  4: 'text-yellow-300',
  5: 'text-lime-400',
  6: 'text-emerald-400',
  8: 'text-cyan-400',
}

function formatSize(mb: number, lang: 'ru' | 'en' = 'ru'): string {
  return (mb / 1024).toFixed(1) + (lang === 'ru' ? ' ГБ' : ' GB')
}

function formatCtx(tokens: number): string {
  if (tokens >= 1024) return Math.round(tokens / 1024) + 'K'
  return String(tokens)
}

function pickQuantForVariants(variants: ModelVariantInfo[], preferredQuant: string): string {
  const preferred = variants.find((variant) => variant.quant === preferredQuant && variant.fits)
  if (preferred) return preferred.quant
  return variants.find((variant) => variant.recommended)?.quant
    ?? variants.find((variant) => variant.fits)?.quant
    ?? preferredQuant
}

export function SettingsPanel({ open, onClose, initialTab, appLanguage = 'ru' }: Props) {
  const L = appLanguage
  const t = (ru: string, en: string) => tr(ru, en, L)
  const [tab, setTab] = useState<Tab>('model')
  const [cfg, setCfg] = useState<AppConfig | null>(null)
  const [variants, setVariants] = useState<ModelVariantInfo[]>([])
  const [resources, setResources] = useState<SystemResources | null>(null)
  const [tools, setTools] = useState<ToolInfo[]>([])
  const [families, setFamilies] = useState<ModelFamily[]>([])
  const [selectedFamily, setSelectedFamily] = useState<string>('')
  const [selectedQuant, setSelectedQuant] = useState('')
  const [selectedCtx, setSelectedCtx] = useState<number>(32768)
  const [selectedGpuMode, setSelectedGpuMode] = useState<GpuMode>('single')
  const [selectedGpuIndex, setSelectedGpuIndex] = useState<number>(0)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [llamaInfo, setLlamaInfo] = useState<LlamaReleaseInfo | null>(null)
  const [llamaUpdating, setLlamaUpdating] = useState(false)
  const [llamaBuildStatus, setLlamaBuildStatus] = useState<string | null>(null)
  const [modelDownloadStatus, setModelDownloadStatus] = useState<string | null>(null)
  const [editingTool, setEditingTool] = useState<CustomTool | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  // Web search
  const [wsProvider, setWsProvider] = useState<WebSearchProvider>('disabled')
  const [wsCustomUrl, setWsCustomUrl] = useState('')
  const [wsStatus, setWsStatus] = useState<WebSearchStatus | null>(null)
  const [wsDirty, setWsDirty] = useState(false)
  const [wsApplying, setWsApplying] = useState(false)
  const [wsError, setWsError] = useState<string | null>(null)

  // Agent params state
  const [maxIterations, setMaxIterations] = useState(200)
  const [temperature, setTemperature] = useState(0.3)
  const [idleTimeoutSec, setIdleTimeoutSec] = useState(60)
  const [maxEmptyRetries, setMaxEmptyRetries] = useState(3)
  const [approvalForFileOps, setApprovalForFileOps] = useState(true)
  const [approvalForCommands, setApprovalForCommands] = useState(true)
  const [agentDirty, setAgentDirty] = useState(false)

  // Prompts state
  const [sysPrompt, setSysPrompt] = useState('')
  const [sumPrompt, setSumPrompt] = useState('')
  const [defaultSysPrompt, setDefaultSysPrompt] = useState('')
  const [defaultSumPrompt, setDefaultSumPrompt] = useState('')
  const [promptsDirty, setPromptsDirty] = useState(false)

  useEffect(() => {
    if (initialTab) {
      const mapped: Tab =
        initialTab === 'prompts' ? 'prompts'
        : initialTab === 'tools' ? 'tools'
        : initialTab === 'mcp' ? 'mcp'
        : initialTab === 'agent' ? 'agent'
        : initialTab === 'web-search' ? 'web-search'
        : 'model'
      setTab(mapped)
    }
  }, [initialTab, open])

  useEffect(() => {
    if (!open) return
    Promise.all([
      window.api.getConfig(),
      window.api.detectResources(),
      window.api.getTools(),
      window.api.getPrompts(),
      window.api.getModelFamilies?.() ?? Promise.resolve([] as ModelFamily[]),
      window.api.getWebSearchStatus?.() ?? Promise.resolve(null as WebSearchStatus | null),
      window.api.getLlamaReleaseInfo?.() ?? Promise.resolve(null as LlamaReleaseInfo | null),
    ]).then(async ([c, r, toolsList, p, fams, wsSt, llama]) => {
      const gpuMode = c.gpuMode ?? 'single'
      const gpuIndex = c.gpuIndex ?? r.gpus[0]?.index ?? 0
      const v = await window.api.getModelVariants({ gpuMode, gpuIndex })

      setCfg(c)
      setResources(r)
      setVariants(v)
      setTools(toolsList)
      setFamilies(fams ?? [])
      setLlamaInfo(llama)
      setLlamaBuildStatus(null)
      setModelDownloadStatus(null)
      setSelectedGpuMode(gpuMode)
      setSelectedGpuIndex(gpuIndex)
      const quant = pickQuantForVariants(v, c.lastQuant || 'UD-Q4_K_XL')
      setSelectedQuant(quant)
      const variantObj = v.find((vi: ModelVariantInfo) => vi.quant === quant)
      const max = variantObj?.maxCtx ?? 32768
      setSelectedCtx((c.ctxSize && c.ctxSize > 0) ? Math.min(c.ctxSize, max) : max)
      setSelectedFamily(variantObj?.family ?? (fams?.[0]?.id ?? ''))
      setDirty(false)

      setWsProvider((c.webSearchProvider as WebSearchProvider) ?? 'disabled')
      setWsCustomUrl(c.searxngBaseUrl ?? '')
      setWsStatus(wsSt)
      setWsDirty(false)
      setWsError(null)

      setMaxIterations(c.maxIterations ?? 200)
      setTemperature(c.temperature ?? 0.3)
      setIdleTimeoutSec(c.idleTimeoutSec ?? 60)
      setMaxEmptyRetries(c.maxEmptyRetries ?? 3)
      setApprovalForFileOps(c.approvalForFileOps ?? (c as any).approvalRequired ?? true)
      setApprovalForCommands(c.approvalForCommands ?? (c as any).approvalRequired ?? true)
      setAgentDirty(false)

      setSysPrompt(p.systemPrompt ?? p.defaultSystemPrompt)
      setSumPrompt(p.summarizePrompt ?? p.defaultSummarizePrompt)
      setDefaultSysPrompt(p.defaultSystemPrompt)
      setDefaultSumPrompt(p.defaultSummarizePrompt)
      setPromptsDirty(false)
    }).catch(() => {})
  }, [open])

  useEffect(() => {
    if (!open) return
    return window.api.onBuildStatus((status) => {
      setLlamaBuildStatus(status)
    })
  }, [open])

  useEffect(() => {
    if (!open) return
    return window.api.onDownloadProgress((progress) => {
      setModelDownloadStatus(progress.status)
    })
  }, [open])

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open || !cfg) return null

  const currentVariant = variants.find((v) => v.quant === selectedQuant)
  const maxCtx = currentVariant?.maxCtx ?? 262144
  const availableGpus = resources?.gpus ?? []
  const hasMultipleGpus = availableGpus.length > 1

  const refreshVariantsForGpu = async (
    gpuMode: GpuMode,
    gpuIndex: number,
    preferredQuant = selectedQuant,
    preferredCtx = selectedCtx,
  ) => {
    const nextVariants = await window.api.getModelVariants({ gpuMode, gpuIndex })
    setVariants(nextVariants)
    const nextQuant = pickQuantForVariants(nextVariants, preferredQuant)
    setSelectedQuant(nextQuant)
    const nextVariant = nextVariants.find((variant) => variant.quant === nextQuant)
    const nextMaxCtx = nextVariant?.maxCtx ?? 32768
    setSelectedCtx(Math.min(preferredCtx, nextMaxCtx))
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await window.api.saveConfig({
        lastQuant: selectedQuant,
        ctxSize: selectedCtx,
        gpuMode: selectedGpuMode,
        gpuIndex: selectedGpuIndex,
      })
      await window.api.selectModelVariant(selectedQuant)
      setDirty(false)
    } finally {
      setSaving(false)
    }
  }

  const handleApplyRestart = async () => {
    setSaving(true)
    try {
      await window.api.saveConfig({
        lastQuant: selectedQuant,
        ctxSize: selectedCtx,
        gpuMode: selectedGpuMode,
        gpuIndex: selectedGpuIndex,
      })
      await window.api.selectModelVariant(selectedQuant)
      setModelDownloadStatus(null)
      setLlamaBuildStatus(null)
      const result = await window.api.restartServer()
      setDirty(false)
      if (result?.actualCtx && result.actualCtx < selectedCtx) {
        alert(
          L === 'ru'
            ? `Сервер запущен, но контекст уменьшен: ${Math.round(result.actualCtx / 1024)}K вместо ${Math.round(selectedCtx / 1024)}K (не хватает памяти)`
            : `Server started, but context reduced: ${Math.round(result.actualCtx / 1024)}K instead of ${Math.round(selectedCtx / 1024)}K (not enough memory)`,
        )
      }
      onClose()
    } catch (e: any) {
      alert((L === 'ru' ? 'Ошибка: ' : 'Error: ') + (e.message ?? e))
    } finally {
      setSaving(false)
    }
  }

  const refreshLlamaInfo = async () => {
    const info = await window.api.getLlamaReleaseInfo()
    setLlamaInfo(info)
    return info
  }

  const handleUpdateLlama = async () => {
    setLlamaUpdating(true)
    setLlamaBuildStatus(null)
    try {
      const info = await window.api.updateLlama()
      setLlamaInfo(info)
    } catch (e: any) {
      alert((L === 'ru' ? 'Ошибка обновления llama.cpp: ' : 'llama.cpp update error: ') + (e?.message ?? e))
      await refreshLlamaInfo().catch(() => null)
    } finally {
      setLlamaUpdating(false)
    }
  }

  const handleDeleteCustomTool = async (toolId: string) => {
    await window.api.deleteCustomTool(toolId)
    const updated = await window.api.getTools()
    setTools(updated)
  }

  const handleSaveCustomTool = async (tool: CustomTool) => {
    await window.api.saveCustomTool(tool)
    const updated = await window.api.getTools()
    setTools(updated)
    setEditingTool(null)
  }

  const handleSavePrompts = async () => {
    setSaving(true)
    try {
      const sysVal = sysPrompt === defaultSysPrompt ? null : sysPrompt
      const sumVal = sumPrompt === defaultSumPrompt ? null : sumPrompt
      await window.api.savePrompts({ systemPrompt: sysVal, summarizePrompt: sumVal })
      setPromptsDirty(false)
    } finally {
      setSaving(false)
    }
  }

  const handleResetPrompts = async () => {
    setSysPrompt(defaultSysPrompt)
    setSumPrompt(defaultSumPrompt)
    await window.api.savePrompts({ systemPrompt: null, summarizePrompt: null })
    setPromptsDirty(false)
  }

  const handleResetAllDefaults = async () => {
    setSaving(true)
    try {
      await window.api.resetAllDefaults()
      const [c, r, toolsList, p] = await Promise.all([
        window.api.getConfig(),
        window.api.detectResources(),
        window.api.getTools(),
        window.api.getPrompts(),
      ])
      const gpuMode = c.gpuMode ?? 'single'
      const gpuIndex = c.gpuIndex ?? r.gpus[0]?.index ?? 0
      const v = await window.api.getModelVariants({ gpuMode, gpuIndex })
      setCfg(c)
      setResources(r)
      setVariants(v)
      setTools(toolsList)
      setSelectedGpuMode(gpuMode)
      setSelectedGpuIndex(gpuIndex)
      const quant = pickQuantForVariants(v, c.lastQuant || 'UD-Q4_K_XL')
      setSelectedQuant(quant)
      const variant = v.find((entry) => entry.quant === quant)
      setSelectedCtx(Math.min(32768, variant?.maxCtx ?? 32768))
      setSysPrompt(p.defaultSystemPrompt)
      setSumPrompt(p.defaultSummarizePrompt)
      setDefaultSysPrompt(p.defaultSystemPrompt)
      setDefaultSumPrompt(p.defaultSummarizePrompt)
      setDirty(false)
      setPromptsDirty(false)
    } finally {
      setSaving(false)
    }
  }

  const handleApplyWebSearch = async () => {
    setWsApplying(true)
    setWsError(null)
    try {
      const payload: Partial<AppConfig> = { webSearchProvider: wsProvider }
      if (wsProvider === 'custom-searxng') payload.searxngBaseUrl = wsCustomUrl.trim() || null
      else payload.searxngBaseUrl = null
      await window.api.saveConfig(payload)
      const res = await window.api.ensureWebSearch?.()
      setWsStatus(res ?? null)
      if (res && !res.healthy && res.detail) setWsError(res.detail)
      setWsDirty(false)
    } catch (e: any) {
      setWsError(e?.message ?? String(e))
    } finally {
      setWsApplying(false)
    }
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: 'model', label: t('Модель', 'Model') },
    { key: 'agent', label: t('Агент', 'Agent') },
    { key: 'tools', label: t('Инструменты', 'Tools') },
    { key: 'mcp', label: t('MCP', 'MCP') },
    { key: 'web-search', label: t('Веб‑поиск', 'Web search') },
    { key: 'prompts', label: t('Промпты', 'Prompts') },
  ]

  return (
    <div className="fixed inset-0 z-[200] flex">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div
        ref={panelRef}
        className="relative ml-auto w-full max-w-xl h-full bg-zinc-950 border-l border-zinc-800 flex flex-col shadow-2xl animate-in slide-in-from-right"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800 shrink-0">
          <h2 className="text-base font-semibold text-zinc-100">{t('Настройки', 'Settings')}</h2>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100 cursor-pointer transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-0 border-b border-zinc-800 shrink-0">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-4 py-2.5 text-sm font-medium transition-colors cursor-pointer ${
                tab === t.key
                  ? 'text-blue-400 border-b-2 border-blue-400'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5">
          {tab === 'model' && (
            <ModelTab
              variants={variants}
              availableGpus={availableGpus}
              hasMultipleGpus={hasMultipleGpus}
              families={families}
              selectedFamily={selectedFamily}
              selectedQuant={selectedQuant}
              selectedCtx={selectedCtx}
              selectedGpuMode={selectedGpuMode}
              selectedGpuIndex={selectedGpuIndex}
              maxCtx={maxCtx}
              appLanguage={L}
              onFamilyChange={(fam) => {
                setSelectedFamily(fam)
                const first = variants.find((v) => v.family === fam && v.fits) ?? variants.find((v) => v.family === fam)
                if (first) {
                  setSelectedQuant(first.quant)
                  const max = first.maxCtx ?? 32768
                  setSelectedCtx((prev) => Math.min(prev, max))
                }
                setDirty(true)
              }}
              onQuantChange={(q) => { setSelectedQuant(q); setDirty(true) }}
              onCtxChange={(c: number) => { setSelectedCtx(c); setDirty(true) }}
              onGpuModeChange={async (gpuMode) => {
                const nextGpuIndex = availableGpus.some((gpu) => gpu.index === selectedGpuIndex)
                  ? selectedGpuIndex
                  : (availableGpus[0]?.index ?? 0)
                setSelectedGpuMode(gpuMode)
                setSelectedGpuIndex(nextGpuIndex)
                await refreshVariantsForGpu(gpuMode, nextGpuIndex)
                setDirty(true)
              }}
              onGpuIndexChange={async (gpuIndex) => {
                setSelectedGpuIndex(gpuIndex)
                await refreshVariantsForGpu(selectedGpuMode, gpuIndex)
                setDirty(true)
              }}
              llamaInfo={llamaInfo}
              llamaBuildStatus={llamaBuildStatus}
              llamaUpdating={llamaUpdating}
              onRefreshLlama={refreshLlamaInfo}
              onUpdateLlama={handleUpdateLlama}
            />
          )}
          {tab === 'web-search' && (
            <WebSearchTab
              provider={wsProvider}
              customUrl={wsCustomUrl}
              status={wsStatus}
              error={wsError}
              applying={wsApplying}
              dirty={wsDirty}
              appLanguage={L}
              onProviderChange={(p) => { setWsProvider(p); setWsDirty(true); setWsError(null) }}
              onCustomUrlChange={(u) => { setWsCustomUrl(u); setWsDirty(true); setWsError(null) }}
              onApply={handleApplyWebSearch}
              onRefresh={async () => {
                const s = await window.api.getWebSearchStatus?.()
                setWsStatus(s ?? null)
              }}
            />
          )}
          {tab === 'agent' && (
            <AgentTab
              maxIterations={maxIterations}
              temperature={temperature}
              idleTimeoutSec={idleTimeoutSec}
              maxEmptyRetries={maxEmptyRetries}
              approvalForFileOps={approvalForFileOps}
              approvalForCommands={approvalForCommands}
              appLanguage={L}
              onChange={(field, value) => {
                if (field === 'maxIterations') setMaxIterations(value as number)
                else if (field === 'temperature') setTemperature(value as number)
                else if (field === 'idleTimeoutSec') setIdleTimeoutSec(value as number)
                else if (field === 'maxEmptyRetries') setMaxEmptyRetries(value as number)
                else if (field === 'approvalForFileOps') setApprovalForFileOps(value as boolean)
                else if (field === 'approvalForCommands') setApprovalForCommands(value as boolean)
                setAgentDirty(true)
              }}
            />
          )}
          {tab === 'tools' && (
            <ToolsTab
              tools={tools}
              editingTool={editingTool}
              appLanguage={L}
              onEdit={setEditingTool}
              onSave={handleSaveCustomTool}
              onDelete={handleDeleteCustomTool}
              onCancelEdit={() => setEditingTool(null)}
            />
          )}
          {tab === 'mcp' && <McpTab appLanguage={L} />}
          {tab === 'prompts' && (
            <PromptsTab
              sysPrompt={sysPrompt}
              sumPrompt={sumPrompt}
              defaultSysPrompt={defaultSysPrompt}
              defaultSumPrompt={defaultSumPrompt}
              appLanguage={L}
              onSysChange={(v) => { setSysPrompt(v); setPromptsDirty(true) }}
              onSumChange={(v) => { setSumPrompt(v); setPromptsDirty(true) }}
              onResetSys={() => { setSysPrompt(defaultSysPrompt); setPromptsDirty(true) }}
              onResetSum={() => { setSumPrompt(defaultSumPrompt); setPromptsDirty(true) }}
            />
          )}
        </div>

        {/* Footer */}
        {tab === 'model' && dirty && (
          <div className="border-t border-zinc-800 px-5 py-3 flex items-center gap-3 shrink-0">
            <div className="min-w-0 flex-1">
              <div className="text-xs text-zinc-500">
                {saving
                  ? t('Сервер перезапускается, модель загружается…', 'Server is restarting, model is loading…')
                  : t('Сервер будет перезапущен с новыми настройками', 'Server will restart with new settings')}
              </div>
              {saving && (modelDownloadStatus || llamaBuildStatus) && (
                <div className="mt-1 truncate font-mono text-[11px] text-zinc-400" title={modelDownloadStatus ?? llamaBuildStatus ?? undefined}>
                  {modelDownloadStatus ?? llamaBuildStatus}
                </div>
              )}
            </div>
            <button
              onClick={handleApplyRestart}
              disabled={saving}
              className="px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-500 cursor-pointer transition-colors disabled:opacity-50"
            >
              {saving ? t('Перезапуск…', 'Restarting…') : t('Применить и перезапустить', 'Apply and restart')}
            </button>
          </div>
        )}

        {tab === 'agent' && agentDirty && (
          <div className="border-t border-zinc-800 px-5 py-3 flex items-center gap-3 shrink-0">
            <span className="text-xs text-zinc-500 flex-1">
              {t('Изменения применяются сразу к следующему сообщению', 'Changes apply to the next message')}
            </span>
            <button
              onClick={async () => {
                await window.api.saveConfig({ maxIterations, temperature, idleTimeoutSec, maxEmptyRetries, approvalForFileOps, approvalForCommands })
                setAgentDirty(false)
              }}
              className="px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-500 cursor-pointer transition-colors"
            >
              {t('Сохранить', 'Save')}
            </button>
          </div>
        )}

        {tab === 'prompts' && promptsDirty && (
          <div className="border-t border-zinc-800 px-5 py-3 flex items-center gap-3 shrink-0">
            <span className="text-xs text-zinc-500 flex-1">
              {t('Промпты применяются к новым сообщениям', 'Prompts apply to new messages')}
            </span>
            <button
              onClick={handleResetPrompts}
              disabled={saving}
              className="px-4 py-2 text-sm rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 cursor-pointer transition-colors disabled:opacity-50"
            >
              {t('Сбросить оба', 'Reset both')}
            </button>
            <button
              onClick={handleSavePrompts}
              disabled={saving}
              className="px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-500 cursor-pointer transition-colors disabled:opacity-50"
            >
              {saving ? t('Сохранение…', 'Saving…') : t('Сохранить промпты', 'Save prompts')}
            </button>
          </div>
        )}

        {/* Global reset */}
        <div className="border-t border-zinc-800 px-5 py-2 shrink-0">
          <button
            onClick={handleResetAllDefaults}
            disabled={saving}
            className="text-[11px] text-zinc-600 hover:text-red-400 cursor-pointer transition-colors disabled:opacity-50"
          >
            {t('Сбросить все настройки по умолчанию', 'Reset all settings to defaults')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Model & Context tab
// ---------------------------------------------------------------------------

function ModelTab({
  variants, families, selectedFamily, availableGpus, hasMultipleGpus,
  selectedQuant, selectedCtx, selectedGpuMode, selectedGpuIndex, maxCtx, appLanguage,
  onFamilyChange, onQuantChange, onCtxChange, onGpuModeChange, onGpuIndexChange,
  llamaInfo, llamaBuildStatus, llamaUpdating, onRefreshLlama, onUpdateLlama,
}: {
  variants: ModelVariantInfo[]
  families: ModelFamily[]
  selectedFamily: string
  availableGpus: SystemResources['gpus']
  hasMultipleGpus: boolean
  selectedQuant: string
  selectedCtx: number
  selectedGpuMode: GpuMode
  selectedGpuIndex: number
  maxCtx: number
  appLanguage: 'ru' | 'en'
  onFamilyChange: (famId: string) => void
  onQuantChange: (q: string) => void
  onCtxChange: (c: number) => void
  onGpuModeChange: (mode: GpuMode) => void | Promise<void>
  onGpuIndexChange: (index: number) => void | Promise<void>
  llamaInfo: LlamaReleaseInfo | null
  llamaBuildStatus: string | null
  llamaUpdating: boolean
  onRefreshLlama: () => void | Promise<unknown>
  onUpdateLlama: () => void | Promise<void>
}) {
  const L = appLanguage
  const t = (ru: string, en: string) => tr(ru, en, L)
  const familyVariants = selectedFamily ? variants.filter((v) => v.family === selectedFamily) : variants
  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-zinc-200">llama.cpp</div>
            <div className="mt-1 text-[11px] text-zinc-500">
              {llamaInfo?.installed
                ? t('Локальный сервер установлен', 'Local server installed')
                : t('Локальный сервер ещё не установлен', 'Local server is not installed yet')}
            </div>
          </div>
          {llamaInfo?.updateAvailable ? (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-300">
              {t('доступно обновление', 'update available')}
            </span>
          ) : llamaInfo?.latestTag && llamaInfo?.installedTag && llamaInfo.latestTag === llamaInfo.installedTag ? (
            <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-300">
              {t('актуально', 'up to date')}
            </span>
          ) : null}
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
          <div className="rounded-lg bg-zinc-950/40 px-2.5 py-2">
            <div className="text-zinc-600">{t('Установлено', 'Installed')}</div>
            <div className="mt-0.5 font-mono text-zinc-300">
              {llamaInfo?.installedTag ?? (llamaInfo?.installed ? t('неизвестно', 'unknown') : '—')}
            </div>
          </div>
          <div className="rounded-lg bg-zinc-950/40 px-2.5 py-2">
            <div className="text-zinc-600">{t('Последний релиз', 'Latest release')}</div>
            <div className="mt-0.5 font-mono text-zinc-300">
              {llamaInfo?.latestTag ?? (llamaInfo?.error ? t('ошибка проверки', 'check failed') : '…')}
            </div>
          </div>
          <div className="col-span-2 rounded-lg bg-zinc-950/40 px-2.5 py-2">
            <div className="text-zinc-600">{t('Бинарь', 'Binary')}</div>
            <div className="mt-0.5 truncate font-mono text-zinc-400" title={llamaInfo?.binaryPath ?? ''}>
              {llamaInfo?.installedVariant ?? '—'}{llamaInfo?.binaryPath ? ` · ${llamaInfo.binaryPath}` : ''}
            </div>
          </div>
        </div>

        {llamaInfo?.error && (
          <div className="mt-2 text-[11px] text-red-300/80">
            {t('Не удалось проверить обновления:', 'Could not check updates:')} {llamaInfo.error}
          </div>
        )}

        {llamaBuildStatus && (
          <div className="mt-2 rounded-lg border border-zinc-800 bg-zinc-950/50 px-2.5 py-2 font-mono text-[11px] text-zinc-400">
            {llamaBuildStatus}
          </div>
        )}

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            onClick={onRefreshLlama}
            disabled={llamaUpdating}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('Проверить обновления', 'Check updates')}
          </button>
          <button
            onClick={onUpdateLlama}
            disabled={llamaUpdating || !llamaInfo?.latestTag}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
            title={t('Скачает последний релиз и заменит старую версию llama.cpp', 'Download the latest release and replace the old llama.cpp')}
          >
            {llamaUpdating
              ? t('Обновление…', 'Updating…')
              : llamaInfo?.installed
                ? t('Обновить llama.cpp', 'Update llama.cpp')
                : t('Установить llama.cpp', 'Install llama.cpp')}
          </button>
        </div>

        <p className="mt-2 text-[11px] leading-snug text-zinc-600">
          {t(
            'При обновлении текущий llama-server будет остановлен. Новый бинарь скачивается во временную папку и заменяет старый только после успешной проверки.',
            'Updating stops the current llama-server. The new binary is downloaded into a temporary folder and replaces the old one only after verification.',
          )}
        </p>
      </div>

      {hasMultipleGpus && (
        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-3">{t('Режим GPU', 'GPU mode')}</label>
          <div className="flex gap-2 mb-3">
            <button
              onClick={() => onGpuModeChange('single')}
              className={`px-3 py-2 text-sm rounded-lg border transition-colors cursor-pointer ${
                selectedGpuMode === 'single'
                  ? 'border-blue-500/50 bg-blue-500/10 text-blue-400'
                  : 'border-zinc-700 text-zinc-400 hover:border-zinc-500'
              }`}
            >
              {t('Одна GPU', 'Single GPU')}
            </button>
            <button
              onClick={() => onGpuModeChange('split')}
              className={`px-3 py-2 text-sm rounded-lg border transition-colors cursor-pointer ${
                selectedGpuMode === 'split'
                  ? 'border-amber-500/50 bg-amber-500/10 text-amber-400'
                  : 'border-zinc-700 text-zinc-400 hover:border-zinc-500'
              }`}
            >
              {t('Все GPU (экспериментально)', 'All GPUs (experimental)')}
            </button>
          </div>
          <p className="text-xs text-zinc-500 mb-3">
            {t(
              'Для систем с несколькими видеокартами безопаснее запускать `llama.cpp` на одной карте. Multi-GPU может быть нестабилен и приводить к случайным падениям драйвера.',
              'On multi-GPU systems it is safer to run `llama.cpp` on a single card. Multi-GPU can be unstable and cause random driver crashes.',
            )}
          </p>
          {selectedGpuMode === 'single' && (
            <div className="space-y-2 rounded-xl border border-zinc-800 p-2">
              {availableGpus.map((gpu) => (
                <button
                  key={gpu.index}
                  onClick={() => onGpuIndexChange(gpu.index)}
                  className={`w-full text-left px-3 py-2.5 rounded-lg border transition-colors cursor-pointer ${
                    selectedGpuIndex === gpu.index
                      ? 'border-blue-500/30 bg-blue-500/10'
                      : 'border-transparent hover:bg-zinc-800/80'
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm text-zinc-200">GPU {gpu.index}: {gpu.name}</span>
                    {selectedGpuIndex === gpu.index && <span className="text-blue-400 text-sm">✓</span>}
                  </div>
                  <div className="text-[11px] text-zinc-500 mt-1">
                    {t('Свободно', 'Free')} {formatSize(gpu.vramFreeMb, L)} {t('из', 'of')} {formatSize(gpu.vramTotalMb, L)}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Family selection */}
      {families.length > 0 && (
        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-3">{t('Семейство моделей', 'Model family')}</label>
          <div className="flex flex-wrap gap-2">
            {families.map((fam) => (
              <button
                key={fam.id}
                onClick={() => onFamilyChange(fam.id)}
                className={`px-3 py-2 text-sm rounded-lg border transition-colors cursor-pointer ${
                  selectedFamily === fam.id
                    ? 'border-blue-500/50 bg-blue-500/10 text-blue-400'
                    : 'border-zinc-700 text-zinc-400 hover:border-zinc-500'
                }`}
                title={fam.description}
              >
                {fam.label}
              </button>
            ))}
          </div>
          {families.find((f) => f.id === selectedFamily)?.description && (
            <p className="text-[11px] text-zinc-500 mt-2">
              {families.find((f) => f.id === selectedFamily)!.description}
            </p>
          )}
        </div>
      )}

      {/* Quant selection */}
      <div>
        <label className="block text-sm font-medium text-zinc-300 mb-3">{t('Квантизация модели', 'Model quantization')}</label>
        <div className="space-y-1 max-h-[360px] overflow-y-auto rounded-xl border border-zinc-800 p-1">
          {familyVariants.map((v) => {
            const isSel = v.quant === selectedQuant
            const colorClass = BITS_COLOR[v.bits] ?? 'text-zinc-400'
            const displayQuant = v.quant.replace(/^9B-/, '').replace(/^27B-/, '').replace(/^36-/, '').replace('UD-', '')
            return (
              <button
                key={v.quant}
                disabled={!v.fits}
                onClick={() => onQuantChange(v.quant)}
                className={`w-full text-left px-3 py-2.5 rounded-lg flex items-center gap-3 transition-colors cursor-pointer ${
                  !v.fits
                    ? 'opacity-30 cursor-not-allowed'
                    : isSel
                      ? 'bg-blue-500/15 border border-blue-500/30'
                      : 'hover:bg-zinc-800/80 border border-transparent'
                }`}
              >
                <div className={`w-7 text-center text-xs font-bold ${colorClass}`}>
                  {v.bits}b
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`text-sm font-medium ${v.fits ? 'text-zinc-200' : 'text-zinc-600'}`}>
                      {displayQuant}
                    </span>
                    {v.recommended && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400 font-medium">
                        {t('рек.', 'rec.')}
                      </span>
                    )}
                  </div>
                  <div className={`text-[11px] mt-0.5 ${v.fits ? 'text-zinc-500' : 'text-zinc-700'}`}>
                    {formatSize(v.sizeMb, L)}
                    {v.fits && <> · {t('макс. ctx', 'max ctx')} {formatCtx(v.maxCtx)} · {v.mode === 'full_gpu' ? 'GPU' : v.mode === 'hybrid' ? 'GPU+CPU' : 'CPU'}</>}
                    {!v.fits && (L === 'ru' ? ' · не хватает памяти' : ' · out of memory')}
                  </div>
                </div>
                {isSel && <span className="text-blue-400 shrink-0 text-sm">✓</span>}
              </button>
            )
          })}
        </div>
      </div>

      {/* Context size */}
      <div>
        <label className="block text-sm font-medium text-zinc-300 mb-2">{t('Размер контекста', 'Context size')}</label>
        <p className="text-xs text-zinc-500 mb-3">
          {t('Максимум для текущей квантизации:', 'Max for the current quantization:')} {formatCtx(maxCtx)}
        </p>
        <div className="flex flex-wrap gap-2">
          {CTX_OPTIONS.filter((o) => o.value <= maxCtx).map((opt) => (
            <button
              key={opt.value}
              onClick={() => onCtxChange(opt.value)}
              className={`px-3 py-1.5 text-sm rounded-lg border transition-colors cursor-pointer ${
                selectedCtx === opt.value
                  ? 'border-blue-500/50 bg-blue-500/10 text-blue-400'
                  : 'border-zinc-700 text-zinc-400 hover:border-zinc-500'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Agent tab
// ---------------------------------------------------------------------------

function AgentTab({
  maxIterations, temperature, idleTimeoutSec, maxEmptyRetries, approvalForFileOps, approvalForCommands, appLanguage, onChange,
}: {
  maxIterations: number
  temperature: number
  idleTimeoutSec: number
  maxEmptyRetries: number
  approvalForFileOps: boolean
  approvalForCommands: boolean
  appLanguage: 'ru' | 'en'
  onChange: (field: string, value: number | boolean) => void
}) {
  const L = appLanguage
  const t = (ru: string, en: string) => tr(ru, en, L)
  return (
    <div className="space-y-5">
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-sm text-zinc-300">{t('Макс. итераций агента', 'Max agent iterations')}</label>
          <span className="text-sm font-mono text-zinc-400">{maxIterations}</span>
        </div>
        <input
          type="range" min={10} max={500} step={10} value={maxIterations}
          onChange={(e) => onChange('maxIterations', parseInt(e.target.value))}
          className="w-full accent-blue-500"
        />
        <div className="flex justify-between text-[10px] text-zinc-600 mt-0.5">
          <span>10</span><span>{t('Сколько шагов агент может сделать за один запрос', 'How many steps the agent can take per request')}</span><span>500</span>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-sm text-zinc-300">{t('Температура', 'Temperature')}</label>
          <span className="text-sm font-mono text-zinc-400">{temperature.toFixed(2)}</span>
        </div>
        <input
          type="range" min={0} max={1.5} step={0.05} value={temperature}
          onChange={(e) => onChange('temperature', parseFloat(e.target.value))}
          className="w-full accent-blue-500"
        />
        <div className="flex justify-between text-[10px] text-zinc-600 mt-0.5">
          <span>{t('0 (точно)', '0 (precise)')}</span><span>{t('Креативность модели', 'Model creativity')}</span><span>{t('1.5 (хаотично)', '1.5 (chaotic)')}</span>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-sm text-zinc-300">{t('Таймаут бездействия (сек)', 'Idle timeout (sec)')}</label>
          <span className="text-sm font-mono text-zinc-400">{idleTimeoutSec}{L === 'ru' ? 'с' : 's'}</span>
        </div>
        <input
          type="range" min={15} max={300} step={5} value={idleTimeoutSec}
          onChange={(e) => onChange('idleTimeoutSec', parseInt(e.target.value))}
          className="w-full accent-blue-500"
        />
        <div className="flex justify-between text-[10px] text-zinc-600 mt-0.5">
          <span>{L === 'ru' ? '15с' : '15s'}</span><span>{t('Сколько ждать ответа модели без данных', 'How long to wait for model response without data')}</span><span>{L === 'ru' ? '300с' : '300s'}</span>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-sm text-zinc-300">{t('Ретраи при пустом ответе', 'Retries on empty response')}</label>
          <span className="text-sm font-mono text-zinc-400">{maxEmptyRetries}</span>
        </div>
        <input
          type="range" min={1} max={10} step={1} value={maxEmptyRetries}
          onChange={(e) => onChange('maxEmptyRetries', parseInt(e.target.value))}
          className="w-full accent-blue-500"
        />
        <div className="flex justify-between text-[10px] text-zinc-600 mt-0.5">
          <span>1</span><span>{t('Сколько раз повторять при пустом ответе', 'How many times to retry on empty response')}</span><span>10</span>
        </div>
      </div>

      <div className="flex items-center justify-between py-2 border-t border-zinc-800">
        <div>
          <div className="text-sm text-zinc-300">{t('Подтверждение записи и создания файлов', 'Confirm file writes and creation')}</div>
          <div className="text-[11px] text-zinc-600 mt-0.5">{t('Спрашивать разрешение на write_file, edit_file, append_file, delete_file, create_directory', 'Ask permission for write_file, edit_file, append_file, delete_file, create_directory')}</div>
        </div>
        <button
          onClick={() => onChange('approvalForFileOps', !approvalForFileOps)}
          className={`w-11 h-6 rounded-full transition-colors relative cursor-pointer ${approvalForFileOps ? 'bg-blue-600' : 'bg-zinc-700'}`}
        >
          <div className={`w-4.5 h-4.5 rounded-full bg-white absolute top-[3px] transition-transform ${approvalForFileOps ? 'translate-x-[22px]' : 'translate-x-[3px]'}`} />
        </button>
      </div>

      <div className="flex items-center justify-between py-2 border-t border-zinc-800">
        <div>
          <div className="text-sm text-zinc-300">{t('Подтверждение выполнения команд', 'Confirm command execution')}</div>
          <div className="text-[11px] text-zinc-600 mt-0.5">{t('Спрашивать разрешение на execute_command (терминал, сборка, тесты и т.д.)', 'Ask permission for execute_command (terminal, build, tests, etc.)')}</div>
        </div>
        <button
          onClick={() => onChange('approvalForCommands', !approvalForCommands)}
          className={`w-11 h-6 rounded-full transition-colors relative cursor-pointer ${approvalForCommands ? 'bg-blue-600' : 'bg-zinc-700'}`}
        >
          <div className={`w-4.5 h-4.5 rounded-full bg-white absolute top-[3px] transition-transform ${approvalForCommands ? 'translate-x-[22px]' : 'translate-x-[3px]'}`} />
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tools tab
// ---------------------------------------------------------------------------

function ToolsTab({
  tools, editingTool, appLanguage,
  onEdit, onSave, onDelete, onCancelEdit,
}: {
  tools: ToolInfo[]
  editingTool: CustomTool | null
  appLanguage: 'ru' | 'en'
  onEdit: (tool: CustomTool | null) => void
  onSave: (tool: CustomTool) => void
  onDelete: (id: string) => void
  onCancelEdit: () => void
}) {
  const L = appLanguage
  const t = (ru: string, en: string) => tr(ru, en, L)
  const builtins = tools.filter((item) => item.builtin)
  const custom = tools.filter((item) => !item.builtin)

  const newTool = (): CustomTool => ({
    id: `ct-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
    name: '',
    description: '',
    command: '',
    parameters: [],
    enabled: true,
  })

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium text-zinc-300 mb-2">{t('Встроенные инструменты', 'Built-in tools')}</h3>
        <div className="space-y-1">
          {builtins.map((item) => (
            <div key={item.name} className="px-3 py-2 rounded-lg bg-zinc-900/50 border border-zinc-800/50">
              <div className="flex items-center gap-2">
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500 font-mono">{item.name}</span>
              </div>
              <p className="text-xs text-zinc-500 mt-1 line-clamp-2">{item.description}</p>
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium text-zinc-300">{t('Пользовательские инструменты', 'Custom tools')}</h3>
          <button
            onClick={() => onEdit(newTool())}
            className="text-xs px-2.5 py-1 rounded-lg bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 cursor-pointer transition-colors"
          >
            {t('+ Добавить', '+ Add')}
          </button>
        </div>

        {custom.length === 0 && !editingTool && (
          <p className="text-xs text-zinc-600 py-4 text-center">
            {t('Нет пользовательских инструментов. Добавьте свой первый инструмент — агент сможет его вызывать.', 'No custom tools yet. Add your first tool — the agent will be able to call it.')}
          </p>
        )}

        {custom.map((item) => (
          <div key={item.id} className="px-3 py-2.5 rounded-lg border border-zinc-800 mb-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 font-mono">{item.name}</span>
                {!item.enabled && <span className="text-[10px] text-zinc-600">{t('отключён', 'disabled')}</span>}
              </div>
              <div className="flex gap-1">
                <button
                  onClick={() => onEdit({ id: item.id!, name: item.name, description: item.description, command: item.command!, parameters: item.parameters!, enabled: item.enabled })}
                  className="text-[10px] px-2 py-0.5 rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 cursor-pointer"
                >
                  {t('ред.', 'edit')}
                </button>
                <button
                  onClick={() => onDelete(item.id!)}
                  className="text-[10px] px-2 py-0.5 rounded text-red-500/60 hover:text-red-400 hover:bg-red-500/10 cursor-pointer"
                >
                  {t('удал.', 'del')}
                </button>
              </div>
            </div>
            <p className="text-xs text-zinc-500 mt-1">{item.description}</p>
            {item.command && <p className="text-[10px] text-zinc-600 mt-1 font-mono">{item.command}</p>}
          </div>
        ))}

        {editingTool && (
          <ToolEditor tool={editingTool} appLanguage={L} onSave={onSave} onCancel={onCancelEdit} />
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tool editor form
// ---------------------------------------------------------------------------

function ToolEditor({
  tool, appLanguage, onSave, onCancel,
}: {
  tool: CustomTool
  appLanguage: 'ru' | 'en'
  onSave: (tool: CustomTool) => void
  onCancel: () => void
}) {
  const L = appLanguage
  const t = (ru: string, en: string) => tr(ru, en, L)
  const [name, setName] = useState(tool.name)
  const [desc, setDesc] = useState(tool.description)
  const [cmd, setCmd] = useState(tool.command)
  const [params, setParams] = useState(tool.parameters)
  const [enabled, setEnabled] = useState(tool.enabled)

  const addParam = () => {
    setParams([...params, { name: '', description: '', required: false }])
  }

  const updateParam = (idx: number, field: string, value: any) => {
    const updated = [...params]
    ;(updated[idx] as any)[field] = value
    setParams(updated)
  }

  const removeParam = (idx: number) => {
    setParams(params.filter((_, i) => i !== idx))
  }

  const isValid = name.trim() && desc.trim() && cmd.trim() && /^[a-z_][a-z0-9_]*$/.test(name.trim())

  return (
    <div className="border border-blue-500/30 rounded-xl p-4 bg-blue-500/5 space-y-3 mt-3">
      <div>
        <label className="block text-xs text-zinc-400 mb-1">{t('Имя функции (snake_case)', 'Function name (snake_case)')}</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="run_tests"
          className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:border-blue-500 outline-none"
        />
      </div>
      <div>
        <label className="block text-xs text-zinc-400 mb-1">{t('Описание (для агента)', 'Description (for the agent)')}</label>
        <input
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder="Run the project test suite"
          className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:border-blue-500 outline-none"
        />
      </div>
      <div>
        <label className="block text-xs text-zinc-400 mb-1">
          {t('Команда', 'Command')} <span className="text-zinc-600">({t('используйте {{param}} для подстановки параметров', 'use {{param}} to substitute parameters')})</span>
        </label>
        <input
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          placeholder="npm test -- {{filter}}"
          className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-zinc-200 font-mono focus:border-blue-500 outline-none"
        />
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs text-zinc-400">{t('Параметры', 'Parameters')}</label>
          <button onClick={addParam} className="text-[10px] text-blue-400 hover:text-blue-300 cursor-pointer">
            {t('+ параметр', '+ parameter')}
          </button>
        </div>
        {params.map((p, i) => (
          <div key={i} className="flex items-center gap-2 mb-1.5">
            <input
              value={p.name}
              onChange={(e) => updateParam(i, 'name', e.target.value)}
              placeholder={t('имя', 'name')}
              className="flex-1 px-2 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-xs text-zinc-200 outline-none"
            />
            <input
              value={p.description}
              onChange={(e) => updateParam(i, 'description', e.target.value)}
              placeholder={t('описание', 'description')}
              className="flex-[2] px-2 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-xs text-zinc-200 outline-none"
            />
            <label className="flex items-center gap-1 text-[10px] text-zinc-500 cursor-pointer">
              <input
                type="checkbox"
                checked={p.required}
                onChange={(e) => updateParam(i, 'required', e.target.checked)}
                className="rounded"
              />
              {t('обяз.', 'req.')}
            </label>
            <button onClick={() => removeParam(i)} className="text-red-500/60 hover:text-red-400 text-xs cursor-pointer">
              ✕
            </button>
          </div>
        ))}
      </div>

      <label className="flex items-center gap-2 text-xs text-zinc-400 cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="rounded"
        />
        {t('Включён', 'Enabled')}
      </label>

      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={onCancel}
          className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 cursor-pointer"
        >
          {t('Отмена', 'Cancel')}
        </button>
        <button
          onClick={() => onSave({ id: tool.id, name: name.trim(), description: desc.trim(), command: cmd.trim(), parameters: params, enabled })}
          disabled={!isValid}
          className="px-4 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
        >
          {t('Сохранить', 'Save')}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Prompts tab
// ---------------------------------------------------------------------------

function PromptsTab({
  sysPrompt, sumPrompt, defaultSysPrompt, defaultSumPrompt, appLanguage,
  onSysChange, onSumChange, onResetSys, onResetSum,
}: {
  sysPrompt: string
  sumPrompt: string
  defaultSysPrompt: string
  defaultSumPrompt: string
  appLanguage: 'ru' | 'en'
  onSysChange: (v: string) => void
  onSumChange: (v: string) => void
  onResetSys: () => void
  onResetSum: () => void
}) {
  const L = appLanguage
  const t = (ru: string, en: string) => tr(ru, en, L)
  const sysIsDefault = sysPrompt === defaultSysPrompt
  const sumIsDefault = sumPrompt === defaultSumPrompt

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="block text-sm font-medium text-zinc-300">{t('Системный промпт', 'System prompt')}</label>
          {!sysIsDefault && (
            <button
              onClick={onResetSys}
              className="text-[10px] px-2 py-0.5 rounded text-zinc-500 hover:text-amber-400 hover:bg-amber-500/10 cursor-pointer transition-colors"
            >
              {t('Вернуть по умолчанию', 'Reset to default')}
            </button>
          )}
        </div>
        <p className="text-[11px] text-zinc-600 mb-2">
          {t('Основные инструкции для агента: стиль работы, правила, поведение', 'Core agent instructions: work style, rules, behavior')}
        </p>
        <textarea
          value={sysPrompt}
          onChange={(e) => onSysChange(e.target.value)}
          rows={14}
          spellCheck={false}
          className="w-full px-3 py-2.5 bg-zinc-900 border border-zinc-700 rounded-xl text-xs text-zinc-300 font-mono leading-relaxed focus:border-blue-500 outline-none resize-y min-h-[120px]"
        />
        {sysIsDefault && (
          <p className="text-[10px] text-zinc-700 mt-1">{t('Используется промпт по умолчанию', 'Using the default prompt')}</p>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="block text-sm font-medium text-zinc-300">{t('Промпт суммаризации', 'Summarization prompt')}</label>
          {!sumIsDefault && (
            <button
              onClick={onResetSum}
              className="text-[10px] px-2 py-0.5 rounded text-zinc-500 hover:text-amber-400 hover:bg-amber-500/10 cursor-pointer transition-colors"
            >
              {t('Вернуть по умолчанию', 'Reset to default')}
            </button>
          )}
        </div>
        <p className="text-[11px] text-zinc-600 mb-2">
          {t('Инструкция для сжатия контекста при приближении к лимиту', 'Instruction for compressing context near the limit')}
        </p>
        <textarea
          value={sumPrompt}
          onChange={(e) => onSumChange(e.target.value)}
          rows={8}
          spellCheck={false}
          className="w-full px-3 py-2.5 bg-zinc-900 border border-zinc-700 rounded-xl text-xs text-zinc-300 font-mono leading-relaxed focus:border-blue-500 outline-none resize-y min-h-[80px]"
        />
        {sumIsDefault && (
          <p className="text-[10px] text-zinc-700 mt-1">{t('Используется промпт по умолчанию', 'Using the default prompt')}</p>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Web search tab
// ---------------------------------------------------------------------------

function WebSearchTab({
  provider, customUrl, status, error, applying, dirty, appLanguage,
  onProviderChange, onCustomUrlChange, onApply, onRefresh,
}: {
  provider: WebSearchProvider
  customUrl: string
  status: WebSearchStatus | null
  error: string | null
  applying: boolean
  dirty: boolean
  appLanguage: 'ru' | 'en'
  onProviderChange: (p: WebSearchProvider) => void
  onCustomUrlChange: (u: string) => void
  onApply: () => void
  onRefresh: () => void
}) {
  const L = appLanguage
  const t = (ru: string, en: string) => tr(ru, en, L)

  const options: { id: WebSearchProvider; title: string; desc: string }[] = [
    {
      id: 'disabled',
      title: t('Отключено', 'Disabled'),
      desc: t('Агент не имеет инструментов веб‑поиска и fetch_url.', 'The agent has no web search or fetch_url tools.'),
    },
    {
      id: 'managed-searxng',
      title: t('SearXNG (локально через Docker)', 'SearXNG (local via Docker)'),
      desc: t(
        'Приложение само запустит и поддержит контейнер searxng. Требуется установленный Docker.',
        'The app will launch and maintain a searxng container. Requires Docker.',
      ),
    },
    {
      id: 'custom-searxng',
      title: t('Свой SearXNG', 'Custom SearXNG'),
      desc: t(
        'Укажите URL существующего инстанса SearXNG (должен поддерживать JSON API).',
        'Provide a URL of an existing SearXNG instance (JSON API must be enabled).',
      ),
    },
  ]

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-medium text-zinc-300 mb-1">{t('Провайдер веб‑поиска', 'Web search provider')}</h3>
        <p className="text-[11px] text-zinc-500 mb-3">
          {t(
            'Веб‑поиск даёт агенту инструменты search_web и fetch_url — полезно для получения свежей документации и примеров кода.',
            'Web search gives the agent search_web and fetch_url tools — useful for fetching fresh docs and code examples.',
          )}
        </p>
        <div className="space-y-2">
          {options.map((opt) => (
            <button
              key={opt.id}
              onClick={() => onProviderChange(opt.id)}
              className={`w-full text-left px-3 py-2.5 rounded-lg border transition-colors cursor-pointer ${
                provider === opt.id
                  ? 'border-blue-500/40 bg-blue-500/10'
                  : 'border-zinc-800 hover:bg-zinc-900/70'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className={`text-sm font-medium ${provider === opt.id ? 'text-blue-300' : 'text-zinc-200'}`}>
                  {opt.title}
                </span>
                {provider === opt.id && <span className="text-blue-400 text-sm">✓</span>}
              </div>
              <p className="text-[11px] text-zinc-500 mt-1">{opt.desc}</p>
            </button>
          ))}
        </div>
      </div>

      {provider === 'custom-searxng' && (
        <div>
          <label className="block text-xs text-zinc-400 mb-1">{t('URL вашего SearXNG', 'Your SearXNG URL')}</label>
          <input
            value={customUrl}
            onChange={(e) => onCustomUrlChange(e.target.value)}
            placeholder="https://searx.example.org"
            className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:border-blue-500 outline-none"
          />
        </div>
      )}

      {status && (
        <div className={`rounded-lg border p-3 text-xs ${status.healthy ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-300' : 'border-amber-500/30 bg-amber-500/5 text-amber-300'}`}>
          <div className="font-medium mb-1">
            {status.healthy ? t('Доступен', 'Available') : t('Недоступен', 'Unavailable')}
            {status.provider ? <span className="text-zinc-500 font-normal"> · {status.provider}</span> : null}
          </div>
          {status.effectiveBaseUrl && <div className="text-zinc-400 font-mono break-all">{status.effectiveBaseUrl}</div>}
          {status.detail && <div className="text-zinc-500 mt-1">{status.detail}</div>}
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 text-red-300 text-xs p-3">
          {error}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={onApply}
          disabled={applying || (!dirty && !!status)}
          className="px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-500 cursor-pointer transition-colors disabled:opacity-50"
        >
          {applying ? t('Применяем…', 'Applying…') : t('Применить и проверить', 'Apply and check')}
        </button>
        <button
          onClick={onRefresh}
          disabled={applying}
          className="px-3 py-2 text-xs rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 cursor-pointer transition-colors disabled:opacity-50"
        >
          {t('Обновить статус', 'Refresh status')}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// MCP tab — manages user-configured Model Context Protocol servers.
// ---------------------------------------------------------------------------

interface McpPreset {
  name: string
  command: string
  args: string[]
  envHints?: { key: string; description: string }[]
  description: { ru: string; en: string }
  /** Zero-config presets work out of the box with just `npx`/`uvx` —
   *  no API keys, no paths to fill in. UI gives these a one-click
   *  "add + connect" button instead of opening the editor. */
  zeroConfig?: boolean
}

const MCP_PRESETS: McpPreset[] = [
  // ---- Zero-config, works out of the box -------------------------------
  {
    name: 'memory',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    zeroConfig: true,
    description: {
      ru: 'Долговременная память агента: граф сущностей/отношений между сессиями',
      en: 'Long-term agent memory: entities and relations graph across sessions',
    },
  },
  {
    name: 'sequential-thinking',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    zeroConfig: true,
    description: {
      ru: 'Структурированное пошаговое рассуждение — помогает модели продумывать сложные задачи',
      en: 'Structured step-by-step reasoning — helps the model think through complex tasks',
    },
  },
  {
    name: 'everything',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-everything'],
    zeroConfig: true,
    description: {
      ru: 'Эталонный тестовый сервер — проверить что MCP в принципе работает (echo, add, длинные ответы и т.п.)',
      en: 'Reference test server — verify MCP works end-to-end (echo, add, long outputs, etc.)',
    },
  },

  // ---- Need path / API key ---------------------------------------------
  {
    name: 'filesystem',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/allowed/dir'],
    description: {
      ru: 'Официальный сервер для чтения/записи файлов в разрешённых директориях',
      en: 'Official server for reading/writing files in allowed directories',
    },
  },
  {
    name: 'github',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    envHints: [{ key: 'GITHUB_PERSONAL_ACCESS_TOKEN', description: 'Personal access token' }],
    description: {
      ru: 'GitHub API: issues, PRs, поиск по коду, репозитории',
      en: 'GitHub API: issues, PRs, code search, repositories',
    },
  },
  {
    name: 'postgres',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://localhost/mydb'],
    description: {
      ru: 'Read-only доступ к PostgreSQL: список таблиц, схемы, SELECT-запросы',
      en: 'Read-only access to PostgreSQL: tables, schemas, SELECT queries',
    },
  },
  {
    name: 'sqlite',
    command: 'uvx',
    args: ['mcp-server-sqlite', '--db-path', '/path/to/file.db'],
    description: {
      ru: 'Запросы к SQLite-базе: список таблиц, схемы, SQL-запросы',
      en: 'SQLite database queries: tables, schemas, SQL queries',
    },
  },
  {
    name: 'brave-search',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    envHints: [{ key: 'BRAVE_API_KEY', description: 'Brave Search API key' }],
    description: {
      ru: 'Веб-поиск через Brave Search API',
      en: 'Web search via Brave Search API',
    },
  },
]

function McpTab({ appLanguage }: { appLanguage: 'ru' | 'en' }) {
  const L = appLanguage
  const t = (ru: string, en: string) => tr(ru, en, L)

  const [servers, setServers] = useState<McpServerConfig[]>([])
  const [statuses, setStatuses] = useState<McpServerStatus[]>([])
  const [tools, setTools] = useState<{ qualifiedName: string; serverId: string; rawName: string; description: string }[]>([])
  const [editing, setEditing] = useState<McpServerConfig | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [stderrFor, setStderrFor] = useState<string | null>(null)
  const [stderr, setStderr] = useState('')

  async function refresh() {
    const [srv, st, tl] = await Promise.all([
      window.api.mcpListServers(),
      window.api.mcpGetStatus(),
      window.api.mcpGetTools(),
    ])
    setServers(srv)
    setStatuses(st)
    setTools(tl)
  }

  useEffect(() => {
    refresh().catch(() => {})
    const id = setInterval(() => refresh().catch(() => {}), 2500)
    return () => clearInterval(id)
  }, [])

  function statusFor(id: string) {
    return statuses.find((s) => s.id === id)
  }
  function toolsFor(id: string) {
    return tools.filter((t) => t.serverId === id)
  }

  async function doConnect(id: string) {
    setBusyId(id)
    try { await window.api.mcpConnect(id) } catch {}
    await refresh()
    setBusyId(null)
  }
  async function doDisconnect(id: string) {
    setBusyId(id)
    try { await window.api.mcpDisconnect(id) } catch {}
    await refresh()
    setBusyId(null)
  }
  async function doDelete(id: string) {
    if (!confirm(t('Удалить этот MCP-сервер?', 'Delete this MCP server?'))) return
    try { await window.api.mcpDeleteServer(id) } catch {}
    await refresh()
  }
  async function doSave(s: McpServerConfig) {
    try { await window.api.mcpSaveServer(s) } catch {}
    setEditing(null)
    await refresh()
  }

  /** One-click install for zero-config presets: skip the editor entirely,
   *  save straight to config, and kick a connect. Status dots will light
   *  up as the background connect finishes. */
  async function quickAddPreset(preset: McpPreset) {
    const cfg = newServerFromPreset(preset)
    setBusyId(cfg.id)
    try {
      await window.api.mcpSaveServer(cfg)
      // mcpSaveServer already auto-connects enabled servers, but we also
      // want the user to see the "connecting…" state on THIS button, so
      // we block until the status updates.
      await refresh()
    } catch {}
    setBusyId(null)
  }

  const installedCmdArgs = new Set(
    servers.map((s) => `${s.command} ${s.args.join(' ')}`),
  )
  function isPresetInstalled(p: McpPreset): boolean {
    return installedCmdArgs.has(`${p.command} ${p.args.join(' ')}`)
  }

  function newServerFromPreset(preset?: McpPreset): McpServerConfig {
    const id = `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    if (!preset) {
      return { id, name: 'my-server', command: '', args: [], env: {}, enabled: true }
    }
    const env: Record<string, string> = {}
    for (const h of preset.envHints ?? []) env[h.key] = ''
    return {
      id,
      name: preset.name,
      command: preset.command,
      args: [...preset.args],
      env,
      enabled: true,
    }
  }

  async function openStderr(id: string) {
    setStderrFor(id)
    try { setStderr(await window.api.mcpGetStderrTail(id)) }
    catch { setStderr('') }
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium text-zinc-300 mb-1">{t('MCP серверы', 'MCP servers')}</h3>
        <p className="text-xs text-zinc-500">
          {t(
            'Подключите любой MCP‑сервер (GitHub, Postgres, Slack, файловая система…) — его инструменты станут доступны агенту как обычные tool‑ы.',
            'Connect any MCP server (GitHub, Postgres, Slack, filesystem, …) — its tools will be exposed to the agent like native tools.',
          )}
          {' '}
          <a
            className="text-blue-400 hover:underline cursor-pointer"
            onClick={(e) => { e.preventDefault(); (window.api as any).openExternalUrl?.('https://modelcontextprotocol.io/servers') }}
          >
            {t('Каталог серверов', 'Browse the registry')} ↗
          </a>
        </p>
      </div>

      {/* Existing servers */}
      {servers.length === 0 && !editing && (
        <p className="text-xs text-zinc-600 py-4 text-center">
          {t('Пока нет серверов. Добавьте первый — или начните с готового пресета ниже.', 'No servers yet. Add one — or start from a preset below.')}
        </p>
      )}
      {servers.map((s) => {
        const st = statusFor(s.id)
        const st_tools = toolsFor(s.id)
        const connected = st?.connected ?? false
        const busy = busyId === s.id
        return (
          <div key={s.id} className="px-3 py-2.5 rounded-lg border border-zinc-800">
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full shrink-0 ${
                connected ? 'bg-emerald-500'
                : st?.lastError ? 'bg-red-500'
                : 'bg-zinc-600'
              }`} />
              <span className="text-sm font-mono text-zinc-200">{s.name}</span>
              {!s.enabled && (
                <span className="text-[10px] text-zinc-600">{t('отключён', 'disabled')}</span>
              )}
              {connected && (
                <span className="text-[10px] text-emerald-400/80">
                  {st_tools.length} {t('инстр.', 'tools')}
                </span>
              )}
              <div className="ml-auto flex gap-1">
                {connected ? (
                  <button
                    onClick={() => doDisconnect(s.id)}
                    disabled={busy}
                    className="text-[10px] px-2 py-0.5 rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 cursor-pointer disabled:opacity-50"
                  >
                    {busy ? '…' : t('откл.', 'disconnect')}
                  </button>
                ) : (
                  <button
                    onClick={() => doConnect(s.id)}
                    disabled={busy || !s.enabled}
                    className="text-[10px] px-2 py-0.5 rounded text-blue-400 hover:text-blue-300 hover:bg-blue-500/10 cursor-pointer disabled:opacity-50"
                  >
                    {busy ? '…' : t('подкл.', 'connect')}
                  </button>
                )}
                <button
                  onClick={() => setEditing(s)}
                  className="text-[10px] px-2 py-0.5 rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 cursor-pointer"
                >
                  {t('ред.', 'edit')}
                </button>
                <button
                  onClick={() => doDelete(s.id)}
                  className="text-[10px] px-2 py-0.5 rounded text-red-500/60 hover:text-red-400 hover:bg-red-500/10 cursor-pointer"
                >
                  {t('удал.', 'del')}
                </button>
              </div>
            </div>
            <p className="text-[10px] text-zinc-600 font-mono mt-1 truncate">
              {s.command} {s.args.join(' ')}
            </p>
            {st?.lastError && (
              <p className="text-[10.5px] text-red-400/90 mt-1">
                ⚠ {st.lastError}
                {' · '}
                <button
                  className="underline cursor-pointer"
                  onClick={() => openStderr(s.id)}
                >
                  {t('логи stderr', 'stderr log')}
                </button>
              </p>
            )}
            {connected && st_tools.length > 0 && (
              <details className="mt-1">
                <summary className="text-[10px] text-zinc-500 cursor-pointer hover:text-zinc-300">
                  {t('инструменты', 'tools')} ({st_tools.length})
                </summary>
                <ul className="mt-1 space-y-0.5 text-[10.5px] text-zinc-400">
                  {st_tools.map((t) => (
                    <li key={t.qualifiedName} className="font-mono truncate">
                      <span className="text-blue-400/80">{t.rawName}</span>
                      {t.description && (
                        <span className="text-zinc-600"> — {t.description}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )
      })}

      {/* Editor */}
      {editing && (
        <McpServerEditor
          initial={editing}
          appLanguage={L}
          onSave={doSave}
          onCancel={() => setEditing(null)}
        />
      )}

      {/* Stderr modal */}
      {stderrFor && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/70" onClick={() => setStderrFor(null)}>
          <div
            className="bg-zinc-900 border border-zinc-700 rounded-lg max-w-xl w-full max-h-[70vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-2.5 border-b border-zinc-800 flex items-center justify-between">
              <span className="text-sm text-zinc-200">stderr — {servers.find((s) => s.id === stderrFor)?.name}</span>
              <button
                onClick={() => setStderrFor(null)}
                className="text-zinc-500 hover:text-zinc-200 cursor-pointer"
              >
                ✕
              </button>
            </div>
            <pre className="p-3 text-[11px] font-mono text-zinc-400 overflow-auto whitespace-pre-wrap flex-1">
              {stderr || t('(пусто)', '(empty)')}
            </pre>
          </div>
        </div>
      )}

      {/* Add new */}
      {!editing && (
        <div className="space-y-3">
          {/* Zero-config presets — big cards with one-click "Install". */}
          <div className="pt-2 border-t border-zinc-800">
            <p className="text-[11px] text-zinc-500 mb-2">
              {t('Попробовать сейчас (без настройки):', 'Try now (no config):')}
            </p>
            <div className="grid grid-cols-1 gap-1.5">
              {MCP_PRESETS.filter((p) => p.zeroConfig).map((p) => {
                const installed = isPresetInstalled(p)
                return (
                  <div
                    key={p.name}
                    className={`px-3 py-2 rounded-lg border flex items-start gap-2.5 ${
                      installed ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-zinc-800 hover:border-zinc-700'
                    } transition-colors`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[12px] font-mono text-zinc-200">{p.name}</span>
                        {installed && (
                          <span className="text-[10px] text-emerald-400/80">{t('добавлен', 'installed')}</span>
                        )}
                      </div>
                      <p className="text-[10.5px] text-zinc-500 mt-0.5">{p.description[L]}</p>
                    </div>
                    <button
                      onClick={() => quickAddPreset(p)}
                      disabled={installed}
                      className="shrink-0 text-[11px] px-2.5 py-1 rounded bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {installed ? '✓' : t('Установить', 'Install')}
                    </button>
                  </div>
                )
              })}
            </div>
            <p className="text-[10px] text-zinc-600 mt-1.5">
              {t(
                'Первая установка скачает npm-пакет (~10–30 сек), дальше мгновенно.',
                'First install fetches the npm package (~10–30 s), then it\'s instant.',
              )}
            </p>
          </div>

          {/* Preset chips that need config + fully custom "Add server" button. */}
          <div className="pt-2 border-t border-zinc-800">
            <p className="text-[11px] text-zinc-500 mb-2">
              {t('Требуют настройки (API-ключ или путь):', 'Need config (API key or path):')}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {MCP_PRESETS.filter((p) => !p.zeroConfig).map((p) => (
                <button
                  key={p.name}
                  onClick={() => setEditing(newServerFromPreset(p))}
                  title={p.description[L]}
                  className="text-[11px] px-2 py-1 rounded border border-zinc-700 text-zinc-300 hover:border-blue-500/50 hover:text-blue-300 cursor-pointer"
                >
                  {p.name}
                </button>
              ))}
              <button
                onClick={() => setEditing(newServerFromPreset())}
                className="text-[11px] px-2 py-1 rounded border border-blue-500/40 text-blue-400 hover:border-blue-500 hover:bg-blue-500/10 cursor-pointer"
              >
                + {t('свой', 'custom')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function McpServerEditor({
  initial,
  appLanguage,
  onSave,
  onCancel,
}: {
  initial: McpServerConfig
  appLanguage: 'ru' | 'en'
  onSave: (s: McpServerConfig) => void
  onCancel: () => void
}) {
  const L = appLanguage
  const t = (ru: string, en: string) => tr(ru, en, L)
  const [name, setName] = useState(initial.name)
  const [command, setCommand] = useState(initial.command)
  const [argsStr, setArgsStr] = useState(initial.args.join(' '))
  const [envList, setEnvList] = useState<{ k: string; v: string }[]>(
    Object.entries(initial.env || {}).map(([k, v]) => ({ k, v })),
  )
  const [enabled, setEnabled] = useState(initial.enabled)

  function save() {
    // Split on whitespace but respect simple quoting ("a b" → a b as one arg).
    // Matches most copy-pasted command lines. For edge cases users can edit
    // the underlying config file directly — this is a 95%-case UI.
    const args: string[] = []
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(argsStr)) !== null) {
      args.push(m[1] ?? m[2] ?? m[3])
    }
    const env: Record<string, string> = {}
    for (const { k, v } of envList) {
      if (k.trim()) env[k.trim()] = v
    }
    onSave({
      ...initial,
      name: name.trim() || 'server',
      command: command.trim(),
      args,
      env,
      enabled,
    })
  }

  return (
    <div className="p-3 rounded-lg border border-blue-500/30 bg-blue-500/5 space-y-2">
      <div>
        <label className="text-[11px] text-zinc-500 block mb-1">{t('Имя', 'Name')}</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full px-2 py-1 text-xs bg-zinc-900 border border-zinc-700 rounded focus:border-blue-500 outline-none font-mono"
          placeholder="my-mcp-server"
        />
      </div>
      <div>
        <label className="text-[11px] text-zinc-500 block mb-1">{t('Команда', 'Command')}</label>
        <input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          className="w-full px-2 py-1 text-xs bg-zinc-900 border border-zinc-700 rounded focus:border-blue-500 outline-none font-mono"
          placeholder="npx"
        />
      </div>
      <div>
        <label className="text-[11px] text-zinc-500 block mb-1">{t('Аргументы', 'Arguments')}</label>
        <input
          value={argsStr}
          onChange={(e) => setArgsStr(e.target.value)}
          className="w-full px-2 py-1 text-xs bg-zinc-900 border border-zinc-700 rounded focus:border-blue-500 outline-none font-mono"
          placeholder="-y @modelcontextprotocol/server-filesystem /path"
        />
      </div>
      <div>
        <label className="text-[11px] text-zinc-500 block mb-1">
          {t('Переменные окружения', 'Environment variables')}
        </label>
        {envList.map((p, i) => (
          <div key={i} className="flex gap-1 mb-1">
            <input
              value={p.k}
              onChange={(e) => {
                const next = [...envList]
                next[i] = { ...next[i], k: e.target.value }
                setEnvList(next)
              }}
              className="flex-1 px-2 py-1 text-xs bg-zinc-900 border border-zinc-700 rounded focus:border-blue-500 outline-none font-mono"
              placeholder="KEY"
            />
            <input
              value={p.v}
              onChange={(e) => {
                const next = [...envList]
                next[i] = { ...next[i], v: e.target.value }
                setEnvList(next)
              }}
              type="password"
              className="flex-[2] px-2 py-1 text-xs bg-zinc-900 border border-zinc-700 rounded focus:border-blue-500 outline-none font-mono"
              placeholder="value"
            />
            <button
              onClick={() => setEnvList(envList.filter((_, j) => j !== i))}
              className="px-2 text-zinc-500 hover:text-red-400 cursor-pointer"
            >
              ✕
            </button>
          </div>
        ))}
        <button
          onClick={() => setEnvList([...envList, { k: '', v: '' }])}
          className="text-[11px] px-2 py-0.5 rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 cursor-pointer"
        >
          + env
        </button>
      </div>
      <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        {t('Включён', 'Enabled')}
      </label>
      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={onCancel}
          className="text-xs px-3 py-1 rounded text-zinc-400 hover:text-zinc-200 cursor-pointer"
        >
          {t('Отмена', 'Cancel')}
        </button>
        <button
          onClick={save}
          disabled={!command.trim()}
          className="text-xs px-3 py-1 rounded bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 cursor-pointer disabled:opacity-40"
        >
          {t('Сохранить', 'Save')}
        </button>
      </div>
    </div>
  )
}
