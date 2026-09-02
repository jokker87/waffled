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

// `householdDelay` staggers the two independent fetches this editor makes at mount.
// It is not decoration: with both resolving in the same tick their state updates batch
// into one render and the "is this list a legal target?" effect never sees a half-loaded
// viewer — which is precisely how the bug below shipped green.
function mockApi(householdDelay = 0, capabilities: string[] = ['goal.manage']) {
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
      if (householdDelay) await new Promise((r) => setTimeout(r, householdDelay))
      return { ok: true, json: async () => ({ provisioned: true, household: { id: 'h', name: 'Home', timezone: 'UTC', weekStart: 'sunday' }, person: { ...me, capabilities } }) }
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

// Why the group the caller sent wasn't sticking.
//
// The editor makes two independent fetches at mount — the goal lists, and the household
// (which is where the viewer's capabilities live). Whether you may target a *shared*
// group depends on `goal.manage`, so the effect that neutralizes an illegal `?list=`
// treats "viewer not loaded yet" as "viewer holds nothing". When the lists win the race,
// that effect fires against a viewer we simply don't know yet and clears a perfectly
// legal prefill — permanently, because nothing re-applies the param once the household
// lands. The gate is now "wait until the household has answered", which is the only
// moment a capability check can honestly be made.
describe('GoalCreate · the ?list= prefill survives the load order', () => {
  it('keeps the group when the household answers after the lists', async () => {
    mockApi(30)
    renderAt('/goals/new?list=l-family&featured=1')
    // Wait for the viewer to land — before that the chip isn't even offered, because a
    // capability-less viewer gets no shared groups in the picker.
    const chip = await screen.findByRole('button', { name: /Family/ })
    expect(chip).toHaveClass('on')

    fireEvent.change(screen.getByPlaceholderText('e.g. 750 Hours Outside'), { target: { value: 'Walk after dinner' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Create goal' }))
    await waitFor(() => expect(posted).not.toBe(null))
    expect(posted).toMatchObject({ goalListId: 'l-family', isFeatured: true })
  })

  // The inverse, and the reason the gate is "wait" and not "skip": a slow household must
  // DELAY the capability check, never cancel it. Without goal.manage, "Family" is two
  // people and not this viewer's to assign — so the prefill still has to be thrown away,
  // just a moment later. The sequence is what proves it: Create goes live while the
  // viewer is unknown, then dies the instant they turn out not to hold the capability.
  it('still clears a group this viewer may not target, once the household says so', async () => {
    mockApi(30, [])
    renderAt('/goals/new?list=l-family&featured=1')
    fireEvent.change(screen.getByPlaceholderText('e.g. 750 Hours Outside'), { target: { value: 'Walk after dinner' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create goal' })).toBeEnabled())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create goal' })).toBeDisabled())
    expect(screen.queryByRole('button', { name: /^Family/ })).not.toBeInTheDocument()
    expect(posted).toBe(null)
  })
})

// The embedded editor — the same component, no route.
//
// Weekly Planning's Goals step renders this inside a modal over the week rather than
// navigating to /goals/new, because leaving the page abandons the session. `embed` is
// purely additive: it fixes the group (so the answer can't drift off the tab the family
// is looking at), reports back instead of navigating, and leaves every route behaviour
// above untouched.
describe('GoalCreate · embedded', () => {
  it('fixes the group, hides the picker, and reports back instead of navigating', async () => {
    const onCreated = vi.fn()
    render(
      <MemoryRouter initialEntries={['/planning/goals']}>
        <TopbarSlotProvider>
          <Topbar />
          <GoalCreate embed={{ listId: 'l-family', featured: true, onCreated }} />
        </TopbarSlotProvider>
      </MemoryRouter>
    )
    // The group is stated, not offered: no chip to press, and no "＋ New group" either.
    const locked = await screen.findByTestId('ge-who-locked')
    expect(locked).toHaveTextContent('Family')
    expect(screen.queryByRole('button', { name: /＋ New group/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Family/ })).not.toBeInTheDocument()
    // It never takes over the app topbar — the modal renders the bar itself.
    expect(screen.getByTestId('topbar')).toBeEmptyDOMElement()
    // …and `featured=1`'s meaning still holds without the URL.
    expect(screen.getByRole('button', { name: /📌 Pinned/ })).toHaveClass('on')

    fireEvent.change(screen.getByPlaceholderText('e.g. 750 Hours Outside'), { target: { value: 'Walk after dinner' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create goal' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalled())
    expect(posted).toMatchObject({ title: 'Walk after dinner', goalListId: 'l-family', isFeatured: true })
    // The route's Cancel is a route concept ("back to /goals") — not offered here.
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
  })
})
