# Pocket Minutes

A personal AI note-taker for in-person meetings. Put the phone on the table, capture
what's said, and get back a summary, decisions, action items (with owners and due
dates), open questions, and a chat you can ask about the meeting. Notes stay in the
app and can be saved to Google Docs or emailed to yourself.

## Project goal (agreed 2026-10-28)

| Question | Answer |
|---|---|
| Where are the meetings? | In person, with the phone on the table |
| What should the notes include? | Summary + action items, full transcript, ask-it-questions |
| Where do notes go? | Kept in the app, Google Docs/Drive, email |
| Who uses it? | Just the owner, so no accounts, sharing or app-store release |

## Phase 1: claude.ai artifact (done)

`artifact/pocket-minutes.html` is published as a private claude.ai artifact.

- **Capture:** artifacts can't use the microphone, so audio is captured outside the
  page: record in iPhone Voice Memos and paste its transcript, or dictate straight into
  the transcript box with the keyboard's mic key. `.txt`, `.vtt` and `.srt` files also load.
- **Notes:** Claude (through the artifact `sample` capability, on your own claude.ai plan)
  writes a summary, decisions, action items, open questions and topic tags.
- **Ask:** chat with any past meeting. Answers come from that meeting's transcript.
- **Storage:** meetings are kept in the artifact's private per-user database.
- **Export:** "Save to Google Docs" (Google Drive connector) and "Email me" (Gmail connector).

## Phase 2: portable phone app (next)

The plan is an installable web app (PWA) added to the iPhone home screen. It records
with the phone mic directly, so no copy-paste. It was picked over a native iOS app because:

- Native iOS for personal use needs a Mac with Xcode. With a free Apple ID the app has
  to be reinstalled every 7 days. The paid Apple Developer Program is $99/year.
- A PWA needs no Mac, no fee and no App Store, and installs from Safari with
  "Add to Home Screen".
- Its one real limit is that iOS stops web-app recording when the screen locks. For
  meetings with the phone face-up on a table, a screen wake lock keeps the screen on.

Planned stack: static PWA (GitHub Pages) → mic recording with `MediaRecorder` in
chunks, saved to IndexedDB so a crash doesn't lose audio → speech-to-text API →
Claude API for notes and Q&A → Google Docs / Gmail export. If background recording
with the screen locked turns out to matter, the same code can be wrapped in a native
shell (Expo/Capacitor) later.
