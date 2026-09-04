import { createContext, useContext, useEffect, useRef } from 'react'

/**
 * The step-relevant action on the shell's parked-note banner.
 *
 * The banner itself belongs to the shell — it is identical on every step, and the shell
 * is what refetches after a write, so a note dealt with anywhere stops being offered
 * everywhere. What it could NOT do was the thing you actually came to the step to do:
 * its only answers were "Handled" and "Drop it", both of which are bookkeeping.
 *
 * Reported as: "while handled vs not kind of works, I feel like we should have an action
 * relevant to the page we are on, like for tasks it should be 'make a task', for a
 * calendar parking it would be 'make an event', goals 'make a goal'".
 *
 * So the shell still owns the banner and each step lends it ONE verb. This context is
 * that loan. It deliberately does not let a step render into the banner — the banner
 * stays one shape on ten steps — and it deliberately does not grow a composer of its
 * own: the step already has one, and a second way to add a chore is how two of them
 * drift apart.
 *
 * A STEP WITHOUT A COMPOSER REGISTERS NOTHING, and the banner keeps saying "Handled".
 * That is the important half of the contract: a button labelled "Make a goal" that only
 * ticks the note off is worse than the plain one, because it promises an action it does
 * not perform.
 */
export interface HandoffAction {
  /** The verb of the step you are standing on — "Make a task", "Make an event". */
  label: string
  /** Open the step's OWN composer, seeded with the note's words. */
  run: (note: string) => void
}

interface HandoffCtxValue {
  register: (action: HandoffAction | null) => void
  /**
   * The step reporting back once its composer closes. TRUE only if something was
   * actually created — a cancelled composer must leave the note on the banner, because
   * settling it would quietly throw away the one record that it still needs doing.
   */
  finish: (created: boolean) => void
}

export const HandoffCtx = createContext<HandoffCtxValue>({ register: () => {}, finish: () => {} })

/**
 * Lend the banner this step's verb, for as long as the step is on screen.
 *
 * Returns the `finish` the step must call when its composer closes.
 */
export function useHandoffAction(label: string, run: (note: string) => void): (created: boolean) => void {
  const { register, finish } = useContext(HandoffCtx)
  // The run closure changes on every render (it captures the step's own state); the
  // registration must not, or the banner would re-register in a loop.
  const latest = useRef(run)
  latest.current = run
  useEffect(() => {
    register({ label, run: (note) => latest.current(note) })
    return () => register(null)
  }, [label, register])
  return finish
}
