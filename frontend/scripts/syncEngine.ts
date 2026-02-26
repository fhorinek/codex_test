type SyncEngineOptions = {
  collab: any;
  dom: any;
  remoteBase: string;
  wsBase: string;
  getEditorController: () => any;
  applyAuthFromInputs: (options?: any) => void;
  closeSpacesModal: () => void;
  loadCollabModules: () => Promise<any>;
  stopOfflineDraftTimer: () => void;
  startIdleWatch: () => void;
  stopIdleWatch: () => void;
  setConnectionStatus: (status: string) => void;
  markActivity: () => void;
  publishCollabIdentityAwareness: () => void;
  updateConnectButtonLabel: () => void;
  updateBoardConnectionLabel: () => void;
  startPresenceHeartbeat: (spaceId: any) => void;
  stopPresenceHeartbeat: (spaceId: any) => void;
  authHeaders: (options?: any) => Record<string, string>;
  forceEditorRefresh: (value: string) => void;
  syncEditorState: () => void;
  trackOfflineDraftChange: (value: string) => void;
  fetchImpl?: typeof fetch;
  requestAnimationFrameImpl?: (callback: FrameRequestCallback) => number;
  navigatorRef?: Navigator | null;
};

export function createSyncEngine(options: SyncEngineOptions) {
  const {
    collab,
    dom,
    remoteBase,
    wsBase,
    getEditorController,
    applyAuthFromInputs,
    closeSpacesModal,
    loadCollabModules,
    stopOfflineDraftTimer,
    startIdleWatch,
    stopIdleWatch,
    setConnectionStatus,
    markActivity,
    publishCollabIdentityAwareness,
    updateConnectButtonLabel,
    updateBoardConnectionLabel,
    startPresenceHeartbeat,
    stopPresenceHeartbeat,
    authHeaders,
    forceEditorRefresh,
    syncEditorState,
    trackOfflineDraftChange,
    fetchImpl = fetch,
    requestAnimationFrameImpl,
    navigatorRef = typeof navigator !== "undefined" ? navigator : null,
  } = options;

  function getEditorValueFallback(): string {
    const editorController = getEditorController();
    return editorController?.getValue?.() || dom?.editor?.value || "";
  }

  function disconnectSpace() {
    stopPresenceHeartbeat(collab.spaceId);
    stopIdleWatch();
    const editorController = getEditorController();
    editorController?.setCollabExtensions?.([]);
    if (collab.binding?.destroy) {
      collab.binding.destroy();
    }
    if (collab.provider) {
      collab.provider.destroy();
    }
    if (collab.ydoc) {
      collab.ydoc.destroy();
    }
    if (collab.saveTimer) {
      clearTimeout(collab.saveTimer);
    }
    collab.spaceId = null;
    collab.spacePath = "";
    collab.provider = null;
    collab.ydoc = null;
    collab.ytext = null;
    collab.binding = null;
    collab.bindingMode = null;
    collab.saveTimer = null;
    collab.presenceTimer = null;
    collab.synced = false;
    collab.lastActivityAt = 0;
    collab.connectionStatus = "disconnected";
    trackOfflineDraftChange(getEditorValueFallback());
    updateConnectButtonLabel();
    updateBoardConnectionLabel();
  }

  async function hydrateFromRemote(spaceId: any, ytext: any) {
    try {
      const normalizedPath =
        typeof collab.spacePath === "string" && collab.spacePath.trim()
          ? collab.spacePath.trim()
          : String(spaceId || "");
      const pathQuery = normalizedPath ? `?path=${encodeURIComponent(normalizedPath)}` : "";
      const response = await fetchImpl(`${remoteBase}/api/spaces/${spaceId}${pathQuery}`, {
        headers: authHeaders(),
      });
      if (!response.ok) {
        return;
      }
      const content = await response.text();
      const current = ytext.toString();
      if (!content) {
        if (current) {
          ytext.delete(0, ytext.length);
        }
        if (collab.bindingMode !== "cm6") {
          forceEditorRefresh("");
        }
        return;
      }
      if (!current && content) {
        ytext.insert(0, content);
        if (collab.bindingMode !== "cm6") {
          forceEditorRefresh(content);
        }
        return;
      }
      if (current && current !== content) {
        // Backend persists Yjs room state to the space text file; no client-side
        // REST PUT echo is needed here.
      }
    } catch {
      // Ignore hydration errors.
    }
  }

  function scheduleCollabSync() {
    if (collab.syncScheduled) {
      return;
    }
    collab.syncScheduled = true;
    const raf =
      typeof requestAnimationFrameImpl === "function"
        ? requestAnimationFrameImpl
        : (typeof requestAnimationFrame === "function" ? requestAnimationFrame : null);
    if (!raf) {
      setTimeout(() => {
        collab.syncScheduled = false;
        syncEditorState();
      }, 0);
      return;
    }
    raf(() => {
      collab.syncScheduled = false;
      syncEditorState();
    });
  }

  async function connectToSpace(spaceId: any, spacePath: any = "") {
    const editorController = getEditorController();
    if (!spaceId || !dom?.editor) {
      return;
    }
    const normalizedPath =
      typeof spacePath === "string" && spacePath.trim() ? spacePath.trim() : spaceId;
    applyAuthFromInputs({ markDirty: false });
    closeSpacesModal();
    const { Y, WebsocketProvider, yCollab } = await loadCollabModules();
    if (!yCollab) {
      return;
    }
    disconnectSpace();
    stopOfflineDraftTimer();
    collab.offlineDraftDirty = false;

    const ydoc = new Y.Doc();
    collab.synced = false;
    setConnectionStatus("connecting");
    startIdleWatch();
    const wsParams: Record<string, string> = {};
    if (collab.username && collab.authToken) {
      wsParams["user"] = collab.username;
      wsParams["pass"] = collab.authToken;
    }
    const provider = new WebsocketProvider(wsBase, normalizedPath, ydoc, {
      params: wsParams,
    });
    const ytext = ydoc.getText("content");

    // y-codemirror.next applies Y.Text deltas onto the existing CodeMirror document.
    // Clear the pre-connect local editor content first so remote hydration/sync doesn't
    // prepend/merge with whatever was previously open (sample/offline draft/local space).
    editorController?.setValue("");

    const collabExtension = yCollab(ytext, provider.awareness);
    editorController?.setCollabExtensions?.([collabExtension]);
    const binding = {
      destroy() {
        const currentEditorController = getEditorController();
        currentEditorController?.setCollabExtensions?.([]);
      },
    };
    const bindingMode = "cm6";

    collab.spaceId = spaceId;
    collab.spacePath = normalizedPath;
    collab.provider = provider;
    collab.ydoc = ydoc;
    collab.ytext = ytext;
    collab.binding = binding;
    collab.bindingMode = bindingMode;
    publishCollabIdentityAwareness();
    updateConnectButtonLabel();
    updateBoardConnectionLabel();
    startPresenceHeartbeat(spaceId);

    provider.on("status", ({ status }: any) => {
      const isOnline =
        navigatorRef && typeof navigatorRef.onLine === "boolean"
          ? navigatorRef.onLine
          : true;
      if (!isOnline) {
        setConnectionStatus("offline");
        return;
      }
      if (status === "connected") {
        setConnectionStatus(collab.synced ? "connected" : "syncing");
      } else if (status === "connecting") {
        setConnectionStatus("connecting");
      } else {
        setConnectionStatus("disconnected");
      }
    });

    provider.on("sync", (synced: any) => {
      collab.synced = synced;
      if (synced) {
        markActivity();
        if (!["offline", "auth-failed", "read-only"].includes(collab.connectionStatus)) {
          setConnectionStatus("connected");
        }
      } else if (collab.connectionStatus === "connecting") {
        setConnectionStatus("syncing");
      }
      if (synced) {
        hydrateFromRemote(spaceId, ytext);
      }
    });

    ytext.observe((event: any, transaction: any) => {
      void event;
      void transaction;
      markActivity();
      scheduleCollabSync();
    });
  }

  return {
    connectToSpace,
    disconnectSpace,
    hydrateFromRemote,
    scheduleCollabSync,
  };
}
