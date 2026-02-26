export type SlugKind = "people" | "states" | "tags";

export interface SlugConfigEntry {
  slug: string;
  name?: string;
  color?: string;
  mail?: string;
  jira?: string;
}

export interface JiraTitleParseResult {
  key: string | null;
  title: string;
}

export interface TaskNode {
  id?: string;
  title?: string;
  rawTitle?: string;
  body?: string;
  state?: string | null;
  estimate?: number | string | null;
  jira?: string | null;
  tags?: string[];
  people?: string[];
  depth?: number;
  lineStart?: number;
  lineEnd?: number;
  parent?: TaskNode | null;
  children?: TaskNode[];
}

export interface ParsedTaskDocument {
  tasks: TaskNode[];
  tags?: Set<string>;
  people?: Set<string>;
  states?: Set<string>;
  invalidStateTags?: Map<number, string[]>;
  lines?: string[];
  allTasks?: TaskNode[];
  config?: any;
  tagMeta?: Map<string, unknown>;
  peopleMeta?: Map<string, unknown>;
  stateMeta?: Map<string, unknown>;
  incomingReferenceCountByName?: Map<string, number>;
  totalStoryPoints?: number;
  [key: string]: unknown;
}

export interface RenderMarkdownOptions {
  disableLinks?: boolean;
  lineIndexes?: number[];
  baseIndent?: number;
}

export type CheckboxToggleHandler = (lineIndex: number) => void;

export type ReorderTaskHandler = (
  taskId: string,
  targetTaskId: string,
  position: "before" | "after",
  options?: { allowRootReparent?: boolean }
) => boolean | void;

export type MoveTaskAsSubtaskHandler = (
  taskId: string,
  parentTaskId: string
) => boolean | void;

declare global {
  interface Window {
    __taskScriptTestHooks?: Record<string, unknown>;
    reportPresence?: (spaceId: string, offline?: boolean) => void;
  }
}
