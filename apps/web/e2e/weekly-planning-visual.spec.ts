import { expect, test, type Page } from '@playwright/test'

// Visual verification for the Weekly Planning session shell. The unit tests prove the
// data and the copy are right; this proves the frame doesn't break.
//
// It exists because of a bug the unit tests structurally cannot catch: the session is a
// three-row grid (header · body · footer) and the first version sized it to `100dvh`.
// Inside `.kiosk-main` — which already has the topbar above it — that overflows by
// exactly the topbar's height and pushes the footer, i.e. BOTH controls of a decision
// surface, off the bottom of the screen. Every unit test still passed: the buttons were
// in the DOM, they just weren't reachable. So the assertion here is the one that matters
// — the footer is inside the viewport — on the board and on the phone.

const person = {
  id: 'person-1', name: 'Alex', memberType: 'adult', isAdmin: true,
  avatarEmoji: 'A', colorHex: '#4f7f73', capabilities: ['chore.manage', 'goal.manage'],
}

const modules = {
  pantry: false, chores: false, goals: false, meals: false,
  lists: false, familyNight: false, quotes: false, rhythms: false, weeklyPlanning: true,
}

const household = {
  id: 'household-1', name: 'Test Household', timezone: 'America/Denver', weekStart: 'sunday',
  location: null, ownerPersonId: person.id,
  settings: { modules, chores: { rewards: false }, pantry: { showOnToday: false }, familyNight: { showOnToday: false } },
}

const capabilities = ['chore.manage', 'goal.manage']
const permissionRow = Object.fromEntries(capabilities.map((c) => [c, false]))

const step = (
  key: string, number: number, title: string, act: string,
  extra: Record<string, unknown> = {}
) => ({
  key, number, title, act, ask: `${title} — the one question?`, primary: 'Looks right',
  available: true, status: 'pending', data: {}, decidedAt: null, parked: [], ...extra,
})

// Chores/goals/meals are off in this household, so their steps come back unavailable —
// which is exactly the case that decides what the counter counts.
const steps = [
  step('looseEnds', 1, 'Loose ends', 'Intake'),
  step('calendar', 2, 'Calendar', 'Frame the week'),
  step('horizon', 3, 'Horizon scan', 'Frame the week'),
  step('familyNight', 4, 'Family night', 'Claim the good', { available: false, requiresModule: 'familyNight' }),
  step('connection', 5, 'Connection', 'Claim the good'),
  step('goals', 6, 'Goals', 'Claim the good', { available: false, requiresModule: 'goals' }),
  step('meals', 7, 'Meals', 'Run the household', { available: false, requiresModule: 'meals' }),
  step('tasks', 8, 'Tasks', 'Run the household', { available: false, requiresModule: 'chores' }),
  step('kids', 9, 'Kids', 'Run the household'),
  step('recap', 10, 'Recap', 'Close', { primary: 'Save the week' }),
]

const session = {
  id: 'sess-1', weekStart: '2026-09-06', status: 'active', currentStep: 'calendar',
  driverPersonId: person.id, startedAt: '2026-09-06T17:00:00.000Z', completedAt: null,
}

const planningView = {
  config: { dayOfWeek: 0, time: '17:00', steps: {}, showOnToday: true },
  weekStart: '2026-09-06',
  defaultWeekStart: '2026-09-06',
  minWeekStart: '2026-08-30',
  session,
  steps,
}

const empty = {
  balances: [], chores: [], countdowns: [], currencies: [], entries: [], events: [],
  goals: [], groups: [], instances: [], items: [], lists: [], meals: [], members: [],
  people: [], persons: [], photos: [], recipes: [], rewards: [], suggestions: [],
}

async function mockApi(page: Page, view: unknown = planningView) {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    let body: unknown = empty

    if (path === '/api/auth/status') body = { initialized: true, methods: ['password'] }
    else if (path === '/api/auth/login') body = { accessToken: 'test-access', refreshToken: 'test-refresh', expiresIn: 900 }
    else if (path === '/api/household') body = { provisioned: true, household, person, memberships: [], pendingInvites: [] }
    else if (path === '/api/persons') body = { persons: [person] }
    else if (path === '/api/permissions') body = { permissions: { adult: permissionRow, teen: permissionRow, kid: permissionRow }, capabilities, roles: ['adult', 'teen', 'kid'] }
    else if (path === '/api/weather') body = { weather: null }
    else if (path === '/api/updates') body = { enabled: false, updateAvailable: false }
    else if (path === '/api/calendar/status') body = { connected: false, configured: false }
    else if (path === '/api/weekly-planning') body = view
    else if (path === '/api/powersync/token') {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'disabled' }) })
      return
    }

    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
}

async function signIn(page: Page) {
  await page.goto('/')
  await expect(page.getByText('Welcome back')).toBeVisible()
  await page.locator('input[type="email"]').fill('alex@example.test')
  await page.locator('input[type="password"]').fill('not-a-real-password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('navigation')).toBeVisible()
}

// Is the element fully inside the viewport? The footer being in the DOM is not the
// claim — being reachable is.
async function withinViewport(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return false
    const r = el.getBoundingClientRect()
    return r.top >= 0 && r.bottom <= window.innerHeight + 1 && r.height > 0
  }, selector)
}

test('the session footer stays on screen on the board', async ({ page }) => {
  await mockApi(page)
  await signIn(page)
  await page.goto('/planning')
  // Scope to the session's own title — "Calendar" is also a rail destination, so an
  // unscoped getByText passes on the rail while the screen is still an empty Suspense.
  await expect(page.locator('.wp-title')).toHaveText('Calendar')
  await page.screenshot({ path: 'test-results/weekly-planning-session.png' })

  // The regression this file exists for.
  expect(await withinViewport(page, '.wp-foot')).toBe(true)
  await expect(page.locator('.wp-primary')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Skip this step' })).toBeVisible()

  // Nothing spills sideways.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})

test('the counter counts only the steps this household runs', async ({ page }) => {
  await mockApi(page)
  await signIn(page)
  await page.goto('/planning')
  // Ten in the catalog, four off for their modules ⇒ six, and Calendar is the 2nd.
  await expect(page.locator('.wp-stepchip')).toContainText('2 of 6')
  // …and the hair measures the same six, not the ten.
  await expect(page.locator('.wp-prog > div')).toHaveAttribute('style', /width:\s*33%/)
})

test('the agenda sheet opens from the counter and lists only runnable steps', async ({ page }) => {
  await mockApi(page)
  await signIn(page)
  await page.goto('/planning')
  await expect(page.locator('.wp-title')).toHaveText('Calendar')

  // Progressive disclosure: the acts are not on screen until asked for.
  await expect(page.getByText('Intake')).toHaveCount(0)
  await page.locator('.wp-stepchip').click()
  await expect(page.getByText('Intake')).toBeVisible()
  await expect(page.getByText("you're here")).toBeVisible()
  await page.screenshot({ path: 'test-results/weekly-planning-agenda.png' })

  // A step whose module is off is never offered as somewhere to jump.
  await expect(page.getByRole('button', { name: /Family night/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Loose ends/ })).toBeVisible()
})

test('the phone gets the same screen, with the footer reachable', async ({ page }) => {
  await mockApi(page)
  // Sign in at the default size — the nav collapses below the phone breakpoint and the
  // shared helper waits on it. The narrowing is what this test is about, so it's after.
  await signIn(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/planning')
  await expect(page.locator('.wp-title')).toBeVisible()
  await page.screenshot({ path: 'test-results/weekly-planning-phone.png' })

  expect(await withinViewport(page, '.wp-foot')).toBe(true)
  // The primary must stay on one line — "Save the week" wrapping turned the footer
  // into a two-line block. Measured as a height ceiling, because computed line-height
  // here is "normal" (parseFloat → NaN), not a number.
  const primaryHeight = await page.evaluate(() => {
    const el = document.querySelector('.wp-primary')
    return el ? Math.round(el.getBoundingClientRect().height) : 999
  })
  expect(primaryHeight).toBeLessThanOrEqual(56)

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})

test('the agenda sheet fits a phone instead of clipping its own text', async ({ page }) => {
  // The sheet set an explicit `width: 520px`, and `.modal-overlay`'s implicit grid
  // column sized to that, so `max-width: 100%` resolved to 520px too: on a phone the
  // card overhung the screen and its own `overflow-y: auto` cropped the text rather
  // than reflowing it. Nothing in the DOM looked wrong — only the geometry did.
  await mockApi(page)
  await signIn(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/planning')
  await page.locator('.wp-stepchip').click()
  await expect(page.getByText('Intake')).toBeVisible()
  await page.screenshot({ path: 'test-results/weekly-planning-sheet-phone.png' })

  const fit = await page.evaluate(() => {
    const el = document.querySelector('.wp-sheet') as HTMLElement | null
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { right: Math.round(r.right), left: Math.round(r.left), vw: window.innerWidth, clipped: el.scrollWidth - el.clientWidth }
  })
  expect(fit).not.toBeNull()
  expect(fit!.left).toBeGreaterThanOrEqual(0)
  expect(fit!.right).toBeLessThanOrEqual(fit!.vw)
  // Nothing cropped inside the card either.
  expect(fit!.clipped).toBeLessThanOrEqual(0)
})

test('a finished session reads back as a record', async ({ page }) => {
  await mockApi(page, {
    ...planningView,
    session: { ...session, status: 'completed', completedAt: '2026-09-06T17:40:00.000Z' },
    steps: steps.map((s) => (s.key === 'looseEnds' ? { ...s, status: 'done' } : s.key === 'calendar' ? { ...s, status: 'skipped' } : s)),
  })
  await signIn(page)
  await page.goto('/planning')
  await expect(page.getByText('The week is decided')).toBeVisible()
  await expect(page.getByText('Skipped — a real answer')).toBeVisible()
  await expect(page.getByRole('button', { name: /Reopen the session/ })).toBeVisible()
  await page.screenshot({ path: 'test-results/weekly-planning-record.png' })
})

// ── The validation pass ────────────────────────────────────────────────────────
// Two of the ten defects reported against these steps were things NO unit test could
// have caught: a layout that squeezed the month grid, and a hover fill with no room
// around it. Both were only visible in a browser, which is why they are asserted here
// rather than in jsdom.

// The parked-note handoff, which the shell draws above whichever step body is up.
const handoffView = {
  ...planningView,
  steps: steps.map((st) =>
    st.key === 'calendar'
      ? step('calendar', 2, 'Calendar', 'Frame the week', {
          parked: [
            { id: 'pk1', note: 'book the campsite before it fills up', byline: 'Alex · 2 weeks ago' },
            { id: 'pk2', note: 'ask about the field trip form', byline: 'Alex · yesterday' },
          ],
        })
      : st
  ),
}

test('a parked note is handed to its step, above the body and on screen', async ({ page }) => {
  await mockApi(page, handoffView)
  await signIn(page)
  await page.goto('/planning')
  await expect(page.locator('.wp-title')).toHaveText('Calendar')

  const banner = page.locator('.wp-handoff')
  await expect(banner).toBeVisible()
  await expect(banner).toContainText('book the campsite before it fills up')
  await expect(banner).toContainText('Alex · 2 weeks ago')
  await page.screenshot({ path: 'test-results/weekly-planning-handoff.png' })

  // It must not cost the footer its place — the banner is a sibling of the step body in
  // `.wp-body`, and anything there that isn't `flex: none` competes for height.
  expect(await withinViewport(page, '.wp-foot')).toBe(true)
  await expect(page.getByRole('button', { name: 'Handled' }).first()).toBeVisible()

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})

test('the handoff stacks its two answers under the note on a phone', async ({ page }) => {
  // Sign in at board size FIRST: `signIn` waits on the nav rail, which the phone layout
  // hides, so resizing before the sign-in makes the helper wait for something that will
  // never appear. Resize once the session is up.
  await mockApi(page, handoffView)
  await signIn(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/planning')
  await expect(page.locator('.wp-handoff')).toBeVisible()
  await page.screenshot({ path: 'test-results/weekly-planning-handoff-phone.png' })

  // The two answers go full width rather than crushing the note into a column the width
  // of a word: on a 390px screen the row is taller than a single line.
  const row = page.locator('.wp-handoff-row').first()
  expect((await row.boundingBox())!.height).toBeGreaterThan(60)

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})
