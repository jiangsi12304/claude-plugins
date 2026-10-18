import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer, TurnUsage } from 'claude-code'
import type { DayTotal, LedgerRow, ModelPrice } from '../types'

const PANE = 'token-meter'
const COMMAND = 'tokens'
const DIALOG = 'token-meter-prices'

/** How often the band's context figure is re-read while a turn runs. */
const TICK_MS = 2000

/** How many days the ledger keeps. */
const DAYS_KEPT = 14

const ledger = atom({ plugin: 'token-meter', key: 'ledger' } as const, [] as LedgerRow[])
const prices = atom({ plugin: 'token-meter', key: 'prices' } as const, {} as Record<string, ModelPrice>)
const days = atom({ plugin: 'token-meter', key: 'days' } as const, [] as DayTotal[])
const status = atom({ plugin: 'token-meter', key: 'status' } as const, '')
const lastPercent = atom({ plugin: 'token-meter', key: 'lastPercent' } as const, 0)
const isWorking = atom({ plugin: 'token-meter', key: 'isWorking' } as const, false)
const editing = atom({ plugin: 'token-meter', key: 'editing' } as const, '')
/** The live figures the band draws: refreshed on a tick, not per keystroke. */
const livePercent = atom({ plugin: 'token-meter', key: 'livePercent' } as const, 0)
const liveTokens = atom({ plugin: 'token-meter', key: 'liveTokens' } as const, 0)
const liveWindow = atom({ plugin: 'token-meter', key: 'liveWindow' } as const, 0)
const liveCost = atom({ plugin: 'token-meter', key: 'liveCost' } as const, 0)

type Dollar = EngineInterface

type Options = {
  showBand: boolean
  compactAt: number
  warnAt: number
  dailyBudget: number
  paneRows: number
}

let ticker: Timer | null = null
/** True once the store has been read: a host may fire no `session.start`. */
let loaded = false
/** The context percentage at which the guard last compacted, so it fires once. */
let guardedAt = -1

/**
 * Text as the drawing takes it. The drawing refuses any tree holding a control
 * character, and refuses the whole tree with it.
 */
function clean(text: string): string {
  return text
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
}

/** `text` cut to `width` cells, ended with an ellipsis where it was cut. */
function fit(text: string, width: number): string {
  if (width <= 0) return ''
  if (text.length <= width) return text
  return width <= 1 ? '…' : text.slice(0, width - 1) + '…'
}

/** `text` cut or padded to exactly `width` cells, so columns line up. */
function pad(text: string, width: number): string {
  const cut = fit(text, width)
  return cut + ' '.repeat(Math.max(0, width - cut.length))
}

/** A token count as the band spells it: `812`, `12.4k`, `1.02M`. */
function shortTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(Math.round(n))
}

/** Dollars as the band spells them: `$0.00`, `$1.24`, `$12.30`. */
function shortCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00'
  if (usd >= 100) return `$${Math.round(usd)}`
  return `$${usd.toFixed(2)}`
}

/** The model id as the ledger names it, less a `[1m]` context suffix. */
const plain = (id: string): string => id.replace(/\[1m\]$/i, '')

/** Today's local date, `YYYY-MM-DD`. */
function today(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/** What one turn cost, from its token counts and the model's price. */
function priceOf(
  table: Record<string, ModelPrice>,
  model: string,
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number },
): number {
  const price = table[plain(model)]
  if (price === undefined) return 0
  // A cached read is billed far below fresh input; a cache write slightly above.
  // The table's `input` is the fresh-input price, and the multipliers are the
  // ones every provider uses.
  const fresh = Math.max(0, usage.input_tokens) * price.input
  const cached = Math.max(0, usage.cache_read_input_tokens) * price.input * 0.1
  const written = Math.max(0, usage.cache_creation_input_tokens) * price.input * 1.25
  const out = Math.max(0, usage.output_tokens) * price.output
  return (fresh + cached + written + out) / 1_000_000
}

/** Adds one turn to the session's ledger, keeping the model's row in place. */
async function recordTurn($: Dollar, usage: TurnUsage): Promise<void> {
  const model = plain(usage.model)
  const table = await read($, prices)
  const cost = priceOf(table, model, usage)
  await update($, ledger, rows => {
    const next = rows.slice()
    const at = next.findIndex(one => one.model === model)
    const row: LedgerRow =
      at < 0
        ? { model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 }
        : { ...next[at]! }
    row.input += Math.max(0, usage.input_tokens)
    row.output += Math.max(0, usage.output_tokens)
    row.cacheRead += Math.max(0, usage.cache_read_input_tokens)
    row.cacheWrite += Math.max(0, usage.cache_creation_input_tokens)
    row.cost += cost
    row.turns += 1
    if (at < 0) next.push(row)
    else next[at] = row
    return next
  })

  // The day's total, kept across sessions: the day's own figures, not the
  // engine's, so a gateway model the engine cannot price still adds up.
  const day = today()
  await update($, days, rows => {
    const next = rows.slice()
    const at = next.findIndex(one => one.day === day)
    const row: DayTotal =
      at < 0 ? { day, cost: 0, input: 0, output: 0, turns: 0 } : { ...next[at]! }
    row.cost += cost
    row.input += Math.max(0, usage.input_tokens) + Math.max(0, usage.cache_read_input_tokens)
    row.output += Math.max(0, usage.output_tokens)
    row.turns += 1
    if (at < 0) next.unshift(row)
    else next[at] = row
    return next.slice(0, DAYS_KEPT)
  })
}

/** Reads the engine's live figures into the atoms the band draws. */
async function readLive($: Dollar): Promise<number> {
  try {
    const usage = await $.session.usage()
    const percent = usage.context.percent ?? 0
    await update($, livePercent, () => percent)
    await update($, liveTokens, () => usage.context.tokens ?? 0)
    await update($, liveWindow, () => usage.context.window)
    await update($, liveCost, () => usage.cost?.usd ?? 0)
    return percent
  } catch {
    return 0
  }
}

/** Starts the tick that keeps the band's context figure live while a turn runs. */
async function startTicker($: Dollar, options: Options): Promise<void> {
  if (ticker !== null) return
  await readLive($)
  ticker = $.clock.every(TICK_MS, () => {
    void (async () => {
      const percent = await readLive($)
      if (!(await read($, isWorking))) {
        stopTicker()
        return
      }
      // The guard: once per crossing, at or past the configured percentage,
      // compact so the window is freed before the engine has to.
      const limit = Math.min(100, Math.max(0, options.compactAt))
      if (limit > 0 && percent >= limit && percent !== guardedAt) {
        guardedAt = percent
        await update($, status, () => `context ${percent}% · compacting…`)
        try {
          await $.session.compact()
          await update($, status, () => `context was ${percent}% · compacted`)
          $.ui.toast(`token-meter · compacted at ${percent}%`)
        } catch (error) {
          await update($, status, () => clean(`compaction failed: ${String(error)}`))
        }
      }
    })()
  })
}

function stopTicker(): void {
  if (ticker === null) return
  ticker.cancel()
  ticker = null
}

/** Opens the meter pane. */
async function openPane($: Dollar, options: Options): Promise<void> {
  const opened = await $.ui.open({
    id: PANE,
    title: 'Tokens',
    focus: true,
    closeOnEscape: true,
    rows: Math.max(6, options.paneRows),
  })
  if (!opened.isPlaced) $.ui.log(`token-meter: ${opened.reason}`, { to: 'debug' })
  await readLive($)
}

/** Saves a price the person typed: `input,output` dollars per million tokens. */
async function savePrice($: Dollar, model: string, typed: string): Promise<void> {
  const parts = typed.split(/[,\s]+/).filter(one => one !== '')
  const input = Number.parseFloat(parts[0] ?? '')
  const output = Number.parseFloat(parts[1] ?? parts[0] ?? '')
  if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) {
    await update($, status, () => 'A price is two numbers: input,output per million tokens.')
    return
  }
  await update($, prices, table => ({ ...table, [model]: { input, output } }))
  await $.store.set('prices', await read($, prices))
  await update($, status, () => `priced ${model} at ${input}/${output} per 1M`)
  await update($, editing, () => '')
}

/** Reads the store once; the second call is free. */
async function ensureStored($: Dollar): Promise<void> {
  if (loaded) return
  loaded = true
  await loadStored($)
}

/** Reads the stored prices and day totals, once, when the session starts. */
async function loadStored($: Dollar): Promise<void> {
  const storedPrices = await $.store.get('prices')
  if (storedPrices !== null && typeof storedPrices === 'object') {
    const table: Record<string, ModelPrice> = {}
    for (const [key, value] of Object.entries(storedPrices as Record<string, unknown>)) {
      if (value === null || typeof value !== 'object') continue
      const one = value as { input?: unknown; output?: unknown }
      if (typeof one.input === 'number' && typeof one.output === 'number') {
        table[key] = { input: one.input, output: one.output }
      }
    }
    await update($, prices, () => table)
  }
  const storedDays = await $.store.get('days')
  if (Array.isArray(storedDays)) {
    const rows: DayTotal[] = []
    for (const one of storedDays) {
      if (one === null || typeof one !== 'object') continue
      const row = one as Partial<DayTotal>
      if (typeof row.day !== 'string') continue
      rows.push({
        day: row.day,
        cost: typeof row.cost === 'number' ? row.cost : 0,
        input: typeof row.input === 'number' ? row.input : 0,
        output: typeof row.output === 'number' ? row.output : 0,
        turns: typeof row.turns === 'number' ? row.turns : 0,
      })
    }
    await update($, days, () => rows.slice(0, DAYS_KEPT))
  }
}

export const register: Register = (on, raw) => {
  const options: Options = {
    showBand: raw.showBand !== false,
    compactAt: typeof raw.compactAt === 'number' ? raw.compactAt : 85,
    warnAt: typeof raw.warnAt === 'number' ? raw.warnAt : 70,
    dailyBudget: typeof raw.dailyBudget === 'number' ? raw.dailyBudget : 0,
    paneRows: typeof raw.paneRows === 'number' ? raw.paneRows : 22,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Context, tokens and estimated spend, by model',
    })
    await loadStored($)
    await update($, ledger, () => [])
    await update($, status, () => '')
    await readLive($)
    if (e.isInteractive) {
      try {
        $.ui.status(undefined)
      } catch {
        // No status line beneath: the band is the only place it shows.
      }
    }
    return next(e)
  })

  // The band's live figures: a turn's start begins the tick, and its end reads
  // the figures once more, so the band settles on what the turn left.
  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    await update($, isWorking, () => true)
    await startTicker($, options)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    await ensureStored($)
    if (e.usage !== undefined) {
      await recordTurn($, e.usage)
      const spent = (await read($, days))[0]?.cost ?? 0
      if (options.dailyBudget > 0 && spent > options.dailyBudget) {
        $.ui.toast(`token-meter · today ${shortCost(spent)} is over the ${shortCost(options.dailyBudget)} budget`)
      }
    }
    await update($, isWorking, () => false)
    stopTicker()
    const percent = await readLive($)
    await update($, lastPercent, () => percent)
    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    await openPane($, options)
    return { text: 'Token meter opened.' }
  }).catch(($, e, next) => (next.called ? next(e) : { text: 'The token meter could not open.' }))

  // The band above the prompt: context, this session's estimated spend, and
  // what the last turn cost. A click opens the pane.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!options.showBand || e.props.hasSurvey) return next(e)

    // A band drawn before `session.start` (or where the host fires none) reads
    // the session itself: reading is all a render hook may do, and the atoms
    // are only a cache of the same figures.
    let percent = await read($, livePercent)
    let tokens = await read($, liveTokens)
    let window = await read($, liveWindow)
    let cost = await read($, liveCost)
    if (percent === 0 && tokens === 0) {
      try {
        const usage = await $.session.usage()
        percent = usage.context.percent ?? 0
        tokens = usage.context.tokens ?? 0
        window = usage.context.window
        cost = usage.cost?.usd ?? 0
      } catch {
        // No figures beneath: the band shows what it has.
      }
    }
    const spentToday = (await read($, days))[0]?.cost ?? 0
    const working = await read($, isWorking)
    const { Box, Button, Text } = $.ui.resolve(e)

    const warned = percent >= Math.max(0, options.warnAt)
    const bar = Math.min(10, Math.max(1, Math.round(percent / 10)))
    const gauge = '█'.repeat(bar) + '░'.repeat(10 - bar)

    return (
      <Box>
        <Text dimColor>ctx </Text>
        <Text color={warned ? 'warning' : 'success'} tabular>
          {gauge}
        </Text>
        <Text dimColor tabular>{` ${Math.round(percent)}%`}</Text>
        {window > 0 && <Text dimColor>{` ${shortTokens(tokens)}/${shortTokens(window)}`}</Text>}
        <Text dimColor>{'   ·   '}</Text>
        <Button key="tokens-open" plain onPress={() => void openPane($, options)}>
          <Text dimColor>session </Text>
          <Text tabular>{shortCost(cost)}</Text>
          {spentToday > 0 && <Text dimColor tabular>{` · today ${shortCost(spentToday)}`}</Text>}
        </Button>
        {working && <Text dimColor>{'  ·  working…'}</Text>}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    await ensureStored($)
    const rows = await read($, ledger)
    const table = await read($, prices)
    const history = await read($, days)
    const note = await read($, status)
    const typed = await read($, editing)
    const percent = await read($, livePercent)
    const tokens = await read($, liveTokens)
    const window = await read($, liveWindow)
    const cost = await read($, liveCost)
    const canType = e.surface !== 'mobile'
    const { Box, Button, Text } = $.ui.resolve(e)

    const width = Math.max(20, e.props.bodyColumns)
    const modelWidth = Math.min(34, Math.max(12, Math.floor(width * 0.34)))
    const sessionTotal = rows.reduce((sum, one) => sum + one.cost, 0)
    const turns = rows.reduce((sum, one) => sum + one.turns, 0)
    const input = rows.reduce((sum, one) => sum + one.input + one.cacheRead, 0)
    const output = rows.reduce((sum, one) => sum + one.output, 0)
    const unpriced = rows.filter(one => table[one.model] === undefined)

    return (
      <Box flexDirection="column">
        <Text dimColor wrap="wrap">
          {`context ${Math.round(percent)}% · ${shortTokens(tokens)}/${shortTokens(window)} tokens · session ${shortCost(cost)} · ${turns} turns`}
        </Text>
        <Text dimColor>{' '}</Text>
        <Text dimColor>
          {pad('model', modelWidth)}
          {pad('in', 9)}
          {pad('out', 9)}
          {pad('cached', 9)}
          {pad('cost', 10)}
          {'turns'}
        </Text>
        {rows.length === 0 && <Text dimColor>No turn has finished this session yet.</Text>}
        {rows.map(one => {
          const priced = table[one.model] !== undefined
          return (
            <Box key={`row:${one.model}`}>
              <Text>{pad(fit(one.model, modelWidth), modelWidth)}</Text>
              <Text dimColor tabular>{pad(shortTokens(one.input), 9)}</Text>
              <Text dimColor tabular>{pad(shortTokens(one.output), 9)}</Text>
              <Text dimColor tabular>{pad(shortTokens(one.cacheRead), 9)}</Text>
              <Text tabular color={priced ? undefined : 'warning'}>
                {pad(priced ? shortCost(one.cost) : 'unpriced', 10)}
              </Text>
              <Text dimColor tabular>{String(one.turns)}</Text>
            </Box>
          )
        })}
        <Text dimColor>{' '}</Text>
        {canType && (
          <Box>
            <Text dimColor>{'price  '}</Text>
            {rows.map(one => (
              <Button
                key={`price:${one.model}`}
                label={table[one.model] === undefined ? `${one.model} · set` : `${one.model} · edit`}
                plain
                dimColor={table[one.model] !== undefined}
                onPress={() => void update($, editing, () => (typed === one.model ? '' : one.model))}
              />
            ))}
            {rows.length === 0 && <Text dimColor>none yet</Text>}
          </Box>
        )}
        {canType && typed !== '' && (() => {
          const { Input } = $.ui.resolve(e)
          return (
            <Input
              key={`price-input:${typed}`}
              label={fit(typed, 24)}
              placeholder="input,output per 1M tokens"
              value=""
              onSubmit={value => void savePrice($, typed, value)}
            />
          )
        })()}
        {unpriced.length > 0 && (
          <Text dimColor wrap="wrap">
            {`Set a price for ${unpriced.map(one => one.model).join(', ')} — the engine cannot price a gateway model.`}
          </Text>
        )}
        <Text dimColor>{' '}</Text>
        <Text dimColor>
          {`this session  in ${shortTokens(input)} · out ${shortTokens(output)} · ${shortCost(sessionTotal)}`}
        </Text>
        {history.length > 0 && (
          <Box flexDirection="column">
            <Text dimColor>{' '}</Text>
            <Text dimColor>recent days</Text>
            {history.slice(0, 7).map(one => (
              <Text key={`day:${one.day}`} dimColor tabular>
                {`  ${one.day}  ${pad(shortCost(one.cost), 10)}  ${shortTokens(one.input)} in / ${shortTokens(one.output)} out  ·  ${one.turns} turns`}
              </Text>
            ))}
          </Box>
        )}
        <Text dimColor>{' '}</Text>
        <Box>
          <Button
            key="refresh"
            label="Refresh"
            variant="secondary"
            onPress={() => void readLive($)}
          />
          <Button
            key="clear-ledger"
            label="Clear session"
            plain
            dimColor
            onPress={() =>
              void (async () => {
                await update($, ledger, () => [])
                await update($, status, () => 'Session ledger cleared.')
              })()
            }
          />
          <Button
            key="close"
            label="Close"
            role="dismiss"
            dimColor
            onPress={() => void $.ui.close({ id: PANE })}
          />
        </Box>
        <Text dimColor wrap="wrap">{note !== '' ? note : 'Esc closes.'}</Text>
      </Box>
    )
  })
}
