# Verification record — 0.1.0 release candidate

Checked on 2026-10-30 with synthetic data only.

- JavaScript regression suite: 17 tests passing.
- Standalone esbuild build from pinned npm dependencies; all runtime dependency licenses embedded.
- npm audit: zero reported vulnerabilities after the documented transitive override in Cipherfold.
- Isolated desktop Obsidian 1.14.5 profile/vault smoke checks; no existing installation used.
- Gateway: 12 Python tests, including real synthetic WAV probing with ffprobe, HTTP redaction/authentication, uncertain/repeated dispatch, duration limits, provisioning file permissions and multipart provider contract.
- Real Obsidian integration with a synthetic recorder/provider: exactly one request, only allowed fields uploaded, native insertion successful, microphone tracks stopped, English settings rendered and OS-encrypted configuration available. Works alongside unlocked Cipherfold.
- Actual HTTP redirects fail without reaching the redirect destination. Cancellation and late completion tests pass.

Not verified: real microphone hardware/permissions, a paid live OpenAI transcription with a new operator account, production nginx/systemd deployment, mobile or every desktop OS. No live provider secrets were used. Synthetic tests establish protocol and state handling, not recognition quality or provider account availability.

## Reproduce and extend

Run `npm ci --ignore-scripts && npm run check`, then the gateway tests if present. Perform integration tests only in a disposable application profile and empty test vault. Before publishing, scan the complete source tree, generated assets and Git history for secrets and private metadata; verify that a clean checkout reproduces release assets. Check actual uploaded asset hashes after release. Never treat a passing scanner as proof of no possible leak.
