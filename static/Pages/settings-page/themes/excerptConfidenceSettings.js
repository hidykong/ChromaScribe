export const MIN_EXCERPT_CONFIDENCE_THRESHOLD = 0;
export const MAX_EXCERPT_CONFIDENCE_THRESHOLD = 1;
export const DEFAULT_EXCERPT_CONFIDENCE_THRESHOLD = 0.2;
export const EXCERPT_CONFIDENCE_STEP_PERCENT = 5;

function normalizeScopeValue(value) {
    return String(value || "").trim();
}

function getRuntimeStorage() {
    return typeof localStorage === "undefined" ? null : localStorage;
}

function getRuntimeProjectId(storage = getRuntimeStorage()) {
    if (typeof window !== "undefined") {
        const params = new URLSearchParams(window.location?.search || "");
        const queryProjectId = normalizeScopeValue(params.get("projectId") || params.get("project_id"));
        if (queryProjectId) return queryProjectId;

        const serverProjectId = normalizeScopeValue(window.CURRENT_PROJECT_ID);
        if (serverProjectId) return serverProjectId;
    }
    return normalizeScopeValue(storage?.getItem("currentProjectId"));
}

function getRuntimeWorkspaceKey(storage = getRuntimeStorage()) {
    if (typeof window !== "undefined") {
        const serverWorkspaceKey = normalizeScopeValue(window.USER_WORKSPACE_KEY);
        if (serverWorkspaceKey) return serverWorkspaceKey;
    }
    return normalizeScopeValue(storage?.getItem("currentWorkspaceKey"));
}

export function clampExcerptConfidenceThreshold(value) {
    let numericValue = Number(value);
    if (!Number.isFinite(numericValue)) return DEFAULT_EXCERPT_CONFIDENCE_THRESHOLD;
    if (numericValue > 1 && numericValue <= 100) numericValue /= 100;
    return Math.max(
        MIN_EXCERPT_CONFIDENCE_THRESHOLD,
        Math.min(MAX_EXCERPT_CONFIDENCE_THRESHOLD, numericValue)
    );
}

export function getExcerptConfidenceThresholdStorageKeys(options = {}) {
    const storage = options.storage || getRuntimeStorage();
    const projectId = normalizeScopeValue(
        Object.prototype.hasOwnProperty.call(options, "projectId")
            ? options.projectId
            : getRuntimeProjectId(storage)
    );
    const workspaceKey = normalizeScopeValue(
        Object.prototype.hasOwnProperty.call(options, "workspaceKey")
            ? options.workspaceKey
            : getRuntimeWorkspaceKey(storage)
    );
    const legacyKey = projectId
        ? `themeExcerptConfidenceThreshold_${projectId}`
        : "themeExcerptConfidenceThreshold";
    const primaryKey = projectId && workspaceKey
        ? `themeExcerptConfidenceThreshold_${workspaceKey}__${projectId}`
        : legacyKey;

    return { primaryKey, legacyKey, projectId, workspaceKey };
}

export function getExcerptConfidenceThreshold(options = {}) {
    const storage = options.storage || getRuntimeStorage();
    if (!storage) return DEFAULT_EXCERPT_CONFIDENCE_THRESHOLD;

    const { primaryKey, legacyKey } = getExcerptConfidenceThresholdStorageKeys({ ...options, storage });
    const primaryValue = storage.getItem(primaryKey);
    if (primaryValue !== null && primaryValue !== undefined && primaryValue !== "") {
        return clampExcerptConfidenceThreshold(primaryValue);
    }

    if (legacyKey !== primaryKey) {
        const legacyValue = storage.getItem(legacyKey);
        if (legacyValue !== null && legacyValue !== undefined && legacyValue !== "") {
            const migratedValue = clampExcerptConfidenceThreshold(legacyValue);
            storage.setItem(primaryKey, String(migratedValue));
            return migratedValue;
        }
    }

    return DEFAULT_EXCERPT_CONFIDENCE_THRESHOLD;
}

export function setExcerptConfidenceThreshold(value, options = {}) {
    const clampedValue = clampExcerptConfidenceThreshold(value);
    const storage = options.storage || getRuntimeStorage();
    if (!storage) return clampedValue;

    const { primaryKey } = getExcerptConfidenceThresholdStorageKeys({ ...options, storage });
    storage.setItem(primaryKey, String(clampedValue));
    return clampedValue;
}
