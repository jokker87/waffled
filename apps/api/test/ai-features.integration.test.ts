// Per-feature AI toggles (Settings â†’ AI & Capture). Feature state lives in
// households.settings.ai.features and defaults to enabled. Covers: the read
// endpoint, the admin write endpoint, the household default (all on), non-admin
// 403, and the meal-planning fallback â€” disabling `mealPlanning` makes the
// plan-week route shuffle instead of calling the model.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './helpers/pg'
import { createServer, type Server } from 'node:http'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'

const SECRET = 'waffled-local-dev-secret-change-me'
let pg: StartedPostgreSqlContainer
let stub: Server
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>
let owner = ''
let member = ''

function mint(sub: string): string {
  return jwt.sign({}, SECRET, { algorithm: 'HS256', subject: sub, issuer: 'waffled-local', audience: 'waffled-api', expiresIn: '1h' })
}

interface RunResult { statusCode: number; body: string }
function call(method: string, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  return app.run({ httpMethod: method, path, headers, queryStringParameters: {}, body: body !== undefined ? JSON.stringify(body) : null, isBase64Encoded: false }, {}) as Promise<RunResult>
}

// Counts stubbed model calls â€” lets us assert the disabled feature never reaches the model.
let modelCalls = 0
function startStub(): Promise<number> {
  return new Promise((resolve) => {
    stub = createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      if (req.method === 'POST' && (req.url ?? '').includes('/responses')) {
        modelCalls++
        res.end(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ suggestions: [] }) }] }] }))
      } else { res.statusCode = 404; res.end('{}') }
    })
    stub.listen(0, '127.0.0.1', () => resolve((stub.address() as { port: number }).port))
  })
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  const dbUrl = pg.getConnectionUri()
  await runMigrations(dbUrl)
  const port = await startStub()
  process.env.DATABASE_URL = dbUrl
  process.env.LOCAL_JWT_SECRET = SECRET
  delete process.env.AUTH0_DOMAIN
  process.env.OPENAI_API_KEY = 'test-key'
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}`
  app = (await import('../src/app')).default
  closePool = (await import('../src/platform/db')).closePool
  const setup = await call('POST', '/api/auth/setup', undefined, {
    household: { name: 'Sites', timezone: 'America/Chicago' },
    admin: { name: 'Owner', email: 'owner@example.com', password: 'ownerpass1' },
  })
  expect(setup.statusCode).toBe(201)
  owner = JSON.parse(setup.body).accessToken
  // A non-admin member: insert person + identity directly and mint a dev token
  // (same pattern as account.integration.test.ts), so we can assert the admin-only
  // feature-flag write is 403 for non-admins.
  const { query } = await import('../src/platform/db')
  const householdId = JSON.parse(setup.body).household.id
  await query(
    `insert into persons (household_id, name, member_type, is_admin) values ($1, 'Member', 'adult', false)`,
    [householdId]
  )
  const memberRow = await query<{ id: string }>(`select id from persons where name = 'Member' and household_id = $1`, [householdId])
  await query(
    `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified) values ($1, $2, 'password', 'dev|member', true)`,
    [householdId, memberRow.rows[0].id]
  )
  member = mint('dev|member')
}, 60_000)

afterAll(async () => {
  await closePool?.()
  await new Promise<void>((r) => stub?.close(() => r()))
  await pg?.stop()
})
async function setProvider(provider: string, model?: string) {
  const res = await call('PUT', '/api/capture/config', owner, { provider, ...(model ? { model } : {}) })
  expect(res.statusCode).toBe(200)
}

describe('AI feature flags', () => {
  it('defaults to all features enabled when the household has no explicit settings', async () => {
    const res = await call('GET', '/api/ai/features', owner)
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.features).toMatchObject({
      capture: true, headsUp: true, eventInsight: true, goalSuggest: true,
      mealPlanning: true, recipeIngest: true, recipeMetadata: true,
    })
  })

  it('writes feature flags for admin/owner and persists them', async () => {
    const put = await call('PUT', '/api/ai/features', owner, { features: { mealPlanning: false } })
    expect(put.statusCode).toBe(200)
    const got = await call('GET', '/api/ai/features', owner)
    const features = JSON.parse(got.body).features
    expect(features.mealPlanning).toBe(false)
    // untouched features stay on
    expect(features.capture).toBe(true)
    expect(features.eventInsight).toBe(true)
  })

  it('rejects feature-flag writes from a non-admin member', async () => {
    const put = await call('PUT', '/api/ai/features', member, { features: { capture: false } })
    expect(put.statusCode).toBe(403)
  })

  it('rejects a flag value that is not a boolean', async () => {
    const put = await call('PUT', '/api/ai/features', owner, { features: { capture: 'yes' } })
    expect(put.statusCode).toBe(400)
  })

  it('re-enables a previously disabled feature', async () => {
    const put = await call('PUT', '/api/ai/features', owner, { features: { mealPlanning: true } })
    expect(put.statusCode).toBe(200)
    const got = await call('GET', '/api/ai/features', owner)
    expect(JSON.parse(got.body).features.mealPlanning).toBe(true)
  })
})

describe('meal planning honors the mealPlanning flag', () => {
  async function makeRecipe(title: string) {
    const res = await call('POST', '/api/recipes', owner, { title })
    expect(res.statusCode).toBe(201)
    return JSON.parse(res.body).recipe as { id: string }
  }

  it('calls the model when mealPlanning is on and a provider is configured', async () => {
    await makeRecipe('AI Plan Dish')
    await setProvider('openai', 'test-model')
    const on = await call('PUT', '/api/ai/features', owner, { features: { mealPlanning: true } })
    expect(on.statusCode).toBe(200)
    modelCalls = 0
    const res = await call('POST', '/api/meals/plan-week', owner, { start: '2026-10-01' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.via).toBe('openai') // resolved provider, not the fallback
    expect(modelCalls).toBeGreaterThan(0)
  })

  it('shuffles instead of calling the model when mealPlanning is off', async () => {
    await makeRecipe('Shuffled Dish A')
    await makeRecipe('Shuffled Dish B')
    const off = await call('PUT', '/api/ai/features', owner, { features: { mealPlanning: false } })
    expect(off.statusCode).toBe(200)
    modelCalls = 0
    const res = await call('POST', '/api/meals/plan-week', owner, { start: '2026-10-08' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.via).toBe('shuffle')
    expect(modelCalls).toBe(0) // the disabled feature never reaches the model
  })
})
