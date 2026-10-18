import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer, TurnCompleteInput } from 'claude-code'
import type { CompareSide, CompareVerdict } from '../types'

const PANE = 'model-compare'
const COMMAND = 'compare'
const DOT = 'compare-dot'

/** The most of one reply the pane draws; the rest is left to Copy. */
const REPLY_LIMIT = 2000

/** How often a running column's seconds move. */
const TICK_MS = 250

const left = atom({ plugin: 'model-compare', key: 'left' } as const, '')
const right = atom({ plugin: 'model-compare', key: 'right' } as const, '')
const prompt = atom({ plugin: 'model-compare', key: 'prompt' } as const, '')
const status = atom({ plugin: 'model-compare', key: 'status' } as const, '')
const isBusy = atom({ plugin: 'model-compare', key: 'isBusy' } as const, false)
const sides = atom({ plugin: 'model-compare', key: 'sides' } as const, [] as CompareSide[])
const models = atom({ plugin: 'model-compare', key: 'models' } as const, [] as string[])
/** The column being typed into, when its id is not in the gateway's list. */
const typing = atom({ plugin: 'model-compare', key: 'typing' } as const, '' as '' | 'left' | 'right' | 'left-dir' | 'right-dir')
/** A plain ask of both models, or a task each of them executes in its own folder. */
const mode = atom({ plugin: 'model-compare', key: 'mode' } as const, 'ask' as 'ask' | 'task')
/** The folder a column's task runs in. Both are cleared after every run. */
const leftDir = atom({ plugin: 'model-compare', key: 'leftDir' } as const, '')
const rightDir = atom({ plugin: 'model-compare', key: 'rightDir' } as const, '')
/** The folder the two pickers list, and the subfolders they offer. */
const base = atom({ plugin: 'model-compare', key: 'base' } as const, '')
const dirs = atom({ plugin: 'model-compare', key: 'dirs' } as const, [] as string[])
/** The clock the pane reads while a run is in flight: a tick moves it on. */
const nowMs = atom({ plugin: 'model-compare', key: 'nowMs' } as const, 0)
/** Blind judging: the pane hides which model each column is until revealed. */
const blind = atom({ plugin: 'model-compare', key: 'blind' } as const, false)
/** Each column's rating, 1 to 5, as the person gave it; null until rated. */
const rates = atom({ plugin: 'model-compare', key: 'rates' } as const, [] as (number | null)[])
/** The model judge's verdict: the scores, the winner and its reason. */
const judge = atom({ plugin: 'model-compare', key: 'judge' } as const, '')

type Dollar = EngineInterface

type Options = {
  showDot: boolean
  rightModel: string
  paneRows: number
  maxTokens: number
  timeoutSeconds: number
}

/** The session's model as `/model` shows it, less a `[1m]` context suffix. */
const plain = (id: string): string => id.replace(/\[1m\]$/i, '')

/**
 * A gateway's own words, or a model's, as the drawing takes them. The drawing
 * refuses any tree holding a control character, and refuses the whole tree
 * with it.
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

/** A path's last segment, which is what the folder fields show. */
function tail(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut < 0 ? path : path.slice(cut + 1)
}

/** `name` under `folder`, spelled with the separator `folder` already uses. */
function join(folder: string, name: string): string {
  const separator = folder.includes('\\') ? '\\' : '/'
  return folder.replace(/[\\/]+$/, '') + separator + name
}

/** Where the model list is read from, and the credential it is read with. */
async function endpoint($: Dollar): Promise<{ url: string; token: string } | null> {
  const base = (await $.env.get('ANTHROPIC_BASE_URL')) ?? ''
  const token =
    (await $.env.get('ANTHROPIC_AUTH_TOKEN')) ?? (await $.env.get('ANTHROPIC_API_KEY')) ?? ''
  if (base === '') return null
  return { url: base.replace(/\/+$/, '') + '/v1/models', token }
}

/**
 * Reads the gateway's model ids, so the second column can be filled without
 * typing an id. A gateway that will not answer leaves the list empty: the
 * columns are still typable, and the comparison never needs this list.
 */
async function loadGatewayModels($: Dollar): Promise<void> {
  const target = await endpoint($)
  if (!target) return
  try {
    const headers: Record<string, string> = { 'anthropic-version': '2023-06-01' }
    if (target.token !== '') {
      headers.authorization = `Bearer ${target.token}`
      headers['x-api-key'] = target.token
    }
    const res = await $.http.fetch(target.url, { headers })
    if (!res.ok) return
    const body = JSON.parse(res.text) as { data?: { id?: unknown }[] }
    const list: string[] = []
    for (const row of body.data ?? []) {
      if (row !== null && typeof row === 'object' && typeof row.id === 'string' && row.id !== '') {
        const id = clean(row.id)
        if (!list.includes(id)) list.push(id)
      }
    }
    list.sort((a, b) => a.localeCompare(b))
    await update($, models, () => list)
  } catch {
    // No list: the columns take a typed id.
  }
}

/** Fills the model list once, if the gateway has not answered yet. */
async function ensureModels($: Dollar): Promise<void> {
  if ((await read($, models)).length > 0) return
  await loadGatewayModels($)
}

/**
 * Puts a model in each column: the session's own on the left, and on the right
 * the configured one, the last one used, or the first the gateway lists that
 * is not the session's.
 */
async function seedModels($: Dollar, options: Options): Promise<void> {
  const started = plain(await $.session.model())
  if ((await read($, left)).trim() === '' && started !== '') {
    await update($, left, () => started)
  }
  if ((await read($, right)).trim() !== '') return

  const configured = options.rightModel.trim()
  if (configured !== '') {
    await update($, right, () => configured)
    return
  }
  const stored = await $.store.get('right')
  if (typeof stored === 'string' && stored.trim() !== '') {
    await update($, right, () => stored)
    return
  }
  const pick = (await read($, models)).find(one => plain(one) !== started)
  if (pick !== undefined) await update($, right, () => pick)
}

/**
 * Puts the prompt in the box: what the person is typing, else the last thing
 * they asked in this session. Either is untrusted text and is cleaned.
 */
async function seedPrompt($: Dollar): Promise<void> {
  if ((await read($, prompt)).trim() !== '') return

  const box = await $.prompt.read()
  const typed = clean(box.text).trim()
  if (typed !== '') {
    await update($, prompt, () => typed)
    return
  }
  const messages = await $.session.messages()
  const last = [...messages].reverse().find(one => one.role === 'user')
  if (last === undefined) return
  const said = clean(last.text).trim()
  if (said !== '') await update($, prompt, () => said.slice(0, 4000))
}

/** One model's answer, or why it did not answer, as a column shows it. */
async function askOne(
  $: Dollar,
  model: string,
  text: string,
  options: Options,
  signal: AbortSignal,
): Promise<CompareSide> {
  const started = await $.clock.now()
  try {
    const result = await $.model.complete(
      {
        model,
        prompt: text,
        maxTokens: Math.max(1, options.maxTokens),
        timeoutMs: Math.max(1, Math.round(options.timeoutSeconds)) * 1000,
      },
      { signal },
    )
    const usage = result.usage
    const base = {
      model,
      startedAt: started,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      ms: (await $.clock.now()) - started,
    }
    if (result.isAnswered) {
      return { ...base, isAnswered: true, text: clean(result.text) }
    }
    if (result.reason === 'api-error') {
      return {
        ...base,
        isAnswered: false,
        text: '',
        reason: 'api-error',
        status: result.status,
        error: result.error,
      }
    }
    return { ...base, isAnswered: false, text: '', reason: result.reason }
  } catch (error) {
    return {
      model,
      startedAt: started,
      isAnswered: false,
      text: '',
      reason: 'failed',
      error: clean(String(error)),
      inputTokens: 0,
      outputTokens: 0,
      ms: (await $.clock.now()) - started,
    }
  }
}

/**
 * The pair of calls in flight, so a Cancel press stops the ones an earlier
 * press started. It never leaves this module.
 */
let stop: AbortController | null = null

/** The tick that moves `nowMs` on while a run is in flight, if one is running. */
let ticker: Timer | null = null

/** Stops the ticker: with nothing in flight, no column's seconds move. */
function stopTicker(): void {
  if (ticker === null) return
  ticker.cancel()
  ticker = null
}

/**
 * Starts the tick that moves `nowMs` on, so every running column's seconds
 * count up while it waits. `nowMs` starts at the clock's now, so a column that
 * has just begun reads 0.0s rather than a negative time.
 */
async function startTicker($: Dollar): Promise<void> {
  stopTicker()
  const now = await $.clock.now()
  await update($, nowMs, () => now)
  ticker = $.clock.every(TICK_MS, () => {
    void (async () => {
      // A run that ended without saying so — an agent that never reported —
      // stops the tick rather than moving a clock nothing reads.
      const running = (await read($, sides)).some(one => one.isRunning)
      if (!(await read($, isBusy)) || !running) {
        stopTicker()
        return
      }
      const at = await $.clock.now()
      await update($, nowMs, () => at)
    })()
  })
}

/**
 * Marks a run in flight or over, and runs the ticker only while it is: a
 * column shows its seconds move for as long as the run it belongs to lasts.
 */
async function setBusy($: Dollar, busy: boolean): Promise<void> {
  await update($, isBusy, () => busy)
  if (busy) await startTicker($)
  else stopTicker()
}

/**
 * The pane's last word: drawn under its buttons, and mirrored on the status
 * line, so a run's progress reads with the pane closed. `undefined` clears the
 * line and leaves the pane's word alone.
 */
async function say($: Dollar, text: string): Promise<void> {
  await update($, status, () => text)
  // A host that draws no status line, or a test's engine beneath the plugin,
  // leaves the word to the pane alone.
  try {
    $.ui.status(text === '' ? undefined : `compare · ${text}`)
  } catch {
    // The pane still says it.
  }
}

/** Raises a toast, where the host draws one. */
function tell($: Dollar, text: string): void {
  try {
    $.ui.toast(text)
  } catch {
    // The pane still says it.
  }
}

/** Asks both models the same prompt, then stores what each said. */
async function runCompare($: Dollar, options: Options): Promise<void> {
  if (await read($, isBusy)) return

  const leftId = (await read($, left)).trim()
  const rightId = (await read($, right)).trim()
  const text = (await read($, prompt)).trim()

  if (leftId === '' || rightId === '') {
    await say($, 'Name a model in each column.')
    return
  }
  if (leftId === rightId) {
    await say($, 'Both columns name the same model: pick another.')
    return
  }
  if (text === '') {
    await say($, 'Type the prompt both models answer.')
    return
  }

  const controller = new AbortController()
  stop = controller
  const started = await $.clock.now()

  await setBusy($, true)
  // Both columns are drawn at once, each counting its own seconds: a run that
  // is still waiting looks like one, rather than an empty pane.
  await update($, sides, () => [
    emptySide(leftId, undefined, true, started),
    emptySide(rightId, undefined, true, started),
  ])
  await update($, rates, () => [])
  await update($, judge, () => '')
  await say($, `asking ${leftId} and ${rightId}…`)

  try {
    const both = await Promise.all([
      askOne($, leftId, text, options, controller.signal),
      askOne($, rightId, text, options, controller.signal),
    ])
    const answered = both.filter(one => one.isAnswered).length
    await update($, sides, () => both)
    const seconds = (((await $.clock.now()) - started) / 1000).toFixed(1)
    await say($, `${answered}/2 answered · ${seconds}s`)
    tell(
      $,
      answered === 2
        ? `compare · both answered in ${seconds}s`
        : `compare · ${answered}/2 answered · ${seconds}s`,
    )
    await $.store.set('right', rightId)
  } catch (error) {
    await say($, clean(`Compare failed: ${String(error)}`))
  } finally {
    await setBusy($, false)
    if (stop === controller) stop = null
  }
}

/**
 * Asks one column again, leaving the other where it stands: a failure on one
 * side is worth another try without paying for the answer already in hand.
 */
async function retryOne($: Dollar, options: Options, which: 'left' | 'right'): Promise<void> {
  if (await read($, isBusy)) return

  const leftId = (await read($, left)).trim()
  const rightId = (await read($, right)).trim()
  const text = (await read($, prompt)).trim()
  if (leftId === '' || rightId === '' || text === '') {
    await say($, 'Name a model in each column and type the prompt.')
    return
  }
  if (leftId === rightId) {
    await say($, 'Both columns name the same model: pick another.')
    return
  }

  const model = which === 'left' ? leftId : rightId
  const controller = new AbortController()
  stop = controller
  await setBusy($, true)
  await putSide($, which, emptySide(model, undefined, true, await $.clock.now()))
  await say($, `asking ${model} again…`)

  try {
    const side = await askOne($, model, text, options, controller.signal)
    await putSide($, which, side)
    const answered = answeredCount(await read($, sides))
    await say($, `${answered}/2 answered · retried ${model}`)
    tell($, `compare · ${answered}/2 answered`)
  } catch (error) {
    await say($, clean(`The retry failed: ${String(error)}`))
  } finally {
    await setBusy($, false)
    if (stop === controller) stop = null
  }
}

/**
 * Reads the subfolders of the session's own folder, so each column's task
 * folder can be picked rather than typed. A folder that will not list leaves
 * the list empty: the fields are still typable.
 */
async function loadFolders($: Dollar): Promise<void> {
  const root = await $.session.cwd().catch(() => '')
  if (root === '') return
  await update($, base, () => root)
  try {
    const entries = await $.fs.list(root)
    const names = entries
      .filter(entry => entry.kind === 'dir')
      .map(entry => clean(entry.name))
      .filter(name => name !== '' && !name.startsWith('.'))
    names.sort((a, b) => a.localeCompare(b))
    await update($, dirs, () => names)
  } catch {
    // No list: the folder is typed.
  }
}

/** Fills the folder list once, if the session's folder has not been read. */
async function ensureFolders($: Dollar): Promise<void> {
  if ((await read($, dirs)).length > 0 || (await read($, base)) !== '') return
  await loadFolders($)
}

/**
 * The folder a column's task runs in, as the engine will see it: absolute, the
 * same folder spelled two ways folded to one. Null with the reason it cannot
 * be used, which the pane says.
 */
async function taskFolder($: Dollar, path: string): Promise<{ real: string } | { why: string }> {
  const spelled = path.trim()
  if (spelled === '') return { why: 'Pick a folder for each column before running a task.' }
  const stat = await $.fs.stat(spelled, { resolve: true }).catch(() => undefined)
  if (stat === undefined) return { why: `No folder at ${spelled}.` }
  if (stat.kind !== 'dir') return { why: `${spelled} is not a folder.` }
  if (stat.realPath === undefined) return { why: `Could not resolve ${spelled}.` }
  return { real: stat.realPath }
}

/** One column's task in flight: where its agent runs, and how long it has run. */
type Pending = {
  side: 'left' | 'right'
  model: string
  folder: string
  started: number
}

/**
 * The tasks in flight, by the id of the agent running each, and the runs that
 * have been cancelled. Both never leave this module: the engine has no call
 * that stops a subagent, so a cancelled run's answer is dropped when it comes.
 */
const waiting = new Map<string, Pending>()
const cancelled = new Set<string>()

/** Writes one column's side, leaving the other where it stands. */
async function putSide($: Dollar, side: 'left' | 'right', value: CompareSide): Promise<void> {
  await update($, sides, shown => {
    const next = shown.slice(0, 2)
    if (side === 'left') return [value, next[1] ?? emptySide('', undefined, false)]
    return [next[0] ?? emptySide('', undefined, false), value]
  })
}

/** A column that has not answered yet: what the pane draws while it works. */
function emptySide(model: string, folder?: string, isRunning = true, startedAt?: number): CompareSide {
  return {
    model,
    folder,
    isAnswered: false,
    text: '',
    isRunning,
    startedAt,
    inputTokens: 0,
    outputTokens: 0,
    ms: 0,
  }
}

/** How a task's end reads in its column. */
function sideOf(end: TurnCompleteInput, pending: Pending): CompareSide {
  const usage = end.usage
  const base = {
    model: pending.model,
    folder: pending.folder,
    startedAt: pending.started,
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    ms: end.durationMs,
  }
  if (end.reason === 'answer') {
    const said = clean(end.answer)
    if (said.trim() === '') return { ...base, isAnswered: false, text: '', reason: 'empty-reply' }
    return { ...base, isAnswered: true, text: said }
  }
  if (end.reason === 'aborted') return { ...base, isAnswered: false, text: '', reason: 'aborted' }
  if (end.reason === 'refusal') {
    return {
      ...base,
      isAnswered: false,
      text: '',
      reason: 'refused',
      error: clean(end.refusal.explanation ?? end.refusal.category ?? ''),
    }
  }
  return { ...base, isAnswered: false, text: '', reason: 'failed' }
}

/**
 * The system prompt a task agent runs under: what `general-purpose` gives one,
 * stated here because a registered type's prompt replaces the session's whole.
 */
const TASK_PROMPT = `You are an agent for Claude Code, Anthropic's official CLI for Claude. Given the user's message, use the tools available to complete the task. Complete the task fully — don't gold-plate, but don't leave it half-done. When you finish, respond with a concise report covering what was done and any key findings; the caller relays it to the user, so it only needs the essentials. Share file paths as absolute paths, and do not write report or summary files unless the task asks for them.`

/**
 * The agent type a model runs as, by model id.
 *
 * A spawn's `model` goes through the Agent tool's own parameter, which takes
 * only the four aliases (`sonnet`, `opus`, `haiku`, `fable`): a gateway id
 * there is refused before the agent starts. A registered type's `model` takes
 * a full id, and a spawn naming that type runs on it — so each model a column
 * is set to gets a type of its own, made the first time it is asked for.
 */
const taskTypes = new Map<string, string>()

/** A model id as a type's short name: letters, digits and dashes, 64 at most. */
function taskTypeName(model: string): string {
  const slug = model
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  let hash = 2166136261
  for (let i = 0; i < model.length; i += 1) {
    hash = Math.imul(hash ^ model.charCodeAt(i), 16777619) >>> 0
  }
  return `task-${slug === '' ? 'model' : slug}-${hash.toString(36)}`
}

/**
 * The agent type to spawn a column's task as: `<plugin>:<name>`, registered on
 * that column's model. Undefined where the host has no `$.agent.register` —
 * the test kit's `$` — and the caller hands the model to the spawn instead.
 */
async function taskTypeFor($: Dollar, model: string): Promise<string | undefined> {
  const known = taskTypes.get(model)
  if (known !== undefined) return known
  try {
    const made = await $.agent.register({
      name: taskTypeName(model),
      description: 'One column of a model-compare task run.',
      prompt: TASK_PROMPT,
      model,
    })
    taskTypes.set(model, made.agent)
    return made.agent
  } catch (error) {
    // A host with no such call — the test kit's `$`: the spawn takes the model.
    // Anything else is the engine refusing the spec, and is the pane's to say.
    if (/is not a function/.test(String(error))) return undefined
    throw error
  }
}

/**
 * A task's prompt as its column's agent reads it. The engine does not move a
 * plugin's spawn into its `cwd` on every build, so the folder is stated too:
 * the agent is told where to work, in the terms its tools take.
 */
function taskPrompt(folder: string, text: string): string {
  return `Work only inside this folder: ${folder}\nEvery path you read, write or run must be absolute and under it. Do not change anything outside it.\n\n${text}`
}

/**
 * Starts one column's task: a subagent on that column's model, in that
 * column's folder. It resolves once the agent started; the answer arrives as
 * its own `turn.complete`, matched by `agentId` in `waiting`.
 */
async function spawnTask(
  $: Dollar,
  side: 'left' | 'right',
  model: string,
  folder: string,
  text: string,
): Promise<CompareSide | undefined> {
  const started = await $.clock.now()
  const label = taskLabel(side)
  try {
    // The column's model is the agent type's own. Naming it on the spawn would
    // be refused where the Agent tool checks it, a gateway id not being one of
    // the four aliases; the type is the way past that, and where no type could
    // be made the spawn is given the model and the host decides.
    const type = await taskTypeFor($, model)
    const spawned = await $.agent.spawn({
      prompt: taskPrompt(folder, text),
      cwd: folder,
      description: label,
      subagentType: type ?? 'general-purpose',
      ...(type === undefined ? { model } : {}),
    })
    if (spawned.deny !== undefined) {
      return {
        model,
        folder,
        isAnswered: false,
        text: '',
        reason: 'failed',
        error: clean(spawned.deny),
        inputTokens: 0,
        outputTokens: 0,
        ms: (await $.clock.now()) - started,
      }
    }
    if (spawned.agentId === undefined) {
      return {
        model,
        folder,
        isAnswered: false,
        text: '',
        reason: 'failed',
        error: 'The task started with no agent to hear from.',
        inputTokens: 0,
        outputTokens: 0,
        ms: (await $.clock.now()) - started,
      }
    }
    waiting.set(spawned.agentId, { side, model, folder, started })
    return undefined
  } catch (error) {
    return {
      model,
      folder,
      isAnswered: false,
      text: '',
      reason: 'failed',
      error: clean(String(error)),
      inputTokens: 0,
      outputTokens: 0,
      ms: (await $.clock.now()) - started,
    }
  }
}

/** How many of a pair of sides answered. */
const answeredCount = (shown: readonly CompareSide[]): number =>
  shown.filter(one => one.isAnswered).length

/**
 * Runs both columns as tasks: each model gets its own folder, and neither
 * folder carries over to the next run.
 */
async function runTask($: Dollar, options: Options): Promise<void> {
  if (await read($, isBusy)) return

  const leftId = (await read($, left)).trim()
  const rightId = (await read($, right)).trim()
  const text = (await read($, prompt)).trim()

  if (leftId === '' || rightId === '') {
    await say($, 'Name a model in each column.')
    return
  }
  if (leftId === rightId) {
    await say($, 'Both columns name the same model: pick another.')
    return
  }
  if (text === '') {
    await say($, 'Type the task both models run.')
    return
  }

  const leftFolder = await taskFolder($, await read($, leftDir))
  const rightFolder = await taskFolder($, await read($, rightDir))
  if ('why' in leftFolder) {
    await say($, leftFolder.why)
    return
  }
  if ('why' in rightFolder) {
    await say($, rightFolder.why)
    return
  }
  if (leftFolder.real === rightFolder.real) {
    await say($, 'The two columns must run in different folders.')
    return
  }

  const started = await $.clock.now()
  await setBusy($, true)
  await update($, sides, () => [
    emptySide(leftId, leftFolder.real, true, started),
    emptySide(rightId, rightFolder.real, true, started),
  ])
  await update($, rates, () => [])
  await update($, judge, () => '')
  await say($, `running ${leftId} in ${leftFolder.real}, ${rightId} in ${rightFolder.real}…`)

  try {
    const failed: CompareSide[] = []
    const [leftSide, rightSide] = await Promise.all([
      spawnTask($, 'left', leftId, leftFolder.real, text),
      spawnTask($, 'right', rightId, rightFolder.real, text),
    ])
    if (leftSide !== undefined) {
      failed.push(leftSide)
      await putSide($, 'left', leftSide)
    }
    if (rightSide !== undefined) {
      failed.push(rightSide)
      await putSide($, 'right', rightSide)
    }
    if (failed.length === 2) {
      await setBusy($, false)
      await say($, clean('Neither task could start.'))
    } else {
      const seconds = (((await $.clock.now()) - started) / 1000).toFixed(1)
      await say($, `started · ${seconds}s · each column reports when its task ends`)
      // A folder is used once: the next run has to pick its own pair.
      await update($, leftDir, () => '')
      await update($, rightDir, () => '')
      await update($, typing, () => '')
    }
    await $.store.set('right', rightId)
  } catch (error) {
    await setBusy($, false)
    await say($, clean(`The task run failed: ${String(error)}`))
  }
}

/** Opens the comparison, seeds both columns and runs it. */
async function openCompare($: Dollar, options: Options, seed = ''): Promise<void> {
  const opened = await $.ui.open({
    id: PANE,
    title: 'Compare',
    focus: true,
    closeOnEscape: true,
    rows: Math.max(6, options.paneRows),
  })
  if (!opened.isPlaced) {
    tell($, clean(`Compare could not open: ${opened.reason}`))
    return
  }

  await ensureModels($)
  await seedModels($, options)
  if (seed.trim() !== '') {
    await update($, prompt, () => clean(seed).trim())
  } else {
    await seedPrompt($)
  }
  if ((await read($, mode)) === 'task') {
    await ensureFolders($)
    return
  }
  await runCompare($, options)
}

/** Runs the prompt the way the pane's mode says: a plain ask, or a task. */
async function runCurrent($: Dollar, options: Options): Promise<void> {
  if ((await read($, mode)) === 'task') {
    await ensureFolders($)
    await runTask($, options)
    return
  }
  await runCompare($, options)
}

/** A task spawn's description for a column. */
const taskLabel = (side: 'left' | 'right'): string => `model-compare ${side}`

/** Why a column has no reply, in the pane's words. */
function failureOf(side: CompareSide): string {
  if (side.reason === 'api-error') {
    const code = side.status === null || side.status === undefined ? 'no response' : `${side.status}`
    return `API error · ${code} · ${side.error ?? 'unknown'}`
  }
  if (side.reason === 'empty-reply') return 'The model replied with no text.'
  if (side.reason === 'aborted') return 'Cut short.'
  if (side.reason === 'refused') {
    return side.error !== undefined && side.error !== '' ? `Refused · ${side.error}` : 'Refused.'
  }
  if (side.reason === 'failed') {
    return side.error !== undefined && side.error !== '' ? side.error : 'The call failed.'
  }
  return 'No answer.'
}

/** The next id in the gateway's list after `current`, wrapping at the end. */
function nextAfter(list: readonly string[], current: string): string {
  if (list.length === 0) return ''
  const index = list.findIndex(one => plain(one) === plain(current))
  const next = list[(index + 1) % list.length]
  return next ?? ''
}

/** One column's elapsed seconds, read live while it runs and fixed once it ends. */
function elapsedOf(side: CompareSide, now: number): number {
  if (side.isRunning && side.startedAt !== undefined) return Math.max(0, now - side.startedAt)
  return side.ms
}

/** Elapsed milliseconds as the pane spells them: `2.5s`, `1m 04s`. */
function duration(ms: number): string {
  const seconds = Math.max(0, ms) / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const whole = Math.floor(seconds)
  return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, '0')}s`
}

/** A column's generation speed: the tokens it made in a second of its time. */
function speedOf(side: CompareSide): string {
  if (side.ms <= 0 || side.outputTokens <= 0) return ''
  return `${(side.outputTokens / (side.ms / 1000)).toFixed(1)} tok/s`
}

/** How many past runs said each model of a pair won, by name. */
async function recordOf($: Dollar, a: string, b: string): Promise<[number, number]> {
  const history = (await $.store.get('verdicts')) as CompareVerdict[] | undefined
  const wins: [number, number] = [0, 0]
  for (const one of history ?? []) {
    if (one.winner === null) continue
    const [first, second] = one.models
    if (one.winner === 0) {
      if (first === a && second === b) wins[0] += 1
      if (first === b && second === a) wins[1] += 1
    } else {
      if (first === a && second === b) wins[1] += 1
      if (first === b && second === a) wins[0] += 1
    }
  }
  return wins
}

/**
 * Lays a fresh verdict over the remembered ones, the newest first, and keeps
 * the most recent runs only.
 */
async function rememberVerdict($: Dollar, verdict: CompareVerdict): Promise<void> {
  const history = ((await $.store.get('verdicts')) as CompareVerdict[] | undefined) ?? []
  await $.store.set('verdicts', [verdict, ...history].slice(0, 50))
}

/** The prompt the judge model reads: anonymous answers, a strict form back. */
const JUDGE_INSTRUCTION = `You are a strict, impartial judge of AI answers. Two answers, A and B, were written by two different models responding to the same prompt. The answers are anonymous: you do not know and must not guess which model wrote either. Judge only what is written: correctness first, then completeness, clarity and usefulness. Score each answer 1 to 10 and reply in exactly this form, nothing else:

A: <1-10>
B: <1-10>
Winner: <A|B|tie>
Reason: <one or two sentences in the same language as the prompt>`

/**
 * Asks one model to judge the pair's two answers blind. The answers are sent
 * as A and B, in an order flipped at random, so a judge cannot favour a
 * position: the scores come back mapped to the columns they belong to.
 */
async function judgeRun($: Dollar, options: Options, text: string, shown: readonly CompareSide[]): Promise<void> {
  const [leftSide, rightSide] = shown
  if (leftSide === undefined || rightSide === undefined) return
  await update($, judge, () => 'A model is judging the two answers…')
  await say($, 'asking a model to judge the two answers…')

  const flipped = Math.random() < 0.5
  const first = flipped ? rightSide : leftSide
  const second = flipped ? leftSide : rightSide

  try {
    const result = await $.model.complete({
      model: (await read($, left)).trim(),
      maxTokens: Math.max(1, options.maxTokens) * 4,
      timeoutMs: Math.max(1, Math.round(options.timeoutSeconds)) * 1000,
      prompt: `${JUDGE_INSTRUCTION}\n\n<original prompt>\n${text}\n</original prompt>\n\n<answer A>\n${first.text}\n</answer A>\n\n<answer B>\n${second.text}\n</answer B>`,
    })

    if (!result.isAnswered) {
      await update($, judge, () => `The judge did not answer (${result.reason}).`)
      await say($, 'the judge did not answer')
      return
    }

    // The reply's scores are for A and B as sent; mapped back through the
    // flip, they are this column's own.
    const score = (letter: 'A' | 'B'): number | null => {
      const line = result.text
        .split('\n')
        .find(one => one.trim().toUpperCase().startsWith(`${letter}:`))
      if (line === undefined) return null
      const n = Number.parseFloat(line.replace(/^[^0-9]*/, '').replace(/[^0-9.].*$/, ''))
      return Number.isFinite(n) ? Math.min(10, Math.max(0, n)) : null
    }
    const a = score('A')
    const b = score('B')
    const leftScore = flipped ? b : a
    const rightScore = flipped ? a : b
    if (leftScore === null || rightScore === null) {
      await update($, judge, () => `The judge's reply did not parse:\n${clean(result.text).slice(0, 400)}`)
      await say($, 'the judge\'s reply did not parse')
      return
    }
    const winnerLine = result.text
      .split('\n')
      .find(one => one.trim().toLowerCase().startsWith('winner:'))
    const reasonLine = result.text
      .split('\n')
      .find(one => one.trim().toLowerCase().startsWith('reason:'))
    const name = (index: 0 | 1): string => (shown[index]?.model ?? `column ${index === 0 ? 'A' : 'B'}`)
    const verdict = `⚖ Judge: ${leftScore}/10 vs ${rightScore}/10 — ${
      leftScore === rightScore ? 'tie' : leftScore > rightScore ? `${name(0)} wins` : `${name(1)} wins`
    }${reasonLine !== undefined ? `\n${clean(reasonLine.replace(/^reason:/i, '').trim())}` : ''}`
    await update($, judge, () => verdict)
    // The judge's 10 carries into the person's 5-star scale, already filled.
    await update($, rates, () => [
      Math.max(1, Math.min(5, Math.round(leftScore / 2))),
      Math.max(1, Math.min(5, Math.round(rightScore / 2))),
    ])
    await say($, `judge scored it ${leftScore}–${rightScore}${winnerLine === undefined ? ' (no winner line)' : ''}`)
  } catch (error) {
    await update($, judge, () => `The judge failed: ${clean(String(error)).slice(0, 300)}`)
    await say($, 'the judge failed')
  }
}

export const register: Register = (on, raw) => {
  const options: Options = {
    showDot: raw.showDot !== false,
    rightModel: typeof raw.rightModel === 'string' ? raw.rightModel : '',
    paneRows: typeof raw.paneRows === 'number' ? raw.paneRows : 24,
    maxTokens: typeof raw.maxTokens === 'number' ? raw.maxTokens : 1024,
    timeoutSeconds: typeof raw.timeoutSeconds === 'number' ? raw.timeoutSeconds : 120,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Ask two models the same prompt and show the answers side by side',
    })
    await update($, status, () => '')
    await update($, sides, () => [])
    await update($, rates, () => [])
  await update($, judge, () => '')
    await update($, blind, () => false)
    try {
      $.ui.status(undefined)
    } catch {
      // No status line beneath: the pane is the only place it shows.
    }
    if (e.isInteractive) {
      const started = plain(await $.session.model())
      if ((await read($, left)).trim() === '') await update($, left, () => started)
      void loadGatewayModels($)
    }
    return next(e)
  })

  // A task's type is the plugin's own, for the pane's Run to spawn: the model
  // is not offered it, so it never dispatches one itself.
  on('agent.offer', (_, e, next) => {
    for (const type of taskTypes.values()) {
      if (type === e.agent) return { isOffered: false }
    }
    return next(e)
  })

  // A task run's answers: each subagent's end, matched to the column that
  // spawned it. Every hook hears every agent's end, so the hook passes the
  // event on after it has used it, and a late answer from a cancelled run is
  // dropped.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) return next(e)
    const pending = waiting.get(e.agentId)
    if (pending === undefined) return next(e)

    waiting.delete(e.agentId)
    if (cancelled.delete(e.agentId)) return next(e)

    await putSide($, pending.side, sideOf(e, pending))
    const shown = await read($, sides)
    const answered = answeredCount(shown)
    const running = shown.filter(one => one.isRunning).length
    const seconds = (((await $.clock.now()) - pending.started) / 1000).toFixed(1)
    if (running === 0) {
      await setBusy($, false)
      await say($, `${answered}/2 answered · ${seconds}s`)
      tell(
        $,
        answered === 2
          ? `compare · both tasks ended in ${seconds}s`
          : `compare · ${answered}/2 tasks ended · ${seconds}s`,
      )
    } else {
      await say($, `${answered}/2 answered · ${running} still running…`)
    }
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    await openCompare($, options, e.args)
    return { text: 'Comparison opened: both columns ask the same prompt.' }
  }).catch(($, e, next) => (next.called ? next(e) : { text: 'The comparison could not open.' }))

  // The green dot leads the hint line, and whatever is beneath is drawn after
  // it: the engine's own line, or another plugin's. Only the first hook in the
  // chain draws a component, so the dot shows only where this plugin is
  // admitted before any other that draws the same line.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (!options.showDot) return next(e)

    const busy = await read($, isBusy)
    const { Box, Button, Text } = $.ui.resolve(e)

    let below: JSX.Element | undefined
    try {
      below = await next(e)
    } catch {
      // Nothing beneath answers: the dot still draws, with the plain hint.
      below = undefined
    }

    return (
      <Box>
        <Button key={DOT} plain onPress={() => void openCompare($, options)}>
          <Text color="success" dimColor={busy}>
            ●
          </Text>
        </Button>
        <Text>{' '}</Text>
        {below ?? <Text dimColor>{e.props.hint}</Text>}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const leftId = await read($, left)
    const rightId = await read($, right)
    const text = await read($, prompt)
    const note = await read($, status)
    const busy = await read($, isBusy)
    const shown = await read($, sides)
    const list = await read($, models)
    const edit = await read($, typing)
    const way = await read($, mode)
    const leftFolder = await read($, leftDir)
    const rightFolder = await read($, rightDir)
    const root = await read($, base)
    const folders = await read($, dirs)
    const now = await read($, nowMs)
    const hidden = await read($, blind)
    const given = await read($, rates)
    const judged = await read($, judge)

    const canType = e.surface !== 'mobile'
    const width = Math.max(20, e.props.bodyColumns)
    const stacked = width < 64
    const gap = 3
    const colWidth = stacked ? width : Math.floor((width - gap) / 2)

    const { Box, Button, Markdown, Text } = $.ui.resolve(e)

    const inputs: JSX.Element[] = []
    if (canType) {
      const { Input, Select } = $.ui.resolve(e)

      // With the gateway's list in hand, a column is picked from it; without
      // one (a gateway that will not list) the id is typed instead. The `✎
      // beside a picker types one the list lacks, such as a new model. The
      // state scan reads each atom by its literal name, so the two columns
      // are written out rather than looped over.
      const optionsOf = (value: string) =>
        (value !== '' && !list.includes(value) ? [value, ...list] : list).map(id => ({
          value: id,
          label: id,
        }))
      if (list.length > 0) {
        inputs.push(
          edit === 'left' ? (
            <Input
              key="left"
              label="left   "
              placeholder="model id"
              value={leftId}
              onSubmit={value => {
                const id = clean(value).trim()
                if (id !== '') void update($, left, () => id)
                void update($, typing, () => '')
              }}
              onInput={value => void update($, left, () => clean(value).trim())}
            />
          ) : (
            <Box key="left-row">
              <Select
                key="left-model"
                label="left   "
                options={optionsOf(leftId)}
                value={leftId}
                onSelect={value => void update($, left, () => clean(value).trim())}
              />
              <Button
                key="left-type"
                label="✎"
                plain
                dimColor
                onPress={() => void update($, typing, () => 'left')}
              />
            </Box>
          ),
        )
        inputs.push(
          edit === 'right' ? (
            <Input
              key="right"
              label="right  "
              placeholder="model id"
              value={rightId}
              onSubmit={value => {
                const id = clean(value).trim()
                if (id !== '') void update($, right, () => id)
                void update($, typing, () => '')
              }}
              onInput={value => void update($, right, () => clean(value).trim())}
            />
          ) : (
            <Box key="right-row">
              <Select
                key="right-model"
                label="right  "
                options={optionsOf(rightId)}
                value={rightId}
                onSelect={value => void update($, right, () => clean(value).trim())}
              />
              <Button
                key="right-type"
                label="✎"
                plain
                dimColor
                onPress={() => void update($, typing, () => 'right')}
              />
            </Box>
          ),
        )
      } else {
        inputs.push(
          <Input
            key="left"
            label="left   "
            placeholder="model id"
            value={leftId}
            onSubmit={value => void update($, left, () => clean(value).trim())}
            onInput={value => void update($, left, () => clean(value).trim())}
          />,
        )
        inputs.push(
          <Input
            key="right"
            label="right  "
            placeholder="model id"
            value={rightId}
            onSubmit={value => void update($, right, () => clean(value).trim())}
            onInput={value => void update($, right, () => clean(value).trim())}
          />,
        )
      }
      inputs.push(
        <Input
          key="prompt"
          label="prompt "
          placeholder="what both models answer…"
          rows={2}
          value={text}
          onSubmit={value => void update($, prompt, () => clean(value))}
          onInput={value => void update($, prompt, () => clean(value))}
        />,
      )
      // A task run needs a folder per column, and a fresh pair for every run:
      // each pick is consumed by the run that uses it. The folders are the
      // session's own subfolders, offered as a pick, or typed when the folder
      // being run in is not under it.
      const folderField = (side: 'left' | 'right', value: string) => {
        const path = value.trim()
        const known = folders.map(name => join(root, name))
        const choices = path !== '' && !known.includes(path) ? [path, ...known] : known
        const label = side === 'left' ? 'left dir ' : 'right dir'
        if (way !== 'task') return undefined
        if (edit === `${side}-dir`) {
          return (
            <Input
              key={`${side}-dir`}
              label={label}
              placeholder="folder the task runs in"
              value={path}
              onSubmit={typed => {
                const picked = clean(typed).trim()
                if (side === 'left') void update($, leftDir, () => picked)
                else void update($, rightDir, () => picked)
                void update($, typing, () => '')
              }}
              onInput={typed => {
                const picked = clean(typed)
                if (side === 'left') void update($, leftDir, () => picked)
                else void update($, rightDir, () => picked)
              }}
            />
          )
        }
        if (choices.length > 0) {
          return (
            <Box key={`${side}-dir-row`}>
              <Select
                key={`${side}-dir`}
                label={label}
                options={choices.map(one => ({ value: one, label: tail(one) }))}
                value={path}
                onSelect={picked => {
                  const chosen = clean(picked)
                  if (side === 'left') void update($, leftDir, () => chosen)
                  else void update($, rightDir, () => chosen)
                }}
              />
              <Button
                key={`${side}-dir-type`}
                label="✎"
                plain
                dimColor
                onPress={() => void update($, typing, () => (side === 'left' ? 'left-dir' : 'right-dir'))}
              />
            </Box>
          )
        }
        return (
          <Input
            key={`${side}-dir`}
            label={label}
            placeholder="folder the task runs in"
            value={path}
            onSubmit={typed => {
              const picked = clean(typed).trim()
              if (side === 'left') void update($, leftDir, () => picked)
              else void update($, rightDir, () => picked)
            }}
            onInput={typed => {
              const picked = clean(typed)
              if (side === 'left') void update($, leftDir, () => picked)
              else void update($, rightDir, () => picked)
            }}
          />
        )
      }
      inputs.push(
        <Box key="mode-row">
          <Button
            key="mode-ask"
            label="Ask"
            plain={way !== 'ask' ? true : undefined}
            dimColor={way !== 'ask'}
            onPress={() => void update($, mode, () => 'ask')}
          />
          <Button
            key="mode-task"
            label="Task"
            plain={way !== 'task' ? true : undefined}
            dimColor={way !== 'task'}
            onPress={() => {
              void (async () => {
                await update($, mode, () => 'task')
                await ensureFolders($)
              })()
            }}
          />
          <Text dimColor>{way === 'task' ? '  each model runs it in its own folder' : '  each model answers in one call'}</Text>
        </Box>,
      )
      const leftField = folderField('left', leftFolder)
      const rightField = folderField('right', rightFolder)
      if (leftField !== undefined) inputs.push(leftField)
      if (rightField !== undefined) inputs.push(rightField)
      if (way === 'task') {
        const leftPick = leftFolder.trim()
        const rightPick = rightFolder.trim()
        inputs.push(
          <Text key="folder-note" dimColor wrap="wrap">
            {leftPick !== '' && leftPick === rightPick
              ? 'Both columns pick the same folder: pick another, the two must differ.'
              : root !== ''
                ? `folders under ${fit(root, Math.max(8, width - 14))}`
                : 'Type the folder each column runs in.'}
          </Text>,
        )
      }
    }

    // One column: its model and the live count of its seconds at the top, its
    // answer or the reason there is none beneath, and what can be done with it
    // last. A running column's seconds move, so a slow answer looks alive.
    const column = (side: CompareSide, index: number) => {
      const ms = elapsedOf(side, now)
      const seconds = duration(ms)
      const speed = side.isAnswered ? speedOf(side) : ''
      const meta = side.isRunning
        ? `running ${seconds}`
        : side.isAnswered
          ? `${seconds} · in ${side.inputTokens} / out ${side.outputTokens} tok${speed !== '' ? ` · ${speed}` : ''}`
          : `${seconds} · no answer`
      const cut = side.text.length > REPLY_LIMIT
      const reply = cut ? side.text.slice(0, REPLY_LIMIT) + '\n\n…' : side.text
      const rate = given[index] ?? null
      const name = hidden ? index === 0 ? 'Column A' : 'Column B' : side.model
      return (
        <Box
          key={`side:${index}`}
          flexDirection="column"
          width={colWidth}
          borderStyle="round"
          borderColor={side.isRunning ? 'promptBorder' : side.isAnswered ? 'success' : 'error'}
          borderDimColor={side.isRunning}
          paddingX={1}
        >
          <Text weight="semibold" wrap="wrap">
            {fit(name, Math.max(4, colWidth - 2))}
          </Text>
          {!hidden && side.folder !== undefined && <Text dimColor>{fit(side.folder, Math.max(4, colWidth - 2))}</Text>}
          <Text dimColor tabular>
            {meta}
          </Text>
          {side.isRunning ? (
            <Text dimColor>{side.folder === undefined ? 'Waiting for its answer…' : 'Its task is running in that folder.'}</Text>
          ) : side.isAnswered ? (
            <Markdown text={reply} />
          ) : (
            <Text color="error" wrap="wrap">
              {failureOf(side)}
            </Text>
          )}
          {!side.isRunning && shown.length > 0 && (
            <Box>
              {side.isAnswered && (
                <Button
                  key={`copy:${index}`}
                  label="Copy"
                  plain
                  dimColor
                  onPress={press => void $.ui.copy({ text: side.text, surface: press.surface })}
                />
              )}
              {way === 'ask' && !busy && (
                <Button
                  key={`retry:${index}`}
                  label="↻?Retry"
                  plain
                  dimColor
                  onPress={() => void retryOne($, options, index === 0 ? 'left' : 'right')}
                />
              )}
              {side.isAnswered && (
                <Box>
                  {[1, 2, 3, 4, 5].map(n => (
                    <Button
                      key={`rate:${index}:${n}`}
                      label={rate === n ? `{n}★` : `{n}☆`}
                      plain
                      dimColor={rate !== n}
                      onPress={() =>
                        void (async () => {
                          await update($, rates, all => {
                            const next = all.slice(0, 2)
                            next[index] = n
                            return next
                          })
                        })()
                      }
                    />
                  ))}
                </Box>
              )}
            </Box>
          )}
        </Box>
      )
    }

    /** The pair's two columns side by side, or one above the other when narrow. */
    const columns = (pair: readonly CompareSide[]) => (
      <Box flexDirection={stacked ? 'column' : 'row'} gap={gap}>
        {pair.map(column)}
      </Box>
    )

    const answered = shown.filter(one => one.isAnswered).length
    const running = shown.filter(one => one.isRunning).length
    const headline =
      shown.length === 0
        ? ''
        : busy || running > 0
          ? `${answered}/2 answered · ${running} still running`
          : `${answered}/2 answered`

    return (
      <Box flexDirection="column">
        {inputs}
        <Box>
          <Button
            key="run"
            hotkey="r"
            label={busy ? (way === 'task' ? 'Running…' : 'Asking…') : way === 'task' ? 'Run tasks' : 'Compare'}
            variant="primary"
            dimColor={busy}
            onPress={() => void runCurrent($, options)}
          />
          {busy && (
            <Button
              key="cancel"
              hotkey="c"
              label="Cancel"
              variant="secondary"
              onPress={() => {
                stop?.abort()
                // A subagent cannot be stopped from here: its id is marked, so
                // the answer it sends later is dropped, and it is told to stop.
                for (const agentId of waiting.keys()) {
                  cancelled.add(agentId)
                  void $.session.send({ to: { agentId }, text: 'Stop: the comparison was cancelled.' })
                }
                waiting.clear()
                void (async () => {
                  await update($, sides, shown => shown.map(one => ({ ...one, isRunning: false })))
                  await setBusy($, false)
                  await say($, 'Cancelled.')
                })()
              }}
            />
          )}
          <Button
            key="swap"
            hotkey="s"
            label="⇄?Swap"
            plain
            dimColor
            onPress={() => {
              void (async () => {
                const a = await read($, left)
                const b = await read($, right)
                await update($, left, () => b)
                await update($, right, () => a)
                await update($, sides, () => [])
                await say($, '')
              })()
            }}
          />
          {list.length > 1 && (
            <Button
              key="cycle-right"
              label="Next model ›"
              plain
              dimColor
              onPress={() => {
                void (async () => {
                  const upcoming = nextAfter(list, await read($, right))
                  if (upcoming !== '') await update($, right, () => upcoming)
                })()
              }}
            />
          )}
          <Button
            key="blind"
            label={hidden ? '👁 Reveal' : '🙈 Blind'}
            plain
            dimColor
            onPress={() =>
              void (async () => {
                if (hidden) {
                  await update($, blind, () => false)
                } else {
                  await update($, blind, () => true)
                  await update($, rates, () => [])
  await update($, judge, () => '')
                  await say($, 'Blind: judge the answers, then reveal and rate.')
                }
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
        <Text dimColor tabular>
          {note !== '' ? note : headline !== '' ? headline : ' '}
        </Text>
        {/* The mobile app draws no field: the prompt the columns answer is
            spelled out here instead, so the pane says what it is comparing. */}
        {!canType && (
          <Text dimColor wrap="wrap">
            {text.trim() === '' ? 'No prompt yet.' : `prompt · ${text.trim()}`}
          </Text>
        )}
        {shown.length === 0 && !busy && (
          <Text dimColor wrap="wrap">
            {text.trim() === ''
              ? 'Type a prompt, or type one in the box above and click the green dot.'
              : way === 'task'
                ? 'Pick a folder for each column, then press Run tasks.'
                : 'Press Compare to ask both models.'}
          </Text>
        )}
        {shown.length > 0 && columns(shown)}
        {shown.length === 2 &&
          shown.every(one => one.isAnswered) &&
          !busy &&
          (() => {
            const [a = null, b = null] = given
            const isJudged = judged !== ''
            const verdict =
              isJudged
                ? judged
                : a === null || b === null
                  ? hidden
                    ? 'Reveal, then rate both columns to name a winner — or let a model judge them.'
                    : 'Rate both columns (1–5★) to name a winner — or let a model judge them.'
                  : a === b
                    ? `Tie at ${a}★.`
                    : a > b
                      ? `Winner: left, ${a}★ to ${b}★.`
                      : `Winner: right, ${b}★ to ${a}★.`
            const done = a !== null && b !== null
            return (
              <Box flexDirection="column">
                <Text dimColor wrap="wrap">
                  {verdict}
                </Text>
                <Box>
                  <Button
                    key="judge"
                    label="⚖?Judge"
                    plain
                    dimColor={isJudged}
                    onPress={() => void judgeRun($, options, text.trim(), shown)}
                  />
                  {done && (
                    <Button
                      key="keep-verdict"
                      label="Keep to history"
                      plain
                      dimColor
                      onPress={() =>
                        void (async () => {
                          const leftId = await read($, left)
                          const rightId = await read($, right)
                          const wins = await recordOf($, leftId, rightId)
                          const winning = a !== b ? (a > b ? leftId : rightId) : null
                          await rememberVerdict($, {
                            models: [leftId, rightId],
                            winner: a === b ? null : a > b ? 0 : 1,
                            prompt: text.trim().slice(0, 80),
                            at: new Date().toISOString().slice(0, 16).replace('T', ' '),
                          })
                          await say(
                            $,
                            `Kept. Head to head: ${wins[0] + (winning === leftId ? 1 : 0)}–${wins[1] + (winning === rightId ? 1 : 0)} ${winning !== null ? `(${winning} leads)` : ''}`.replace('  ', ' '),
                          )
                        })()
                      }
                    />
                  )}
                </Box>
              </Box>
            )
          })()}
        <Text dimColor wrap="wrap">
          {way === 'task'
            ? 'Each run needs a folder per column, and a folder is used once.'
            : canType && shown.length > 0
              ? 'r run · s swap · c cancel · Esc close'
              : 'Esc closes.'}
        </Text>
      </Box>
    )
  })
}
