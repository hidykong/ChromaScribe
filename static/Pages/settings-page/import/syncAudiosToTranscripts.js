import { formatProjectFileName as formatFileName, uploadFiles, allProjectFiles } from "./uploadFiles.js?v=20260601c";
import { fileLists, FileMap } from "../../../chromascribe-main.js";
import { createThemeGenerationEtaController } from "../themeGenerationEta.js?v=20260425a";
import {
  clearStoredFileMap,
  persistFileMapToStorage
} from "../../fileMapSync.js?v=20260601b";

let generationEtaController = null;
let activeGenerationWatchToken = 0;

function getCurrentProjectId() {
  return (window.CURRENT_PROJECT_ID || localStorage.getItem("currentProjectId") || "").trim();
}

function getProjectStorageScope(projectId = getCurrentProjectId()) {
  const resolvedProjectId = String(projectId || "").trim();
  if (!resolvedProjectId) return "";
  const workspaceKey = (window.USER_WORKSPACE_KEY || localStorage.getItem("currentWorkspaceKey") || "").trim();
  return workspaceKey ? `${workspaceKey}__${resolvedProjectId}` : resolvedProjectId;
}

function markUsageStep(stepName, details = {}) {
  const payload = { stepName, ...details };
  window.__pendingChromaUsageStep = payload;
  if (window.ChromaUsageLogger && typeof window.ChromaUsageLogger.setStep === "function") {
    window.ChromaUsageLogger.setStep(stepName, payload);
  }
}

function normalizeProgressMessage(message) {
  return String(message || "").trim().toLowerCase();
}

export function isGenerationProgressRunning(progress) {
  const stage = Number(progress && progress.stage);
  const message = normalizeProgressMessage(progress && progress.message);
  return (
    [0, 1, 2, 3].includes(stage) &&
    !["idle", "not started", "complete", "demo data ready"].includes(message)
  );
}

function isGenerationProgressComplete(progress) {
  const stage = Number(progress && progress.stage);
  const message = normalizeProgressMessage(progress && progress.message);
  return stage >= 4 || message === "complete" || Array.isArray(progress?.themes);
}

function persistGeneratedThemesFromProgress(progress) {
  if (!Array.isArray(progress?.themes) || progress.themes.length === 0) return;
  const storageScope = getProjectStorageScope();
  const generatedThemesKey = storageScope
    ? `generatedPossibleThemes_${storageScope}`
    : "generatedPossibleThemes";
  localStorage.setItem(generatedThemesKey, JSON.stringify(progress.themes));
  if (!storageScope) {
    localStorage.setItem("generatedPossibleThemes", JSON.stringify(progress.themes));
  }
}

function persistGeneratedThemeCandidates(themePayload) {
  const themes = Array.isArray(themePayload?.themes) ? themePayload.themes : [];
  const themeNames = themes
    .map(theme => String(theme?.themeName || theme?.theme || theme?.name || "").trim())
    .filter(Boolean);
  if (themeNames.length === 0) return;
  const storageScope = getProjectStorageScope();
  const generatedThemesKey = storageScope
    ? `generatedPossibleThemes_${storageScope}`
    : "generatedPossibleThemes";
  localStorage.setItem(generatedThemesKey, JSON.stringify(themeNames));
  if (!storageScope) {
    localStorage.setItem("generatedPossibleThemes", JSON.stringify(themeNames));
  }
}

async function syncGeneratedThemePayloadFromServer() {
  try {
    const projectId = getCurrentProjectId();
    const projectParam = projectId ? `&projectId=${encodeURIComponent(projectId)}` : "";
    const response = await fetch(`/api/themes?t=${Date.now()}${projectParam}`, { cache: "no-store" });
    if (!response.ok) return null;
    const payload = await response.json();
    if (payload && Array.isArray(payload.themes) && payload.themes.length > 0) {
      persistGeneratedThemeCandidates(payload);
      return payload;
    }
  } catch (error) {
    console.warn("Failed to sync completed generated themes:", error);
  }
  return null;
}

function clearFileUpdateWorkflowState(projectId = getCurrentProjectId()) {
  const storageScope = getProjectStorageScope(projectId);
  if (!storageScope) return;
  localStorage.removeItem(`fileUpdateWorkflow_${storageScope}`);
}

function getThemeSelectionPendingKey(projectId = getCurrentProjectId()) {
  const storageScope = getProjectStorageScope(projectId);
  return storageScope ? `themeSelectionPending_${storageScope}` : "themeSelectionPending";
}

function markThemeSelectionPending(projectId = getCurrentProjectId()) {
  localStorage.setItem(getThemeSelectionPendingKey(projectId), "1");
  if (!getProjectStorageScope(projectId)) {
    localStorage.setItem("themeSelectionPending", "1");
  }
}

async function saveFileMapToSession(projectId, fileMap = FileMap) {
  if (!fileMap || !Array.isArray(fileMap.participants)) return false;
  try {
    const response = await fetch('/api/filemap/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileMap, projectId })
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      console.warn("Failed to persist FileMap to session:", payload.error || response.statusText);
      return false;
    }
    return true;
  } catch (error) {
    console.warn("Failed to persist FileMap to session:", error);
    return false;
  }
}

export async function fetchGenerationProgress() {
  const projectId = getCurrentProjectId();
  const projectParam = projectId ? `&projectId=${encodeURIComponent(projectId)}` : "";
  const response = await fetch(`/progress?t=${Date.now()}${projectParam}`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Progress request failed (${response.status})`);
  }
  return response.json();
}

function ensureResumeProgressAnimations() {
  if (document.getElementById("generation-progress-animations")) return;
  const style = document.createElement("style");
  style.id = "generation-progress-animations";
  style.textContent = `
    @keyframes generation-stage-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
  `;
  document.head.appendChild(style);
}

function setResumeStageVisual(id, state) {
  const circle = d3.select("#stage-circle-" + id);
  const icon = d3.select("#stage-icon-" + id);
  const label = d3.select("#stage-label-" + id);
  if (circle.empty() || icon.empty()) return;

  if (state === "done") {
    circle.style("background", "#22c55e").style("border", "2px solid #22c55e");
    icon
      .text("✓")
      .style("width", "auto")
      .style("height", "auto")
      .style("border", "none")
      .style("animation", "none")
      .style("border-radius", "0")
      .style("color", "#ffffff")
      .style("font-size", "16px")
      .style("font-weight", "800")
      .style("line-height", "1");
    label.style("color", "#1f2937");
    return;
  }

  if (state === "active") {
    circle.style("background", "#ffffff").style("border", "2px solid #9bb2f6");
    icon
      .text("")
      .style("width", "14px")
      .style("height", "14px")
      .style("border", "2px solid #dbe5ff")
      .style("border-top", "2px solid #3a61dd")
      .style("border-radius", "50%")
      .style("animation", "generation-stage-spin 0.9s linear infinite")
      .style("color", "transparent")
      .style("font-size", "0");
    label.style("color", "#111827");
    return;
  }

  circle.style("background", "#ffffff").style("border", "2px solid #b6bac5");
  icon
    .text("")
    .style("width", "10px")
    .style("height", "10px")
    .style("border", "2px solid #b6bac5")
    .style("border-top", "2px solid #b6bac5")
    .style("border-radius", "50%")
    .style("animation", "none")
    .style("color", "transparent")
    .style("font-size", "0");
  label.style("color", "#4b5563");
}

function updateResumeProgress(stage) {
  const clamped = Math.max(0, Math.min(4, Number(stage) || 0));
  for (let i = 1; i <= 3; i++) {
    if (clamped >= 4 || i < clamped) {
      setResumeStageVisual(i, "done");
    } else if (i === clamped && clamped >= 1 && clamped < 4) {
      setResumeStageVisual(i, "active");
    } else {
      setResumeStageVisual(i, "pending");
    }
  }
}

function showResumeGenerationPopup(projectTranscriptCount = 1) {
  ensureResumeProgressAnimations();
  if (!generationEtaController) {
    generationEtaController = createThemeGenerationEtaController("generation-stage-eta", {
      workloadUnits: projectTranscriptCount,
    });
  }
  generationEtaController.reset("Estimated remaining time: preparing estimate...", {
    workloadUnits: projectTranscriptCount,
  });

  d3.select("#generation-overlay").remove();
  const overlay = d3.select("#main-edit-window")
    .append("div")
    .attr("id", "generation-overlay")
    .style("position", "absolute")
    .style("top", "0")
    .style("left", "0")
    .style("right", "0")
    .style("bottom", "0")
    .style("background", "rgba(0,0,0,0.15)")
    .style("z-index", 9999)
    .style("display", "flex")
    .style("align-items", "center")
    .style("justify-content", "center");

  const popUpHolderAI = overlay.append("div")
    .attr("id", "popUpHolder")
    .style("background", "#ffffff")
    .style("height", "auto")
    .style("max-height", "70vh")
    .style("width", "620px")
    .style("display", "flex")
    .style("flex-direction", "column")
    .style("justify-content", "center")
    .style("align-items", "center")
    .style("border-radius", "15px")
    .style("font-family", "Inter")
    .style("text-align", "center")
    .style("box-shadow", "0 4px 15px rgba(0, 0, 0, 0.2)")
    .style("padding", "18px 24px 16px")
    .style("overflow-y", "auto");

  popUpHolderAI.append("div")
    .attr("id", "generation-stage-title")
    .style("margin-top", "4px")
    .style("width", "520px")
    .style("font-weight", 800)
    .style("font-size", "22px")
    .text("Generating Codes and Excerpts. Please wait...");

  popUpHolderAI.append("div")
    .attr("id", "generation-stage-subtitle")
    .style("width", "540px")
    .style("margin-top", "10px")
    .style("font-size", "15px")
    .style("font-weight", 300)
    .style("color", "#444")
    .text("Privacy & data handling:");

  popUpHolderAI.append("div")
    .attr("id", "generation-stage-eta")
    .style("width", "540px")
    .style("margin-top", "8px")
    .style("font-size", "14px")
    .style("font-weight", 600)
    .style("color", "#6b7280")
    .text("Estimated remaining time: preparing estimate...");

  popUpHolderAI.append("div")
    .attr("id", "generation-stage-scope")
    .style("width", "540px")
    .style("margin-top", "6px")
    .style("font-size", "12px")
    .style("font-weight", 600)
    .style("color", "#64748b")
    .text(`Project-wide estimate across ${projectTranscriptCount} transcript${projectTranscriptCount === 1 ? "" : "s"}.`);

  const privacyBox = popUpHolderAI.append("div")
    .attr("id", "generation-privacy-bullets")
    .style("width", "540px")
    .style("margin-top", "10px")
    .style("text-align", "left")
    .style("font-size", "12.5px")
    .style("line-height", "1.35")
    .style("color", "#555");

  const bulletList = privacyBox.append("ul")
    .style("margin", "0")
    .style("padding-left", "18px");

  [
    "Local storage: Files and results stay in your local workspace until you remove them.",
    "AI processing: Requests go to your configured model service. Hosted providers receive transcript text and questions.",
    "Provider policies: Your model provider determines its own data retention and training policies. Review them before processing sensitive data.",
  ].forEach(text => {
    const row = bulletList.append("li");
    const match = text.match(/^([^:]+):(.*)$/);
    if (match) {
      row.append("strong").text(match[1].trim() + ": ");
      row.append("span").text(match[2].trim());
    } else {
      row.text(text);
    }
  });

  popUpHolderAI.append("div")
    .attr("id", "generation-browse-note")
    .style("width", "540px")
    .style("margin-top", "10px")
    .style("font-size", "16px")
    .style("font-weight", 800)
    .style("line-height", "1.35")
    .style("color", "#2563eb")
    .text("You can continue browsing other tabs while this runs.");

  const progressContainer = popUpHolderAI.append("div")
    .attr("id", "progress-stages")
    .style("display", "flex")
    .style("flex-direction", "row")
    .style("align-items", "center")
    .style("margin-top", "18px")
    .style("gap", "40px");

  function makeStage(id, label) {
    const stage = progressContainer.append("div")
      .style("display", "flex")
      .style("flex-direction", "column")
      .style("align-items", "center");

    stage.append("div")
      .attr("class", "stage-circle")
      .attr("id", "stage-circle-" + id)
      .style("width", "30px")
      .style("height", "30px")
      .style("display", "flex")
      .style("align-items", "center")
      .style("justify-content", "center")
      .style("border-radius", "50%")
      .style("border", "2px solid #b6bac5")
      .style("background", "#fff")
      .append("div")
      .attr("id", "stage-icon-" + id)
      .style("width", "10px")
      .style("height", "10px")
      .style("border", "2px solid #b6bac5")
      .style("border-radius", "50%");

    stage.append("div")
      .attr("id", "stage-label-" + id)
      .style("margin-top", "6px")
      .style("font-size", "13px")
      .style("color", "#4b5563")
      .text(label);
  }

  makeStage(1, "Tagging Questions");
  makeStage(2, "Tagging Answers");
  makeStage(3, "Generating Codes");
  updateResumeProgress(0);
}

function syncResumeGenerationPopup(progress) {
  updateResumeProgress(progress?.stage);
  generationEtaController?.update(progress);
  const title = d3.select("#generation-stage-title");
  if (!title.empty() && progress?.message) {
    title.text(progress.message);
  }
}

function hideResumeGenerationPopup() {
  generationEtaController?.stop();
  d3.select("#generation-overlay").remove();
}

async function watchGenerationUntilComplete({ redirectOnComplete = true, onComplete = null } = {}) {
  const POLL_MS = 1500;
  const watchToken = ++activeGenerationWatchToken;
  while (true) {
    if (watchToken !== activeGenerationWatchToken) return;
    const progress = await fetchGenerationProgress();
    syncResumeGenerationPopup(progress);

    if (Number(progress?.stage) === -1) {
      hideResumeGenerationPopup();
      alert(progress?.message || "Theme generation failed. You can retry from the Codes tab.");
      return;
    }

    if (Number(progress?.stage) >= 4 || !isGenerationProgressRunning(progress)) {
      persistGeneratedThemesFromProgress(progress);
      await syncGeneratedThemePayloadFromServer();
      updateResumeProgress(4);
      hideResumeGenerationPopup();
      if (typeof onComplete === "function") {
        onComplete(progress);
      }
      if (redirectOnComplete) window.location.href = "/themes";
      return;
    }

    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}

export async function resumeGenerationProgressIfRunning(options = {}) {
  if ((window.APP_MODE || "").toLowerCase() === "demo") return;
  const {
    redirectOnComplete = true,
    fileMap = null,
    onComplete = null
  } = options || {};
  try {
    const progress = await fetchGenerationProgress();
    if (!isGenerationProgressRunning(progress)) return;
    const sourceFileMap = fileMap && Array.isArray(fileMap.participants) ? fileMap : FileMap;
    const assignedTranscriptCount = Math.max(1, (sourceFileMap.participants || []).filter((participant) => {
      const transcript = ((participant || {}).transcript) || null;
      const relativePath = transcript && transcript.relativePath;
      return typeof relativePath === "string" && relativePath.trim() !== "";
    }).length);
    showResumeGenerationPopup(assignedTranscriptCount);
    syncResumeGenerationPopup(progress);
    watchGenerationUntilComplete({ redirectOnComplete, onComplete }).catch(error => {
      console.warn("Failed to resume generation progress:", error);
      hideResumeGenerationPopup();
    });
  } catch (error) {
    console.warn("Could not check generation progress:", error);
  }
}

/* ---------------- Sticky Bottom Bar + Dots (consistent with Upload step) ---------------- */
function renderDotsInside(bottomBar, activeIndex = 3) {
  d3.select("#circles").remove();

  const wrap = bottomBar.append("div")
    .attr("id", "circles")
    .style("display", "flex")
    .style("justify-content", "center")
    .style("align-items", "center")
    .style("gap", "10px")
    .style("flex", "1");

  const pill = wrap.append("div")
    .style("display", "flex")
    .style("align-items", "center")
    .style("justify-content", "center")
    .style("gap", "10px")
    .style("padding", "6px 10px")
    .style("border-radius", "999px")
    .style("box-shadow", "0 0 10px rgba(0,0,0,0.08)")
    .style("background", "#fff")
    .style("flex-wrap", "nowrap")
    .style("max-width", "100%");

  for (let i = 0; i < 4; i++) {
    pill.append("button")
      .attr("id", "circle_" + i)
      .style("width", i === activeIndex ? "15px" : "10px")
      .style("height", i === activeIndex ? "15px" : "12px")
      .style("border", "none")
      .style("border-radius", "50%")
      .style("background", i === activeIndex ? "#4E4E4E" : "#EDEDED")
      .style("cursor", "pointer")
      .on("click", function () {
        const step = this.id.substring(7);
        switch (step) {
          case "0": typeof nameProject === "function" && nameProject(); break;
          case "1": uploadFiles(); break;
          case "2": typeof renderUploadQuestionSetUI === "function" && renderUploadQuestionSetUI(); break;
          case "3": syncAudiosToTranscripts(); break;
        }
      });
  }
}

function renderBottomButtons(mainEditWindow, backAction, nextAction, activeIndex = 3) {
  const bar = mainEditWindow.append("div")
    .attr("id", "bottomButtonsBar")
    .style("position", "sticky")
    .style("bottom", "0")
    .style("z-index", "5")
    .style("display", "flex")
    .style("align-items", "center")
    .style("flex-wrap", "nowrap")
    .style("gap", "12px")
    .style("width", "100%")
    .style("padding", "15px 5%")
    .style("background-color", "#ffffff")
    .style("box-shadow", "0 -2px 8px rgba(0,0,0,0.1)")
    .style("box-sizing", "border-box");

  bar.append("button")
    .attr("id", "backBtn")
    .text("Back")
    .style("padding", "10px 20px")
    .style("font-size", "15px")
    .style("background-color", "#ececf0")
    .style("color", "#333")
    .style("border", "1px solid #ccc")
    .style("border-radius", "6px")
    .on("click", backAction);

  renderDotsInside(bar, activeIndex);

  bar.append("button")
    .attr("id", "syncNextBtn")
    .text("Next")
    .style("margin-left", "auto")
    .style("padding", "10px 20px")
    .style("font-size", "15px")
    .style("background-color", "#3A61DD")
    .style("color", "white")
    .style("border", "none")
    .style("border-radius", "6px")
    .on("click", nextAction);
}

/* ---------------- Utilities ---------------- */
function cssEscapeId(id) {
  return id.replace(/([ !"#$%&'()*+,./:;<=>?@\[\\\]^`{|}~])/g, "\\$1");
}
function extractParticipantCode(filename) {
  if (!filename) return null;
  const pMatch = filename.match(/(^|[^A-Za-z0-9])P(\d+)(?![A-Za-z0-9])/i);
  if (pMatch && pMatch[2]) return "P" + parseInt(pMatch[2], 10);
  const lead = filename.match(/^(\d+)(?=[_\.\s-])/);
  if (lead && lead[1]) return "P" + parseInt(lead[1], 10);
  const ptMatch = filename.match(/_pt(\d+)/i);
  if (ptMatch && ptMatch[1]) return "P" + parseInt(ptMatch[1], 10);
  return null;
}
function normalizeCode(input) {
  if (!input) return null;
  const trimmed = String(input).trim();
  if (!trimmed) return null;
  const m = trimmed.match(/^P?\s*(\d+)$/i);
  return m ? ("P" + parseInt(m[1], 10)) : null;
}
function nextSuggestedCode(existing) {
  const nums = existing
    .map(c => (c.match(/^P(\d+)$/i) ? parseInt(RegExp.$1, 10) : 0))
    .filter(n => n > 0);
  const max = nums.length ? Math.max(...nums) : 0;
  return "P" + (max + 1);
}

/* ---------------- Page ---------------- */
export function syncAudiosToTranscripts() {
  markUsageStep("Match transcripts to audio", {
    stepKey: "file_manager_match_audio_transcripts",
    workflow: "file_manager_import",
  });
  const mainEditWindow = d3.select("#main-edit-window");
  mainEditWindow.selectAll("*").remove();

  mainEditWindow
    .style("position", "relative")
    .style("display", "flex")
    .style("flex-direction", "column")
    .style("min-height", "100%")
    .style("height", "100%")
    .style("overflow-y", "auto")
    .style("overflow-x", "hidden");

  const content = mainEditWindow.append("div")
    .style("flex-grow", "1")
    .style("display", "flex")
    .style("flex-direction", "column")
    .style("align-items", "stretch");

  FileMap.participants = [];

  // Header
  const header = content.append("div")
    .style("width", "100%")
    .style("max-width", "1400px")
    .style("margin", "0 auto")
    .style("text-align", "center");

  header.append("div")
    .style("font-family", "Inter")
    .style("font-size", "34px")
    .style("font-weight", 700)
    .style("color", "#3A61DD")
    .text("Match Participants to Files");

  header.append("div")
    .style("margin", "8px auto 0")
    .style("max-width", "920px")
    .style("font-family", "Inter")
    .style("font-size", "16px")
    .style("font-weight", 500)
    .style("color", "#333")
    .text("Each transcript is assigned a participant. Matching filenames help pair recordings; drag files to correct any pairing. Audio is optional.");

  const ColumnHeight = Math.max(360, mainEditWindow.node().offsetHeight - header.node().offsetHeight - 240);

  // Full-width row
  const scroller = content.append("div")
    .attr("id", "matchScroller")
    .style("width", "100%")
    .style("max-width", "calc(100% - 80px)")
    .style("margin", "28px auto 0")
    .style("overflow", "visible")
    .style("box-sizing", "border-box");

  const row = scroller.append("div")
    .attr("id", "matchRow")
    .style("display", "flex")
    .style("flex-direction", "row")
    .style("gap", "16px")
    .style("align-items", "stretch")
    .style("justify-content", "flex-start")
    .style("width", "100%");

  /* LEFT: Participants table (flexes to fill the space) */
  const participantsColumn = row.append("div")
    .style("flex", "1 1 auto")
    .style("min-width", "0");

  const participantsMatching = participantsColumn.append("div")
    .attr("id", "participantsMatching")
    .style("margin-top", "10px")
    .style("display", "flex")
    .style("flex-direction", "column")
    .style("align-items", "stretch")
    .style("overflow", "auto")
    .style("height", ColumnHeight + "px")
    .style("border-radius", "10px")
    .style("border", "2px solid #C4C4C4")
    .style("background", "#fff")
    .style("box-sizing", "border-box")
    .style("width", "100%");

  const labels = participantsMatching.append("div")
    .style("display", "flex")
    .style("flex-direction", "row")
    .style("align-items", "center")
    .style("justify-content", "start")
    .style("gap", "0")
    .style("width", "100%")
    .style("border-bottom", "2px solid #ededed")
    .style("background", "#fafafa")
    .style("box-sizing", "border-box");

  const colParticipants = labels.append("div")
    .style("width", "22%")
    .style("padding", "12px 10px")
    .style("border-right", "2px solid #ededed")
    .style("color", "#7d7d7d")
    .style("font-weight", 800)
    .style("font-size", "14px")
    .style("display", "flex")
    .style("align-items", "center")
    .style("justify-content", "space-between")
    .style("gap", "8px");

  colParticipants.append("span")
    .style("white-space", "nowrap").style("overflow", "hidden").style("text-overflow", "ellipsis")
    .text("Participants");

  colParticipants.append("button")
    .attr("id", "addParticipantBtn")
    .text("+")
    .attr("title", "Add participant")
    .style("padding", "2px 8px")
    .style("font-size", "16px")
    .style("line-height", "1")
    .style("border-radius", "6px")
    .style("border", "1px solid #c9c9c9")
    .style("background", "#ffffff")
    .style("cursor", "pointer")
    .on("click", onAddParticipantClicked);

  labels.append("div")
    .style("width", "39%")
    .style("padding", "12px 10px")
    .style("border-right", "2px solid #ededed")
    .style("color", "#7d7d7d")
    .style("font-weight", 800)
    .style("font-size", "14px")
    .text("Transcript");

  labels.append("div")
    .style("width", "39%")
    .style("padding", "12px 10px")
    .style("color", "#7d7d7d")
    .style("font-weight", 800)
    .style("font-size", "14px")
    .text("Audio");

  /* RIGHT: Unmatched Files panel */
  const unmatchedColumn = row.append("div")
    .style("flex", "0 0 320px")
    .style("width", "320px")
    .style("max-width", "320px")
    .style("min-width", "320px");

  const unmatched = unmatchedColumn.append("div")
    .attr("id", "unmatched")
    .style("margin-top", "10px")
    .style("display", "flex")
    .style("flex-direction", "column")
    .style("align-items", "stretch")
    .style("overflow", "hidden")
    .style("min-height", "0")
    .style("height", ColumnHeight + "px")
    .style("gap", "10px")
    .style("padding", "12px")
    .style("border-radius", "10px")
    .style("border", "2px solid #C4C4C4")
    .style("background", "#fff");

  buildAndRenderWithAutoMatch();

  renderBottomButtons(mainEditWindow, () => uploadFiles(), handleNext, 3);
  resumeGenerationProgressIfRunning();
}

/* ---------------- Build, auto-match, render ---------------- */
var finaltranscript = [];

function buildAndRenderWithAutoMatch() {
  const allTranscripts = [];
  const allAudios = [];
  FileMap.participants = [];

  const candidateParticipants = new Set();

  allProjectFiles.forEach(fileEntry => {
    if (fileEntry.type === "transcript") {
      const code = extractParticipantCode(fileEntry.originalFilename);
      allTranscripts.push({ entry: fileEntry, code });
      if (code) candidateParticipants.add(code);
    } else if (fileEntry.type === "audio") {
      const code = extractParticipantCode(fileEntry.originalFilename);
      allAudios.push({ entry: fileEntry, code });
      if (code) candidateParticipants.add(code);
    }
  });

  // Ordinary filenames receive a project participant ID without being renamed.
  let nextParticipantNumber = 1;
  for (const transcript of allTranscripts) {
    if (transcript.code) continue;
    while (candidateParticipants.has(`P${nextParticipantNumber}`)) {
      nextParticipantNumber += 1;
    }
    transcript.code = `P${nextParticipantNumber}`;
    candidateParticipants.add(transcript.code);
    const transcriptPath = transcript.entry.relativePath || transcript.entry.originalFilename || "";
    const transcriptStem = transcriptPath.replace(/\.[^.]+$/, "").toLowerCase();
    const matchingAudio = allAudios.filter(audio => {
      const audioPath = audio.entry.relativePath || audio.entry.originalFilename || "";
      const audioStem = audioPath.replace(/\.[^.]+$/, "").toLowerCase();
      return !audio.code && audioStem === transcriptStem;
    });
    if (matchingAudio.length === 1) {
      matchingAudio[0].code = transcript.code;
    }
  }

  const participantCodes = Array.from(candidateParticipants).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  );

  participantCodes.forEach(code => {
    FileMap.participants.push({ participant: code, transcript: null, audio: null });
  });

  const firstTranscriptFor = new Map();
  const firstAudioFor = new Map();
  for (const t of allTranscripts) if (t.code && !firstTranscriptFor.has(t.code)) firstTranscriptFor.set(t.code, t.entry);
  for (const a of allAudios) if (a.code && !firstAudioFor.has(a.code)) firstAudioFor.set(a.code, a.entry);

  const placedTranscriptIds = new Set();
  const placedAudioIds = new Set();

  addParticipantEntries(FileMap);

  FileMap.participants.forEach((row, idx) => {
    const tMatch = firstTranscriptFor.get(row.participant);
    if (tMatch) {
      row.transcript = tMatch;
      placedTranscriptIds.add(tMatch.id);
      placeChipInCell({ type: "transcript", data: tMatch, participantIndex: idx + 1 });
    }
    const aMatch = firstAudioFor.get(row.participant);
    if (aMatch) {
      row.audio = aMatch;
      placedAudioIds.add(aMatch.id);
      placeChipInCell({ type: "audio", data: aMatch, participantIndex: idx + 1 });
    }
  });

  renderUnmatchedList({
    unmatchedTranscripts: allTranscripts.filter(t => !placedTranscriptIds.has(t.entry.id)),
    unmatchedAudios: allAudios.filter(a => !placedAudioIds.has(a.entry.id))
  });
}

/* ---- Render unified unmatched panel with two subtables (equal height + scroll) ---- */
function renderUnmatchedList({ unmatchedTranscripts, unmatchedAudios }) {
  const container = d3.select("#unmatched");
  container.html("");
  container
    .style("display", "flex")
    .style("flex-direction", "column")
    .style("gap", "10px")
    .style("overflow", "hidden");

  container.append("div")
    .style("font-weight", 800)
    .style("font-size", "14px")
    .style("color", "#7d7d7d")
    .style("margin-bottom", "2px")
    .text("Unmatched Files");

  const makeBox = (id, title) => {
    const box = container.append("div")
      .attr("id", id)
      .style("display", "flex")
      .style("flex-direction", "column")
      .style("flex", "1 1 0")
      .style("min-height", "0")
      .style("border", "1px solid #e6e6e6")
      .style("border-radius", "8px")
      .style("padding", "8px")
      .style("background", "#fff");

    box.append("div")
      .style("flex", "0 0 auto")
      .style("font-weight", 700)
      .style("font-size", "13px")
      .style("color", "#6b6b6b")
      .style("margin-bottom", "6px")
      .text(title);

    const list = box.append("div")
      .attr("id", id + "List")
      .style("flex", "1 1 auto")
      .style("min-height", "0")
      .style("overflow-y", "auto")
      .style("display", "flex")
      .style("flex-direction", "column")
      .style("gap", "6px");

    return list;
  };

  const tList = makeBox("unmatchedTranscripts", "Unmatched Transcripts")
    .attr("aria-label", "Unmatched transcript files");
  const aList = makeBox("unmatchedAudios", "Unmatched Audio")
    .attr("aria-label", "Unmatched audio files");

  unmatchedTranscripts
    .sort((a, b) => a.entry.originalFilename.localeCompare(b.entry.originalFilename))
    .forEach(({ entry }) => {
      tList.append("div")
        .datum(entry)
        .attr("class", "unmatched-item")
        .attr("id", "transcriptfile_" + entry.originalFilename)
        .attr("title", entry.originalFilename)
        .style("display", "flex")
        .style("align-items", "center")
        .style("gap", "6px")
        .style("border-radius", "16px")
        .style("background", "#3A61DD")
        .style("color", "#ffffff")
        .style("padding", "4px 8px")
        .style("width", "100%")
        .style("max-width", "100%")
        .style("min-width", "0")
        .style("cursor", "grab")
        .html(
          '<img src="/static/images/transcript_icon_white.png" style="width:16px; height:16px; vertical-align:middle;" alt="Icon"/>' +
          `<span style="font-size:12px; display:inline-block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; width:100%;">${formatFileName(entry.originalFilename, 24)}</span>`
        )
        .call(dragTranscript);
    });

  unmatchedAudios
    .sort((a, b) => a.entry.originalFilename.localeCompare(b.entry.originalFilename))
    .forEach(({ entry }) => {
      aList.append("div")
        .datum(entry)
        .attr("class", "unmatched-item")
        .attr("id", "audiofile_" + entry.originalFilename)
        .attr("title", entry.originalFilename)
        .style("display", "flex")
        .style("align-items", "center")
        .style("gap", "6px")
        .style("border-radius", "16px")
        .style("background", "#3A61DD")
        .style("color", "#ffffff")
        .style("padding", "4px 8px")
        .style("width", "100%")
        .style("max-width", "100%")
        .style("min-width", "0")
        .style("cursor", "grab")
        .html(
          '<img src="/static/images/Audio_icon_white.png" style="width:16px; height:16px; vertical-align:middle;" alt="Icon"/>' +
          `<span style="font-size:12px; display:inline-block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; width:100%;">${formatFileName(entry.originalFilename, 24)}</span>`
        )
        .call(dragAudio);
    });
}


/* ---- Create participant rows (now editable + addable) ---- */
let participantToAudioMap = {};
let participantToTranscriptMap = {};

function onAddParticipantClicked() {
  const existing = FileMap.participants.map(p => p.participant);
  const suggestion = nextSuggestedCode(existing);
  const raw = prompt("Add participant (e.g., P5 or 5):", suggestion);
  const code = normalizeCode(raw);
  if (!code) { alert("Please enter a code like P5 or 5."); return; }
  if (existing.includes(code)) { alert(`"${code}" already exists.`); return; }
  const index = addParticipantRow({ participant: code, transcript: null, audio: null });
  const node = d3.select("#participantEntry" + index).node();
  if (node) node.scrollIntoView({ block: "center" });
}

function renderEditableParticipantCell(rowSel, code, index) {
  const label = rowSel.append("div")
    .style("width", "22%")
    .style("padding", "16px 10px")
    .style("border-right", "2px solid #ededed")
    .style("font-size", "14px")
    .style("font-weight", "600")
    .style("white-space", "nowrap")
    .style("overflow", "hidden")
    .style("text-overflow", "ellipsis")
    .style("cursor", "text")
    .attr("title", "Click to edit participant code")
    .attr("data-participant-index", index);

  const textSpan = label.append("span").text(code);

  function beginEdit() {
    const current = textSpan.text();
    textSpan.remove();
    const input = label.append("input")
      .attr("type", "text")
      .style("width", "100%")
      .style("padding", "4px 6px")
      .style("font-size", "14px")
      .style("border", "1px solid #cfcfcf")
      .style("border-radius", "4px")
      .property("value", current)
      .on("keydown", function() { if (d3.event.key === "Enter") commit(this.value); })
      .on("blur", function() { commit(this.value); })
      .node();
    input.focus();
    input.select();
  }

  function commit(raw) {
    const newCode = normalizeCode(raw);
    const allCodes = FileMap.participants.map(p => p.participant);
    if (!newCode) {
      alert("Invalid code. Use P# (e.g., P3) or just a number.");
    } else if (allCodes.some((c, i) => i !== (index - 1) && c === newCode)) {
      alert(`"${newCode}" already exists.`);
    } else {
      FileMap.participants[index - 1].participant = newCode;
    }
    label.selectAll("*").remove();
    label.append("span").text(FileMap.participants[index - 1].participant);
  }

  label.on("click", beginEdit);
}

function addParticipantRow(rowData) {
  FileMap.participants.push({ participant: rowData.participant, transcript: rowData.transcript || null, audio: rowData.audio || null });
  const index = FileMap.participants.length;

  const container = d3.select("#participantsMatching");
  const row = container.append("div")
    .attr("id", "participantEntry" + index)
    .style("display", "flex")
    .style("flex-direction", "row")
    .style("align-items", "stretch")
    .style("justify-content", "start")
    .style("color", "#000000")
    .style("border-bottom", "2px solid #ededed")
    .style("width", "100%")
    .style("min-height", "60px")
    .style("background", "transparent")
    .style("box-sizing", "border-box");

  renderEditableParticipantCell(row, rowData.participant, index);

  row.append("div")
    .attr("id", "transcript" + index)
    .style("width", "39%")
    .style("padding", "8px 10px")
    .style("border-right", "2px solid #ededed")
    .style("display", "flex")
    .style("align-items", "center")
    .style("gap", "6px")
    .style("min-height", "44px");

  row.append("div")
    .attr("id", "audio" + index)
    .style("width", "39%")
    .style("padding", "8px 10px")
    .style("display", "flex")
    .style("align-items", "center")
    .style("gap", "6px")
    .style("min-height", "44px");

  return index;
}

function addParticipantEntries(transcriptMap) {
  const participants = transcriptMap.participants.map(p => p.participant);
  const container = d3.select("#participantsMatching");

  participants.forEach((code, i) => {
    const row = container.append("div")
      .attr("id", "participantEntry" + (i + 1))
      .style("display", "flex")
      .style("flex-direction", "row")
      .style("align-items", "stretch")
      .style("justify-content", "start")
      .style("color", "#000000")
      .style("border-bottom", "2px solid #ededed")
      .style("width", "100%")
      .style("min-height", "60px")
      .style("background", "transparent")
      .style("box-sizing", "border-box");

    renderEditableParticipantCell(row, code.toString(), i + 1);

    row.append("div")
      .attr("id", "transcript" + (i + 1))
      .style("width", "39%")
      .style("padding", "8px 10px")
      .style("border-right", "2px solid #ededed")
      .style("display", "flex")
      .style("align-items", "center")
      .style("gap", "6px")
      .style("min-height", "44px");

    row.append("div")
      .attr("id", "audio" + (i + 1))
      .style("width", "39%")
      .style("padding", "8px 10px")
      .style("display", "flex")
      .style("align-items", "center")
      .style("gap", "6px")
      .style("min-height", "44px");
  });
}

/* ---------------- Swap & X-behavior utilities ---------------- */
let dragSource = { kind: null, from: null, participantIndex: null };

function moveFileToUnmatched(kind, entry) {
  const isAudio = kind === 'audio';
  const targetListId = isAudio ? "#unmatchedAudiosList" : "#unmatchedTranscriptsList";
  const container = d3.select(targetListId);
  const icon = isAudio ? "/static/images/Audio_icon_white.png" : "/static/images/transcript_icon_white.png";
  const idPrefix = isAudio ? "audiofile_" : "transcriptfile_";
  const dragBehavior = isAudio ? dragAudio : dragTranscript;
  const nodeId = idPrefix + entry.originalFilename;

  d3.select("#" + cssEscapeId(nodeId)).remove();

  container.append("div")
    .datum(entry)
    .attr("class", "unmatched-item")
    .attr("id", nodeId)
    .attr("title", entry.originalFilename)
    .style("display", "flex")
    .style("align-items", "center")
    .style("gap", "6px")
    .style("border-radius", "16px")
    .style("background", "#3A61DD")
    .style("color", "#ffffff")
    .style("padding", "4px 8px")
    .style("width", "100%")
    .style("max-width", "100%")
    .style("min-width", "0")
    .style("cursor", "grab")
    .html(
      `<img src="${icon}" style="width:16px;height:16px;vertical-align:middle;" alt="Icon"/>` +
      `<span style="font-size:12px; display:inline-block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; width:100%;">${formatFileName(entry.originalFilename, 24)}</span>`
    )
    .call(dragBehavior);
}

function clearParticipant(kind, participantIndex) {
  const key = kind === 'audio' ? 'audio' : 'transcript';
  const cellSel = `#${key}${participantIndex}`;
  d3.select(cellSel).html("");
  if (FileMap.participants[participantIndex - 1]) {
    FileMap.participants[participantIndex - 1][key] = null;
  }
  if (kind === 'audio') delete participantToAudioMap[participantIndex];
  else delete participantToTranscriptMap[participantIndex];
}

function setParticipant(kind, participantIndex, entry) {
  const key = kind === 'audio' ? 'audio' : 'transcript';
  const icon = kind === 'audio' ? "/static/images/Audio_icon_white.png"
                                : "/static/images/transcript_icon_white.png";
  const dragBehavior = kind === 'audio' ? dragAudio : dragTranscript;
  const idPrefix = kind === 'audio' ? "audiofile_" : "transcriptfile_";
  const cellSel = `#${key}${participantIndex}`;

  const chip = d3.select(cellSel).append("div")
    .datum(entry)
    .attr("id", idPrefix + entry.originalFilename)
    .attr("title", entry.originalFilename)
    .style("position", "relative")
    .style("display", "flex")
    .style("align-items", "center")
    .style("gap", "6px")
    .style("border-radius", "16px")
    .style("background", "#3A61DD")
    .style("color", "#ffffff")
    .style("padding", "4px 10px")
    .style("padding-right", "30px")
    .style("width", "100%")
    .style("max-width", "100%")
    .style("min-width", "0")
    .style("cursor", "auto")
    .html(
      `<img src="${icon}" style="width:16px;height:16px;vertical-align:middle;" alt="Icon"/>` +
      `<span style="font-size:12px; display:inline-block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; width:100%;">` +
      `${formatFileName(entry.originalFilename, 22)}</span>`
    )
    .call(dragBehavior);

  chip.append("button")
    .attr("aria-label", "Remove")
    .attr("title", "Remove")
    .style("position", "absolute")
    .style("top", "-6px")
    .style("right", "-6px")
    .style("width", "18px")
    .style("height", "18px")
    .style("display", "inline-flex")
    .style("align-items", "center")
    .style("justify-content", "center")
    .style("border", "2px solid #fff")
    .style("border-radius", "50%")
    .style("background", "#dc3545")
    .style("color", "#fff")
    .style("font-size", "12px")
    .style("line-height", "1")
    .style("box-shadow", "0 1px 3px rgba(0,0,0,0.25)")
    .style("cursor", "pointer")
    .style("z-index", "2")
    .text("×")
    .on("mousedown", function () {
      d3.event.stopPropagation();
      d3.event.preventDefault();
    })
    .on("click", function () {
      clearParticipant(kind, participantIndex);
      moveFileToUnmatched(kind, entry);
      chip.remove();
    });

  FileMap.participants[participantIndex - 1][key] = entry;
}

function placeChipInCell({ type, data, participantIndex }) {
  const key = type === 'audio' ? 'audio' : 'transcript';
  const sel = `#${key}${participantIndex}`;
  if (!d3.select(sel).node()) return;
  d3.select(sel).html("");
  setParticipant(type, participantIndex, data);
}

/* ---------------- Drag & Drop (robust hit testing + swap) ---------------- */
var dragAudio = d3.drag().on("start", onStartDragAudio).on("drag", onDragAudio).on("end", onEndDragAudio);
var dragTranscript = d3.drag().on("start", onStartDragTranscript).on("drag", onDragTranscript).on("end", onEndDragTranscript);

var initialMouseX, initialMouseY, initialElementX, initialElementY;
var dragToEntry;

function highlightRowAt(clientX, clientY) {
  dragToEntry = "";
  d3.select("#participantsMatching").selectAll("div[id^='participantEntry']").each(function () {
    const rect = this.getBoundingClientRect();
    if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
      d3.select(this).style("background", "#d9d9d9");
      dragToEntry = this.id;
    } else {
      d3.select(this).style("background", "none");
    }
  });
}

function onStartDragAudio() {
  initialMouseX = d3.event.x;
  initialMouseY = d3.event.y;
  const r = this.getBoundingClientRect();
  initialElementX = r.left + window.scrollX;
  initialElementY = r.top + window.scrollY;

  dragSource = { kind: 'audio', from: null, participantIndex: null };
  const parentId = d3.select(this).node().parentElement.id;
  if (/^audio\d+$/.test(parentId)) {
    dragSource.from = 'cell';
    dragSource.participantIndex = parseInt(parentId.replace('audio',''), 10);
  } else {
    dragSource.from = 'unmatched';
  }

  d3.select(this).style("z-index", 1000);
}

function onDragAudio() {
  const src = d3.event.sourceEvent;
  const clientX = (src.touches ? src.touches[0].clientX : src.clientX);
  const clientY = (src.touches ? src.touches[0].clientY : src.clientY);

  var newLeft = initialElementX + (d3.event.x - initialMouseX - 100);
  var newTop = initialElementY + (d3.event.y - initialMouseY - 100);
  d3.select(this)
    .style("position", "absolute")
    .style("top", newTop + "px")
    .style("left", newLeft + "px")
    .style("cursor", "grabbing");

  highlightRowAt(clientX, clientY);
}

function onEndDragAudio() {
  if (d3.event.sourceEvent && d3.event.sourceEvent.type === "click") return;

  if (dragToEntry) {
    const destIndex = parseInt(dragToEntry.match(/\d+/)[0], 10);
    const destSel = "#audio" + destIndex;
    const draggedData = d3.select(this).datum();

    const destChild = d3.select(destSel).select("div");
    const hadExisting = !destChild.empty();
    const existingData = hadExisting ? destChild.datum() : null;

    d3.select(this).remove();

    placeChipInCell({ type: "audio", data: draggedData, participantIndex: destIndex });

    if (hadExisting && existingData) {
      if (dragSource.from === 'cell' && dragSource.participantIndex) {
        placeChipInCell({ type: "audio", data: existingData, participantIndex: dragSource.participantIndex });
      } else {
        moveFileToUnmatched("audio", existingData);
      }
    } else if (dragSource.from === 'cell' && dragSource.participantIndex) {
      clearParticipant("audio", dragSource.participantIndex);
    }

    d3.select("#" + dragToEntry).style("background", "none");
  } else {
    d3.select(this).style("top", null).style("left", null).style("position", null).style("cursor", "auto").style("z-index", null);
  }
}

function onStartDragTranscript() {
  initialMouseX = d3.event.x;
  initialMouseY = d3.event.y;
  const r = this.getBoundingClientRect();
  initialElementX = r.left + window.scrollX;
  initialElementY = r.top + window.scrollY;

  dragSource = { kind: 'transcript', from: null, participantIndex: null };
  const parentId = d3.select(this).node().parentElement.id;
  if (/^transcript\d+$/.test(parentId)) {
    dragSource.from = 'cell';
    dragSource.participantIndex = parseInt(parentId.replace('transcript',''), 10);
  } else {
    dragSource.from = 'unmatched';
  }

  d3.select(this).style("z-index", 1000);
}

function onDragTranscript() {
  const src = d3.event.sourceEvent;
  const clientX = (src.touches ? src.touches[0].clientX : src.clientX);
  const clientY = (src.touches ? src.touches[0].clientY : src.clientY);

  var newLeft = initialElementX + (d3.event.x - initialMouseX - 150);
  var newTop = initialElementY + (d3.event.y - initialMouseY - 100);
  d3.select(this)
    .style("position", "absolute")
    .style("top", newTop + "px")
    .style("left", newLeft + "px")
    .style("cursor", "grabbing");

  highlightRowAt(clientX, clientY);
}

function onEndDragTranscript() {
  if (d3.event.sourceEvent && d3.event.sourceEvent.type === "click") return;

  if (dragToEntry) {
    const destIndex = parseInt(dragToEntry.match(/\d+/)[0], 10);
    const destSel = "#transcript" + destIndex;
    const draggedData = d3.select(this).datum();

    const destChild = d3.select(destSel).select("div");
    const hadExisting = !destChild.empty();
    const existingData = hadExisting ? destChild.datum() : null;

    d3.select(this).remove();

    placeChipInCell({ type: "transcript", data: draggedData, participantIndex: destIndex });

    if (hadExisting && existingData) {
      if (dragSource.from === 'cell' && dragSource.participantIndex) {
        placeChipInCell({ type: "transcript", data: existingData, participantIndex: dragSource.participantIndex });
      } else {
        moveFileToUnmatched("transcript", existingData);
      }
    } else if (dragSource.from === 'cell' && dragSource.participantIndex) {
      clearParticipant("transcript", dragSource.participantIndex);
    }

    d3.select("#" + dragToEntry).style("background", "none");
  } else {
    d3.select(this).style("top", null).style("left", null).style("position", null).style("cursor", "auto").style("z-index", null);
  }
}

/* ---------------- Reset helpers ---------------- */
function resetAudioSection(entry, index) {
  clearParticipant("audio", index);
  const audioFile = participantToAudioMap[index];
  if (audioFile) moveFileToUnmatched("audio", audioFile);
  delete participantToAudioMap[index];
  delete participantToTranscriptMap[index];
}
function resetTranscriptSection(entry, index) {
  clearParticipant("transcript", index);
  const transcriptFile = participantToTranscriptMap[index];
  if (transcriptFile) moveFileToUnmatched("transcript", transcriptFile);
  delete participantToTranscriptMap[index];
}

/* ---------------- Persist & Next ---------------- */
function appendParticipant(newParticipant) {
  const storageScope = getProjectStorageScope();
  const dataKey = storageScope ? `data.json_${storageScope}` : "data.json";
  const updatedData = { participants: [newParticipant] };
  localStorage.setItem(dataKey, JSON.stringify(updatedData));
  if (!storageScope) {
    localStorage.setItem('data.json', JSON.stringify(updatedData));
  }
  console.log('Data after overwriting:', updatedData);
}
export function getCurrentData() {
  const storageScope = getProjectStorageScope();
  const dataKey = storageScope ? `data.json_${storageScope}` : "data.json";
  const currentData = JSON.parse(localStorage.getItem(dataKey) || "{}");
  console.log('Current Data:', currentData);
  return currentData;
}

async function handleNext() {
  const btn = d3.select("#syncNextBtn");
  btn.text("Processing...").property("disabled", true).style("opacity", 0.5);

  const assignedTranscriptCount = (FileMap.participants || []).filter((participant) => {
    const transcript = ((participant || {}).transcript) || null;
    const relativePath = transcript && transcript.relativePath;
    return typeof relativePath === "string" && relativePath.trim() !== "";
  }).length;
  if (assignedTranscriptCount === 0) {
    alert("Assign at least one transcript to continue. Audio is optional.");
    btn.text("Next").property("disabled", false).style("opacity", 1);
    return;
  }

  const appMode = (window.APP_MODE || "").toLowerCase();
  const projectTranscriptCount = Math.max(1, assignedTranscriptCount);

  function clearThemeSelectionState(projectId) {
    const storageScope = getProjectStorageScope(projectId);
    const themesKey = storageScope ? `themesObject_${storageScope}` : "themesObject";
    const selectionCompleteKey = storageScope
      ? `themeSelectionComplete_${storageScope}`
      : "themeSelectionComplete";
    localStorage.removeItem(themesKey);
    sessionStorage.removeItem(themesKey);
    if (!storageScope) {
      localStorage.removeItem("themesObject");
      sessionStorage.removeItem("themesObject");
    }
    localStorage.removeItem(selectionCompleteKey);
    sessionStorage.removeItem(selectionCompleteKey);
    if (!storageScope) {
      localStorage.removeItem("themeSelectionComplete");
      sessionStorage.removeItem("themeSelectionComplete");
    }
  }

  function ensureProgressAnimations() {
    if (document.getElementById("generation-progress-animations")) return;
    const style = document.createElement("style");
    style.id = "generation-progress-animations";
    style.textContent = `
      @keyframes generation-stage-spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
    `;
    document.head.appendChild(style);
  }

  function setStageVisual(id, state) {
    const circle = d3.select("#stage-circle-" + id);
    const icon = d3.select("#stage-icon-" + id);
    const label = d3.select("#stage-label-" + id);
    if (circle.empty() || icon.empty()) return;

    if (state === "done") {
      circle
        .style("background", "#22c55e")
        .style("border", "2px solid #22c55e");
      icon
        .text("✓")
        .style("width", "auto")
        .style("height", "auto")
        .style("border", "none")
        .style("animation", "none")
        .style("border-radius", "0")
        .style("color", "#ffffff")
        .style("font-size", "16px")
        .style("font-weight", "800")
        .style("line-height", "1");
      label.style("color", "#1f2937");
      return;
    }

    if (state === "active") {
      circle
        .style("background", "#ffffff")
        .style("border", "2px solid #9bb2f6");
      icon
        .text("")
        .style("width", "14px")
        .style("height", "14px")
        .style("border", "2px solid #dbe5ff")
        .style("border-top", "2px solid #3a61dd")
        .style("border-radius", "50%")
        .style("animation", "generation-stage-spin 0.9s linear infinite")
        .style("color", "transparent")
        .style("font-size", "0");
      label.style("color", "#111827");
      return;
    }

    circle
      .style("background", "#ffffff")
      .style("border", "2px solid #b6bac5");
    icon
      .text("")
      .style("width", "10px")
      .style("height", "10px")
      .style("border", "2px solid #b6bac5")
      .style("border-top", "2px solid #b6bac5")
      .style("border-radius", "50%")
      .style("animation", "none")
      .style("color", "transparent")
      .style("font-size", "0");
    label.style("color", "#4b5563");
  }

  function updateProgress(stage) {
    const clamped = Math.max(0, Math.min(4, Number(stage) || 0));
    for (let i = 1; i <= 3; i++) {
      if (clamped >= 4 || i < clamped) {
        setStageVisual(i, "done");
      } else if (i === clamped && clamped >= 1 && clamped < 4) {
        setStageVisual(i, "active");
      } else {
        setStageVisual(i, "pending");
      }
    }
  }

  function showLoadingPopup() {
    ensureProgressAnimations();
    if (!generationEtaController) {
      generationEtaController = createThemeGenerationEtaController("generation-stage-eta", {
        workloadUnits: projectTranscriptCount,
      });
    }
    generationEtaController.reset("Estimated remaining time: preparing estimate...", {
      workloadUnits: projectTranscriptCount,
    });
    d3.select("#generation-overlay").remove();
    const overlay = d3.select("#main-edit-window")
      .append("div")
      .attr("id", "generation-overlay")
      .style("position", "absolute")
      .style("top", "0")
      .style("left", "0")
      .style("right", "0")
      .style("bottom", "0")
      .style("background", "rgba(0,0,0,0.15)")
      .style("z-index", 9999)
      .style("display", "flex")
      .style("align-items", "center")
      .style("justify-content", "center");

    const popUpHolderAI = overlay.append("div")
      .attr("id", "popUpHolder")
      .style("background", "#ffffff")
      .style("height", "auto")
      .style("max-height", "70vh")
      .style("width", "620px")
      .style("display", "flex")
      .style("flex-direction", "column")
      .style("justify-content", "center")
      .style("align-items", "center")
      .style("border-radius", "15px")
      .style("font-family", "Inter")
      .style("text-align", "center")
      .style("box-shadow", "0 4px 15px rgba(0, 0, 0, 0.2)")
      .style("padding", "18px 24px 16px")
      .style("overflow-y", "auto");

    popUpHolderAI.append("div")
      .attr("id", "generation-stage-title")
      .style("margin-top", "4px")
      .style("width", "520px")
      .style("font-weight", 800)
      .style("font-size", "22px")
      .text("Generating Codes and Excerpts. Please wait...");

    popUpHolderAI.append("div")
      .attr("id", "generation-stage-subtitle")
      .style("width", "540px")
      .style("margin-top", "10px")
      .style("font-size", "15px")
      .style("font-weight", 300)
      .style("color", "#444")
      .text("Privacy & data handling:");

    popUpHolderAI.append("div")
      .attr("id", "generation-stage-eta")
      .style("width", "540px")
      .style("margin-top", "8px")
      .style("font-size", "14px")
      .style("font-weight", 600)
      .style("color", "#6b7280")
      .text("Estimated remaining time: preparing estimate...");

    popUpHolderAI.append("div")
      .attr("id", "generation-stage-scope")
      .style("width", "540px")
      .style("margin-top", "6px")
      .style("font-size", "12px")
      .style("font-weight", 600)
      .style("color", "#64748b")
      .text(
        `Project-wide estimate across ${projectTranscriptCount} transcript${projectTranscriptCount === 1 ? "" : "s"}.`
      );

    const privacyBox = popUpHolderAI.append("div")
      .attr("id", "generation-privacy-bullets")
      .style("width", "540px")
      .style("margin-top", "10px")
      .style("text-align", "left")
      .style("font-size", "12.5px")
      .style("line-height", "1.35")
      .style("color", "#555");

    const bulletList = privacyBox.append("ul")
      .style("margin", "0")
      .style("padding-left", "18px");

    [
      "Local storage: Files and results stay in your local workspace until you remove them.",
      "AI processing: Requests go to your configured model service. Hosted providers receive transcript text and questions.",
      "Provider policies: Your model provider determines its own data retention and training policies. Review them before processing sensitive data.",
    ].forEach(text => {
      const row = bulletList.append("li");
      const match = text.match(/^([^:]+):(.*)$/);
      if (match) {
        row.append("strong").text(match[1].trim() + ": ");
        row.append("span").text(match[2].trim());
      } else {
        row.text(text);
      }
    });

    popUpHolderAI.append("div")
      .attr("id", "generation-browse-note")
      .style("width", "540px")
      .style("margin-top", "10px")
      .style("font-size", "16px")
      .style("font-weight", 800)
      .style("line-height", "1.35")
      .style("color", "#2563eb")
      .text("You can continue browsing other tabs while this runs.");

    const progressContainer = popUpHolderAI.append("div")
      .attr("id", "progress-stages")
      .style("display", "flex")
      .style("flex-direction", "row")
      .style("align-items", "center")
      .style("margin-top", "18px")
      .style("gap", "40px");

    function makeStage(id, label) {
      const stage = progressContainer.append("div")
        .style("display", "flex")
        .style("flex-direction", "column")
        .style("align-items", "center");

      stage.append("div")
        .attr("class", "stage-circle")
        .attr("id", "stage-circle-" + id)
        .style("width", "30px")
        .style("height", "30px")
        .style("display", "flex")
        .style("align-items", "center")
        .style("justify-content", "center")
        .style("border-radius", "50%")
        .style("border", "2px solid #b6bac5")
        .style("background", "#fff")
        .append("div")
        .attr("id", "stage-icon-" + id)
        .style("width", "10px")
        .style("height", "10px")
        .style("border", "2px solid #b6bac5")
        .style("border-radius", "50%");

      stage.append("div")
        .attr("id", "stage-label-" + id)
        .style("margin-top", "6px")
        .style("font-size", "13px")
        .style("color", "#4b5563")
        .text(label);
    }

    makeStage(1, "Tagging Questions");
    makeStage(2, "Tagging Answers");
    makeStage(3, "Generating Codes");
    updateProgress(0);
    return overlay;
  }

  function hideLoadingPopup() {
    if (generationEtaController) {
      generationEtaController.stop();
    }
    d3.select("#generation-overlay").remove();
  }

  function setManualCodingMode(projectId = getCurrentProjectId()) {
    const storageScope = getProjectStorageScope(projectId);
    const key = storageScope ? `manualCodingOnly_${storageScope}` : "manualCodingOnly";
    localStorage.setItem(key, "1");
    if (!storageScope) {
      localStorage.setItem("manualCodingOnly", "1");
    }
  }

  function clearManualCodingMode(projectId = getCurrentProjectId()) {
    const storageScope = getProjectStorageScope(projectId);
    const key = storageScope ? `manualCodingOnly_${storageScope}` : "manualCodingOnly";
    localStorage.removeItem(key);
    if (!storageScope) {
      localStorage.removeItem("manualCodingOnly");
    }
  }

  function appendChoiceButton(container, label, options = {}) {
    const button = container.append("button")
      .attr("type", "button")
      .style("height", "52px")
      .style("min-width", options.minWidth || "170px")
      .style("padding", "0 22px")
      .style("border-radius", "10px")
      .style("border", options.border || "1px solid #d7dce5")
      .style("background", options.background || "#ffffff")
      .style("color", options.color || "#111827")
      .style("font-family", "Inter")
      .style("font-size", "16px")
      .style("font-weight", 800)
      .style("box-shadow", options.boxShadow || "none")
      .style("cursor", "pointer")
      .text(label);

    if (typeof options.onClick === "function") {
      button.on("click", options.onClick);
    }
    return button;
  }

  function showPostProcessingChoicePage({ onStartAiTagging, onManualCoding }) {
    hideLoadingPopup();
    const root = d3.select("#main-edit-window");
    root.selectAll("*").remove();
    root
      .style("display", "flex")
      .style("align-items", "center")
      .style("justify-content", "center")
      .style("background", "#f8fafc")
      .style("padding", "36px");

    const panel = root.append("div")
      .attr("id", "post-upload-choice")
      .style("width", "min(880px, 100%)")
      .style("background", "#ffffff")
      .style("border", "1px solid #e5e7eb")
      .style("border-radius", "16px")
      .style("box-shadow", "0 12px 36px rgba(15, 23, 42, 0.12)")
      .style("padding", "42px")
      .style("font-family", "Inter");

    panel.append("div")
      .style("font-size", "34px")
      .style("line-height", "1.15")
      .style("font-weight", 850)
      .style("color", "#111827")
      .text("Files are ready");

    panel.append("div")
      .style("margin-top", "14px")
      .style("max-width", "720px")
      .style("font-size", "18px")
      .style("line-height", "1.45")
      .style("font-weight", 700)
      .style("color", "#4b5563")
      .text("Run AI tagging now, or skip it and start coding manually from the transcript pages.");

    const options = panel.append("div")
      .style("display", "grid")
      .style("grid-template-columns", "repeat(auto-fit, minmax(260px, 1fr))")
      .style("gap", "18px")
      .style("margin-top", "32px");

    const aiOption = options.append("div")
      .style("border", "1px solid #c7d2fe")
      .style("border-radius", "14px")
      .style("background", "#f8fbff")
      .style("padding", "22px");

    aiOption.append("div")
      .style("font-size", "19px")
      .style("font-weight", 850)
      .style("color", "#111827")
      .text("AI tagging");

    aiOption.append("div")
      .style("margin-top", "8px")
      .style("font-size", "14px")
      .style("line-height", "1.45")
      .style("font-weight", 650)
      .style("color", "#5b6472")
      .text("Generate suggested questions, answers, codes, and excerpts in the background.");

    appendChoiceButton(aiOption.append("div").style("margin-top", "18px"), "Continue AI tagging", {
      background: "#3A61DD",
      color: "#ffffff",
      border: "1px solid #3A61DD",
      boxShadow: "0 8px 18px rgba(58, 97, 221, 0.22)",
      onClick: async function() {
        d3.select(this).property("disabled", true).style("opacity", 0.65).text("Starting...");
        await onStartAiTagging();
      }
    });

    const manualOption = options.append("div")
      .style("border", "1px solid #d7dce5")
      .style("border-radius", "14px")
      .style("background", "#ffffff")
      .style("padding", "22px");

    manualOption.append("div")
      .style("font-size", "19px")
      .style("font-weight", 850)
      .style("color", "#111827")
      .text("Manual coding");

    manualOption.append("div")
      .style("margin-top", "8px")
      .style("font-size", "14px")
      .style("line-height", "1.45")
      .style("font-weight", 650)
      .style("color", "#5b6472")
      .text("Open the transcripts now and create codes directly without waiting for AI outputs.");

    appendChoiceButton(manualOption.append("div").style("margin-top", "18px"), "Go to transcripts", {
      background: "#111827",
      color: "#ffffff",
      border: "1px solid #111827",
      onClick: onManualCoding
    });

    const quickLinks = panel.append("div")
      .style("display", "flex")
      .style("flex-wrap", "wrap")
      .style("gap", "12px")
      .style("margin-top", "28px")
      .style("padding-top", "24px")
      .style("border-top", "1px solid #edf0f4");

    [
      ["Codes", "/themes"],
      ["Visualization", "/visualization"],
      ["File Manager", "/fileManager"]
    ].forEach(([label, href]) => {
      appendChoiceButton(quickLinks, label, {
        minWidth: "132px",
        background: "#f8fafc",
        color: "#334155",
        border: "1px solid #d7dce5",
        onClick: () => {
          if (label !== "File Manager") {
            setManualCodingMode(getCurrentProjectId());
          }
          window.location.href = href;
        }
      });
    });
  }

  async function startAiTaggingAfterTranscriptProcessing(syncedFileMapForRun) {
    const currentProjectId = getCurrentProjectId();
    const storageScope = getProjectStorageScope(currentProjectId);
    const generatedThemesKey = storageScope
      ? `generatedPossibleThemes_${storageScope}`
      : "generatedPossibleThemes";
    const generatedThemesLegacyKey = "generatedPossibleThemes";

    try {
      const existingProgress = await fetchGenerationProgress().catch(() => null);
      if (isGenerationProgressRunning(existingProgress)) {
        showLoadingPopup();
        syncResumeGenerationPopup(existingProgress);
        window.dispatchEvent(new CustomEvent("themes:generation-started", {
          detail: {
            projectId: currentProjectId,
            fileMap: syncedFileMapForRun || FileMap,
            reason: "theme-generation-resumed"
          }
        }));
        await watchGenerationUntilComplete({ redirectOnComplete: true });
        return;
      }
      if (isGenerationProgressComplete(existingProgress)) {
        persistGeneratedThemesFromProgress(existingProgress);
        await syncGeneratedThemePayloadFromServer();
        window.location.href = "/themes";
        return;
      }

      showLoadingPopup();
      const title = d3.select("#generation-stage-title");
      if (!title.empty()) title.text("Starting theme generation...");
      const startResponse = await fetch("/create_themes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(currentProjectId ? { projectId: currentProjectId } : {})
      });
      const startPayload = await startResponse.json().catch(() => ({}));
      if (!startResponse.ok) {
        const details = startPayload?.error || startPayload?.message || "";
        throw new Error(details || `Failed to start theme generation (${startResponse.status})`);
      }
      const startStatus = startPayload?.status || "started";
      clearFileUpdateWorkflowState(currentProjectId);
      clearManualCodingMode(currentProjectId);
      if (startStatus === "up_to_date") {
        if (startPayload?.progress) {
          persistGeneratedThemesFromProgress(startPayload.progress);
          updateProgress(Number(startPayload.progress.stage) >= 4 ? 4 : 0);
        }
        await syncGeneratedThemePayloadFromServer();
        hideLoadingPopup();
        window.location.href = "/themes";
        return;
      }
      if (startStatus === "started") {
        clearThemeSelectionState(currentProjectId);
        markThemeSelectionPending(currentProjectId);
        localStorage.removeItem(generatedThemesKey);
        if (!storageScope) {
          localStorage.removeItem(generatedThemesLegacyKey);
        }
      }
      generationEtaController?.markStarted();
      window.dispatchEvent(new CustomEvent("themes:generation-started", {
        detail: {
          projectId: currentProjectId,
          fileMap: syncedFileMapForRun || FileMap,
          reason: startStatus === "already_running"
            ? "theme-generation-already-running"
            : "theme-generation-started"
        }
      }));

      const POLL_MS = 1500;
      const MAX_WAIT_MS = 6 * 60 * 1000;
      const startedAt = Date.now();
      let reachedStage = 0;

      while (true) {
        const progressParam = currentProjectId ? `?projectId=${encodeURIComponent(currentProjectId)}` : "";
        const progressRes = await fetch(`/progress${progressParam}`, { cache: "no-store" });
        if (!progressRes.ok) {
          throw new Error(`Progress request failed (${progressRes.status})`);
        }

        const progress = await progressRes.json();
        const stage = Number(progress?.stage) || 0;
        reachedStage = Math.max(reachedStage, stage);
        if (reachedStage >= 1) {
          updateProgress(reachedStage);
        }
        generationEtaController?.update(progress);

        if (!title.empty() && progress?.message) {
          title.text(progress.message);
        }

        if (stage === -1) {
          throw new Error(progress?.message || "Theme generation failed.");
        }

        if (stage >= 4) {
          if (Array.isArray(progress?.themes) && progress.themes.length > 0) {
            localStorage.setItem(generatedThemesKey, JSON.stringify(progress.themes));
            if (!storageScope) {
              localStorage.setItem(generatedThemesLegacyKey, JSON.stringify(progress.themes));
            }
          }
          await syncGeneratedThemePayloadFromServer();
          updateProgress(4);
          break;
        }

        if ((Date.now() - startedAt) >= MAX_WAIT_MS) {
          console.warn("Theme generation timed out in the UI; continuing to theme selection.");
          break;
        }

        await new Promise(resolve => setTimeout(resolve, POLL_MS));
      }
    } catch (e) {
      console.warn("Theme generation failed:", e);
      hideLoadingPopup();
      alert("Theme generation failed. You can retry from the Themes tab.");
      window.location.href = "/themes";
      return;
    }

    hideLoadingPopup();
    window.location.href = "/themes";
  }

  const activeProjectId = getCurrentProjectId();
  const syncedFileMap = persistFileMapToStorage(FileMap, {
    projectId: activeProjectId,
    reason: "transcript-processing-started"
  });
  await saveFileMapToSession(activeProjectId);

  if (appMode !== "demo") {
    showLoadingPopup();
    const title = d3.select("#generation-stage-title");
    if (!title.empty()) title.text("Processing transcripts...");
  }

  try {
    const projectId = getCurrentProjectId();
    const response = await fetch('/process_all_transcripts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...FileMap, projectId })
    });
    const result = await response.json();

    if (!response.ok) {
      if (appMode !== "demo") hideLoadingPopup();
      alert("Error during transcript processing: " + (result.error || "Unknown server error. Check console."));
      btn.text("Next").property("disabled", false).style("opacity", 1);
      return;
    }
    console.log("Server processing successful:", result.message);
  } catch (error) {
    if (appMode !== "demo") hideLoadingPopup();
    alert("A network error occurred while trying to process files. Please check your connection and try again.");
    btn.text("Next").property("disabled", false).style("opacity", 1);
    return;
  }

  if (FileMap && FileMap.participants) {
    const projectId = getCurrentProjectId();
    persistFileMapToStorage(FileMap, { projectId, reason: "transcripts-processed" });
    void saveFileMapToSession(projectId);
  } else {
    const projectId = getCurrentProjectId();
    clearStoredFileMap({ projectId, reason: "transcripts-processed" });
  }

  if (appMode === "demo") {
    clearFileUpdateWorkflowState(getCurrentProjectId());
    clearThemeSelectionState(getCurrentProjectId());
    window.location.href = "/themes";
    return;
  }

  const currentProjectId = getCurrentProjectId();
  clearFileUpdateWorkflowState(currentProjectId);
  showPostProcessingChoicePage({
    onStartAiTagging: () => startAiTaggingAfterTranscriptProcessing(syncedFileMap),
    onManualCoding: () => {
      setManualCodingMode(currentProjectId);
      window.location.href = "/transcriptmode";
    }
  });
}
