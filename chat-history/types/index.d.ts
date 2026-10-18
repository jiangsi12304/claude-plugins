export type Conversation = {
  id: string
  /** The AI-written title, when the transcript carries one. */
  title?: string
  /** The first prompt the person typed, as a fallback title. */
  firstPrompt: string
  /** When the transcript last changed, milliseconds since the epoch. */
  updatedAt: number
  /** Its size in bytes. */
  size: number
  /** The project folder it was read from. */
  project: string
  /** The working directory recorded in it, when one was. */
  cwd?: string
  /** True when the person pinned it: a pinned conversation leads the list. */
  pinned?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'chat-history': {
      conversations: Conversation[]
      page: number
      status: string
      isBusy: boolean
      loadedAt: number
      filter: string
      preview: string
      previewId: string
      /** The ids the person pinned, newest pin first; kept across sessions. */
      pins: string[]
    }
  }
}
