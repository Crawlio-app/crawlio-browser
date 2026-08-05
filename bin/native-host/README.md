# Crawlio native-messaging host

Delivers the **real bridge token** to the extension over Chrome's authenticated
native-messaging channel, so the extension's server-identity handshake
(`bridge-handshake.ts` / `evaluateServerTrust`) can **refuse rogue local listeners**
that answer `/health` with `{service:"crawlio-mcp"}` but never read the real `0600`
bridge file. Without this channel the handshake is inert (trust-on-first-use).

## Files
- `provision.mjs` — pure helpers (NM frame encode/decode, freshest-live-bridge pick). Unit-tested (`tests/unit/native-host-provision.test.ts`).
- `host.mjs` — the host Chrome launches: `ping`→`pong`, then pushes `set_crawlio_token` + `set_crawlio_port` from the freshest live `~/.crawlio/bridges/<pid>.json`.
- `install.mjs` — writes the host manifest (`com.crawlio.agent.json`, locked to our extension id) + a node wrapper into each detected browser's `NativeMessagingHosts/` dir. `--uninstall` removes them.
- `ext-key.json` — the pinned public key + derived extension id (`hcjdiacihjiilndbaeligceompemdcmp`). `gen-key.mjs` regenerates it.

## Activate (one time, on the machine running the browser)
1. The extension manifest already pins `"key"` → stable id `hcjdiacihjiilndbaeligceompemdcmp`. **Reload the unpacked extension** so it adopts that id, and grant the `nativeMessaging` optional permission.
2. Install the host: `node bin/native-host/install.mjs`
3. Done. On connect the extension is handed the real token and refuses any WS server that can't prove it holds it.

## Verify (acceptance test)
With a real MCP server running (so a `~/.crawlio/bridges/<pid>.json` exists), start a **rogue** listener on a free 9333–9342 port that returns `{ "service":"crawlio-mcp" }` from `/health`. Expected: the extension connects, challenges, the rogue **fails** the handshake and its pushed commands are **refused**; the real server passes. (The token-delivery half — host framing + freshest-bridge selection — is already verified by the unit tests and a local stdio e2e.)

## If you ship your own key / publish to the Web Store
Run `node bin/native-host/gen-key.mjs` (or use the store-assigned id), paste the new `"key"` into `manifest.prod.json`, and re-run `install.mjs` — the host manifest's `allowed_origins` follows `ext-key.json` automatically.
