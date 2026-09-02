import { Component, type ReactNode } from 'react'

// A step body that throws must not take the session down with it.
//
// The route-level `ScreenBoundary` would catch it, but it would replace the WHOLE
// planning screen — the counter, the agenda sheet and the footer included — so one
// step failing would strand you with no way to skip past it or reach the other nine.
// This boundary is deliberately tighter: the chrome survives, and Skip and the
// affirmative still work, so a broken step costs you that step and nothing else.
//
// Reset by giving it `key={step.key}` — moving to another step should try again
// rather than inheriting the last one's failure.
export class StepErrorBoundary extends Component<{ children: ReactNode; title: string }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className="wp-placeholder">
        <div className="wp-placeholder-t">{this.props.title} didn't load</div>
        <div className="wp-placeholder-s">
          Something went wrong reading this step. The rest of the session still works — skip it
          for now, or jump to another step from the counter above.
        </div>
      </div>
    )
  }
}
