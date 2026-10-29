# Self-hosted gateway

Requires Python 3.10+, ffmpeg/ffprobe on PATH, an OpenAI API account with access to `gpt-transcribe`, a dedicated system user, HTTPS reverse proxy and writable SQLite directory. No Python dependencies need installation. The plugin does not install or deploy this server.

## Local development

```sh
python3 -m unittest discover -s gateway -v
```

Install ffmpeg through your OS package manager first. The real WAV duration test is skipped if ffprobe is missing; a release operator should run it. Never use production recordings or keys in tests.

## Provision a device

```sh
python3 gateway/provision-device.py /secure/location/device.json
```

This exclusively creates a mode-0600 file containing a random instance UUID, bearer token and config entry with its SHA-256 digest. Add only the `server_device` entry to `devices` in your server config. Enter `instance_id` and `token` into the Obsidian settings. Use a distinct file and identity per device/vault, transfer securely, then protect or delete the enrollment file according to your policy. Removing the entry and restarting the gateway revokes that device. The command does not modify any server.

## Linux deployment

1. Create an unprivileged `dictation-bridge` system user. Install `service.py` in `/opt/dictation-bridge/` with root ownership. Create `/etc/dictation-bridge/` mode 0700 and `/var/lib/dictation-bridge/` owned by the service user, mode 0700.
2. Copy `deploy/config.example.json` to `/etc/dictation-bridge/config.json`, mode 0600, readable by the service user. Add your generated `server_device` entries. The database path must be dedicated to this installation. Do not reuse another deployment's state or identities.
3. Create root-owned `/etc/dictation-bridge/provider.env`, mode 0600, containing `OPENAI_API_KEY=` followed by your actual API key. Do not paste it into shell command arguments, history or repository files. The systemd manager reads this file for the process; the plugin never sees it.
4. Review `deploy/voice-gateway.service`, install it as `dictation-bridge.service`, and start it deliberately. It listens on **127.0.0.1:8897**, with memory/CPU limits, no core dumps and no timers. Change the port if occupied; do not stop an unrelated service.
5. Put `deploy/voice-gateway-routes.conf` inside a dedicated HTTPS nginx server block for your hostname. Install your own certificate. Validate nginx configuration before reloading. The public endpoint is `https://YOUR-HOST/dictation-bridge/v1/transcribe`. The exact routes allow CORS without cookies so desktop Obsidian Fetch works; the transcription route still requires its scoped bearer token.
6. GET `/dictation-bridge/healthz` checks configuration only. Make one explicit synthetic spoken request with your own API account to validate microphone/provider behavior and charges before real use.

Do not run the built-in HTTP listener directly on the public interface. Review all global nginx log/body settings; sample routes disable request logs, proxy buffering and temporary audio files for these routes. Never enable request-body debugging. Back up the ledger while preserving SQLite consistency. Restore the ledger together with device configuration after a failure; uncertain requests stay blocked.

Default quotas are global across devices: 120 requests and 3600 audio seconds per UTC day; maximum five minutes / 5 MiB per recording. Failed/uncertain dispatch keeps its reservation. The provider timeout is 75 seconds. Transcript cache is memory-only, up to 900 seconds. See [privacy](../docs/PRIVACY.md).
