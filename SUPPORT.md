# Support

## Documentation

- [Overview and setup](https://docs.crawlio.app/browser-agent/overview)
- [Tool reference](https://docs.crawlio.app/browser-agent/tools)
- [README](README.md) — quick start, transport modes, architecture

## Before filing an issue

Run the built-in health check and include its output:

```bash
npx crawlio-browser doctor --json
```

It probes the bridge, portal, native-messaging host, MCP client configs, and Crawlio.app
without side effects, and redacts secrets before printing.

Common causes, in rough order of frequency:

| Symptom | Likely cause |
|---|---|
| Tools time out or say "not connected" | The Chrome extension is not installed, or its bridge is not connected. Check the extension's popup for a connected status. |
| "permission_denied" in a tool result | An optional permission has not been granted. Open the extension popup and approve the pending request. |
| Nothing captured on a `chrome://` or `about:` page | Browser-internal pages are not scriptable via CDP by design. |
| A page reports being opted out | The site sets `<meta name="crawlio-agent" content="disable">` and the extension respects it. |

## Bugs and feature requests

Open an issue: https://github.com/Crawlio-app/crawlio-browser/issues

Use the **Bug report** form for defects and **Feature request** for proposals. Blank issues
are disabled because the forms collect the version, client, and doctor output that almost
every diagnosis needs.

## Security vulnerabilities

Do **not** open a public issue. Follow the private disclosure process in
[SECURITY.md](SECURITY.md).

## Commercial support

Crawlio Browser is part of [Crawlio](https://www.crawlio.app). For commercial enquiries,
see the product site.
