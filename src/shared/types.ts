// Types shared between MCP server and extension

export interface FrameworkDetection {
  framework: string;
  subtype?: string;
  confidence: "high" | "medium" | "low";
  signals: string[];
  version?: string;
  ssrMode?: string;
  detectionSource?: "static" | "dynamic" | "merged";
}

export interface NetworkEntry {
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
}

export interface ConsoleEntry {
  level: "debug" | "info" | "warning" | "error";
  text: string;
  timestamp: string;
  url?: string;
  lineNumber?: number;
}

export interface DOMNode {
  tag: string;
  attrs?: Record<string, string>;
  text?: string;
  children?: DOMNode[];
}

export interface CookieEntry {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
  size: number;
}

export interface InteractionResult {
  success: boolean;
  action: string;
  selector?: string;
  url?: string;
  title?: string;
  message?: string;
}

export interface AXNode {
  role: string;
  name: string;
  value?: string;
  description?: string;
  children?: AXNode[];
  properties?: Record<string, unknown>;
}

export interface PageCapture {
  url: string;
  title: string;
  framework?: FrameworkDetection;
  networkRequests?: NetworkEntry[];
  consoleLogs?: ConsoleEntry[];
  domSnapshot?: DOMNode;
  cookies?: CookieEntry[];
  screenshotBase64?: string;
  capturedAt: string;
}

// --- Session Recording (MCP agent recording) ---

export interface RecordingInteraction {
  timestamp: string;
  tool: string;
  args: Record<string, unknown>;
  result?: unknown;
  durationMs: number;
  pageUrl: string;
  source?: "user" | "mcp";
}

export interface RecordingPage {
  url: string;
  title?: string;
  enteredAt: string;
  screenshot?: string;
  framework?: FrameworkDetection;
  console: ConsoleEntry[];
  network: NetworkEntry[];
  interactions: RecordingInteraction[];
}

export interface RecordingSession {
  id: string;
  startedAt: string;
  stoppedAt?: string;
  duration: number;
  pages: RecordingPage[];
  metadata: {
    tabId: number;
    initialUrl: string;
    framework?: FrameworkDetection;
    stopReason: "manual" | "max_duration" | "max_interactions" | "tab_closed" | "tab_disconnected";
  };
}

export interface RecordingStatus {
  active: boolean;
  sessionId?: string;
  durationSec?: number;
  pageCount?: number;
  interactionCount?: number;
  currentPageUrl?: string;
}

// --- Canonical RecordingBundle v1 ---

export type RecordingFidelity = "cdpFull" | "cdpPartial" | "wkScript" | "interceptorFlowOnly";
export type RecordingProducer = "chrome" | "headless" | "wkWebView" | "interceptor" | "imported";

export interface RecordingBundleCounts {
  pages: number;
  interactions: number;
  networkEntries: number;
  bodyRecords: number;
  stateEvents: number;
  flows: number;
}

export interface RecordingBundleManifest {
  id: string;
  schemaVersion: "crawlio.recordingBundle.v1";
  targetURL?: string;
  producer: RecordingProducer;
  fidelity: RecordingFidelity;
  startedAt?: string;
  stoppedAt?: string;
  createdAt: string;
  privacy: "local-sensitive" | string;
  bodyPolicy: {
    captureBody: boolean;
    maxBodyBytes?: number;
    truncated: boolean;
  };
  counts: RecordingBundleCounts;
  artifacts: Record<string, string>;
  warnings: string[];
}
