import { useMemo, useState, type FormEvent } from 'react'
import {
  eventsApi,
  invalidateGetCache,
  useEventsRange,
  useHousehold,
  usePersons,
  type AgendaEvent,
} from '../../../lib/api'
import { useEventColor } from '../../../lib/event-color'
import { createEventLocal } from '../../../lib/powersync/events-local'
import { DOW, DOW_FULL, addDays, fmtTime, localDate, ymd } from '../../components/cal-utils'
import type { PlanningStepModule, StepBodyProps } from '../registry'
import '../../../styles/planning-calendar.css'

// Step 2 · Calendar — the week is the whole screen, and it is the REAL calendar.
//
// Nothing here is invented: the seven columns are `GET /api/events` over the week the
// server handed us, coloured by owner exactly as the month/week/agenda views colour
// them (useEventColor). The one action is adding what isn't on there yet, composed in
// place on the day you tapped — no parallel "decide" list, no side column, no receipt.
//
// Three rules this file must not break:
//  1. THE SERVER OWNS THE WEEK. `weekStart` is a prop; the seven days are that date
//     plus 0…6. Nothing here asks the device what week it is.
//  2. THE SEVEN COLUMNS STAY EQUAL. The composer takes the place of a day's add tile;
//     the column does not grow to hold it. A column that widened on tap would make the
//     whole week jump under the reader mid-thought.
//  3. ADDING GOES THROUGH THE APP'S OWN EVENT-CREATION PATH — the same local-first
//     create EventModal uses for a plain, non-recurring event, falling back to REST
//     when PowerSync isn't running. A step that wrote its own SQL would be a second
//     way to make an event, and the two would drift.

// The composer opens with a TIME chosen rather than all-day: most of what a week turns
// out to be missing happens at an hour ("soccer at five"), and the all-day chip beside
// it is one tap away.
const DEFAULT_TIME = '17:00'

// A local-clock ISO for a day + time, the way EventModal builds one. NOT
// `new Date('2026-09-09')` — that is UTC midnight, and west of Greenwich it renders
// (and files) as the day before.
const toIso = (date: string, time: string): string => new Date(`${date}T${time}`).toISOString()

// "5:00 PM" from a 24h "17:00".
const clock = (t: string): string => {
  const [h, m] = t.split(':').map(Number)
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}

// What marks an event as "just added", for its ring. `createEventLocal` hands back a
// boolean rather than an id, so the two write paths can only agree on what the person
// actually typed — which is enough to light up the line they just made.
const madeKey = (dayKey: string, title: string) => `${dayKey} ${title.trim().toLowerCase()}`

interface Day {
  key: string
  dow: string
  dowFull: string
  num: number
  today: boolean
}

function Body({ weekStart, setDecisionData, refresh, busy }: StepBodyProps) {
  const { household } = useHousehold()
  const tz = household?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const { persons } = usePersons()
  const colorOf = useEventColor()

  // The week: the server's `weekStart` plus 0…6. Local parse (no trailing Z) so the
  // column headings are the days the household actually calls them.
  const days = useMemo<Day[]>(() => {
    const start = new Date(`${weekStart}T00:00:00`)
    const todayKey = ymd(new Date())
    return Array.from({ length: 7 }, (_, i) => {
      const d = addDays(start, i)
      const key = ymd(d)
      return { key, dow: DOW[d.getDay()], dowFull: DOW_FULL[d.getDay()], num: d.getDate(), today: key === todayKey }
    })
  }, [weekStart])

  const { events, loading, refetch } = useEventsRange(days[0].key, days[6].key)

  // Bucketed by the HOUSEHOLD's zone (localDate), not the device's — an 8pm event on an
  // out-of-zone kiosk belongs to the evening it happens in, not to tomorrow.
  const byDay = useMemo(() => {
    const map: Record<string, AgendaEvent[]> = {}
    for (const e of events) (map[localDate(e.startsAt, tz)] ??= []).push(e)
    for (const k of Object.keys(map)) {
      map[k].sort((a, b) =>
        a.allDay === b.allDay
          ? new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime()
          : a.allDay ? -1 : 1
      )
    }
    return map
  }, [events, tz])

  // The composer: one day at a time, in place.
  const [openDay, setOpenDay] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  // '' = all day. Otherwise a 24h HH:MM.
  const [time, setTime] = useState(DEFAULT_TIME)
  // MULTI-select: an event for both parents is the ordinary case, not the exception.
  const [who, setWho] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // How many things this session put on the week — the crumb, and only ever a count.
  // The recap reads through to the calendar itself, so copying event data onto the
  // session record would give the two something to disagree about.
  const [added, setAdded] = useState(0)
  // What this session added, so those lines keep a ring: you can see what you just did.
  const [made, setMade] = useState<Set<string>>(new Set())

  function open(key: string) {
    setOpenDay(key)
    setTitle('')
    setTime(DEFAULT_TIME)
    setWho([])
    setError(null)
  }

  function close() {
    setOpenDay(null)
    setError(null)
  }

  const toggleWho = (id: string) =>
    setWho((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))

  async function submit(e: FormEvent, dayKey: string) {
    e.preventDefault()
    const text = title.trim()
    if (!text || saving || busy) return
    setSaving(true)
    setError(null)
    // All-day events are filed at midday like everywhere else in the app, so they can't
    // slide into a neighbouring day on a zone change.
    const allDay = !time
    const startsAt = toIso(dayKey, time || '12:00')
    const endsAt = allDay ? null : new Date(new Date(startsAt).getTime() + 60 * 60000).toISOString()
    // Exactly EventModal's two shapes: `personIds` for the local DB, `participantIds`
    // for REST. Keeping the split identical is what stops the two paths drifting.
    const draft = {
      title: text,
      startsAt,
      endsAt,
      allDay,
      isCountdown: false,
      location: null,
      personIds: who,
      goalId: null,
      goalStepId: null,
    }
    const { personIds: ids, ...eventDraft } = draft
    try {
      // Prefer the local DB (instant, offline-capable, and it paints through the same
      // live query this screen reads); fall back to REST when PowerSync isn't running.
      // `calendarId: null` lets the server auto-route, as it does for a single-calendar
      // owner in EventModal.
      if (!(await createEventLocal({ ...draft, calendarId: null }))) {
        await eventsApi.createEvent({ ...eventDraft, participantIds: ids })
      }
      // The week digest is now out of date.
      invalidateGetCache('/api/calendar/heads-up')
      const n = added + 1
      setAdded(n)
      setDecisionData({ added: n })
      setMade((cur) => new Set(cur).add(madeKey(dayKey, text)))
      close()
      refetch()
      // The agenda sheet and the counter should agree with what just happened.
      refresh()
    } catch (err) {
      console.error('planning · calendar add failed', err)
      // ApiSendError carries the server's own `{ error, message }`; say what it said
      // rather than a generic apology, and keep the typed line so it can be retried.
      const said = (err as { body?: { message?: string } })?.body?.message
      setError(said ? `Couldn't add that — ${said}` : "Couldn't add that — try again.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="wpc">
      {/* The shell hides its own week label under 720px, so the body names the week
          there. Hidden on wide, where the header already says it. */}
      <div className="wpc-week-l">{`${days[0].dow} ${days[0].num} - ${days[6].dow} ${days[6].num}`}</div>
      {/* The one line of instruction the design keeps. Not a "worth knowing" strip: it
          says nothing about the CONTENTS of the week, only about how to change it. */}
      <p className="wpc-hint">
        Tap any day to add what isn&rsquo;t on here yet. Everything else is already on the calendar.
      </p>

      <div className="wpc-week">
        {days.map((d) => {
          const list = byDay[d.key] ?? []
          const composing = openDay === d.key
          return (
            <section key={d.key} className={`wpc-day${composing ? ' composing' : ''}`} data-testid={`wpc-day-${d.key}`}>
              <header className={`wpc-day-h${d.today ? ' today' : ''}`}>
                <span className="wpc-dow wf-serif">{d.dow}</span>
                <span className="wpc-num">{d.num}</span>
              </header>
              <div className="wpc-day-b">
                <div className="wpc-evs">
                  {list.map((e) => (
                    <div
                      key={`${e.id}-${e.occurrenceStart ?? ''}`}
                      className={`wpc-ev${made.has(madeKey(d.key, e.title)) ? ' new' : ''}`}
                    >
                      <i className="wpc-bar" style={{ background: colorOf(e) }} aria-hidden />
                      <span className="wpc-ev-t">{e.title}</span>
                      <span className="wpc-ev-w">{fmtTime(e)}</span>
                    </div>
                  ))}
                  {!list.length && !loading && <p className="wpc-none">Nothing yet</p>}
                </div>

                {composing ? (
                  <form
                    className="wpc-comp"
                    onSubmit={(e) => submit(e, d.key)}
                    onKeyDown={(e) => { if (e.key === 'Escape') close() }}
                  >
                    {/* No Cancel row — the design's composer is four rows and ends on the
                        primary. Backing out is this, or Escape. */}
                    <button type="button" className="wpc-comp-x" onClick={close} aria-label="Close">&times;</button>

                    {/* Row 1 — the line itself: one editable line, no box around it. */}
                    <input
                      className="wpc-comp-t"
                      autoFocus
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder="What's happening?"
                      aria-label={`What's happening on ${d.dowFull} ${d.num}?`}
                    />

                    {/* Row 2 — when: a chip pair, a time or all day. The time chip is a
                        real time control wearing the chip, so the platform's own picker
                        (and typing) both work on a kiosk. */}
                    <div className="wpc-row">
                      <label className={`wpc-chip wpc-chip-time${time ? ' on' : ''}`}>
                        <span className="wpc-chip-d">{d.dow}</span>
                        <span className="wpc-chip-v" aria-hidden>{clock(time || DEFAULT_TIME)}</span>
                        <input
                          type="time"
                          aria-label="Time"
                          value={time || DEFAULT_TIME}
                          onChange={(e) => setTime(e.target.value)}
                        />
                      </label>
                      <button
                        type="button"
                        className={`wpc-chip${!time ? ' on' : ''}`}
                        aria-pressed={!time}
                        onClick={() => setTime(time ? '' : DEFAULT_TIME)}
                      >
                        All day
                      </button>
                    </div>

                    {/* Row 3 — who it's for. One avatar chip per member, MULTI-select:
                        an event for both parents is the ordinary case. */}
                    <div className="wpc-row wpc-whos">
                      {persons.map((p) => {
                        const on = who.includes(p.id)
                        return (
                          <button
                            key={p.id}
                            type="button"
                            className={`wpc-chip wpc-chip-av${on ? ' on' : ''}`}
                            aria-pressed={on}
                            aria-label={p.name}
                            onClick={() => toggleWho(p.id)}
                          >
                            <i className="wpc-av" style={{ background: `${p.colorHex ?? '#A6A29B'}22` }} aria-hidden>
                              {p.avatarEmoji ?? '🙂'}
                            </i>
                            <span className="wpc-av-n">{p.name}</span>
                          </button>
                        )
                      })}
                    </div>

                    {error && <p className="wpc-err">{error}</p>}

                    {/* Row 4 — the one primary, full width. */}
                    <button type="submit" className="btn btn-primary wpc-go" disabled={!title.trim() || saving || busy}>
                      Add to the week
                    </button>
                  </form>
                ) : (
                  <button
                    type="button"
                    className="wpc-add"
                    disabled={busy}
                    aria-label={`Add something to ${d.dowFull} ${d.num}`}
                    onClick={() => open(d.key)}
                  >
                    <span aria-hidden>+</span>
                  </button>
                )}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}

// No FooterExtra: the shell already owns the single primary ("Looks right"), and one
// primary button is the whole argument of this screen.
const mod: PlanningStepModule = { Body }
export default mod
