import Foundation
import Testing
@testable import Waffled

/// WHICH WORDS AN ANSWERED NOTE CARRIES.
///
/// The gold box lets a note be corrected in place, and renders the correction. But the
/// answer button handed the composer `note.note` — the stored words — so "Make an event" on
/// a note you had just fixed opened with the pre-edit wording, throwing the fix away at the
/// exact moment the note turned into a real event or task.
@Suite struct PlanningHandoffWordsTests {

    private func note(id: String, _ text: String) -> WaffledAPI.PlanningStepHandoff {
        WaffledAPI.PlanningStepHandoff(id: id, note: text, byline: nil)
    }

    @Test func anUneditedNoteCarriesItsStoredWords() {
        let n = note(id: "n1", "book the campsite")
        #expect(PlanningHandoffWords.of(n, edited: [:]) == "book the campsite")
    }

    @Test func anEditedNoteCarriesTheEdit() {
        let n = note(id: "n1", "book the capmsite")
        #expect(PlanningHandoffWords.of(n, edited: ["n1": "book the campsite"]) == "book the campsite")
    }

    /// Another note's edit is not this note's — the map is keyed by id for exactly this
    /// reason, since two notes can be open in the same box.
    @Test func oneNotesEditDoesNotLeakOntoAnother() {
        let n = note(id: "n2", "ask about the school trip")
        #expect(PlanningHandoffWords.of(n, edited: ["n1": "something else"]) == "ask about the school trip")
    }
}
