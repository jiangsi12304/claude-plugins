import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const BAND = {
  component: 'AbovePrompt' as const,
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
}

const PANE = {
  component: 'Pane' as const,
  requestId: 'model-picker',
  props: {
    title: 'Models',
    isFocused: true,
    bodyColumns: 100,
    placement: 'inline' as const,
    scroll: { offset: 0, bodyRows: 16 },
    view: {},
  },
}

const MODELS = {
  data: [
    {
      id: 'cn:model-a',
      name: 'Model A',
      context_length: 1000000,
      reasoning_supported_efforts: ['low', 'high', 'max'],
      reasoning_default_effort: 'high',
    },
    {
      id: 'global:model-b',
      name: 'Model B',
      context_length: 1000000,
      reasoning_supported_efforts: ['medium'],
    },
    { id: 'global:plain', name: 'Plain', context_length: 128000 },
  ],
}

/**
 * The engine calls the picker makes, answered beneath the plugin: the gateway
 * read, the pane, the session's model, the command registry and the store.
 * Answers the switched-to ids.
 */
function mockEngine(
  on: On,
  sessionModel = 'cn:model-a',
  models: unknown = MODELS,
): { switched: string[]; efforts: string[] } {
  const switched: string[] = []
  const efforts: string[] = []
  mock.env(on, { ANTHROPIC_BASE_URL: 'http://gateway.test', ANTHROPIC_AUTH_TOKEN: 'test-token' })
  on('http.fetch', ($, e, next) => {
    if (!e.url.endsWith('/v1/models')) return next(e)
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(models) } }
  })
  on('command.run', { command: 'model' }, ($, e, next) => {
    if (e.origin.kind !== 'plugin') return next(e)
    switched.push(e.args)
    return { text: `Set model to \`${e.args}\`` }
  })
  on('command.run', { command: 'effort' }, ($, e, next) => {
    if (e.origin.kind !== 'plugin') return next(e)
    efforts.push(e.args)
    return { text: `Set effort level to ${e.args}` }
  })
  on('command.register', ($, e, next) => {
    void next
    return { value: { command: e.name } }
  })
  on('session.model', ($, e, next) => {
    void e
    void next
    return { value: sessionModel }
  })
  on('ui.open', ($, e, next) => {
    void e
    void next
    return { value: { isPlaced: true } }
  })
  on('store.get', ($, e, next) => {
    void e
    void next
    return { value: undefined }
  })
  on('store.set', ($, e, next) => {
    void e
    void next
    return { value: undefined }
  })
  return { switched, efforts }
}

test('the band shows the model and opens the picker', async ($, on) => {
  mockEngine(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'model-picker', surface, ...BAND })
    expect(await ui.find({ key: 'model-name' })).toBeDefined()
    expect(await ui.find({ text: /cn:model-a/ })).toBeDefined()
    await ui.press({ key: 'model-name' })
    await ui.unmount()
  }
})

test('the band leaves the effort out for a model that declares none', async ($, on) => {
  mockEngine(on, 'global:plain')
  const ui = await $.ui.mount({ plugin: 'model-picker', surface: 'terminal', ...BAND })
  expect(await ui.find({ text: /global:plain/ })).toBeDefined()
  expect(await ui.find({ key: 'effort-cycle' })).toBeUndefined()
  await ui.unmount()
})

test('the band shows the effort beside the model, cycling on a press', async ($, on) => {
  const { efforts } = mockEngine(on)
  const ui = await $.ui.mount({ plugin: 'model-picker', surface: 'terminal', ...BAND })
  // The model's levels arrive with the gateway read at session start, which
  // the band may be drawn before; opening the pane fills them.
  expect(await ui.find({ key: 'effort-cycle' })).toBeUndefined()
  const pane = await $.ui.mount({ plugin: 'model-picker', surface: 'terminal', ...PANE })
  await pane.press({ key: 'refresh' })
  await pane.unmount()

  await ui.press({ key: 'effort-cycle' })
  expect(efforts).toContain('low')
  await ui.unmount()
})

test('the band keeps the gateway prefix but drops the context suffix', async ($, on) => {
  mockEngine(on, 'cn:model-a[1M]')
  const ui = await $.ui.mount({ plugin: 'model-picker', surface: 'terminal', ...BAND })
  expect(await ui.find({ text: /model-a/ })).toBeDefined()
  expect(await ui.find({ text: /\[1M\]/i })).toBeUndefined()
  await ui.unmount()
})

test('the band sits flush right, on the meter line\'s edge', async ($, on) => {
  mockEngine(on)
  const ui = await $.ui.mount({ plugin: 'model-picker', surface: 'terminal', ...BAND })
  const boxes = await ui.findAll({ type: 'Box' })
  expect(boxes.some(one => one.props.justifyContent === 'flex-end')).toBe(true)
  // The outer column is what gives that row the site's width to push against.
  expect(boxes.some(one => one.props.flexDirection === 'column')).toBe(true)
  await ui.unmount()
})

test('the pane lists what the gateway offers and a press switches', async ($, on) => {
  const { switched } = mockEngine(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'model-picker', surface, ...PANE })
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ key: 'm:cn:model-a' })).toBeDefined()
    expect(await ui.find({ key: 'm:global:model-b' })).toBeDefined()
    await ui.press({ key: 'm:cn:model-a' })
    expect(switched).toContain('cn:model-a')
    await ui.unmount()
  }
})

test('a gateway name holding an escape sequence still draws the pane', async ($, on) => {
  mockEngine(on, 'cn:model-a', {
    data: [{ id: 'cn:escaped', name: 'Bold\u001b[1mName\u001b[22m', context_length: 128000 }],
  })
  const ui = await $.ui.mount({ plugin: 'model-picker', surface: 'terminal', ...PANE })
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ key: 'm:cn:escaped' })).toBeDefined()
  expect(await ui.find({ text: /\u001b/ })).toBeUndefined()
  await ui.unmount()
})

test('the filter narrows the rows', async ($, on) => {
  mockEngine(on)
  const ui = await $.ui.mount({ plugin: 'model-picker', surface: 'terminal', ...PANE })
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ key: 'm:cn:model-a' })).toBeDefined()
  await ui.input({ key: 'filter', text: 'model-b' })
  expect(await ui.find({ key: 'm:cn:model-a' })).toBeUndefined()
  expect(await ui.find({ key: 'm:global:model-b' })).toBeDefined()
  await ui.unmount()
})

test('the effort row offers what the model takes and a press sets it', async ($, on) => {
  const { efforts } = mockEngine(on)
  const ui = await $.ui.mount({ plugin: 'model-picker', surface: 'terminal', ...PANE })
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ key: 'effort:auto' })).toBeDefined()
  expect(await ui.find({ key: 'effort:max' })).toBeDefined()
  expect(await ui.find({ key: 'effort:medium' })).toBeUndefined()
  await ui.press({ key: 'effort:max' })
  expect(efforts).toContain('max')
  await ui.unmount()
})

test('a model that declares no levels offers auto alone', async ($, on) => {
  const { efforts } = mockEngine(on, 'global:plain')
  const ui = await $.ui.mount({ plugin: 'model-picker', surface: 'terminal', ...PANE })
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ key: 'effort:auto' })).toBeDefined()
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
    expect(await ui.find({ key: `effort:${level}` })).toBeUndefined()
  }
  expect(await ui.find({ text: /declares none/ })).toBeDefined()
  await ui.press({ key: 'effort:auto' })
  expect(efforts).toContain('auto')
  await ui.unmount()
})

test('the pane draws on mobile without a filter field', async ($, on) => {
  mockEngine(on)
  const ui = await $.ui.mount({ plugin: 'model-picker', surface: 'mobile', ...PANE })
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ key: 'm:cn:model-a' })).toBeDefined()
  expect(await ui.find({ key: 'filter' })).toBeUndefined()
  await ui.unmount()
})
