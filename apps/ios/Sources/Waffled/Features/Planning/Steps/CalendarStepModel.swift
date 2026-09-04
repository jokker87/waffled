import Foundation
import Observation

// Weekly Planning · step 2 "Calendar" — the week's arithmetic and the little state the
// step keeps. Ported from `apps/web/src/kiosk/planning/steps/CalendarStep.tsx`.
//
// THERE IS NO NETWORK IN THIS STEP. `calendar.routes.ts` deliberately registers nothing:
// the week is the REAL calendar, read the ordinary iOS way (the PowerSync mirror via
// `SyncManager.eventsByDay`, which is what `GET /api/events?from&to` is on the web), and
// adding is the app's own `EventEditSheet` (`POST /api/events` / the local-first path).
// A `/api/weekly-planning/calendar` mirror of those would be a second door onto the same
// rows, and the two would drift.
//
// THE SERVER OWNS THE WEEK. Every day here is `weekStart` plus 0…6, done as STRING
// arithmetic in UTC — a week start is a calendar label, not an instant, and parsing it in
// the device's zone lands on the Saturday or the Monday twice a year (the same rule
// `PlanningFormat` keeps).

/// One day column of the planned week, resolved once per week rather than per render.
struct PlanningWeekDay: Identifiable, Equatable, Sendable {
    /// `YYYY-MM-DD`, household-local — the key into `SyncManager.eventsByDay`.
    let key: String
    /// "SUN".
    let dow: String
    /// "Sunday" — what the open-days sentence names, and the add button's label.
    let full: String
    /// "Sep 6".
    let date: String
    let isToday: Bool

    var id: String { key }
}

enum PlanningWeekDays {

    /// How many events a day shows before it collapses behind "+N more". BUSY WEEKS STAY
    /// ONE SCREEN — never a scrolling row, and never a navigation away.
    static let rowMax = 4

    /// The seven days of the planned week. `todayKey` is the household-local today, passed
    /// in so nothing here reaches for a clock.
    static func days(weekStart: String, todayKey: String) -> [PlanningWeekDay] {
        (0..<7).map { i in
            let key = addDays(weekStart, i)
            let weekday = dayOfWeek(key)
            return PlanningWeekDay(
                key: key,
                dow: dowShort[weekday].uppercased(),
                full: PlanningFormat.planningDayName(weekday),
                date: monthDay(key),
                isToday: key == todayKey)
        }
    }

    /// "Sep 6 – 12", and "Sep 27 – Oct 3" when the week straddles a month.
    static func weekRangeLabel(_ weekStart: String) -> String {
        guard let a = isoDay.date(from: weekStart) else { return weekStart }
        let b = a.addingTimeInterval(6 * 24 * 60 * 60)
        let sameMonth = monthOut.string(from: a) == monthOut.string(from: b)
        let left = "\(monthOut.string(from: a)) \(dayOut.string(from: a))"
        let right = sameMonth
            ? dayOut.string(from: b)
            : "\(monthOut.string(from: b)) \(dayOut.string(from: b))"
        return "\(left) – \(right)"
    }

    /// "Sunday, Thursday and Friday" — an Oxford-comma-free list a person would say.
    static func names(_ list: [String]) -> String {
        guard list.count > 1 else { return list.first ?? "" }
        return "\(list.dropLast().joined(separator: ", ")) and \(list[list.count - 1])"
    }

    /// The one line under the week range: how much is on the week, and what is still open.
    ///
    /// "7 events · Sunday and Thursday are still open" / "28 events · every day has
    /// something". THE OPEN DAYS ARE THE POINT OF THE STEP — a week with room in it is the
    /// thing a family can still decide about — so they are named, not counted.
    static func summary(total: Int, openDays: [String]) -> String {
        let count = total == 0 ? "Nothing on the week yet" : (total == 1 ? "1 event" : "\(total) events")
        let open: String
        if openDays.isEmpty {
            open = "every day has something"
        } else if openDays.count == 7 {
            open = "every day is still open"
        } else {
            open = "\(names(openDays)) \(openDays.count == 1 ? "is" : "are") still open"
        }
        return "\(count) · \(open)"
    }

    /// Step a `YYYY-MM-DD` by whole days, in UTC. (`PlanningFormat.addWeeks` does the same
    /// for weeks; its formatter is private, so this file keeps its own.)
    static func addDays(_ iso: String, _ n: Int) -> String {
        guard let base = isoDay.date(from: iso) else { return iso }
        return isoDay.string(from: base.addingTimeInterval(Double(n) * 24 * 60 * 60))
    }

    /// 0 = Sunday … 6 = Saturday.
    static func dayOfWeek(_ iso: String) -> Int {
        guard let d = isoDay.date(from: iso) else { return 0 }
        return (utcCalendar.component(.weekday, from: d) - 1 + 7) % 7
    }

    /// "Sep 6".
    static func monthDay(_ iso: String) -> String {
        guard let d = isoDay.date(from: iso) else { return iso }
        return "\(monthOut.string(from: d)) \(dayOut.string(from: d))"
    }

    private static let dowShort = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

    private static let utcCalendar: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c
    }()
    private static let isoDay: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()
    private static let monthOut: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "MMM"
        return f
    }()
    private static let dayOut: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "d"
        return f
    }()
}

@MainActor
@Observable
final class PlanningCalendarModel {

    /// What step 1 sent HERE — routed loose ends whose destination is this step.
    ///
    /// Handed down through `PlanningStepProps.routes` rather than read off this step's own
    /// `data`: `looseEnds.ts` persists the array on the **looseEnds** step's row, because
    /// that is the step whose decision it is, and a body only ever sees its own step. The
    /// shell holds every step, so the shell is the one place that can pass it across.
    private(set) var routes: [WaffledAPI.LooseEndRoute] = []
    /// Routes this sitting has already turned into an event — `"kind:id"`. The offer goes
    /// away once it has been taken, so nobody makes the same event twice.
    private(set) var made: Set<String> = []
    /// How many things this session put on the week. ONLY EVER A COUNT: the recap reads
    /// through to the calendar itself, so copying an event's title onto the session record
    /// would give the two something to disagree about.
    private(set) var added = 0
    private(set) var revision = 0

    /// The crumb. `added` matches the web's key exactly — both platforms write the same
    /// record, and the recap reads back whatever either wrote.
    ///
    /// COUNTS ONLY here, and that is safe for this step specifically: the routes live on
    /// step 1's row, not this one, so answering this step cannot erase them. (A step whose
    /// own row carries a mid-step write — Goals, Kids, Connection — must mirror it back,
    /// because the affirmative REPLACES `data`.)
    var decisionData: [String: JSONValue] { ["added": .int(added)] }

    /// The routes addressed to this step, from the shell.
    func seedRoutes(_ all: [WaffledAPI.LooseEndRoute]) {
        let mine = PlanningRouteSeed.addressed(to: "calendar", in: all)
        guard routes != mine else { return }
        routes = mine
        revision &+= 1
    }

    /// A real calendar event was created from this step.
    func recordEventAdded() {
        added += 1
        revision &+= 1
    }

    /// …and, when it came from a routed loose end, that offer is taken.
    func recordRouteMade(kind: String, id: String) {
        made.insert("\(kind):\(id)")
        revision &+= 1
    }

    /// Still worth offering — a route nobody has made an event for yet.
    var openRoutes: [WaffledAPI.LooseEndRoute] {
        routes.filter { !made.contains("\($0.kind):\($0.id)") }
    }
}
