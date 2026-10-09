import { filesUploaded } from "../../../chromascribe-main.js";
import {
  fetchGenerationProgress,
  isGenerationProgressRunning,
  resumeGenerationProgressIfRunning,
  syncAudiosToTranscripts
} from "./syncAudiosToTranscripts.js?v=20260601c";
import { uploadFiles } from "./uploadFiles.js?v=20260601c";
import {
  clearStoredFileMap,
  getStoredFileMap as getSyncedStoredFileMap,
  hydrateFileMapFromServer
} from "../../fileMapSync.js?v=20260601b";

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

function setProjectNameWarning(message = "") {
  const warningEl = document.getElementById("projectNameWarning");
  const inputEl = document.getElementById("projectNameInput");
  if (warningEl) {
    warningEl.textContent = message || "";
    warningEl.style.display = message ? "block" : "none";
  }
  if (inputEl) {
    inputEl.style.borderColor = message ? "#D93025" : "#000000";
    inputEl.setAttribute("aria-invalid", message ? "true" : "false");
  }
}

/* ---------------- Shared UI (match other steps) ---------------- */
function renderDotsInside(bottomBar, activeIndex = 0) {
  // remove any prior #circles to avoid duplicates
  d3.select("#circles").remove();

  const wrap = bottomBar.append("div")
    .attr("id", "circles")
    .style("display", "flex")
    .style("justify-content", "center")
    .style("align-items", "center")
    .style("gap", "10px")
    .style("flex", "1");

  // pill background like the other pages
  const pill = wrap.append("div")
    .style("display", "flex")
    .style("align-items", "center")
    .style("justify-content", "center")
    .style("gap", "10px")
    .style("padding", "6px 10px")
    .style("border-radius", "999px")
    .style("box-shadow", "0 0 10px rgba(0,0,0,0.08)")
    .style("background", "#fff");

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
          case "0": nameProject(); break;
          case "1": uploadFiles(); break;
          case "2": (typeof renderUploadQuestionSetUI === "function") && renderUploadQuestionSetUI(); break;
          case "3": syncAudiosToTranscripts(); break;
        }
      });
  }
}

function renderBottomButtons(mainEditWindow, backAction, nextAction, activeIndex = 0) {
  const bar = mainEditWindow.append("div")
    .attr("id", "bottomButtonsBar")
    .style("position", "sticky")
    .style("bottom", "0")
    .style("z-index", "5")
    .style("display", "flex")
    .style("align-items", "center")
    .style("gap", "12px")
    .style("width", "100%")
    .style("padding", "15px 5%")
    .style("background-color", "#ffffff")
    .style("box-shadow", "0 -2px 8px rgba(0,0,0,0.1)")
    .style("box-sizing", "border-box");

  // Left: Back
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

  // Center: dots (stepper)
  renderDotsInside(bar, activeIndex);

  // Right: Next
  bar.append("button")
    .attr("id", "nameNextBtn")
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

/* ---------------- Page ---------------- */
export async function nameProject() {
  markUsageStep("Name project", {
    stepKey: "file_manager_name_project",
    workflow: "file_manager_import",
  });
  const mainEditWindow = d3.select("#main-edit-window");
  mainEditWindow.selectAll("*").remove();

  // Structure to keep footer at bottom (same as other steps)
  mainEditWindow
    .style("position", "relative")
    .style("display", "flex")
    .style("flex-direction", "column")
    .style("justify-content", "space-between")
    .style("height", "100%")
    .style("overflow-y", "auto")
    .style("overflow-x", "hidden");

  const projectState = await handleProjectState();
  // Attempt to restore any previously saved FileMap for this session.
  await hydrateFileMapFromSession();

  let fileMap = getStoredFileMap();
  const storageScope = getProjectStorageScope();
  const dataKey = storageScope ? `data.json_${storageScope}` : "data.json";
  const data = JSON.parse(localStorage.getItem(dataKey) || "{}");
  if ((!fileMap || !Array.isArray(fileMap.participants)) && Array.isArray(data.participants)) {
    fileMap = { participants: data.participants };
  }
  const hasMatchedFiles = fileMap && Array.isArray(fileMap.participants) && fileMap.participants.length > 0;

  if (!hasMatchedFiles && isProjectNameConfirmed(projectState)) {
    uploadFiles();
    return;
  }

  const content = mainEditWindow.append("div")
    .style("flex-grow", "1")
    .style("display", "flex")
    .style("flex-direction", "column")
    .style("align-items", "center");

  // ===== EXISTING PROJECT: File Manager view =====
  if (hasMatchedFiles) {
    const projectId = getCurrentProjectId();
    const progress = await getFileManagerTaggingProgress();
    if (!isGenerationProgressRunning(progress) && isFileUpdateWorkflowActive(projectId)) {
      uploadFiles();
      return;
    }

    const tableMaxWidth = "calc(100% - 96px)";
    const headerRow = content.append("div")
      .style("width", "100%")
      .style("max-width", tableMaxWidth)
      .style("display", "flex")
      .style("align-items", "center")
      .style("justify-content", "space-between")
      .style("margin-top", "32px")
      .style("gap", "16px");

    headerRow.append("div")
      .style("font-family", "Inter")
      .style("font-size", "34px")
      .style("font-weight", 700)
      .style("color", "#3A61DD")
      .text("File Manager");

    const mainContentContainer = content.append("div")
      .style("display", "flex")
      .style("flex-direction", "column")
      .style("align-items", "center")
      .style("margin-top", "20px")
      .style("width", "100%")
      .style("font-family", "Nunito")
      .style("font-size", "20px")
      .style("font-weight", 800)
      .style("color", "#000000")
      .style("text-align", "left");

    const filesColumn = mainContentContainer.append("div")
      .style("width", "100%")
      .style("max-width", tableMaxWidth);
    const filesMatched = filesColumn.append("div")
      .attr("id", "participantsMatching")
      .style("margin-top", "10px")
      .style("display", "flex")
      .style("flex-direction", "column")
      .style("align-items", "center")
      .style("overflow", "hidden")
      .style("border-radius", "12px")
      .style("opacity", "1")
      .style("background", "#ffffff")
      .style("border", "1px solid #d9d9d9")
      .style("box-shadow", "0 4px 12px rgba(0, 0, 0, 0.08)");

    const labels = filesMatched.append("div")
      .style("display", "grid")
      .style("grid-template-columns", "140px minmax(220px, 1fr) minmax(220px, 1fr)")
      .style("align-items", "center")
      .style("text-align", "left")
      .style("color", "#3A61DD")
      .style("font-size", "16px")
      .style("font-weight", 700)
      .style("background", "#f7f9ff")
      .style("border-bottom", "1px solid #e8e8e8")
      .style("width", "100%")
      .style("padding", "12px 0");

    const headerParticipant = labels.append("div")
      .style("min-width", "0")
      .style("padding", "0 16px")
      .style("border-right", "1px solid #e3e3e3")
      .text("Participants");
    const headerTranscript = labels.append("div")
      .style("min-width", "0")
      .style("padding", "0 16px")
      .style("border-right", "1px solid #e3e3e3")
      .text("Transcript");
    const headerAudio = labels.append("div")
      .style("min-width", "0")
      .style("padding", "0 16px")
      .text("Audio");

    displayFileMap(fileMap);

    const stateRendered = renderFileManagerTaggingState(mainContentContainer, {
      progress,
      fileMap,
    });

    if (!stateRendered) {
      // Sticky bottom bar with centered dots (activeIndex=0 for step 1)
      renderBottomButtons(mainEditWindow, () => { window.location.href = '/'; }, uploadFiles, 0);
    }
    return;
  }

  // ===== NEW PROJECT: Title (single line) + centered input =====
  const hero = content.append("div")
    .style("display", "flex")
    .style("flex-direction", "column")
    .style("align-items", "center")
    .style("margin-top", "180px")
    .style("width", "100%");

  // Single-line title (no wrapping)
  hero.append("div")
    .style("font-family", "Inter")
    .style("font-size", "34px")
    .style("font-weight", 700)
    .style("line-height", "1")
    .style("white-space", "nowrap")
    .style("overflow", "hidden")
    .style("text-overflow", "clip")
    .style("color", "#3A61DD")
    .text("Name Your Project");

  // Wider centered input inside right panel
  hero.append("input")
    .attr("id", "projectNameInput")
    .attr("placeholder", "Add your project name")
    .style("margin-top", "24px")
    .style("width", "84%")
    .style("max-width", "1500px")
    .style("min-width", "360px")
    .style("padding", "12px 20px")
    .style("border-radius", "10px")
    .style("background", "#ffffff")
    .style("border", "2px solid #000000")
    .style("font-family", "Nunito")
    .style("font-size", "20px")
    .style("font-weight", 500)
    .style("text-align", "center")
    .on("input", () => setProjectNameWarning(""));

  hero.append("div")
    .attr("id", "projectNameWarning")
    .attr("role", "alert")
    .attr("aria-live", "polite")
    .style("display", "none")
    .style("margin-top", "12px")
    .style("width", "84%")
    .style("max-width", "1500px")
    .style("min-width", "360px")
    .style("color", "#D93025")
    .style("font-family", "Inter")
    .style("font-size", "15px")
    .style("font-weight", 600)
    .style("text-align", "center");

  // Ensure a blank project-scoped data cache exists.
  const blankStorageScope = getProjectStorageScope();
  const blankDataKey = blankStorageScope ? `data.json_${blankStorageScope}` : "data.json";
  if (!localStorage.getItem(blankDataKey)) {
    localStorage.setItem(blankDataKey, JSON.stringify({}));
  }

  // Sticky bottom bar with centered dots (activeIndex=0 for step 1)
  renderBottomButtons(
    mainEditWindow,
    () => { window.location.href = '/'; },
    async () => {
      setProjectNameWarning("");
      const input = document.getElementById("projectNameInput");
      const projectName = input ? input.value.trim() : "";
      try {
        const response = await fetch("/api/project/set", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectName }),
        });
        if (response.status === 409) {
          const payload = await response.json().catch(() => ({}));
          const warningMessage = payload.warning || payload.error || "This project name already exists. Choose a different name.";
          setProjectNameWarning(warningMessage);
          if (input) {
            input.focus();
            input.select();
          }
          return;
        }
        if (!response.ok) {
          throw new Error(`Failed to persist project name: ${response.status}`);
        }
        const projectContext = await response.json().catch(() => null);
        if (projectContext?.currentProjectId) {
          localStorage.setItem("currentProjectId", projectContext.currentProjectId);
        }
        if (projectContext && window.ChromaUsageLogger?.setContext) {
          window.ChromaUsageLogger.setContext(projectContext);
        }
      } catch (err) {
        console.warn("Failed to persist project name:", err);
        setProjectNameWarning("Could not save this project name right now. Please try again.");
        return;
      }
      uploadFiles();
    },
    0
  );
}

async function handleProjectState() {
  try {
    const response = await fetch('/api/check_project_state', { cache: 'no-store' });
    if (!response.ok) return null;
    const projectState = await response.json();
    const resolvedProjectId = String(projectState?.projectContext?.currentProjectId || getCurrentProjectId() || "").trim();
    if (resolvedProjectId) {
      localStorage.setItem("currentProjectId", resolvedProjectId);
    }
    if (projectState.isNewProject) {
      const projectId = resolvedProjectId;
      clearStoredFileMap({ projectId });
    }
    return projectState;
  } catch (err) {
    console.warn("Could not check project state:", err);
  }
  return null;
}

function isProjectNameConfirmed(projectState) {
  const progress = projectState?.projectProgress || projectState?.projectContext?.projectProgress || {};
  if (projectState?.projectNameConfirmed || projectState?.projectContext?.projectNameConfirmed || progress.projectNameConfirmed) {
    return true;
  }
  const projectName = String(projectState?.projectContext?.currentProjectName || "").trim();
  return Boolean(
    projectName
    && projectName.toLowerCase() !== "untitled project"
    && !/^project\s+\d+$/i.test(projectName)
  );
}

/* ---------------- Helpers ---------------- */
function displayFileMap(FileMap) {
  const container = d3.select("#participantsMatching");
  container.selectAll(".participant-row").remove();

  const participants = Array.isArray(FileMap?.participants) ? FileMap.participants : [];
  participants.forEach(participantEntry => {
    const row = container.append("div")
      .attr("class", "participant-row")
      .style("display", "grid")
      .style("grid-template-columns", "140px minmax(220px, 1fr) minmax(220px, 1fr)")
      .style("align-items", "center")
      .style("text-align", "left")
      .style("justify-content", "start")
      .style("width", "100%")
      .style("border-top", "1px solid #ededed")
      .style("padding", "10px 0");

    const participantCell = row.append("div")
      .style("min-width", "0")
      .style("padding", "0 16px")
      .style("border-right", "1px solid #ededed")
      .style("font-weight", 700)
      .style("color", "#1f1f1f");
    appendCellText(participantCell, participantEntry.participant || "", false);

    const transcriptCell = row.append("div")
      .style("min-width", "0")
      .style("padding", "0 16px")
      .style("border-right", "1px solid #ededed")
      .style("display", "flex")
      .style("flex-direction", "column");

    const transcriptName = getEntryDisplayName(participantEntry.transcript);
    appendCellText(transcriptCell, transcriptName || "No Transcript Files", !transcriptName);

    const audioCell = row.append("div")
      .style("min-width", "0")
      .style("padding", "0 16px")
      .style("display", "flex")
      .style("flex-direction", "column");

    const audioName = getEntryDisplayName(participantEntry.audio);
    appendCellText(audioCell, audioName || "No Audio Files", !audioName);
  });
}

async function getFileManagerTaggingProgress() {
  if ((window.APP_MODE || "").toLowerCase() === "demo") return null;
  try {
    return await fetchGenerationProgress();
  } catch (error) {
    console.warn("Could not read tagging progress for File Manager:", error);
    return null;
  }
}

function isTaggingComplete(progress) {
  const stage = Number(progress && progress.stage);
  const message = String(progress && progress.message || "").trim().toLowerCase();
  return stage >= 4 || message === "complete" || Array.isArray(progress?.themes);
}

function renderFileManagerTaggingState(container, { progress, fileMap }) {
  d3.select("#file-manager-tagging-state").remove();
  if (!progress) return false;

  if (isGenerationProgressRunning(progress)) {
    void resumeGenerationProgressIfRunning({
      redirectOnComplete: false,
      fileMap,
      onComplete: () => {
        void nameProject();
      }
    });
    return true;
  }

  if (!isTaggingComplete(progress)) return false;

  const panel = container.append("div")
    .attr("id", "file-manager-tagging-state")
    .style("width", "calc(100% - 96px)")
    .style("max-width", "1400px")
    .style("box-sizing", "border-box")
    .style("margin-top", "24px")
    .style("padding", "28px 30px")
    .style("border", "1px solid #ccefd8")
    .style("border-radius", "14px")
    .style("background", "#f6fff8")
    .style("box-shadow", "0 3px 12px rgba(30, 80, 45, 0.06)")
    .style("font-family", "Inter");

  panel.append("div")
    .style("font-size", "24px")
    .style("line-height", "1.25")
    .style("font-weight", "800")
    .style("color", "#1f2937")
    .text("AI tagging is complete for this project");

  panel.append("div")
    .style("margin-top", "14px")
    .style("font-size", "17px")
    .style("line-height", "1.45")
    .style("font-weight", "700")
    .style("color", "#5d6675")
    .text("No new tagging run is needed. Go to Codes to review the AI outputs and choose matching excerpts, or change files only if you want to replace/update transcript or audio files.");

  const actions = panel.append("div")
    .style("display", "flex")
    .style("flex-wrap", "wrap")
    .style("gap", "18px")
    .style("margin-top", "24px");

  appendFileManagerActionButton(actions, "Go to Codes", {
    background: "#3A61DD",
    color: "#ffffff",
    border: "1px solid #3A61DD",
    onClick: () => { window.location.href = "/themes"; }
  });
  appendFileManagerActionButton(actions, "Visualization", {
    background: "#eef3ff",
    color: "#2f52c6",
    border: "1px solid #cfdafe",
    onClick: () => { window.location.href = "/visualization"; }
  });
  appendFileManagerActionButton(actions, "Transcripts", {
    background: "#eef3ff",
    color: "#2f52c6",
    border: "1px solid #cfdafe",
    onClick: () => { window.location.href = "/transcriptmode"; }
  });
  appendFileManagerActionButton(actions, "Change files", {
    background: "#fffafa",
    color: "#b42318",
    border: "1px solid #f5b5b5",
    onClick: beginFileUpdateWorkflow
  });

  return true;
}

function appendFileManagerActionButton(container, label, options) {
  container.append("button")
    .attr("type", "button")
    .style("min-width", "104px")
    .style("height", "48px")
    .style("padding", "0 20px")
    .style("border-radius", "9px")
    .style("border", options.border)
    .style("background", options.background)
    .style("color", options.color)
    .style("font-family", "Inter")
    .style("font-size", "16px")
    .style("font-weight", "800")
    .style("cursor", "pointer")
    .style("box-shadow", "none")
    .text(label)
    .on("click", options.onClick);
}

function beginFileUpdateWorkflow() {
  const projectId = getCurrentProjectId();
  const storageScope = getProjectStorageScope(projectId);
  if (storageScope) {
    localStorage.setItem(`fileUpdateWorkflow_${storageScope}`, "1");
  } else if (projectId) {
    localStorage.setItem(`fileUpdateWorkflow_${projectId}`, "1");
  }
  uploadFiles();
}

function isFileUpdateWorkflowActive(projectId) {
  const storageScope = getProjectStorageScope(projectId);
  if (storageScope && localStorage.getItem(`fileUpdateWorkflow_${storageScope}`) === "1") {
    return true;
  }
  return Boolean(projectId && !storageScope && localStorage.getItem(`fileUpdateWorkflow_${projectId}`) === "1");
}

function appendCellText(container, text, muted) {
  container.append("span")
    .style("display", "block")
    .style("white-space", "nowrap")
    .style("overflow", "hidden")
    .style("text-overflow", "ellipsis")
    .style("font-size", "14px")
    .style("font-weight", muted ? 500 : 600)
    .style("color", muted ? "#7a7a7a" : "#1f1f1f")
    .attr("title", text || "")
    .text(text);
}

async function hydrateFileMapFromSession() {
  await hydrateFileMapFromServer(getCurrentProjectId());
}

function getStoredFileMap() {
  return getSyncedStoredFileMap(getCurrentProjectId());
}

function getEntryDisplayName(entry) {
  if (!entry) return "";
  if (Array.isArray(entry)) {
    return entry.map(getEntryDisplayName).filter(Boolean).join(", ");
  }
  if (typeof entry === "string") return entry;
  const name = entry.originalFilename || entry.name || entry.relativePath || entry.processedName || entry.serverTranscriptUrl;
  if (!name) return "";
  return truncateName(name, 48);
}

function truncateName(name, maxLength) {
  if (!name || name.length <= maxLength) return name;
  return `${name.slice(0, maxLength - 3)}...`;
}
