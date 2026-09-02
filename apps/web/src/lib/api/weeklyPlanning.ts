// Weekly Planning domain — the guided session that decides the week ahead.
//
// The step catalog (order, titles, the question each step asks) is SERVER-owned and
// arrives in the view; nothing here hardcodes it, so web and iOS can't drift on the
// shape of the session. See docs/product/weekly-planning-plan.md.
import { useEffect, useState } from 'react'
import { apiGet, apiSend } from './client'
import { useRefetchOn, emit } from './bus'

export type StepStatus = 'pending' | 'done' | 'skipped'

export interface PlanningStep {
  key: string
  number: number
  title: string
  ask: string
  // The affirmative answer to `ask`, for the primary button.
  primary: string
  act: string
  requiresModule?: string
  // False ⇒ the module this step reads is off, or the household turned it off.
  available: boolean
  status: StepStatus
  data: Record<string, unknown>
  decidedAt: string | null
}

export interface PlanningSession {
  id: string
  weekStart: string
  status: 'active' | 'completed'
  currentStep: string | null
  driverPersonId: string | null
  startedAt: string
  completedAt: string | null
}

export interface WeeklyPlanningConfig {
  dayOfWeek: number
  time: string
  steps: Record<string, boolean>
  showOnToday: boolean
}

export interface WeeklyPlanningView {
  config: WeeklyPlanningConfig
  weekStart: string
  session: PlanningSession | null
  steps: PlanningStep[]
}

export const weeklyPlanningApi = {
  get: () => apiGet<WeeklyPlanningView>('/api/weekly-planning'),
  getConfig: () => apiGet<{ config: WeeklyPlanningConfig; steps: PlanningStep[] }>('/api/weekly-planning/config'),
  setConfig: (patch: Partial<WeeklyPlanningConfig>) =>
    apiSend<{ config: WeeklyPlanningConfig }>('PUT', '/api/weekly-planning/config', patch).then((r) => { emit('weeklyPlanning'); return r }),
  startSession: () =>
    apiSend<{ session: PlanningSession }>('POST', '/api/weekly-planning/session', {}).then((r) => { emit('weeklyPlanning'); return r }),
  patchSession: (id: string, patch: { currentStep?: string; status?: 'active' | 'completed' }) =>
    apiSend<{ session: PlanningSession }>('PATCH', `/api/weekly-planning/session/${id}`, patch).then((r) => { emit('weeklyPlanning'); return r }),
  decideStep: (id: string, stepKey: string, status: StepStatus, data?: Record<string, unknown>) =>
    apiSend<{ steps: PlanningStep[] }>('POST', `/api/weekly-planning/session/${id}/step`, { stepKey, status, data })
      .then((r) => { emit('weeklyPlanning'); return r }),
  complete: (id: string) =>
    apiSend<{ session: PlanningSession; steps: PlanningStep[] }>('POST', `/api/weekly-planning/session/${id}/complete`, {})
      .then((r) => { emit('weeklyPlanning'); return r }),
}

// The steps this household actually runs, in order — the ones the session walks and
// the only ones the agenda sheet lists.
export const availableSteps = (steps: PlanningStep[]): PlanningStep[] => steps.filter((s) => s.available)

// The acts, in catalog order, each with its available steps. Drives the agenda sheet's
// "Act 2 · Frame the week" grouping without hardcoding the acts on the client.
export function stepsByAct(steps: PlanningStep[]): { act: string; steps: PlanningStep[] }[] {
  const out: { act: string; steps: PlanningStep[] }[] = []
  for (const s of availableSteps(steps)) {
    const last = out[out.length - 1]
    if (last && last.act === s.act) last.steps.push(s)
    else out.push({ act: s.act, steps: [s] })
  }
  return out
}

// Where the driver is, resolved against what's actually available — a currentStep
// pointing at a step whose module was turned off mid-week must not strand the session.
export function resolveCurrent(view: WeeklyPlanningView | null): PlanningStep | null {
  if (!view) return null
  const avail = availableSteps(view.steps)
  if (!avail.length) return null
  const key = view.session?.currentStep
  return avail.find((s) => s.key === key) ?? avail[0]
}

export const nextStepAfter = (steps: PlanningStep[], key: string): PlanningStep | null => {
  const avail = availableSteps(steps)
  const i = avail.findIndex((s) => s.key === key)
  return i >= 0 && i + 1 < avail.length ? avail[i + 1] : null
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
export const planningDayName = (dow: number) => WEEKDAYS[((dow % 7) + 7) % 7] ?? 'Sunday'

export function useWeeklyPlanning() {
  const [view, setView] = useState<WeeklyPlanningView | null>(null)
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)
  const refetch = () => setNonce((n) => n + 1)
  useRefetchOn(['weeklyPlanning'], refetch)
  useEffect(() => {
    let alive = true
    weeklyPlanningApi.get()
      .then((d) => { if (alive) { setView(d); setLoading(false) } })
      .catch(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [nonce])
  return { view, loading, refetch }
}
