// @ts-check

type AppDomSpecific = {
  editor: HTMLTextAreaElement | null;
  fileInput: HTMLInputElement | null;
  searchInput: HTMLInputElement | null;
  appBootLoader: HTMLElement | null;
  appBootLoaderStatus: HTMLElement | null;
  topbarActions: HTMLElement | null;
  mobileToolbarToggle: HTMLButtonElement | null;
  searchName: HTMLInputElement | null;
  searchDescription: HTMLInputElement | null;
  searchTag: HTMLInputElement | null;
  searchPerson: HTMLInputElement | null;
  loginUsername: HTMLInputElement | null;
  loginPassword: HTMLInputElement | null;
  profileDisplayName: HTMLInputElement | null;
  profileCurrentPassword: HTMLInputElement | null;
  profilePassword: HTMLInputElement | null;
  profilePasswordConfirm: HTMLInputElement | null;
  jiraConfigBaseUrl: HTMLInputElement | null;
  jiraConfigEmail: HTMLInputElement | null;
  jiraConfigToken: HTMLInputElement | null;
  userNewUsername: HTMLInputElement | null;
  userNewDisplayName: HTMLInputElement | null;
  userNewPassword: HTMLInputElement | null;
  userNewPasswordConfirm: HTMLInputElement | null;
  userNewRole: HTMLSelectElement | null;
  userPasswordNew: HTMLInputElement | null;
  userPasswordRepeat: HTMLInputElement | null;
  taskEditTitleInput: HTMLInputElement | null;
  taskEditCode: HTMLTextAreaElement | null;
  taskEditDelete: HTMLButtonElement | null;
  taskEditPreview: HTMLElement;
  taskEditSide: HTMLElement;
  boardMobileConnection: HTMLElement | null;
  slugRenameCurrent: HTMLInputElement | null;
  slugRenameNew: HTMLInputElement | null;
  slugRenameDisplayName: HTMLInputElement | null;
  slugRenameColor: HTMLInputElement | null;
  slugRenameColorPicker: HTMLInputElement | null;
  slugRenameEmail: HTMLInputElement | null;
  slugRenameJiraState: HTMLInputElement | null;
  boardRenameInput: HTMLInputElement | null;
  spaceNew: HTMLInputElement | null;
  spaceFolderNew: HTMLInputElement | null;
  spaceCreate: HTMLButtonElement | null;
  spaceFolderCreate: HTMLButtonElement | null;
  taskDeleteConfirmAll: HTMLButtonElement | null;
  taskTrash: HTMLElement;
  usersList: HTMLElement;
  tagList: HTMLElement;
  personList: HTMLElement;
  storyPointsSummaryGraph: HTMLElement;
  storyPointsSummaryKanban: HTMLElement;
  graphCanvas: HTMLElement;
  graphPanel: HTMLElement;
  legend: HTMLElement;
  divider: HTMLElement;
  kanbanDivider: HTMLElement;
  historyButton: HTMLButtonElement | null;
  responsivePaneBar: HTMLElement | null;
  mobilePaneTabs: HTMLElement | null;
  tabletPaneToggle: HTMLElement | null;
  tabletLayoutToggle: HTMLElement | null;
  boardHistoryMode: HTMLElement | null;
  historyViewerBanner: HTMLElement | null;
  historyViewerBannerLabel: HTMLElement | null;
  historyPanel: HTMLElement | null;
  historyTagButton: HTMLButtonElement | null;
  historyRevertButton: HTMLButtonElement | null;
  historyCancelButton: HTMLButtonElement | null;
  historyStepPrev: HTMLButtonElement | null;
  historyStepNext: HTMLButtonElement | null;
  historySlider: HTMLInputElement | null;
  historyMarks: HTMLElement | null;
  historyCurrentLabel: HTMLElement | null;
  historyRevertModal: HTMLElement | null;
  historyRevertClose: HTMLButtonElement | null;
  historyRevertMessage: HTMLElement | null;
  historyRevertCancel: HTMLButtonElement | null;
  historyRevertConfirm: HTMLButtonElement | null;
  historyTagModal: HTMLElement | null;
  historyTagClose: HTMLButtonElement | null;
  historyTagInput: HTMLInputElement | null;
  historyTagError: HTMLElement | null;
  historyTagCancel: HTMLButtonElement | null;
  historyTagSave: HTMLButtonElement | null;
  spellcheckToggleMain: HTMLButtonElement | null;
  spellcheckToggleModal: HTMLButtonElement | null;
};

function createAppDomRaw(doc: Document = document) {
  return {
    editor: doc.getElementById("task-editor"),
    editorHost: doc.getElementById("code-editor"),
    graphNodes: doc.getElementById("graph-nodes"),
    graphLines: doc.getElementById("graph-lines"),
    graphMinimap: doc.getElementById("graph-minimap"),
    minimapSvg: doc.getElementById("minimap-svg"),
    graphAddTask: doc.getElementById("graph-add-task"),
    appBootLoader: doc.getElementById("app-boot-loader"),
    appBootLoaderStatus: doc.getElementById("app-boot-loader-status"),
    topbarActions: doc.getElementById("topbar-actions"),
    mobileToolbarToggle: doc.getElementById("mobile-toolbar-toggle"),
    searchInput: doc.getElementById("search-input"),
    searchName: doc.getElementById("search-name"),
    searchDescription: doc.getElementById("search-description"),
    searchTag: doc.getElementById("search-tag"),
    searchPerson: doc.getElementById("search-person"),
    boardTitle: doc.getElementById("board-title"),
    boardMobileConnection: doc.getElementById("board-mobile-connection"),
    boardConnection: doc.getElementById("board-connection"),
    undoButton: doc.getElementById("undo-button"),
    redoButton: doc.getElementById("redo-button"),
    loadButton: doc.getElementById("load-button"),
    saveButton: doc.getElementById("save-button"),
    formatButton: doc.getElementById("format-button"),
    historyButton: doc.getElementById("history-button"),
    responsivePaneBar: doc.getElementById("responsive-pane-bar"),
    mobilePaneTabs: doc.getElementById("mobile-pane-tabs"),
    tabletPaneToggle: doc.getElementById("tablet-pane-toggle"),
    tabletLayoutToggle: doc.getElementById("tablet-layout-toggle"),
    boardHistoryMode: doc.getElementById("board-history-mode"),
    connectButton: doc.getElementById("connect-button"),
    themeButton: doc.getElementById("theme-button"),
    fullscreenButton: doc.getElementById("fullscreen-button"),
    fileInput: doc.getElementById("file-input"),
    loginModal: doc.getElementById("login-modal"),
    loginModalClose: doc.getElementById("login-modal-close"),
    loginUsername: doc.getElementById("login-username"),
    loginPassword: doc.getElementById("login-password"),
    loginSubmit: doc.getElementById("login-submit"),
    loginError: doc.getElementById("login-error"),
    spacesModal: doc.getElementById("spaces-modal"),
    spacesModalClose: doc.getElementById("spaces-modal-close"),
    spacesLogout: doc.getElementById("spaces-logout"),
    spacesTabCurrent: doc.getElementById("spaces-tab-current"),
    profileButton: doc.getElementById("profile-button"),
    jiraConfigButton: doc.getElementById("jira-config-button"),
    usersButton: doc.getElementById("users-button"),
    profileModal: doc.getElementById("profile-modal"),
    profileClose: doc.getElementById("profile-close"),
    profileError: doc.getElementById("profile-error"),
    profileDisplayName: doc.getElementById("profile-display-name"),
    profileCurrentPassword: doc.getElementById("profile-current-password"),
    profilePassword: doc.getElementById("profile-password"),
    profilePasswordConfirm: doc.getElementById("profile-password-confirm"),
    profileLogoutModal: doc.getElementById("profile-logout-modal"),
    profileLogoutCancel: doc.getElementById("profile-logout-cancel"),
    profileLogoutConfirm: doc.getElementById("profile-logout-confirm"),
    profileSave: doc.getElementById("profile-save"),
    jiraConfigModal: doc.getElementById("jira-config-modal"),
    jiraConfigClose: doc.getElementById("jira-config-close"),
    jiraConfigBaseUrl: doc.getElementById("jira-config-base-url"),
    jiraConfigEmail: doc.getElementById("jira-config-email"),
    jiraConfigToken: doc.getElementById("jira-config-token"),
    jiraConfigSave: doc.getElementById("jira-config-save"),
    jiraConfigCancel: doc.getElementById("jira-config-cancel"),
    jiraConfigError: doc.getElementById("jira-config-error"),
    usersModal: doc.getElementById("users-modal"),
    usersClose: doc.getElementById("users-close"),
    usersError: doc.getElementById("users-error"),
    usersAdminSection: doc.getElementById("users-admin-section"),
    usersList: doc.getElementById("users-list"),
    userOpenCreate: doc.getElementById("user-open-create"),
    userNewUsername: doc.getElementById("user-new-username"),
    userNewDisplayName: doc.getElementById("user-new-display-name"),
    userNewPassword: doc.getElementById("user-new-password"),
    userNewPasswordConfirm: doc.getElementById("user-new-password-confirm"),
    userNewRole: doc.getElementById("user-new-role"),
    userNewSpacesField: doc.getElementById("user-new-spaces-field"),
    userNewSpaces: doc.getElementById("user-new-spaces"),
    userCreateModal: doc.getElementById("user-create-modal"),
    userCreateClose: doc.getElementById("user-create-close"),
    userCreateError: doc.getElementById("user-create-error"),
    userCreate: doc.getElementById("user-create"),
    userPasswordModal: doc.getElementById("user-password-modal"),
    userPasswordClose: doc.getElementById("user-password-close"),
    userPasswordMessage: doc.getElementById("user-password-message"),
    userPasswordNew: doc.getElementById("user-password-new"),
    userPasswordRepeat: doc.getElementById("user-password-repeat"),
    userPasswordError: doc.getElementById("user-password-error"),
    userPasswordCancel: doc.getElementById("user-password-cancel"),
    userPasswordSave: doc.getElementById("user-password-save"),
    userDeleteModal: doc.getElementById("user-delete-modal"),
    userDeleteMessage: doc.getElementById("user-delete-message"),
    userDeleteCancel: doc.getElementById("user-delete-cancel"),
    userDeleteConfirm: doc.getElementById("user-delete-confirm"),
    taskEditModal: doc.getElementById("task-edit-modal"),
    taskEditTitleInput: doc.getElementById("task-edit-title-input"),
    taskEditJiraPill: doc.getElementById("task-edit-jira-pill"),
    taskEditPreview: doc.getElementById("task-edit-preview"),
    taskEditCode: doc.getElementById("task-edit-code"),
    taskEditDelete: doc.getElementById("task-edit-delete"),
    taskEditCodeHost: doc.getElementById("task-edit-code-editor"),
    taskEditSide: doc.getElementById("task-edit-side"),
    taskEditStates: doc.getElementById("task-edit-states"),
    taskEditPeople: doc.getElementById("task-edit-people"),
    taskEditTags: doc.getElementById("task-edit-tags"),
    taskEditCancel: doc.getElementById("task-edit-cancel"),
    taskEditSave: doc.getElementById("task-edit-save"),
    taskEditError: doc.getElementById("task-edit-error"),
    slugRenameModal: doc.getElementById("slug-rename-modal"),
    slugRenameClose: doc.getElementById("slug-rename-close"),
    slugRenameMessage: doc.getElementById("slug-rename-message"),
    slugRenameCurrent: doc.getElementById("slug-rename-current"),
    slugRenameNew: doc.getElementById("slug-rename-new"),
    slugRenameDisplayNameField: doc.getElementById("slug-rename-display-name-field"),
    slugRenameDisplayNameLabel: doc.getElementById("slug-rename-display-name-label"),
    slugRenameDisplayName: doc.getElementById("slug-rename-display-name"),
    slugRenameColorField: doc.getElementById("slug-rename-color-field"),
    slugRenameColor: doc.getElementById("slug-rename-color"),
    slugRenameColorSwatches: doc.getElementById("slug-rename-color-swatches"),
    slugRenameColorPicker: doc.getElementById("slug-rename-color-picker"),
    slugRenameColorClear: doc.getElementById("slug-rename-color-clear"),
    slugRenameColorPreview: doc.getElementById("slug-rename-color-preview"),
    slugRenameEmailField: doc.getElementById("slug-rename-email-field"),
    slugRenameEmailLabel: doc.getElementById("slug-rename-email-label"),
    slugRenameEmail: doc.getElementById("slug-rename-email"),
    slugRenameJiraStateField: doc.getElementById("slug-rename-jira-state-field"),
    slugRenameJiraStateLabel: doc.getElementById("slug-rename-jira-state-label"),
    slugRenameJiraState: doc.getElementById("slug-rename-jira-state"),
    slugRenameCancel: doc.getElementById("slug-rename-cancel"),
    slugRenameSave: doc.getElementById("slug-rename-save"),
    boardRenameModal: doc.getElementById("board-rename-modal"),
    boardRenameClose: doc.getElementById("board-rename-close"),
    boardRenameInput: doc.getElementById("board-rename-input"),
    boardRenameCancel: doc.getElementById("board-rename-cancel"),
    boardRenameSave: doc.getElementById("board-rename-save"),
    taskTrash: doc.getElementById("task-trash"),
    taskDeleteModal: doc.getElementById("task-delete-modal"),
    taskDeleteMessage: doc.getElementById("task-delete-message"),
    taskDeleteCancel: doc.getElementById("task-delete-cancel"),
    taskDeleteConfirm: doc.getElementById("task-delete-confirm"),
    taskDeleteConfirmAll: doc.getElementById("task-delete-confirm-all"),
    spaceOpenCreate: doc.getElementById("space-open-create"),
    spaceOpenFolderCreate: doc.getElementById("space-open-folder-create"),
    spaceCreateModal: doc.getElementById("space-create-modal"),
    spaceCreateClose: doc.getElementById("space-create-close"),
    spaceCreateCancel: doc.getElementById("space-create-cancel"),
    spaceNew: doc.getElementById("space-new"),
    spaceCreate: doc.getElementById("space-create"),
    spaceFolderCreateModal: doc.getElementById("space-folder-create-modal"),
    spaceFolderCreateClose: doc.getElementById("space-folder-create-close"),
    spaceFolderCreateCancel: doc.getElementById("space-folder-create-cancel"),
    spaceFolderNew: doc.getElementById("space-folder-new"),
    spaceFolderCreate: doc.getElementById("space-folder-create"),
    folderDeleteModal: doc.getElementById("folder-delete-modal"),
    folderDeleteMessage: doc.getElementById("folder-delete-message"),
    folderDeleteCancel: doc.getElementById("folder-delete-cancel"),
    folderDeleteConfirm: doc.getElementById("folder-delete-confirm"),
    spaceError: doc.getElementById("space-error"),
    spaceList: doc.getElementById("space-list"),
    deleteModal: doc.getElementById("delete-modal"),
    deleteModalMessage: doc.getElementById("delete-modal-message"),
    deleteConfirm: doc.getElementById("delete-confirm"),
    deleteCancel: doc.getElementById("delete-cancel"),
    kanbanBoard: doc.getElementById("kanban-board"),
    kanbanContent: doc.getElementById("kanban-content"),
    kanbanDivider: doc.getElementById("kanban-divider"),
    kanbanGroup: doc.getElementById("kanban-group"),
    graphPanel: doc.querySelector(".graph-panel"),
    legend: doc.querySelector(".legend"),
    tagList: doc.getElementById("tag-list"),
    personList: doc.getElementById("person-list"),
    clearFilters: doc.getElementById("clear-filters"),
    storyPointsSummaryGraph: doc.getElementById("story-points-summary-graph"),
    storyPointsSummaryKanban: doc.getElementById("story-points-summary-kanban"),
    graphCanvas: doc.getElementById("graph-canvas"),
    divider: doc.getElementById("divider"),
    historyViewerBanner: doc.getElementById("history-viewer-banner"),
    historyViewerBannerLabel: doc.getElementById("history-viewer-banner-label"),
    historyPanel: doc.getElementById("history-panel"),
    historyTagButton: doc.getElementById("history-tag-button"),
    historyRevertButton: doc.getElementById("history-revert-button"),
    historyCancelButton: doc.getElementById("history-cancel-button"),
    historyStepPrev: doc.getElementById("history-step-prev"),
    historyStepNext: doc.getElementById("history-step-next"),
    historySlider: doc.getElementById("history-slider"),
    historyMarks: doc.getElementById("history-marks"),
    historyCurrentLabel: doc.getElementById("history-current-label"),
    historyRevertModal: doc.getElementById("history-revert-modal"),
    historyRevertClose: doc.getElementById("history-revert-close"),
    historyRevertMessage: doc.getElementById("history-revert-message"),
    historyRevertCancel: doc.getElementById("history-revert-cancel"),
    historyRevertConfirm: doc.getElementById("history-revert-confirm"),
    historyTagModal: doc.getElementById("history-tag-modal"),
    historyTagClose: doc.getElementById("history-tag-close"),
    historyTagInput: doc.getElementById("history-tag-input"),
    historyTagError: doc.getElementById("history-tag-error"),
    historyTagCancel: doc.getElementById("history-tag-cancel"),
    historyTagSave: doc.getElementById("history-tag-save"),
    spellcheckToggleMain: doc.getElementById("spellcheck-toggle-main"),
    spellcheckToggleModal: doc.getElementById("spellcheck-toggle-modal"),
  };
}

export type AppDom = ReturnType<typeof createAppDomRaw> & AppDomSpecific;

export function createAppDom(doc: Document = document): AppDom {
  return createAppDomRaw(doc) as AppDom;
}
