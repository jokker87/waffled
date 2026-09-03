import { useEffect, useState, useSyncExternalStore } from 'react'
import {
  planningKidsApi,
  planningKidsDecision,
  goalDisplayProgress,
  goalDisplayTarget,
  fmtGoalNum,
  type PlanningKidsView,
  type PlanningKidCard,
  type PlanningKidFocusOption,
  type PlanningKidForwardOption,
  type PlanningKidPick,
} from '../../../lib/api'
import type { PlanningStepModule, StepBodyProps } from '../registry'
import '../../../styles/planning-kids.css'

// Step 9 · Kids — "What's your week about?"
//
// THE ONE STEP THE KIDS THEMSELVES READ. Wally and Lottie are standing at the board, so
// the type is sized for them, their NAME is the title of their card, and both cards fit
// one screen — there is no per-kid navigation for a family of two. (On a phone there
// isn't room, so a segmented control puts one kid on screen at a time; both cards stay
// in the DOM and CSS decides, so switching costs nothing and there is only one layout to
// keep right.)
//
// TWO QUESTIONS EACH, AND BOTH ARE ANSWERED FROM THINGS THAT ALREADY EXIST. The focus
// options are that child's own goals, their own overdue chores and the standing chores
// they already carry; the look-forward-to options are events already on their week.
// "＋ Something else" is the escape hatch and sits LAST — a kid should recognise their
// week in the list rather than have to invent it. Everything on screen is composed by
// the server (see steps/kids.ts) except the goal's number, which goes through the SHARED
// display helper so a habit reads as this period's count and not a lifetime total.
//
// THE SECOND FRAME IS THE READ-BACK. Once every card has both answers the step stops
// being a picker and becomes the two sentences, large: "the part they'll actually
// remember". "Change something" in the footer puts the picker back.
//
// WHY THERE IS A STORE IN THIS FILE. The shell renders `Body` and `FooterExtra` as two
// sibling trees, and the footer's "Same as last week" / "Change something" is what the
// body has to react to. A context provider would mean editing the shell, so the state
// lives here, module-scoped and keyed by session+week so stepping to another week (or
// discarding the session) can't leave a previous week's answers on screen.
//
// The answers are a REAL write, never `setDecisionData` — the crumb only reaches the
// server when the step is ANSWERED, so a family that reads the cards out and walks away
// without pressing Done would lose the very thing they came here to say.

interface StepState {
  key: string
  view: PlanningKidsView | null
  loading: boolean
  error: string | null
  // The card a write is in flight for. One at a time: two answers landing together would
  // race two read-modify-writes of the same session crumb.
  saving: string | null
  // Which card the phone's segmented control is showing. Irrelevant on a wide screen,
  // where both are up.
  active: string | null
  // "Change something" — the read-back put away by hand, until they answer again.
  changing: boolean
  // Which escape hatch is open, if any.
  typing: { personId: string; which: 'focus' | 'forward' } | null
}

const EMPTY: StepState = { key: '', view: null, loading: true, error: null, saving: null, active: null, changing: false, typing: null }

let state: StepState = EMPTY
const listeners = new Set<() => void>()
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
const snapshot = () => state
function set(patch: Partial<StepState>) {
  state = { ...state, ...patch }
  for (const l of [...listeners]) l()
}

async function load(key: string, sessionId: string, weekStart: string) {
  set({ ...EMPTY, key })
  try {
    const view = await planningKidsApi.get(sessionId, weekStart)
    if (state.key !== key) return // a later week won the race
    set({ view, loading: false, active: view.kids[0]?.personId ?? null })
  } catch {
    if (state.key !== key) return
    set({ loading: false, error: "Couldn't read the kids' week — reload, or skip this step." })
  }
}

async function reread(sessionId: string, weekStart: string) {
  const key = state.key
  const view = await planningKidsApi.get(sessionId, weekStart)
  if (state.key === key) set({ view })
}

// Both components read the same state; `primary` (only Body passes it) says which one
// owns the fetching, so a remount doesn't fire two reads.
function useKidsStep(p: StepBodyProps, primary = false): StepState {
  const key = `${p.sessionId}|${p.weekStart}`
  useEffect(() => {
    if (state.key !== key) void load(key, p.sessionId, p.weekStart)
    else if (primary && !state.loading) void reread(p.sessionId, p.weekStart).catch(() => { /* the cards stay as they were */ })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return useSyncExternalStore(subscribe, snapshot)
}

async function answer(p: StepBodyProps, personId: string, body: { focus?: PlanningKidPick; forward?: PlanningKidPick }) {
  if (state.saving || p.busy) return
  set({ saving: personId, error: null, typing: null })
  try {
    const view = await planningKidsApi.answer(p.sessionId, personId, body, p.weekStart)
    // Answering again is how you get OUT of "Change something": the frame follows the
    // answers once they're fresh, rather than waiting to be told twice.
    set({ view, saving: null, changing: false })
  } catch {
    // Leave the last good answer on screen rather than a half-applied one.
    set({ saving: null, error: "That didn't take — try again." })
  }
  p.refresh()
}

// ---------------------------------------------------------------------------
// Bits
// ---------------------------------------------------------------------------

// "Wally and Lottie" — the mock's own step title. The catalog says "Kids" and is
// server-owned (web and iOS must not drift on it), so the names live here instead.
function heading(kids: PlanningKidCard[]): string {
  const names = kids.map((k) => k.name)
  if (names.length <= 1) return names[0] ?? 'Kids'
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

const readBackNow = (s: StepState) =>
  !s.changing && !!s.view && s.view.kids.length > 0 && s.view.kids.every((k) => k.settled)

function Face({ kid, className }: { kid: PlanningKidCard; className: string }) {
  // The household's REAL avatar on a tint of their own colour, the way the Tasks step
  // draws a person. (There is no shared person-avatar component on web; kiosk/components
  // /Avatar.tsx is a design-era stub with four hardcoded emoji and must not be used.)
  return (
    <span className={className} style={{ background: `${kid.colorHex ?? '#A6A29B'}22` }} aria-hidden>
      {kid.avatarEmoji ?? '🙂'}
    </span>
  )
}

function FocusOption({ option, checked, disabled, onPick }: {
  option: PlanningKidFocusOption
  checked: boolean
  disabled: boolean
  onPick: () => void
}) {
  // The number ALWAYS comes from the shared helper — never an inline `totalProgress`,
  // which would tell a kid they'd read 99 times this week. `detail` is the server's
  // sentence for the same fact, and is null on a standing chore because nothing is wrong
  // with it: that absence is the design, not a missing string.
  const progress = option.goal ? goalDisplayProgress(option.goal) : null
  const target = option.goal ? goalDisplayTarget(option.goal) : null
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      className={`wpk-opt${checked ? ' on' : ''}`}
      onClick={onPick}
    >
      <span className="wpk-opt-e" aria-hidden>{option.emoji}</span>
      <span className="wpk-opt-main">
        <span className="wpk-opt-t">{option.label}</span>
        {option.detail && <span className="wpk-opt-s">{option.detail}</span>}
        {option.routed && <span className="wpk-routed">sent here in step 1</span>}
      </span>
      {progress != null && (
        <span className="wpk-opt-num">
          <span className="wpk-num">{fmtGoalNum(progress)}</span>
          {target != null && <span className="wpk-den">/ {fmtGoalNum(target)}</span>}
        </span>
      )}
    </button>
  )
}

function ForwardOption({ option, checked, disabled, onPick }: {
  option: PlanningKidForwardOption
  checked: boolean
  disabled: boolean
  onPick: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      className={`wpk-fchip${checked ? ' on' : ''}`}
      onClick={onPick}
    >
      <span aria-hidden>{option.emoji}</span>
      {/* Day and title in ONE node: the week strip above already carries the title on
          its own, and two identical labels on a card make it unreadable by voice. */}
      <span className="wpk-fchip-n">{option.when} · {option.label}</span>
    </button>
  )
}

function TypeIn({ label, placeholder, disabled, onCancel, onSave }: {
  label: string
  placeholder: string
  disabled: boolean
  onCancel: () => void
  onSave: (text: string) => void
}) {
  const [text, setText] = useState('')
  return (
    <form
      className="wpk-type"
      onSubmit={(e) => { e.preventDefault(); if (text.trim()) onSave(text.trim()) }}
    >
      <input
        className="input"
        aria-label={label}
        placeholder={placeholder}
        value={text}
        autoFocus
        maxLength={120}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
      />
      <button type="submit" className="btn btn-primary" disabled={disabled || !text.trim()}>Save</button>
      <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
    </form>
  )
}

// ---------------------------------------------------------------------------
// One card
// ---------------------------------------------------------------------------

function Card({ kid, s, p, readBack }: { kid: PlanningKidCard; s: StepState; p: StepBodyProps; readBack: boolean }) {
  const frozen = p.busy || s.saving !== null
  const typing = s.typing?.personId === kid.personId ? s.typing.which : null

  return (
    <section
      className={`wpk-card${s.active === kid.personId ? ' on' : ''}`}
      role="group"
      aria-label={kid.name}
    >
      <header className="wpk-h">
        <Face kid={kid} className="wpk-face" />
        <div className="wpk-id">
          <div className="wpk-nm">{kid.name}</div>
          {kid.age != null && <div className="wpk-ag">age {kid.age}</div>}
        </div>
        {/* Stars are funded by chores, so an economy that is off simply isn't drawn —
            never a zero, which would read as "you've earned nothing". */}
        {kid.stars != null && (
          <div className="wpk-stars">{kid.starsSymbol ?? '⭐'} {kid.stars}</div>
        )}
      </header>

      {/* Their week, in both frames: the kid at the board wants to see their own week
          whether or not they've answered yet. */}
      <div className="wpk-sec">
        <div className="wpk-lab">Your week</div>
        <ul className="wpk-chips" aria-label={`${kid.name}’s week`}>
          {kid.week.map((e) => (
            <li key={e.id} className="wpk-chip">
              <span className="wpk-chip-t">{e.when}</span>
              <span className="wpk-chip-n">{e.title}</span>
            </li>
          ))}
          {kid.chores.map((c) => (
            <li key={`c-${c.id}`} className={`wpk-chip${c.late ? ' late' : ''}`}>
              <span className="wpk-chip-t">{c.when}</span>
              <span className="wpk-chip-n">{c.title}</span>
            </li>
          ))}
          {kid.week.length === 0 && kid.chores.length === 0 && (
            <li className="wpk-chip"><span className="wpk-chip-n">Nothing on it yet</span></li>
          )}
        </ul>
      </div>

      {readBack ? (
        <div className="wpk-sec" role="region" aria-label={`What ${kid.name} said`}>
          {kid.focus && (
            <div className="wpk-said">
              <div className="wpk-said-e" aria-hidden>{kid.focus.emoji}</div>
              <div className="wpk-said-b">
                <div className="wpk-big">{kid.focus.label}</div>
                <div className="wpk-cap">this week’s one thing</div>
              </div>
            </div>
          )}
          {kid.forward && (
            <div className="wpk-said">
              <div className="wpk-said-e" aria-hidden>{kid.forward.emoji}</div>
              <div className="wpk-said-b">
                <div className="wpk-big">{kid.forward.label}</div>
                <div className="wpk-cap">
                  {kid.forward.when ? `${kid.forward.when} — ` : ''}the bit to look forward to
                </div>
              </div>
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="wpk-sec">
            <div className="wpk-lab">One thing to focus on</div>
            <div className="wpk-opts" role="radiogroup" aria-label={`${kid.name}’s one thing`}>
              {kid.focusOptions.map((o) => (
                <FocusOption
                  key={o.key}
                  option={o}
                  checked={kid.focus?.source === o.source && kid.focus?.id === o.id}
                  disabled={frozen}
                  onPick={() => void answer(p, kid.personId, { focus: { key: o.key } })}
                />
              ))}
              {/* LAST, and quiet. The escape hatch, not the main path. */}
              <button
                type="button"
                role="radio"
                aria-checked={kid.focus?.source === 'custom'}
                disabled={frozen}
                className={`wpk-opt more${kid.focus?.source === 'custom' ? ' on' : ''}`}
                onClick={() => set({ typing: { personId: kid.personId, which: 'focus' } })}
              >
                {kid.focus?.source === 'custom' ? kid.focus.label : '＋ Something else'}
              </button>
            </div>
            {typing === 'focus' && (
              <TypeIn
                label={`Something else for ${kid.name}`}
                placeholder="In their own words"
                disabled={frozen}
                onCancel={() => set({ typing: null })}
                onSave={(text) => void answer(p, kid.personId, { focus: { text } })}
              />
            )}
          </div>

          <div className="wpk-sec">
            <div className="wpk-lab">Something to look forward to</div>
            <div className="wpk-fwd" role="radiogroup" aria-label={`what ${kid.name} is looking forward to`}>
              {kid.forwardOptions.map((o) => (
                <ForwardOption
                  key={o.key}
                  option={o}
                  checked={kid.forward?.eventId === o.eventId}
                  disabled={frozen}
                  onPick={() => void answer(p, kid.personId, { forward: { key: o.key } })}
                />
              ))}
              <button
                type="button"
                role="radio"
                aria-checked={kid.forward?.eventId === null && kid.forward != null}
                disabled={frozen}
                className={`wpk-fchip more${kid.forward != null && kid.forward.eventId === null ? ' on' : ''}`}
                onClick={() => set({ typing: { personId: kid.personId, which: 'forward' } })}
              >
                {kid.forward != null && kid.forward.eventId === null ? kid.forward.label : '＋ Add something'}
              </button>
            </div>
            {typing === 'forward' && (
              <TypeIn
                label={`Something else for ${kid.name} to look forward to`}
                placeholder="Something on their week"
                disabled={frozen}
                onCancel={() => set({ typing: null })}
                onSave={(text) => void answer(p, kid.personId, { forward: { text } })}
              />
            )}
          </div>
        </>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// The step
// ---------------------------------------------------------------------------

function Body(p: StepBodyProps) {
  const s = useKidsStep(p, true)
  const { setDecisionData } = p

  // Mirror what the session already knows onto the crumb after EVERY fresh read, not
  // only after a click: the shell RESETS the crumb on step change and replaces the
  // step's stored data when the primary is pressed, so a body that only set it in its
  // click handler would erase its own record after a remount.
  useEffect(() => { if (s.view) setDecisionData(planningKidsDecision(s.view)) }, [s.view, setDecisionData])

  if (s.loading) return <div className="wpk-note">Reading their week…</div>
  if (s.error && !s.view) return <div className="wpk-note">{s.error}</div>

  const kids = s.view?.kids ?? []
  if (kids.length === 0) {
    return (
      <div className="wpk-note">
        No one in this household is set up as a child yet, so there are no cards to read
        out. Add them in Settings → People (member type “kid”) and this step will have
        something to ask — skipping is a real answer in the meantime.
      </div>
    )
  }

  const readBack = readBackNow(s)
  return (
    <div className="wpk">
      <h2 className="wpk-title">{heading(kids)}</h2>

      {/* Phone only (CSS). Both cards stay mounted; this only decides which is on
          screen, so switching kid costs nothing and loses no half-typed answer. */}
      <div className="wpk-tabs" role="tablist" aria-label="Which kid">
        {kids.map((k) => (
          <button
            key={k.personId}
            type="button"
            role="tab"
            aria-selected={s.active === k.personId}
            className={`wpk-tab${s.active === k.personId ? ' on' : ''}`}
            onClick={() => set({ active: k.personId })}
          >
            <Face kid={k} className="wpk-tab-face" />
            <span className="wpk-tab-n">{k.name}</span>
            {k.settled && <span aria-hidden>★</span>}
          </button>
        ))}
      </div>

      {s.error && <div className="wpk-note">{s.error}</div>}

      <div className="wpk-cards">
        {kids.map((k) => (
          <Card key={k.personId} kid={k} s={s} p={p} readBack={readBack} />
        ))}
      </div>
    </div>
  )
}

// One more control beside Skip and the affirmative — and WHICH one is the frame's own
// question. On the picker it is the shortcut the mock names ("Same as last week"); on
// the read-back it is the way back ("Change something"). Both are the middle button in
// the mock's two frames.
//
// The phone's "Lottie →" is deliberately NOT here: the per-kid picker lives in the body
// where per-kid navigation belongs, so this slot keeps one meaning on every screen size.
function FooterExtra(p: StepBodyProps) {
  const s = useKidsStep(p)
  if (!s.view || s.view.kids.length === 0) return null
  if (readBackNow(s)) {
    return (
      <button type="button" className="btn btn-ghost" onClick={() => set({ changing: true })}>
        Change something
      </button>
    )
  }
  if (!s.view.canRepeat) return null
  return (
    <button
      type="button"
      className="btn btn-ghost"
      disabled={p.busy || s.saving !== null}
      onClick={() => {
        if (state.saving || p.busy) return
        set({ saving: 'repeat', error: null })
        planningKidsApi.repeat(p.sessionId, p.weekStart)
          .then((view) => set({ view, saving: null, changing: false }))
          .catch(() => set({ saving: null, error: "Couldn't copy last week — pick this week's instead." }))
          .finally(() => p.refresh())
      }}
    >
      Same as last week
    </button>
  )
}

const mod: PlanningStepModule = { Body, FooterExtra }
export default mod
