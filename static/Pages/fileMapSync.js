function safeStorage() {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch (_) {
    return null;
  }
}

export function getCurrentProjectId() {
  const serverProjectId = typeof window !== "undefined" ? String(window.CURRENT_PROJECT_ID || "").trim() : "";
  if (serverProjectId) return serverProjectId;
  const storage = safeStorage();
  if (!storage) return "";
  const rawValue = storage.getItem("currentProjectId");
  return typeof rawValue === "string" ? rawValue.trim() : "";
}

function getCurrentWorkspaceKey() {
  const serverWorkspaceKey = typeof window !== "undefined" ? String(window.USER_WORKSPACE_KEY || "").trim() : "";
  if (serverWorkspaceKey) return serverWorkspaceKey;
  const storage = safeStorage();
  if (!storage) return "";
  const rawValue = storage.getItem("currentWorkspaceKey");
  return typeof rawValue === "string" ? rawValue.trim() : "";
}

function getProjectStorageScope(projectId = getCurrentProjectId()) {
  const resolvedProjectId = String(projectId || "").trim();
  if (!resolvedProjectId) return "";
  const workspaceKey = getCurrentWorkspaceKey();
  return workspaceKey ? `${workspaceKey}__${resolvedProjectId}` : resolvedProjectId;
}

function getStorageKeys(projectId = getCurrentProjectId()) {
  const storageScope = getProjectStorageScope(projectId);
  return {
    matched: storageScope ? `FileMap_MatchedData_${storageScope}` : "FileMap_MatchedData",
    demographics: storageScope ? `FileMap_ForDemographics_${storageScope}` : "FileMap_ForDemographics",
    data: storageScope ? `data.json_${storageScope}` : "data.json",
  };
}

function parseStoredFileMap(rawValue, storageKey) {
  if (!rawValue) return null;
  try {
    const parsed = JSON.parse(rawValue);
    return parsed && Array.isArray(parsed.participants) ? parsed : null;
  } catch (error) {
    console.warn(`Corrupted FileMap in localStorage for ${storageKey}. Resetting.`, error);
    const storage = safeStorage();
    if (storage) storage.removeItem(storageKey);
    return null;
  }
}

function demographicsParticipants(fileMap) {
  return (fileMap?.participants || [])
    .map((participant) => {
      const participantCode = typeof participant === "string"
        ? participant
        : participant?.participant;
      return { participant: String(participantCode || "").trim() };
    })
    .filter((participant) => participant.participant);
}

function dispatchFileMapUpdate(fileMap, projectId, options = {}) {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  try {
    window.dispatchEvent(new CustomEvent("filemap:updated", {
      detail: {
        fileMap,
        projectId,
        reason: options.reason || "filemap-updated",
        updatedAt: Date.now()
      }
    }));
  } catch (error) {
    console.warn("Failed to broadcast FileMap update:", error);
  }
}

export function persistFileMapToStorage(fileMap, options = {}) {
  const storage = safeStorage();
  if (!storage) return null;

  const projectId = String(options.projectId || getCurrentProjectId() || "").trim();
  if (projectId) {
    storage.setItem("currentProjectId", projectId);
  }
  const workspaceKey = getCurrentWorkspaceKey();
  if (workspaceKey) {
    storage.setItem("currentWorkspaceKey", workspaceKey);
  }

  if (!fileMap || !Array.isArray(fileMap.participants)) {
    clearStoredFileMap({ projectId, reason: options.reason || "filemap-cleared" });
    return null;
  }

  const normalizedFileMap = {
    ...fileMap,
    ...(projectId ? { projectId } : {}),
    participants: fileMap.participants,
  };
  const keys = getStorageKeys(projectId);
  const serializedFileMap = JSON.stringify(normalizedFileMap);
  const serializedDemographics = JSON.stringify(demographicsParticipants(normalizedFileMap));
  const serializedData = JSON.stringify({ participants: normalizedFileMap.participants });

  storage.setItem(keys.matched, serializedFileMap);
  storage.setItem(keys.demographics, serializedDemographics);
  storage.setItem(keys.data, serializedData);

  if (options.writeLegacy === true && !workspaceKey) {
    storage.setItem("FileMap_MatchedData", serializedFileMap);
    storage.setItem("FileMap_ForDemographics", serializedDemographics);
    storage.setItem("data.json", serializedData);
  }

  dispatchFileMapUpdate(normalizedFileMap, projectId, options);
  return normalizedFileMap;
}

export function clearStoredFileMap(options = {}) {
  const storage = safeStorage();
  if (!storage) return;

  const projectId = String(options.projectId || getCurrentProjectId() || "").trim();
  const keys = getStorageKeys(projectId);
  storage.removeItem(keys.matched);
  storage.removeItem(keys.demographics);
  storage.setItem(keys.data, JSON.stringify({}));

  if (options.clearLegacy === true && !getCurrentWorkspaceKey()) {
    storage.removeItem("FileMap_MatchedData");
    storage.removeItem("FileMap_ForDemographics");
    storage.setItem("data.json", JSON.stringify({}));
  }

  dispatchFileMapUpdate({ participants: [] }, projectId, options);
}

export function getStoredFileMap(projectId = getCurrentProjectId(), options = {}) {
  const storage = safeStorage();
  if (!storage) return null;

  const resolvedProjectId = String(projectId || "").trim();
  const keys = getStorageKeys(resolvedProjectId);
  const scopedMap = parseStoredFileMap(storage.getItem(keys.matched), keys.matched);
  if (scopedMap) return scopedMap;

  if (options.allowLegacy === true && !resolvedProjectId && !getCurrentWorkspaceKey()) {
    return parseStoredFileMap(storage.getItem("FileMap_MatchedData"), "FileMap_MatchedData");
  }

  return null;
}

export async function hydrateFileMapFromServer(projectId = getCurrentProjectId()) {
  try {
    const projectParam = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    const response = await fetch(`/api/filemap/load${projectParam}`, { cache: "no-store" });
    if (!response.ok) return null;

    const payload = await response.json();
    const resolvedProjectId = String(payload?.projectContext?.currentProjectId || projectId || "").trim();
    const fileMap = payload?.fileMap;
    if (fileMap && Array.isArray(fileMap.participants)) {
      return persistFileMapToStorage(fileMap, { projectId: resolvedProjectId });
    }

    clearStoredFileMap({ projectId: resolvedProjectId });
    return null;
  } catch (error) {
    console.warn("Failed to restore FileMap from the server.", error);
    return null;
  }
}
