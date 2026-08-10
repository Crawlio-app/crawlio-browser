// Popup — status + Connect/Disconnect control. Optional grants belong exclusively to welcome.html.
import { declaredOptionalPermissions, missingPermissions, isComplete } from "../shared/permissions";

(async () => {
  const waitingCard = document.getElementById("waiting-card") as HTMLElement;
  const reconnectBtn = document.getElementById("reconnect-btn") as HTMLButtonElement;
  const disconnectBtn = document.getElementById("disconnect-btn") as HTMLButtonElement;
  const setupBtn = document.getElementById("setup-btn") as HTMLButtonElement;
  const statusLabel = document.getElementById("status-label") as HTMLElement | null;
  const statusDot = document.querySelector(".status-dot") as HTMLElement | null;
  const accessStatus = document.getElementById("access-status") as HTMLElement;

  // --- State helpers ---

  const statusRow = document.querySelector(".status-row") as HTMLElement | null;

  function updateUI(connected: boolean) {
    waitingCard.style.display = connected ? "none" : "flex";
    reconnectBtn.style.display = connected ? "none" : "inline-block";
    disconnectBtn.style.display = connected ? "block" : "none";
    if (statusRow) {
      statusRow.style.display = "flex";
    }
    if (statusDot) {
      statusDot.classList.toggle("connected", connected);
    }
    if (statusLabel) {
      statusLabel.classList.toggle("connected", connected);
      statusLabel.textContent = connected ? "MCP connected" : "MCP disconnected";
    }
  }

  function renderAccessStatus(onboardingComplete: boolean, missing: chrome.permissions.Permissions) {
    const missingCount = (missing.permissions?.length ?? 0) + (missing.origins?.length ?? 0);
    const ready = onboardingComplete && missingCount === 0;
    accessStatus.classList.toggle("ready", ready);
    accessStatus.classList.toggle("needs-onboarding", !ready);
    accessStatus.textContent = ready
      ? "Ready"
      : missingCount > 0
        ? `${missingCount} grant${missingCount === 1 ? "" : "s"} missing`
        : "Onboarding incomplete";
    setupBtn.textContent = onboardingComplete
      ? "Review permissions in onboarding"
      : "Complete onboarding";
    setupBtn.style.display = ready ? "none" : "block";
  }

  async function refreshAccessStatus() {
    try {
      const [local, missing] = await Promise.all([
        chrome.storage.local.get("crawlio:onboardingComplete"),
        missingPermissions(declaredOptionalPermissions()),
      ]);
      renderAccessStatus(local["crawlio:onboardingComplete"] === true, missing);
    } catch (error: unknown) {
      // A status read failure must never hide the recovery route. The onboarding page remains the
      // only place that can request optional access; the popup only links to it.
      console.error("[Popup] Could not read browser access status:", error);
      accessStatus.classList.remove("ready");
      accessStatus.classList.add("needs-onboarding");
      accessStatus.textContent = "Status unavailable";
      setupBtn.textContent = "Review permissions in onboarding";
      setupBtn.style.display = "block";
    }
  }

  function openOnboarding() {
    chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") }).catch((error: unknown) => {
      console.error("[Popup] Could not open onboarding:", error);
    });
    window.close();
  }

  // --- Reconnect ---

  reconnectBtn.addEventListener("click", async () => {
    reconnectBtn.textContent = "Connecting...";
    reconnectBtn.disabled = true;

    // A revoked or newly declared permission is recovered on the dedicated onboarding page. The
    // popup never invokes chrome.permissions.request(), including from an explicit reconnect.
    const missing = await missingPermissions(declaredOptionalPermissions());
    if (!isComplete(missing)) {
      reconnectBtn.textContent = "Reconnect";
      reconnectBtn.disabled = false;
      openOnboarding();
      return;
    }

    chrome.runtime.sendMessage({ type: "START_BRIDGE" });

    const connected = await new Promise<boolean>((resolve) => {
      let settled = false;
      const listener = (changes: Record<string, chrome.storage.StorageChange>) => {
        if (changes["crawlio:bridgeConnected"] && !settled) {
          settled = true;
          chrome.storage.session.onChanged.removeListener(listener);
          resolve(changes["crawlio:bridgeConnected"].newValue === true);
        }
      };
      chrome.storage.session.onChanged.addListener(listener);
      setTimeout(async () => {
        if (!settled) {
          settled = true;
          chrome.storage.session.onChanged.removeListener(listener);
          const d = await chrome.storage.session.get("crawlio:bridgeConnected");
          resolve(d["crawlio:bridgeConnected"] === true);
        }
      }, 8000);
    });

    updateUI(connected);
    reconnectBtn.textContent = "Reconnect";
    reconnectBtn.disabled = false;
  });

  // --- Disconnect ---

  disconnectBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "STOP_BRIDGE" });
    updateUI(false);
  });

  // --- Live status updates ---

  let updateTimer: ReturnType<typeof setTimeout> | null = null;
  chrome.storage.session.onChanged.addListener((changes) => {
    if (changes["crawlio:bridgeConnected"]) {
      if (reconnectBtn.disabled) return;
      chrome.storage.session.get("crawlio:bridgeConnected").then((data) => {
        const connected = data["crawlio:bridgeConnected"] === true;
        if (updateTimer) clearTimeout(updateTimer);
        if (connected) {
          updateUI(true);
        } else {
          updateTimer = setTimeout(() => updateUI(false), 800);
        }
      });
    }
  });

  // --- Welcome.html onboarding link ---

  setupBtn.addEventListener("click", openOnboarding);

  chrome.permissions.onAdded.addListener(() => { void refreshAccessStatus(); });
  chrome.permissions.onRemoved.addListener(() => { void refreshAccessStatus(); });

  // --- Initial render ---

  try {
    const data = await chrome.storage.session.get("crawlio:bridgeConnected");
    updateUI(data["crawlio:bridgeConnected"] === true);
  } catch {
    updateUI(false);
  }

  // The popup only reports onboarding state. Permission acquisition is owned by welcome.html.
  await refreshAccessStatus();
})();
