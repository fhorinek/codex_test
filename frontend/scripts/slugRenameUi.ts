// @ts-check

import type { AppDom } from "./appDom.js";

const SLUG_RENAME_SWATCH_COLORS = [
  "#e85d75",
  "#f28a2e",
  "#d6b100",
  "#5ea63a",
  "#0fa58a",
  "#1d8fe1",
  "#5d6bff",
  "#b24be0",
];

/**
 * @param {string} kind
 * @returns {boolean}
 */
function isPersonKind(kind: string) {
  return kind === "person";
}

/**
 * @param {string} kind
 * @returns {boolean}
 */
function isStateKind(kind: string) {
  return kind === "state";
}

/**
 * @param {string} value
 * @returns {string}
 */
export function normalizeHexColorValue(value: string) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    return "";
  }
  const hex = raw.startsWith("#") ? raw : `#${raw}`;
  if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
    return hex.toLowerCase();
  }
  const shortMatch = hex.match(/^#([0-9a-fA-F]{3})$/);
  if (!shortMatch) {
    return "";
  }
  const [r, g, b] = (shortMatch[1] || "").split("");
  return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
}

export function createSlugRenameUi(dom: AppDom, doc: Document = document) {
  let colorControlsBound = false;
  const domAny: any = dom;

  /**
   * @param {string} value
   */
  function updateColorPreview(value: string) {
    if (!domAny.slugRenameColorPreview) {
      return;
    }
    const raw = typeof value === "string" ? value.trim() : "";
    const hex = normalizeHexColorValue(raw);
    domAny.slugRenameColorPreview.textContent = raw || "Auto";
    domAny.slugRenameColorPreview.style.setProperty(
      "--slug-rename-preview-color",
      hex || "transparent"
    );
    domAny.slugRenameColorPreview.classList.toggle("has-color", Boolean(hex));
  }

  /**
   * @param {string} value
   */
  function setColorValue(value: string) {
    const raw = typeof value === "string" ? value.trim() : "";
    if (domAny.slugRenameColor) {
      domAny.slugRenameColor.value = raw;
    }
    const hex = normalizeHexColorValue(raw);
    if (domAny.slugRenameColorPicker && hex) {
      domAny.slugRenameColorPicker.value = hex;
    }
    if (domAny.slugRenameColorSwatches) {
      domAny.slugRenameColorSwatches
        .querySelectorAll("button[data-color]")
        .forEach((buttonNode: Element) => {
          const button = buttonNode as HTMLButtonElement;
          const swatchColor = normalizeHexColorValue(button.dataset["color"] || "");
          const active = Boolean(hex) && swatchColor === hex;
          button.classList.toggle("active", active);
          button.setAttribute("aria-pressed", active ? "true" : "false");
        });
    }
    updateColorPreview(raw);
  }

  function ensureColorControls() {
    if (colorControlsBound) {
      return;
    }
    colorControlsBound = true;
    if (domAny.slugRenameColorSwatches) {
      domAny.slugRenameColorSwatches.innerHTML = "";
      SLUG_RENAME_SWATCH_COLORS.forEach((color, index) => {
        const button = doc.createElement("button");
        button.type = "button";
        button.className = "slug-color-swatch";
        button.dataset["color"] = color;
        button.style.setProperty("--swatch-color", color);
        button.setAttribute("aria-label", `Color ${index + 1}`);
        button.setAttribute("aria-pressed", "false");
        button.addEventListener("click", () => {
          setColorValue(color);
        });
        domAny.slugRenameColorSwatches.appendChild(button);
      });
    }
    domAny.slugRenameColorPicker?.addEventListener("input", (event: Event) => {
      const target = event.currentTarget as HTMLInputElement | null;
      setColorValue(target?.value || "");
    });
    domAny.slugRenameColorClear?.addEventListener("click", () => {
      setColorValue("");
    });
    setColorValue("");
  }

  /**
   * @param {string} kind
   */
  function configureContext(kind: string) {
    if (domAny.slugRenameDisplayNameLabel) {
      domAny.slugRenameDisplayNameLabel.textContent = "Display name";
    }
    if (domAny.slugRenameDisplayName) {
      domAny.slugRenameDisplayName.placeholder = "";
      domAny.slugRenameDisplayName.autocomplete = isPersonKind(kind) ? "name" : "off";
    }

    if (domAny.slugRenameEmailLabel) {
      domAny.slugRenameEmailLabel.textContent = "Email";
    }
    if (domAny.slugRenameEmail) {
      domAny.slugRenameEmail.placeholder = "";
      domAny.slugRenameEmail.autocomplete = "email";
    }

    if (domAny.slugRenameJiraStateLabel) {
      domAny.slugRenameJiraStateLabel.textContent = "Jira state";
    }
    if (domAny.slugRenameJiraState) {
      domAny.slugRenameJiraState.placeholder = "";
      domAny.slugRenameJiraState.autocomplete = "off";
    }
  }

  /**
   * @param {string} kind
   */
  function setFieldVisibility(kind: string) {
    domAny.slugRenameDisplayNameField?.classList.remove("hidden");
    domAny.slugRenameColorField?.classList.remove("hidden");
    domAny.slugRenameEmailField?.classList.toggle("hidden", !isPersonKind(kind));
    domAny.slugRenameJiraStateField?.classList.toggle("hidden", !isStateKind(kind));
  }

  return {
    ensureColorControls,
    setColorValue,
    setFieldVisibility,
    configureContext,
  };
}
