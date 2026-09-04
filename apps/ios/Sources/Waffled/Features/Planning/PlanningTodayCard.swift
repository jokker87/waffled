import SwiftUI

/// Today card for Weekly Planning — the nudge, and the way back into a half-done week.
///
/// It has exactly three things to say, and says nothing the rest of the time:
///
///   * **Session due.** No session for the week ahead, and today IS the household's
///     session day. "Sunday's session · 9 steps."
///   * **Part-planned.** A session is open. "4 of 9 steps decided" — which is what makes
///     a week somebody stepped out of findable again from Today, instead of only from
///     the Planning surface.
///   * **Decided.** The session is saved. One quiet line, because after the recap "Today
///     is the surface, not this session" — so the card gets out of the way.
///
/// Everything else is `EmptyView`: an untouched Wednesday has no business carrying a
/// planning card. It also hides itself when the household turns `showOnToday` off
/// (Settings → Weekly Planning), matching Pantry and Family Night.
///
/// `kiosk == true` is the iPad family display (`KioskCard` + larger type); `false` is the
/// phone (`WaffledCard`). Gate the call site on `sync.module(.weeklyPlanning)`.
struct PlanningTodayCard: View {
    var kiosk = false
    /// Where tapping goes — the Planning surface. The card does not navigate itself,
    /// because Today and the Family hub host it in different `NavigationStack`s.
    var onOpen: () -> Void = {}

    @Environment(SyncManager.self) private var sync
    @State private var model = PlanningModel()

    /// What the card has to say, decided once per load rather than in the render path.
    private enum Prompt: Equatable {
        case due            // today is the session day and nothing is started
        case inProgress     // a session is open
        case decided        // the session is saved
        case quiet          // nothing worth a card
    }

    var body: some View {
        Group {
            if prompt == .quiet {
                // A ZERO-SIZE REAL VIEW, NOT `EmptyView`, AND THAT IS THE WHOLE BUG THIS
                // FIXES.
                //
                // `prompt` is `.quiet` until the first fetch lands, so on mount this
                // branch is the one taken. With `EmptyView` here SwiftUI materialises no
                // view at all, and a `.task` has nothing to attach to — so the fetch never
                // ran, `prompt` stayed `.quiet` for ever, and the card could not appear on
                // any device. It needed data to become visible and only loaded data once
                // visible. A green build and 1042 green tests both missed it; what caught
                // it was that the server logged no `GET /api/weekly-planning` at all while
                // the Family Night card beside it logged its own read.
                //
                // `FamilyNightCard` never hits this because it ALWAYS renders a real card
                // and decides its contents inside. This card is allowed to disappear —
                // an untouched Wednesday has no business carrying a planning card, and the
                // kiosk column clips anything oversized — so it needs a host that occupies
                // nothing but exists.
                //
                // Zero width AND height so it paints nothing. It does still take the
                // stack's spacing, which is why this card is appended LAST on Today: a
                // trailing gap ahead of the tab-bar clearance is invisible.
                Color.clear.frame(width: 0, height: 0)
            } else {
                Button(action: onOpen) {
                    Group {
                        if kiosk { KioskCard { cardBody } } else { WaffledCard(padding: 15) { cardBody } }
                    }
                }
                .buttonStyle(.plain)
            }
        }
        // Keyed on the refresh signal, not a bare `.task` — see SyncManager.refreshRev.
        // It must stay attached in BOTH branches: a session started on another device has
        // to be able to make a quiet card appear.
        .task(id: sync.refreshRev) { await model.load() }
    }

    private var prompt: Prompt {
        // Nothing decided until the first fetch lands: a card that flashed "session due"
        // and then vanished is worse than one that appears a beat late.
        guard let view = model.view, view.config.showOnToday else { return .quiet }
        if let session = view.session {
            return session.isCompleted ? .decided : .inProgress
        }
        return isSessionDayToday(view.config.dayOfWeek) ? .due : .quiet
    }

    /// 0 = Sunday … 6 = Saturday, in the HOUSEHOLD's zone — a device travelling a day
    /// ahead of the house should not move the session's prompt.
    ///
    /// `Calendar.component(.weekday)` is 1-based from Sunday, so it needs the -1.
    private func isSessionDayToday(_ dayOfWeek: Int) -> Bool {
        let weekday = Cal.gregorian(sync.householdTz).component(.weekday, from: Date()) - 1
        return weekday == ((dayOfWeek % 7) + 7) % 7
    }

    @ViewBuilder private var cardBody: some View {
        VStack(alignment: .leading, spacing: kiosk ? 10 : 8) {
            HStack(spacing: 8) {
                Text("🗓️ Weekly planning")
                    .font(kiosk ? .system(size: 16, weight: .heavy) : .system(size: 12.5, weight: .bold))
                    .foregroundStyle(kiosk ? WF.ink : WF.ink2)
                Spacer(minLength: 6)
                Text(model.weekLabel)
                    .font(.system(size: kiosk ? 13 : 12)).foregroundStyle(WF.ink3)
                Image(systemName: "chevron.right")
                    .font(.system(size: kiosk ? 13 : 12, weight: kiosk ? .bold : .semibold))
                    .foregroundStyle(WF.ink3)
            }
            Text(headline)
                .font(.system(size: kiosk ? 19 : 15, weight: .bold)).foregroundStyle(WF.ink)
                .fixedSize(horizontal: false, vertical: true)
            Text(detail)
                .font(.system(size: kiosk ? 15 : 13)).foregroundStyle(WF.ink3)
                .fixedSize(horizontal: false, vertical: true)
            if prompt == .inProgress, model.runnable.count > 0 {
                ProgressBar(value: model.progress, tint: WF.primary, track: WF.hair, height: kiosk ? 7 : 5)
                    .padding(.top, 2)
            }
        }
    }

    private var headline: String {
        switch prompt {
        case .due:        return "\(model.sessionDayName)’s session"
        case .inProgress: return "The week is part-planned"
        case .decided:    return "The week is decided"
        case .quiet:      return ""
        }
    }

    private var detail: String {
        let total = model.runnable.count
        switch prompt {
        case .due:
            return "\(total) \(total == 1 ? "step" : "steps"). Jump anywhere, leave whenever the week is decided."
        case .inProgress:
            return "\(model.settledCount) of \(total) steps decided — pick it up whenever."
        case .decided:
            return model.savedAtLabel.map { "Saved \($0)." } ?? "Saved."
        case .quiet:
            return ""
        }
    }
}
