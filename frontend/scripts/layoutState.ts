// @ts-check

/**
 * Module: Responsive layout state persistence and layout configuration helpers.
 */

// Defines the GraphTopHiddenLayoutParams type structure for this module.
type GraphTopHiddenLayoutParams = {
  dom: Record<string, any>;
  defaultKanbanHeight?: number;
  doc?: Document;
};

/**
 * Handles the setGraphHiddenForLeftSnap function logic.
 * Input: leftPercent: number, doc: Document = document.
 * Output: result produced by this function.
 */
export function setGraphHiddenForLeftSnap(leftPercent: number, doc: Document = document) {
  const graphHidden = Number.isFinite(leftPercent) && leftPercent <= 0.01;
  if (graphHidden) {
    doc.documentElement.setAttribute("data-graph-hidden", "true");
  } else {
    doc.documentElement.removeAttribute("data-graph-hidden");
  }
}

/**
 * Handles the setGraphTopHiddenForKanbanHeight function logic.
 * Input: kanbanHeightPx: number, maxHeightPx: number, doc: Document = document.
 * Output: result produced by this function.
 */
export function setGraphTopHiddenForKanbanHeight(
  kanbanHeightPx: number,
  maxHeightPx: number,
  doc: Document = document
) {
  const graphTopHidden =
    Number.isFinite(kanbanHeightPx)
    && Number.isFinite(maxHeightPx)
    && maxHeightPx >= 0
    && (maxHeightPx - kanbanHeightPx) <= 0.5;
  if (graphTopHidden) {
    doc.documentElement.setAttribute("data-graph-top-hidden", "true");
  } else {
    doc.documentElement.removeAttribute("data-graph-top-hidden");
  }
}

/**
 * Handles the updateGraphTopHiddenFromLayout function logic.
 * Input: { dom, defaultKanbanHeight = 180, doc = document, }: GraphTopHiddenLayoutParams.
 * Output: result produced by this function.
 */
export function updateGraphTopHiddenFromLayout({
  dom,
  defaultKanbanHeight = 180,
  doc = document,
}: GraphTopHiddenLayoutParams) {
  const domAny: any = dom;
  const panelRect = (domAny["graphPanel"] || domAny["graphCanvas"])?.getBoundingClientRect?.();
  if (!panelRect) {
    return;
  }
  const dividerHeight = domAny["kanbanDivider"]?.offsetHeight || 0;
  const legendHeight = domAny["legend"]?.getBoundingClientRect?.().height || 0;
  const maxHeight = Math.max(0, panelRect.height - legendHeight - dividerHeight);
  const rawKanbanHeight = getComputedStyle(doc.documentElement)
    .getPropertyValue("--kanban-height")
    .trim();
  const kanbanHeight = Number.parseFloat(rawKanbanHeight);
  setGraphTopHiddenForKanbanHeight(
    Number.isFinite(kanbanHeight) ? kanbanHeight : defaultKanbanHeight,
    maxHeight,
    doc
  );
}
