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

## Phase 2: iPhone web app (built)

`app/` is an installable web app (PWA). Open it in Safari, tap Share, then
**Add to Home Screen**, and it runs like a normal app.

- **Record:** one tap records with the phone mic. The screen stays on, audio is saved to
  the phone every 5 seconds, and a new file starts every 10 minutes, so a crash or a
  closed app loses at most a few seconds. Pause/Resume, a live level meter, and warnings
  when iOS cuts the mic (lock screen, phone call).
- **Import:** an existing recording (Voice Memos `.m4a`, `.mp3`, `.wav`…) works too.
- **Gemini does the AI work, on your own key (free tier):** each 10-minute audio file is
  sent to Gemini for a timestamped transcript. A second call writes the notes (summary,
  action items, decisions, open questions, topics). The Ask tab streams answers about the
  meeting. No separate transcription service is used.
- **Model:** after you paste your key, the app lists the models your key can use and
  picks the newest Flash model. You can change it in Settings, and nothing needs
  changing in AI Studio.
- **Sharing:** iPhone share sheet (Gmail, Messages, Notes, Google Docs), Email me
  (opens Mail with the notes filled in), Copy, Save as file.
- **Privacy:** meetings, audio and the API key live only on the phone (IndexedDB +
  localStorage). Only the audio/text sent to Gemini leaves it. On Gemini's free tier
  Google may use what you send to improve its products.
- **Design:** styled with the Skyglass design system.

### Hosting

`.github/workflows/pages.yml` publishes `app/` to GitHub Pages on every push to `main`
that touches it. GitHub Pages needs either a **public** repo or a paid GitHub plan for a
private one. Turn it on once in **Settings → Pages → Source: GitHub Actions**.

### Run it locally

```bash
cd app && python3 -m http.server 8000   # then open http://localhost:8000
```

The mic needs HTTPS on a real phone, so test on the phone through the Pages URL.
