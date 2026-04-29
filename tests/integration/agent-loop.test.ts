/**
 * End-to-end integration tests for `runAgent`.
 *
 * Each test scripts a deterministic sequence of LLM replies through the
 * harness and then asserts on observable effects:
 *   - emitted events
 *   - fetch bodies sent to the fake server
 *   - session state (messages / taskState)
 *   - filesystem under the temp workspace
 *
 * Together these cover the wiring between `agent.ts` and the context-
 * management modules that the unit tests verify in isolation.
 */

import { describe, it, expect, afterEach } from 'vitest'
import path from 'path'
import fs from 'fs'
import { makeHarness, type Harness } from './harness'
import { runAgent } from '../../electron/agent'
import * as toolCache from '../../electron/tool-cache'

let live: Harness | null = null
afterEach(() => {
  if (live) {
    live.cleanup()
    live = null
  }
})

describe('runAgent integration', () => {
  it('sends cache_prompt:true and includes the repo map + tools', async () => {
    live = await makeHarness({
      seedFiles: {
        'src/alpha.ts': 'export const alpha = () => 1\n',
        'src/beta.ts': 'export function beta() { return 2 }\n',
        'package.json': '{"name":"fixture"}\n',
      },
    })
    live.enqueueAssistantText('Всё понятно, ничего делать не надо.')

    await runAgent('Привет', live.workspace, live.bridge)

    const chatCall = live.fetchCalls.find((c) => c.url.endsWith('/v1/chat/completions'))
    expect(chatCall, 'chat completion call should have been made').toBeTruthy()
    expect(chatCall!.body.cache_prompt, 'cache_prompt must be true for llama.cpp KV reuse').toBe(true)
    expect(chatCall!.body.stream).toBe(true)
    expect(Array.isArray(chatCall!.body.tools)).toBe(true)
    expect(chatCall!.body.tools.length).toBeGreaterThan(5)

    const toolNames = chatCall!.body.tools.map((t: any) => t.function.name)
    expect(toolNames).toContain('read_file')
    expect(toolNames).toContain('get_project_context')
    expect(toolNames).toContain('update_plan')
    expect(toolNames).toContain('recall')

    // The first system prompt should carry the repo map or at least the
    // project type indicator that lives right next to it.
    const systemMsg = chatCall!.body.messages.find((m: any) => m.role === 'system')
    expect(systemMsg).toBeTruthy()
    expect(systemMsg.content).toMatch(/Project Context Index|Dynamic context|get_project_context/i)
    expect(systemMsg.content.length).toBeLessThan(12000)
  })

  it('fetches project context dynamically through get_project_context', async () => {
    live = await makeHarness({
      seedFiles: {
        'AGENTS.md': 'Always run the narrowest relevant test before finalizing.\n',
        'src/alpha.ts': 'export const alpha = () => 1\n',
      },
    })

    live.enqueueAssistantToolCall({ name: 'get_project_context', args: { section: 'rules' } })
    live.enqueueAssistantText('rules loaded')

    await runAgent('check project rules', live.workspace, live.bridge)

    const result = live.events.find((e) => e.type === 'tool_result' && e.name === 'get_project_context')
    expect(result).toBeTruthy()
    expect(String(result.result)).toContain('Always run the narrowest relevant test')
  })

  it('caches repeated read_file calls (second call served from cache)', async () => {
    live = await makeHarness({
      seedFiles: {
        'note.txt': 'hello world\nline two\n',
      },
    })

    // Turn 1: model asks to read_file
    live.enqueueAssistantToolCall({ name: 'read_file', args: { path: 'note.txt' } })
    // Turn 2: model asks again for the same file
    live.enqueueAssistantToolCall({ name: 'read_file', args: { path: 'note.txt' } })
    // Turn 3: model stops
    live.enqueueAssistantText('Done.')

    await runAgent('read that file twice', live.workspace, live.bridge)

    const toolResults = live.events.filter((e) => e.type === 'tool_result' && e.name === 'read_file')
    expect(toolResults.length).toBe(2)

    // The first result is the raw file content; the second must be a
    // cache short-circuit (marker header injected by renderCachedShortCircuit).
    expect(toolResults[0].result).toContain('hello world')
    expect(toolResults[1].result).toMatch(/\[.*cached.*(?:reused|turn)/i)

    // Hit counter should have bumped by exactly one.
    const stats = toolCache.getStats()
    expect(stats.hits).toBeGreaterThanOrEqual(1)
  })

  it('cache hit prefixes the repeated result with a reused-from-turn marker', async () => {
    live = await makeHarness({
      seedFiles: {
        'big.txt': 'X'.repeat(2000),
      },
    })

    live.enqueueAssistantToolCall({ name: 'read_file', args: { path: 'big.txt' } })
    live.enqueueAssistantToolCall({ name: 'read_file', args: { path: 'big.txt' } })
    live.enqueueAssistantText('Finished.')

    await runAgent('read big twice', live.workspace, live.bridge)

    const toolMsgs = live.session.messages.filter((m: any) => m.role === 'tool')
    expect(toolMsgs.length).toBeGreaterThanOrEqual(2)
    const [first, second] = toolMsgs.slice(0, 2).map((m: any) => String(m.content ?? ''))
    expect(first).not.toMatch(/cached result, reused/i)
    expect(second).toMatch(/cached result, reused from turn/i)
  })

  it('blocks non-consecutive repeated read_file loops within one turn', async () => {
    live = await makeHarness({
      seedFiles: {
        'marl_library/algorithms/qmix.py': 'def train():\n    pass\n',
      },
    })

    const target = 'marl_library/algorithms/qmix.py'
    live.enqueueAssistantToolCall({ name: 'read_file', args: { path: target } })
    live.enqueueAssistantToolCall({
      name: 'update_plan',
      args: { goal: 'fix qmix', plan: [{ title: 'inspect', status: 'in_progress' }] },
    })
    live.enqueueAssistantToolCall({ name: 'read_file', args: { path: target } })
    live.enqueueAssistantToolCall({ name: 'update_plan', args: { notes: 'still inspecting' } })
    live.enqueueAssistantToolCall({ name: 'read_file', args: { path: target } })
    live.enqueueAssistantText('Stopped re-reading and moving on.')

    await runAgent('fix qmix train', live.workspace, live.bridge)

    const readResults = live.events.filter((e) => e.type === 'tool_result' && e.name === 'read_file')
    expect(readResults).toHaveLength(2)
    expect(String(readResults[0].result)).toContain('def train')
    expect(String(readResults[1].result)).toMatch(/\[.*cached.*(?:reused|turn)/i)
    expect(live.session.messages.some((m: any) => String(m.content ?? '').includes('Loop guard: you already called read_file'))).toBe(true)
  })

  it('injects recovery guidance when the model ignores repeated loop-guard nudges', async () => {
    live = await makeHarness({
      seedFiles: {
        'marl_library/algorithms/qmix.py': 'def train():\n    pass\n',
      },
    })

    const target = 'marl_library/algorithms/qmix.py'
    for (let i = 0; i < 5; i++) {
      live.enqueueAssistantToolCall({ name: 'read_file', args: { path: target } })
    }
    live.enqueueAssistantText('I will use the existing file contents and edit next.')

    const result = await runAgent('fix qmix train', live.workspace, live.bridge)

    expect(result).toMatch(/use the existing file contents/)
    expect(live.session.messages.some((m: any) => String(m.content ?? '').includes('loop guard intervention'))).toBe(true)
  })

  it('recovers from repeated XML text tool calls before flooding the UI', async () => {
    live = await makeHarness({
      seedFiles: {
        'src/envs/grid_world.py': 'def step(action):\n    return None\n',
      },
    })

    const toolCall = `<tool_call>
<function=read_file>
<parameter=path>src/envs/grid_world.py</parameter>
<parameter=offset>56</parameter>
<parameter=limit>40</parameter>
</function>
</tool_call>`
    live.enqueueAssistantText(`I am looping.\n${Array.from({ length: 20 }, () => toolCall).join('\n')}`)
    live.enqueueAssistantText('I will stop re-reading and apply the edit from the observed code.')

    const result = await runAgent('fix grid world', live.workspace, live.bridge)

    expect(result).toMatch(/stop re-reading/)
    const readCards = live.events.filter((e) => e.type === 'tool_call' && e.name === 'read_file')
    const readResults = live.events.filter((e) => e.type === 'tool_result' && e.name === 'read_file')
    expect(readCards).toHaveLength(2)
    expect(readResults).toHaveLength(2)
    expect(live.session.messages.some((m: any) => String(m.content ?? '').includes('loop guard intervention'))).toBe(true)
  })

  it('update_plan mutates session.taskState and resurfaces in the NEXT system prompt', async () => {
    live = await makeHarness()

    live.enqueueAssistantToolCall({
      name: 'update_plan',
      args: {
        goal: 'ship feature X',
        plan: [
          { title: 'step one', status: 'in_progress' },
          { title: 'step two', status: 'pending' },
        ],
        notes: 'be careful',
      },
    })
    live.enqueueAssistantText('Plan stored.')

    await runAgent('plan it', live.workspace, live.bridge)

    expect(live.session.taskState).toBeTruthy()
    expect(live.session.taskState!.goal).toBe('ship feature X')
    expect(live.session.taskState!.plan.map((s) => s.title)).toEqual(['step one', 'step two'])
    expect(live.session.taskState!.plan[0].status).toBe('in_progress')
    expect(live.session.taskState!.notes).toBe('be careful')

    // A live `task_state` event must be emitted immediately after
    // update_plan so the sidebar panel can re-render mid-turn — without
    // this the plan appears frozen until the whole agent cycle ends.
    const taskStateEvents = live.events.filter((e) => e.type === 'task_state')
    expect(taskStateEvents.length).toBeGreaterThanOrEqual(1)
    const lastSnap = taskStateEvents[taskStateEvents.length - 1].taskState as any
    expect(lastSnap).toBeTruthy()
    expect(lastSnap.goal).toBe('ship feature X')
    expect(lastSnap.plan.map((s: any) => s.title)).toEqual(['step one', 'step two'])

    // At least two LLM calls were made; the SECOND should include the
    // task-state block — but NOT baked into the system prompt (that was
    // the old, KV-cache-hostile design). Instead it arrives as a short
    // ephemeral user message placed immediately before the current user
    // turn, so the system prompt and prior history stay byte-identical
    // across turns and llama.cpp's `cache_prompt` actually reuses them.
    const chatCalls = live.fetchCalls.filter((c) => c.url.endsWith('/v1/chat/completions'))
    expect(chatCalls.length).toBeGreaterThanOrEqual(2)
    const secondSystem = chatCalls[1].body.messages.find((m: any) => m.role === 'system')
    expect(secondSystem).toBeTruthy()
    // System prompt must NOT contain the task-state block — that would
    // invalidate the KV cache on every update_plan.
    expect(secondSystem.content).not.toMatch(/taskstate:begin/)
    expect(secondSystem.content).not.toContain('ship feature X')

    // Instead, look for an ephemeral user message carrying the block.
    const ephemeral = chatCalls[1].body.messages.find(
      (m: any) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('<!--taskstate:begin-->'),
    )
    expect(ephemeral).toBeTruthy()
    expect(ephemeral.content).toMatch(/taskstate:begin|Task state|Текущая задача|Goal:|Цель:/i)
    expect(ephemeral.content).toContain('ship feature X')

    // The ephemeral must sit immediately before the latest real user turn.
    const msgs = chatCalls[1].body.messages
    const ephIdx = msgs.indexOf(ephemeral)
    expect(ephIdx).toBeGreaterThanOrEqual(0)
    // Next message after ephemeral must be the real user turn.
    const nextReal = msgs.slice(ephIdx + 1).find((m: any) => m.role === 'user' && !(typeof m.content === 'string' && m.content.startsWith('<!--taskstate:begin-->')))
    expect(nextReal).toBeTruthy()

    // And the persisted session must NOT contain the ephemeral (it is
    // only stitched in for each outgoing request).
    const leaked = live.session.messages.some(
      (m: any) => typeof m.content === 'string' && m.content.startsWith('<!--taskstate:begin-->'),
    )
    expect(leaked, 'ephemeral taskState must not leak into session.messages').toBe(false)
  })

  it('recall tool finds matches from the persistent archive', async () => {
    live = await makeHarness()

    // First run: drop a unique phrase into the conversation. Final-only
    // assistant messages are saved directly to session.messages but the
    // archive flush happens at the START of each iteration — so to make
    // sure the phrase is archived before the run ends we give the model a
    // tool-using turn followed by a plain stop turn.
    live.enqueueAssistantToolCall(
      { name: 'update_plan', args: { goal: 'remember spell' } },
      'Запомни фразу: Секретное заклинание — BANANAS_QUANTUM_42',
    )
    live.enqueueAssistantText('done')
    await runAgent('say the spell', live.workspace, live.bridge)

    // Second run: same session, new user turn. Ask the model to call recall.
    live.enqueueAssistantToolCall({ name: 'recall', args: { query: 'BANANAS_QUANTUM_42' } })
    live.enqueueAssistantText('Found it.')
    await runAgent('what was the spell?', live.workspace, live.bridge)

    const recallResult = live.events
      .filter((e) => e.type === 'tool_result' && e.name === 'recall')
      .pop()
    expect(recallResult).toBeTruthy()
    expect(recallResult.result).toContain('BANANAS_QUANTUM_42')
    expect(recallResult.result).toMatch(/Found \d+ match/i)
  })

  it('persists task-state across turns in the same session', async () => {
    live = await makeHarness()

    // First turn: set plan.
    live.enqueueAssistantToolCall({
      name: 'update_plan',
      args: {
        goal: 'write docs',
        plan: [
          { title: 'draft', status: 'in_progress' },
          { title: 'review', status: 'pending' },
        ],
      },
    })
    live.enqueueAssistantText('ok')
    await runAgent('start docs', live.workspace, live.bridge)

    // Second turn: set notes only. Unspecified fields (goal, plan) must be
    // preserved from the previous state — this is the whole point of the
    // partial-update semantics.
    live.enqueueAssistantToolCall({
      name: 'update_plan',
      args: { notes: 'watch out for typos' },
    })
    live.enqueueAssistantText('noted')
    await runAgent('and be careful', live.workspace, live.bridge)

    expect(live.session.taskState!.goal).toBe('write docs')
    expect(live.session.taskState!.plan.map((s) => s.title)).toEqual(['draft', 'review'])
    expect(live.session.taskState!.notes).toBe('watch out for typos')
  })

  it('writes and reads files through the real tool implementations', async () => {
    live = await makeHarness()

    live.enqueueAssistantToolCall({
      name: 'write_file',
      args: { path: 'hello.md', content: '# Hello\n' },
    })
    live.enqueueAssistantText('wrote it')

    await runAgent('create hello.md', live.workspace, live.bridge)

    const abs = path.join(live.workspace, 'hello.md')
    expect(fs.existsSync(abs)).toBe(true)
    expect(fs.readFileSync(abs, 'utf8')).toBe('# Hello\n')
  })

  it('routes write_file through hunk-review when approvalForFileOps is on', async () => {
    live = await makeHarness({
      seedFiles: { 'a.txt': 'one\ntwo\nthree\n' },
      configOverrides: { approvalForFileOps: true },
    })

    live.enqueueAssistantToolCall({
      name: 'write_file',
      args: { path: 'a.txt', content: 'one\nTWO\nthree\n' },
    })
    live.enqueueAssistantText('done')

    await runAgent('edit a.txt', live.workspace, live.bridge)

    expect(live.hunkReviewCalls.length).toBe(1)
    const review = live.hunkReviewCalls[0]
    expect(review.toolName).toBe('write_file')
    expect(review.filePath).toBe('a.txt')
    expect(review.hunks.length).toBeGreaterThan(0)

    // accept_all stub → file on disk equals newContent from the review.
    const abs = path.join(live.workspace, 'a.txt')
    expect(fs.readFileSync(abs, 'utf8')).toBe('one\nTWO\nthree\n')

    // Agent must see a friendly success string in tool_result.
    const toolResult = live.events.find((e) => e.type === 'tool_result')
    expect(toolResult).toBeTruthy()
    expect(toolResult.result).toMatch(/Created|Edited/)

    // A `hunk_review` event must have been emitted for the UI.
    const reviewEvent = live.events.find((e) => e.type === 'hunk_review')
    expect(reviewEvent).toBeTruthy()
    expect(reviewEvent.hunkReview.filePath).toBe('a.txt')
  })

  it('rejecting the hunk review keeps the file unchanged', async () => {
    live = await makeHarness({
      seedFiles: { 'b.txt': 'alpha\nbeta\n' },
      configOverrides: { approvalForFileOps: true },
    })
    live.setHunkReviewResponder(() => ({ decision: 'reject' }))

    live.enqueueAssistantToolCall({
      name: 'write_file',
      args: { path: 'b.txt', content: 'ALPHA\nBETA\n' },
    })
    live.enqueueAssistantText('ok')

    await runAgent('edit b.txt', live.workspace, live.bridge)

    const abs = path.join(live.workspace, 'b.txt')
    // Untouched — rejection must not write anything.
    expect(fs.readFileSync(abs, 'utf8')).toBe('alpha\nbeta\n')
    const toolResult = live.events.find((e) => e.type === 'tool_result')
    expect(toolResult.result).toMatch(/Denied by user/)
  })

  it('accept_selected applies only the chosen hunks (other hunks are kept old)', async () => {
    const original =
      ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9', 'l10', 'l11', 'l12'].join('\n') + '\n'
    live = await makeHarness({
      seedFiles: { 'c.txt': original },
      configOverrides: { approvalForFileOps: true },
    })

    // The LLM proposes to change two distant lines (2 and 11) — expect two hunks.
    const modified =
      ['l1', 'CHANGED2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9', 'l10', 'CHANGED11', 'l12'].join('\n') + '\n'

    // Stub: accept only hunk 0 (the first change), reject hunk 1.
    live.setHunkReviewResponder((review) => {
      expect(review.hunks.length).toBeGreaterThanOrEqual(2)
      return { decision: 'accept_selected', selectedHunkIds: [review.hunks[0].id] }
    })

    live.enqueueAssistantToolCall({
      name: 'write_file',
      args: { path: 'c.txt', content: modified },
    })
    live.enqueueAssistantText('partial')

    await runAgent('edit c.txt', live.workspace, live.bridge)

    const abs = path.join(live.workspace, 'c.txt')
    const onDisk = fs.readFileSync(abs, 'utf8')
    const lines = onDisk.split('\n')
    // First hunk applied:
    expect(lines[1]).toBe('CHANGED2')
    // Second hunk rejected:
    expect(lines[10]).toBe('l11')
  })

  // ---------------------------------------------------------------------------
  // Agent modes (chat / plan / agent)
  // ---------------------------------------------------------------------------

  describe('agent modes', () => {
    it('chat mode: sends no tools, forces tool_choice=none, embeds mode note', async () => {
      live = await makeHarness({ sessionMode: 'chat' })
      live.enqueueAssistantText('Ок, обсуждаем.')

      await runAgent('Что ты думаешь про monorepos?', live.workspace, live.bridge)

      const chat = live.fetchCalls.find((c) => c.url.endsWith('/v1/chat/completions'))!
      expect(Array.isArray(chat.body.tools)).toBe(true)
      expect(chat.body.tools.length).toBe(0)
      expect(chat.body.tool_choice).toBe('none')

      // Mode instruction must arrive as an ephemeral user message (never
      // in the system prompt — that would invalidate the KV cache on
      // every mode switch).
      const sys = chat.body.messages.find((m: any) => m.role === 'system')
      expect(sys?.content ?? '').not.toMatch(/Режим: Chat|Mode: Chat/)
      const eph = chat.body.messages.find(
        (m: any) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('Режим: Chat'),
      )
      expect(eph, 'ephemeral chat-mode note should be present').toBeTruthy()

      // And the ephemeral is NOT persisted into the session history.
      const persistedHasEphemeral = live.session.messages.some(
        (m: any) => typeof m.content === 'string' && m.content.includes('taskstate:begin'),
      )
      expect(persistedHasEphemeral).toBe(false)
    })

    it('plan mode: ships only the read-only allowlist to the LLM', async () => {
      live = await makeHarness({ sessionMode: 'plan' })
      live.enqueueAssistantText('Вот план…')

      await runAgent('спланируй', live.workspace, live.bridge)

      const chat = live.fetchCalls.find((c) => c.url.endsWith('/v1/chat/completions'))!
      const toolNames: string[] = chat.body.tools.map((t: any) => t.function.name)

      // Allowed in plan mode (read-only builtins + plan/recall):
      expect(toolNames).toContain('get_project_context')
      expect(toolNames).toContain('read_file')
      expect(toolNames).toContain('list_directory')
      expect(toolNames).toContain('find_files')
      expect(toolNames).toContain('update_plan')
      expect(toolNames).toContain('save_plan_artifact')
      expect(toolNames).toContain('update_project_memory')
      expect(toolNames).toContain('recall')

      // Forbidden in plan mode (write/exec tools):
      expect(toolNames).not.toContain('write_file')
      expect(toolNames).not.toContain('execute_command')
      expect(toolNames).not.toContain('append_file')
      expect(toolNames).not.toContain('delete_file')

      // Plan-mode instruction lives in the ephemeral message, not the
      // system prompt. Same KV-cache-preservation reasoning as above.
      const sys = chat.body.messages.find((m: any) => m.role === 'system')
      expect(sys?.content ?? '').not.toMatch(/Режим: Plan|Mode: Plan/)
      const eph = chat.body.messages.find(
        (m: any) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('Режим: Plan'),
      )
      expect(eph).toBeTruthy()
    })

    it('plan mode: blocks a tool call at dispatch if the LLM still tries', async () => {
      // Simulate a model that "remembers" write_file from a previous
      // turn even though we don't advertise it. The dispatcher-level
      // guard should step in and return a denial back to the model.
      live = await makeHarness({ sessionMode: 'plan' })
      live.enqueueAssistantToolCall({ name: 'write_file', args: { path: 'x.txt', content: 'nope' } })
      live.enqueueAssistantText('оk, я больше не буду')

      await runAgent('сделай что-нибудь', live.workspace, live.bridge)

      // File must NOT appear on disk.
      const abs = path.join(live.workspace, 'x.txt')
      expect(fs.existsSync(abs)).toBe(false)

      // The dispatcher emitted a denial through tool_result.
      const denied = live.events.find(
        (e) => e.type === 'tool_result' && e.name === 'write_file' && /Denied by mode/i.test(String(e.result ?? '')),
      )
      expect(denied, 'expected a "Denied by mode" tool_result').toBeTruthy()
    })

    it('plan mode: save_plan_artifact writes PLAN.md and emits open event', async () => {
      live = await makeHarness({ sessionMode: 'plan' })
      live.enqueueAssistantToolCall({
        name: 'save_plan_artifact',
        args: {
          content: '# PLAN\n\n## Goal\n\nShip a polished plan viewer.\n',
        },
      })
      live.enqueueAssistantText('План сохранён в PLAN.md.')

      await runAgent('спланируй красивый viewer', live.workspace, live.bridge)

      const planPath = path.join(live.workspace, 'PLAN.md')
      expect(fs.existsSync(planPath)).toBe(true)
      expect(fs.readFileSync(planPath, 'utf-8')).toContain('Ship a polished plan viewer')
      const ev = live.events.find((e) => e.type === 'plan_artifact')
      expect(ev?.planArtifactPath).toBe(planPath)
    })

    it('agent mode (default): exposes all tools and no mode note', async () => {
      live = await makeHarness({ sessionMode: 'agent' })
      live.enqueueAssistantText('поехали')

      await runAgent('привет', live.workspace, live.bridge)

      const chat = live.fetchCalls.find((c) => c.url.endsWith('/v1/chat/completions'))!
      const toolNames: string[] = chat.body.tools.map((t: any) => t.function.name)
      expect(toolNames).toContain('write_file')
      expect(toolNames).toContain('execute_command')
      expect(chat.body.tool_choice).toBe('auto')

      // Agent mode adds NO mode instruction (keep the prompt minimal
      // when there's nothing to say).
      const hasEphemeral = chat.body.messages.some(
        (m: any) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('taskstate:begin'),
      )
      expect(hasEphemeral).toBe(false)
    })
  })
})
