import { FileMap } from "../../chromascribe-main.js";

function getCurrentProjectId() {
  const serverProjectId = typeof window !== "undefined" ? String(window.CURRENT_PROJECT_ID || "").trim() : "";
  if (serverProjectId) return serverProjectId;
  if (typeof localStorage === "undefined") return "";
  const rawValue = localStorage.getItem("currentProjectId");
  return typeof rawValue === "string" ? rawValue.trim() : "";
}

function getProjectStorageScope(projectId = getCurrentProjectId()) {
  const resolvedProjectId = String(projectId || "").trim();
  if (!resolvedProjectId) return "";
  const workspaceKey = typeof window !== "undefined" && window.USER_WORKSPACE_KEY
    ? String(window.USER_WORKSPACE_KEY).trim()
    : (typeof localStorage !== "undefined" ? String(localStorage.getItem("currentWorkspaceKey") || "").trim() : "");
  return workspaceKey ? `${workspaceKey}__${resolvedProjectId}` : resolvedProjectId;
}

function parseStoredJson(key) {
  if (!key || typeof localStorage === "undefined") return null;
  try {
    const rawValue = localStorage.getItem(key);
    return rawValue ? JSON.parse(rawValue) : null;
  } catch (error) {
    console.warn(`Unable to parse localStorage value for ${key}:`, error);
    return null;
  }
}

function getStoredFileMap(projectId = getCurrentProjectId()) {
  const storageScope = getProjectStorageScope(projectId);
  const scopedKey = storageScope ? `FileMap_MatchedData_${storageScope}` : "FileMap_MatchedData";
  const scopedValue = parseStoredJson(scopedKey);
  if (scopedValue && Array.isArray(scopedValue.participants)) {
    return scopedValue;
  }
  return null;
}

function getStoredProjectFiles(projectId = getCurrentProjectId()) {
  const scopedKey = `projectFiles_${getProjectStorageScope(projectId) || "default"}`;
  const storedValue = parseStoredJson(scopedKey);
  return Array.isArray(storedValue) ? storedValue : [];
}

function getStoredProjectFileStatus(projectId = getCurrentProjectId()) {
  const scopedKey = `projectFileStatus_${getProjectStorageScope(projectId) || "default"}`;
  const storedValue = parseStoredJson(scopedKey);
  return storedValue && typeof storedValue === "object" ? storedValue : {};
}

function getKnownParticipantCount(projectId = getCurrentProjectId()) {
  const liveParticipants = Array.isArray(FileMap.participants) ? FileMap.participants : [];
  if (liveParticipants.length > 0) return liveParticipants.length;

  const storedFileMap = getStoredFileMap(projectId);
  const storedParticipants = Array.isArray(storedFileMap?.participants) ? storedFileMap.participants : [];
  return storedParticipants.length;
}

export function normalizeParticipantCode(rawValue) {
  const text = (rawValue || "").toString().trim();
  if (!text) return "";

  let match = text.match(/^P\s*(\d+)$/i);
  if (match) return `P${parseInt(match[1], 10)}`;

  match = text.match(/^Participant\s*(\d+)$/i);
  if (match) return `P${parseInt(match[1], 10)}`;

  match = text.match(/^(\d+)$/);
  if (match) return `P${parseInt(match[1], 10)}`;

  return text.toUpperCase();
}

function extractParticipantCode(rawValue) {
  const text = (rawValue || "").toString().trim();
  if (!text) return "";

  const basename = text.split(/[\\/]/).pop() || text;
  let match = basename.match(/(^|[^A-Za-z0-9])P(\d+)(?![A-Za-z0-9])/i);
  if (match && match[2]) return `P${parseInt(match[2], 10)}`;

  match = basename.match(/^(\d+)(?=[_\.\s-])/);
  if (match && match[1]) return `P${parseInt(match[1], 10)}`;

  match = basename.match(/_pt(\d+)/i);
  if (match && match[1]) return `P${parseInt(match[1], 10)}`;

  return "";
}

function getRawAudioPath(rawEntry) {
  if (typeof rawEntry === "string") return rawEntry;
  if (!rawEntry || typeof rawEntry !== "object") return "";

  return [
    rawEntry.relativePath,
    rawEntry.savedPath,
    rawEntry.path,
    rawEntry.url,
    rawEntry.audioUrl,
    rawEntry.serverAudioUrl,
    rawEntry.originalFilename,
    rawEntry.name,
  ].find(value => typeof value === "string" && value.trim() !== "") || "";
}

export function normalizeAudioRelativePath(rawEntry) {
  let text = getRawAudioPath(rawEntry).toString().trim().replace(/\\/g, "/");
  if (!text) return "";

  try {
    text = decodeURI(text);
  } catch (_) {}

  text = text
    .replace(/^https?:\/\/[^/]+/i, "")
    .split("?")[0]
    .split("#")[0]
    .trim()
    .replace(/^\/+/, "");

  const storageMarkers = [
    "/inputs/audio_storage/",
    "/uploads/audio_storage/",
    "/uploads/audio/",
    "/audio_storage/",
  ];
  for (const marker of storageMarkers) {
    const markerIndex = text.indexOf(marker);
    if (markerIndex >= 0) {
      text = text.slice(markerIndex + marker.length);
      break;
    }
  }

  const storagePrefixes = [
    "serve_audio/",
    "static/Uploaded_files/audio_storage/",
    "Uploaded_files/audio_storage/",
    "static/audio_storage/",
    "inputs/audio_storage/",
    "audio_storage/",
    "uploads/audio_storage/",
    "uploads/audio/",
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of storagePrefixes) {
      if (text.startsWith(prefix)) {
        text = text.slice(prefix.length);
        changed = true;
      }
    }
  }

  const pathSegments = text.split("/").filter(Boolean);
  if (pathSegments.some(segment => segment === "." || segment === "..")) return "";
  return pathSegments.join("/");
}

export function buildServeAudioUrl(rawEntry) {
  const relativePath = normalizeAudioRelativePath(rawEntry);
  if (!relativePath) return "";
  return `/serve_audio/${relativePath.split("/").map(encodeURIComponent).join("/")}`;
}

function buildParticipantAudioMatch(rawAudioEntry, participantHint = "") {
  if (!rawAudioEntry) return null;

  const relativePath = normalizeAudioRelativePath(rawAudioEntry);
  const rawAudio = typeof rawAudioEntry === "object" ? rawAudioEntry : {};
  const originalFilename = ((rawAudio.originalFilename || rawAudio.name || "").toString().trim())
    || (relativePath.split(/[\\/]/).pop() || "");
  if (!relativePath && !originalFilename) return null;

  const inferredParticipant = normalizeParticipantCode(
    participantHint
    || extractParticipantCode(relativePath)
    || extractParticipantCode(originalFilename)
  );

  return {
    participant: inferredParticipant,
    audio: {
      ...rawAudio,
      type: "audio",
      relativePath: relativePath || originalFilename,
      originalFilename: originalFilename || relativePath,
    },
  };
}

function collectAudioMatchesFromFileMap(fileMap, collected, seenKeys) {
  const participants = Array.isArray(fileMap?.participants) ? fileMap.participants : [];
  participants.forEach((participantEntry) => {
    const match = buildParticipantAudioMatch(participantEntry?.audio, participantEntry?.participant);
    if (!match || !match.audio?.relativePath) return;

    const dedupeKey = match.audio.relativePath.toLowerCase();
    if (seenKeys.has(dedupeKey)) {
      const existingMatch = collected.find((entry) => entry.audio.relativePath.toLowerCase() === dedupeKey);
      if (existingMatch && !existingMatch.participant && match.participant) {
        existingMatch.participant = match.participant;
      }
      return;
    }

    seenKeys.add(dedupeKey);
    collected.push(match);
  });
}

export function getKnownAudioMatches(projectId = getCurrentProjectId()) {
  const collected = [];
  const seenKeys = new Set();
  const storedFileStatus = getStoredProjectFileStatus(projectId);

  collectAudioMatchesFromFileMap({ participants: FileMap.participants || [] }, collected, seenKeys);
  collectAudioMatchesFromFileMap(getStoredFileMap(projectId), collected, seenKeys);

  getStoredProjectFiles(projectId)
    .filter((entry) => {
      if (!entry || entry.type !== "audio") return false;
      const status = storedFileStatus?.[entry.id]?.status;
      return !status || status === "success";
    })
    .forEach((audioEntry) => {
      const match = buildParticipantAudioMatch(audioEntry, "");
      if (!match || !match.audio?.relativePath) return;

      const dedupeKey = match.audio.relativePath.toLowerCase();
      if (seenKeys.has(dedupeKey)) {
        const existingMatch = collected.find((entry) => entry.audio.relativePath.toLowerCase() === dedupeKey);
        if (existingMatch && !existingMatch.participant && match.participant) {
          existingMatch.participant = match.participant;
        }
        return;
      }

      seenKeys.add(dedupeKey);
      collected.push(match);
    });

  return collected;
}

export function projectHasUploadedAudio(projectId = getCurrentProjectId()) {
  return getKnownAudioMatches(projectId).some((entry) => {
    const relativePath = entry?.audio?.relativePath;
    return typeof relativePath === "string" && relativePath.trim() !== "";
  });
}

export function findParticipantAudio(participantId, options = {}) {
  const { allowSingleFallback = true } = options;
  const normalizedTarget = normalizeParticipantCode(participantId);
  const matches = getKnownAudioMatches();
  if (!matches.length) return null;

  if (normalizedTarget) {
    const directMatch = matches.find((entry) => normalizeParticipantCode(entry.participant) === normalizedTarget);
    if (directMatch) {
      return {
        participant: normalizedTarget,
        audio: { ...directMatch.audio },
      };
    }

    const inferredMatch = matches.find((entry) => {
      const relativePath = entry?.audio?.relativePath || entry?.audio?.originalFilename || "";
      return normalizeParticipantCode(extractParticipantCode(relativePath)) === normalizedTarget;
    });
    if (inferredMatch) {
      return {
        participant: normalizedTarget,
        audio: { ...inferredMatch.audio },
      };
    }
  }

  if (allowSingleFallback && matches.length === 1 && getKnownParticipantCount() <= 1) {
    const onlyMatch = matches[0];
    return {
      participant: normalizedTarget || onlyMatch.participant || "",
      audio: { ...onlyMatch.audio },
    };
  }

  return null;
}
