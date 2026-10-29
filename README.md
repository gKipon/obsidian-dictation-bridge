# Dictation Bridge

Record a short dictation in desktop Obsidian, send it to **your own HTTPS gateway**, and insert the transcript at the captured cursor or selection. Existing note content, title and path are not uploaded. If the note changes while waiting, the transcript stays in a recovery dialog for explicit insertion.

**Early community release, 0.1.0.** Requires Obsidian 1.14.5 or later, OS-encrypted SecretStorage, microphone access, a self-hosted gateway and a paid OpenAI API account. No hosted service or API key is supplied. Desktop only; mobile is not claimed. Provider charges and data handling are governed by the operator's OpenAI account.

## Install and connect

1. Deploy the included [gateway](gateway/README.md) to your own HTTPS host. Create a separate device UUID/token for each Obsidian vault/device.
2. Download `main.js`, `manifest.json` and `styles.css` from the GitHub release; verify `SHA256SUMS`. Copy them into `<vault>/.obsidian/plugins/dictation-bridge/`, then enable the plugin.
3. In settings, enter the complete HTTPS transcription endpoint, instance UUID and device token. This is **not** the OpenAI API key. No default endpoint is configured.
4. Optionally set expected ISO language codes (empty means auto-detect), a vocabulary of up to 50 terms, and whole-line Markdown formatting commands.
5. Open a Markdown note in editing mode and click the microphone icon or use **Start / stop dictation**. Assign a shortcut yourself in Obsidian Hotkeys.

Maximum recording: 4 minutes 55 seconds and 5 MiB. **Stop** sends the audio. **Cancel** discards unfinished local data; it cannot recall audio already received by the gateway/provider. Hiding the app or locking Cipherfold cancels an unfinished session. Undo uses the normal editor undo stack.

If the target note/selection changed, use **Show pending transcript**, choose the intended note and insert explicitly. Pending audio/text exists in memory only and is lost on cancellation, hiding, locking or exit. Retry uses the same request ID; ambiguous provider outcomes are never submitted again. See [privacy](docs/PRIVACY.md).

## Optional Cipherfold integration

Works without Cipherfold. If Cipherfold is present, dictation requires an unlocked compatible session and is cancelled before lock. Insertion goes through the native editor's ordinary encrypted save path. No enrollment file or private service is imported automatically.

## Development

```sh
npm ci --ignore-scripts
npm run check
python3 -m unittest discover -s gateway -v
```

Node.js 22 or 24; Python 3.10+ and ffprobe for gateway tests. No Python package dependencies. See [AGENTS.md](AGENTS.md), [architecture](docs/ARCHITECTURE.md), [verification](docs/VERIFICATION.md) and [contributing](CONTRIBUTING.md). MIT licensed; independently maintained community codebase.
