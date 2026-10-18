import { expect, mock, test } from 'claude-code/testing'
import type { On, Register } from 'claude-code'

const HINT = {
  component: 'PromptHint' as const,
  props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
}

const PANE = {
  component: 'Pane' as const,
  requestId: 'chat-history',
  props: {
    title: 'History',
    isFocused: true,
    bodyColumns: 100,
    placement: 'inline' as const,
    scroll: { offset: 0, bodyRows: 16 },
    view: {},
  },
}

const ROWS: Record<string, string> = {
  'aaaa1111-1111-1111-1111-111111111111': [
    JSON.stringify({ type: 'ai-title', aiTitle: 'Rename the parser' }),
    JSON.stringify({
      type: 'user',
      message: { content: 'Please rename the parser module' },
      cwd: 'D:/work/one',
    }),
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Renamed it.' }] },
    }),
  ].join('\n'),
  'bbbb2222-2222-2222-2222-222222222222': [
    JSON.stringify({ type: 'user', message: { content: 'Add a health endpoint' } }),
  ].join('\n'),
  'dddd4444-4444-4444-4444-444444444444': [
    JSON.stringify({
      type: 'user',
      message: { content: '<local-command-stdout>Set model to `one`\u001b[2m\u001b[22m\n\u001b[2m  note\u001b[22m</local-command-stdout>' },
    }),
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Colour\u001b[31mred\u001b[39m and plain.' }] },
    }),
  ].join('\n'),
}

/** Answers the transcript reads, the pane, and the engine calls the plugin makes. */
const norm = (path: string): string => path.replaceAll(String.fromCharCode(92), '/')

function mockEngine(on: On, resumed: string[]): void {
  mock.env(on, { USERPROFILE: 'C:/home' })
  on('fs.list', ($, e, next) => {
    if (norm(e.path) === 'C:/home/.claude/projects') {
      return {
        value: [
          { name: 'D--work-one', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
        ],
      }
    }
    if (norm(e.path) === 'C:/home/.claude/projects/D--work-one') {
      return {
        value: [
          {
            name: 'aaaa1111-1111-1111-1111-111111111111.jsonl',
            kind: 'file',
            size: 900,
            mtimeMs: Date.now() - 5 * 60_000,
            isLink: false,
          },
          {
            name: 'bbbb2222-2222-2222-2222-222222222222.jsonl',
            kind: 'file',
            size: 400,
            mtimeMs: Date.now() - 90 * 60_000,
            isLink: false,
          },
          {
            name: 'dddd4444-4444-4444-4444-444444444444.jsonl',
            kind: 'file',
            size: 500,
            mtimeMs: Date.now() - 120 * 60_000,
            isLink: false,
          },
        ],
      }
    }
    return next(e)
  })
  on('fs.read', ($, e, next) => {
    for (const [id, text] of Object.entries(ROWS)) {
      if (norm(e.path).endsWith(`${id}.jsonl`)) return { value: text }
    }
    return next(e)
  })
  on('session.cwd', ($, e, next) => {
    void e
    void next
    return { value: 'D:/work/one' }
  })
  on('session.id', ($, e, next) => {
    void e
    void next
    return { value: 'cccc3333-3333-3333-3333-333333333333' }
  })
  on('command.register', ($, e, next) => {
    void next
    return { value: { command: e.name } }
  })
  on('command.run', { command: 'resume' }, ($, e, next) => {
    if (e.origin.kind !== 'plugin') return next(e)
    resumed.push(e.args)
    return { text: `Resumed ${e.args}` }
  })
  on('ui.open', ($, e, next) => {
    void e
    void next
    return { value: { isPlaced: true } }
  })
  on('ui.close', ($, e, next) => {
    void e
    void next
    return { value: undefined }
  })
}

/** A stand-in for another plugin drawing the same line: its dot, then the rest. */
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

test('the footer dot opens history', async ($, on) => {
  mockEngine(on, [])
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'chat-history', surface, ...HINT })
    const dot = await ui.find({ key: 'history-dot' })
    expect(dot).toBeDefined()
    expect(dot?.text).toBe('●')
    await ui.press({ key: 'history-dot' })
    await ui.unmount()
  }
})

test('a plugin beneath that draws the line is nested after the dot', { plugins: [rival] }, async ($, on) => {
  mockEngine(on, [])
  const ui = await $.ui.mount({ plugin: 'chat-history', surface: 'terminal', ...HINT })
  expect(await ui.find({ key: 'history-dot' })).toBeDefined()
  expect(await ui.find({ text: /RIVAL/ })).toBeDefined()
  await ui.unmount()
})

test('the pane lists conversations and a press resumes one', async ($, on) => {
  const resumed: string[] = []
  mockEngine(on, resumed)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'chat-history', surface, ...PANE })
    await ui.press({ key: 'history-refresh' })
    expect(await ui.find({ key: 'c:aaaa1111-1111-1111-1111-111111111111' })).toBeDefined()
    expect(await ui.find({ text: /Rename the parser/ })).toBeDefined()
    expect(await ui.find({ text: /Add a health endpoint/ })).toBeDefined()
    await ui.press({ key: 'c:aaaa1111-1111-1111-1111-111111111111' })
    expect(resumed).toContain('aaaa1111-1111-1111-1111-111111111111')
    await ui.unmount()
  }
})

test('Peek shows the opening of a conversation', async ($, on) => {
  mockEngine(on, [])
  const ui = await $.ui.mount({ plugin: 'chat-history', surface: 'terminal', ...PANE })
  await ui.press({ key: 'history-refresh' })
  await ui.press({ key: 'p:aaaa1111-1111-1111-1111-111111111111' })
  expect(await ui.find({ text: /you: Please rename the parser module/ })).toBeDefined()
  expect(await ui.find({ text: /claude: Renamed it\./ })).toBeDefined()
  await ui.unmount()
})

test('the filter narrows the list', async ($, on) => {
  mockEngine(on, [])
  const ui = await $.ui.mount({ plugin: 'chat-history', surface: 'terminal', ...PANE })
  await ui.press({ key: 'history-refresh' })
  await ui.input({ key: 'history-filter', text: 'health' })
  expect(await ui.find({ key: 'c:aaaa1111-1111-1111-1111-111111111111' })).toBeUndefined()
  expect(await ui.find({ key: 'c:bbbb2222-2222-2222-2222-222222222222' })).toBeDefined()
  await ui.unmount()
})

test('the pane draws on mobile without a filter field', async ($, on) => {
  mockEngine(on, [])
  const ui = await $.ui.mount({ plugin: 'chat-history', surface: 'mobile', ...PANE })
  await ui.press({ key: 'history-refresh' })
  expect(await ui.find({ key: 'c:aaaa1111-1111-1111-1111-111111111111' })).toBeDefined()
  expect(await ui.find({ key: 'history-filter' })).toBeUndefined()
  await ui.unmount()
})

test('a transcript holding escape sequences still draws the pane', async ($, on) => {
  mockEngine(on, [])
  const ui = await $.ui.mount({ plugin: 'chat-history', surface: 'terminal', ...PANE })
  await ui.press({ key: 'history-refresh' })
  // The row's own text carries the escapes; the pane may not keep them.
  expect(await ui.find({ key: 'c:dddd4444-4444-4444-4444-444444444444' })).toBeDefined()
  await ui.press({ key: 'p:dddd4444-4444-4444-4444-444444444444' })
  expect(await ui.find({ text: /Colourred and plain\./ })).toBeDefined()
  expect(await ui.find({ text: /\u001b/ })).toBeUndefined()
  await ui.unmount()
})
