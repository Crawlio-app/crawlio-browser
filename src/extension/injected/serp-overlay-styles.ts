// SERP overlay CSS — injected into shadow DOM via CDP Runtime.evaluate
// Self-contained: no external imports, no leaking into host page
// Uses Crawlio design tokens adapted for Google SERP layout

export const SERP_OVERLAY_CSS = `
  :host {
    all: initial;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 13px;
    color: #1a1a2e;
    line-height: 1.4;
  }

  * {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }

  /* --- Per-result badge --- */
  .crawlio-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
    line-height: 18px;
    white-space: nowrap;
    vertical-align: middle;
    cursor: default;
    border: 1px solid rgba(59, 130, 246, 0.2);
    background: rgba(59, 130, 246, 0.08);
    color: #3b82f6;
    margin-left: 6px;
  }

  .crawlio-badge--perf {
    border-color: rgba(34, 197, 94, 0.2);
    background: rgba(34, 197, 94, 0.08);
    color: #16a34a;
  }

  .crawlio-badge--perf-warn {
    border-color: rgba(245, 158, 11, 0.2);
    background: rgba(245, 158, 11, 0.08);
    color: #d97706;
  }

  .crawlio-badge--perf-poor {
    border-color: rgba(239, 68, 68, 0.2);
    background: rgba(239, 68, 68, 0.08);
    color: #dc2626;
  }

  .crawlio-badge .crawlio-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
    flex-shrink: 0;
  }

  /* --- SERP header bar --- */
  .crawlio-serp-header {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 2147483647;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px 16px;
    background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
    color: #e0e0e0;
    font-size: 12px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
    border-bottom: 1px solid rgba(59, 130, 246, 0.3);
  }

  .crawlio-serp-header .crawlio-logo {
    font-weight: 700;
    color: #3b82f6;
    font-size: 13px;
    letter-spacing: 0.5px;
  }

  .crawlio-serp-header .crawlio-query {
    color: #94a3b8;
    max-width: 300px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .crawlio-serp-header .crawlio-status {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .crawlio-serp-header .crawlio-status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #22c55e;
    animation: crawlio-pulse 2s ease-in-out infinite;
  }

  @keyframes crawlio-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }

  .crawlio-serp-header .crawlio-close {
    background: none;
    border: none;
    color: #94a3b8;
    cursor: pointer;
    padding: 2px 6px;
    font-size: 16px;
    line-height: 1;
    border-radius: 3px;
  }

  .crawlio-serp-header .crawlio-close:hover {
    background: rgba(255, 255, 255, 0.1);
    color: #fff;
  }

  /* --- Sidebar panel --- */
  .crawlio-sidebar {
    position: fixed;
    top: 60px;
    right: 12px;
    width: 280px;
    max-height: calc(100vh - 80px);
    overflow-y: auto;
    z-index: 2147483646;
    background: #fff;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
    padding: 12px;
  }

  .crawlio-sidebar h3 {
    font-size: 13px;
    font-weight: 700;
    color: #1a1a2e;
    margin-bottom: 8px;
    padding-bottom: 6px;
    border-bottom: 1px solid #e2e8f0;
  }

  .crawlio-sidebar .crawlio-metric {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 4px 0;
    font-size: 12px;
  }

  .crawlio-sidebar .crawlio-metric-label {
    color: #64748b;
  }

  .crawlio-sidebar .crawlio-metric-value {
    font-weight: 600;
    color: #1a1a2e;
  }

  .crawlio-sidebar .crawlio-section {
    margin-top: 10px;
  }

  .crawlio-sidebar .crawlio-section-title {
    font-size: 11px;
    font-weight: 600;
    color: #94a3b8;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 4px;
  }
`;
