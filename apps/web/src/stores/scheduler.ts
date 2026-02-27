import { create } from 'zustand'

// ─── CronJob ──────────────────────────────────────────────────────────────────
// UI representation of a gateway cron job summary.

export type CronScheduleKind = 'every' | 'at' | 'cron'

export interface CronJobSchedule {
  kind: CronScheduleKind
  /** For 'every' kind — milliseconds between runs. */
  everyMs?: number
  /** For 'every' kind with a fixed anchor — UTC ms. */
  anchorMs?: number
  /** For 'at' kind — ISO string of one-time run time. */
  at?: string
  /** For 'cron' kind — cron expression. */
  expr?: string
  /** For 'cron' kind — IANA timezone. */
  tz?: string
}

export type CronJobLastStatus = 'ok' | 'error' | 'skipped'

export interface CronJob {
  /** Gateway-assigned job ID. */
  id: string
  /** Human-readable job name. */
  name: string
  /** ID of the agent this job belongs to. */
  agentId: string
  /** Resolved agent name (from fleet store at load time). */
  agentName: string
  /** Parsed schedule. */
  schedule: CronJobSchedule
  /** The task/message text delivered to the agent. */
  task: string
  /** Whether the job is enabled. */
  active: boolean
  /** UTC ms of the next scheduled run. Null if disabled or one-time past. */
  nextExecution: number | null
  /** UTC ms of the most recent completed run. */
  lastExecution: number | null
  /** Outcome of the last run. */
  lastStatus: CronJobLastStatus | null
  /** Last error message, if lastStatus === 'error'. */
  lastError: string | null
  /** Duration of the last run in ms. */
  lastDurationMs: number | null
  /** UTC ms of last gateway update. Used for sorting. */
  updatedAtMs: number
}

// ─── Store ────────────────────────────────────────────────────────────────────

interface SchedulerStore {
  /** All cron jobs loaded from the gateway. */
  jobs: CronJob[]
  /** True while the initial load or a refresh is in progress. */
  isLoading: boolean
  /** Error message from the last load attempt. */
  loadError: string | null

  /** Replace the full job list (called on load / refresh). */
  setJobs: (jobs: CronJob[]) => void

  /** Prepend a single newly-created job. */
  addJob: (job: CronJob) => void

  /** Remove a job by id. */
  removeJob: (id: string) => void

  /** Toggle the `active` field on a job by id (optimistic). */
  toggleJob: (id: string) => void

  /** Merge partial updates onto a job by id. */
  updateJob: (id: string, partial: Partial<CronJob>) => void

  /** Set loading flag. */
  setLoading: (isLoading: boolean) => void

  /** Set error message. */
  setLoadError: (error: string | null) => void
}

export const useSchedulerStore = create<SchedulerStore>((set) => ({
  jobs: [],
  isLoading: false,
  loadError: null,

  setJobs: (jobs) => set({ jobs }),

  addJob: (job) => set((state) => ({ jobs: [job, ...state.jobs] })),

  removeJob: (id) => set((state) => ({ jobs: state.jobs.filter((j) => j.id !== id) })),

  toggleJob: (id) =>
    set((state) => ({
      jobs: state.jobs.map((j) => (j.id === id ? { ...j, active: !j.active } : j)),
    })),

  updateJob: (id, partial) =>
    set((state) => ({
      jobs: state.jobs.map((j) => (j.id === id ? { ...j, ...partial } : j)),
    })),

  setLoading: (isLoading) => set({ isLoading }),

  setLoadError: (loadError) => set({ loadError }),
}))
