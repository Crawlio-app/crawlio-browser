// Welcome page — Grant browser access, then hand off to hosted onboarding
const ONBOARDING_URL = "https://crawlio.app/browser-agent/activate";

(async () => {
  const connectBtn = document.getElementById("connect-btn") as HTMLButtonElement;
  const modalOverlay = document.getElementById("modal-overlay") as HTMLElement;
  const authorizeBtn = document.getElementById("authorize-btn") as HTMLButtonElement;
  const cancelBtn = document.getElementById("cancel-btn") as HTMLButtonElement;
  const stepGrant = document.getElementById("step-grant") as HTMLElement;

  // Show trust modal
  connectBtn.addEventListener("click", () => {
    modalOverlay.classList.add("visible");
  });

  // Cancel: dismiss modal
  cancelBtn.addEventListener("click", () => {
    modalOverlay.classList.remove("visible");
  });

  // Close modal on overlay click
  modalOverlay.addEventListener("click", (e) => {
    if (e.target === modalOverlay) {
      modalOverlay.classList.remove("visible");
    }
  });

  // Authorize → mark complete → redirect to hosted onboarding
  authorizeBtn.addEventListener("click", async () => {
    const granted = await chrome.permissions.request({
      permissions: ["tabs"],
      origins: ["http://127.0.0.1/*"],
    });
    if (granted) {
      // Animate step 2 as done
      stepGrant.classList.remove("current");
      stepGrant.classList.add("done");
      const dot = stepGrant.querySelector(".step-dot") as HTMLElement;
      if (dot) {
        dot.textContent = "";
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("width", "12");
        svg.setAttribute("height", "12");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("fill", "none");
        svg.setAttribute("stroke", "currentColor");
        svg.setAttribute("stroke-width", "3");
        svg.setAttribute("stroke-linecap", "round");
        svg.setAttribute("stroke-linejoin", "round");
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", "M20 6 9 17l-5-5");
        svg.appendChild(path);
        dot.appendChild(svg);
      }

      await chrome.storage.local.set({ "crawlio:onboardingComplete": true });
      chrome.runtime.sendMessage({ type: "PERMISSIONS_GRANTED" });
      window.location.href = `${ONBOARDING_URL}?from=extension`;
    }
  });

  // If already onboarded, redirect straight to hosted page
  const data = await chrome.storage.local.get("crawlio:onboardingComplete");
  if (data["crawlio:onboardingComplete"]) {
    window.location.href = ONBOARDING_URL;
  }
})();
