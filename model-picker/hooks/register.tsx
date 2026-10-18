import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { ModelEntry } from '../types'

const PANE = 'model-picker'
const COMMAND = 'models'

const models = atom({ plugin: 'model-picker', key: 'models' } as const, [] as ModelEntry[])
const current = atom({ plugin: 'model-picker', key: 'current' } as const, '')
const query = atom({ plugin: 'model-picker', key: 'query' } as const, '')
const status = atom({ plugin: 'model-picker', key: 'status' } as const, '')
const isBusy = atom({ plugin: 'model-picker', key: 'isBusy' } as const, false)
const fetchedAt = atom({ plugin: 'model-picker', key: 'fetchedAt' } as const, 0)
const recent = atom({ plugin: 'model-picker', key: 'recent' } as const, [] as string[])
const page = atom({ plugin: 'model-picker', key: 'page' } as const, 0)
const effort = atom({ plugin: 'model-picker', key: 'effort' } as const, 'auto')
const effortOptions = atom({ plugin: 'model-picker', key: 'effortOptions' } as const, [] as string[])

/** Every level the engine's `/effort` takes, weakest first. */
const ALL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

type Dollar = EngineInterface

type Options = {
  showBand: boolean
  baseUrl: string
  paneRows: number
  refreshMinutes: number
}

/** The session's model as `/model` shows it, less a `[1m]` context suffix. */
const plain = (id: string): string => id.replace(/\[1m\]$/i, '')

/**
 * A gateway's own words as the drawing takes them. A name or a description is
 * untrusted text, and the drawing refuses a tree holding a control character.
 */
function clean(text: string): string {
  return text
    // CSI: colour, cursor and the rest, `ESC [ ... final byte`.
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    // OSC: a title or hyperlink, ended by BEL or `ESC \`.
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    // Whatever else is neither a tab nor a newline.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
}

/** `text` cut to `width` cells, ended with an ellipsis where it was cut. */
function fit(text: string, width: number): string {
  if (width <= 0) return ''
  if (text.length <= width) return text
  return width <= 1 ? '…' : text.slice(0, width - 1) + '…'
}

/** `text` cut or padded to exactly `width` cells, so rows line up. */
function pad(text: string, width: number): string {
  const cut = fit(text, width)
  return cut + ' '.repeat(Math.max(0, width - cut.length))
}

/** A context length as the models list reads it. */
const shortContext = (n: number | undefined): string => {
  if (!n || n < 1000) return ''
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M ctx`
  return `${Math.round(n / 1000)}K ctx`
}

/** Where the models list is read from, and the credential it is read with. */
async function endpoint(
  $: Dollar,
  options: Options,
): Promise<{ url: string; token: string } | null> {
  const configured = options.baseUrl.trim()
  const base = configured !== '' ? configured : (await $.env.get('ANTHROPIC_BASE_URL')) ?? ''
  const token =
    (await $.env.get('ANTHROPIC_AUTH_TOKEN')) ?? (await $.env.get('ANTHROPIC_API_KEY')) ?? ''
  if (base === '') return null
  return { url: base.replace(/\/+$/, '') + '/v1/models', token }
}

/** Reads the gateway's model list, or says why it could not. */
async function loadModels($: Dollar, options: Options): Promise<void> {
  const target = await endpoint($, options)
  if (!target) {
    await update($, status, () => "No gateway: set ANTHROPIC_BASE_URL or this plugin's base URL.")
    return
  }

  await update($, isBusy, () => true)
  try {
    const headers: Record<string, string> = { 'anthropic-version': '2023-06-01' }
    if (target.token !== '') {
      headers.authorization = `Bearer ${target.token}`
      headers['x-api-key'] = target.token
    }
    const res = await $.http.fetch(target.url, { headers })
    if (!res.ok) {
      await update($, status, () => `Gateway answered ${res.status} at ${target.url}.`)
      return
    }
    const body = JSON.parse(res.text) as {
      data?: {
        id?: string
        name?: string
        description?: string
        context_length?: number
        vendor?: string
        reasoning_supported_efforts?: string[]
        reasoning_default_effort?: string
        reasoning_effort?: string
      }[]
    }
    const list: ModelEntry[] = []
    for (const row of body.data ?? []) {
      if (!row || typeof row.id !== 'string' || row.id === '') continue
      const efforts = Array.isArray(row.reasoning_supported_efforts)
        ? row.reasoning_supported_efforts.filter(one => typeof one === 'string')
        : undefined
      list.push({
        id: clean(row.id),
        name: clean(typeof row.name === 'string' ? row.name : row.id),
        description:
          typeof row.description === 'string' ? clean(row.description) : undefined,
        contextLength: typeof row.context_length === 'number' ? row.context_length : undefined,
        vendor: typeof row.vendor === 'string' ? clean(row.vendor) : undefined,
        efforts: efforts && efforts.length > 0 ? efforts : undefined,
        defaultEffort:
          typeof row.reasoning_default_effort === 'string'
            ? row.reasoning_default_effort
            : typeof row.reasoning_effort === 'string'
              ? row.reasoning_effort
              : undefined,
      })
    }
    list.sort((a, b) => a.id.localeCompare(b.id))
    await update($, models, () => list)
    await update($, fetchedAt, () => Date.now())
    await update($, status, () => `${list.length} models from ${target.url}`)
    await updateEffortOptions($, list, await read($, current))
  } catch (error) {
    await update($, status, () => clean(`Could not read ${target.url}: ${String(error)}`))
  } finally {
    await update($, isBusy, () => false)
  }
}

/** Refreshes when the list is empty or older than the configured freshness. */
async function ensureModels($: Dollar, options: Options): Promise<void> {
  const list = await read($, models)
  const at = await read($, fetchedAt)
  const ttl = Math.max(0, options.refreshMinutes) * 60_000
  if (list.length > 0 && Date.now() - at < ttl) return
  await loadModels($, options)
}

/** The model the session is on, as the list names it. */
function entryFor(list: ModelEntry[], current: string): ModelEntry | undefined {
  return list.find(one => plain(one.id) === plain(current))
}

/**
 * What the effort row offers for `current`: exactly the levels the gateway
 * lists for that model, weakest first. A model the gateway lists none for
 * offers `auto` alone — the picker never invents a level the gateway did not
 * declare.
 */
async function updateEffortOptions(
  $: Dollar,
  list: ModelEntry[],
  current: string,
): Promise<void> {
  const id = current !== '' ? current : await $.session.model()
  const entry = entryFor(list, id)
  const listed = entry?.efforts ?? []
  const known = ALL_EFFORTS.filter(one => listed.includes(one))
  const extra = listed.filter(one => !(ALL_EFFORTS as readonly string[]).includes(one))
  const next = [...known, ...extra]
  await update($, effortOptions, () => next)
}

/** Switches the session's model through the engine's own `/model`, as typed. */
async function switchTo($: Dollar, id: string): Promise<void> {
  try {
    const result = await $.command.run({ command: 'model', args: id })
    if ('deny' in result) {
      $.ui.toast(clean(`Could not switch: ${result.deny}`))
      return
    }
    const now = await $.session.model()
    await update($, current, () => plain(now))
    await updateEffortOptions($, await read($, models), plain(now))
    const nextRecent = [id, ...(await read($, recent)).filter(one => one !== id)].slice(0, 8)
    await update($, recent, () => nextRecent)
    await $.store.set('recent', nextRecent)
    $.ui.toast(clean(`Model: ${now}`))
  } catch (error) {
    $.ui.toast(clean(`Could not switch: ${String(error)}`))
  }
}

/** Sets the turn's reasoning effort through the engine's own `/effort`. */
async function setEffort($: Dollar, level: string): Promise<void> {
  try {
    const result = await $.command.run({ command: 'effort', args: level })
    if ('deny' in result) {
      $.ui.toast(clean(`Could not set effort: ${result.deny}`))
      return
    }
    await update($, effort, () => level)
    await $.store.set('effort', level)
    $.ui.toast(`Effort: ${level}`)
  } catch (error) {
    $.ui.toast(clean(`Could not set effort: ${String(error)}`))
  }
}

let inflight: Promise<void> | null = null

/** Refreshes the list once, folding concurrent asks into the one in flight. */
async function refresh($: Dollar, options: Options): Promise<void> {
  if (inflight) return inflight
  inflight = loadModels($, options).finally(() => {
    inflight = null
  })
  return inflight
}

/** Opens the picker, taking the keyboard where the prompt allows it. */
async function openPicker($: Dollar, options: Options): Promise<void> {
  const opened = await $.ui.open({
    id: PANE,
    title: 'Models',
    focus: true,
    closeOnEscape: true,
    rows: Math.max(4, options.paneRows),
  })
  if (!opened.isPlaced) $.ui.log(`model-picker: ${opened.reason}`, { to: 'debug' })
  await ensureModels($, options)
}

export const register: Register = (on, raw) => {
  const options: Options = {
    showBand: raw.showBand !== false,
    baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : '',
    paneRows: typeof raw.paneRows === 'number' ? raw.paneRows : 20,
    refreshMinutes: typeof raw.refreshMinutes === 'number' ? raw.refreshMinutes : 10,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Browse the models your gateway offers and switch with a click',
    })
    await $.command.register({
      name: 'model-picker',
      description: 'Open the model picker',
    })

    const stored = await $.store.get('recent')
    if (Array.isArray(stored)) {
      const ids = stored.filter((one): one is string => typeof one === 'string').slice(0, 8)
      await update($, recent, () => ids)
    }
    const started = await $.session.model()
    const storedEffort = await $.store.get('effort')
    const fromEnv = (await $.env.get('CLAUDE_EFFORT')) ?? ''
    const settings = await $.settings.read()
    const modelSettings = settings.modelSettings as
      | Record<string, { effortLevel?: unknown }>
      | undefined
    const fromSettings = modelSettings?.[plain(started)]?.effortLevel
    const level =
      typeof fromSettings === 'string' && fromSettings !== ''
        ? fromSettings
        : fromEnv !== ''
          ? fromEnv
          : typeof storedEffort === 'string' && storedEffort !== ''
            ? storedEffort
            : 'auto'
    await update($, effort, () => level)
    await update($, current, () => plain(started))
    await updateEffortOptions($, await read($, models), plain(started))

    if (e.isInteractive) void refresh($, options)
    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    await openPicker($, options)
    return { text: 'Model picker opened: click a row, or press its number.' }
  }).catch(($, e, next) => (next.called ? next(e) : { text: 'Model picker could not open.' }))

  on('command.run', { command: 'model-picker' }, async $ => {
    await openPicker($, options)
    return { text: 'Model picker opened.' }
  })

  on('classic.PostModelSwitch', async ($, e, next) => {
    await update($, current, () => plain(e.to_model))
    await updateEffortOptions($, await read($, models), plain(e.to_model))
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : undefined))

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined && e.effort !== undefined) {
      const shown = String(e.effort)
      if (shown !== (await read($, effort))) await update($, effort, () => shown)
    }
    yield* next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!options.showBand || e.props.hasSurvey) return next(e)

    const now = await read($, current)
    const busy = await read($, isBusy)
    const level = await read($, effort)
    const levels = await read($, effortOptions)
    const { Box, Button, Text } = $.ui.resolve(e)

    // The band may be drawn before `session.start` has read the model: ask the
    // session, as reading is all a render hook may do.
    const shown = now !== '' ? now : plain(await $.session.model())

    // A model the gateway declares no levels for offers no effort to show, so
    // the row ends at the model rather than trailing a dash.
    const hasLevels = levels.length > 0

    return (
      <Box>
        <Text dimColor>model</Text>
        <Text dimColor>{'  '}</Text>
        <Button
          key="model-name"
          plain
          onPress={() => void openPicker($, options)}
        >
          <Text weight="semibold">{shown !== '' ? shown : 'default'}</Text>
        </Button>
        <Text dimColor>{busy ? '  ·  reading…' : ''}</Text>
        {hasLevels && (
          <>
            <Text dimColor>{'   ·   '}</Text>
            <Text dimColor>effort</Text>
            <Text dimColor>{'  '}</Text>
            <Button
              key="effort-cycle"
              plain
              onPress={() => {
                const index = levels.indexOf(level)
                const upcoming = levels[(index + 1) % levels.length]
                if (upcoming !== undefined) void setEffort($, upcoming)
              }}
            >
              <Text>{level}</Text>
            </Button>
          </>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const list = await read($, models)
    const now = await read($, current)
    const filter = await read($, query)
    const note = await read($, status)
    const busy = await read($, isBusy)
    const pageState = await read($, page)
    const recentIds = await read($, recent)
    const level = await read($, effort)
    const levels = await read($, effortOptions)

    const needle = filter.trim().toLowerCase()
    const matched =
      needle === ''
        ? list
        : list.filter(
            one =>
              one.id.toLowerCase().includes(needle) ||
              one.name.toLowerCase().includes(needle) ||
              (one.description ?? '').toLowerCase().includes(needle),
          )

    const room = Math.max(1, (e.props.scroll?.bodyRows ?? options.paneRows) - 4)
    const pageCount = Math.max(1, Math.ceil(matched.length / room))
    const pageNow = Math.min(Math.max(0, pageState), pageCount - 1)
    const shown = matched.slice(pageNow * room, pageNow * room + room)
    const canType = e.surface !== 'mobile'
    const { Box, Button, Text } = $.ui.resolve(e)

    // One width for each of the two columns, from what this page shows, so the
    // rows line up under each other instead of each finding its own width.
    const nameWidth = Math.min(24, Math.max(4, ...shown.map(one => one.name.length)))
    const idWidth = Math.min(32, Math.max(10, ...shown.map(one => one.id.length)))

    let filterField = null
    if (canType) {
      const { Input } = $.ui.resolve(e)
      filterField = (
        <Input
          key="filter"
          placeholder="filter models…"
          value={filter}
          onSubmit={value => {
            void update($, query, () => value)
            void update($, page, () => 0)
          }}
          onInput={value => {
            void update($, query, () => value)
            void update($, page, () => 0)
          }}
        />
      )
    }

    return (
      <Box flexDirection="column">
        <Box>
          {filterField}
          <Button
            key="refresh"
            label={busy ? 'Refreshing…' : 'Refresh'}
            variant="secondary"
            dimColor={!busy}
            onPress={() => void refresh($, options)}
          />
        </Box>
        <Text dimColor>{note !== '' ? note : ' '}</Text>
        {recentIds.length > 0 && needle === '' && (
          <Text dimColor>{'recent  '}{recentIds.map(plain).join('  ·  ')}</Text>
        )}
        {shown.length > 0 && (
          <Text dimColor>{' '.repeat(2 + nameWidth + 2) + 'id'}</Text>
        )}
        {shown.length === 0 && (
          <Text dimColor>{busy ? 'Reading the gateway…' : 'No model matches.'}</Text>
        )}
        {shown.map((one, index) => {
          const isNow = plain(one.id) === now
          const context = shortContext(one.contextLength)
          const effortsText = one.efforts !== undefined ? one.efforts.join('/') : ''
          return (
            <Button
              key={`m:${one.id}`}
              hotkey={index < 9 ? String(index + 1) : undefined}
              plain
              onPress={() => void switchTo($, one.id)}
            >
              <Text>{isNow ? '● ' : '  '}</Text>
              <Text dimColor={!isNow}>{pad(one.name, nameWidth)}</Text>
              <Text dimColor>{'  '}</Text>
              <Text dimColor>{pad(one.id, idWidth)}</Text>
              {context !== '' && <Text dimColor>{`  ${context}`}</Text>}
              {effortsText !== '' && <Text dimColor>{`  ${effortsText}`}</Text>}
            </Button>
          )
        })}
        <Text dimColor>{' '}</Text>
        <Box>
          <Text dimColor>effort  </Text>
          <Button
            key="effort:auto"
            label="auto"
            plain
            dimColor={level !== 'auto'}
            onPress={() => void setEffort($, 'auto')}
          />
          {levels.length === 0 && <Text dimColor>{'  this model declares none'}</Text>}
          {levels.map(one => (
            <Button
              key={`effort:${one}`}
              label={one}
              plain
              dimColor={level !== one}
              onPress={() => void setEffort($, one)}
            />
          ))}
        </Box>
        <Text dimColor>{' '}</Text>
        <Box>
          <Button
            key="prev"
            label="‹ Prev"
            plain
            dimColor
            onPress={() => void update($, page, value => Math.max(0, value - 1))}
          />
          <Text dimColor>{`   ${pageNow + 1} / ${pageCount}   `}</Text>
          <Button
            key="next"
            label="Next ›"
            plain
            dimColor
            onPress={() => void update($, page, value => Math.min(pageCount - 1, value + 1))}
          />
          <Text dimColor>{'      '}</Text>
          <Button
            key="close"
            label="Close"
            role="dismiss"
            dimColor
            onPress={() => void $.ui.close({ id: PANE })}
          />
        </Box>
        <Text dimColor>{canType ? 'Click a row, or press its number.  Esc closes.' : 'Esc closes.'}</Text>
      </Box>
    )
  })
}
