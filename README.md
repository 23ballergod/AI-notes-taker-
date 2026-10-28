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

`.github/workflows/pages.yml` publishes `app/` to GitHub Pages at
`https://23ballergod.github.io/AI-notes-taker-/` on every push to `main` that touches it.
Turn it on once in **Settings → Pages → Source: GitHub Actions** (the repo must be public
on a free GitHub plan).

### Security: why a public repo doesn't expose your key

- **The key is never in this repo.** You type it into the app's Settings on your phone.
  It's stored only in that app's storage on that phone and sent only to Google's Gemini
  API over HTTPS. Anyone can read the code; nobody can read your key from it.
- **A strict Content Security Policy** (`app/index.html`) lets the page run only its own
  files and talk only to itself and `generativelanguage.googleapis.com`. Even if a script
  were somehow injected, it couldn't load or send the key anywhere else.
- **No third-party scripts, fonts or trackers** are loaded.
- **`.gitignore`** blocks `.env` and key files, and GitHub push protection blocks pushes
  that contain Google API keys.
- **Lock the key to this site** (Google Cloud Console → APIs & Services → Credentials →
  your key):
  - Application restrictions → **Websites** → `https://23ballergod.github.io/*`
  - API restrictions → **Restrict key** → **Generative Language API**
- **Don't attach billing** to the key's Google Cloud project. A free-tier key with no
  billing can't cost money; the worst case if it ever leaked is someone using up your free
  daily allowance. Delete and recreate the key in AI Studio if that ever happens.
- **Remove key from this phone** in Settings wipes it from the device.

### Run it locally

```bash
cd app && python3 -m http.server 8000   # then open http://localhost:8000
```

The mic needs HTTPS on a real phone, so test on the phone through the Pages URL.
