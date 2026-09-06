// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { Settings } from './Settings'
import { __resetAiFeatureCacheForTests } from '../lib/api/aiFeatures'

const household = { id: 'h1', name: 'The Family', timezone: 'America/Chicago', weekStart: 'sunday', ownerPersonId: 'p1' }
const members = [
  { id: 'p1', name: 'Kevin', memberType: 'adult', isAdmin: true, avatarEmoji: 'ðŸ»', colorHex: '#2F7FED', birthday: null, showOnKiosk: true, hasLogin: true, isOwner: true },
]
const captureConfig = {
  provider: 'heuristic' as const,
  model: null,
  available: { heuristic: true, ollama: false, anthropic: false, openai: false },
  defaultModels: { anthropic: '', openai: '', ollama: '' },
}

function mockApi(features: Record<string, boolean>) {
  const state: Record<string, boolean> = { ...features }
  const puts: Array<Record<string, unknown>> = []
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    if (u.includes('/api/ai/features')) {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { features: Record<string, boolean> }
        puts.push(body)
        Object.assign(state, body.features)
        return { ok: true, json: async () => ({ features: state }) }
      }
      return { ok: true, json: async () => ({ features: state }) }
    }
    if (u.includes('/api/capture/config')) return { ok: true, json: async () => captureConfig }
    if (u.includes('/api/household/settings')) return { ok: true, json: async () => ({ household, members }) }
    if (u.includes('/api/household')) return { ok: true, json: async () => ({ provisioned: true, household, person: members[0] }) }
    if (u.includes('/api/persons')) return { ok: true, json: async () => ({ persons: [] }) }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
  return { puts }
}

describe('Settings â†’ AI & Capture â†’ per-feature toggles', () => {
  beforeEach(() => {
    __resetAiFeatureCacheForTests()
  })

  it('lists all seven AI feature toggles, defaulting on', async () => {
    mockApi({}) // empty â†’ all default true
    render(<MemoryRouter><Settings /></MemoryRouter>)
    fireEvent.click(await screen.findByText('Kevin'))
    fireEvent.click(screen.getByText('AI & Capture'))

    const names = ['Quick capture', 'Heads-up this week', 'Event insight', 'Match goals to events', 'Meal planning', 'Import recipes', 'Recipe auto-fill']
    await screen.findByText('AI features')
    for (const name of names) {
      const sw = screen.getByRole('switch', { name })
      expect(sw).toHaveAttribute('aria-checked', 'true')
    }
  })

  it('flipping a toggle PUTs /api/ai/features with just that feature flipped', async () => {
    const { puts } = mockApi({})
    render(<MemoryRouter><Settings /></MemoryRouter>)
    fireEvent.click(await screen.findByText('Kevin'))
    fireEvent.click(screen.getByText('AI & Capture'))
    await screen.findByText('AI features')

    const sw = screen.getByRole('switch', { name: 'Heads-up this week' })
    fireEvent.click(sw)
    await waitFor(() => expect(puts).toContainEqual({ features: { headsUp: false } }))
    // Optimistic update: the switch reads off after the flip.
    expect(sw).toHaveAttribute('aria-checked', 'false')
  })
})
