// SERP overlay injector — runs inside the page via CDP Runtime.evaluate
// MUST be self-contained: no imports, no closures, no external references
// Uses shadow DOM for CSS isolation — no style leaking into Google's SERP
 
export function injectSerpOverlay(config: {
  widgets: string[];
  query: string;
  css: string;
  data?: Record<string, unknown>;
}): any {
  const ROOT_ID = "crawlio-serp-root";

  // Idempotent — remove existing overlay before re-injecting
  const existing = document.getElementById(ROOT_ID);
  if (existing) existing.remove();

  const host = document.createElement("div");
  host.id = ROOT_ID;
  host.style.cssText = "all: initial !important; position: static !important; display: block !important;";
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: "closed" });

  // Inject CSS
  const style = document.createElement("style");
  style.textContent = config.css;
  shadow.appendChild(style);

  const widgets = config.widgets || [];
  let widgetCount = 0;

  // --- Header bar widget ---
  if (widgets.includes("header")) {
    const header = document.createElement("div");
    header.className = "crawlio-serp-header";

    const logo = document.createElement("span");
    logo.className = "crawlio-logo";
    logo.textContent = "CRAWLIO";
    header.appendChild(logo);

    if (config.query) {
      const queryEl = document.createElement("span");
      queryEl.className = "crawlio-query";
      queryEl.textContent = config.query;
      header.appendChild(queryEl);
    }

    const status = document.createElement("span");
    status.className = "crawlio-status";
    const dot = document.createElement("span");
    dot.className = "crawlio-status-dot";
    status.appendChild(dot);
    const statusText = document.createElement("span");
    statusText.textContent = "Analyzing";
    status.appendChild(statusText);
    header.appendChild(status);

    const closeBtn = document.createElement("button");
    closeBtn.className = "crawlio-close";
    closeBtn.textContent = "\u00D7";
    closeBtn.addEventListener("click", () => {
      const root = document.getElementById(ROOT_ID);
      if (root) root.remove();
    });
    header.appendChild(closeBtn);

    shadow.appendChild(header);
    widgetCount++;
  }

  // Per-hostname enrichment data (shared between initial badge pass and MutationObserver)
  const data = (config.data || {}) as Record<string, { framework?: string; perfScore?: number }>;

  // --- Per-result badge widget ---
  if (widgets.includes("badge")) {

    // Google SERP result selectors
    const resultSelectors = ["div.g", "div[data-sokoban-container]"];
    const results: Element[] = [];
    for (const sel of resultSelectors) {
      const els = document.querySelectorAll(sel);
      for (let i = 0; i < els.length; i++) {
        results.push(els[i]);
      }
    }

    for (const result of results) {
      // Find the link element to extract the URL
      const link = result.querySelector("a[href]") as HTMLAnchorElement | null;
      if (!link) continue;

      let hostname = "";
      try { hostname = new URL(link.href).hostname; } catch { continue; }

      // Find the cite element or header to attach badge
      const cite = result.querySelector("cite");
      const attachTo = cite || link;
      if (!attachTo) continue;

      // Skip if already badged
      if (result.querySelector(".crawlio-result-badge")) continue;

      const badge = document.createElement("span");
      badge.className = "crawlio-badge";

      const dot = document.createElement("span");
      dot.className = "crawlio-dot";
      badge.appendChild(dot);

      // Check if we have data for this hostname
      const siteData = data[hostname];
      if (siteData && siteData.framework) {
        badge.textContent = "";
        badge.appendChild(dot);
        const text = document.createElement("span");
        text.textContent = siteData.framework;
        badge.appendChild(text);
      } else {
        badge.appendChild(dot);
        const text = document.createElement("span");
        text.textContent = hostname.replace(/^www\./, "").split(".")[0];
        badge.appendChild(text);
      }

      // Perf score styling
      if (siteData && typeof siteData.perfScore === "number") {
        const score = siteData.perfScore;
        if (score >= 90) {
          badge.className = "crawlio-badge crawlio-badge--perf";
        } else if (score >= 50) {
          badge.className = "crawlio-badge crawlio-badge--perf-warn";
        } else {
          badge.className = "crawlio-badge crawlio-badge--perf-poor";
        }
        const scoreEl = document.createElement("span");
        scoreEl.textContent = " \u00B7 " + score;
        badge.appendChild(scoreEl);
      }

      // Inject badge into the shadow DOM at result position
      // We need to create an element in the main DOM that references the shadow badge
      // Since shadow DOM isolates styles, we create a minimal host per badge
      const badgeHost = document.createElement("span");
      badgeHost.className = "crawlio-result-badge";
      badgeHost.style.cssText = "all: initial !important; display: inline !important;";
      const badgeShadow = badgeHost.attachShadow({ mode: "closed" });
      const badgeStyle = document.createElement("style");
      badgeStyle.textContent = config.css;
      badgeShadow.appendChild(badgeStyle);
      badgeShadow.appendChild(badge);
      attachTo.appendChild(badgeHost);
      widgetCount++;
    }
  }

  // --- Sidebar panel widget ---
  if (widgets.includes("sidebar")) {
    const sidebar = document.createElement("div");
    sidebar.className = "crawlio-sidebar";

    const title = document.createElement("h3");
    title.textContent = "SERP Analysis";
    sidebar.appendChild(title);

    // Query info
    if (config.query) {
      const section = document.createElement("div");
      section.className = "crawlio-section";
      const sectionTitle = document.createElement("div");
      sectionTitle.className = "crawlio-section-title";
      sectionTitle.textContent = "Query";
      section.appendChild(sectionTitle);

      const metric = document.createElement("div");
      metric.className = "crawlio-metric";
      const label = document.createElement("span");
      label.className = "crawlio-metric-label";
      label.textContent = "Search term";
      const value = document.createElement("span");
      value.className = "crawlio-metric-value";
      value.textContent = config.query;
      metric.appendChild(label);
      metric.appendChild(value);
      section.appendChild(metric);
      sidebar.appendChild(section);
    }

    // Result count
    const resultCount = document.querySelectorAll("div.g").length;
    const statsSection = document.createElement("div");
    statsSection.className = "crawlio-section";
    const statsTitle = document.createElement("div");
    statsTitle.className = "crawlio-section-title";
    statsTitle.textContent = "Stats";
    statsSection.appendChild(statsTitle);

    const countMetric = document.createElement("div");
    countMetric.className = "crawlio-metric";
    const countLabel = document.createElement("span");
    countLabel.className = "crawlio-metric-label";
    countLabel.textContent = "Organic results";
    const countValue = document.createElement("span");
    countValue.className = "crawlio-metric-value";
    countValue.textContent = String(resultCount);
    countMetric.appendChild(countLabel);
    countMetric.appendChild(countValue);
    statsSection.appendChild(countMetric);

    // PAA (People Also Ask) count
    const paaCount = document.querySelectorAll(".related-question-pair").length;
    if (paaCount > 0) {
      const paaMetric = document.createElement("div");
      paaMetric.className = "crawlio-metric";
      const paaLabel = document.createElement("span");
      paaLabel.className = "crawlio-metric-label";
      paaLabel.textContent = "People Also Ask";
      const paaValue = document.createElement("span");
      paaValue.className = "crawlio-metric-value";
      paaValue.textContent = String(paaCount);
      paaMetric.appendChild(paaLabel);
      paaMetric.appendChild(paaValue);
      statsSection.appendChild(paaMetric);
    }

    sidebar.appendChild(statsSection);

    // Custom data metrics
    const data = config.data || {};
    const dataKeys = Object.keys(data);
    if (dataKeys.length > 0) {
      const dataSection = document.createElement("div");
      dataSection.className = "crawlio-section";
      const dataTitle = document.createElement("div");
      dataTitle.className = "crawlio-section-title";
      dataTitle.textContent = "Data";
      dataSection.appendChild(dataTitle);

      for (const key of dataKeys.slice(0, 10)) {
        const val = data[key];
        if (val === null || val === undefined || typeof val === "object") continue;
        const m = document.createElement("div");
        m.className = "crawlio-metric";
        const l = document.createElement("span");
        l.className = "crawlio-metric-label";
        l.textContent = key;
        const v = document.createElement("span");
        v.className = "crawlio-metric-value";
        v.textContent = String(val);
        m.appendChild(l);
        m.appendChild(v);
        dataSection.appendChild(m);
      }
      sidebar.appendChild(dataSection);
    }

    shadow.appendChild(sidebar);
    widgetCount++;
  }

  // --- MutationObserver for dynamic SERP loading ---
  if (widgets.includes("badge")) {
    const searchContainer = document.getElementById("search") || document.getElementById("rso");
    if (searchContainer) {
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (let i = 0; i < mutation.addedNodes.length; i++) {
            const node = mutation.addedNodes[i];
            if (!(node instanceof HTMLElement)) continue;
            // Check if the added node contains new search results
            const newResults = node.querySelectorAll ? node.querySelectorAll("div.g, div[data-sokoban-container]") : [];
            for (let j = 0; j < newResults.length; j++) {
              const result = newResults[j];
              if (result.querySelector(".crawlio-result-badge")) continue;
              const link = result.querySelector("a[href]") as HTMLAnchorElement | null;
              if (!link) continue;
              let hostname = "";
              try { hostname = new URL(link.href).hostname; } catch { continue; }
              const cite = result.querySelector("cite");
              const attachTo = cite || link;
              if (!attachTo) continue;

              const badgeHost = document.createElement("span");
              badgeHost.className = "crawlio-result-badge";
              badgeHost.style.cssText = "all: initial !important; display: inline !important;";
              const badgeShadow = badgeHost.attachShadow({ mode: "closed" });
              const badgeStyle = document.createElement("style");
              badgeStyle.textContent = config.css;
              badgeShadow.appendChild(badgeStyle);

              const badge = document.createElement("span");
              badge.className = "crawlio-badge";
              const dot = document.createElement("span");
              dot.className = "crawlio-dot";
              badge.appendChild(dot);

              // Use enrichment data if available (same logic as initial badge pass)
              const siteData = data[hostname] as { framework?: string; perfScore?: number } | undefined;
              const text = document.createElement("span");
              if (siteData && siteData.framework) {
                text.textContent = siteData.framework;
              } else {
                text.textContent = hostname.replace(/^www\./, "").split(".")[0];
              }
              badge.appendChild(text);

              if (siteData && typeof siteData.perfScore === "number") {
                const score = siteData.perfScore;
                if (score >= 90) {
                  badge.className = "crawlio-badge crawlio-badge--perf";
                } else if (score >= 50) {
                  badge.className = "crawlio-badge crawlio-badge--perf-warn";
                } else {
                  badge.className = "crawlio-badge crawlio-badge--perf-poor";
                }
                const scoreEl = document.createElement("span");
                scoreEl.textContent = " \u00B7 " + score;
                badge.appendChild(scoreEl);
              }

              badgeShadow.appendChild(badge);
              attachTo.appendChild(badgeHost);
            }
          }
        }
      });
      observer.observe(searchContainer, { childList: true, subtree: true });

      // Store observer reference for cleanup
      (host as any).__crawlioObserver = observer;
    }
  }

  return { injected: true, widgetCount, query: config.query || "" };
}

// Cleanup function — removes SERP overlay and disconnects MutationObserver
 
export function removeSerpOverlay(): any {
  const ROOT_ID = "crawlio-serp-root";
  const host = document.getElementById(ROOT_ID);
  if (!host) return { cleared: false, reason: "no overlay found" };

  // Disconnect MutationObserver if active
  const observer = (host as any).__crawlioObserver;
  if (observer) observer.disconnect();

  host.remove();

  // Also remove per-result badge hosts
  const badges = document.querySelectorAll(".crawlio-result-badge");
  for (let i = 0; i < badges.length; i++) {
    badges[i].remove();
  }

  return { cleared: true };
}
