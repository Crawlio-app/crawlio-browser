// Page-side event monitor used by extension-resident robot training.
//
// The program has no free variables so its source can be injected through CDP. Events cross one
// narrow Runtime binding into the extension service worker, which validates, caps, redacts and
// persists them. The page never owns the authoritative log.

export const RESIDENT_TRAINING_BINDING = "__crawlio_resident_training_event";

interface ResidentPageWindow extends Window {
  __crawlioResidentTrainingUninstall?: () => void;
  [key: string]: unknown;
}

export function residentTrainingPageProgram(bindingName: string, captureStorageValues: boolean): {
  installed: boolean;
  captureStorageValues: boolean;
} {
  const root = window as unknown as ResidentPageWindow;
  root.__crawlioResidentTrainingUninstall?.();

  let installed = true;
  const cap = (value: unknown, max = 2_048): string => String(value ?? "").slice(0, max);
  const sensitiveName = /pass(?:word)?|secret|token|auth|session|cookie|credit|card|cvv|ssn/i;

  const cssEscape = (value: string): string => {
    try {
      if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(value);
    } catch { /* fall through */ }
    return value.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
  };

  const cssResolvesExactly = (selector: string, target: Element): boolean => {
    try {
      const matches = target.ownerDocument.querySelectorAll(selector);
      return matches.length === 1 && matches[0] === target;
    } catch {
      return false;
    }
  };

  const xpathResolvesExactly = (xpath: string, target: Element): boolean => {
    try {
      const result = target.ownerDocument.evaluate(
        xpath,
        target.ownerDocument,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null,
      );
      return result.snapshotLength === 1 && result.snapshotItem(0) === target;
    } catch {
      return false;
    }
  };

  const xpathFor = (target: Element): string | null => {
    const parts: string[] = [];
    let current: Element | null = target;
    while (current && current !== current.ownerDocument.documentElement) {
      const parent: Element | null = current.parentElement;
      if (!parent) break;
      const tag = current.tagName.toLowerCase();
      const siblings = Array.from(parent.children).filter((child) => child.tagName === current?.tagName);
      const position = siblings.indexOf(current) + 1;
      parts.unshift(`${tag}[${Math.max(1, position)}]`);
      current = parent;
    }
    const xpath = `/html/${parts.join("/")}`;
    return xpathResolvesExactly(xpath, target) ? xpath : null;
  };

  const textFor = (target: Element): string | null => {
    const node = target as HTMLElement;
    const text = cap(node.innerText || target.textContent || "", 80).replace(/\s+/g, " ").trim();
    return text || null;
  };

  const roleFor = (target: Element): string | null => {
    const explicit = target.getAttribute("role");
    if (explicit) return explicit;
    const tag = target.tagName.toLowerCase();
    if (tag === "a" && target.hasAttribute("href")) return "link";
    if (tag === "button") return "button";
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "img") return "img";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "input") {
      const type = (target.getAttribute("type") || "text").toLowerCase();
      if (["button", "submit", "reset"].includes(type)) return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      return "textbox";
    }
    return null;
  };

  const selectorBundle = (target: Element | null): Record<string, unknown> | null => {
    if (!target) return null;
    const tag = target.tagName.toLowerCase();
    let attribute: string | null = null;
    for (const name of ["data-testid", "data-test", "data-qa", "data-cy", "id", "name", "aria-label"]) {
      const value = target.getAttribute(name);
      if (!value) continue;
      const escapedValue = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const candidate = name === "id" ? `#${cssEscape(value)}` : `${tag}[${name}="${escapedValue}"]`;
      if (cssResolvesExactly(candidate, target)) {
        attribute = candidate;
        break;
      }
    }

    const stableClasses = Array.from(target.classList).filter((name) => name && !/\d/.test(name)).slice(0, 3);
    const classCandidate = stableClasses.length ? `${tag}.${stableClasses.map(cssEscape).join(".")}` : null;
    const classChain = classCandidate && cssResolvesExactly(classCandidate, target) ? classCandidate : null;
    const xpath = xpathFor(target);
    const textContent = textFor(target);
    const role = roleFor(target);
    const rolePlusText = role && textContent ? `${role}[${textContent}]` : null;
    const primary = attribute
      ? { type: "css", value: attribute, rail: "attribute" }
      : xpath
        ? { type: "xpath", value: xpath, rail: "xpath" }
        : classChain
          ? { type: "css", value: classChain, rail: "classChain" }
          : null;
    return {
      verified: primary !== null,
      selector: primary,
      rails: { xpath, attribute, classChain, textContent, rolePlusText },
    };
  };

  const elementIsSensitive = (target: Element): boolean => {
    const input = target as HTMLInputElement;
    const descriptor = [input.type, input.name, input.id, input.autocomplete, target.getAttribute("aria-label")]
      .filter(Boolean)
      .join(" ");
    return input.type === "password" || sensitiveName.test(descriptor);
  };

  const fieldValue = (target: Element): string | boolean | undefined => {
    if (elementIsSensitive(target)) return "[REDACTED]";
    const field = target as HTMLInputElement;
    if (typeof field.checked === "boolean" && ["checkbox", "radio"].includes(field.type)) return field.checked;
    return "value" in field ? cap(field.value) : undefined;
  };

  const fields = (): Record<string, unknown> => {
    const result: Record<string, unknown> = {};
    for (const target of Array.from(document.querySelectorAll("input, textarea, select")).slice(0, 100)) {
      const bundle = selectorBundle(target);
      const selector = (bundle?.selector as { value?: string } | null)?.value;
      const key = target.id || (target as HTMLInputElement).name || selector;
      if (!key) continue;
      result[cap(key, 256)] = {
        value: fieldValue(target),
        type: cap((target as HTMLInputElement).type || target.tagName.toLowerCase(), 40),
      };
    }
    return result;
  };

  const storageObject = (storage: Storage): Record<string, string | null> => {
    const result: Record<string, string | null> = {};
    try {
      for (const key of Object.keys(storage).slice(0, 200)) {
        result[cap(key, 256)] = captureStorageValues && !sensitiveName.test(key)
          ? cap(storage.getItem(key), 4_096)
          : null;
      }
    } catch { /* storage may be blocked */ }
    return result;
  };

  const describe = (target: EventTarget | null): Record<string, unknown> | null => {
    if (!(target instanceof Element)) return null;
    return {
      bundle: selectorBundle(target),
      tag: target.tagName,
      text: textFor(target),
      value: fieldValue(target),
    };
  };

  const emit = (reason: string, extra: Record<string, unknown> | null): void => {
    if (!installed) return;
    const binding = root[bindingName];
    if (typeof binding !== "function") return;
    try {
      (binding as (payload: string) => void)(JSON.stringify({
        ts: Date.now(),
        reason,
        url: cap(location.href, 4_096),
        title: cap(document.title, 512),
        sessionStorage: storageObject(sessionStorage),
        localStorage: storageObject(localStorage),
        fields: fields(),
        focused: document.activeElement instanceof Element ? selectorBundle(document.activeElement) : null,
        scroll: { x: scrollX, y: scrollY },
        extra,
      }));
    } catch { /* extension may have detached */ }
  };

  const onClick = (event: Event): void => {
    const extra = describe(event.target);
    emit("before-click", extra);
    setTimeout(() => emit("after-click", extra), 200);
  };
  const inputTimers = new WeakMap<Element, ReturnType<typeof setTimeout>>();
  const onInput = (event: Event): void => {
    if (!(event.target instanceof Element)) return;
    const previous = inputTimers.get(event.target);
    if (previous) clearTimeout(previous);
    inputTimers.set(event.target, setTimeout(() => emit("input-change", describe(event.target)), 250));
  };
  const onSubmit = (event: Event): void => {
    const extra = describe(event.target);
    emit("before-submit", extra);
    setTimeout(() => emit("after-submit", extra), 300);
  };
  const onPageShow = (): void => emit("pageshow", null);
  const onPopState = (): void => emit("popstate", null);

  document.addEventListener("click", onClick, true);
  document.addEventListener("input", onInput, true);
  document.addEventListener("submit", onSubmit, true);
  window.addEventListener("pageshow", onPageShow);
  window.addEventListener("popstate", onPopState);
  root.__crawlioResidentTrainingUninstall = () => {
    installed = false;
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("input", onInput, true);
    document.removeEventListener("submit", onSubmit, true);
    window.removeEventListener("pageshow", onPageShow);
    window.removeEventListener("popstate", onPopState);
    delete root.__crawlioResidentTrainingUninstall;
  };
  emit("init", null);
  return { installed: true, captureStorageValues };
}

/** Build a self-contained page program for Runtime.evaluate / addScriptToEvaluateOnNewDocument. */
export function buildResidentTrainingMonitorScript(captureStorageValues: boolean): string {
  return `(${residentTrainingPageProgram.toString()})(${JSON.stringify(RESIDENT_TRAINING_BINDING)}, ${JSON.stringify(captureStorageValues)})`;
}

export const UNINSTALL_RESIDENT_TRAINING_MONITOR_SCRIPT =
  "window.__crawlioResidentTrainingUninstall && window.__crawlioResidentTrainingUninstall()";
