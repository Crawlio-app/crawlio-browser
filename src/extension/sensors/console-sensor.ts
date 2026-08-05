// Console sensor reference — CDP Runtime.consoleAPICalled handling
// Actual implementation is in background.ts (chrome.debugger.onEvent listener)
// CDP Flow:
// 1. Runtime.enable (after Page.enable, Network.enable)
// 2. Listen for Runtime.consoleAPICalled events
// 3. Extract: type (log/warn/error/info/debug), args, timestamp, stackTrace
// 4. Map args to text: arg.value ?? arg.description ?? ""
// 5. Get source location from stackTrace.callFrames[0]

export interface ConsoleEntryInternal {
  level: string;
  text: string;
  timestamp: string;
  url?: string;
  lineNumber?: number;
}
