import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  usePersons,
  planningConnectionApi,
  type Person,
  type PlanningConnectionBoard,
  type PlanningConnectionPairing,
  type PlanningConnectionSlot,
} from '../../../lib/api'
import { EventModal } from '../../components/EventModal'
import type { PlanningStepModule, StepBodyProps } from '../registry'
import '../../../styles/planning-connection.css'

// Step 5 · Connection — "Who gets time with whom?"
//
// NOTHING NEW IS STORED FOR THIS STEP. A pairing is a query over event_participants —
// an event whose people are exactly those two — and claiming a slot writes an ORDINARY
// CALENDAR EVENT with those participants. There is no pairing record to create, and
// this file must never grow one: a row's state is whatever the calendar says next time
// you look, which is why every action here re-reads instead of bookkeeping locally.
//
// Four rules this file must not break:
//
//  1. THE ROWS ARE A PROMPT, NOT THE LIST. The server ranks every pair in the house by
//     how long it has been; the step draws the top few. "Make a pairing" — any two
//     people, or three, any title, any time — is a FIRST-CLASS action sitting under
//     them at full width, not an affordance tucked in a corner.
//  2. TIME THAT ALREADY EXISTS GETS CREDIT. The honest answer is often "you're already
//     doing this together on Saturday", so a row leads with the time the week already
//     holds and offers a muted "already counts" instead of only offering to manufacture
//     a new commitment. A planning tool that can only add obligations is a worse tool.
//  3. ADDING IS THE APP'S OWN EVENT MODAL. `EventModal`, opened with the pairing's
//     people prefilled and the slot's date/time. It already owns the title, the
//     duration, repeats, the location, the "who" and the local-first write. The mock
//     draws a who/what/when composer; building one here would be a second event form,
//     and a second event form is the drift the reuse rule exists to prevent. What this
//     step keeps of the composer is only the half the modal CAN'T do: choosing who,
//     which is the input to the slot query, and picking one of the week's real gaps.
//     Both then prefill the modal — they are not a form, and they never save anything.
//  4. NO INVENTED TIMES. A slot is a gap the week left behind (server-computed, so iOS
//     gets the same ones): it opens when that day's last event ends. A day with nothing
//     on it has NO time at all — `EventModal`'s own picker decides — rather than this
//     step guessing at an evening.
//
// The faces are the household's REAL people (`usePersons`), never the design-era
// `components/Avatar`, which is a static map of four hardcoded emoji: who the pairing is
// between is the entire content of a row, so a stand-in family here would be worse than
// no faces at all.

// How many suggested pairings the step draws. The server ranks them all; this is purely
// a layout decision, which is why the footnote below says "the rows above" and never
// names a count — a two-person household has exactly ONE pairing.
// How many pairings the step shows. A pairing that already has time on the week is a
// fact about the week rather than a prompt, so it is never the one dropped: those are
// kept first and the rest of the cap is filled with the best-ranked guesses. Three
// stays the number — a six-person household would otherwise read fifteen rows — and it
// only grows when more than three pairings genuinely have time on them.
const ROWS = 3
// How many of a pairing's gaps fit on a row before "Another time" takes over.
const SLOTS = 2

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Aug 8". Local parse (no trailing Z) so the date doesn't slip a day west of Greenwich. */
function monthDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00`)
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`
}

/** "2 hours" / "45 minutes" — how long the thing they already have actually runs. */
function durationWords(min: number): string {
  if (min % 60 === 0) {
    const h = min / 60
    return `${h} ${h === 1 ? 'hour' : 'hours'}`
  }
  return `${min} minutes`
}

/**
 * Which pairings the step draws, IN THE SERVER'S OWN ORDER.
 *
 * `slice(0, ROWS)` was reported as a disappearing act: "I added a custom time … the
 * events did save but they didn't populate on the connection tab." The board is ranked
 * by how long it has been since it was just those two, and that ranking reads only
 * history BEFORE the planned week — so giving a pairing time INSIDE the week does not
 * move it up, and a pairing ranked fourth stayed invisible no matter what you had just
 * done for it. A row you cannot see is indistinguishable from a write that never
 * happened, which is exactly how it was read.
 *
 * So the pairings with time on the week claim their places first, and what's left of the
 * cap goes to the best-ranked pairings that have none. The step's first rule is that
 * time which already exists gets credit; this is that rule applied to which rows exist
 * at all.
 *
 * Filtered, not partitioned: re-grouping would float credit rows to the top and throw
 * away the ranking, which is the step's actual argument.
 */
export function visible<T extends { alreadyThisWeek: unknown[] }>(pairings: T[]): T[] {
  const credited = pairings.filter((p) => p.alreadyThisWeek.length)
  let guesses = Math.max(0, ROWS - credited.length)
  const keep = new Set(credited)
  for (const p of pairings) {
    if (guesses <= 0) break
    if (keep.has(p)) continue
    keep.add(p)
    guesses -= 1
  }
  return pairings.filter((p) => keep.has(p))
}

/** "20:30" for EventModal's time field, from the instant the gap opens. */
function localTime(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * The one line under a pairing's name — the whole job of a row, in a function, so the
 * wording is testable without a DOM and iOS has something to copy.
 *
 * It leads with the time that ALREADY EXISTS, because that is usually the true answer.
 * Failing that it says how long it has been and names the thing that is nearly it but
 * isn't ("Friday's dinner at the Hales is you both, but it's not that") — a near miss
 * is the most useful thing a row can say, and it is also the honest one.
 */
export function pairingSentence(p: PlanningConnectionPairing, acknowledged: boolean): string {
  const credit = p.alreadyThisWeek[0]
  if (credit) {
    if (acknowledged) return `Nothing new — ${credit.day}’s ${credit.title} already is it, and you said so out loud.`
    const len = credit.minutes ? ` for ${durationWords(credit.minutes)}` : ''
    return `${credit.day}’s ${credit.title} is the two of you${len} — that may already be it.`
  }
  const lead = `Nothing on the calendar with just the two of you${p.lastTogetherOn ? ` since ${monthDay(p.lastTogetherOn)}` : ''}.`
  const near = p.togetherThisWeek
  if (near.length === 1) return `${lead} ${near[0].day}’s ${near[0].title} is you both, but it’s not that.`
  if (near.length > 1) return `${lead} You’re both at ${near.length} things this week, but none of them is that.`
  return lead
}

/** What a slot chip hands the event modal: the day, and the time only when there is one. */
interface Compose {
  date: string
  time?: string
  participantIds: string[]
}
const composeFrom = (slot: PlanningConnectionSlot, participantIds: string[]): Compose => ({
  date: slot.date,
  time: slot.startsAt ? localTime(slot.startsAt) : undefined,
  participantIds,
})

// A person's face. Identity, not a control — so a span with the household's own colour
// tint, exactly as the Tasks step's `.wpt-face` paints one. The row's whole face group
// carries the names, so each face is decoration to a screen reader.
function Face({ person }: { person: Person }) {
  return (
    <span className="wpn-face" style={{ background: `${person.colorHex ?? '#A6A29B'}22` }} aria-hidden>
      {person.avatarEmoji ?? '🙂'}
    </span>
  )
}

function Body({ weekStart, setDecisionData, refresh, busy }: StepBodyProps) {
  const { persons } = usePersons()
  const [board, setBoard] = useState<PlanningConnectionBoard | null>(null)
  const [error, setError] = useState(false)
  // What this sitting put on the calendar, and how many pairings somebody said were
  // already covered. COUNTS ONLY: the crumb is a hint for the recap, never storage —
  // the recap reads through to the calendar, so copying event data here would only give
  // the two something to disagree about. (setDecisionData also doesn't reach the server
  // until the step is answered, so nothing may depend on it being there.)
  const [added, setAdded] = useState(0)
  // Pairings somebody said out loud are already covered by time the week has. Keyed by
  // the pairing's people. Deliberately local: it changes a sentence, nothing else, and
  // the row still reads correctly from the query alone on the next visit.
  const [counted, setCounted] = useState<Set<string>>(() => new Set())
  // The event modal, when one is open, and what it was opened with.
  const [compose, setCompose] = useState<Compose | null>(null)

  const load = useCallback(() => {
    planningConnectionApi
      .board(weekStart)
      .then((b) => { setBoard(b); setError(false) })
      .catch(() => setError(true))
  }, [weekStart])
  useEffect(load, [load])

  useEffect(() => {
    if (!board) return
    setDecisionData({ added, alreadyCounted: counted.size })
  }, [board, added, counted, setDecisionData])

  const byId = useMemo(() => new Map(persons.map((p) => [p.id, p])), [persons])

  function onSaved() {
    setAdded((n) => n + 1)
    // Re-read rather than bookkeeping: a pairing's status IS the calendar, so the only
    // honest way to redraw the rows is to ask again.
    load()
    refresh()
  }

  if (error) return <p className="wpn-empty">Couldn’t read your week just now.</p>
  if (!board) return <p className="wpn-empty">Looking at who’s been where…</p>
  if (!board.pairings.length) {
    return <p className="wpn-empty">This one needs more than one person in the household — add someone in Settings, and pairings appear here.</p>
  }

  return (
    <div className="wpn">
      {visible(board.pairings).map((p) => {
        const key = p.personIds.join('-')
        const people = p.personIds.map((id) => byId.get(id)).filter(Boolean) as Person[]
        const acknowledged = counted.has(key)
        const credit = p.alreadyThisWeek[0]
        return (
          <div className="wpn-row" key={key} data-testid={`wpn-pair-${key}`}>
            <div className="wpn-faces" role="img" aria-label={p.who}>
              {people.map((person) => <Face key={person.id} person={person} />)}
            </div>

            <div className="wpn-main">
              <div className="wpn-who">{p.who}</div>
              <p className="wpn-stat">{pairingSentence(p, acknowledged)}</p>
            </div>

            <div className="wpn-slots">
              {/* Time that already exists, first and muted. It offers nothing new —
                  it lets you say the week already answers this, which is a real
                  answer to "who gets time with whom" and the only one that doesn't
                  cost anybody an evening. */}
              {credit && (
                <button
                  type="button"
                  className={`wpn-slot wpn-counts${acknowledged ? ' on' : ''}`}
                  aria-pressed={acknowledged}
                  aria-label={`${credit.title} on ${credit.when} already counts`}
                  disabled={busy}
                  onClick={() =>
                    setCounted((cur) => {
                      const next = new Set(cur)
                      if (!next.delete(key)) next.add(key)
                      return next
                    })
                  }
                >
                  {credit.day.slice(0, 3)} {credit.time ?? 'all day'} counts
                </button>
              )}

              {p.slots.slice(0, SLOTS).map((s) => (
                <button
                  key={s.date}
                  type="button"
                  className="wpn-slot"
                  disabled={busy}
                  onClick={() => setCompose(composeFrom(s, p.personIds))}
                >
                  {s.label}
                </button>
              ))}

              <button
                type="button"
                className="wpn-slot wpn-add"
                aria-label={`Another time for ${p.who}`}
                disabled={busy}
                onClick={() => setCompose({ date: weekStart, participantIds: p.personIds })}
              >
                <span aria-hidden>＋</span> Another time
              </button>
            </div>
          </div>
        )
      })}

      <MakePairing weekStart={weekStart} persons={persons} busy={busy} onCompose={setCompose} />

      <p className="wpn-note">
        The rows above are just the pairings the app can see — they aren’t the list.{' '}
        <b>Make a pairing</b> takes any two people and any time, and the slots offered are the gaps the
        week already left behind. Either way it ends up as a normal calendar event. Add a third person
        and it still lands on the calendar — it just counts as time together rather than as time with
        just the two of them.
      </p>

      {/* The app's own event modal — NOT a second event form. It carries the people and
          the gap it was opened from; the title, the duration and the save are its own. */}
      {compose && (
        <EventModal
          date={compose.date}
          time={compose.time}
          prefill={{ participantIds: compose.participantIds }}
          onClose={() => setCompose(null)}
          onSaved={onSaved}
        />
      )}
    </div>
  )
}

/**
 * "＋ Make a pairing" — the first-class action, at full width under the rows.
 *
 * Choosing WHO is not an event form: it is the input to the slot query (the gaps depend
 * on whose week you're looking at) and the prefill for the modal. What and when and the
 * save all belong to `EventModal`, which is why there is no title field here and no
 * save button — every chip below opens the modal.
 */
function MakePairing({
  weekStart,
  persons,
  busy,
  onCompose,
}: {
  weekStart: string
  persons: Person[]
  busy: boolean
  onCompose: (c: Compose) => void
}) {
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(() => new Set())
  const [slots, setSlots] = useState<PlanningConnectionSlot[]>([])
  const [who, setWho] = useState('')

  // Household order, not the order they were tapped — so the same three people always
  // ask the server the same question, and the answer is cacheable and comparable.
  const chosen = useMemo(() => persons.filter((p) => picked.has(p.id)).map((p) => p.id), [persons, picked])

  // Keyed on the ids THEMSELVES, not on the array's identity: if `persons` ever came
  // back fresh per render, an array dependency would refire this every render and loop
  // /slots forever on a kiosk nobody is touching.
  const key = chosen.join(',')
  useEffect(() => {
    const ids = key ? key.split(',') : []
    if (ids.length < 2) { setSlots([]); setWho(''); return }
    let live = true
    planningConnectionApi
      .slotsFor(weekStart, ids)
      .then((r) => { if (live) { setSlots(r.slots); setWho(r.who) } })
      .catch(() => { if (live) { setSlots([]); setWho('') } })
    return () => { live = false }
  }, [weekStart, key])

  if (!open) {
    return (
      <button type="button" className="wpn-make-open" disabled={busy} onClick={() => setOpen(true)}>
        <span className="wpn-make-lead">
          <span aria-hidden>＋</span> Make a pairing — any two people, any time
        </span>
        <span className="wpn-faces" aria-hidden>
          {persons.map((p) => <Face key={p.id} person={p} />)}
        </span>
      </button>
    )
  }

  return (
    <div className="wpn-make" data-testid="wpn-make">
      <div className="wpn-make-row">
        <div className="wpn-lab">Who</div>
        <div className="wpn-picks">
          {persons.map((p) => {
            const on = picked.has(p.id)
            return (
              <button
                key={p.id}
                type="button"
                className={`wpn-face wpn-pick${on ? ' on' : ''}`}
                style={{ background: `${p.colorHex ?? '#A6A29B'}22`, borderColor: on ? (p.colorHex ?? undefined) : undefined }}
                aria-pressed={on}
                aria-label={on ? `${p.name} — take out of the pairing` : `${p.name} — add to the pairing`}
                disabled={busy}
                onClick={() =>
                  setPicked((cur) => {
                    const next = new Set(cur)
                    if (!next.delete(p.id)) next.add(p.id)
                    return next
                  })
                }
              >
                {p.avatarEmoji ?? '🙂'}
              </button>
            )
          })}
        </div>
        <div className="wpn-picked">{who ? `${who} · tap to add anyone else` : 'Tap two people — or three.'}</div>
      </div>

      {/* The same gaps a suggested row offers, for people the app didn't suggest. */}
      <div className="wpn-make-row">
        <div className="wpn-lab">When</div>
        <div className="wpn-slots wpn-slots-left">
          {chosen.length < 2 ? (
            <span className="wpn-hint">Their free evenings appear once there are two of them.</span>
          ) : (
            <>
              {slots.slice(0, SLOTS + 1).map((s) => (
                <button
                  key={s.date}
                  type="button"
                  className="wpn-slot"
                  disabled={busy}
                  onClick={() => onCompose(composeFrom(s, chosen))}
                >
                  {s.label}
                </button>
              ))}
              {/* "Any time" has to mean any time — the week's gaps are a shortcut, not
                  the only door. This one opens the modal on its own picker. */}
              <button
                type="button"
                className="wpn-slot wpn-add"
                disabled={busy}
                onClick={() => onCompose({ date: weekStart, participantIds: chosen })}
              >
                Pick a date and time
              </button>
            </>
          )}
        </div>
      </div>

      <div className="wpn-make-row">
        <div className="wpn-lab" />
        <button type="button" className="btn btn-ghost" onClick={() => { setOpen(false); setPicked(new Set()) }}>
          Cancel
        </button>
      </div>
    </div>
  )
}

// No FooterExtra: the shell already owns the single primary ("Done") and Skip
// ("Nothing this week"), and both are honest answers to this step on their own.
const mod: PlanningStepModule = { Body }
export default mod
