import { useCallback, useEffect, useState } from 'react'
import { Icon } from '../../icons'
import { ChoreModal } from '../../components/ChoreModal'
import {
  can,
  useCurrencies,
  useHousehold,
  planningTasksApi,
  type PlanningTasksBoard,
  type PlanningTasksChore,
  type PlanningTasksPerson,
} from '../../../lib/api'
import type { PlanningStepModule, StepBodyProps } from '../registry'
import '../../../styles/planning-tasks.css'

// Step 8 · Tasks — "Who's doing what?"
//
// Laid out by person, in the same columns the kiosk Chores screen uses, because that is
// where the family already reads this. Everything nobody has taken sits in one strip
// across the top with the member faces under it: tap a face and the chore moves to that
// column; tap nobody and it stays up for grabs, which is a real answer and not an error
// state. Each column's footer names the recurring load that person already carries, so
// fairness is visible without anyone computing a score.
//
// A COLUMN IS THE WEEK, NOT THE SITTING. Its contents come from the server read — what
// that person is carrying for the week being planned — never from local "what I just
// moved" state, so a refresh, a remount or the iPad picking up where the phone left off
// all show the same board. Handing a chore out therefore re-reads rather than
// bookkeeping in the component.
//
// The unit is the chore DEFINITION, not the day's instance: the session plans a week,
// and an instance is one day. Handing one out is `PATCH /api/chores/:id` (plus an
// assign of any instance already sitting on a board), both existing chores endpoints —
// this step writes nothing of its own.

const SHORT_DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// "9am", "9:30am" — the day chip is a glance, not a schedule.
function shortTime(hhmm: string | null): string {
  if (!hhmm) return ''
  const [h, m] = hhmm.split(':').map(Number)
  if (Number.isNaN(h) || Number.isNaN(m)) return ''
  const ampm = h < 12 ? 'am' : 'pm'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return m === 0 ? `${h12}${ampm}` : `${h12}:${String(m).padStart(2, '0')}${ampm}`
}

const weekdayOf = (iso: string) => SHORT_DAY[new Date(`${iso}T00:00:00Z`).getUTCDay()]
const monthDay = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

// When this chore lands, in as few words as the chip can hold. Every branch is a fact
// the server handed us — nothing here guesses a day.
export function dayChip(c: PlanningTasksChore): string {
  const time = shortTime(c.dueTime)
  const withTime = (s: string) => (time ? `${s} ${time}` : s)
  if (c.carriedOver) return withTime('Carried over')
  if (c.days.length >= 7) return withTime('Every day')
  if (c.days.length > 0) return withTime(c.days.map(weekdayOf).join(', '))
  // A one-off whose date is outside the week still says which day it is for.
  if (c.dueOn) return withTime(monthDay(c.dueOn))
  return 'No day set'
}

// Where a card came from, as far as the chores module can honestly say.
function provenance(c: PlanningTasksChore): string {
  if (c.carriedOver) return 'Left over from before this week'
  return c.cadence === 'once' ? 'One-off task' : 'Recurring chore'
}

function carriesLabel(n: number): string {
  if (n === 0) return 'No recurring chores yet'
  return `Carries ${n} recurring chore${n === 1 ? '' : 's'}`
}

function ChoreCard({ chore, extra }: { chore: PlanningTasksChore; extra?: React.ReactNode }) {
  return (
    <div className="chore wpt-card">
      <div className="body">
        <div className="t">
          {chore.emoji ? `${chore.emoji} ` : ''}
          {chore.title}
        </div>
        <div className="wpt-sub">{provenance(chore)}</div>
        <div className="wpt-chip-row">
          <span className={`wpt-chip ${chore.days.length === 0 && !chore.dueOn ? 'is-unset' : ''}`}>{dayChip(chore)}</span>
        </div>
        {extra}
      </div>
    </div>
  )
}

function Body({ weekStart, setDecisionData, refresh, busy }: StepBodyProps) {
  const [board, setBoard] = useState<PlanningTasksBoard | null>(null)
  const [error, setError] = useState(false)
  const [saving, setSaving] = useState<string | null>(null)
  // Whose column's "+ Add for …" is open. `''` is the strip's own "Add a task" (nobody
  // prefilled); null is closed.
  const [adding, setAdding] = useState<string | null>(null)
  // How many chores this sitting handed over — the only thing worth remembering
  // locally, because the board itself can no longer tell you what moved today.
  const [assigned, setAssigned] = useState(0)

  const { person } = useHousehold()
  const cur = useCurrencies()
  // Handing a chore to someone else is chore.manage (the server enforces it, and the
  // kiosk board hides its drag grip the same way) — so don't offer a tap that 403s.
  const canAssign = can(person, 'chore.manage')

  const load = useCallback(() => {
    planningTasksApi
      .board(weekStart)
      .then((b) => {
        setBoard(b)
        setError(false)
      })
      .catch(() => setError(true))
  }, [weekStart])
  useEffect(load, [load])

  // The crumb kept on the session record: counts only. The recap reads through to
  // chores for the detail, so copying chore rows here would just let the two disagree.
  const open = board?.unassigned.length ?? 0
  useEffect(() => {
    if (!board) return
    setDecisionData({ assigned, leftUpForGrabs: open })
  }, [board, assigned, open, setDecisionData])

  async function give(chore: PlanningTasksChore, personId: string) {
    if (saving || busy) return
    setSaving(chore.id)
    try {
      await planningTasksApi.handOut(chore, personId)
      setAssigned((n) => n + 1)
      // Re-read rather than bookkeeping: the column is the week, and the server owns it.
      load()
      refresh()
    } catch {
      /* nothing moved, so there's nothing to undo — the chore stays in the strip */
    } finally {
      setSaving(null)
    }
  }

  function savedChore() {
    load()
    refresh()
  }

  if (error) return <div className="wp-empty">Couldn’t load the chores board — try again in a moment.</div>
  if (!board) return <div className="wp-empty">Loading…</div>

  const symbol = (key: string | null) => (key ? cur.byKey[key] : cur.defaultCurrency)?.symbol ?? '⭐'

  return (
    <div className="wpt">
      {/* The strip: everything nobody has taken, faces underneath. */}
      <div className="wpt-strip" data-testid="wpt-strip">
        <div className="wpt-strip-h">
          <span className="chore-ava grabs" aria-hidden>🙌</span>
          <span className="wpt-strip-t">Up for grabs</span>
          <span className="wpt-strip-s">
            {board.unassigned.length === 0
              ? '✓ Everything’s handed out.'
              : canAssign
                ? 'Tap a face to hand one over. Leaving one up for grabs is a real answer — whoever does it gets the stars.'
                : 'Whoever does one gets the stars.'}
          </span>
        </div>
        <div className="wpt-strip-list">
          {board.unassigned.map((c) => (
            <ChoreCard
              key={c.id}
              chore={c}
              extra={
                <>
                  {c.rewardAmount > 0 && (
                    <div className="star">
                      {symbol(c.rewardCurrency)} {c.rewardAmount}
                    </div>
                  )}
                  {canAssign && (
                    <div className="wpt-faces">
                      {board.people.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          className="wpt-face"
                          style={{ background: `${p.colorHex ?? '#A6A29B'}22` }}
                          title={`${p.name} takes it`}
                          aria-label={`Give ${c.title} to ${p.name}`}
                          disabled={busy || saving !== null}
                          onClick={() => give(c, p.id)}
                        >
                          {p.avatarEmoji ?? '🙂'}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              }
            />
          ))}
          {/* The strip's own tile — a task nobody owns yet, which is not the same
              thing as adding one to a person's column. */}
          <button type="button" className="wpt-add-tile" disabled={busy} onClick={() => setAdding('')}>
            <Icon name="plus" />
            Add a task
          </button>
        </div>
      </div>

      {/* The columns — the kiosk Chores layout, one per member, holding what that
          person is carrying for this week. */}
      <div className="wpt-cols">
        {board.people.map((p: PlanningTasksPerson) => (
          <div className="chore-col wpt-col" key={p.id} data-testid={`wpt-col-${p.name}`}>
            <div className="chore-head">
              <span className="nm">
                <span className="chore-ava" style={{ background: `${p.colorHex ?? '#A6A29B'}22` }}>{p.avatarEmoji ?? '🙂'}</span>
                {p.name}
              </span>
              <span className="wpt-count">{p.chores.length} this week</span>
            </div>

            <div className="chore-list">
              {p.chores.map((c) => (
                <ChoreCard key={c.id} chore={c} />
              ))}
            </div>
            {p.chores.length === 0 && <div className="tiny muted chore-empty">Nothing on {p.name}’s week yet.</div>}

            <button type="button" className="chore-add" disabled={busy} onClick={() => setAdding(p.id)}>
              <Icon name="plus" />
              Add for {p.name}
            </button>

            {/* What they already carry — the fairness read, stated rather than scored. */}
            <div className="wpt-carries">{carriesLabel(p.recurringChores)}</div>
          </div>
        ))}
      </div>

      {/* The app's existing New chore modal, with Who already prefilled — never a
          second chore form of this step's own. '' prefills nobody (up for grabs). */}
      {adding !== null && (
        <ChoreModal
          personId={adding || null}
          canAssignOthers={canAssign}
          selfPersonId={person?.id ?? null}
          onClose={() => setAdding(null)}
          onSaved={savedChore}
        />
      )}
    </div>
  )
}

const mod: PlanningStepModule = { Body }
export default mod
