const PROJECT_STATE_PREFIXES = [
  "themesObject",
  "themeObject",
  "demographicsObject",
  "generatedPossibleThemes",
  "themeSelectionComplete",
  "themeSelectionPending",
  "visualizationThemeSelection",
  "FileMap_MatchedData",
  "FileMap_ForDemographics",
  "data.json",
  "projectFiles",
  "projectFileStatus",
  "manualQuestions",
  "fileUpdateWorkflow",
  "manualCodingOnly",
  "nonVerbalAudioCues",
];

const state = {
  initialized: false,
  saving: false,
  dirty: false,
  revision: null,
  timer: null,
  saveQueue: Promise.resolve(),
  browserRevisionChanges: new Map(),
};

function projectScope() {
  const workspaceKey = String(window.USER_WORKSPACE_KEY || "").trim();
  const projectId = String(window.CURRENT_PROJECT_ID || "").trim();
  if (!workspaceKey || !projectId) return null;
  return { workspaceKey, projectId, token: `${workspaceKey}__${projectId}` };
}

function isScopedProgressKey(key, scope) {
  if (!key || !scope || !key.includes(scope.token)) return false;
  return PROJECT_STATE_PREFIXES.some((prefix) => (
    key === `${prefix}_${scope.token}` ||
    key.startsWith(`${prefix}_${scope.token}_`) ||
    key.startsWith(`${prefix}:${scope.token}:`)
  ));
}

function collectBrowserState() {
  const scope = projectScope();
  const snapshot = {};
  if (!scope) return snapshot;
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!isScopedProgressKey(key, scope)) continue;
    const value = localStorage.getItem(key);
    if (typeof value === "string") snapshot[key] = value;
  }
  return snapshot;
}

function applyServerState(browserState, replaceScopedState = false) {
  const scope = projectScope();
  if (!scope || !browserState || typeof browserState !== "object") return false;
  let changed = false;
  if (replaceScopedState) {
    const serverKeys = new Set(Object.keys(browserState));
    const localKeys = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (isScopedProgressKey(key, scope) && !serverKeys.has(key)) localKeys.push(key);
    }
    localKeys.forEach((key) => {
      localStorage.removeItem(key);
      changed = true;
    });
  }
  Object.entries(browserState).forEach(([key, value]) => {
    if (!isScopedProgressKey(key, scope) || typeof value !== "string") return;
    if (localStorage.getItem(key) !== value) {
      localStorage.setItem(key, value);
      changed = true;
    }
  });
  return changed;
}

async function hydrateFromServer({ reloadIfChanged = false } = {}) {
  const scope = projectScope();
  if (!scope) return;
  const response = await fetch(`/api/project_progress_state?projectId=${encodeURIComponent(scope.projectId)}`, {
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!response.ok) return;
  const payload = await response.json();
  state.revision = Number.isInteger(payload.projectRevision) ? payload.projectRevision : null;
  rememberBrowserRevisionChange(
    payload.browserStateBaseRevision, payload.browserStateRevision, payload.projectRevision
  );
  const changed = applyServerState(payload.browserState, payload.hasSavedState === true);
  if (changed && reloadIfChanged) {
    const reloadKey = `chromaProgressHydrated:${scope.token}:${state.revision}`;
    if (!sessionStorage.getItem(reloadKey)) {
      sessionStorage.setItem(reloadKey, "1");
      window.location.reload();
    }
  }
  return payload;
}

function queueProjectSave(saveChange) {
  const pendingSave = state.saveQueue.then(saveChange);
  state.saveQueue = pendingSave.catch(() => {});
  return pendingSave;
}

function revisionAfterBrowserSaves(projectId, revision) {
  const scope = projectScope();
  if (!scope || scope.projectId !== projectId || !Number.isInteger(revision)) {
    return revision;
  }
  let currentRevision = revision;
  while (state.browserRevisionChanges.has(currentRevision)) {
    currentRevision = state.browserRevisionChanges.get(currentRevision);
  }
  return currentRevision;
}

function rememberBrowserRevisionChange(previousRevision, nextRevision, liveRevision = nextRevision) {
  if (!Number.isInteger(previousRevision) || !Number.isInteger(nextRevision)) return;
  if (!Number.isInteger(liveRevision) || nextRevision > liveRevision) return;
  if (previousRevision >= 0 && nextRevision > previousRevision) {
    state.browserRevisionChanges.set(previousRevision, nextRevision);
  }
}

function collectBrowserStateForSave(scope) {
  const snapshot = collectBrowserState();
  for (const [key, value] of Object.entries(snapshot)) {
    if (!key.startsWith("themesObject_") && !key.startsWith("themeObject_")) continue;
    try {
      const payload = JSON.parse(value);
      if (!payload || !Number.isInteger(payload.projectRevision)) continue;
      payload.projectRevision = revisionAfterBrowserSaves(scope.projectId, payload.projectRevision);
      snapshot[key] = JSON.stringify(payload);
    } catch (error) {
      // Preserve unrecognized cache values; their owning page handles validation.
    }
  }
  return snapshot;
}

async function runProjectChange(projectId, saveChange) {
  return queueProjectSave(async () => {
    const result = await saveChange();
    const revision = result?.projectRevision ?? result?.themes?.projectRevision;
    const scope = projectScope();
    if (scope?.projectId === projectId && Number.isInteger(revision)) {
      state.revision = revision;
      scheduleSave();
    }
    return result;
  });
}

async function saveBrowserState(scope) {
  const submittedRevision = state.revision;
  const response = await fetch("/api/project_progress_state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({
      projectId: scope.projectId,
      projectRevision: submittedRevision,
      browserState: collectBrowserStateForSave(scope),
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 409) {
    await hydrateFromServer({ reloadIfChanged: true });
    return;
  }
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  if (Number.isInteger(payload.projectRevision)) {
    // A browser-cache save does not change the codes. Allow the next code save
    // from this page to use that newer revision without accepting external edits.
    rememberBrowserRevisionChange(submittedRevision, payload.projectRevision);
    state.revision = payload.projectRevision;
  }
}

async function saveToServer() {
  const scope = projectScope();
  if (!scope || state.saving || !state.dirty) return;
  state.saving = true;
  state.dirty = false;
  try {
    await queueProjectSave(() => saveBrowserState(scope));
  } catch (error) {
    state.dirty = true;
    console.warn("Could not save project browser progress:", error);
  } finally {
    state.saving = false;
  }
}

function scheduleSave() {
  if (!state.initialized) return;
  state.dirty = true;
  window.clearTimeout(state.timer);
  state.timer = window.setTimeout(() => void saveToServer(), 1000);
}

function flushWithBeacon() {
  const scope = projectScope();
  if (!scope || !state.dirty || !navigator.sendBeacon) return;
  const payload = JSON.stringify({
    projectId: scope.projectId,
    projectRevision: state.revision,
    browserState: collectBrowserStateForSave(scope),
  });
  navigator.sendBeacon("/api/project_progress_state", new Blob([payload], { type: "application/json" }));
}

function clearAllProjectCaches() {
  [localStorage, sessionStorage].forEach((storage) => {
    if (!storage) return;
    const keys = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (
        key === "currentProjectId" ||
        key === "currentWorkspaceKey" ||
        key === "chromascribeActiveUserKey" ||
        PROJECT_STATE_PREFIXES.some((prefix) => key === prefix || key.startsWith(`${prefix}_`) || key.startsWith(`${prefix}:`))
      ) {
        keys.push(key);
      }
    }
    keys.forEach((key) => storage.removeItem(key));
  });
}

window.ChromaProjectProgress = {
  save: async () => {
    state.dirty = true;
    await saveToServer();
  },
  clearCaches: clearAllProjectCaches,
  runProjectChange,
  revisionAfterBrowserSaves,
};

function sessionContextUrl() {
  const pagePath = window.location.pathname;
  const isDemoPage = pagePath === "/demo" || pagePath.startsWith("/demo/");
  return isDemoPage ? "/demo/api/session_context" : "/api/session_context";
}

function syncProjectContext(context) {
  const workspaceKey = String(context.workspaceKey || "").trim();
  const projectId = String(context.currentProjectId || context.projectId || "").trim();
  if (!workspaceKey) {
    throw new Error("The local workspace is unavailable.");
  }

  const previousWorkspaceKey = localStorage.getItem("currentWorkspaceKey");
  if (previousWorkspaceKey && previousWorkspaceKey !== workspaceKey) {
    clearAllProjectCaches();
  }

  window.USER_WORKSPACE_KEY = workspaceKey;
  window.CURRENT_PROJECT_ID = projectId;
  localStorage.setItem("currentWorkspaceKey", workspaceKey);
  if (projectId) {
    localStorage.setItem("currentProjectId", projectId);
  } else {
    localStorage.removeItem("currentProjectId");
  }
}

async function initializeProjectContext() {
  const response = await fetch(sessionContextUrl(), {
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!response.ok) {
    throw new Error(`Project context unavailable: ${response.status}`);
  }
  const context = await response.json();
  syncProjectContext(context);
}

async function initialize() {
  if (state.initialized) return;
  try {
    await initializeProjectContext();
  } catch (error) {
    console.warn("Could not load the local project context:", error);
    return;
  }
  if (!projectScope()) return;
  const serverPayload = await hydrateFromServer({ reloadIfChanged: true });
  state.initialized = true;
  state.lastSnapshot = collectBrowserState();
  if (serverPayload?.hasSavedState !== true && Object.keys(state.lastSnapshot).length > 0) {
    scheduleSave();
  }
  document.addEventListener("input", scheduleSave, true);
  document.addEventListener("change", scheduleSave, true);
  window.addEventListener("chroma:theme-payload-updated", scheduleSave);
  window.addEventListener("pagehide", flushWithBeacon);
  window.setInterval(() => {
    if (JSON.stringify(collectBrowserState()) !== JSON.stringify(state.lastSnapshot || {})) {
      state.lastSnapshot = collectBrowserState();
      scheduleSave();
    }
  }, 5000);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void initialize(), { once: true });
} else {
  void initialize();
}
