# Crawlio Agent Command Reference

Full catalog of all commands available via `search` and `execute`.

## Browser Commands (96)

Commands sent via `bridge.send({ type: "<command>", ...params })`.

### Connection & Tab Management

| Command | Description | Key Parameters |
|---------|-------------|----------------|
| `connect_tab` | Connect to a browser tab (opens new if needed) | `url?`, `tabId?` |
| `disconnect_tab` | Disconnect from the current tab | — |
| `list_tabs` | List all open browser tabs | — |
| `get_connection_status` | Check current connection state | — |
| `reconnect_tab` | Reconnect to the last connected tab | — |
| `get_capabilities` | Get extension capabilities and version | — |
| `create_tab` | Create a new browser tab | `url` |
| `close_tab` | Close a specific tab | `tabId` |
| `switch_tab` | Switch to a specific tab | `tabId` |

### Navigation & Interaction

| Command | Description | Key Parameters |
|---------|-------------|----------------|
| `browser_navigate` | Navigate to a URL | `url` |
| `browser_click` | Click an element | `selector`, `button?`, `modifiers?` |
| `browser_type` | Type text into an element | `selector`, `text`, `slowly?`, `submit?` |
| `browser_press_key` | Press a keyboard key | `key`, `modifiers?` |
| `browser_hover` | Hover over an element | `selector` |
| `browser_select_option` | Select dropdown option | `selector`, `value?`, `label?`, `index?` |
| `browser_wait` | Wait for a specified duration | `ms` |
| `browser_fill_form` | Fill multiple form fields at once | `selector`, `values` |
| `browser_scroll` | Scroll the page or element | `x?`, `y?`, `selector?`, `direction?` |
| `browser_double_click` | Double-click an element | `selector` |
| `browser_drag` | Drag from one element to another | `sourceSelector`, `targetSelector` |
| `browser_file_upload` | Upload a file to an input | `selector`, `filePath` |
| `browser_evaluate` | Execute JavaScript in the page | `expression`, `returnByValue?` |
| `browser_snapshot` | Capture accessibility tree snapshot | — |
| `browser_wait_for` | Wait for element to appear | `selector`, `timeout?` |
| `browser_intercept` | Intercept and modify network requests | `urlPattern`, `action`, `responseBody?`, `statusCode?` |

### Data Capture

| Command | Description | Key Parameters |
|---------|-------------|----------------|
| `capture_page` | Full page capture (framework, network, console, DOM, cookies) | — |
| `detect_framework` | Detect JavaScript frameworks | — |
| `start_network_capture` | Start capturing network requests | — |
| `stop_network_capture` | Stop and return captured network requests | — |
| `get_console_logs` | Get console log entries | — |
| `get_cookies` | Get all cookies for the current page | `url?` |
| `get_dom_snapshot` | Get DOM snapshot | `depth?` |
| `take_screenshot` | Take a screenshot | `fullPage?`, `selector?`, `format?`, `quality?` |
| `ocr_screenshot` | Extract text from page via Vision.framework OCR (macOS) | `fullPage?`, `selector?` |
| `get_response_body` | Get response body for a network request | `requestId` |
| `get_websocket_connections` | List active WebSocket connections | — |
| `get_websocket_messages` | Get messages for a WebSocket connection | `requestId`, `limit?` |

### Session Recording

| Command | Description | Key Parameters |
|---------|-------------|----------------|
| `start_recording` | Start recording browser session | `maxDurationSec?` (10–600), `maxInteractions?` (1–500) |
| `stop_recording` | Stop recording and return full session data | — |
| `get_recording_status` | Check active recording status and counters | — |

### Cookies & Storage

| Command | Description | Key Parameters |
|---------|-------------|----------------|
| `set_cookie` | Set a cookie | `name`, `value`, `domain?`, `path?`, `secure?`, `httpOnly?`, `sameSite?`, `expires?` |
| `delete_cookies` | Delete cookies | `name?`, `domain?`, `url?` |
| `get_storage` | Get localStorage or sessionStorage | `storageType` |
| `set_storage` | Set a storage item | `storageType`, `key`, `value` |
| `clear_storage` | Clear storage | `storageType` |

### Frames

| Command | Description | Key Parameters |
|---------|-------------|----------------|
| `get_frame_tree` | Get the frame tree hierarchy | — |
| `switch_to_frame` | Switch execution context to a frame | `frameId` |
| `switch_to_main_frame` | Switch back to the main frame | — |

### Dialogs

| Command | Description | Key Parameters |
|---------|-------------|----------------|
| `get_dialog` | Get current dialog info (alert, confirm, prompt) | — |
| `handle_dialog` | Accept or dismiss a dialog | `accept`, `promptText?` |

### Device Emulation

| Command | Description | Key Parameters |
|---------|-------------|----------------|
| `set_viewport` | Set viewport dimensions | `width`, `height`, `deviceScaleFactor?`, `isMobile?` |
| `set_user_agent` | Override the user agent string | `userAgent` |
| `emulate_device` | Emulate a device preset | `device` |
| `set_geolocation` | Set geolocation coordinates | `latitude`, `longitude`, `accuracy?` |

### Network Control

| Command | Description | Key Parameters |
|---------|-------------|----------------|
| `emulate_network` | Emulate network conditions | `offline?`, `latency?`, `downloadThroughput?`, `uploadThroughput?` |
| `set_cache_disabled` | Enable or disable cache | `cacheDisabled` |
| `set_extra_headers` | Set extra HTTP headers | `headers` |
| `set_stealth_mode` | Enable stealth mode to avoid detection | `enabled` |

### Security

| Command | Description | Key Parameters |
|---------|-------------|----------------|
| `get_security_state` | Get page security/TLS state | — |
| `ignore_certificate_errors` | Ignore certificate errors | `ignore` |

### Service Workers

| Command | Description | Key Parameters |
|---------|-------------|----------------|
| `list_service_workers` | List registered service workers | — |
| `stop_service_worker` | Stop a service worker | `versionId` |
| `bypass_service_worker` | Bypass service worker for network | `bypass` |

### DOM Manipulation

| Command | Description | Key Parameters |
|---------|-------------|----------------|
| `set_outer_html` | Set outerHTML of an element | `selector`, `html` |
| `set_attribute` | Set an attribute on an element | `selector`, `name`, `value` |
| `remove_attribute` | Remove an attribute from an element | `selector`, `name` |
| `remove_node` | Remove an element from the DOM | `selector` |
| `highlight_element` | Visually highlight an element | `selector`, `color?`, `duration?` |

### Performance & Coverage

| Command | Description | Key Parameters |
|---------|-------------|----------------|
| `get_performance_metrics` | Get runtime performance metrics | — |
| `start_css_coverage` | Start CSS coverage collection | — |
| `stop_css_coverage` | Stop and return CSS coverage data | — |
| `start_js_coverage` | Start JS coverage collection | — |
| `stop_js_coverage` | Stop and return JS coverage data | — |
| `get_computed_style` | Get computed styles for an element | `selector`, `properties?` |
| `detect_fonts` | Detect fonts used on the page | `selector?` |
| `force_pseudo_state` | Force CSS pseudo state (hover, focus, etc.) | `selector`, `pseudoClasses` |
| `show_layout_shifts` | Visualize cumulative layout shifts | — |
| `show_paint_rects` | Show paint rectangles | `enabled` |

### Memory & Debugging

| Command | Description | Key Parameters |
|---------|-------------|----------------|
| `get_dom_counters` | Get DOM node/event/document counters | — |
| `force_gc` | Force garbage collection | — |
| `take_heap_snapshot` | Capture a heap snapshot | — |
| `get_targets` | List all debugger targets | — |
| `attach_to_target` | Attach to a specific target | `targetId` |
| `create_browser_context` | Create an isolated browser context | — |

### IndexedDB

| Command | Description | Key Parameters |
|---------|-------------|----------------|
| `get_databases` | List IndexedDB databases | `securityOrigin?` |
| `query_object_store` | Query an IndexedDB object store | `databaseName`, `objectStoreName`, `securityOrigin?`, `limit?` |
| `clear_database` | Clear an IndexedDB database | `databaseName`, `objectStoreName`, `securityOrigin?` |

### Export & PDF

| Command | Description | Key Parameters |
|---------|-------------|----------------|
| `print_to_pdf` | Print page to PDF | `landscape?`, `displayHeaderFooter?`, `scale?`, `paperWidth?`, `paperHeight?` |
| `extract_site` | Full site extraction via Crawlio | `url`, `format?` |

### Crawlio Desktop Bridge

| Command | Description | Key Parameters |
|---------|-------------|----------------|
| `get_crawl_status` | Get Crawlio crawl status | — |
| `get_enrichment` | Get enrichment data for a URL | `url?` |
| `get_crawled_urls` | Get list of crawled URLs | `status?`, `type?`, `limit?`, `offset?` |
| `enrich_url` | Submit enrichment data to Crawlio | `url`, `framework?`, `networkRequests?`, `consoleLogs?`, `domSnapshotJSON?` |

## Desktop Commands (33)

Commands sent via `crawlio.api(method, path, body?)`. Requires Crawlio desktop app running.

| Command | HTTP | Description |
|---------|------|-------------|
| `get_crawl_status` | `GET /status` | Engine state, progress counters |
| `get_crawl_logs` | `GET /logs` | Recent log entries (filterable by category, level) |
| `get_errors` | `GET /logs?level=error` | Error and fault-level logs |
| `get_downloads` | `GET /downloads` | All download items with status |
| `get_failed_urls` | `GET /failed-urls` | Failed downloads with error messages |
| `get_site_tree` | `GET /site-tree` | Downloaded files as directory tree |
| `start_crawl` | `POST /start` | Start a new crawl |
| `stop_crawl` | `POST /stop` | Stop the current crawl |
| `pause_crawl` | `POST /pause` | Pause the current crawl |
| `resume_crawl` | `POST /resume` | Resume a paused crawl |
| `get_settings` | `GET /settings` | Current crawl settings and policy |
| `update_settings` | `PATCH /settings` | Partial merge of settings/policy |
| `list_projects` | `GET /projects` | All saved crawl projects |
| `save_project` | `POST /projects` | Save current project |
| `load_project` | `POST /projects/{id}/load` | Load a saved project |
| `delete_project` | `DELETE /projects/{id}` | Delete a saved project |
| `get_project` | `GET /projects/{id}` | Full project details |
| `export_site` | `POST /export` | Export downloaded site (folder, zip, singleHTML, warc) |
| `get_export_status` | `GET /export/status` | Export state and progress |
| `extract_site_pipeline` | `POST /extract` | Run extraction pipeline |
| `get_extraction_status` | `GET /extract/status` | Extraction state and progress |
| `recrawl_urls` | `POST /recrawl` | Re-crawl specific URLs |
| `get_enrichment_data` | `GET /enrichment` | Browser enrichment data |
| `get_observations` | `GET /observations` | Observation timeline |
| `create_finding` | `POST /finding` | Create curated finding |
| `get_findings` | `GET /findings` | List curated findings |
| `get_crawled_urls_list` | `GET /crawled-urls` | Downloaded URLs with pagination |
| `trigger_capture` | `POST /capture` | WebKit runtime capture |
| `submit_enrichment_bundle` | `POST /enrichment/bundle` | Submit complete enrichment bundle |
| `submit_enrichment_framework` | `POST /enrichment/framework` | Submit framework detection |
| `submit_enrichment_network` | `POST /enrichment/network` | Submit network requests |
| `submit_enrichment_console` | `POST /enrichment/console` | Submit console logs |
| `submit_enrichment_dom` | `POST /enrichment/dom` | Submit DOM snapshot |

## Smart Object Reference

The `smart` object provides auto-waiting wrappers and framework-specific data:

### Core Methods

| Method | Description |
|--------|-------------|
| `smart.evaluate(expr)` | JS evaluation via CDP. Returns `{ result, type }` — access `.result` for the value. Auto-wraps in IIFE if `return` is used. Return objects directly, never `JSON.stringify` inside. |
| `smart.click(selector, opts?)` | Poll + click + 500ms settle. Accepts CSS selectors or snapshot refs (`[ref=e3]`). |
| `smart.type(selector, text, opts?)` | Poll + type + 300ms settle. Accepts CSS selectors or snapshot refs. |
| `smart.navigate(url, opts?)` | Navigate + 1000ms settle |
| `smart.waitFor(selector, timeout?)` | Poll until element is actionable |
| `smart.snapshot()` | Capture accessibility snapshot |
| `smart.rebuild()` | Refresh framework detection cache (forces re-probe on next call) |

> **Note:** There is no `smart.screenshot()` method. For screenshots, use `bridge.send({ type: 'take_screenshot' })` or `smart.scrollCapture()` for multi-section visual evidence.

### Framework Namespaces

| Namespace | Methods |
|-----------|---------|
| `smart.react` | `getVersion`, `getRootCount`, `hasProfiler`, `isHookInstalled` |
| `smart.vue` | `getVersion`, `getAppCount`, `getConfig`, `isDevMode` |
| `smart.angular` | `getVersion`, `isDebugMode`, `isIvy`, `getRootCount`, `getState` |
| `smart.svelte` | `getVersion`, `getMeta`, `isDetected` |
| `smart.nextjs` | `getData`, `getRouter`, `getSSRMode`, `getRouteManifest` |
| `smart.nuxt` | `getData`, `getConfig`, `isSSR` |
| `smart.remix` | `getContext`, `getRouteData` |
| `smart.gatsby` | `getData`, `getPageData` |
| `smart.redux` | `isInstalled`, `getStoreState` |
| `smart.alpine` | `getVersion`, `getStoreKeys`, `getComponentCount` |
| `smart.shopify` | `getShop`, `getCart` |
| `smart.wordpress` | `isWP`, `getRestUrl`, `getPlugins` |
| `smart.laravel` | `getCSRF` |
| `smart.django` | `getCSRF` |
| `smart.drupal` | `getSettings` |
| `smart.jquery` | `getVersion` |

## Links

- Extension install: https://www.crawlio.app/browser-agent
- GitHub: https://github.com/Crawlio-app/crawlio-browser-agent
