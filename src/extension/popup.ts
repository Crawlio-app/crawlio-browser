// Popup — status + permission broker + Connect/Disconnect control

/** Chrome permission → human-readable label */
const PERM_LABELS: Record<string, string> = {
  tabs: "See your open tabs",
  activeTab: "Interact with the current page",
  "http://127.0.0.1/*": "Connect locally",
  nativeMessaging: "Block rogue local servers (verify the MCP server's identity)",
  clipboardRead: "Read clipboard content",
  clipboardWrite: "Copy to clipboard",
  notifications: "Send notifications",
};

(async () => {
  const waitingCard = document.getElementById("waiting-card") as HTMLElement;
  const reconnectBtn = document.getElementById("reconnect-btn") as HTMLButtonElement;
  const disconnectBtn = document.getElementById("disconnect-btn") as HTMLButtonElement;
  const setupCard = document.getElementById("setup-card") as HTMLElement;
  const setupPerms = document.getElementById("setup-perms") as HTMLElement;
  const enableBtn = document.getElementById("enable-btn") as HTMLButtonElement;
  const setupBtn = document.getElementById("setup-btn") as HTMLButtonElement;
  const statusLabel = document.getElementById("status-label") as HTMLElement | null;
  const statusDot = document.querySelector(".status-dot") as HTMLElement | null;

  // --- State helpers ---

  const statusRow = document.querySelector(".status-row") as HTMLElement | null;

  function updateUI(connected: boolean) {
    waitingCard.style.display = connected ? "none" : "flex";
    reconnectBtn.style.display = connected ? "none" : "inline-block";
    disconnectBtn.style.display = connected ? "block" : "none";
    if (statusRow) {
      statusRow.style.display = connected ? "flex" : "none";
    }
    if (statusDot) {
      statusDot.classList.toggle("connected", connected);
    }
    if (statusLabel) {
      statusLabel.classList.toggle("connected", connected);
      statusLabel.textContent = "Connected";
    }
  }

  function showSetupCard(pending: chrome.permissions.Permissions) {
    const items: string[] = [];
    for (const p of pending.permissions || []) {
      items.push(PERM_LABELS[p] || p);
    }
    for (const o of pending.origins || []) {
      items.push(PERM_LABELS[o] || o);
    }
    if (items.length === 0) {
      setupCard.style.display = "none";
      return;
    }
    setupPerms.innerHTML = "";
    for (const label of items) {
      const li = document.createElement("li");
      li.textContent = label;
      setupPerms.appendChild(li);
    }
    setupCard.style.display = "block";
  }

  function hideSetupCard() {
    setupCard.style.display = "none";
  }

  // --- Permission broker ---

  async function tryAutoGrant(): Promise<boolean> {
    try {
      const data = await chrome.storage.session.get("crawlio:pendingPermissions");
      const pending = data["crawlio:pendingPermissions"] as chrome.permissions.Permissions | undefined;
      if (!pending || (!pending.permissions?.length && !pending.origins?.length)) {
        hideSetupCard();
        return true;
      }

      // Attempt silent grant (popup open = user gesture)
      const granted = await chrome.permissions.request({
        permissions: pending.permissions || [],
        origins: pending.origins || [],
      });

      if (granted) {
        chrome.action.setBadgeText({ text: "" });
        chrome.storage.session.remove("crawlio:pendingPermissions");
        chrome.runtime.sendMessage({ type: "PERMISSIONS_GRANTED" });
        hideSetupCard();
        return true;
      }
    } catch {
      // permissions.request may throw if popup closes during request
    }

    // Silent grant failed or user denied — show the setup card
    const data = await chrome.storage.session.get("crawlio:pendingPermissions");
    const pending = data["crawlio:pendingPermissions"] as chrome.permissions.Permissions | undefined;
    if (pending) {
      showSetupCard(pending);
    }
    return false;
  }

  // "Enable Crawlio" button — explicit user grant
  enableBtn.addEventListener("click", async () => {
    const data = await chrome.storage.session.get("crawlio:pendingPermissions");
    const pending = data["crawlio:pendingPermissions"] as chrome.permissions.Permissions | undefined;
    if (!pending) {
      hideSetupCard();
      return;
    }

    try {
      const granted = await chrome.permissions.request({
        permissions: pending.permissions || [],
        origins: pending.origins || [],
      });
      if (granted) {
        chrome.action.setBadgeText({ text: "" });
        chrome.storage.session.remove("crawlio:pendingPermissions");
        chrome.runtime.sendMessage({ type: "PERMISSIONS_GRANTED" });
        hideSetupCard();
      }
    } catch {
      // popup may close during request
    }
  });

  // --- Reconnect ---

  reconnectBtn.addEventListener("click", async () => {
    reconnectBtn.textContent = "Connecting...";
    reconnectBtn.disabled = true;

    const hasPerms = await chrome.permissions.contains({
      permissions: ["tabs"],
      origins: ["http://127.0.0.1/*"],
    });

    if (!hasPerms) {
      const granted = await chrome.permissions.request({
        permissions: ["tabs"],
        origins: ["http://127.0.0.1/*"],
      });
      if (!granted) {
        reconnectBtn.textContent = "Reconnect";
        reconnectBtn.disabled = false;
        return;
      }
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
    // Re-check pending permissions when they change
    if (changes["crawlio:pendingPermissions"]) {
      const val = changes["crawlio:pendingPermissions"].newValue;
      if (val && (val.permissions?.length || val.origins?.length)) {
        showSetupCard(val);
      } else {
        hideSetupCard();
      }
    }
  });

  // --- Welcome.html onboarding link ---

  setupBtn.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
    window.close();
  });

  // --- Initial render ---

  try {
    const data = await chrome.storage.session.get("crawlio:bridgeConnected");
    updateUI(data["crawlio:bridgeConnected"] === true);
  } catch {
    updateUI(false);
  }

  // Priority: welcome.html onboarding first, then permission broker fallback
  const local = await chrome.storage.local.get("crawlio:onboardingComplete");
  if (!local["crawlio:onboardingComplete"]) {
    // Onboarding not done — show "Complete setup" link to welcome.html
    setupBtn.style.display = "block";
  } else {
    // Onboarding done — check if permissions need re-granting (fallback)
    await tryAutoGrant();
  }
})();
