// Network sensor reference — CDP event handling pattern
// Actual implementation is in background.ts (chrome.debugger.onEvent listener)
// CDP Flow:
// 1. chrome.debugger.attach(tabId, "1.3")
// 2. Page.enable (must be first per init pattern)
// 3. Network.enable
// 4. Listen for events:
//    - Network.requestWillBeSent → create entry (url, method, startTime, initiator)
//    - Network.responseReceived → update entry (status, mimeType)
//    - Network.loadingFinished → update entry (transferSize, duration)
//    - Network.loadingFailed → mark entry as failed (status: -1)
// 5. Network.disable to stop
// Correlation: entries keyed by requestId (string)
// Timing: durationMs = (loadingFinished.timestamp - requestWillBeSent.timestamp) * 1000

export interface NetworkCaptureState {
  capturing: boolean;
  entries: Map<string, NetworkEntryInternal>;
}

export interface NetworkEntryInternal {
  url: string;
  method: string;
  status: number;
  mimeType: string;
  size: number;
  transferSize: number;
  durationMs: number;
  resourceType: string;
  initiator?: string;
  requestHeaders?: Record<string, string>;
  requestBody?: string;
  requestId?: string;
  _startTime: number;
}
