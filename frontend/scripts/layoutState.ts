// @ts-check

type GraphTopHiddenLayoutParams = {
  dom: Record<string, any>;
  defaultKanbanHeight?: number;
  doc?: Document;
};

export function setGraphHiddenForLeftSnap(leftPercent: number, doc: Document = document) {
  const graphHidden = Number.isFinite(leftPercent) && leftPercent <= 0.01;
  if (graphHidden) {
    doc.documentElement.setAttribute("data-graph-hidden", "true");
  } else {
    doc.documentElement.removeAttribute("data-graph-hidden");
  }
}

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
