function getCurrentProjectId() {
  const serverProjectId = typeof window !== "undefined" ? String(window.CURRENT_PROJECT_ID || "").trim() : "";
  if (serverProjectId) return serverProjectId;
  if (typeof localStorage === "undefined") return "";
  const rawValue = localStorage.getItem("currentProjectId");
  return typeof rawValue === "string" ? rawValue.trim() : "";
}

function getCurrentWorkspaceKey() {
  const serverWorkspaceKey = typeof window !== "undefined" ? String(window.USER_WORKSPACE_KEY || "").trim() : "";
  if (serverWorkspaceKey) return serverWorkspaceKey;
  if (typeof localStorage === "undefined") return "";
  const rawValue = localStorage.getItem("currentWorkspaceKey");
  return typeof rawValue === "string" ? rawValue.trim() : "";
}

const THEME_SYNC_CHANNEL_NAME = "chromascribe-theme-sync";
export const DEFAULT_THEME_COLOR_PALETTE = [
  "#E7A23B",
  "#E14947",
  "#8EC053",
  "#579AE2",
  "#8E41D1",
  "#15AABF",
  "#F76707",
  "#2F9E44",
  "#D6336C",
  "#7048E8",
  "#0CA678",
  "#F59F00",
  "#1971C2",
  "#C2255C",
  "#5C940D",
  "#9C36B5",
];
let themeBroadcastChannel = null;

export function shouldOpenSavedThemeCodeManager(appMode, selectionComplete, selectedPayload) {
  const hasSavedThemes = Boolean(
    selectedPayload &&
    Array.isArray(selectedPayload.themes) &&
    selectedPayload.themes.length > 0 &&
    selectedPayload.selectedThemesExists !== false
  );
  if (!hasSavedThemes) return false;
  return (
    String(appMode || "user").trim().toLowerCase() === "demo" ||
    selectionComplete === true ||
    themePayloadHasManualContent(selectedPayload)
  );
}

function getThemeBroadcastChannel() {
  if (typeof BroadcastChannel === "undefined") return null;
  if (!themeBroadcastChannel) {
    themeBroadcastChannel = new BroadcastChannel(THEME_SYNC_CHANNEL_NAME);
  }
  return themeBroadcastChannel;
}

function projectMatches(projectId) {
  const currentProjectId = getCurrentProjectId();
  if (!currentProjectId) return !projectId;
  return String(projectId || "").trim() === currentProjectId;
}

function parseStoredThemePayload(rawValue) {
  if (!rawValue) return null;
  try {
    const parsed = JSON.parse(rawValue);
    return parsed && Array.isArray(parsed.themes) ? parsed : null;
  } catch (error) {
    console.warn("Failed to parse stored theme payload:", error);
    return null;
  }
}

export function getThemesStorageKey(projectId = getCurrentProjectId()) {
  const resolvedProjectId = String(projectId || "").trim();
  const workspaceKey = getCurrentWorkspaceKey();
  if (resolvedProjectId && workspaceKey) {
    return `themesObject_${workspaceKey}__${resolvedProjectId}`;
  }
  return resolvedProjectId ? `themesObject_${resolvedProjectId}` : "themesObject";
}

export function getStoredThemePayload(projectId = getCurrentProjectId()) {
  const scopedKey = getThemesStorageKey(projectId);
  const candidateKeys = projectId ? [scopedKey] : [scopedKey];
  const stores = [];

  if (typeof localStorage !== "undefined") stores.push(localStorage);
  if (typeof sessionStorage !== "undefined") stores.push(sessionStorage);

  for (const store of stores) {
    for (const key of candidateKeys) {
      const parsed = parseStoredThemePayload(store.getItem(key));
      if (parsed) return parsed;
    }
  }

  return null;
}

function broadcastThemePayloadUpdate(payload, projectId = getCurrentProjectId()) {
  const detail = { payload, projectId };

  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    try {
      window.dispatchEvent(new CustomEvent("themes:updated", { detail }));
    } catch (error) {
      console.warn("Failed to broadcast theme update event:", error);
    }
  }

  try {
    getThemeBroadcastChannel()?.postMessage({
      type: "themes:updated",
      payload,
      projectId,
      updatedAt: Date.now(),
    });
  } catch (error) {
    console.warn("Failed to broadcast theme update channel message:", error);
  }
}

export function subscribeToThemePayloadUpdates(callback) {
  if (typeof callback !== "function") return () => {};

  const handleWindowEvent = (event) => {
    const payload = event?.detail?.payload;
    const projectId = event?.detail?.projectId;
    if (payload && Array.isArray(payload.themes) && projectMatches(projectId)) {
      callback(payload, { source: "event", projectId });
    }
  };

  const handleStorageEvent = (event) => {
    if (!event?.key || !event.key.includes("themesObject")) return;
    if (event.key !== getThemesStorageKey()) return;
    const payload = parseStoredThemePayload(event.newValue) || getStoredThemePayload();
    callback(payload, { source: "storage", projectId: getCurrentProjectId(), key: event.key });
  };

  const channel = getThemeBroadcastChannel();
  const handleChannelMessage = (event) => {
    const data = event?.data;
    if (data?.type !== "themes:updated") return;
    if (!projectMatches(data.projectId)) return;
    const payload = data.payload;
    if (payload && Array.isArray(payload.themes)) {
      callback(payload, { source: "broadcast", projectId: data.projectId });
    }
  };

  if (typeof window !== "undefined") {
    window.addEventListener("themes:updated", handleWindowEvent);
    window.addEventListener("storage", handleStorageEvent);
  }
  if (channel) {
    channel.addEventListener("message", handleChannelMessage);
  }

  return () => {
    if (typeof window !== "undefined") {
      window.removeEventListener("themes:updated", handleWindowEvent);
      window.removeEventListener("storage", handleStorageEvent);
    }
    if (channel) {
      channel.removeEventListener("message", handleChannelMessage);
    }
  };
}

export function normalizeHexColor(rawColor, fallback = "#579AE2") {
  const color = String(rawColor || "").trim();
  if (/^#[0-9a-f]{6}$/i.test(color)) {
    return color.toUpperCase();
  }
  if (/^#[0-9a-f]{3}$/i.test(color)) {
    const expanded = color.slice(1).split("").map((ch) => ch + ch).join("");
    return `#${expanded}`.toUpperCase();
  }
  return fallback ? String(fallback).toUpperCase() : "";
}

export function normalizeThemeNameKey(rawThemeName) {
  return String(rawThemeName || "")
    .replace(/&/g, " and ")
    .replace(/[_-]+/g, " ")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeThemeNameIdentityKey(rawThemeName) {
  return normalizeThemeNameKey(rawThemeName).replace(/\s+/g, "");
}

function getThemeName(theme) {
  return String(
    (theme && (theme.themeName || theme.theme || theme.name || theme.title)) || ""
  ).trim();
}

function getUsedThemeColorSet(themes) {
  const usedColors = new Set();
  (Array.isArray(themes) ? themes : []).forEach((theme) => {
    const color = normalizeHexColor(theme && theme.color, "");
    if (color) usedColors.add(color);
  });
  return usedColors;
}

function getNextThemeColorFromUsedColors(usedColors, offset = 0) {
  const palette = DEFAULT_THEME_COLOR_PALETTE
    .map((color) => normalizeHexColor(color, ""))
    .filter(Boolean);

  for (let index = 0; index < palette.length; index += 1) {
    const color = palette[(index + offset) % palette.length];
    if (!usedColors.has(color)) return color;
  }

  for (let index = 0; index < 180; index += 1) {
    const hue = (offset * 53 + index * 137.508) % 360;
    const generated = hslToHex(hue, 70, 48);
    if (!usedColors.has(generated)) return generated;
  }

  return palette[offset % palette.length] || "#579AE2";
}

function hslToHex(h, s, l) {
  const saturation = s / 100;
  const lightness = l / 100;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = chroma * (1 - Math.abs((h / 60) % 2 - 1));
  const m = lightness - chroma / 2;
  let r = 0;
  let g = 0;
  let b = 0;

  if (h < 60) {
    r = chroma; g = x; b = 0;
  } else if (h < 120) {
    r = x; g = chroma; b = 0;
  } else if (h < 180) {
    r = 0; g = chroma; b = x;
  } else if (h < 240) {
    r = 0; g = x; b = chroma;
  } else if (h < 300) {
    r = x; g = 0; b = chroma;
  } else {
    r = chroma; g = 0; b = x;
  }

  const toHex = (channel) => Math.round((channel + m) * 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

export function getNextAvailableThemeColor(themes = [], preferredColor = "") {
  const usedColors = getUsedThemeColorSet(themes);
  const normalizedPreferred = normalizeHexColor(preferredColor, "");
  if (normalizedPreferred && !usedColors.has(normalizedPreferred)) {
    return normalizedPreferred;
  }
  return getNextThemeColorFromUsedColors(usedColors, usedColors.size);
}

export function normalizeThemeWordText(rawValue) {
  return String(rawValue || "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeThemeExcerptIdentityText(rawValue) {
  return normalizeThemeWordText(rawValue)
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/^[\s"'`]+|[\s"'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function normalizeThemeParticipantCode(rawValue) {
  const text = String(rawValue || "").trim();
  if (!text) return "";
  const match = text.match(/(?:^|[^a-z0-9])(?:participant\s*|p[\s_-]*)0*(\d+)(?=$|[^a-z0-9])/i);
  return match ? `P${parseInt(match[1], 10)}` : "";
}

export function normalizeThemeParticipantId(rawValue) {
  const text = String(rawValue || "").trim();
  const numericId = text.match(/^(?:(?:participant\s*|p[\s_-]*|pt[\s_-]*))?0*(\d+)$/i);
  return numericId ? `P${parseInt(numericId[1], 10)}` : text;
}

export function normalizeThemeQaTag(rawValue) {
  const text = String(rawValue || "").trim();
  if (!text) return "";
  const match = text.match(/\b([QA])\s*0*(\d+)([a-z]?)\b/i);
  return match ? `${match[1].toUpperCase()}${parseInt(match[2], 10)}${(match[3] || "").toLowerCase()}` : "";
}

export function normalizeThemeTimestamp(rawValue) {
  return String(rawValue || "")
    .replace(/\s+/g, "")
    .trim();
}

export function buildThemeExcerptEntry(rawEntry, overrides = {}) {
  const mergedEntry = typeof rawEntry === "object" && rawEntry !== null
    ? { ...rawEntry, ...overrides }
    : { ...overrides, word: rawEntry };

  const word = normalizeThemeWordText(mergedEntry.word || mergedEntry.text || mergedEntry.quote || mergedEntry.excerpt || "");
  if (!word) return null;

  const speaker = String(mergedEntry.speaker || "").trim();
  const sourceFile = String(mergedEntry.source_file
    || mergedEntry.sourceFile
    || mergedEntry.file_key
    || mergedEntry.fileKey
    || mergedEntry.filename
    || mergedEntry.fileName
    || mergedEntry.relativePath
    || mergedEntry.transcriptFile
    || "").trim();
  const segmentId = String(mergedEntry.segmentId || "").trim();
  const participant = normalizeThemeParticipantId(mergedEntry.participantId || mergedEntry.participant)
    || normalizeThemeParticipantCode(speaker)
    || normalizeThemeParticipantCode(sourceFile);
  const tag = normalizeThemeQaTag(mergedEntry.tag || speaker);
  const timestamp = normalizeThemeTimestamp(mergedEntry.timestamp);
  const cueText = normalizeThemeWordText(mergedEntry.cueText || "");

  const entry = {
    ...mergedEntry,
    word,
    value: Number.isFinite(Number(mergedEntry.value))
      ? Number(mergedEntry.value)
      : 1,
    stemmedWords: Array.isArray(mergedEntry.stemmedWords)
      ? mergedEntry.stemmedWords
          .map((value) => normalizeThemeWordText(value))
          .filter(Boolean)
      : [],
  };

  if (speaker) entry.speaker = speaker;
  else delete entry.speaker;

  if (participant) entry.participant = participant;
  else delete entry.participant;

  if (mergedEntry.participantId && participant) entry.participantId = participant;
  if (sourceFile) entry.sourceFile = sourceFile;
  if (segmentId) entry.segmentId = segmentId;

  if (tag) entry.tag = tag;
  else delete entry.tag;

  if (timestamp) entry.timestamp = timestamp;
  else delete entry.timestamp;

  if (cueText) entry.cueText = cueText;
  else delete entry.cueText;

  return entry;
}

export function buildThemeWordIdentityKey(rawEntry) {
  const entry = buildThemeExcerptEntry(rawEntry);
  if (!entry) return "";

  // A segment can have several selected spans. Include the selected text while
  // keeping repeated text in separate source segments distinct.
  if (entry.segmentId) {
    return [
      "segment",
      String(entry.sourceFile || ""),
      entry.segmentId,
      String(entry.participant || "").toLowerCase(),
      normalizeThemeExcerptIdentityText(entry.word || ""),
    ].join("||");
  }

  return [
    String(entry.participant || "").toLowerCase(),
    String(entry.tag || "").toLowerCase(),
    String(entry.timestamp || "").toLowerCase(),
    normalizeThemeExcerptIdentityText(entry.cueText || ""),
    normalizeThemeExcerptIdentityText(entry.word || ""),
  ].join("||");
}

export function themeWordEntriesEqual(leftEntry, rightEntry) {
  const leftKey = buildThemeWordIdentityKey(leftEntry);
  const rightKey = buildThemeWordIdentityKey(rightEntry);
  return Boolean(leftKey) && leftKey === rightKey;
}

function getThemeEntrySourceKey(entry) {
  return String(entry?.codeSource || entry?.source || entry?.tagSource || "").trim().toLowerCase();
}

function themeEntryHasHumanSource(entry) {
  if (!entry || typeof entry !== "object") return false;
  const source = getThemeEntrySourceKey(entry);
  if (source === "manual" || source === "human" || source === "human_ai" || source === "human+ai" || source === "both") return true;
  if (entry.humanTagged === true || entry.human_tagged === true) return true;
  return entry.ai_generated === false;
}

export function isManualThemeEntry(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (themeEntryHasHumanSource(entry)) return true;
  return (Array.isArray(entry.words) ? entry.words : []).some(themeEntryHasHumanSource);
}

export function themePayloadHasManualContent(payload) {
  const themes = Array.isArray(payload?.themes) ? payload.themes : [];
  return themes.some(isManualThemeEntry);
}

export function isManualThemeWordEntry(entry) {
  return themeEntryHasHumanSource(entry);
}

function normalizeOptOutKeys(rawValues) {
  return [...new Set((Array.isArray(rawValues) ? rawValues : [])
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean))].sort();
}

export function normalizeManualSelectionOptOuts(source) {
  const raw = source && typeof source === "object" && source.manualSelectionOptOuts
    ? source.manualSelectionOptOuts
    : source;
  return {
    codes: normalizeOptOutKeys(raw && raw.codes),
    excerpts: normalizeOptOutKeys(raw && raw.excerpts),
  };
}

export function buildManualCodeSelectionKey(themeName) {
  return normalizeThemeNameIdentityKey(themeName);
}

export function buildManualExcerptSelectionKey(themeName, wordEntry) {
  const codeKey = buildManualCodeSelectionKey(themeName);
  const excerptKey = buildThemeWordIdentityKey(wordEntry);
  return codeKey && excerptKey ? `${codeKey}::${excerptKey}` : "";
}

export function isManualCodeEffectivelySelected(source, themeEntry) {
  if (!isManualThemeEntry(themeEntry)) return themeEntry?.selectedByUser === true;
  const codeKey = buildManualCodeSelectionKey(getThemeName(themeEntry));
  if (!codeKey) return true;
  return !normalizeManualSelectionOptOuts(source).codes.includes(codeKey);
}

export function isManualExcerptEffectivelySelected(source, themeName, wordEntry) {
  if (!isManualThemeWordEntry(wordEntry)) return wordEntry?.selectedByUser === true;
  const optOuts = normalizeManualSelectionOptOuts(source);
  const codeKey = buildManualCodeSelectionKey(themeName);
  const excerptKey = buildManualExcerptSelectionKey(themeName, wordEntry);
  if (codeKey && optOuts.codes.includes(codeKey)) return false;
  return !excerptKey || !optOuts.excerpts.includes(excerptKey);
}

function writeManualSelectionOptOuts(source, nextOptOuts) {
  if (!source || typeof source !== "object") return normalizeManualSelectionOptOuts(nextOptOuts);
  source.manualSelectionOptOuts = normalizeManualSelectionOptOuts(nextOptOuts);
  return source.manualSelectionOptOuts;
}

export function setManualCodeSelection(source, themeName, selected) {
  const optOuts = normalizeManualSelectionOptOuts(source);
  const codeKey = buildManualCodeSelectionKey(themeName);
  if (!codeKey) return writeManualSelectionOptOuts(source, optOuts);
  const codes = new Set(optOuts.codes);
  if (selected) codes.delete(codeKey);
  else codes.add(codeKey);
  return writeManualSelectionOptOuts(source, { ...optOuts, codes: [...codes] });
}

export function setManualExcerptSelection(source, themeName, wordEntry, selected) {
  const optOuts = normalizeManualSelectionOptOuts(source);
  const excerptKey = buildManualExcerptSelectionKey(themeName, wordEntry);
  if (!excerptKey) return writeManualSelectionOptOuts(source, optOuts);
  const excerpts = new Set(optOuts.excerpts);
  if (selected) excerpts.delete(excerptKey);
  else excerpts.add(excerptKey);
  return writeManualSelectionOptOuts(source, { ...optOuts, excerpts: [...excerpts] });
}

export function selectManualCodeForNewExcerpt(source, themeName, wordEntry) {
  setManualCodeSelection(source, themeName, true);
  setManualExcerptSelection(source, themeName, wordEntry, true);
  return normalizeManualSelectionOptOuts(source);
}

export function migrateManualSelectionThemeName(source, oldThemeName, newThemeName) {
  const optOuts = normalizeManualSelectionOptOuts(source);
  const oldCodeKey = buildManualCodeSelectionKey(oldThemeName);
  const newCodeKey = buildManualCodeSelectionKey(newThemeName);
  if (!oldCodeKey || !newCodeKey || oldCodeKey === newCodeKey) {
    return writeManualSelectionOptOuts(source, optOuts);
  }

  const codes = new Set(optOuts.codes);
  if (codes.delete(oldCodeKey)) codes.add(newCodeKey);
  const oldPrefix = `${oldCodeKey}::`;
  const excerpts = optOuts.excerpts.map((key) => (
    key.startsWith(oldPrefix) ? `${newCodeKey}::${key.slice(oldPrefix.length)}` : key
  ));
  return writeManualSelectionOptOuts(source, { codes: [...codes], excerpts });
}

function themeEntryHasAiSource(entry) {
  if (!entry || typeof entry !== "object") return true;
  const source = getThemeEntrySourceKey(entry);
  if (source === "human_ai" || source === "human+ai" || source === "both" || source === "ai" || source === "llm" || source === "cloud") return true;
  if (entry.aiTagged === true || entry.ai_tagged === true) return true;
  if (entry.ai_generated === true) return true;
  return !themeEntryHasHumanSource(entry);
}

function mergeThemeWordSourceMetadata(existingEntry, candidateEntry) {
  const hasHuman = themeEntryHasHumanSource(existingEntry) || themeEntryHasHumanSource(candidateEntry);
  const hasAi = themeEntryHasAiSource(existingEntry) || themeEntryHasAiSource(candidateEntry);
  if (!(hasHuman && hasAi)) return existingEntry;
  return {
    ...existingEntry,
    ai_generated: true,
    aiTagged: true,
    humanTagged: true,
    codeSource: "human_ai",
    source: "human_ai",
  };
}

export function dedupeThemeWordEntries(words) {
  if (!Array.isArray(words)) return [];

  const indexByKey = new Map();
  const unique = [];

  words.forEach((rawEntry) => {
    const entry = buildThemeExcerptEntry(rawEntry);
    if (!entry) return;

    const key = buildThemeWordIdentityKey(entry);
    if (!key) return;
    if (indexByKey.has(key)) {
      const existingIndex = indexByKey.get(key);
      unique[existingIndex] = mergeThemeWordSourceMetadata(unique[existingIndex], entry);
      return;
    }

    indexByKey.set(key, unique.length);
    unique.push(entry);
  });

  return unique;
}

export function resolveThemeWordParticipantLabel(rawEntry) {
  const entry = buildThemeExcerptEntry(rawEntry);
  if (!entry) return "";

  const participant = String(entry.participant || "").trim();
  const tag = String(entry.tag || "").trim();

  if (participant && tag) return `${participant} · ${tag}`;
  if (participant) return participant;
  if (tag) return tag;
  return "";
}

function cloneWordEntry(wordEntry) {
  return buildThemeExcerptEntry(wordEntry);
}

function mergeUniqueArrayValues(...arrays) {
  const seen = new Set();
  const merged = [];
  arrays.forEach((arrayValue) => {
    (Array.isArray(arrayValue) ? arrayValue : []).forEach((value) => {
      const key = value && typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
      if (seen.has(key)) return;
      seen.add(key);
      merged.push(value && typeof value === "object" ? structuredClone(value) : value);
    });
  });
  return merged;
}

const PERSISTED_THEME_PAYLOAD_KEYS = [
  "selectionSource",
  "selectionStage",
  "appliedToVisualization",
  "appliedAt",
  "updatedAt",
  "visualizationPreviewState",
  "selectedByUser",
  "selectedThemesExists",
  "demoCodeManagerSeedVersion",
  "projectRevision",
];

const PERSISTED_THEME_ENTRY_KEYS = [
  "selectedByUser",
  "selectionSource",
  "selectionStage",
  "codeSource",
  "source",
  "ai_generated",
  "humanTagged",
  "human_tagged",
];

const PERSISTED_ARCHIVED_CODE_KEYS = [
  "archivedAt",
  "archivedFrom",
];

function copyDefinedProperties(target, source, keys) {
  if (!source || typeof source !== "object") return target;
  keys.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined) {
      target[key] = source[key];
    }
  });
  return target;
}

function mergeThemeEntryRecords(existingTheme, candidateTheme) {
  const existingWords = Array.isArray(existingTheme.words) ? existingTheme.words : [];
  const candidateWords = Array.isArray(candidateTheme.words) ? candidateTheme.words : [];
  const mergedTheme = {
    ...existingTheme,
    words: dedupeThemeWordEntries([...existingWords, ...candidateWords]),
    highlight: mergeUniqueArrayValues(existingTheme.highlight, candidateTheme.highlight),
    groups: mergeUniqueArrayValues(existingTheme.groups, candidateTheme.groups),
  };

  if (!normalizeThemeWordText(mergedTheme.summary) && normalizeThemeWordText(candidateTheme.summary)) {
    mergedTheme.summary = normalizeThemeWordText(candidateTheme.summary);
  }
  if (!String(mergedTheme.comment || "").trim() && String(candidateTheme.comment || "").trim()) {
    mergedTheme.comment = String(candidateTheme.comment || "");
  }
  if (!normalizeHexColor(mergedTheme.color, "") && normalizeHexColor(candidateTheme.color, "")) {
    mergedTheme.color = normalizeHexColor(candidateTheme.color, "");
  }
  copyDefinedProperties(mergedTheme, candidateTheme, PERSISTED_THEME_ENTRY_KEYS);
  return mergedTheme;
}

export function dedupeThemeEntries(rawThemes) {
  const themes = [];
  const indexByName = new Map();

  (Array.isArray(rawThemes) ? rawThemes : []).forEach((theme) => {
    if (!theme || typeof theme !== "object") return;
    const themeName = getThemeName(theme);
    const themeKey = normalizeThemeNameIdentityKey(themeName);
    if (!themeName || !themeKey) return;

    const normalizedTheme = {
      ...theme,
      themeName,
      words: Array.isArray(theme.words) ? theme.words : [],
      highlight: Array.isArray(theme.highlight) ? theme.highlight : [],
      groups: Array.isArray(theme.groups) ? theme.groups : [],
      summary: normalizeThemeWordText(theme.summary || ""),
      comment: String(theme.comment || ""),
    };

    if (indexByName.has(themeKey)) {
      const existingIndex = indexByName.get(themeKey);
      themes[existingIndex] = mergeThemeEntryRecords(themes[existingIndex], normalizedTheme);
      return;
    }

    indexByName.set(themeKey, themes.length);
    themes.push(normalizedTheme);
  });

  return themes;
}

function buildPersistedThemeEntries(rawThemes, additionalKeys = []) {
  const dedupedThemes = dedupeThemeEntries(rawThemes);
  const usedColors = new Set();

  return dedupedThemes
    .map((theme, index) => {
      const themeName = String((theme && theme.themeName) || "").trim();
      if (!themeName) return null;

      const summary = normalizeThemeWordText(theme && theme.summary || "");
      const normalizedSummary = summary.toLowerCase();
      const words = Array.isArray(theme && theme.words)
        ? dedupeThemeWordEntries(
            theme.words
              .map(cloneWordEntry)
              .filter((wordEntry) => {
                const word = normalizeThemeWordText(wordEntry?.word || "");
                return word !== "" && (!normalizedSummary || word.toLowerCase() !== normalizedSummary);
              })
          )
        : [];
      let color = normalizeHexColor(theme && theme.color, "");
      if (!color || usedColors.has(color)) {
        color = getNextThemeColorFromUsedColors(usedColors, index);
      }
      usedColors.add(color);

      const persistedTheme = {
        themeName,
        color,
        summary,
        words,
        highlight: Array.isArray(theme && theme.highlight) ? theme.highlight.slice() : [],
        groups: Array.isArray(theme && theme.groups) ? theme.groups.slice() : [],
        comment: String(theme && theme.comment || ""),
      };

      return copyDefinedProperties(
        persistedTheme,
        theme,
        [...PERSISTED_THEME_ENTRY_KEYS, ...additionalKeys]
      );
    })
    .filter(Boolean);
}

export function buildPersistedThemePayload(source) {
  const rawThemes = Array.isArray(source?.themes)
    ? source.themes
    : (Array.isArray(source) ? source : []);
  const hasArchivedCodes = Boolean(
    source
    && typeof source === "object"
    && !Array.isArray(source)
    && Object.prototype.hasOwnProperty.call(source, "archivedCodes")
  );
  const archivedCodes = hasArchivedCodes
    ? buildPersistedThemeEntries(source.archivedCodes, PERSISTED_ARCHIVED_CODE_KEYS)
    : [];
  const archivedNames = new Set(
    archivedCodes.map(theme => normalizeThemeNameIdentityKey(theme.themeName)).filter(Boolean)
  );
  const themes = buildPersistedThemeEntries(rawThemes)
    .filter(theme => !archivedNames.has(normalizeThemeNameIdentityKey(theme.themeName)));

  const payload = copyDefinedProperties({ themes }, source, PERSISTED_THEME_PAYLOAD_KEYS);
  if (hasArchivedCodes) {
    payload.archivedCodes = archivedCodes;
  }
  if (source && typeof source === "object" && Object.prototype.hasOwnProperty.call(source, "manualSelectionOptOuts")) {
    payload.manualSelectionOptOuts = normalizeManualSelectionOptOuts(source);
  }
  return payload;
}

export function archiveCodeInPayload(source, rawThemeName, archivedAt = new Date().toISOString()) {
  const payload = buildPersistedThemePayload(source || { themes: [] });
  const themeKey = normalizeThemeNameIdentityKey(rawThemeName);
  const themeIndex = payload.themes.findIndex(
    theme => normalizeThemeNameIdentityKey(theme?.themeName) === themeKey
  );
  if (!themeKey || themeIndex < 0) {
    throw new Error("Code could not be found in the active codebook.");
  }

  const archivedCode = {
    ...payload.themes[themeIndex],
    archivedAt: String(archivedAt || new Date().toISOString()),
    archivedFrom: "code_manager",
  };
  const remainingThemes = payload.themes.filter((_, index) => index !== themeIndex);
  const remainingArchivedCodes = (Array.isArray(payload.archivedCodes) ? payload.archivedCodes : [])
    .filter(theme => normalizeThemeNameIdentityKey(theme?.themeName) !== themeKey);

  return buildPersistedThemePayload({
    ...payload,
    themes: remainingThemes,
    archivedCodes: [...remainingArchivedCodes, archivedCode],
  });
}

export function restoreArchivedCodeInPayload(source, rawThemeName) {
  const payload = buildPersistedThemePayload(source || { themes: [], archivedCodes: [] });
  const themeKey = normalizeThemeNameIdentityKey(rawThemeName);
  const archivedIndex = (Array.isArray(payload.archivedCodes) ? payload.archivedCodes : [])
    .findIndex(theme => normalizeThemeNameIdentityKey(theme?.themeName) === themeKey);
  if (!themeKey || archivedIndex < 0) {
    throw new Error("Code could not be found in the archive.");
  }
  if (payload.themes.some(theme => normalizeThemeNameIdentityKey(theme?.themeName) === themeKey)) {
    throw new Error("An active code already uses this name.");
  }

  const restoredCode = { ...payload.archivedCodes[archivedIndex] };
  delete restoredCode.archivedAt;
  delete restoredCode.archivedFrom;

  return buildPersistedThemePayload({
    ...payload,
    themes: [...payload.themes, restoredCode],
    archivedCodes: payload.archivedCodes.filter((_, index) => index !== archivedIndex),
  });
}

export function persistThemePayloadLocally(source, options = {}) {
  const hasExplicitOptOuts = source && typeof source === "object"
    && Object.prototype.hasOwnProperty.call(source, "manualSelectionOptOuts");
  const storedPayload = hasExplicitOptOuts ? null : getStoredThemePayload();
  const sourceWithStoredOptOuts = !hasExplicitOptOuts && storedPayload?.manualSelectionOptOuts
    ? (Array.isArray(source)
        ? { themes: source, manualSelectionOptOuts: storedPayload.manualSelectionOptOuts }
        : { ...source, manualSelectionOptOuts: storedPayload.manualSelectionOptOuts })
    : source;
  const payload = buildPersistedThemePayload(
    sourceWithStoredOptOuts
  );
  const serialized = JSON.stringify(payload);
  const projectId = getCurrentProjectId();
  const workspaceKey = getCurrentWorkspaceKey();
  const scopedKey = getThemesStorageKey(projectId);

  if (typeof localStorage !== "undefined") {
    localStorage.setItem(scopedKey, serialized);
    if (!projectId && !workspaceKey) {
      localStorage.setItem("themesObject", serialized);
    }
  }
  if (typeof sessionStorage !== "undefined") {
    sessionStorage.setItem(scopedKey, serialized);
    if (!projectId && !workspaceKey) {
      sessionStorage.setItem("themesObject", serialized);
    }
  }

  if (options.broadcast !== false) {
    broadcastThemePayloadUpdate(payload, projectId);
  }

  return payload;
}

async function saveThemePayloadToServer(payload, options) {
  const projectId = getCurrentProjectId();
  const progress = typeof window !== "undefined" ? window.ChromaProjectProgress : null;
  const revision = progress?.revisionAfterBrowserSaves?.(projectId, payload.projectRevision);
  if (Number.isInteger(revision)) {
    payload.projectRevision = revision;
  }
  const requestPayload = options.manualDeletionIntent
    ? { ...payload, manualDeletionIntent: options.manualDeletionIntent }
    : payload;
  const response = await fetch("/api/save_selected_themes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(projectId ? { ...requestPayload, projectId } : requestPayload),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = result.error || result.details || response.statusText || `HTTP ${response.status}`;
    throw new Error(message);
  }
  const broadcastAfterRemote = options.broadcastAfterRemote === true;
  if (Number.isInteger(result.projectRevision)) {
    payload.projectRevision = result.projectRevision;
    persistThemePayloadLocally(payload, { broadcast: broadcastAfterRemote });
  } else if (broadcastAfterRemote) {
    persistThemePayloadLocally(payload);
  }
  return payload;
}

export async function persistThemePayload(source, options = {}) {
  const previousPayload = options.rollbackOnError === true ? getStoredThemePayload() : null;
  const broadcastAfterRemote = options.broadcastAfterRemote === true && options.syncRemote !== false;
  const payload = persistThemePayloadLocally(source, { broadcast: !broadcastAfterRemote });
  if (options.syncRemote === false) {
    return payload;
  }

  try {
    const progress = typeof window !== "undefined" ? window.ChromaProjectProgress : null;
    const saveChange = () => saveThemePayloadToServer(payload, options);
    if (typeof progress?.runProjectChange === "function") {
      await progress.runProjectChange(getCurrentProjectId(), saveChange);
    } else {
      await saveChange();
    }
  } catch (error) {
    console.warn("Failed to persist selected themes:", error);
    if (options.rollbackOnError === true && previousPayload) {
      persistThemePayloadLocally(previousPayload);
    }
    if (options.throwOnError === true) {
      throw error;
    }
  }

  return payload;
}

function parseRgbString(rawColor) {
  const match = String(rawColor || "").trim().match(/^rgba?\(([^)]+)\)$/i);
  if (!match) return null;
  const parts = match[1].split(",").map((value) => Number(value.trim()));
  if (parts.length < 3 || parts.slice(0, 3).some((value) => !Number.isFinite(value))) {
    return null;
  }
  return parts.slice(0, 3).map((value) => Math.max(0, Math.min(255, value)));
}

function getRgbChannels(rawColor) {
  const normalizedHex = normalizeHexColor(rawColor, "");
  if (normalizedHex) {
    return [
      parseInt(normalizedHex.slice(1, 3), 16),
      parseInt(normalizedHex.slice(3, 5), 16),
      parseInt(normalizedHex.slice(5, 7), 16),
    ];
  }
  return parseRgbString(rawColor) || [238, 237, 239];
}

export function colorToRgba(rawColor, alpha = 0.28) {
  const [r, g, b] = getRgbChannels(rawColor);
  const safeAlpha = Number.isFinite(Number(alpha)) ? Number(alpha) : 0.28;
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, safeAlpha))})`;
}

export function getContrastingTextColor(rawColor, dark = "#111111", light = "#FFFFFF") {
  const [r, g, b] = getRgbChannels(rawColor);
  const luminance = ((0.299 * r) + (0.587 * g) + (0.114 * b)) / 255;
  return luminance > 0.62 ? dark : light;
}
