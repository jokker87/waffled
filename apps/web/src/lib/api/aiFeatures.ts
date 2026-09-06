// Per-feature AI toggles (Settings â†’ AI & Capture). Reads/writes the household's
// ai.features map. A module-level cache + the 'aiFeatures' bus topic keep every
// surface (calendar cards, meal buttons, recipe import) in sync with one fetch,
// and `setEnabled` flips the UI optimistically across all of them.
import { useEffect, useState } from 'react'
import { apiGet, apiSend } from './client'
import { useRefetchOn, emit } from './bus'

export type AiFeature =
  | 'capture'
  | 'headsUp'
  | 'eventInsight'
  | 'goalSuggest'
  | 'mealPlanning'
  | 'recipeIngest'
  | 'recipeMetadata'

export type AiFeatures = Record<AiFeature, boolean>

export const AI_FEATURE_KEYS: AiFeature[] = [
  'capture', 'headsUp', 'eventInsight', 'goalSuggest', 'mealPlanning', 'recipeIngest', 'recipeMetadata',
]

// The API already returns a complete, defaulted map â€” but normalise here too so
// the hook is a reliable source of truth even for a partial/legacy payload. A
// feature is off only when the server said so explicitly; anything else is on.
function normalizeFeatures(input: Partial<Record<AiFeature, boolean>> | null | undefined): AiFeatures {
  const out = {} as AiFeatures
  for (const k of AI_FEATURE_KEYS) out[k] = input?.[k] === false ? false : true
  return out
}
export const ALL_AI_FEATURES_ON: AiFeatures = normalizeFeatures(null)

export const aiFeaturesApi = {
  get: () => apiGet<{ features: AiFeatures }>('/api/ai/features'),
  set: (features: Partial<Record<AiFeature, boolean>>) =>
    apiSend<{ features: AiFeatures }>('PUT', '/api/ai/features', { features }),
}

// Module-level cache so several mounted surfaces share one source of truth.
let cached: AiFeatures | null = null
let inflight: Promise<AiFeatures> | null = null

async function load(): Promise<AiFeatures> {
  if (cached) return cached
  if (!inflight) {
    inflight = aiFeaturesApi.get()
      .then(r => { cached = normalizeFeatures(r.features); return cached })
      .finally(() => { inflight = null })
  }
  return inflight
}

export function useAiFeatures(): {
  features: AiFeatures | null
  setEnabled: (f: AiFeature, enabled: boolean) => void
} {
  const [features, setFeatures] = useState<AiFeatures | null>(cached)

  const refetch = () => {
    cached = null
    load().then(setFeatures).catch(() => {})
  }

  useEffect(() => {
    load().then(setFeatures).catch(() => {})
  }, [])
  // Another surface (or tab) changed a toggle â†’ refresh from the server.
  useRefetchOn(['aiFeatures'], refetch)

  const setEnabled = (f: AiFeature, enabled: boolean) => {
    // Optimistic flip for this surface, then persist; other surfaces refresh
    // once the server confirms (via the 'aiFeatures' bus topic).
    const base: AiFeatures = cached ?? ALL_AI_FEATURES_ON
    cached = { ...base, [f]: enabled }
    setFeatures(cached)
    aiFeaturesApi
      .set({ [f]: enabled })
      .then(r => { cached = normalizeFeatures(r.features); setFeatures(cached); emit('aiFeatures') })
      .catch(refetch)
  }

  return { features, setEnabled }
}

// Test-only: clear the module-level cache so a new render re-fetches. Production
// code never calls this â€” it exists so multiple test files can isolate flag state.
export function __resetAiFeatureCacheForTests() {
  cached = null
  inflight = null
}
