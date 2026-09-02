import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ChoreModal } from './ChoreModal'

function mockApi(opts: { created?: unknown[]; patched?: unknown[]; deleted?: string[] }) {
  globalThis.fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const u = String(url)
    const m = init?.method
    if (u.includes('/api/persons')) {
      return {
        ok: true,
        json: async () => ({
          persons: [
            { id: 'p1', name: 'Wally', avatarEmoji: '🐢', colorHex: '#25A368', memberType: 'kid', isAdmin: false },
            { id: 'p2', name: 'Lottie', avatarEmoji: '🦊', colorHex: '#E0653F', memberType: 'kid', isAdmin: false },
          ],
        }),
      }
    }
    if (u.endsWith('/api/chores') && m === 'POST') {
      opts.created?.push(JSON.parse(init!.body!))
      return { ok: true, json: async () => ({ chore: { id: 'c1' } }) }
    }
    if (/\/api\/chores\/[^/]+$/.test(u) && m === 'PATCH') {
      opts.patched?.push(JSON.parse(init!.body!))
      return { ok: true, json: async () => ({ chore: { id: 'c1' } }) }
    }
    if (/\/api\/chores\/[^/]+$/.test(u) && m === 'DELETE') {
      opts.deleted?.push(u)
      return { ok: true, status: 204, json: async () => ({}) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

const chore = { id: 'c1', title: 'Old chore', emoji: '🐶', personId: 'p1', rewardAmount: 3 }

describe('ChoreModal', () => {
  it('creates a chore for the prefilled person', async () => {
    const created: unknown[] = []
    mockApi({ created })
    render(<ChoreModal personId="p1" onClose={vi.fn()} onSaved={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText('Feed the dog'), { target: { value: 'Tidy room' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add chore' }))
    await waitFor(() => expect(created).toHaveLength(1))
    expect(created[0]).toMatchObject({ title: 'Tidy room', personId: 'p1' })
  })

  it('edits a chore (PATCH)', async () => {
    const patched: unknown[] = []
    mockApi({ patched })
    render(<ChoreModal chore={chore} onClose={vi.fn()} onSaved={vi.fn()} />)
    fireEvent.change(screen.getByDisplayValue('Old chore'), { target: { value: 'New chore' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(patched).toHaveLength(1))
    expect(patched[0]).toMatchObject({ title: 'New chore' })
  })

  it('canAssignOthers=false restricts the assignee picker to self + up-for-grabs', async () => {
    mockApi({})
    render(<ChoreModal canAssignOthers={false} selfPersonId="p1" onClose={vi.fn()} onSaved={vi.fn()} />)
    // Wait for the person list to load (self appears), then assert Lottie is absent.
    expect(await screen.findByRole('option', { name: /Wally/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /up for grabs/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /Lottie/ })).not.toBeInTheDocument()
  })

  it('canAssignOthers=true shows the full member list', async () => {
    mockApi({})
    render(<ChoreModal canAssignOthers={true} selfPersonId="p1" onClose={vi.fn()} onSaved={vi.fn()} />)
    expect(await screen.findByRole('option', { name: /Wally/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Lottie/ })).toBeInTheDocument()
  })

  it('deletes only after a confirm tap', async () => {
    const deleted: string[] = []
    mockApi({ deleted })
    render(<ChoreModal chore={chore} onClose={vi.fn()} onSaved={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(deleted).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Tap again to delete' }))
    await waitFor(() => expect(deleted).toHaveLength(1))
  })
  // The surface that opens the modal can say what a NEW chore should start as. Nothing
  // else changes: leave the props off and the Chores screen gets what it always got.
  it('a new chore still defaults to Every day, dated by the modal itself', async () => {
    const created: unknown[] = []
    mockApi({ created })
    render(<ChoreModal personId="p1" onClose={vi.fn()} onSaved={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Every day' }).className).toContain('on')
    fireEvent.change(screen.getByPlaceholderText('Feed the dog'), { target: { value: 'Tidy room' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add chore' }))
    await waitFor(() => expect(created).toHaveLength(1))
    // Recurring, so no day is sent at all — the rrule decides.
    expect(created[0]).toMatchObject({ rrule: 'FREQ=DAILY' })
    expect((created[0] as { dueOn?: string }).dueOn).toBeUndefined()
  })

  it('takes a starting cadence and day from the surface that opened it', async () => {
    const created: unknown[] = []
    mockApi({ created })
    render(<ChoreModal personId="p1" defaultFreq="once" defaultDueOn="2099-03-04" onClose={vi.fn()} onSaved={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Just once' }).className).toContain('on')
    fireEvent.change(screen.getByPlaceholderText('Feed the dog'), { target: { value: 'Book the sitter' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add chore' }))
    await waitFor(() => expect(created).toHaveLength(1))
    expect(created[0]).toMatchObject({ rrule: null, dueOn: '2099-03-04' })
  })
})
