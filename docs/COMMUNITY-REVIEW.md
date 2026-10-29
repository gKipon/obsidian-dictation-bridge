# Community directory review notes

This is an independent, MIT-licensed community codebase maintained in this repository. Its history, identifiers, build, documentation and runtime configuration are self-contained. There is no bundled hosted service, private updater, account bootstrap or production enrollment.

## Submission metadata

- Repository: https://github.com/gKipon/obsidian-dictation-bridge
- Release/tag: `0.1.1` (no `v` prefix).
- Minimum application version: 1.14.5; desktop only.
- License: MIT. Funding URL omitted.
- Install assets: `main.js`, `manifest.json`, `styles.css`; `SHA256SUMS` is an additional integrity file.
- Documentation: README, AGENTS, PRIVACY, ARCHITECTURE, VERIFICATION and CONTRIBUTING are in English.

## Reviewer attention

Users need their own HTTPS gateway and paid OpenAI API account. Audio, explicit vocabulary/language hints and random device/request identifiers leave the device; existing note text/title/path do not. Provider credentials stay on the gateway. The client token and options use OS-encrypted Obsidian SecretStorage with no plaintext fallback.

Microphone permission is requested only when starting dictation. Recording is limited to 295 seconds/5 MiB. Hiding the main application or locking Cipherfold cancels pending work. Ambiguous provider outcomes are held and never automatically dispatched again. Cancellation cannot recall already uploaded audio or charges.

Gateway source and deploy examples are included but never installed or provisioned by the plugin. Tests use synthetic audio and a stub provider; live microphone, paid-provider, mobile and popout-window acceptance are not claimed.

## Local lint review

The official recommended rules were run against `src/**/*.mjs` explicitly; the directory scanner documentation currently excludes `.mjs` by default. No critical no-eval, implied-eval, unsafe-HTML, forbidden-element or lookbehind finding occurred. Advisory findings include global timers/Fetch/WebCrypto in Node-testable modules, intentional empty catches for privacy/error cleanup, and sentence-case false positives for product names, acronyms and literal URLs. Settings currently use the imperative Setting API, so declarative settings search is not implemented. Main-window operation is the tested scope.

Approval is determined by the Obsidian team. This document is a review packet, not evidence that the listing has been submitted or accepted.
