import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router'
import { StepErrorBoundary } from './StepErrorBoundary'
import { WeeklyPlanning } from '../WeeklyPlanning'

// Ten steps are built independently, so one of them WILL throw at some point. The claim
// this file defends is that it costs you that step and nothing else: the counter, the
// agenda sheet and both footer controls keep working, so you can skip past it or jump
// elsewhere. Without this, the route-level ScreenBoundary would replace the whole
// planning screen and strand you.

function Boom(): never {
  throw new Error('step body exploded')
}

// The registry is the shell/step seam, so making a step throw is the honest way to
// simulate a broken step — no shell code is stubbed out.
vi.mock('./registry', async (orig) => {
  const actual = await orig<typeof import('./registry')>()
  return {
    ...actual,
    STEP_MODULES: {
      ...actual.STEP_MODULES,
      calendar: () => Promise.resolve({ Body: Boom }),
    },
  }
})

const step = (key: string, number: number, title: string, act: string) => ({
  key, number, title, act, ask: `${title}?`, primary: 'Looks right',
  available: true, status: 'pending', data: {}, decidedAt: null,
})

const view = {
  config: { dayOfWeek: 0, time: '17:00', steps: {}, showOnToday: true },
  weekStart: '2026-09-06',
  defaultWeekStart: '2026-09-06',
  minWeekStart: '2026-08-30',
  session: {
    id: 's1', weekStart: '2026-09-06', status: 'active', currentStep: 'calendar',
    driverPersonId: 'p1', startedAt: '2026-09-06T17:00:00.000Z', completedAt: null,
  },
  steps: [step('looseEnds', 1, 'Loose ends', 'Intake'), step('calendar', 2, 'Calendar', 'Frame the week')],
}

describe('a step body that throws', () => {
  it('renders its own fallback rather than nothing', () => {
    // React logs the caught error; that's expected noise, not a failure.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<StepErrorBoundary title="Horizon scan"><Boom /></StepErrorBoundary>)
    expect(screen.getByText(/Horizon scan didn't load/)).toBeTruthy()
    expect(screen.getByText(/The rest of the session still works/)).toBeTruthy()
    err.mockRestore()
  })

  it('lets a healthy step through untouched', () => {
    render(<StepErrorBoundary title="Calendar"><div>the real body</div></StepErrorBoundary>)
    expect(screen.getByText('the real body')).toBeTruthy()
    expect(screen.queryByText(/didn't load/)).toBeNull()
  })

  it('leaves the session chrome usable so you can skip past it', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => view })) as unknown as typeof fetch
    render(
      <MemoryRouter initialEntries={['/planning/calendar']}>
        <Routes>
          <Route path="/planning/:step" element={<WeeklyPlanning />} />
        </Routes>
      </MemoryRouter>
    )

    expect(await screen.findByText(/Calendar didn't load/)).toBeTruthy()
    // The chrome — the whole point.
    expect(screen.getByRole('button', { name: /2 of 2/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Skip this step' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Looks right/ })).toBeTruthy()
    // …and the title still says which step you're on.
    expect(screen.getByText('Calendar')).toBeTruthy()
    err.mockRestore()
  })
})
