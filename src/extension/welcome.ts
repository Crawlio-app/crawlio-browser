// Welcome page — the only surface allowed to request optional Chrome permissions.
import {
  declaredOptionalPermissions,
  isComplete,
  missingPermissions,
} from "../shared/permissions";
import { describePermissions } from "../shared/permission-labels";

const ONBOARDING_URL = "https://crawlio.app/browser-agent/activate";

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing onboarding element #${id}`);
  return element as T;
}

(async () => {
  const connectBtn = requiredElement<HTMLButtonElement>("connect-btn");
  const modalOverlay = requiredElement<HTMLElement>("modal-overlay");
  const authorizeBtn = requiredElement<HTMLButtonElement>("authorize-btn");
  const cancelBtn = requiredElement<HTMLButtonElement>("cancel-btn");
  const stepGrant = requiredElement<HTMLElement>("step-grant");
  const permissionList = requiredElement<HTMLUListElement>("permission-list");
  const permissionStatus = requiredElement<HTMLElement>("permission-status");
  const declared = declaredOptionalPermissions();
  let outstanding = await missingPermissions(declared);

  for (const label of describePermissions(declared)) {
    const item = document.createElement("li");
    item.textContent = label;
    permissionList.appendChild(item);
  }

  const markGrantComplete = () => {
    stepGrant.classList.remove("current");
    stepGrant.classList.add("done");
    const dot = stepGrant.querySelector(".step-dot");
    if (!(dot instanceof HTMLElement)) return;
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
  };

  const finishOnboarding = async () => {
    markGrantComplete();
    await chrome.storage.local.set({ "crawlio:onboardingComplete": true });
    chrome.runtime.sendMessage({ type: "PERMISSIONS_GRANTED" });
    window.location.href = `${ONBOARDING_URL}?from=extension`;
  };

  connectBtn.addEventListener("click", () => {
    permissionStatus.textContent = "";
    modalOverlay.classList.add("visible");
  });

  cancelBtn.addEventListener("click", () => {
    modalOverlay.classList.remove("visible");
  });

  modalOverlay.addEventListener("click", (event) => {
    if (event.target === modalOverlay) modalOverlay.classList.remove("visible");
  });

  // The request is the first asynchronous call in this click handler so Chrome retains the user
  // gesture. No popup/widget or background command calls permissions.request().
  authorizeBtn.addEventListener("click", async () => {
    authorizeBtn.disabled = true;
    permissionStatus.textContent = "";
    try {
      const granted = isComplete(outstanding)
        ? true
        : await chrome.permissions.request(outstanding);
      outstanding = await missingPermissions(declared);
      if (granted && isComplete(outstanding)) {
        await finishOnboarding();
        return;
      }
      permissionStatus.textContent = "Access was not granted. Review Chrome’s prompt and try again.";
    } catch (error) {
      permissionStatus.textContent = error instanceof Error
        ? `Chrome could not complete the request: ${error.message}`
        : "Chrome could not complete the permission request.";
    } finally {
      authorizeBtn.disabled = false;
    }
  });

  // A revoked or newly declared optional capability makes onboarding incomplete again. This lets
  // updates recover on the same dedicated page instead of falling back to a popup prompt.
  const local = await chrome.storage.local.get("crawlio:onboardingComplete");
  if (local["crawlio:onboardingComplete"] && isComplete(outstanding)) {
    window.location.href = ONBOARDING_URL;
  }
})();
