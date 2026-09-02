import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router'
import { GoalCreate } from './GoalCreate'
import { TopbarSlotProvider, useTopbarSlots } from './topbar-slot'

// `?featured=1` — the one param that pre-picks a tier.
//
// Weekly Planning's Goals step sends it when the week's focus doesn't exist yet ("＋ New
// goal for this week"), so the goal you came here to make comes back already pinned to
// the group you came from rather than needing a second trip through the picker. It is
// deliberately narrow and additive: with the param absent, the editor still opens on
// Normal, which is the tier the app has always defaulted to.

const lists = [
  {
    id: 'l-family', name: 'Family', emoji: '🏡', colorHex: null, isPrivate: false, sortOrder: 0,
    members: [
      { personId: 'p1', name: 'Kevin', avatarEmoji: '🙂', colorHex: null },
      { personId: 'p2', name: 'Kelly', avatarEmoji: '🙃', colorHex: null },
    ],
    goalCount: 0,
  },
]

const me = { id: 'p1', name: 'Kevin', memberType: 'adult', isAdmin: true, capabilities: ['goal.manage'] }

let posted: Record<string, unknown> | null = null

function mockApi() {
  posted = null
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    if (method === 'POST' && u.endsWith('/api/goals')) {
      posted = JSON.parse(String(init?.body))
      return { ok: true, json: async () => ({ goal: { id: 'g-new' } }) }
    }
    if (u.includes('/api/goal-lists')) return { ok: true, json: async () => ({ lists }) }
    if (u.includes('/api/goals')) return { ok: true, json: async () => ({ goals: [] }) }
    if (u.includes('/api/household')) {
      return { ok: true, json: async () => ({ provisioned: true, household: { id: 'h', name: 'Home', timezone: 'UTC', weekStart: 'sunday' }, person: me }) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

// The editor's Cancel/Create live in the topbar slot, so the harness has to render it
// — otherwise there is no way to press Create and the POST body goes untested.
function Topbar() {
  const { full } = useTopbarSlots()
  return <div data-testid="topbar">{full}</div>
}

function renderAt(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <TopbarSlotProvider>
        <Topbar />
        <Routes>
          <Route path="/goals/new" element={<GoalCreate />} />
          <Route path="/goals" element={<div>goals list sentinel</div>} />
          <Route path="/goals/:id" element={<div>goal detail sentinel</div>} />
        </Routes>
      </TopbarSlotProvider>
    </MemoryRouter>
  )
}

beforeEach(() => mockApi())

describe('GoalCreate · ?featured=1', () => {
  it('opens on the Pinned tier and creates the goal already featured', async () => {
    renderAt('/goals/new?list=l-family&featured=1')
    await waitFor(() => expect(screen.getByRole('button', { name: /📌 Pinned/ })).toHaveClass('on'))

    fireEvent.change(screen.getByPlaceholderText('e.g. 750 Hours Outside'), { target: { value: 'Walk after dinner' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Create goal' }))
    await waitFor(() => expect(posted).not.toBe(null))
    expect(posted).toMatchObject({ title: 'Walk after dinner', goalListId: 'l-family', isFeatured: true })
    // The param pins; it must never promote to the one-per-list hero.
    expect(posted!.isSpotlight).toBe(false)
  })

  it('changes nothing when the param is absent — the tier still defaults to Normal', async () => {
    renderAt('/goals/new?list=l-family')
    await waitFor(() => expect(screen.getByRole('button', { name: /Normal/ })).toHaveClass('on'))
    expect(screen.getByRole('button', { name: /📌 Pinned/ })).not.toHaveClass('on')
  })

  it('treats any value other than 1 as absent, rather than as truthy', async () => {
    renderAt('/goals/new?list=l-family&featured=0')
    await waitFor(() => expect(screen.getByRole('button', { name: /Normal/ })).toHaveClass('on'))
  })
})
