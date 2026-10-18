/** One model's price, in US dollars per million tokens. */
export type ModelPrice = {
  /** Dollars per million input tokens. */
  input: number
  /** Dollars per million output tokens. */
  output: number
}

/** What one model has used this session. */
export type LedgerRow = {
  /** The model id the API reported. */
  model: string
  /** Uncached input tokens. */
  input: number
  /** Generated tokens. */
  output: number
  /** Input tokens the prompt cache served. */
  cacheRead: number
  /** Input tokens written to the prompt cache. */
  cacheWrite: number
  /** Estimated dollars, from the price table; 0 when the model is unpriced. */
  cost: number
  /** Turns the model answered. */
  turns: number
}

/** One day's totals, kept across sessions. */
export type DayTotal = {
  /** The local date, `YYYY-MM-DD`. */
  day: string
  /** Estimated dollars spent that day. */
  cost: number
  /** Input tokens that day. */
  input: number
  /** Output tokens that day. */
  output: number
  /** Turns that day. */
  turns: number
}

declare module 'claude-code' {
  interface PluginState {
    'token-meter': {
      /** Every model this session has used, in the order it first answered. */
      ledger: LedgerRow[]
      /** The price table, by model id. */
      prices: Record<string, ModelPrice>
      /** The last few days' totals, newest first. */
      days: DayTotal[]
      /** What the pane says last. */
      status: string
      /** The context percentage at the last reading, for the warning's edge. */
      lastPercent: number
      /** True while a turn is in flight, so the ticker knows to keep reading. */
      isWorking: boolean
      /** The model whose price is being typed, or ''. */
      editing: string
      /** The live context percentage, as the last tick read it. */
      livePercent: number
      /** The live context tokens, as the last tick read them. */
      liveTokens: number
      /** The live context window, as the last tick read it. */
      liveWindow: number
      /** The engine's own session cost, as the last tick read it. */
      liveCost: number
    }
  }
}
