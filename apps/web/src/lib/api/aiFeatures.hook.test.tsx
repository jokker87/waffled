// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { renderHook } from '@testing-library/react'
import { useAiFeatures, __resetAiFeatureCacheForTests } from './aiFeatures'

type Call = { method?: string; url: string; body?: string }

function mockFetch(features: Record<string, boolean>, calls: Call[]) {
  const state: Record<string, boolean> = { ...features }
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    calls.push({ method: init?.method, url: u, body: init?.body ? String(init.body) : undefined })
    if (u.includes('/api/ai/features')) {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { features: Record<string, boolean> }
        Object.assign(state, body.features)
      }
      return { ok: true, json: async () => ({ features: state }) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

describe('useAiFeatures', () => {
  beforeEach(() => __resetAiFeatureCacheForTests())

  it('loads flags and defaults missing keys to enabled', async () => {
    mockFetch({ headsUp: false }, [])
    const { result } = renderHook(() => useAiFeatures())
    await vi.waitFor(() => expect(result.current.features).not.toBeNull())
    expect(result.current.features?.headsUp).toBe(false)
    expect(result.current.features?.mealPlanning).toBe(true)
  })

  it('setEnabled flips one key, PUTs it, and reports the new value optimistically', async () => {
    const calls: Call[] = []
    mockFetch({}, calls)
    const { result } = renderHook(() => useAiFeatures())
    await vi.waitFor(() => expect(result.current.features).not.toBeNull())

    act(() => {
      result.current.setEnabled('eventInsight', false)
    })
    // Flush the pending PUT .then() so the state update lands inside act.
    await act(async () => {})
    // Optimistic value applied synchronously.
    expect(result.current.features?.eventInsight).toBe(false)
    // And the PUT carries only the changed key.
    const put = calls.find((c) => c.method === 'PUT')
    expect(put?.url).toContain('/api/ai/features')
    expect(JSON.parse(put!.body!)).toEqual({ features: { eventInsight: false } })
  })
})
