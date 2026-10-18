export type ModelEntry = {
  id: string
  name: string
  description?: string
  contextLength?: number
  vendor?: string
  /** The reasoning levels the gateway says this model takes, in its order. */
  efforts?: string[]
  /** The level the gateway runs when nothing asks for one. */
  defaultEffort?: string
}

declare module 'claude-code' {
  interface PluginState {
    'model-picker': {
      models: ModelEntry[]
      current: string
      query: string
      status: string
      isBusy: boolean
      fetchedAt: number
      recent: string[]
      page: number
      effort: string
      effortOptions: string[]
    }
  }
}
