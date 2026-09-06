// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { AgendaView } from './AgendaView'
import { __resetAiFeatureCacheForTests } from '../../lib/api/aiFeatures'

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone
const household = { id: 'h1', name: 'The Family', timezone: 'America/Chicago', weekStart: 'sunday', ownerPersonId: 'p1' }
const person = { id: 'p1', name: 'Kevin', memberType: 'adult', isAdmin: true, isOwner: true }
const captureConfig = {
  provider: 'heuristic' as const,
  model: null,
  available: { heuristic: true, ollama: false, anthropic: false, openai: false },
  defaultModels: { anthropic: '', openai: '', ollama: '' },
}
const headsUp = { headline: 'A big week', body: 'Three things to watch.' }

// Only /api/ai/features varies per test; everything else resolves to empty.
function mockApi(features: { headsUp: boolean }) {
  const calls: string[] = []
  globalThis.fetch = vi.fn(async (url: string) => {
    const u = String(url)
    calls.push(u)
    if (u.includes('/api/ai/features')) return { ok: true, json: async () => ({ features }) }
    if (u.includes('/api/capture/config')) return { ok: true, json: async () => captureConfig }
    if (u.includes('/api/calendar/heads-up')) return { ok: true, json: async () => ({ ...headsUp, enabled: true, via: 'ai' }) }
    if (u.includes('/api/household/settings')) return { ok: true, json: async () => ({ household, members: [person] }) }
    if (u.includes('/api/household')) return { ok: true, json: async () => ({ provisioned: true, household, person }) }
    if (u.includes('/api/persons')) return { ok: true, json: async () => ({ persons: [person] }) }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
  return { calls }
}

const renderAgenda = () =>
  render(
    <MemoryRouter>
      <AgendaView events={[]} tz={TZ} onOpenEvent={() => {}} onPickDate={() => {}} onCreate={() => {}} />
    </MemoryRouter>,
  )

describe('AgendaView heads-up AI card gating', () => {
  beforeEach(() => __resetAiFeatureCacheForTests())

  it('shows the "Heads up this week" card when the headsUp feature is on', async () => {
    const { calls } = mockApi({ headsUp: true })
    renderAgenda()
    expect(await screen.findByText('Heads up this week')).toBeInTheDocument()
    // On â†’ the card requests the (server-fallback) insight.
    await waitFor(() => expect(calls.some((u) => u.includes('/api/calendar/heads-up'))).toBe(true))
  })

  it('hides the card and makes no insight request when the headsUp feature is off', async () => {
    const { calls } = mockApi({ headsUp: false })
    renderAgenda()
    // The always-present agenda header renders once the household loads; the
    // heads-up card must not appear.
    await screen.findByText("What's coming up")
    expect(screen.queryByText('Heads up this week')).not.toBeInTheDocument()
    // Off â†’ the model-call endpoint is never hit.
    expect(calls.some((u) => u.includes('/api/calendar/heads-up'))).toBe(false)
  })
})
