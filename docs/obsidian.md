# Obsidian: getting meeting notes in, and letting Claude read the vault

## 1. Pocket Minutes → Obsidian (built in, version 5)

On a meeting's Notes tab, tap **Send to Obsidian**. The app opens Obsidian's own
`obsidian://new` link, and Obsidian creates the note itself. No plugin, server or MCP
is involved, and nothing leaves the phone except to the Obsidian app.

- Notes land in `Meetings/YYYY-MM-DD Title.md`. Change the folder, and pick a vault by
  name, in the app's **Settings → Sending notes**. A blank vault name means the vault
  you last had open.
- Each note gets properties (`date`, `type: meeting`, `duration`, `attendees`, `tags`)
  and action items as `- [ ]` checkboxes, which work with Obsidian's Tasks and Dataview
  plugins.
- If the note is too long for a link (very long transcripts), the transcript is left
  out and the notes still go through.

## 2. Claude → your Obsidian vault: MCP server audit (2026-11-20)

I downloaded the exact published packages and read the code that would run. None of
them was executed.

| Server | Version audited | How it reaches the vault | Verdict |
|---|---|---|---|
| **`@modelcontextprotocol/server-filesystem`** (official MCP reference server) | 2.4.0 (npm) | Reads and writes files directly, limited to the folders you list | **Recommended.** See below. |
| `obsidian-mcp` (StevenStavrakis) | 2.0.1 (npm) | Reads and writes vault files directly | Acceptable, but has a **permanent delete** tool and no read-only mode. Single maintainer. |
| `mcp-obsidian` (MarkusPfundstein) | 0.2.3 (PyPI) | Calls the *Local REST API* community plugin on `127.0.0.1:27124` with that plugin's API key | Works, but adds a second component and key to trust, turns **TLS verification off**, and can **delete files and folders**. |

### Why the official server

- **Stays in the folder you give it.** Every path is resolved, and symlinks are
  followed to their real target, before any read or write. Anything outside the allowed
  folders is refused (`validatePath` in `dist/lib.js`).
- **No delete tool at all.** Its tools are read, list, search, file info, write,
  append, edit, create folder, move and copy. A move fails if the destination already
  exists.
- **`--read-only` mode** drops every write tool, keyed on the tools' own read-only flag.
- **No network.** It talks to Claude over stdio. An HTTP mode exists only behind
  `--transport streamable-http`, binds to `127.0.0.1` and accepts localhost origins only.
- **No `child_process`, `eval` or outgoing requests** anywhere in its code.
  Dependencies are the MCP SDK, `zod`, `diff` and `minimatch`.
- **Maintained** in the Model Context Protocol project's own repository.

### Set it up in Claude Desktop

1. Install Node.js (nodejs.org, the LTS version) on the computer that has the vault.
2. In Claude Desktop, open **Settings → Developer → Edit Config**. That opens
   `claude_desktop_config.json`. Add the following, with your real vault path:

   ```json
   {
     "mcpServers": {
       "obsidian-vault": {
         "command": "npx",
         "args": [
           "-y",
           "@modelcontextprotocol/server-filesystem@2.4.0",
           "--read-only",
           "/Users/YOUR-NAME/Downloads/YOUR-VAULT-FOLDER"
         ]
       }
     }
   }
   ```

   On Windows the path looks like `C:\\Users\\YOUR-NAME\\Downloads\\YOUR-VAULT-FOLDER`.
3. Quit and reopen Claude Desktop. Ask "list my Obsidian notes about meetings" to check.

- **Pinned to `@2.4.0`**, the version audited here. A newer version only runs after you
  change that number, so updates never arrive unreviewed.
- **Start with `--read-only`.** Claude can read and search the vault but can't change
  it. Remove that line once you want Claude to write or edit notes. Even then it can't
  delete anything.
- **Give it only the vault folder**, never your whole home or Downloads folder.
