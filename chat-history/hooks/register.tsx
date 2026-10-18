import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { Conversation } from '../types'

const PANE = 'chat-history'
const COMMAND = 'history'
const DOT = 'history-dot'

const conversations = atom({ plugin: 'chat-history', key: 'conversations' } as const, [] as Conversation[])
const page = atom({ plugin: 'chat-history', key: 'page' } as const, 0)
const status = atom({ plugin: 'chat-history', key: 'status' } as const, '')
const isBusy = atom({ plugin: 'chat-history', key: 'isBusy' } as const, false)
const loadedAt = atom({ plugin: 'chat-history', key: 'loadedAt' } as const, 0)
const filter = atom({ plugin: 'chat-history', key: 'filter' } as const, '')
const preview = atom({ plugin: 'chat-history', key: 'preview' } as const, '')
const previewId = atom({ plugin: 'chat-history', key: 'previewId' } as const, '')

type Dollar = EngineInterface

type Options = {
  showDot: boolean
  pageSize: number
  showAllProjects: boolean
  previewLines: number
}

const SEP = String.fromCharCode(92)

/** The folder name the engine gives a working directory: every other byte a dash. */
function encodeCwd(cwd: string): string {
  let out = ''
  for (const ch of cwd) out += /[A-Za-z0-9]/.test(ch) ? ch : '-'
  return out
}

/** The folder a path is in, as a path the fs calls take. */
function parentOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf(SEP))
  return cut <= 0 ? path : path.slice(0, cut)
}

/** Where the transcripts of every project live. */
async function projectsRoot($: Dollar): Promise<string | null> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
  if (home === '') return null
  return home.split(SEP).join('/') + '/.claude/projects'
}

/**
 * A transcript's text as the drawing takes it. A row written by a slash
 * command keeps the terminal colouring it was printed with (`\u001b[2m` and
 * the like); the drawing refuses any text holding one, and refuses the whole
 * tree with it.
 */
function clean(text: string): string {
  return (
    text
      // CSI: colour, cursor and the rest, `ESC [ ... final byte`.
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
      // OSC: a title or hyperlink, ended by BEL or `ESC \`.
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
      // Whatever else is neither a tab nor a newline.
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
  )
}

/** The first prompt the person typed, from a transcript's opening rows. */
function firstPromptOf(text: string): string {
  for (const line of text.split('\n')) {
    if (line === '' || !line.includes('"type":"user"')) continue
    let row: {
      type?: string
      isMeta?: boolean
      message?: { content?: unknown }
    }
    try {
      row = JSON.parse(line) as typeof row
    } catch {
      continue
    }
    if (row.type !== 'user' || row.isMeta === true) continue
    const content = row.message?.content
    let said = ''
    if (typeof content === 'string') said = content
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (
          block !== null &&
          typeof block === 'object' &&
          (block as { type?: string }).type === 'text' &&
          typeof (block as { text?: unknown }).text === 'string'
        ) {
          said += (block as { text: string }).text
        }
      }
    }
    said = clean(said).replace(/\s+/g, ' ').trim()
    if (said === '') continue
    // The engine's own wrappers are not what the person typed.
    if (said.startsWith('<local-command-caveat>') || said.startsWith('<command-name>')) continue
    return said.slice(0, 120)
  }
  return ''
}

/** The AI title a transcript carries, if any. */
function titleOf(text: string): string | undefined {
  for (const line of text.split('\n')) {
    if (!line.includes('"aiTitle"')) continue
    try {
      const row = JSON.parse(line) as { aiTitle?: unknown }
      if (typeof row.aiTitle === 'string' && row.aiTitle.trim() !== '') {
        const title = clean(row.aiTitle).replace(/\s+/g, ' ').trim()
        if (title !== '') return title
      }
    } catch {
      continue
    }
  }
  return undefined
}

/** The working directory a transcript recorded, if any. */
function cwdOf(text: string): string | undefined {
  for (const line of text.split('\n')) {
    if (!line.includes('"cwd"')) continue
    try {
      const row = JSON.parse(line) as { cwd?: unknown }
      if (typeof row.cwd === 'string' && row.cwd !== '') return row.cwd
    } catch {
      continue
    }
  }
  return undefined
}

/** One line of a conversation for the preview: who said what. */
function previewLine(row: string): string | null {
  let parsed: {
    type?: string
    isMeta?: boolean
    message?: { content?: unknown }
  }
  try {
    parsed = JSON.parse(row) as typeof parsed
  } catch {
    return null
  }
  const kind = parsed.type
  if (kind !== 'user' && kind !== 'assistant') return null
  if (parsed.isMeta === true) return null
  const content = parsed.message?.content
  let said = ''
  if (typeof content === 'string') said = content
  else if (Array.isArray(content)) {
    for (const block of content) {
      if (
        block !== null &&
        typeof block === 'object' &&
        (block as { type?: string }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string'
      ) {
        said += (block as { text: string }).text
      }
    }
  }
  said = clean(said).replace(/\s+/g, ' ').trim()
  if (said === '') return null
  if (said.startsWith('<local-command-caveat>') || said.startsWith('<command-name>')) return null
  return `${kind === 'user' ? 'you' : 'claude'}: ${said.slice(0, 200)}`
}

/**
 * The opening of a transcript: its text when the engine will hand it over,
 * else the first lines read by the host's own shell (the engine's read refuses
 * a file past 4 MiB). `''` when neither answers.
 */
async function readOpening($: Dollar, path: string): Promise<string> {
  try {
    return await $.fs.read(path)
  } catch {
    // Over the read limit: ask the host for the head instead.
  }
  const attempts: readonly (readonly string[])[] = [
    ['powershell', '-NoProfile', '-Command', 'Get-Content -LiteralPath $env:F -TotalCount 400'],
    ['sh', '-c', 'head -n 400 "$F"'],
  ]
  for (const argv of attempts) {
    try {
      const ran = await $.process.run(argv, { env: { F: path }, timeoutMs: 15_000 })
      if (ran.exitCode === 0 && ran.stdout !== '') return ran.stdout
    } catch {
      continue
    }
  }
  return ''
}

/** Every transcript under one project folder, newest first. */
async function readProject($: Dollar, folder: string, project: string): Promise<Conversation[]> {
  const entries = await $.fs.list(folder).catch(() => [])
  const found: Conversation[] = []
  const files = entries
    .filter(entry => entry.kind === 'file' && entry.name.endsWith('.jsonl'))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 60)
  for (const entry of files) {
    const id = entry.name.slice(0, -'.jsonl'.length)
    if (!/^[0-9a-f-]{8,}$/i.test(id)) continue
    const head = await readOpening($, `${folder}/${entry.name}`)
    found.push({
      id,
      title: head === '' ? undefined : titleOf(head),
      firstPrompt: head === '' ? '' : firstPromptOf(head),
      updatedAt: entry.mtimeMs,
      size: entry.size,
      project,
      cwd: head === '' ? undefined : cwdOf(head),
    })
  }
  return found
}

/** Lists the conversations of this project (or every project). */
async function loadConversations($: Dollar, options: Options): Promise<void> {
  const root = await projectsRoot($)
  if (root === null) {
    await update($, status, () => 'No home directory: cannot find transcripts.')
    return
  }

  await update($, isBusy, () => true)
  try {
    const cwd = await $.session.cwd()
    const ownFolder = `${root}/${encodeCwd(cwd)}`
    const projects = options.showAllProjects
      ? (await $.fs.list(root).catch(() => []))
          .filter(entry => entry.kind === 'dir')
          .map(entry => ({ folder: `${root}/${entry.name}`, project: entry.name }))
      : [{ folder: ownFolder, project: encodeCwd(cwd) }]

    const all: Conversation[] = []
    for (const one of projects) {
      all.push(...(await readProject($, one.folder, one.project)))
    }
    const current = await $.session.id()
    all.sort((a, b) => b.updatedAt - a.updatedAt)
    await update($, conversations, () => all.filter(one => one.id !== current))
    await update($, loadedAt, () => Date.now())
    await update($, page, () => 0)
    await update($, status, () =>
      `${all.filter(one => one.id !== current).length} conversations in ${
        options.showAllProjects ? 'every project' : 'this project'
      }`,
    )
  } catch (error) {
    await update($, status, () => clean(`Could not read transcripts: ${String(error)}`))
  } finally {
    await update($, isBusy, () => false)
  }
}

/** Reads the opening of one conversation for the preview. */
async function loadPreview($: Dollar, options: Options, one: Conversation | undefined): Promise<void> {
  if (one === undefined) {
    await update($, preview, () => '')
    await update($, previewId, () => '')
    return
  }
  if (one.id === (await read($, previewId))) return

  const root = await projectsRoot($)
  if (root === null) return
  const text = await readOpening($, `${root}/${one.project}/${one.id}.jsonl`)
  if (text === '') {
    await update($, preview, () => 'This conversation could not be read here.')
    await update($, previewId, () => one.id)
    return
  }
  const lines: string[] = []
  for (const row of text.split('\n')) {
    if (lines.length >= Math.max(1, options.previewLines)) break
    const line = previewLine(row)
    if (line !== null) lines.push(line)
  }
  await update($, preview, () => lines.join('\n'))
  await update($, previewId, () => one.id)
}

/** Resumes one conversation in this session, as `claude -r <id>` would. */
async function resumeConversation($: Dollar, one: Conversation): Promise<void> {
  try {
    await $.command.run({ command: 'resume', args: one.id })
    $.ui.toast(clean(`Resumed ${one.title ?? one.firstPrompt ?? one.id}`))
  } catch (error) {
    $.ui.toast(clean(`Could not resume: ${String(error)}`))
  }
}

/** Opens the history pane, refreshed. */
async function openHistory($: Dollar, options: Options): Promise<void> {
  const opened = await $.ui.open({
    id: PANE,
    title: 'History',
    focus: true,
    closeOnEscape: true,
    rows: Math.max(6, options.pageSize + 5),
  })
  if (!opened.isPlaced) $.ui.log(`chat-history: ${opened.reason}`, { to: 'debug' })
  await loadConversations($, options)
  await loadPreview($, options, (await read($, conversations))[0])
}

/** A relative time, as the list shows it. */
function ago(ms: number): string {
  const minutes = Math.round((Date.now() - ms) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d`
  return `${Math.round(days / 30)}mo`
}

export const register: Register = (on, raw) => {
  const options: Options = {
    showDot: raw.showDot !== false,
    pageSize: typeof raw.pageSize === 'number' ? raw.pageSize : 10,
    showAllProjects: raw.showAllProjects === true,
    previewLines: typeof raw.previewLines === 'number' ? raw.previewLines : 4,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: "Browse this project's past conversations and resume one",
    })
    await update($, filter, () => '')
    await update($, preview, () => '')
    await update($, previewId, () => '')
    if (e.isInteractive) void loadConversations($, options)
    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    await openHistory($, options)
    return { text: 'History opened: click a conversation to resume it.' }
  }).catch(($, e, next) => (next.called ? next(e) : { text: 'History could not open.' }))

  // The dot leads the hint line, and whatever is beneath is drawn after it: the
  // engine's own line, or another plugin's. Only the first hook in the chain
  // draws a component, so nesting what `next` answers is what lets two plugins
  // share this line whichever of them the engine admitted first.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (!options.showDot) return next(e)

    const note = await read($, status)
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
        <Button key={DOT} plain onPress={() => void openHistory($, options)}>
          <Text color="#8B0000">●</Text>
        </Button>
        <Text>{' '}</Text>
        {below ?? <Text dimColor>{e.props.hint}</Text>}
        {note !== '' && <Text dimColor>{`  ·  ${note}`}</Text>}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const list = await read($, conversations)
    const note = await read($, status)
    const busy = await read($, isBusy)
    const needle = (await read($, filter)).trim().toLowerCase()
    const pageState = await read($, page)
    const previewText = await read($, preview)
    const { Box, Button, Text } = $.ui.resolve(e)

    const matched =
      needle === ''
        ? list
        : list.filter(
            one =>
              one.id.toLowerCase().includes(needle) ||
              (one.title ?? '').toLowerCase().includes(needle) ||
              one.firstPrompt.toLowerCase().includes(needle),
          )

    const room = Math.max(1, options.pageSize)
    const pageCount = Math.max(1, Math.ceil(matched.length / room))
    const pageNow = Math.min(Math.max(0, pageState), pageCount - 1)
    const shown = matched.slice(pageNow * room, pageNow * room + room)

    let filterField = null
    if (e.surface !== 'mobile') {
      const { Input } = $.ui.resolve(e)
      filterField = (
        <Input
          key="history-filter"
          placeholder="filter conversations…"
          value={await read($, filter)}
          onSubmit={value => {
            void update($, filter, () => value)
            void update($, page, () => 0)
          }}
          onInput={value => {
            void update($, filter, () => value)
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
            key="history-refresh"
            label={busy ? 'Reading…' : 'Refresh'}
            onPress={() => {
              void loadConversations($, options).then(() =>
                loadPreview($, options, undefined),
              )
            }}
          />
        </Box>
        <Text dimColor>{note !== '' ? note : ' '}</Text>
        {shown.length === 0 && (
          <Text dimColor>{busy ? 'Reading transcripts…' : 'No conversation matches.'}</Text>
        )}
        {shown.map((one, index) => (
          <Box key={`row:${one.id}`}>
            <Button
              key={`c:${one.id}`}
              hotkey={index < 9 ? String(index + 1) : undefined}
              onPress={() => void resumeConversation($, one)}
            >
              <Text dimColor>{`${ago(one.updatedAt)}  `}</Text>
              <Text>{one.title ?? (one.firstPrompt !== '' ? one.firstPrompt : one.id)}</Text>
              {options.showAllProjects && <Text dimColor>{`  ${one.project}`}</Text>}
            </Button>
            <Button
              key={`p:${one.id}`}
              label="Peek"
              dimColor
              onPress={() => void loadPreview($, options, one)}
            />
          </Box>
        ))}
        <Box>
          <Button
            key="history-prev"
            label="‹ Prev"
            dimColor
            onPress={() => void update($, page, value => Math.max(0, value - 1))}
          />
          <Text dimColor>
            {'  '}
            {pageNow + 1}/{pageCount}
            {'  '}
          </Text>
          <Button
            key="history-next"
            label="Next ›"
            dimColor
            onPress={() => void update($, page, value => Math.min(pageCount - 1, value + 1))}
          />
          <Text dimColor>{'   '}</Text>
          <Button
            key="history-close"
            label="Close"
            role="dismiss"
            onPress={() => void $.ui.close({ id: PANE })}
          />
        </Box>
        {previewText !== '' && (
          <Box flexDirection="column">
            <Text dimColor>{'—'.repeat(Math.min(40, e.props.bodyColumns))}</Text>
            <Text dimColor>{previewText}</Text>
          </Box>
        )}
        <Text dimColor>Click a row to resume it here. Esc closes.</Text>
      </Box>
    )
  })
}
