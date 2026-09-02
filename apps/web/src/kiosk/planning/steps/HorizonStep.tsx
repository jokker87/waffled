import { StepPlaceholder } from '../StepPlaceholder'
import type { PlanningStepModule, StepBodyProps } from '../registry'

// Step 3 · Horizon scan — reads the calendar.
//
// THIS FILE IS YOURS. The shell (WeeklyPlanning.tsx), the registry and the other nine
// steps are not: build this step by replacing the placeholder below, add any styles in
// apps/web/src/styles/planning-horizon.css, and put its API client in
// apps/web/src/lib/api/planning/horizon.ts. See docs/product/weekly-planning-plan.md
// ("Building the steps in parallel") before you start.
function Body(props: StepBodyProps) {
  return <StepPlaceholder step={props.step} />
}

// `FooterExtra` is optional: export it to put one more control in the footer next to
// Skip and the affirmative (v4 gives Meals "✨ Plan the rest for me" and an undo).
const mod: PlanningStepModule = { Body }
export default mod
