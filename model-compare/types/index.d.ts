/**
 * One model's half of a comparison: what it said, what it cost, or why it
 * did not answer.
 */
export type CompareSide = {
  /** The model id the call named, as given. */
  model: string
  /** The folder the agent ran in, for a task run; absent for a plain ask. */
  folder?: string
  /** True when the model answered; `text` is its reply. */
  isAnswered: boolean
  /** The reply's text, cleaned; empty when no answer came. */
  text: string
  /** Why no answer came: an API error, an empty reply, a cut call, or a refusal. */
  reason?: 'api-error' | 'empty-reply' | 'aborted' | 'failed' | 'refused'
  /** True while this column's agent is still working, in a task run. */
  isRunning?: boolean
  /**
   * When this column's call started, on the engine's clock (`$.clock.now()`);
   * the pane counts from it while the column runs, so its seconds move.
   */
  startedAt?: number
  /** The error reply's HTTP status; null when no response arrived. */
  status?: number | null
  /** Which kind of API failure, as the engine classified it. */
  error?: string
  /** Uncached input tokens the call was answered over. */
  inputTokens: number
  /** Tokens the call generated. */
  outputTokens: number
  /** How long the call took, in milliseconds. */
  ms: number
}

/** One remembered verdict of a past run: which pair ran, and who was rated higher. */
export type CompareVerdict = {
  /** The two model ids, left first as the run had them. */
  models: [string, string]
  /** Whose rating won: 0 left, 1 right, null a tie or unrated. */
  winner: 0 | 1 | null
  /** The run's prompt, cut short. */
  prompt: string
  /** When the run was rated, as a locale date-time. */
  at: string
}

declare module 'claude-code' {
  interface PluginState {
    'model-compare': {
      /** The model id the left column asks. */
      left: string
      /** The model id the right column asks. */
      right: string
      /** The prompt both models answer. */
      prompt: string
      /** What the pane says last: progress, or why nothing ran. */
      status: string
      /** True while a pair of calls is in flight. */
      isBusy: boolean
      /** The last run's two sides, left first. */
      sides: CompareSide[]
      /** The ids the gateway offers, for cycling a column's model. */
      models: string[]
      /** The column being typed into instead of picked, when the list lacks it. */
      typing: '' | 'left' | 'right' | 'left-dir' | 'right-dir'
      /** How a run treats the prompt: a plain ask, or a task each model executes. */
      mode: 'ask' | 'task'
      /** The folder the left column's task runs in; cleared after every run. */
      leftDir: string
      /** The folder the right column's task runs in; cleared after every run. */
      rightDir: string
      /** The session folder the two folder pickers list. */
      base: string
      /** The subfolder names under `base`, offered in each folder picker. */
      dirs: string[]
      /**
       * The engine's clock while a run is in flight, moved on every few
       * hundred milliseconds so a running column's seconds count up.
       */
      nowMs: number
      /** True when the pane hides which model each column is, for blind judging. */
      blind: boolean
      /** The rating each column was given, 1 to 5; null until it is rated. */
      rates: (number | null)[]
      /** The judge's verdict: scores, winner and reason; empty until it has judged. */
      judge: string
    }
  }
}
