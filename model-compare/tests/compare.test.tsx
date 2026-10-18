import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ModelApiError, On, Register } from 'claude-code'

const HINT = {
  component: 'PromptHint' as const,
  props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
}

const PANE = {
  component: 'Pane' as const,
  requestId: 'model-compare',
  props: {
    title: 'Compare',
    isFocused: true,
    bodyColumns: 100,
    placement: 'inline' as const,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
}

const MODELS = {
  data: [
    { id: 'cn:model-a' },
    { id: 'global:model-b' },
    { id: 'global:model-c' },
  ],
}

/** A reply the mocked call returns: text, or an API error arm. */
type Reply = { text: string } | { status: number; error: ModelApiError }

/**
 * The engine calls the plugin makes, answered beneath it: the gateway read, the
 * pane, the session's model, the prompt box, the store and both completions.
 * Answers the opened pane ids and the model calls in the order they were made.
 *
 * The file system answers with one folder, `proj`, holding two: `alpha` and
 * `beta`. A task run's agents are recorded, and start with no answer: the test
 * raises each one's `turn.complete` itself.
 *
 * A task's model reaches its agent through a type registered for it, so the
 * registrations are recorded too: `tasks[i].model` is the model of the type
 * that spawn names.
 */
function mockEngine(
  on: On,
  replies: Record<string, Reply> = {},
  judgeReply?: (prompt: string) => string,
): {
  opened: string[]
  calls: { model: string; prompt: string }[]
  tasks: { model: string; prompt: string; cwd?: string }[]
  clock: ReturnType<typeof mock.clock>
  stored: Record<string, unknown>
} {
  const opened: string[] = []
  // What the plugin has kept across sessions, keyed as `$.store` holds it.
  const stored: Record<string, unknown> = {}
  const calls: { model: string; prompt: string }[] = []
  const tasks: { model: string; prompt: string; cwd?: string }[] = []
  // The types the plugin registers: a spawn names one, and runs on its model.
  const types = new Map<string, string>()
  // The engine's clock, held still: a running column counts from it, and only
  // an advance moves its seconds on.
  const clock = mock.clock(on)
  mock.env(on, { ANTHROPIC_BASE_URL: 'http://gateway.test', ANTHROPIC_AUTH_TOKEN: 'test-token' })
  on('http.fetch', ($, e, next) => {
    if (!e.url.endsWith('/v1/models')) return next(e)
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(MODELS) } }
  })
  on('command.register', ($, e, next) => {
    void next
    return { value: { command: e.name } }
  })
  on('session.model', ($, e, next) => {
    void e
    void next
    return { value: 'cn:model-a' }
  })
  on('session.cwd', ($, e, next) => {
    void e
    void next
    return { value: 'C:\\proj' }
  })
  on('fs.list', ($, e, next) => {
    void next
    if (e.path !== 'C:\\proj') return { value: [] }
    return {
      value: [
        { name: 'alpha', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
        { name: 'beta', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
        { name: 'README.md', kind: 'file', size: 10, mtimeMs: 0, isLink: false },
      ],
    }
  })
  on('fs.stat', ($, e, next) => {
    void next
    const real = e.path.replace(/[\\/]+$/, '')
    if (!/^C:\\proj(\\[^\\]+)?$/.test(real)) return { deny: 'ENOENT' }
    return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: real } }
  })
  // The test stands in for core, which is what mints an agent's id: a hook
  // that answers without passing the spawn on started none, so the id rides
  // the `result` core answers with. A task's model rides its type, which the
  // plugin registers: a spawn naming one runs on the model it was made with.
  on('agent.register', ($, e, next) => {
    void next
    const agent = `model-compare:${e.name}`
    types.set(agent, e.model ?? '')
    return { value: { agent } }
  })
  on('agent.spawn', ($, e, next) => {
    void next
    // The kit hands the event the Agent call's own spelling, `subagent_type`.
    const asCall = e as unknown as { subagentType?: string; subagent_type?: string }
    const type = asCall.subagentType ?? asCall.subagent_type ?? ''
    const model = e.model ?? types.get(type) ?? ''
    tasks.push({ model, prompt: e.prompt, cwd: e.cwd })
    return { model, result: { resolvedModel: model, agentId: `agent-${tasks.length}` } }
  })
  on('turn.complete', ($, e, next) => {
    void e
    void next
    return { text: 'ok' }
  })
  on('session.send', ($, e, next) => {
    void e
    void next
    return { isDelivered: true }
  })
  on('ui.open', ($, e, next) => {
    void next
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('store.get', ($, e, next) => {
    void next
    return { value: stored[e.key as string] }
  })
  on('store.set', ($, e, next) => {
    void next
    stored[e.key as string] = e.value
    return { value: undefined }
  })
  on('prompt.read', ($, e, next) => {
    void e
    void next
    return { value: { text: 'hello', cursor: 5 } }
  })
  on('session.messages', ($, e, next) => {
    void e
    void next
    return { value: [] }
  })
  // The engine's own line, for a test whose plugin passes the hint through.
  on('ui.render', { component: 'PromptHint' }, ($, e, next) => {
    void next
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text>{e.props.hint}</Text>
      </Box>
    )
  })
  on('model.complete', ($, e, next) => {
    void next
    calls.push({ model: e.model, prompt: e.prompt })
    const usage = {
      input_tokens: 12,
      output_tokens: 34,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    }
    const reply = replies[e.model]
    if (reply !== undefined && !('text' in reply)) {
      return {
        value: { isAnswered: false, reason: 'api-error', status: reply.status, error: reply.error, usage },
      }
    }
    if (judgeReply !== undefined && e.prompt.startsWith('You are a strict, impartial judge')) {
      return {
        value: {
          isAnswered: true,
          text: judgeReply(e.prompt),
          usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      }
    }
    return {
      value: { isAnswered: true, text: reply?.text ?? `${e.model} says hi`, usage },
    }
  })
  return { opened, calls, tasks, clock, stored }
}

/** Opens the comparison from the dot, then hands back the pane's drawing. */
async function runFromDot($: Engine) {
  const hint = await $.ui.mount({ plugin: 'model-compare', surface: 'terminal', ...HINT })
  await hint.press({ key: 'compare-dot' })
  await hint.unmount()
  return $.ui.mount({ plugin: 'model-compare', surface: 'terminal', ...PANE })
}

/** Opens the comparison with a judge reply wired in before anything mounts. */
async function runFromDotWithJudge($: Engine, on: On, judgeReply: (prompt: string) => string) {
  const pane = await runFromDotWith($, on, {}, judgeReply)
  return pane
}

async function runFromDotWith(
  $: Engine,
  on: On,
  replies: Record<string, Reply>,
  judgeReply?: (prompt: string) => string,
) {
  mockEngine(on, replies, judgeReply)
  return runFromDot($)
}

test('the model judge scores both answers blind and fills the ratings', async ($, on) => {
  // The judge's mock reply scores whichever answer text sits under A 9 and the
  // other 7 — the plugin may have flipped the order, and the judge sees only
  // anonymous A/B, so the reply is built from the prompt it was sent.
  const pane = await runFromDotWithJudge($, on, prompt => {
    const aIsBetter = /<answer A>[\s\S]*<\/answer A>/.exec(prompt)?.[0].includes('BETTER') ?? false
    return `A: ${aIsBetter ? 9 : 7}\nB: ${aIsBetter ? 7 : 9}\nWinner: ${aIsBetter ? 'A' : 'B'}\nReason: the first is more precise.`
  })
  await pane.press({ key: 'run' })
  expect(await pane.find({ text: /Rate both columns/ })).toBeDefined()

  await pane.press({ key: 'judge' })
  // The verdict lands on the pane with scores and the judge's reason, and the
  // 5-star ratings are filled from it.
  expect(await pane.find({ text: /Judge: 9\/10 vs 7\/10/ })).toBeDefined()
  expect(await pane.find({ text: /the first is more precise/ })).toBeDefined()
  expect(await pane.find({ key: 'rate:0:5' })).toBeDefined()
  await pane.unmount()
})

test('the green dot sits beside the prompt and a press opens the comparison', async ($, on) => {
  const { opened, calls } = mockEngine(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'model-compare', surface, ...HINT })
    expect(await ui.find({ key: 'compare-dot' })).toBeDefined()
    expect(await ui.find({ text: /●/ })).toBeDefined()
    expect(await ui.find({ text: /\? for shortcuts/ })).toBeDefined()
    await ui.press({ key: 'compare-dot' })
    await ui.unmount()
  }
  expect(opened).toEqual(['model-compare', 'model-compare'])
  expect(calls).toHaveLength(4)
  expect(calls[0]?.prompt).toBe('hello')
  expect(calls[0]?.model).not.toBe(calls[1]?.model)
})

/**
 * A stand-in for the other plugin that draws the same hint line, as the real
 * one does: a dot of its own, then whatever is beneath it.
 */
const rival: { name: string; register: Register } = {
  name: 'rival',
  register: on => {
    on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
      let below: JSX.Element | undefined
      try {
        below = await next(e)
      } catch {
        below = undefined
      }
      const { Box, Button, Text } = $.ui.resolve(e)
      return (
        <Box>
          <Button key="rival-dot" plain onPress={() => {}}>
            <Text>RIVAL</Text>
          </Button>
          {below}
        </Box>
      )
    })
  },
}

test('the dot leads the line and the hint beneath it still draws', async ($, on) => {
  mockEngine(on)
  const ui = await $.ui.mount({ plugin: 'model-compare', surface: 'terminal', ...HINT })
  expect(await ui.find({ key: 'compare-dot' })).toBeDefined()
  // The line beneath this hook is nested under the dot, not dropped.
  expect(await ui.find({ text: /\? for shortcuts/ })).toBeDefined()
  await ui.unmount()
})

test('a plugin beneath that draws the line is nested after the dot', { plugins: [rival] }, async ($, on) => {
  mockEngine(on)
  const ui = await $.ui.mount({ plugin: 'model-compare', surface: 'terminal', ...HINT })
  expect(await ui.find({ key: 'compare-dot' })).toBeDefined()
  expect(await ui.find({ text: /RIVAL/ })).toBeDefined()
  await ui.unmount()
})

test('with the dot off, the line beneath is left to draw', { options: { showDot: false }, plugins: [rival] }, async ($, on) => {
  mockEngine(on)
  const ui = await $.ui.mount({ plugin: 'model-compare', surface: 'terminal', ...HINT })
  expect(await ui.find({ key: 'compare-dot' })).toBeUndefined()
  expect(await ui.find({ text: /RIVAL/ })).toBeDefined()
  await ui.unmount()
})

test('the dot still draws when nothing beneath answers the line', async $ => {
  // No render hook beneath this one: the hook's `next` has nowhere to go.
  const ui = await $.ui.mount({ plugin: 'model-compare', surface: 'terminal', ...HINT })
  expect(await ui.find({ key: 'compare-dot' })).toBeDefined()
  expect(await ui.find({ text: /\? for shortcuts/ })).toBeDefined()
  await ui.unmount()
})

test('the pane draws both answers with their token counts', async ($, on) => {
  mockEngine(on)
  const pane = await runFromDot($)
  expect(await pane.find({ text: /cn:model-a says hi/ })).toBeDefined()
  expect(await pane.find({ text: /global:model-b says hi/ })).toBeDefined()
  expect(await pane.find({ text: /in 12 \/ out 34 tok/ })).toBeDefined()
  expect(await pane.find({ text: /2\/2 answered/ })).toBeDefined()
  expect(await pane.find({ key: 'run' })).toBeDefined()
  expect(await pane.find({ key: 'swap' })).toBeDefined()
  expect(await pane.find({ key: 'close' })).toBeDefined()
  await pane.unmount()
})

test('an API error column says its status and kind', async ($, on) => {
  mockEngine(on, { 'cn:model-a': { status: 429, error: 'rate_limit' } })
  const pane = await runFromDot($)
  expect(await pane.find({ text: /API error · 429 · rate_limit/ })).toBeDefined()
  expect(await pane.find({ text: /1\/2 answered/ })).toBeDefined()
  expect(await pane.find({ text: /global:model-b says hi/ })).toBeDefined()
  await pane.unmount()
})

test('a reply holding an escape sequence still draws the pane', async ($, on) => {
  mockEngine(on, { 'cn:model-a': { text: 'Bold \u001b[1mword\u001b[22m here' } })
  const pane = await runFromDot($)
  expect(await pane.find({ text: /Bold word here/ })).toBeDefined()
  expect(await pane.find({ text: /\u001b/ })).toBeUndefined()
  await pane.unmount()
})

test('the dot can be turned off in the config', { options: { showDot: false } }, async ($, on) => {
  mockEngine(on)
  const ui = await $.ui.mount({ plugin: 'model-compare', surface: 'terminal', ...HINT })
  expect(await ui.find({ key: 'compare-dot' })).toBeUndefined()
  await ui.unmount()
})

test('each column is picked from the gateway list, and the pick is what is asked', async ($, on) => {
  const { calls } = mockEngine(on)
  const pane = await runFromDot($)
  const left = await pane.find({ key: 'left-model' })
  expect(left?.type).toBe('Select')
  expect(left?.props.options).toEqual([
    { value: 'cn:model-a', label: 'cn:model-a' },
    { value: 'global:model-b', label: 'global:model-b' },
    { value: 'global:model-c', label: 'global:model-c' },
  ])
  await pane.select({ key: 'left-model', value: 'global:model-c' })
  await pane.press({ key: 'run' })
  expect(calls.at(-2)?.model).toBe('global:model-c')
  await pane.unmount()
})

test('the prompt typed in the pane is what the next run asks', async ($, on) => {
  const { calls } = mockEngine(on)
  const pane = await runFromDot($)
  // The pane holds the keyboard, so the prompt it compares is edited here.
  await pane.input({ key: 'prompt', text: 'a different question' })
  await pane.press({ key: 'run' })
  expect(calls.at(-2)?.prompt).toBe('a different question')
  expect(calls.at(-1)?.prompt).toBe('a different question')
  await pane.unmount()
})

test('a column outside the list is typed in through its pencil', async ($, on) => {
  mockEngine(on)
  const pane = await runFromDot($)
  expect(await pane.find({ key: 'left' })).toBeUndefined()
  await pane.press({ key: 'left-type' })
  expect(await pane.find({ key: 'left' })).toBeDefined()
  expect(await pane.find({ key: 'left-model' })).toBeUndefined()
  await pane.unmount()
})

test('the pane draws on mobile without the typing fields', async ($, on) => {
  mockEngine(on)
  const hint = await $.ui.mount({ plugin: 'model-compare', surface: 'mobile', ...HINT })
  await hint.press({ key: 'compare-dot' })
  await hint.unmount()
  const pane = await $.ui.mount({ plugin: 'model-compare', surface: 'mobile', ...PANE })
  expect(await pane.find({ key: 'left' })).toBeUndefined()
  expect(await pane.find({ key: 'right' })).toBeUndefined()
  expect(await pane.find({ key: 'prompt' })).toBeUndefined()
  expect(await pane.find({ key: 'run' })).toBeDefined()
  expect(await pane.find({ text: /cn:model-a says hi/ })).toBeDefined()
  await pane.unmount()
})

/** Opens the pane in task mode, with both folders picked from the session's own. */
async function runTaskFromDot($: Engine) {
  const pane = await runFromDot($)
  await pane.press({ key: 'mode-task' })
  await pane.select({ key: 'left-dir', value: 'C:\\proj\\alpha' })
  await pane.select({ key: 'right-dir', value: 'C:\\proj\\beta' })
  return pane
}

test('a task run spawns one agent per column, each in its own folder', async ($, on) => {
  const { tasks, clock } = mockEngine(on)
  const pane = await runTaskFromDot($)
  await pane.press({ key: 'run' })
  expect(tasks).toHaveLength(2)
  expect(tasks[0]?.cwd).toBe('C:\\proj\\alpha')
  expect(tasks[1]?.cwd).toBe('C:\\proj\\beta')
  expect(tasks[0]?.model).not.toBe(tasks[1]?.model)
  // The folder is stated in the task itself, for a build that leaves `cwd`
  // to the parent: an agent told where to work starts in the right place.
  expect(tasks[0]?.prompt).toContain('C:\\proj\\alpha')
  expect(tasks[0]?.prompt).toContain('hello')
  expect(tasks[1]?.prompt).toContain('C:\\proj\\beta')
  // Both columns are drawn at once, counting their seconds as they wait.
  expect(await pane.find({ text: /running 0\.0s/ })).toBeDefined()
  await clock.advance(2000)
  expect(await pane.find({ text: /running 2\.0s/ })).toBeDefined()
  await pane.unmount()
})

test('a task runs each column on its own gateway id', async ($, on) => {
  const { tasks } = mockEngine(on)
  const pane = await runTaskFromDot($)
  await pane.press({ key: 'run' })
  // The Agent tool's own `model` takes an alias alone. Each column's model is
  // registered as a type of its own instead, and its spawn names that type.
  expect(tasks).toHaveLength(2)
  expect(tasks[0]?.model).toBe('cn:model-a')
  expect(tasks[1]?.model).toBe('global:model-b')
  await pane.unmount()
})

test('each agent’s end fills its own column', async ($, on) => {
  const { tasks, clock } = mockEngine(on)
  const pane = await runTaskFromDot($)
  await pane.press({ key: 'run' })
  await clock.advance(2500)

  await $.turn.complete({
    answer: 'left did it',
    durationMs: 2500,
    isAborted: false,
    turnId: 't1',
    agentId: 'agent-1',
    reason: 'answer',
    usage: {
      input_tokens: 5,
      output_tokens: 7,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      model: tasks[0]?.model ?? '',
    },
  })
  expect(await pane.find({ text: /left did it/ })).toBeDefined()
  expect(await pane.find({ text: /2\.5s · in 5 \/ out 7 tok/ })).toBeDefined()
  expect(await pane.find({ text: /1\/2 answered/ })).toBeDefined()

  await $.turn.complete({
    answer: 'right did it',
    durationMs: 4000,
    isAborted: false,
    turnId: 't2',
    agentId: 'agent-2',
    reason: 'answer',
  })
  expect(await pane.find({ text: /right did it/ })).toBeDefined()
  expect(await pane.find({ text: /2\/2 answered/ })).toBeDefined()
  await pane.unmount()
})

test('a task run refuses two columns in one folder', async ($, on) => {
  const { tasks } = mockEngine(on)
  const pane = await runFromDot($)
  await pane.press({ key: 'mode-task' })
  await pane.select({ key: 'left-dir', value: 'C:\\proj\\alpha' })
  await pane.select({ key: 'right-dir', value: 'C:\\proj\\alpha' })
  // The pane says the pair is wrong as it is picked, before Run is pressed.
  expect(await pane.find({ text: /Both columns pick the same folder/ })).toBeDefined()
  await pane.press({ key: 'run' })
  expect(tasks).toHaveLength(0)
  expect(await pane.find({ text: /different folders/ })).toBeDefined()
  await pane.unmount()
})

test('a failing column can be asked again on its own', async ($, on) => {
  const { calls } = mockEngine(on, { 'cn:model-a': { status: 429, error: 'rate_limit' } })
  const pane = await runFromDot($)
  expect(await pane.find({ text: /API error · 429 · rate_limit/ })).toBeDefined()
  expect(await pane.find({ key: 'retry:0' })).toBeDefined()
  // One column asked again: the other's answer is not paid for twice.
  await pane.press({ key: 'retry:0' })
  expect(calls).toHaveLength(3)
  expect(calls[2]?.model).toBe('cn:model-a')
  await pane.unmount()
})

test('a running column counts its seconds up', async ($, on) => {
  const { clock } = mockEngine(on)
  const pane = await runTaskFromDot($)
  await pane.press({ key: 'run' })
  expect(await pane.find({ text: /running 0\.0s/ })).toBeDefined()
  await clock.advance(12_000)
  expect(await pane.find({ text: /running 12\.0s/ })).toBeDefined()
  await pane.unmount()
})

test('a task run refuses a folder that is not there', async ($, on) => {
  const { tasks } = mockEngine(on)
  const pane = await runFromDot($)
  await pane.press({ key: 'mode-task' })
  await pane.select({ key: 'left-dir', value: 'C:\\proj\\alpha' })
  await pane.select({ key: 'right-dir', value: 'C:\\proj\\beta' })
  await pane.press({ key: 'right-dir-type' })
  await pane.input({ key: 'right-dir', text: 'C:\\nowhere' })
  await pane.press({ key: 'run' })
  expect(tasks).toHaveLength(0)
  expect(await pane.find({ text: /No folder at C:\\nowhere/ })).toBeDefined()
  await pane.unmount()
})

test('each run asks for its folders again', async ($, on) => {
  const { tasks } = mockEngine(on)
  const pane = await runTaskFromDot($)
  await pane.press({ key: 'run' })
  expect(tasks).toHaveLength(2)

  // Both agents end; the run is over.
  for (const agentId of ['agent-1', 'agent-2']) {
    await $.turn.complete({
      answer: `${agentId} done`,
      durationMs: 1000,
      isAborted: false,
      turnId: `t-${agentId}`,
      agentId,
      reason: 'answer',
    })
  }

  // The picks were used once: pressing Run again has nothing to run in.
  await pane.press({ key: 'run' })
  expect(tasks).toHaveLength(2)
  expect(await pane.find({ text: /Pick a folder for each column/ })).toBeDefined()

  // Picking a fresh pair runs again, in the new folders.
  await pane.select({ key: 'left-dir', value: 'C:\\proj\\beta' })
  await pane.select({ key: 'right-dir', value: 'C:\\proj\\alpha' })
  await pane.press({ key: 'run' })
  expect(tasks).toHaveLength(4)
  expect(tasks[2]?.cwd).toBe('C:\\proj\\beta')
  expect(tasks[3]?.cwd).toBe('C:\\proj\\alpha')
  await pane.unmount()
})

test('cancel drops a task’s late answer', async ($, on) => {
  mockEngine(on)
  const pane = await runTaskFromDot($)
  await pane.press({ key: 'run' })
  await pane.press({ key: 'cancel' })
  expect(await pane.find({ text: /Cancelled/ })).toBeDefined()

  await $.turn.complete({
    answer: 'too late',
    durationMs: 100,
    isAborted: false,
    turnId: 't1',
    agentId: 'agent-1',
    reason: 'answer',
  })
  expect(await pane.find({ text: /too late/ })).toBeUndefined()
  await pane.unmount()
})

test('a finished column shows its generation speed', async ($, on) => {
  const { tasks, clock } = mockEngine(on)
  const pane = await runTaskFromDot($)
  await pane.press({ key: 'run' })
  await clock.advance(2500)
  // A task's end carries its own duration: 7 tokens over 2.5s.
  await $.turn.complete({
    answer: 'left did it',
    durationMs: 2500,
    isAborted: false,
    turnId: 't1',
    agentId: 'agent-1',
    reason: 'answer',
    usage: {
      input_tokens: 5,
      output_tokens: 7,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      model: tasks[0]?.model ?? '',
    },
  })
  expect(await pane.find({ text: /2\.5s · in 5 \/ out 7 tok · 2\.8 tok\/s/ })).toBeDefined()
  await pane.unmount()
})

test('blind mode hides which model is which until revealed', async ($, on) => {
  mockEngine(on)
  const pane = await runFromDot($)
  expect(await pane.find({ text: /cn:model-a/ })).toBeDefined()

  await pane.press({ key: 'blind' })
  expect(await pane.find({ text: /Column A/ })).toBeDefined()
  expect(await pane.find({ text: /Column B/ })).toBeDefined()
  // The columns' headings are the lettered ones now; the pickers keep the ids,
  // for the person setting the bout already knows what runs.
  const headings = await pane.findAll({ text: /^Column [AB]$/ })
  expect(headings).toHaveLength(2)

  await pane.press({ key: 'blind' })
  expect(await pane.find({ text: /cn:model-a/ })).toBeDefined()
  await pane.unmount()
})

test('rating both columns names a winner and keeps it to history', async ($, on) => {
  const { stored } = mockEngine(on)
  const pane = await runFromDot($)
  expect(await pane.find({ text: /Rate both columns/ })).toBeDefined()

  // Left rates 5, right rates 3: the left column wins.
  await pane.press({ key: 'rate:0:5' })
  await pane.press({ key: 'rate:1:3' })
  expect(await pane.find({ text: /Winner: left, 5★ to 3★/ })).toBeDefined()

  await pane.press({ key: 'keep-verdict' })
  const kept = stored.verdicts as { models: [string, string]; winner: number }[] | undefined
  expect(kept).toHaveLength(1)
  expect(kept?.[0]?.models).toEqual(['cn:model-a', 'global:model-b'])
  expect(kept?.[0]?.winner).toBe(0)
  await pane.unmount()
})

test('a tie keeps no winner, and history says who leads a rematch', async ($, on) => {
  const { stored } = mockEngine(on)
  stored.verdicts = [
    {
      models: ['cn:model-a', 'global:model-b'],
      winner: 0,
      prompt: 'earlier',
      at: '2026-10-17 09:00',
    },
  ]
  const pane = await runFromDot($)
  await pane.press({ key: 'rate:0:4' })
  await pane.press({ key: 'rate:1:4' })
  expect(await pane.find({ text: /Tie at 4★/ })).toBeDefined()

  await pane.press({ key: 'keep-verdict' })
  expect((stored.verdicts as unknown[]).length).toBe(2)
  // The rematch's verdict sits first, newest first.
  expect((stored.verdicts as { winner: number }[])[0]?.winner).toBeNull()
  await pane.unmount()
})
