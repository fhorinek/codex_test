/**
 * Module: Synchronization engine for remote state, connection lifecycle, and retries.
 */

// Defines the SyncEngineOptions type structure for this module.
type SyncEngineOptions = {
  collab: any;
  dom: any;
  remoteBase: string;
  wsBase: string;
  /**
   * Handles the getEditorController function logic.
   * Input: none.
   * Output: result produced by this function.
   */
  getEditorController: () => any;
  /**
   * Handles the applyAuthFromInputs function logic.
   * Input: options?: any.
   * Output: result produced by this function.
   */
  applyAuthFromInputs: (options?: any) => void;
  /**
   * Handles the closeSpacesModal function logic.
   * Input: none.
   * Output: result produced by this function.
   */
  closeSpacesModal: () => void;
  /**
   * Handles the loadCollabModules function logic.
   * Input: none.
   * Output: result produced by this function.
   */
  loadCollabModules: () => Promise<any>;
  /**
   * Handles the stopOfflineDraftTimer function logic.
   * Input: none.
   * Output: result produced by this function.
   */
  stopOfflineDraftTimer: () => void;
  /**
   * Handles the startIdleWatch function logic.
   * Input: none.
   * Output: result produced by this function.
   */
  startIdleWatch: () => void;
  /**
   * Handles the stopIdleWatch function logic.
   * Input: none.
   * Output: result produced by this function.
   */
  stopIdleWatch: () => void;
  /**
   * Handles the setConnectionStatus function logic.
   * Input: status: string.
   * Output: result produced by this function.
   */
  setConnectionStatus: (status: string) => void;
  /**
   * Handles the markActivity function logic.
   * Input: none.
   * Output: result produced by this function.
   */
  markActivity: () => void;
  /**
   * Handles the publishCollabIdentityAwareness function logic.
   * Input: none.
   * Output: result produced by this function.
   */
  publishCollabIdentityAwareness: () => void;
  /**
   * Handles the updateConnectButtonLabel function logic.
   * Input: none.
   * Output: result produced by this function.
   */
  updateConnectButtonLabel: () => void;
  /**
   * Handles the updateBoardConnectionLabel function logic.
   * Input: none.
   * Output: result produced by this function.
   */
  updateBoardConnectionLabel: () => void;
  /**
   * Handles the startPresenceHeartbeat function logic.
   * Input: spaceId: any.
   * Output: result produced by this function.
   */
  startPresenceHeartbeat: (spaceId: any) => void;
  /**
   * Handles the stopPresenceHeartbeat function logic.
   * Input: spaceId: any.
   * Output: result produced by this function.
   */
  stopPresenceHeartbeat: (spaceId: any) => void;
  /**
   * Handles the authHeaders function logic.
   * Input: options?: any.
   * Output: result produced by this function.
   */
  authHeaders: (options?: any) => Record<string, string>;
  /**
   * Handles the forceEditorRefresh function logic.
   * Input: value: string.
   * Output: result produced by this function.
   */
  forceEditorRefresh: (value: string) => void;
  /**
   * Handles the syncEditorState function logic.
   * Input: none.
   * Output: result produced by this function.
   */
  syncEditorState: () => void;
  /**
   * Handles the trackOfflineDraftChange function logic.
   * Input: value: string.
   * Output: result produced by this function.
   */
  trackOfflineDraftChange: (value: string) => void;
  fetchImpl?: typeof fetch;
  requestAnimationFrameImpl?: (callback: FrameRequestCallback) => number;
  navigatorRef?: Navigator | null;
};

/**
 * Handles the createSyncEngine function logic.
 * Input: options: SyncEngineOptions.
 * Output: result produced by this function.
 */
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

  /**
   * Handles the getEditorValueFallback function logic.
   * Input: none.
   * Output: string.
   */
  function getEditorValueFallback(): string {
    const editorController = getEditorController();
    return editorController?.getValue?.() || dom?.editor?.value || "";
  }

  /**
   * Handles the disconnectSpace function logic.
   * Input: none.
   * Output: result produced by this function.
   */
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

  /**
   * Handles the hydrateFromRemote function logic.
   * Input: spaceId: any, ytext: any.
   * Output: result produced by this function.
   */
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

  /**
   * Handles the scheduleCollabSync function logic.
   * Input: none.
   * Output: result produced by this function.
   */
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

  /**
   * Handles the connectToSpace function logic.
   * Input: spaceId: any, spacePath: any = "".
   * Output: result produced by this function.
   */
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
      /**
       * Handles the destroy function logic.
       * Input: none.
       * Output: result produced by this function.
       */
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
