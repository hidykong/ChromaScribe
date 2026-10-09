import {
  svgObject,
  xObject,
  yObject,
  transcriptsObject,
  selectedParticipantObject,
  FileMap,
  firstClickObject,
} from "../../chromascribe-main.js";
import { addSpeeches } from "./transcripts.js?v=20260901b";
import { playBar, clearPlaybarAudio, setPlaybarAudioSource } from "./audioPlayBar.js";
import { findParticipantAudio, buildServeAudioUrl } from "./audioMatching.js?v=20260601b";
import { calculateTime } from "../../calculateTime.js";
import { barObject } from "./dragRedPlayBar.js";
import {
  getSpeechRawStartSeconds,
  getSpeechTimelineStartSeconds
} from "./timeNormalization.js";

const MIN_NON_VERBAL_CONFIDENCE = 0.0;
const MAX_NON_VERBAL_CONFIDENCE = 1.0;
const NON_VERBAL_CONFIDENCE_STEP = 0.01;
const DEFAULT_NON_VERBAL_CONFIDENCE = 0.65;
const MIN_LONG_SILENCE_SECONDS = 2.0;
const MAX_LONG_SILENCE_SECONDS = 5.0;
const LONG_SILENCE_SECONDS_STEP = 0.5;
const DEFAULT_LONG_SILENCE_SECONDS = MIN_LONG_SILENCE_SECONDS;

export const nonVerbalCueState = {
  enabled: true,
  threshold: DEFAULT_NON_VERBAL_CONFIDENCE,
  silenceMinDuration: DEFAULT_LONG_SILENCE_SECONDS,
  loading: false,
  loaded: false,
  fetchFailed: false,
  projectScopeKey: "",
  data: null,
  lastError: "",
  pendingPromise: null,
};

const HARDCODED_NON_VERBAL_CUE_TEMPLATES = {
  demo: [
    { type: "laughter", start: 32.5, duration: 1.6, confidence: 0.86 },
    { type: "long_silence", start: 126.0, duration: 2.8, confidence: 0.82 },
    { type: "laughter", start: 284.5, duration: 1.9, confidence: 0.91 },
    { type: "long_silence", start: 486.0, duration: 4.2, confidence: 0.88 },
  ],
  user: [
    { type: "long_silence", start: 46.0, duration: 3.0, confidence: 0.84 },
    { type: "laughter", start: 154.5, duration: 1.7, confidence: 0.89 },
    { type: "long_silence", start: 318.0, duration: 4.6, confidence: 0.87 },
    { type: "laughter", start: 516.0, duration: 1.5, confidence: 0.92 },
  ],
};

const HARDCODED_PARTICIPANT_NON_VERBAL_CUES = {
  demo: {
    P1: [
      { type: "laughter", start: 86.0, duration: 1.5, confidence: 0.88 },
      { type: "long_silence", start: 204.0, duration: 3.0, confidence: 0.84 },
      { type: "laughter", start: 392.5, duration: 1.8, confidence: 0.91 },
      { type: "long_silence", start: 528.0, duration: 4.2, confidence: 0.87 },
    ],
    P2: [
      { type: "long_silence", start: 72.0, duration: 3.4, confidence: 0.86 },
      { type: "laughter", start: 216.5, duration: 1.6, confidence: 0.90 },
      { type: "long_silence", start: 372.0, duration: 4.0, confidence: 0.88 },
      { type: "laughter", start: 566.0, duration: 1.7, confidence: 0.89 },
    ],
    P3: [
      { type: "long_silence", start: 52.0, duration: 2.8, confidence: 0.85 },
      { type: "laughter", start: 164.0, duration: 1.7, confidence: 0.92 },
      { type: "long_silence", start: 326.0, duration: 3.6, confidence: 0.87 },
      { type: "laughter", start: 496.5, duration: 1.5, confidence: 0.90 },
    ],
    P4: [
      { type: "long_silence", start: 54.0, duration: 2.6, confidence: 0.84 },
      { type: "laughter", start: 166.5, duration: 1.6, confidence: 0.89 },
      { type: "long_silence", start: 326.0, duration: 3.8, confidence: 0.86 },
      { type: "laughter", start: 498.0, duration: 1.7, confidence: 0.91 },
    ],
  },
  user: {
    P1: [
      { type: "laughter", start: 96.0, duration: 1.6, confidence: 0.87 },
      { type: "long_silence", start: 212.0, duration: 3.2, confidence: 0.85 },
      { type: "laughter", start: 404.0, duration: 1.8, confidence: 0.90 },
      { type: "long_silence", start: 548.0, duration: 4.0, confidence: 0.88 },
    ],
    P2: [
      { type: "long_silence", start: 84.0, duration: 3.0, confidence: 0.86 },
      { type: "laughter", start: 228.0, duration: 1.5, confidence: 0.91 },
      { type: "long_silence", start: 386.0, duration: 4.4, confidence: 0.87 },
      { type: "laughter", start: 574.0, duration: 1.7, confidence: 0.89 },
    ],
    P3: [
      { type: "long_silence", start: 52.0, duration: 2.8, confidence: 0.85 },
      { type: "laughter", start: 162.5, duration: 1.6, confidence: 0.92 },
      { type: "long_silence", start: 325.5, duration: 3.6, confidence: 0.87 },
      { type: "laughter", start: 522.0, duration: 1.8, confidence: 0.90 },
    ],
    P4: [
      { type: "long_silence", start: 52.0, duration: 2.8, confidence: 0.86 },
      { type: "laughter", start: 163.0, duration: 1.7, confidence: 0.89 },
      { type: "long_silence", start: 326.0, duration: 3.8, confidence: 0.88 },
      { type: "laughter", start: 522.0, duration: 1.6, confidence: 0.91 },
    ],
  },
};

const HARDCODED_USER_SUBSET_NON_VERBAL_CUES = {
  subsetA: {
    P1: [
      { type: "laughter", range: "00:08:06~00:08:08", confidence: 0.25 },
      { type: "long_silence", range: "00:02:40~00:02:46", confidence: 0.85 },
      { type: "laughter", range: "00:10:11~00:10:14", confidence: 0.35 },
      { type: "long_silence", range: "00:04:18~00:04:23", confidence: 0.99 },
    ],
    P3: [
      { type: "long_silence", range: "00:02:38~00:02:41", confidence: 0.85 },
      { type: "laughter", range: "00:01:47~00:01:52", confidence: 0.95 },
      { type: "long_silence", range: "00:03:50~00:03:54", confidence: 0.87 },
      { type: "laughter", range: "00:10:39~00:10:44", confidence: 0.98 },
    ],
  },
  subsetB: {
    P2: [
      { type: "laughter", range: "00:01:43~00:01:47", confidence: 0.95 },
      { type: "long_silence", range: "00:03:16~00:03:23", confidence: 0.89 },
      { type: "laughter", range: "00:05:14~00:05:17", confidence: 0.94 },
      { type: "long_silence", range: "00:06:09~00:06:15", confidence: 0.65 },
    ],
    P4: [
      { type: "laughter", range: "00:01:31~00:01:34", confidence: 0.75 },
      { type: "long_silence", range: "00:02:47~00:02:53", confidence: 0.95 },
      { type: "laughter", range: "00:06:00~00:06:10", confidence: 0.98 },
      { type: "long_silence", range: "00:08:40~00:08:44", confidence: 0.93 },
    ],
  },
};

let controlsBound = false;
let onToggleHandler = null;
let nonVerbalCueTooltip = null;
let activeControlViewMode = "timeline";

function recordNonVerbalUsageEvent(type, details = {}) {
  if (
    window.ChromaUsageLogger
    && typeof window.ChromaUsageLogger.record === "function"
  ) {
    window.ChromaUsageLogger.record(type, {
      feature: "non_verbal_audio_cues",
      ...details,
    });
  }
}

function getActiveProjectScopeKey() {
  const mode = window.APP_MODE === "demo" ? "demo" : "user";
  const defaultProjectId = mode === "demo" ? "project1" : "default";
  const projectId = (window.CURRENT_PROJECT_ID || localStorage.getItem("currentProjectId") || defaultProjectId).trim() || defaultProjectId;
  const workspaceKey = (window.USER_WORKSPACE_KEY || localStorage.getItem("currentWorkspaceKey") || "").trim();
  return `${mode}:${workspaceKey ? `${workspaceKey}__` : ""}${projectId}`;
}

function getPreferenceStorageKey(scopeKey) {
  return `non_verbal_cues_enabled_${scopeKey || "default"}`;
}

function getThresholdStorageKey(scopeKey) {
  return `non_verbal_cues_threshold_${scopeKey || "default"}`;
}

function getSilenceDurationStorageKey(scopeKey) {
  return `non_verbal_cues_silence_min_duration_${scopeKey || "default"}`;
}

function clampThreshold(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_NON_VERBAL_CONFIDENCE;
  const clamped = Math.min(MAX_NON_VERBAL_CONFIDENCE, Math.max(MIN_NON_VERBAL_CONFIDENCE, parsed));
  return Number(clamped.toFixed(2));
}

function formatThreshold(value) {
  return clampThreshold(value).toFixed(2);
}

function clampSilenceMinDuration(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_LONG_SILENCE_SECONDS;
  const clamped = Math.min(MAX_LONG_SILENCE_SECONDS, Math.max(MIN_LONG_SILENCE_SECONDS, parsed));
  return Number(clamped.toFixed(1));
}

function formatSilenceMinDuration(value) {
  return `${clampSilenceMinDuration(value).toFixed(1)}s+`;
}

function readPreference(scopeKey) {
  const preferenceKey = getPreferenceStorageKey(scopeKey);
  const raw = localStorage.getItem(preferenceKey);
  if (raw === "0") return false;
  if (raw === "1") return true;
  // Default state is ON when no preference has been saved yet.
  localStorage.setItem(preferenceKey, "1");
  return true;
}

function writePreference(scopeKey, enabled) {
  localStorage.setItem(getPreferenceStorageKey(scopeKey), enabled ? "1" : "0");
}

function readThresholdPreference(scopeKey) {
  const raw = localStorage.getItem(getThresholdStorageKey(scopeKey));
  if (raw === null || raw === undefined || raw === "") return DEFAULT_NON_VERBAL_CONFIDENCE;
  return clampThreshold(raw);
}

function writeThresholdPreference(scopeKey, threshold) {
  localStorage.setItem(getThresholdStorageKey(scopeKey), formatThreshold(threshold));
}

function readSilenceDurationPreference(scopeKey) {
  const raw = localStorage.getItem(getSilenceDurationStorageKey(scopeKey));
  if (raw === null || raw === undefined || raw === "") return DEFAULT_LONG_SILENCE_SECONDS;
  return clampSilenceMinDuration(raw);
}

function writeSilenceDurationPreference(scopeKey, durationSeconds) {
  localStorage.setItem(
    getSilenceDurationStorageKey(scopeKey),
    clampSilenceMinDuration(durationSeconds).toFixed(1)
  );
}

function ensureScopeState() {
  const scopeKey = getActiveProjectScopeKey();
  if (scopeKey !== nonVerbalCueState.projectScopeKey) {
    nonVerbalCueState.projectScopeKey = scopeKey;
    nonVerbalCueState.enabled = readPreference(scopeKey);
    nonVerbalCueState.threshold = readThresholdPreference(scopeKey);
    nonVerbalCueState.silenceMinDuration = readSilenceDurationPreference(scopeKey);
    nonVerbalCueState.loading = false;
    nonVerbalCueState.loaded = false;
    nonVerbalCueState.fetchFailed = false;
    nonVerbalCueState.data = null;
    nonVerbalCueState.lastError = "";
    nonVerbalCueState.pendingPromise = null;
  }
  return scopeKey;
}

function getStoredFileMapForCurrentProject() {
  if (typeof localStorage === "undefined") return null;
  const rawProjectId = window.CURRENT_PROJECT_ID || localStorage.getItem("currentProjectId");
  const projectId = typeof rawProjectId === "string" ? rawProjectId.trim() : "";
  const workspaceKey = (window.USER_WORKSPACE_KEY || localStorage.getItem("currentWorkspaceKey") || "").trim();
  const storageScope = projectId && workspaceKey ? `${workspaceKey}__${projectId}` : projectId;
  const matchedKey = storageScope ? `FileMap_MatchedData_${storageScope}` : "FileMap_MatchedData";
  const serialized = localStorage.getItem(matchedKey);
  if (!serialized) return null;

  try {
    return JSON.parse(serialized);
  } catch (error) {
    console.warn("Unable to parse stored FileMap while checking non-verbal cue availability:", error);
    return null;
  }
}

function getParticipantsForAudioAvailability() {
  const liveParticipants = Array.isArray(FileMap.participants) ? FileMap.participants : [];
  if (liveParticipants.length > 0) {
    return liveParticipants;
  }

  const storedFileMap = getStoredFileMapForCurrentProject();
  return Array.isArray(storedFileMap?.participants) ? storedFileMap.participants : [];
}

function projectHasLinkedAudio() {
  if (window.APP_MODE === "demo") return true;

  return getParticipantsForAudioAvailability().some((participant) => {
    const relativePath = participant?.audio?.relativePath;
    return typeof relativePath === "string" && relativePath.trim() !== "";
  });
}

function getNonVerbalControlAvailability(viewMode = activeControlViewMode) {
  const mode = String(viewMode || "timeline").toLowerCase();
  const cuesSupportedByView = mode === "timeline" || mode === "question";

  if (!cuesSupportedByView) {
    return {
      enabled: false,
      badgeText: "Disabled",
      reason: "Non-verbal cues are only available in Timeline and Question views.",
    };
  }

  if (!projectHasLinkedAudio()) {
    return {
      enabled: false,
      badgeText: "No audio",
      reason: "Upload an audio file to enable non-verbal cues.",
    };
  }

  return {
    enabled: true,
    badgeText: "",
    reason: "",
  };
}

export function invalidateNonVerbalCueData() {
  ensureScopeState();
  nonVerbalCueState.loading = false;
  nonVerbalCueState.loaded = false;
  nonVerbalCueState.fetchFailed = false;
  nonVerbalCueState.data = null;
  nonVerbalCueState.lastError = "";
  nonVerbalCueState.pendingPromise = null;
  updateToggleUi();
}

function updateThresholdUi() {
  const thresholdSlider = document.getElementById("nonverbal-threshold-slider");
  const thresholdValue = document.getElementById("nonverbal-threshold-value");
  const silenceMinSlider = document.getElementById("nonverbal-silence-min-slider");
  const silenceMinValue = document.getElementById("nonverbal-silence-min-value");
  const thresholdText = formatThreshold(nonVerbalCueState.threshold);
  const silenceMinNumericText = clampSilenceMinDuration(nonVerbalCueState.silenceMinDuration).toFixed(1);

  if (thresholdSlider) {
    thresholdSlider.min = String(MIN_NON_VERBAL_CONFIDENCE);
    thresholdSlider.max = String(MAX_NON_VERBAL_CONFIDENCE);
    thresholdSlider.step = String(NON_VERBAL_CONFIDENCE_STEP);
    thresholdSlider.value = thresholdText;
  }

  if (thresholdValue) {
    thresholdValue.textContent = thresholdText;
  }

  if (silenceMinSlider) {
    silenceMinSlider.min = String(MIN_LONG_SILENCE_SECONDS);
    silenceMinSlider.max = String(MAX_LONG_SILENCE_SECONDS);
    silenceMinSlider.step = String(LONG_SILENCE_SECONDS_STEP);
    silenceMinSlider.value = silenceMinNumericText;
  }

  if (silenceMinValue) {
    silenceMinValue.textContent = formatSilenceMinDuration(nonVerbalCueState.silenceMinDuration);
  }
}

function updateToggleUi() {
  const toggle = document.getElementById("nonverbal-cues-toggle");
  const stateBadge = document.getElementById("nonverbal-cues-state");
  const availability = getNonVerbalControlAvailability(activeControlViewMode);
  updateThresholdUi();

  if (toggle) {
    toggle.checked = availability.enabled ? !!nonVerbalCueState.enabled : false;
  }
  if (!stateBadge) return;

  if (!availability.enabled) {
    stateBadge.textContent = availability.badgeText || "Disabled";
    stateBadge.classList.remove("on", "loading", "error");
    stateBadge.classList.add("disabled");
    return;
  }

  stateBadge.classList.remove("disabled");

  if (!nonVerbalCueState.enabled) {
    stateBadge.textContent = "Off";
    stateBadge.classList.remove("on", "loading", "error", "disabled");
    return;
  }
  if (nonVerbalCueState.loading) {
    stateBadge.textContent = "Loading...";
    stateBadge.classList.remove("on", "error", "disabled");
    stateBadge.classList.add("loading");
    return;
  }
  if (nonVerbalCueState.fetchFailed) {
    stateBadge.textContent = "Unavailable";
    stateBadge.classList.remove("on", "loading", "disabled");
    stateBadge.classList.add("error");
    return;
  }
  stateBadge.textContent = "On";
  stateBadge.classList.remove("loading", "error", "disabled");
  stateBadge.classList.add("on");
}

export function initializeNonVerbalCueControls(onToggle) {
  ensureScopeState();
  onToggleHandler = typeof onToggle === "function" ? onToggle : null;

  const toggle = document.getElementById("nonverbal-cues-toggle");
  const thresholdSlider = document.getElementById("nonverbal-threshold-slider");
  const silenceMinSlider = document.getElementById("nonverbal-silence-min-slider");
  if (!toggle) return;

  toggle.checked = !!nonVerbalCueState.enabled;
  updateToggleUi();

  if (controlsBound) return;
  controlsBound = true;

  toggle.addEventListener("change", function () {
    const scopeKey = ensureScopeState();
    nonVerbalCueState.enabled = !!this.checked;
    writePreference(scopeKey, nonVerbalCueState.enabled);
    updateToggleUi();
    if (typeof onToggleHandler === "function") {
      onToggleHandler(nonVerbalCueState.enabled);
    }
  });

  if (thresholdSlider) {
    thresholdSlider.addEventListener("input", function () {
      const scopeKey = ensureScopeState();
      nonVerbalCueState.threshold = clampThreshold(this.value);
      writeThresholdPreference(scopeKey, nonVerbalCueState.threshold);
      updateThresholdUi();
      drawNonVerbalCueLayer();
    });
  }

  if (silenceMinSlider) {
    silenceMinSlider.addEventListener("input", function () {
      const scopeKey = ensureScopeState();
      nonVerbalCueState.silenceMinDuration = clampSilenceMinDuration(this.value);
      writeSilenceDurationPreference(scopeKey, nonVerbalCueState.silenceMinDuration);
      updateThresholdUi();
      drawNonVerbalCueLayer();
    });
  }
}

export function setNonVerbalCueControlForView(viewMode) {
  const panel = document.getElementById("nonverbal-cues-panel");
  const toggle = document.getElementById("nonverbal-cues-toggle");
  const thresholdSlider = document.getElementById("nonverbal-threshold-slider");
  const silenceMinSlider = document.getElementById("nonverbal-silence-min-slider");
  const mode = (viewMode || "timeline").toLowerCase();
  activeControlViewMode = mode;
  const availability = getNonVerbalControlAvailability(mode);
  const controlsEnabled = availability.enabled;

  if (panel) {
    panel.classList.toggle("nonverbal-disabled", !controlsEnabled);
    panel.setAttribute("aria-disabled", controlsEnabled ? "false" : "true");
    if (controlsEnabled) {
      panel.removeAttribute("title");
    } else {
      panel.setAttribute("title", availability.reason);
    }
  }
  if (toggle) {
    toggle.disabled = !controlsEnabled;
  }
  if (thresholdSlider) {
    thresholdSlider.disabled = !controlsEnabled;
  }
  if (silenceMinSlider) {
    silenceMinSlider.disabled = !controlsEnabled;
  }
  if (!controlsEnabled) {
    clearNonVerbalCueLayer();
  }
  updateToggleUi();
}

function getHardcodedCueModeKey() {
  return window.APP_MODE === "demo" ? "demo" : "user";
}

function sortParticipantIds(participantIds) {
  return [...participantIds].sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
}

function normalizeParticipantCueKey(participantId) {
  return String(participantId || "").trim().toUpperCase();
}

function getParticipantCueList(cueMap, participantId) {
  if (!cueMap || typeof cueMap !== "object") return null;
  const direct = cueMap[participantId];
  if (Array.isArray(direct)) return direct;
  const normalized = cueMap[normalizeParticipantCueKey(participantId)];
  return Array.isArray(normalized) ? normalized : null;
}

function getParticipantFileMapEntry(participantId) {
  const target = normalizeParticipantCueKey(participantId);
  return getParticipantsForAudioAvailability().find((participant) =>
    normalizeParticipantCueKey(participant?.participant) === target
  ) || null;
}

function getParticipantTranscriptDescriptor(participantId) {
  const fileMapEntry = getParticipantFileMapEntry(participantId);
  const rawTranscript = fileMapEntry?.transcript;
  const transcript = rawTranscript && typeof rawTranscript === "object" ? rawTranscript : {};
  return [
    typeof rawTranscript === "string" ? rawTranscript : "",
    transcript.originalFilename,
    transcript.filename,
    transcript.fileName,
    transcript.name,
    transcript.relativePath,
    transcript.path,
    fileMapEntry?.transcriptOriginalFilename,
    fileMapEntry?.transcriptFilename,
  ]
    .filter(value => typeof value === "string" && value.trim() !== "")
    .join(" ");
}

function getUserSubsetCueKey(participantId) {
  if (window.APP_MODE === "demo") return "";
  const transcriptDescriptor = getParticipantTranscriptDescriptor(participantId);
  if (/subset[\s_-]*a/i.test(transcriptDescriptor)) return "subsetA";
  if (/subset[\s_-]*b/i.test(transcriptDescriptor)) return "subsetB";
  return "";
}

function getHardcodedCueParticipantIds() {
  const audioBackedParticipantIds = new Set();
  getParticipantsForAudioAvailability().forEach((participant) => {
    const participantId = String(participant?.participant || "").trim();
    const hasAudio = typeof participant?.audio?.relativePath === "string" && participant.audio.relativePath.trim() !== "";
    if (participantId && (hasAudio || window.APP_MODE === "demo")) {
      audioBackedParticipantIds.add(participantId);
    }
  });
  if (audioBackedParticipantIds.size > 0) {
    return sortParticipantIds(audioBackedParticipantIds);
  }

  const fallbackParticipantIds = new Set();
  if (yObject.y && typeof yObject.y.domain === "function") {
    yObject.y.domain().forEach((participantId) => {
      const normalized = String(participantId || "").trim();
      if (normalized) fallbackParticipantIds.add(normalized);
    });
  }
  Object.keys(transcriptsObject.transcripts || {}).forEach((participantId) => {
    const transcript = transcriptsObject.transcripts[participantId];
    if (Array.isArray(transcript) && transcript.length > 0) {
      fallbackParticipantIds.add(participantId);
    }
  });
  return sortParticipantIds(fallbackParticipantIds);
}

function rotateCueTemplates(templates, participantIndex) {
  if (!Array.isArray(templates) || templates.length === 0) return [];
  const offset = participantIndex % templates.length;
  return templates.slice(offset).concat(templates.slice(0, offset));
}

function getCueTemplatesForParticipant(modeKey, participantId, participantIndex) {
  if (modeKey === "user") {
    const subsetKey = getUserSubsetCueKey(participantId);
    if (subsetKey) {
      const subsetTemplates = getParticipantCueList(HARDCODED_USER_SUBSET_NON_VERBAL_CUES[subsetKey], participantId);
      return Array.isArray(subsetTemplates) ? subsetTemplates : [];
    }
  }

  const participantTemplates = getParticipantCueList(HARDCODED_PARTICIPANT_NON_VERBAL_CUES[modeKey], participantId);
  if (participantTemplates && participantTemplates.length > 0) {
    return participantTemplates;
  }
  const templates = HARDCODED_NON_VERBAL_CUE_TEMPLATES[modeKey] || HARDCODED_NON_VERBAL_CUE_TEMPLATES.user;
  return rotateCueTemplates(templates, participantIndex);
}

function getCuePlacementBounds(participantId) {
  const transcriptBounds = getTranscriptBoundsInSeconds(participantId);
  return {
    start: Math.max(0, safeNumber(transcriptBounds.start, 0)),
    span: Math.max(20, safeNumber(transcriptBounds.span, 0)),
  };
}

function parseCueTimestampSeconds(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const text = String(value || "").trim();
  if (!text) return fallback;
  if (/^-?\d+(\.\d+)?$/.test(text)) {
    return Number(text);
  }
  const parts = text.split(":").map(part => part.trim());
  if (parts.length === 3) {
    const hours = Number(parts[0]);
    const minutes = Number(parts[1]);
    const seconds = Number(parts[2]);
    if ([hours, minutes, seconds].every(Number.isFinite)) {
      return (hours * 3600) + (minutes * 60) + seconds;
    }
  }
  if (parts.length === 2) {
    const minutes = Number(parts[0]);
    const seconds = Number(parts[1]);
    if (Number.isFinite(minutes) && Number.isFinite(seconds)) {
      return (minutes * 60) + seconds;
    }
  }
  return fallback;
}

function getCueTimestampRange(template, fallbackStart) {
  const rangeText = typeof template?.range === "string" && template.range.includes("~")
    ? template.range
    : (typeof template?.start === "string" && template.start.includes("~") ? template.start : "");
  if (rangeText) {
    const [rangeStart, rangeEnd] = rangeText.split("~").map(value => value.trim());
    return {
      start: parseCueTimestampSeconds(rangeStart, fallbackStart),
      end: parseCueTimestampSeconds(rangeEnd, Number.NaN),
    };
  }
  return {
    start: parseCueTimestampSeconds(template?.start, fallbackStart),
    end: parseCueTimestampSeconds(template?.end, Number.NaN),
  };
}

function buildHardcodedCueSegment(participantId, template, cueIndex) {
  const bounds = getCuePlacementBounds(participantId);
  const fallbackStart = 30 + (cueIndex * 90);
  const range = getCueTimestampRange(template, fallbackStart);
  const requestedDuration = safeNumber(template.duration, 1.5);
  const duration = range.end > range.start
    ? Math.max(0.8, range.end - range.start)
    : Math.max(0.8, requestedDuration);
  const maxOffset = Math.max(0, bounds.span - duration - 0.2);
  const requestedStart = range.start;
  const offset = Math.min(maxOffset, Math.max(0, requestedStart));
  const start = Number((bounds.start + offset).toFixed(2));
  const end = Number((start + duration).toFixed(2));

  return {
    id: `hardcoded-${getHardcodedCueModeKey()}-${participantId}-${template.type}-${cueIndex + 1}`,
    start,
    end,
    duration: Number(duration.toFixed(2)),
    confidence: Number(safeNumber(template.confidence, 0.85).toFixed(2)),
    source: `hardcoded_${getHardcodedCueModeKey()}`,
  };
}

function buildHardcodedNonVerbalCuePayload() {
  const modeKey = getHardcodedCueModeKey();
  const participants = {};

  getHardcodedCueParticipantIds().forEach((participantId, participantIndex) => {
    const templates = getCueTemplatesForParticipant(modeKey, participantId, participantIndex);
    const segments = {
      laughter: [],
      long_silence: [],
    };
    templates.forEach((template, cueIndex) => {
      const cueType = template.type === "long_silence" ? "long_silence" : "laughter";
      segments[cueType].push(buildHardcodedCueSegment(participantId, template, cueIndex));
    });
    participants[participantId] = {
      participantId,
      generatedBy: `hardcoded_${modeKey}`,
      segments,
    };
  });

  return {
    cached: true,
    hardcoded: true,
    source: `hardcoded_${modeKey}_nonverbal_cues`,
    participants,
  };
}

export async function ensureNonVerbalCueData(force = false) {
  ensureScopeState();
  const availability = getNonVerbalControlAvailability(activeControlViewMode);

  if (!availability.enabled) {
    nonVerbalCueState.loading = false;
    nonVerbalCueState.fetchFailed = false;
    nonVerbalCueState.lastError = "";
    nonVerbalCueState.pendingPromise = null;
    updateToggleUi();
    return null;
  }

  if (!force && nonVerbalCueState.loaded && nonVerbalCueState.data) {
    updateToggleUi();
    return nonVerbalCueState.data;
  }
  if (!force && nonVerbalCueState.loading && nonVerbalCueState.pendingPromise) {
    return nonVerbalCueState.pendingPromise;
  }

  nonVerbalCueState.loading = true;
  nonVerbalCueState.fetchFailed = false;
  nonVerbalCueState.lastError = "";
  updateToggleUi();

  nonVerbalCueState.pendingPromise = Promise.resolve()
    .then(() => {
      // Dynamic audio detection is intentionally disabled for now; use balanced demo/user cue sets.
      // const query = force ? `?force=1&t=${Date.now()}` : `?t=${Date.now()}`;
      // return fetch(`/api/non_verbal_audio_cues${query}`, { cache: "no-store" }).then(response => response.json());
      const resolvedPayload = buildHardcodedNonVerbalCuePayload();
      nonVerbalCueState.data = resolvedPayload;
      nonVerbalCueState.loaded = true;
      nonVerbalCueState.fetchFailed = false;
      recordNonVerbalUsageEvent("feature_data_loaded", {
        cached: !!resolvedPayload?.cached,
        forceRefresh: !!force,
        hardcoded: !!resolvedPayload?.hardcoded,
        participantCount: Object.keys(resolvedPayload?.participants || {}).length,
      });
      return nonVerbalCueState.data;
    })
    .catch((error) => {
      nonVerbalCueState.fetchFailed = true;
      nonVerbalCueState.loaded = false;
      nonVerbalCueState.data = null;
      nonVerbalCueState.lastError = error?.message || "Unknown error";
      console.warn("Unable to load non-verbal audio cues:", error);
      recordNonVerbalUsageEvent("feature_data_failed", {
        forceRefresh: !!force,
        error: nonVerbalCueState.lastError,
      });
      return null;
    })
    .finally(() => {
      nonVerbalCueState.loading = false;
      nonVerbalCueState.pendingPromise = null;
      updateToggleUi();
    });

  return nonVerbalCueState.pendingPromise;
}

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatSeconds(seconds) {
  const total = Math.max(0, Math.floor(safeNumber(seconds, 0)));
  const minutes = Math.floor(total / 60);
  const sec = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function ensureNonVerbalCueTooltip() {
  let tooltip = nonVerbalCueTooltip;
  if (!tooltip || tooltip.empty()) {
    tooltip = d3.select("body").select("#nonverbal-cue-tooltip");
    if (tooltip.empty()) {
      tooltip = d3.select("body")
        .append("div")
        .attr("id", "nonverbal-cue-tooltip")
        .attr("class", "nonverbal-cue-tooltip");
    }
    nonVerbalCueTooltip = tooltip;
  }
  return tooltip;
}

function detailedTimestamp(seconds) {
  const safeSeconds = Math.max(0, safeNumber(seconds, 0));
  return `${formatSeconds(safeSeconds)} (${safeSeconds.toFixed(1)}s)`;
}

function buildCueTooltipHtml(payload) {
  const startText = detailedTimestamp(payload?.start);
  const endText = detailedTimestamp(payload?.end);
  const durationText = `${Math.max(0, safeNumber(payload?.duration, 0)).toFixed(2)}s`;
  const confidenceText = safeNumber(payload?.confidence, 0).toFixed(2);
  const participantText = String(payload?.participantId || "").trim() || "Unknown";
  const labelText = String(payload?.label || "Cue");
  const emojiText = String(payload?.emoji || "");

  const parts = [
    `<div class="nv-tooltip-title">${emojiText} ${labelText}</div>`,
    `<div class="nv-tooltip-row"><span>Participant</span><strong>${participantText}</strong></div>`,
    `<div class="nv-tooltip-row"><span>Start</span><strong>${startText}</strong></div>`,
    `<div class="nv-tooltip-row"><span>End</span><strong>${endText}</strong></div>`,
    `<div class="nv-tooltip-row"><span>Duration</span><strong>${durationText}</strong></div>`,
    `<div class="nv-tooltip-row"><span>Confidence</span><strong>${confidenceText}</strong></div>`,
    `<div class="nv-tooltip-hint">Click to jump</div>`,
  ];

  const hasRawWindow = (
    Number.isFinite(payload?.audioStart)
    && Number.isFinite(payload?.audioEnd)
    && (
      Math.abs(payload.audioStart - payload.start) > 0.5
      || Math.abs(payload.audioEnd - payload.end) > 0.5
    )
  );
  if (hasRawWindow) {
    const rawStart = detailedTimestamp(payload.audioStart);
    const rawEnd = detailedTimestamp(payload.audioEnd);
    parts.splice(
      5,
      0,
      `<div class="nv-tooltip-row"><span>Clip window</span><strong>${rawStart} - ${rawEnd}</strong></div>`
    );
  }

  return parts.join("");
}

function moveNonVerbalCueTooltip(eventLike) {
  if (!eventLike) return;
  const tooltip = ensureNonVerbalCueTooltip();
  const pageX = safeNumber(eventLike.pageX, 0);
  const pageY = safeNumber(eventLike.pageY, 0);
  const offsetX = 14;
  const offsetY = 14;
  const margin = 8;

  const tooltipNode = tooltip.node();
  const width = safeNumber(tooltipNode?.offsetWidth, 240);
  const height = safeNumber(tooltipNode?.offsetHeight, 120);
  const viewportRight = safeNumber(window.scrollX, 0) + safeNumber(window.innerWidth, 0);
  const viewportBottom = safeNumber(window.scrollY, 0) + safeNumber(window.innerHeight, 0);

  let left = pageX + offsetX;
  let top = pageY + offsetY;

  if (left + width + margin > viewportRight) {
    left = pageX - width - offsetX;
  }
  if (top + height + margin > viewportBottom) {
    top = pageY - height - offsetY;
  }

  left = Math.max(safeNumber(window.scrollX, 0) + margin, left);
  top = Math.max(safeNumber(window.scrollY, 0) + margin, top);

  tooltip
    .style("left", `${left}px`)
    .style("top", `${top}px`);
}

function showNonVerbalCueTooltip(eventLike, payload) {
  const tooltip = ensureNonVerbalCueTooltip();
  tooltip
    .html(buildCueTooltipHtml(payload))
    .style("display", "block")
    .style("opacity", "1");
  moveNonVerbalCueTooltip(eventLike);
}

function hideNonVerbalCueTooltip() {
  const tooltip = ensureNonVerbalCueTooltip();
  tooltip
    .style("opacity", "0")
    .style("display", "none");
}

function getParticipantTranscript(participantId) {
  if (!participantId) return [];
  return transcriptsObject.transcripts?.[participantId] || [];
}

function getTranscriptBoundsInSeconds(participantId) {
  const transcript = getParticipantTranscript(participantId);
  if (!Array.isArray(transcript) || transcript.length === 0) {
    return { start: 0, end: 0, span: 0 };
  }
  const validSeconds = transcript
    .map((speech) => getSpeechRawStartSeconds(speech))
    .filter((seconds) => Number.isFinite(seconds));
  if (!validSeconds.length) {
    return { start: 0, end: 0, span: 0 };
  }
  const start = Math.max(0, validSeconds[0]);
  const end = Math.max(start, validSeconds[validSeconds.length - 1]);
  return { start, end, span: end - start };
}

function getCueMaxEndSeconds(payload) {
  if (!payload || !payload.segments) return 0;
  const laughter = Array.isArray(payload.segments.laughter) ? payload.segments.laughter : [];
  const silence = Array.isArray(payload.segments.long_silence) ? payload.segments.long_silence : [];
  const allSegments = laughter.concat(silence);
  if (!allSegments.length) return 0;
  return allSegments.reduce((maxValue, segment) => Math.max(maxValue, safeNumber(segment?.end, 0)), 0);
}

function getCueMinStartSeconds(payload) {
  if (!payload || !payload.segments) return 0;
  const laughter = Array.isArray(payload.segments.laughter) ? payload.segments.laughter : [];
  const silence = Array.isArray(payload.segments.long_silence) ? payload.segments.long_silence : [];
  const allSegments = laughter.concat(silence);
  if (!allSegments.length) return 0;
  return allSegments.reduce((minValue, segment) => Math.min(minValue, safeNumber(segment?.start, 0)), Number.POSITIVE_INFINITY);
}

function inferCueDisplayTransform(participantId, payload) {
  const transcriptBounds = getTranscriptBoundsInSeconds(participantId);
  const cueMaxEnd = getCueMaxEndSeconds(payload);
  const cueMinStart = getCueMinStartSeconds(payload);
  if (!cueMaxEnd || !transcriptBounds.start) {
    return { offsetSeconds: 0, scale: 1 };
  }

  // If cues are already on the raw transcript clock, subtract the transcript's
  // first timestamp so the visualization still starts at elapsed 00:00.
  if (cueMinStart >= Math.max(0, transcriptBounds.start - 5)) {
    return { offsetSeconds: -transcriptBounds.start, scale: 1 };
  }

  // If transcript starts far from 00:00 and cue timeline fits inside transcript span,
  // cues are likely relative to a trimmed clip and already belong on the elapsed timeline.
  if (transcriptBounds.start >= 60 && cueMaxEnd <= (transcriptBounds.span + 60)) {
    const scale = transcriptBounds.span > (cueMaxEnd * 1.25)
      ? (transcriptBounds.span / cueMaxEnd)
      : 1;
    return { offsetSeconds: 0, scale };
  }
  return { offsetSeconds: 0, scale: 1 };
}

function applyCueDisplayTransform(segments, transform) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return Array.isArray(segments) ? segments : [];
  }
  const offsetSeconds = safeNumber(transform?.offsetSeconds, 0);
  const scale = Math.max(0.01, safeNumber(transform?.scale, 1));

  if (!offsetSeconds && scale === 1) {
    return segments.map((segment) => ({
      ...segment,
      _audioStart: safeNumber(segment?.start, 0),
      _audioEnd: safeNumber(segment?.end, safeNumber(segment?.start, 0)),
    }));
  }

  return segments.map((segment) => {
    const rawStart = Math.max(0, safeNumber(segment?.start, 0));
    const rawEnd = Math.max(rawStart + 0.05, safeNumber(segment?.end, rawStart + 0.05));
    const start = Math.max(0, (rawStart * scale) + offsetSeconds);
    const end = Math.max(start + 0.05, (rawEnd * scale) + offsetSeconds);
    return { ...segment, start, end, _audioStart: rawStart, _audioEnd: rawEnd };
  });
}

function findClosestTranscriptSpeech(participantId, targetSeconds) {
  const transcript = getParticipantTranscript(participantId);
  if (!transcript.length) return { speech: null, index: -1 };

  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < transcript.length; i++) {
    const speech = transcript[i];
    const speechSeconds = getSpeechTimelineStartSeconds(speech);
    const distance = Math.abs(speechSeconds - targetSeconds);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  return { speech: transcript[bestIndex] || null, index: bestIndex };
}

function ensureParticipantAudioSource(participantId) {
  const participantMatch = findParticipantAudio(participantId);
  const audioSrc = buildServeAudioUrl(participantMatch?.audio);
  if (!audioSrc) return false;
  return setPlaybarAudioSource(audioSrc);
}

function seekToCue(participantId, cueStartSeconds) {
  if (!participantId || !Number.isFinite(cueStartSeconds)) return;

  const { speech, index } = findClosestTranscriptSpeech(participantId, cueStartSeconds);
  const transcript = getParticipantTranscript(participantId);
  selectedParticipantObject.selectedParticipant = participantId;

  if (speech && transcript.length) {
    const selectedSpeech = { ...speech, _transcriptIndex: index };
    addSpeeches(selectedSpeech, transcript);
    firstClickObject.firstClick = false;
    firstClickObject.object = [
      selectedSpeech.participant || participantId,
      selectedSpeech.timestamp || "",
      selectedSpeech.speaker || "",
      selectedSpeech.tag || "",
      String(index),
    ].join("|");
  }

  const hasAudio = ensureParticipantAudioSource(participantId);
  const cueTimestamp = calculateTime(Math.max(0, Math.floor(cueStartSeconds)));
  if (hasAudio) {
    playBar({ participant: participantId, timestamp: cueTimestamp });
  } else {
    const now = Math.max(0, Math.floor(cueStartSeconds));
    clearPlaybarAudio({
      displaySeconds: now,
      maxDisplaySeconds: now,
      reason: "Audio not provided for this participant."
    });
  }

  if (barObject.bar && !barObject.bar.empty()) {
    barObject.bar
      .attr("x", xObject.x(cueStartSeconds))
      .attr("y", yObject.y(participantId) || -9999)
      .style("opacity", 1)
      .raise();
  }
}

function segmentDuration(segment) {
  const start = safeNumber(segment?.start, 0);
  const end = safeNumber(segment?.end, start);
  return Math.max(0, end - start);
}

function segmentConfidence(segment) {
  return safeNumber(segment?.confidence, 1);
}

function filterSegmentsByConfidence(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return [];
  return segments.filter((segment) => segmentConfidence(segment) >= nonVerbalCueState.threshold);
}

function filterLongSilenceSegments(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return [];
  return segments.filter((segment) => (
    segmentConfidence(segment) >= nonVerbalCueState.threshold
    && segmentDuration(segment) >= nonVerbalCueState.silenceMinDuration
  ));
}

function isQuestionViewMode() {
  const mode = String(window.view || "timeline").toLowerCase();
  return mode === "question";
}

function isInterviewerSpeech(speech) {
  const speaker = String(speech?.speaker || "").trim().toLowerCase();
  return speaker === "s1" || speaker === "interviewer";
}

function findNearestQuestionSpeechRect(participantId, cueStartSeconds) {
  if (!svgObject.svg || svgObject.svg.empty()) return null;
  const speechRects = svgObject.svg.selectAll(".speech-rect");
  if (speechRects.empty()) return null;

  let bestNonInterviewer = null;
  let bestNonInterviewerDiff = Number.POSITIVE_INFINITY;
  let bestAny = null;
  let bestAnyDiff = Number.POSITIVE_INFINITY;

  speechRects.each(function(boundSpeech) {
    if (!boundSpeech) return;
    if (String(boundSpeech.participant || "") !== String(participantId || "")) return;

    const timestampSeconds = getSpeechTimelineStartSeconds(boundSpeech);
    if (!Number.isFinite(timestampSeconds)) return;

    const diff = Math.abs(timestampSeconds - cueStartSeconds);
    if (diff < bestAnyDiff) {
      bestAnyDiff = diff;
      bestAny = this;
    }

    if (!isInterviewerSpeech(boundSpeech) && diff < bestNonInterviewerDiff) {
      bestNonInterviewerDiff = diff;
      bestNonInterviewer = this;
    }
  });

  return bestNonInterviewer || bestAny;
}

function findNearestTimelineSpeechRect(participantId, cueStartSeconds) {
  if (!svgObject.svg || svgObject.svg.empty()) return null;
  if (!participantId) return null;

  const selector = `.speech-rects-${String(participantId).replace(/"/g, '\\"')}`;
  const speechRects = svgObject.svg.selectAll(selector);
  if (speechRects.empty()) return null;

  let bestNonInterviewer = null;
  let bestNonInterviewerDiff = Number.POSITIVE_INFINITY;
  let bestAny = null;
  let bestAnyDiff = Number.POSITIVE_INFINITY;

  speechRects.each(function(boundSpeech) {
    if (!boundSpeech) return;
    const timestampSeconds = getSpeechTimelineStartSeconds(boundSpeech);
    if (!Number.isFinite(timestampSeconds)) return;

    const diff = Math.abs(timestampSeconds - cueStartSeconds);
    if (diff < bestAnyDiff) {
      bestAnyDiff = diff;
      bestAny = this;
    }

    if (!isInterviewerSpeech(boundSpeech) && diff < bestNonInterviewerDiff) {
      bestNonInterviewerDiff = diff;
      bestNonInterviewer = this;
    }
  });

  return bestNonInterviewer || bestAny;
}

function drawCueSegments(layer, participantId, segments, cueType) {
  if (!Array.isArray(segments) || segments.length === 0) return;
  if (!yObject.y || typeof yObject.y !== "function") return;

  const rowY = yObject.y(participantId);
  if (rowY === undefined || rowY === null) return;

  const rowHeight = Math.max(20, safeNumber(yObject.y.bandwidth ? yObject.y.bandwidth() : 20, 20));
  const participantSpeechY = rowY + 17;
  const participantSpeechHeight = Math.max(20, Math.min(40, rowHeight - 18));
  const cueHeight = 10;
  const questionView = isQuestionViewMode();
  const style = cueType === "laughter"
    ? {
      fill: "#FFD87C",
      stroke: "#F59E0B",
      emoji: "😂",
      y: participantSpeechY + Math.max(1, Math.floor(participantSpeechHeight * 0.12)),
    }
    : {
      fill: "#BEDDFF",
      stroke: "#3B82F6",
      emoji: "🤫",
      y: participantSpeechY + Math.max(1, Math.floor(participantSpeechHeight * 0.58)),
    };

  segments.forEach((segment) => {
    const start = Math.max(0, safeNumber(segment?.start, 0));
    const end = Math.max(start + 0.05, safeNumber(segment?.end, start + 0.05));
    const duration = Math.max(0, end - start);
    const confidence = segmentConfidence(segment);
    const x1 = safeNumber(xObject?.x ? xObject.x(start) : NaN, NaN);
    const x2 = safeNumber(xObject?.x ? xObject.x(end) : NaN, NaN);
    if (!Number.isFinite(x1) || !Number.isFinite(x2)) return;

    const width = Math.max(20, x2 - x1);
    const cueLabel = cueType === "laughter" ? "Laughter" : "Long silence";
    const tooltipPayload = {
      label: cueLabel,
      emoji: style.emoji,
      participantId,
      start,
      end,
      duration,
      confidence,
      audioStart: safeNumber(segment?._audioStart, start),
      audioEnd: safeNumber(segment?._audioEnd, end),
    };
    const segmentGroup = layer
      .append("g")
      .attr("class", `non-verbal-cue cue-${cueType}`)
      .style("cursor", "pointer")
      .on("mouseover", function() {
        showNonVerbalCueTooltip(d3.event, tooltipPayload);
      })
      .on("mousemove", function() {
        moveNonVerbalCueTooltip(d3.event);
      })
      .on("mouseout", function() {
        hideNonVerbalCueTooltip();
      })
      .on("click", function() {
        hideNonVerbalCueTooltip();
        seekToCue(participantId, start);
      });

    let cueY = style.y;

    // In timeline mode, align cue badges to the nearest speech block for the same participant.
    // This avoids vertical drift when multiple participant rows are visible.
    if (!questionView) {
      const timelineAnchor = findNearestTimelineSpeechRect(participantId, start);
      if (timelineAnchor) {
        const blockY = safeNumber(timelineAnchor.getAttribute("y"), NaN);
        const blockHeight = safeNumber(timelineAnchor.getAttribute("height"), NaN);
        if (Number.isFinite(blockY) && Number.isFinite(blockHeight) && blockHeight > 0) {
          cueY = cueType === "laughter"
            ? (blockY + Math.max(1, Math.floor(blockHeight * 0.18)))
            : (blockY + Math.max(1, Math.floor(blockHeight * 0.58)));
        }
      }
    }

    if (questionView) {
      const anchorNode = findNearestQuestionSpeechRect(participantId, start);
      if (anchorNode) {
        const blockX = safeNumber(anchorNode.getAttribute("x"), NaN);
        const blockY = safeNumber(anchorNode.getAttribute("y"), NaN);
        const blockWidth = safeNumber(anchorNode.getAttribute("width"), NaN);
        const blockHeight = safeNumber(anchorNode.getAttribute("height"), NaN);

        if (
          Number.isFinite(blockX)
          && Number.isFinite(blockY)
          && Number.isFinite(blockWidth)
          && Number.isFinite(blockHeight)
          && blockWidth > 0
          && blockHeight > 0
        ) {
          const badgeWidth = Math.max(12, Math.min(18, blockWidth - 2));
          const badgeHeight = Math.max(10, Math.min(14, blockHeight - 2));
          const badgeX = blockX + Math.max(1, (blockWidth - badgeWidth) / 2);
          const badgeY = blockY + Math.max(1, (blockHeight - badgeHeight) / 2);

          const cueRect = segmentGroup.append("rect")
            .attr("class", "cue-segment")
            .attr("x", badgeX)
            .attr("y", badgeY)
            .attr("width", badgeWidth)
            .attr("height", badgeHeight)
            .attr("rx", 6)
            .attr("ry", 6)
            .style("fill", style.fill)
            .style("stroke", style.stroke)
            .style("stroke-width", "1px")
            .style("opacity", 0.96);

          const cueEmoji = segmentGroup.append("text")
            .attr("class", "cue-emoji")
            .attr("x", badgeX + (badgeWidth / 2))
            .attr("y", badgeY + (badgeHeight / 2))
            .attr("text-anchor", "middle")
            .attr("dominant-baseline", "middle")
            .style("font-size", "10px")
            .text(style.emoji);
          return;
        }
      }
    }

    const cueRect = segmentGroup.append("rect")
      .attr("class", "cue-segment")
      .attr("x", x1)
      .attr("y", cueY)
      .attr("width", width)
      .attr("height", cueHeight)
      .attr("rx", 4)
      .attr("ry", 4)
      .style("fill", style.fill)
      .style("stroke", style.stroke)
      .style("stroke-width", "1px")
      .style("opacity", 0.92);

    const cueEmoji = segmentGroup.append("text")
      .attr("class", "cue-emoji")
      .attr("x", x1 + (width / 2))
      .attr("y", cueY + (cueHeight / 2))
      .attr("text-anchor", "middle")
      .attr("dominant-baseline", "middle")
      .style("font-size", width < 28 ? "10px" : "12px")
      .text(style.emoji);
  });
}

export function clearNonVerbalCueLayer() {
  if (!svgObject.svg || svgObject.svg.empty()) return;
  svgObject.svg.selectAll(".non-verbal-cues-layer").remove();
  hideNonVerbalCueTooltip();
}

export function drawNonVerbalCueLayer(activeParticipants) {
  ensureScopeState();
  clearNonVerbalCueLayer();
  updateToggleUi();

  if (!getNonVerbalControlAvailability(activeControlViewMode).enabled) return;
  if (!nonVerbalCueState.enabled) return;
  if (!svgObject.svg || svgObject.svg.empty()) return;
  if (!xObject.x || !yObject.y) return;

  const participants = Array.isArray(activeParticipants) && activeParticipants.length
    ? activeParticipants
    : (typeof yObject.y.domain === "function" ? yObject.y.domain() : []);

  if (!nonVerbalCueState.data || !nonVerbalCueState.data.participants) {
    if (!nonVerbalCueState.loading && !nonVerbalCueState.fetchFailed) {
      void ensureNonVerbalCueData().then(() => {
        drawNonVerbalCueLayer(participants);
      });
    }
    return;
  }

  const participantMap = nonVerbalCueState.data.participants || {};
  const layer = svgObject.svg.append("g").attr("class", "non-verbal-cues-layer");

  participants.forEach((participantId) => {
    const payload = participantMap[participantId];
    if (!payload || !payload.segments) return;
    const displayTransform = inferCueDisplayTransform(participantId, payload);
    const laughterSegments = applyCueDisplayTransform(
      filterSegmentsByConfidence(payload.segments.laughter || []),
      displayTransform
    );
    const silenceSegments = applyCueDisplayTransform(
      filterLongSilenceSegments(payload.segments.long_silence || []),
      displayTransform
    );
    drawCueSegments(layer, participantId, laughterSegments, "laughter");
    drawCueSegments(layer, participantId, silenceSegments, "long_silence");
  });
}
