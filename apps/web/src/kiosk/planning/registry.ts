import type { ComponentType } from 'react'
import type { PlanningStep } from '../../lib/api'

// THE CONTRACT BETWEEN THE SHELL AND A STEP.
//
// The shell owns the chrome (the counter, the title, the one question, the progress
// hair, Skip and the affirmative) and each step owns only what goes between them. This
// registry is the single place the two meet, and it is complete on day one — all ten
// keys point at all ten files — so building a step means editing that step's files and
// nothing else. Ten agents can work at once without touching a shared file.
export interface StepBodyProps {
  step: PlanningStep
  sessionId: string
  // The week being planned (YYYY-MM-DD, a household week start). Always use this rather
  // than computing a week client-side — the server owns the boundary.
  weekStart: string
  // Attach the crumb this step wants kept on the session record ("3 nights were
  // auto-filled and can still be undone"). NEVER a copy of module data: the recap reads
  // through to the modules, so duplicating here lets the two disagree. null clears it.
  //
  // IT IS ONLY PERSISTED WHEN THE STEP IS ANSWERED. This holds a ref in the shell until
  // Skip or the affirmative sends it, so a step that is used and then left — assign
  // something, walk away without answering — loses it. Never make it the authority for
  // anything a step must find again: derive that from the module that owns it, and treat
  // the crumb as a hint at most. (The Meals step's shopping trip works exactly this way,
  // for exactly this reason.) A step needing a mid-step write should call its own route.
  setDecisionData: (data: Record<string, unknown> | null) => void
  // Re-read the session view — call after writing into another module so the agenda
  // sheet and the counter agree with what just happened.
  refresh: () => void
  // A write is in flight; disable your own controls.
  busy: boolean
}

export interface PlanningStepModule {
  Body: ComponentType<StepBodyProps>
  // Optional: one more control in the footer, beside Skip and the affirmative. v4 uses
  // it for Meals ("✨ Plan the rest for me", then "Undo the three").
  FooterExtra?: ComponentType<StepBodyProps>
}

// Lazily imported so a step's code (and its chunk) only loads when someone reaches it.
export const STEP_MODULES: Record<string, () => Promise<PlanningStepModule>> = {
  looseEnds: () => import('./steps/LooseEndsStep').then((m) => m.default),
  calendar: () => import('./steps/CalendarStep').then((m) => m.default),
  horizon: () => import('./steps/HorizonStep').then((m) => m.default),
  familyNight: () => import('./steps/FamilyNightStep').then((m) => m.default),
  connection: () => import('./steps/ConnectionStep').then((m) => m.default),
  goals: () => import('./steps/GoalsStep').then((m) => m.default),
  meals: () => import('./steps/MealsStep').then((m) => m.default),
  tasks: () => import('./steps/TasksStep').then((m) => m.default),
  kids: () => import('./steps/KidsStep').then((m) => m.default),
  recap: () => import('./steps/RecapStep').then((m) => m.default),
}
