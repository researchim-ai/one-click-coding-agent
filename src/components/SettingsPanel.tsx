import { useState, useEffect, useRef } from 'react'
import type { ModelVariantInfo, ToolInfo } from '../../electron/types'
import type { AppConfig, CustomTool } from '../../electron/config'

interface Props {
  open: boolean
  onClose: () => void
  initialTab?: string
}

type Tab = 'model' | 'tools' | 'prompts'

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

function formatSize(mb: number): string {
  return (mb / 1024).toFixed(1) + ' ГБ'
}

function formatCtx(tokens: number): string {
  if (tokens >= 1024) return Math.round(tokens / 1024) + 'K'
  return String(tokens)
}

export function SettingsPanel({ open, onClose, initialTab }: Props) {
  const [tab, setTab] = useState<Tab>('model')
  const [cfg, setCfg] = useState<AppConfig | null>(null)
  const [variants, setVariants] = useState<ModelVariantInfo[]>([])
  const [tools, setTools] = useState<ToolInfo[]>([])
  const [selectedQuant, setSelectedQuant] = useState('')
  const [selectedCtx, setSelectedCtx] = useState<number>(32768)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editingTool, setEditingTool] = useState<CustomTool | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  // Prompts state
  const [sysPrompt, setSysPrompt] = useState('')
  const [sumPrompt, setSumPrompt] = useState('')
  const [defaultSysPrompt, setDefaultSysPrompt] = useState('')
  const [defaultSumPrompt, setDefaultSumPrompt] = useState('')
  const [promptsDirty, setPromptsDirty] = useState(false)

  useEffect(() => {
    if (initialTab) {
      const mapped = initialTab === 'prompts' ? 'prompts' : initialTab === 'tools' ? 'tools' : 'model'
      setTab(mapped)
    }
  }, [initialTab, open])

  useEffect(() => {
    if (!open) return
    Promise.all([
      window.api.getConfig(),
      window.api.getModelVariants(),
      window.api.getTools(),
      window.api.getPrompts(),
    ]).then(([c, v, t, p]) => {
      setCfg(c)
      setVariants(v)
      setTools(t)
      const quant = c.lastQuant || 'UD-Q4_K_XL'
      setSelectedQuant(quant)
      const variant = v.find((vi: ModelVariantInfo) => vi.quant === quant)
      const max = variant?.maxCtx ?? 32768
      setSelectedCtx((c.ctxSize && c.ctxSize > 0) ? Math.min(c.ctxSize, max) : max)
      setDirty(false)

      setSysPrompt(p.systemPrompt ?? p.defaultSystemPrompt)
      setSumPrompt(p.summarizePrompt ?? p.defaultSummarizePrompt)
      setDefaultSysPrompt(p.defaultSystemPrompt)
      setDefaultSumPrompt(p.defaultSummarizePrompt)
      setPromptsDirty(false)
    }).catch(() => {})
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

  const handleSave = async () => {
    setSaving(true)
    try {
      await window.api.saveConfig({ lastQuant: selectedQuant, ctxSize: selectedCtx })
      await window.api.selectModelVariant(selectedQuant)
      setDirty(false)
    } finally {
      setSaving(false)
    }
  }

  const handleApplyRestart = async () => {
    setSaving(true)
    try {
      await window.api.saveConfig({ lastQuant: selectedQuant, ctxSize: selectedCtx })
      await window.api.selectModelVariant(selectedQuant)
      const result = await window.api.restartServer()
      setDirty(false)
      if (result?.actualCtx && result.actualCtx < selectedCtx) {
        alert(`Сервер запущен, но контекст уменьшен: ${Math.round(result.actualCtx / 1024)}K вместо ${Math.round(selectedCtx / 1024)}K (не хватает памяти)`)
      }
      onClose()
    } catch (e: any) {
      alert('Ошибка: ' + (e.message ?? e))
    } finally {
      setSaving(false)
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
      const [c, v, t, p] = await Promise.all([
        window.api.getConfig(),
        window.api.getModelVariants(),
        window.api.getTools(),
        window.api.getPrompts(),
      ])
      setCfg(c)
      setVariants(v)
      setTools(t)
      setSelectedQuant(c.lastQuant || 'UD-Q4_K_XL')
      setSelectedCtx(32768)
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

  const tabs: { key: Tab; label: string }[] = [
    { key: 'model', label: 'Модель и контекст' },
    { key: 'tools', label: 'Инструменты' },
    { key: 'prompts', label: 'Промпты' },
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
          <h2 className="text-base font-semibold text-zinc-100">Настройки</h2>
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
              selectedQuant={selectedQuant}
              selectedCtx={selectedCtx}
              maxCtx={maxCtx}
              onQuantChange={(q) => { setSelectedQuant(q); setDirty(true) }}
              onCtxChange={(c: number) => { setSelectedCtx(c); setDirty(true) }}
            />
          )}
          {tab === 'tools' && (
            <ToolsTab
              tools={tools}
              editingTool={editingTool}
              onEdit={setEditingTool}
              onSave={handleSaveCustomTool}
              onDelete={handleDeleteCustomTool}
              onCancelEdit={() => setEditingTool(null)}
            />
          )}
          {tab === 'prompts' && (
            <PromptsTab
              sysPrompt={sysPrompt}
              sumPrompt={sumPrompt}
              defaultSysPrompt={defaultSysPrompt}
              defaultSumPrompt={defaultSumPrompt}
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
            <span className="text-xs text-zinc-500 flex-1">
              Сервер будет перезапущен с новыми настройками
            </span>
            <button
              onClick={handleApplyRestart}
              disabled={saving}
              className="px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-500 cursor-pointer transition-colors disabled:opacity-50"
            >
              {saving ? 'Перезапуск…' : 'Применить и перезапустить'}
            </button>
          </div>
        )}

        {tab === 'prompts' && promptsDirty && (
          <div className="border-t border-zinc-800 px-5 py-3 flex items-center gap-3 shrink-0">
            <span className="text-xs text-zinc-500 flex-1">
              Промпты применяются к новым сообщениям
            </span>
            <button
              onClick={handleResetPrompts}
              disabled={saving}
              className="px-4 py-2 text-sm rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 cursor-pointer transition-colors disabled:opacity-50"
            >
              Сбросить оба
            </button>
            <button
              onClick={handleSavePrompts}
              disabled={saving}
              className="px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-500 cursor-pointer transition-colors disabled:opacity-50"
            >
              {saving ? 'Сохранение…' : 'Сохранить промпты'}
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
            Сбросить все настройки по умолчанию
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
  variants, selectedQuant, selectedCtx, maxCtx,
  onQuantChange, onCtxChange,
}: {
  variants: ModelVariantInfo[]
  selectedQuant: string
  selectedCtx: number
  maxCtx: number
  onQuantChange: (q: string) => void
  onCtxChange: (c: number) => void
}) {
  return (
    <div className="space-y-6">
      {/* Quant selection */}
      <div>
        <label className="block text-sm font-medium text-zinc-300 mb-3">Квантизация модели</label>
        <div className="space-y-1 max-h-[320px] overflow-y-auto rounded-xl border border-zinc-800 p-1">
          {variants.map((v) => {
            const isSel = v.quant === selectedQuant
            const colorClass = BITS_COLOR[v.bits] ?? 'text-zinc-400'
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
                      {v.quant.replace('UD-', '')}
                    </span>
                    {v.recommended && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400 font-medium">
                        рек.
                      </span>
                    )}
                  </div>
                  <div className={`text-[11px] mt-0.5 ${v.fits ? 'text-zinc-500' : 'text-zinc-700'}`}>
                    {formatSize(v.sizeMb)}
                    {v.fits && <> · макс. ctx {formatCtx(v.maxCtx)} · {v.mode === 'full_gpu' ? 'GPU' : v.mode === 'hybrid' ? 'GPU+CPU' : 'CPU'}</>}
                    {!v.fits && ' · не хватает памяти'}
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
        <label className="block text-sm font-medium text-zinc-300 mb-2">Размер контекста</label>
        <p className="text-xs text-zinc-500 mb-3">
          Максимум для текущей квантизации: {formatCtx(maxCtx)}
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
// Tools tab
// ---------------------------------------------------------------------------

function ToolsTab({
  tools, editingTool,
  onEdit, onSave, onDelete, onCancelEdit,
}: {
  tools: ToolInfo[]
  editingTool: CustomTool | null
  onEdit: (tool: CustomTool | null) => void
  onSave: (tool: CustomTool) => void
  onDelete: (id: string) => void
  onCancelEdit: () => void
}) {
  const builtins = tools.filter((t) => t.builtin)
  const custom = tools.filter((t) => !t.builtin)

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
      {/* Built-in tools */}
      <div>
        <h3 className="text-sm font-medium text-zinc-300 mb-2">Встроенные инструменты</h3>
        <div className="space-y-1">
          {builtins.map((t) => (
            <div key={t.name} className="px-3 py-2 rounded-lg bg-zinc-900/50 border border-zinc-800/50">
              <div className="flex items-center gap-2">
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500 font-mono">{t.name}</span>
              </div>
              <p className="text-xs text-zinc-500 mt-1 line-clamp-2">{t.description}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Custom tools */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium text-zinc-300">Пользовательские инструменты</h3>
          <button
            onClick={() => onEdit(newTool())}
            className="text-xs px-2.5 py-1 rounded-lg bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 cursor-pointer transition-colors"
          >
            + Добавить
          </button>
        </div>

        {custom.length === 0 && !editingTool && (
          <p className="text-xs text-zinc-600 py-4 text-center">
            Нет пользовательских инструментов. Добавьте свой первый инструмент — агент сможет его вызывать.
          </p>
        )}

        {custom.map((t) => (
          <div key={t.id} className="px-3 py-2.5 rounded-lg border border-zinc-800 mb-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 font-mono">{t.name}</span>
                {!t.enabled && <span className="text-[10px] text-zinc-600">отключён</span>}
              </div>
              <div className="flex gap-1">
                <button
                  onClick={() => onEdit({ id: t.id!, name: t.name, description: t.description, command: t.command!, parameters: t.parameters!, enabled: t.enabled })}
                  className="text-[10px] px-2 py-0.5 rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 cursor-pointer"
                >
                  ред.
                </button>
                <button
                  onClick={() => onDelete(t.id!)}
                  className="text-[10px] px-2 py-0.5 rounded text-red-500/60 hover:text-red-400 hover:bg-red-500/10 cursor-pointer"
                >
                  удал.
                </button>
              </div>
            </div>
            <p className="text-xs text-zinc-500 mt-1">{t.description}</p>
            {t.command && <p className="text-[10px] text-zinc-600 mt-1 font-mono">{t.command}</p>}
          </div>
        ))}

        {editingTool && (
          <ToolEditor tool={editingTool} onSave={onSave} onCancel={onCancelEdit} />
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tool editor form
// ---------------------------------------------------------------------------

function ToolEditor({
  tool, onSave, onCancel,
}: {
  tool: CustomTool
  onSave: (tool: CustomTool) => void
  onCancel: () => void
}) {
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
        <label className="block text-xs text-zinc-400 mb-1">Имя функции (snake_case)</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="run_tests"
          className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:border-blue-500 outline-none"
        />
      </div>
      <div>
        <label className="block text-xs text-zinc-400 mb-1">Описание (для агента)</label>
        <input
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder="Run the project test suite"
          className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:border-blue-500 outline-none"
        />
      </div>
      <div>
        <label className="block text-xs text-zinc-400 mb-1">
          Команда <span className="text-zinc-600">({'используйте {{param}} для подстановки параметров'})</span>
        </label>
        <input
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          placeholder="npm test -- {{filter}}"
          className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-zinc-200 font-mono focus:border-blue-500 outline-none"
        />
      </div>

      {/* Parameters */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs text-zinc-400">Параметры</label>
          <button onClick={addParam} className="text-[10px] text-blue-400 hover:text-blue-300 cursor-pointer">
            + параметр
          </button>
        </div>
        {params.map((p, i) => (
          <div key={i} className="flex items-center gap-2 mb-1.5">
            <input
              value={p.name}
              onChange={(e) => updateParam(i, 'name', e.target.value)}
              placeholder="имя"
              className="flex-1 px-2 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-xs text-zinc-200 outline-none"
            />
            <input
              value={p.description}
              onChange={(e) => updateParam(i, 'description', e.target.value)}
              placeholder="описание"
              className="flex-[2] px-2 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-xs text-zinc-200 outline-none"
            />
            <label className="flex items-center gap-1 text-[10px] text-zinc-500 cursor-pointer">
              <input
                type="checkbox"
                checked={p.required}
                onChange={(e) => updateParam(i, 'required', e.target.checked)}
                className="rounded"
              />
              обяз.
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
        Включён
      </label>

      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={onCancel}
          className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 cursor-pointer"
        >
          Отмена
        </button>
        <button
          onClick={() => onSave({ id: tool.id, name: name.trim(), description: desc.trim(), command: cmd.trim(), parameters: params, enabled })}
          disabled={!isValid}
          className="px-4 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
        >
          Сохранить
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Prompts tab
// ---------------------------------------------------------------------------

function PromptsTab({
  sysPrompt, sumPrompt, defaultSysPrompt, defaultSumPrompt,
  onSysChange, onSumChange, onResetSys, onResetSum,
}: {
  sysPrompt: string
  sumPrompt: string
  defaultSysPrompt: string
  defaultSumPrompt: string
  onSysChange: (v: string) => void
  onSumChange: (v: string) => void
  onResetSys: () => void
  onResetSum: () => void
}) {
  const sysIsDefault = sysPrompt === defaultSysPrompt
  const sumIsDefault = sumPrompt === defaultSumPrompt

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="block text-sm font-medium text-zinc-300">Системный промпт</label>
          {!sysIsDefault && (
            <button
              onClick={onResetSys}
              className="text-[10px] px-2 py-0.5 rounded text-zinc-500 hover:text-amber-400 hover:bg-amber-500/10 cursor-pointer transition-colors"
            >
              Вернуть по умолчанию
            </button>
          )}
        </div>
        <p className="text-[11px] text-zinc-600 mb-2">
          Основные инструкции для агента: стиль работы, правила, поведение
        </p>
        <textarea
          value={sysPrompt}
          onChange={(e) => onSysChange(e.target.value)}
          rows={14}
          spellCheck={false}
          className="w-full px-3 py-2.5 bg-zinc-900 border border-zinc-700 rounded-xl text-xs text-zinc-300 font-mono leading-relaxed focus:border-blue-500 outline-none resize-y min-h-[120px]"
        />
        {sysIsDefault && (
          <p className="text-[10px] text-zinc-700 mt-1">Используется промпт по умолчанию</p>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="block text-sm font-medium text-zinc-300">Промпт суммаризации</label>
          {!sumIsDefault && (
            <button
              onClick={onResetSum}
              className="text-[10px] px-2 py-0.5 rounded text-zinc-500 hover:text-amber-400 hover:bg-amber-500/10 cursor-pointer transition-colors"
            >
              Вернуть по умолчанию
            </button>
          )}
        </div>
        <p className="text-[11px] text-zinc-600 mb-2">
          Инструкция для сжатия контекста при приближении к лимиту
        </p>
        <textarea
          value={sumPrompt}
          onChange={(e) => onSumChange(e.target.value)}
          rows={8}
          spellCheck={false}
          className="w-full px-3 py-2.5 bg-zinc-900 border border-zinc-700 rounded-xl text-xs text-zinc-300 font-mono leading-relaxed focus:border-blue-500 outline-none resize-y min-h-[80px]"
        />
        {sumIsDefault && (
          <p className="text-[10px] text-zinc-700 mt-1">Используется промпт по умолчанию</p>
        )}
      </div>
    </div>
  )
}
