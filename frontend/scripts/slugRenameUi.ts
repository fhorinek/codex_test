// @ts-check

/**
 * Module: UI helpers for rendering and updating slug rename controls.
 */

import type { AppDom } from "./appDom.js";

// Stores the SLUG_RENAME_SWATCH_COLORS module constant.
export const SLUG_RENAME_SWATCH_COLORS = [
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

export function createSlugColorControls(controls: any, doc: Document = document, onChange?: (value: string, commit: boolean) => void) {
    /**
     * @param {string} value
     */
    function updateColorPreview(value: string) {
      if (!controls.slugRenameColorPreview) {
        return;
      }
      const raw = typeof value === "string" ? value.trim() : "";
      const hex = normalizeHexColorValue(raw);
      controls.slugRenameColorPreview.textContent = raw || "Auto";
      controls.slugRenameColorPreview.style.setProperty(
        "--slug-rename-preview-color",
        hex || "transparent"
      );
      controls.slugRenameColorPreview.classList.toggle("has-color", Boolean(hex));
    }

    /**
     * @param {string} value
     */
    function setColorValue(value: string) {
      const raw = typeof value === "string" ? value.trim() : "";
      if (controls.slugRenameColor) {
        controls.slugRenameColor.value = raw;
      }
      const hex = normalizeHexColorValue(raw);
      if (controls.slugRenameColorPicker && hex) {
        controls.slugRenameColorPicker.value = hex;
      }
      if (controls.slugRenameColorSwatches) {
        controls.slugRenameColorSwatches
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

    /**
     * Handles the ensureColorControls function logic.
     * Input: none.
     * Output: result produced by this function.
     */
    function bindControls() {
      if (controls.slugRenameColorSwatches) {
        controls.slugRenameColorSwatches.innerHTML = "";
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
            onChange?.(color, true);
          });
          controls.slugRenameColorSwatches.appendChild(button);
        });
      }
      controls.slugRenameColorPicker?.addEventListener("input", (event: Event) => {
        const target = event.currentTarget as HTMLInputElement | null;
        setColorValue(target?.value || "");
        onChange?.(target?.value || "", false);
      });
      controls.slugRenameColorClear?.addEventListener("click", () => {
        setColorValue("");
        onChange?.("", true);
      });
      setColorValue("");
    }

    return { setColorValue, bindControls };
  }

/**
 * Handles the createSlugRenameUi function logic.
 * Input: dom: AppDom, doc: Document = document.
 * Output: result produced by this function.
 */
export function createSlugRenameUi(dom: AppDom, doc: Document = document) {
  let colorControlsBound = false;
  const domAny: any = dom;

  const color = createSlugColorControls(domAny, doc);
  const background = createSlugColorControls({
    slugRenameColor: domAny.slugRenameBackground,
    slugRenameColorPicker: domAny.slugRenameBackgroundPicker,
    slugRenameColorSwatches: domAny.slugRenameBackgroundSwatches,
    slugRenameColorClear: domAny.slugRenameBackgroundClear,
    slugRenameColorPreview: domAny.slugRenameBackgroundPreview,
  }, doc);
  function ensureColorControls() {
    if (colorControlsBound) return;
    colorControlsBound = true;
    color.bindControls();
    background.bindControls();
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
    domAny.slugRenameBackgroundField?.classList.toggle("hidden", kind !== "tag");
    domAny.slugRenameEmailField?.classList.toggle("hidden", !isPersonKind(kind));
    domAny.slugRenameJiraStateField?.classList.toggle("hidden", !isStateKind(kind));
  }

  return {
    ensureColorControls,
    setColorValue: color.setColorValue,
    setBackgroundValue: background.setColorValue,
    setFieldVisibility,
    configureContext,
  };
}
