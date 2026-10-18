import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const BAND = {
  component: 'PromptHint' as const,
  props: {
    isDraft: false,
    isWorking: false,
    hint: '? for shortcuts',
  },
}

const PANE = {
  component: 'Pane' as const,
  requestId: 'token-meter',
  props: {
    title: 'Tokens',
    isFocused: true,
    bodyColumns: 100,
    placement: 'inline' as const,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
}

/** The engine's figures, as `$.session.usage()` answers them. */
function usageOf(percent: number, tokens: number, window = 1_000_000, usd = 0) {
  return { startedAt: 0, context: { percent, tokens, window }, rateLimits: [], cost: { usd } }
}

/** A usage answer with no live figures, as a gateway reporting no input leaves it. */
function bareUsage(window = 1_000_000) {
  return { startedAt: 0, context: { window }, rateLimits: [], cost: { usd: 0 } }
}

/**
 * The engine calls the meter makes, answered beneath the plugin: the session's
 * usage, the command registry, the store and compaction. Answers what the
 * store kept and whether compaction ran.
 */
function mockEngine(
  on: On,
  usage: () => ReturnType<typeof usageOf> | ReturnType<typeof bareUsage> = () => usageOf(20, 200_000),
): {
  stored: Record<string, unknown>
  compactions: number
  clock: ReturnType<typeof mock.clock>
} {
  const stored: Record<string, unknown> = {}
  const state = { compactions: 0 }
  const clock = mock.clock(on)
  on('session.usage', ($, e, next) => {
    void next
    const answered = usage()
    if (e.breakdown !== undefined) {
      return {
        value: {
          ...answered,
          context: {
            ...answered.context,
            breakdown: {
              totalTokens: 53_398,
              percentage: 5,
              categories: [],
              maxTokens: 1_000_000,
              rawMaxTokens: 1_000_000,
              autocompactSource: 'auto',
              gridRows: [],
              model: 'global:model-a',
              memoryFiles: [],
              mcpTools: [],
              agents: [],
              isAutoCompactEnabled: true,
            } as never,
          },
        },
      }
    }
    return { value: answered }
  })
  on('session.compact', ($, e, next) => {
    void e
    void next
    state.compactions += 1
    return {
      messages: [{ role: 'user', text: 'summary', toolUses: [] } as never],
      tokensBefore: 900_000,
      tokensAfter: 100_000,
    }
  })
  on('command.register', ($, e, next) => {
    void next
    return { value: { command: e.name } }
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
  on('ui.open', ($, e, next) => {
    void e
    void next
    return { value: { isPlaced: true } }
  })
  // The engine's own answers for the two events the meter hooks: a turn ends
  // and starts with nothing of core's to add here.
  on('turn.complete', ($, e, next) => {
    void e
    void next
    return { text: 'ok' }
  })
  on('turn.start', ($, e, next) => {
    void e
    void next
    return { turnId: 't1' }
  })
  return {
    stored,
    get compactions() {
      return state.compactions
    },
    clock,
  }
}

/** One finished turn, as the engine reports it. */
async function finishTurn(
  $: Engine,
  usage: {
    model: string
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  },
): Promise<void> {
  await $.turn.complete({
    answer: 'done',
    durationMs: 1000,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
    usage: {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      model: usage.model,
    },
  })
}

test('the band shows context and the session cost', async ($, on) => {
  mockEngine(on, () => usageOf(42, 420_000, 1_000_000, 0.42))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'token-meter', surface, ...BAND })
    expect(await ui.find({ text: /42%/ })).toBeDefined()
    expect(await ui.find({ text: /420k\/1\.00M/ })).toBeDefined()
    expect(await ui.find({ text: /\$0\.42/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a click on the band opens the meter', async ($, on) => {
  mockEngine(on)
  const ui = await $.ui.mount({ plugin: 'token-meter', surface: 'terminal', ...BAND })
  await ui.press({ key: 'tokens-open' })
  await ui.unmount()
})

test('a finished turn adds to the ledger, priced from the table', async ($, on) => {
  const engine = mockEngine(on)
  engine.stored.prices = { 'global:model-a': { input: 1, output: 2 } }

  // The stored price is read at session start; the turn is then priced.
  await finishTurn($, {
    model: 'global:model-a',
    input_tokens: 1_000_000,
    output_tokens: 500_000,
  })

  const pane = await $.ui.mount({ plugin: 'token-meter', surface: 'terminal', ...PANE })
  expect(await pane.find({ text: /global:model-a/ })).toBeDefined()
  // 1M in at $1 + 0.5M out at $2 = $2.00.
  expect(await pane.find({ text: /\$2\.00/ })).toBeDefined()
  expect(await pane.find({ text: /1\.00M/ })).toBeDefined()
  await pane.unmount()
})

test('a model with no price is marked unpriced, not costed as zero', async ($, on) => {
  mockEngine(on)
  await finishTurn($, { model: 'global:unknown', input_tokens: 500, output_tokens: 100 })

  const pane = await $.ui.mount({ plugin: 'token-meter', surface: 'terminal', ...PANE })
  expect(await pane.find({ text: /unpriced/ })).toBeDefined()
  expect(await pane.find({ text: /Set a price for global:unknown/ })).toBeDefined()
  await pane.unmount()
})

test('a price typed into the pane is remembered and applied', async ($, on) => {
  const engine = mockEngine(on)
  await finishTurn($, { model: 'global:model-a', input_tokens: 1_000_000, output_tokens: 0 })

  const pane = await $.ui.mount({ plugin: 'token-meter', surface: 'terminal', ...PANE })
  expect(await pane.find({ text: /unpriced/ })).toBeDefined()
  await pane.press({ key: 'price:global:model-a' })
  await pane.input({ key: 'price-input:global:model-a', text: '3,6' })
  // The price lands in the store for the next session too.
  expect(engine.stored.prices).toEqual({ 'global:model-a': { input: 3, output: 6 } })
  await pane.unmount()
})

test('the guard compacts once the context passes the limit', async ($, on) => {
  let percent = 10
  const engine = mockEngine(on, () => usageOf(percent, percent * 10_000))
  const ui = await $.ui.mount({ plugin: 'token-meter', surface: 'terminal', ...BAND })
  expect(await ui.find({ text: /10%/ })).toBeDefined()

  // A turn starts: the ticker reads the context, and the guard sees it cross.
  await $.turn.start({ text: 'go', turnId: 't1' })
  percent = 90
  await engine.clock.advance(2500)
  expect(engine.compactions).toBe(1)

  // The same percentage does not compact again.
  await engine.clock.advance(2500)
  expect(engine.compactions).toBe(1)
  await ui.unmount()
})

test('with the guard off, no compaction happens', { options: { compactAt: 0 } }, async ($, on) => {
  const engine = mockEngine(on, () => usageOf(95, 950_000))
  await $.turn.start({ text: 'go', turnId: 't1' })
  await engine.clock.advance(2500)
  expect(engine.compactions).toBe(0)
})

test('the band can be turned off', { options: { showBand: false } }, async ($, on) => {
  mockEngine(on)
  on('ui.render', { component: 'PromptHint' }, ($, e, next) => {
    void next
    const { Box, Text } = $.ui.resolve(e)
    return <Box><Text>plain</Text></Box>
  })
  const ui = await $.ui.mount({ plugin: 'token-meter', surface: 'terminal', ...BAND })
  expect(await ui.find({ key: 'tokens-open' })).toBeUndefined()
  await ui.unmount()
})

test('a gateway that reports no input still fills the context from the estimate', async ($, on) => {
  // The plain call has no tokens or percent, as a proxy that sends
  // `input_tokens: 0` leaves them; the breakdown estimates them locally.
  const engine = mockEngine(on, () => bareUsage())
  const ui = await $.ui.mount({ plugin: 'token-meter', surface: 'terminal', ...BAND })
  expect(await ui.find({ text: /5%/ })).toBeDefined()
  expect(await ui.find({ text: /53k\/1\.00M/ })).toBeDefined()
  await ui.unmount()
  void engine
})

test('a turn with no reported input is priced from the estimate, not as free', async ($, on) => {
  const engine = mockEngine(on)
  engine.stored.prices = { 'global:model-a': { input: 1, output: 0 } }
  await finishTurn($, { model: 'global:model-a', input_tokens: 0, output_tokens: 0 })

  const pane = await $.ui.mount({ plugin: 'token-meter', surface: 'terminal', ...PANE })
  // 53,398 estimated input tokens at $1/M is $0.05, not $0.00.
  expect(await pane.find({ text: /\$0\.05/ })).toBeDefined()
  await pane.unmount()
})
