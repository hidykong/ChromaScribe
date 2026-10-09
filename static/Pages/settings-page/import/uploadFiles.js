import { appendTranscriptImportPreview } from "./transcriptImportPreview.js?v=20260922a";
import { nameProject } from "./nameProject.js?v=20260601d";
import { syncAudiosToTranscripts } from "./syncAudiosToTranscripts.js?v=20260601c";
import { fileLists } from "../../../chromascribe-main.js"; // Path to main shared state
// --- NEW: A state variable for the debounce timer ---
let debounceTimer;

function markUsageStep(stepName, details = {}) {
  const payload = { stepName, ...details };
  window.__pendingChromaUsageStep = payload;
  if (window.ChromaUsageLogger && typeof window.ChromaUsageLogger.setStep === "function") {
    window.ChromaUsageLogger.setStep(stepName, payload);
  }
}

// ------------------------------
// Progress dots inside bottom bar
// ------------------------------
function renderDotsInside(bottomBar, activeIndex = 0) {
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
          case "0": nameProject(); break;
          case "1": uploadFiles(); break;
          case "2": (typeof renderUploadQuestionSetUI === "function") && renderUploadQuestionSetUI(); break;
          case "3": syncAudiosToTranscripts(); break;
        }
      });
  }
}

// ------------------------------------
// Sticky bottom bar (Back | Dots | Next)
// ------------------------------------
function renderBottomButtons(mainEditWindow, backAction, nextAction, activeIndex) {
  mainEditWindow.select("#bottomButtonsBar").remove();
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
    .attr("id", "nextBtn")
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

// --- State variables for folder selection and processing ---
export let allProjectFiles = []; // {file, id, type, serverTranscriptUrl, relativePath, originalFilename, size}
let fileProcessingStatus = {};   // {id: {status, message}}
let manualQuestions = ["", ""];  // Start with two empty questions
let activeProjectId = null;
let manualQuestionsLoaded = false;
let manualQuestionsLoadedProjectId = null;

async function resolveProjectId() {
  try {
    const response = await fetch('/api/session_context', { cache: "no-store" });
    if (response.ok) {
      const data = await response.json();
      if (data.currentProjectId) {
        if (activeProjectId && activeProjectId !== data.currentProjectId) {
          manualQuestions = ["", ""];
          manualQuestionsLoaded = false;
          manualQuestionsLoadedProjectId = null;
        }
        activeProjectId = data.currentProjectId;
        localStorage.setItem("currentProjectId", activeProjectId);
      }
    }
  } catch (err) {
    console.warn("Could not resolve project id:", err);
  }
  const stored = localStorage.getItem("currentProjectId");
  if (stored && stored !== activeProjectId) {
    activeProjectId = stored;
    manualQuestions = ["", ""];
    manualQuestionsLoaded = false;
    manualQuestionsLoadedProjectId = null;
  }
  return activeProjectId;
}

function projectStorageKey(prefix) {
  return `${prefix}_${activeProjectId || "default"}`;
}

function serializeProjectFiles() {
  return allProjectFiles.map(entry => ({
    id: entry.id,
    type: entry.type,
    originalFilename: entry.originalFilename,
    relativePath: entry.relativePath,
    serverTranscriptUrl: entry.serverTranscriptUrl || null,
    importSummary: entry.importSummary || null,
    preview: entry.preview || [],
    speakerRoles: entry.speakerRoles || {},
    size: entry.size || (entry.file ? entry.file.size : null)
  }));
}

function saveProjectFilesToStorage() {
  if (!activeProjectId) return;
  try {
    localStorage.setItem(projectStorageKey("projectFiles"), JSON.stringify(serializeProjectFiles()));
    localStorage.setItem(projectStorageKey("projectFileStatus"), JSON.stringify(fileProcessingStatus));
  } catch (err) {
    console.warn("Failed to persist project files:", err);
  }
}

function loadProjectFilesFromStorage() {
  if (!activeProjectId) return;
  try {
    const storedFiles = localStorage.getItem(projectStorageKey("projectFiles"));
    if (storedFiles) {
      const parsed = JSON.parse(storedFiles);
      if (Array.isArray(parsed)) {
        allProjectFiles = parsed.map(entry => ({
          ...entry,
          file: null,
          serverTranscriptUrl: entry.serverTranscriptUrl || null,
          size: entry.size || null
        }));
      }
    }
    const storedStatus = localStorage.getItem(projectStorageKey("projectFileStatus"));
    if (storedStatus) {
      fileProcessingStatus = JSON.parse(storedStatus) || {};
    } else {
      fileProcessingStatus = {};
      allProjectFiles.forEach(entry => {
        fileProcessingStatus[entry.id] = { status: "success", message: "Ready!" };
      });
    }
  } catch (err) {
    console.warn("Failed to load project files from storage:", err);
    allProjectFiles = [];
    fileProcessingStatus = {};
  }
}

function loadManualQuestionsFromStorage() {
  if (!activeProjectId) return;
  if (manualQuestionsLoaded && manualQuestionsLoadedProjectId === activeProjectId) return;
  try {
    const stored = localStorage.getItem(projectStorageKey("manualQuestions"));
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed) && parsed.length >= 2) {
        manualQuestions = parsed;
      }
    }
  } catch (err) {
    console.warn("Failed to load manual questions:", err);
  }
  manualQuestionsLoaded = true;
  manualQuestionsLoadedProjectId = activeProjectId;
}

function saveManualQuestionsToStorage() {
  if (!activeProjectId) return;
  try {
    localStorage.setItem(projectStorageKey("manualQuestions"), JSON.stringify(manualQuestions));
  } catch (err) {
    console.warn("Failed to persist manual questions:", err);
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function uploadFiles() {
  markUsageStep("Upload transcripts and audio", {
    stepKey: "file_manager_upload_files",
    workflow: "file_manager_import",
  });
  fetch('/api/check_project_state')
    .then(response => response.json())
    .then(async data => {
      await resolveProjectId();
      if (data.isNewProject) {
        console.log("New project state detected from server. Clearing client-side file list.");
        allProjectFiles = [];
        fileProcessingStatus = {};
        manualQuestions = ["", ""];
        manualQuestionsLoaded = false;
        manualQuestionsLoadedProjectId = null;
        if (activeProjectId) {
          localStorage.removeItem(projectStorageKey("projectFiles"));
          localStorage.removeItem(projectStorageKey("projectFileStatus"));
          localStorage.removeItem(projectStorageKey("manualQuestions"));
        }
      } else {
        loadProjectFilesFromStorage();
      }
      renderUploadProjectFilesUI();
    });
}

// -------------------------------
// Shared main frame (RIGHT PANEL)
// -------------------------------
function renderMainFrame() {
  const mainEditWindow = d3.select("#main-edit-window");
  mainEditWindow.selectAll("*").remove();

  mainEditWindow
    .style("position", "relative")
    .style("display", "flex")
    .style("flex-direction", "column")
    .style("min-height", "100%")
    .style("height", "100%")
    .style("overflow", "auto");

  const contentArea = mainEditWindow.append("div")
    .attr("id", "upload-content-area")
    .style("flex-grow", "1")
    .style("display", "flex")
    .style("justify-content", "center")
    .style("align-items", "center")
    .style("min-height", "0");

  return contentArea;
}

// ===================================================================
// ===                PAGE 1: UPLOAD PROJECT FILES                 ===
// ===================================================================
export function renderUploadProjectFilesUI() {
  const mainEditWindow = d3.select("#main-edit-window");
  const contentArea = renderMainFrame();
  if (!allProjectFiles.length) {
    loadProjectFilesFromStorage();
  }
  loadManualQuestionsFromStorage();

  const uploadContainer = contentArea.append("div")
    .attr("id", "uploadDivs")
    .style("display", "flex")
    .style("flex-direction", "row")
    .style("justify-content", "space-around")
    .style("width", "90%")
    .style("max-width", "1200px")
    .style("margin", "30px auto 0 auto")
    .style("gap", "30px")
    .style("padding-bottom", "120px");

  const audioTranscriptSection = uploadContainer.append("div")
    .attr("id", "audioTranscriptUploadArea")
    .style("flex-basis", "48%")
    .style("min-width", "350px")
    .style("padding", "20px")
    .style("border", "2px dashed #3A61DD")
    .style("border-radius", "10px")
    .style("background-color", "rgba(58, 97, 221, 0.03)")
    .style("display", "flex")
    .style("flex-direction", "column")
    .style("align-items", "center");

  audioTranscriptSection.append("h2")
    .style("color", "#3A61DD").style("font-family", "Inter, sans-serif").style("font-size", "22px")
    .style("font-weight", 700).style("text-align", "center")
    .style("margin-top", "0").style("margin-bottom", "8px")
    .text("Upload Transcript Files");

  // ✅ Updated helper text per your request
  audioTranscriptSection.append("p")
    .style("text-align", "center").style("font-family", "Inter, sans-serif")
    .style("font-size", "13px").style("color", "#555").style("margin-bottom", "15px")
    .text("Transcripts: DOCX, TXT, VTT or SRT, with or without timestamps. Recordings are optional: MP3, WAV, M4A, OGG or FLAC. Add your interview question guide in the next step.");

  // --- Buttons (folder OR files) ---
  const controls = audioTranscriptSection.append("div")
    .style("display", "flex")
    .style("gap", "10px")
    .style("flex-wrap", "wrap")
    .style("justify-content", "center")
    .style("margin-bottom", "15px");

  // Folder Selection Button (unchanged look)
  controls.append("button")
    .attr("id", "selectProjectFolderBtn_ufs")
    .style("padding", "10px 20px").style("font-size", "15px")
    .style("background-color", "#3A61DD").style("color", "white")
    .style("border", "none").style("border-radius", "6px").style("cursor", "pointer")
    .html("📂 Select Project Folder")
    .on("click", () => d3.select("#projectFolderInput_ufs").node().click());

  // NEW: Individual Files button (keeps layout; small addition)
  controls.append("button")
    .attr("id", "selectProjectFilesBtn_ufs")
    .style("padding", "10px 20px").style("font-size", "15px")
    .style("background-color", "#ffffff").style("color", "#3A61DD")
    .style("border", "2px solid #3A61DD").style("border-radius", "6px").style("cursor", "pointer")
    .html("🗂️ Select Files")
    .on("click", () => d3.select("#projectFilesInput_ufs").node().click());

  // Hidden inputs
  audioTranscriptSection.append("input")
    .attr("type", "file")
    .attr("id", "projectFolderInput_ufs")
    .attr("webkitdirectory", true)
    .attr("directory", true)
    .style("display", "none")
    .on("change", handleProjectFolderSelection);  // existing folder flow

  audioTranscriptSection.append("input")
    .attr("type", "file")
    .attr("id", "projectFilesInput_ufs")
    .attr("multiple", true)
    .attr("accept", ".docx,.txt,.vtt,.srt,.mp3,.wav,.m4a,.ogg,.flac")
    .style("display", "none")
    .on("change", handleIndividualFilesSelection); // new files flow

  // Display area (now also supports drag & drop files)
  const displayArea = audioTranscriptSection.append("div")
    .attr("id", "folderFileDisplay_ufs")
    .style("width", "100%")
    .style("min-height", "150px")
    .style("max-height", "350px")
    .style("overflow-y", "auto")
    .style("background-color", "#fff")
    .style("border", "1px solid #ddd")
    .style("border-radius", "8px")
    .style("padding", "10px")
    .html("<p style='text-align:center; color:#777; padding-top: 20%;'><i>Drop transcript files here.</i><br>Audio files are optional.</p>");

  // Drag & drop support for individual files (no UI layout change)
  const dropNode = displayArea.node();
  dropNode.ondragover = (e) => { e.preventDefault(); displayArea.style("background-color", "#fafcff"); };
  dropNode.ondragleave = () => displayArea.style("background-color", "#fff");
  dropNode.ondrop = (e) => {
    e.preventDefault();
    displayArea.style("background-color", "#fff");
    const files = e.dataTransfer?.files ? Array.from(e.dataTransfer.files) : [];
    if (files.length) ingestSelectedFiles(files); // same ingestion as the buttons
  };

  // Bottom bar (active step = 1)
  // renderBottomButtons(
  //   mainEditWindow,
  //   () => d3.select("#circle_0").dispatch("click"),
  //   renderUploadQuestionSetUI,
  //   1
  // );
    renderBottomButtons(
      mainEditWindow,
      nameProject,
      async () => {
      const nextButton = d3.select("#nextBtn");
       nextButton.text("Validating...").property("disabled", true);
        // block if uploads still running
        const anyProcessing = Object.values(fileProcessingStatus).some(s => s && s.status === 'uploading');
        if (anyProcessing) {
            alert("Some files are still uploading/processing. Please wait.");
            nextButton.text("Next").property("disabled", false);
            return;
        }

        const failedUploads = allProjectFiles.some(entry => fileProcessingStatus[entry.id]?.status === 'error');
        if (failedUploads) {
          alert("Some files could not be imported. Replace or remove those files before continuing.");
          nextButton.text("Next").property("disabled", false);
          return;
        }

        // Build downstream list
        fileLists.filesList1 = allProjectFiles
        .filter(entry => entry.type === 'audio' || (entry.type === 'transcript' && entry.serverTranscriptUrl))
        .map(entry => entry.type === 'audio'
              ? { name: entry.originalFilename, type: 'audio', fileObject: entry.file, relativePath: entry.relativePath, id: entry.id }
              : { name: entry.originalFilename, type: 'transcript', serverTranscriptUrl: entry.serverTranscriptUrl, relativePath: entry.relativePath, id: entry.id, speakerRoles: entry.speakerRoles || {} }
            );

        const usableTranscripts = allProjectFiles.some(f => f.type === 'transcript' && f.serverTranscriptUrl);
        if (!usableTranscripts) {
          alert("At least one successfully processed transcript is required to continue. Audio is optional.");
          nextButton.text("Next").property("disabled", false);
          return;
        }
        renderUploadQuestionSetUI();
      },
      1
    ); 

  if (allProjectFiles.length > 0) renderProjectFileDisplay();
}

// ===================================================================
// ===               PAGE 2: UPLOAD QUESTION SET                   ===
// ===================================================================
async function renderUploadQuestionSetUI() {
  markUsageStep("Upload or enter interview questions", {
    stepKey: "file_manager_question_set",
    workflow: "file_manager_import",
  });
  const mainEditWindow = d3.select("#main-edit-window");
  const contentArea = renderMainFrame();
  await resolveProjectId();
  const isDemoMode = String(window.APP_MODE || "").toLowerCase() === "demo";
  if (isDemoMode) {
    loadManualQuestionsFromStorage();
  } else {
    manualQuestions = ["", ""];
    saveManualQuestionsToStorage();
  }

  const uploadContainer = contentArea.append("div")
    .attr("id", "uploadDivs")
    .style("display", "flex")
    .style("flex-direction", "row")
    .style("justify-content", "space-around")
    .style("width", "90%")
    .style("max-width", "1200px")
    .style("margin", "30px auto 0 auto")
    .style("gap", "30px")
    .style("padding-bottom", "120px");

  const questionSection = uploadContainer.append("div")
    .style("flex-basis", "48%")
    .style("min-width", "350px")
    .style("padding", "20px")
    .style("border", "2px dashed #3A61DD")
    .style("border-radius", "10px")
    .style("background-color", "rgba(58, 97, 221, 0.03)")
    .style("display", "flex").style("flex-direction", "column").style("align-items", "center");

  questionSection.append("h2")
    .style("color", "#3A61DD").style("font-family", "Inter, sans-serif").style("font-size", "22px")
    .style("font-weight", 700).style("text-align", "center")
    .style("margin-top", "0").style("margin-bottom", "8px")
    .text("Upload Questions set");

  questionSection.append("p")
    .style("text-align", "center").style("font-family", "Inter, sans-serif")
    .style("font-size", "13px").style("color", "#555").style("margin-bottom", "15px")
    .text("ChromaScribe can identify and present data answered to specific questions");

  const dropFiles2_questions_area = questionSection.append("div")
    .attr("id", "dropFiles2_questions_area")
    .style("text-align", "center").style("display", "flex").style("flex-direction", "column")
    .style("align-items", "center").style("justify-content", "center")
    .style("color", "#3A61DD").style("font-size", "16px")
    .style("border-radius", "8px")
    .style("border", "2px dashed #3A61DD")
    .style("padding", "20px")
    .style("background", "rgba(58, 97, 221, 0.03)")
    .style("flex-grow", "1")
    .style("width", "100%")
    .style("cursor", "pointer")
    .on("click", () => d3.select("#fileInput2_questions_ufs").node().click());

  dropFiles2_questions_area.append("div")
    .attr("id", "question_file_display_status")
    .text("Drop your question file here (or click)");

  const fileInput2_questions = questionSection.append("input")
    .attr("type", "file")
    .attr("id", "fileInput2_questions_ufs")
    .attr("accept", ".pdf,.docx,.txt")
    .style("display", "none")
    .on("change", handleQuestionFileSelection);

  dropFiles2_questions_area.node().ondrop = function (event) {
    event.preventDefault();
    dropFiles2_questions_area.style("background-color", "rgba(58, 97, 221, 0.03)");
    if (event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files.length > 0) {
      const file = event.dataTransfer.files[0];
      processAndUploadQuestionFile(file);
    }
  };
  dropFiles2_questions_area.node().ondragover = function (event) {
    event.preventDefault();
    dropFiles2_questions_area.style("background-color", "rgba(58, 97, 221, 0.1)");
  };
  dropFiles2_questions_area.node().ondragleave = function () {
    dropFiles2_questions_area.style("background-color", "rgba(58, 97, 221, 0.03)");
  };

  const manualQuestionSection = uploadContainer.append("div")
    .style("flex-basis", "48%")
    .style("min-width", "350px")
    .style("padding", "20px")
    .style("border", "2px dashed #3A61DD")
    .style("border-radius", "10px")
    .style("background-color", "rgba(58, 97, 221, 0.03)")
    .style("display", "flex").style("flex-direction", "column").style("align-items", "center")
    .style("justify-content", "center");

  manualQuestionSection.append("h2")
    .style("color", "#3A61DD").style("font-family", "Inter, sans-serif").style("font-size", "22px")
    .style("font-weight", 700).style("text-align", "center")
    .text("You should enter at least 2 Questions...");

  const questionListContainer = manualQuestionSection.append("div")
    .attr("id", "question-list-container")
    .style("flex-grow", "1").style("overflow-y", "auto").style("width", "100%");

  const manualInputControls = manualQuestionSection.append("div")
    .style("display", "flex")
    .style("justify-content", "space-between")
    .style("width", "100%")
    .style("gap", "10px")
    .style("margin-top", "10px");

  manualInputControls.append("button")
    .attr("class", "add-question-button")
    .text("+ Add Question")
    .on("click", addQuestionInput);

  manualInputControls.append("button")
    .attr("class", "delete-question-set-button")
    .attr("title", "Delete the saved question set for this project")
    .style("cursor", "pointer")
    .text("Delete Question Set")
    .on("click", function () {
      deleteQuestionSet(this);
    });

  // manualInputControls.append("button")
  //   .attr("class", "save-questions-button")
  //   .text("Save Manual Questions")
  //   .on("click", saveManualQuestions);

  renderQuestionInputs();
  void hydrateQuestionsFromServer();

  renderBottomButtons(
    mainEditWindow,
    renderUploadProjectFilesUI,
    async () => {
      const nextButton = d3.select("#nextBtn");
      nextButton.text("Validating...").property("disabled", true);
      try {
        const response = await fetch('/api/check_questions_exist');
        const result = await response.json();
        if (!result.exists) {
          alert("Please upload a question file or enter and save at least two questions manually.");
          nextButton.text("Next").property("disabled", false);
          return;
        }
        syncAudiosToTranscripts();
      } catch (e) {
        alert("Error validating questions. Please try again.");
        nextButton.text("Next").property("disabled", false);
      }
    },
    2
  );
}

// --- Manual Questions Helpers ---
function questionDisplayTag(questionText, index) {
  const numberedQuestion = String(questionText || "").match(/^\s*(?:q\s*)?0*(\d+)([a-z]?)\s*[.):\-]\s*\S/i);
  if (!numberedQuestion) return `Q${index + 1}`;
  return `Q${Number(numberedQuestion[1])}${numberedQuestion[2].toLowerCase()}`;
}

function renderQuestionInputs() {
  const container = d3.select("#question-list-container");
  container.html("");
  manualQuestions.forEach((questionText, i) => {
    const inputGroup = container.append("div")
      .attr("title", questionText || `Question ${i + 1}`)
      .style("display", "flex").style("align-items", "center").style("margin-bottom", "10px")
      .style("gap", "10px").style("width", "100%");
    const questionLabel = inputGroup.append("span")
      .style("font-weight", "bold")
      .style("min-width", "34px")
      .text(questionDisplayTag(questionText, i));
    inputGroup.append("input")
      .attr("type", "text").attr("class", "question-input")
      .attr("title", questionText || `Question ${i + 1}`)
      .style("flex", "1").style("min-width", "0").style("padding", "8px")
      .style("border", "1px solid #ccc").style("border-radius", "5px")
      .property("value", questionText)
      .on("input", function () { manualQuestions[i] = this.value;
        questionLabel.text(questionDisplayTag(this.value, i));
        inputGroup.attr("title", this.value || `Question ${i + 1}`);
        d3.select(this).attr("title", this.value || `Question ${i + 1}`);
        saveManualQuestionsToStorage();
        // --- 2. THIS IS THE KEY AUTO-SAVE LOGIC ---
        // Clear the previous timer
        clearTimeout(debounceTimer);
        // Set a new timer. The save function will only run
        // after the user has stopped typing for 1 second (1000ms).
        debounceTimer = setTimeout(() => {
        saveManualQuestions({ notify: false });
        }, 1000);
        // --- END OF AUTO-SAVE LOGIC ---
      });
    inputGroup.append("button")
      .attr("type", "button")
      .attr("title", `Delete question ${i + 1}`)
      .style("background-color", "#dc3545")
      .style("color", "#ffffff")
      .style("border", "none")
      .style("border-radius", "50%")
      .style("width", "26px")
      .style("height", "26px")
      .style("display", "inline-flex")
      .style("align-items", "center")
      .style("justify-content", "center")
      .style("flex-shrink", "0")
      .style("cursor", "pointer")
      .style("font-size", "16px")
      .style("font-weight", "bold")
      .style("line-height", "1")
      .style("padding", "0")
      .html("×")
      .on("click", function () {
        d3.event.stopPropagation();
        deleteQuestionAtIndex(i);
      });
  });
}

function addQuestionInput() { manualQuestions.push(""); saveManualQuestionsToStorage(); renderQuestionInputs(); }

async function saveManualQuestions({ notify = true } = {}) {
  const questionsToSave = manualQuestions.filter(q => q.trim() !== "");
  if (questionsToSave.length < 2) {
    if (notify) alert("Please enter at least 2 questions to save.");
    return;
  }
  
  console.log("Auto-saving manual questions...");
  // const saveButton = d3.select(".save-questions-button");
  // saveButton.text("Saving...").property("disabled", true);
  try {
    const resp = await fetch('/api/save_manual_questions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(questionsToSave)
    });
    const result = await resp.json();
    if (!resp.ok) throw new Error(result.error);
    if (notify) alert("Manual questions saved successfully!");
  } catch (err) {
    if (notify) alert("Error saving questions: " + err.message);
    else console.warn("Error saving questions:", err);
  } 
  //finally {
  //   saveButton.text("Save Manual Questions").property("disabled", false);
  // }
}

async function deleteQuestionAtIndex(questionIndex) {
  if (questionIndex < 0 || questionIndex >= manualQuestions.length) return;

  const removedQuestion = manualQuestions[questionIndex] || "";
  manualQuestions.splice(questionIndex, 1);
  saveManualQuestionsToStorage();
  renderQuestionInputs();

  if (!removedQuestion.trim()) return;

  try {
    const response = await fetch('/api/delete_question', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        index: questionIndex,
        questions: manualQuestions.filter(q => q.trim() !== "")
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not delete question.");
    if (Array.isArray(result.questions)) {
      manualQuestions = result.questions;
      saveManualQuestionsToStorage();
      renderQuestionInputs();
    }
    const statusDiv = d3.select("#question_file_display_status");
    if (!statusDiv.empty()) {
      statusDiv.html(`<span style="color:green;">Question deleted</span><br><small>(${manualQuestions.filter(q => q.trim() !== "").length} questions saved)</small>`);
    }
  } catch (err) {
    alert("Error deleting question: " + err.message);
    void hydrateQuestionsFromServer();
  }
}

async function deleteQuestionSet(buttonNode) {
  if (!confirm("Delete the entire saved question set for this project?")) return;

  const button = d3.select(buttonNode);
  button.text("Deleting...").property("disabled", true).style("opacity", 0.65);
  try {
    const response = await fetch('/api/delete_question_set', { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not delete question set.");

    manualQuestions = ["", ""];
    fileLists.filesList2 = [];
    saveManualQuestionsToStorage();
    renderQuestionInputs();

    const statusDiv = d3.select("#question_file_display_status");
    if (!statusDiv.empty()) {
      statusDiv.attr("title", null).html(`<span style="color:#555;">No saved question set</span>`);
    }
  } catch (err) {
    alert("Error deleting question set: " + err.message);
  } finally {
    button.text("Delete Question Set").property("disabled", false).style("opacity", 1);
  }
}

async function hydrateQuestionsFromServer() {
  try {
    const response = await fetch('/api/get_question_list', { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json();
    const serverQuestions = Array.isArray(data.questions) ? data.questions : [];
    const isDemoMode = String(window.APP_MODE || "").toLowerCase() === "demo";
    if (serverQuestions.length === 0) {
      const statusDiv = d3.select("#question_file_display_status");
      if (!statusDiv.empty()) {
        statusDiv.attr("title", null).html(`<span style="color:#555;">No saved question set</span>`);
      }
      if (!isDemoMode) {
        manualQuestions = ["", ""];
        saveManualQuestionsToStorage();
        renderQuestionInputs();
      }
      return;
    }

    const statusDiv = d3.select("#question_file_display_status");
    if (!statusDiv.empty()) {
      statusDiv.html(`<span style="color:green;">Saved question set found</span><br><small>(${serverQuestions.length} questions)</small>`);
    }

    manualQuestions = serverQuestions;
    saveManualQuestionsToStorage();
    renderQuestionInputs();
  } catch (err) {
    console.warn("Failed to hydrate questions from server:", err);
  }
}

// ------------------------
// Folder / Files handlers
// ------------------------
async function handleProjectFolderSelection() {
  const files = Array.from(this.files || []);
  ingestSelectedFiles(files, /*mode*/"folder");
  this.value = null;
}

async function handleIndividualFilesSelection() {
  const files = Array.from(this.files || []);
  ingestSelectedFiles(files, /*mode*/"files");
  this.value = null;
}

function ingestSelectedFiles(files, mode = "files") {
  if (!files || files.length === 0) return;

  // Reset status map for fresh uploads
  fileProcessingStatus = fileProcessingStatus || {};

  let transcriptEntriesToUpload = [];
  let audioEntriesToUpload = [];

  // Deduplicate by (name + size) to avoid repeats across picks
  const existingKey = new Set(allProjectFiles.map(f => `${f.relativePath || f.originalFilename}::${f.file?.size || f.size || 0}`));

  files.forEach((file, index) => {
    const type = getProjectFileType(file.name);
    if (type === 'other') return;

    const relativePath = mode === "folder" ? (file.webkitRelativePath || file.name) : file.name;
    const key = `${relativePath}::${file.size || 0}`;
    if (existingKey.has(key)) return; // skip duplicates
    existingKey.add(key);

    const fileEntry = {
      file,
      id: `projfile-${Date.now()}-${mode}-${index}`,
      type,
      serverTranscriptUrl: null,
      originalFilename: file.name,
      relativePath: (mode === "folder" ? (file.webkitRelativePath || file.name) : file.name),
      size: file.size
    };

    allProjectFiles.push(fileEntry);
    if (type === 'transcript') transcriptEntriesToUpload.push(fileEntry);
    if (type === 'audio')      audioEntriesToUpload.push(fileEntry);
  });

  renderProjectFileDisplay();
  saveProjectFilesToStorage();

  // Upload in parallel
  const jobs = [
    ...transcriptEntriesToUpload.map(uploadAndProcessProjectTranscript),
    ...audioEntriesToUpload.map(uploadProjectAudio),
  ];

  if (jobs.length > 0) {
    const displayArea = d3.select("#folderFileDisplay_ufs");
    const placeholder = displayArea.select("p");
    if (!placeholder.empty()) {
      placeholder.html("<i>Uploading & Processing Files... This may take a moment.</i>").style("color", "orange");
    }
    d3.select("#nextBtn").property("disabled", true).style("opacity", 0.5).style("cursor", "not-allowed");
    Promise.allSettled(jobs).finally(() => {
      d3.select("#nextBtn").property("disabled", false).style("opacity", 1).style("cursor", "pointer");
    });
  }
}

async function uploadAndProcessProjectTranscript(transcriptFileEntry) {
  const formData = new FormData();
  formData.append('transcript_file', transcriptFileEntry.file, transcriptFileEntry.file.name);
  formData.append('relativePath', transcriptFileEntry.relativePath);

  fileProcessingStatus[transcriptFileEntry.id] = { status: 'uploading', message: 'Sending to server...' };
  renderProjectFileDisplay();

  try {
    const response = await fetch('/upload_transcript_file', { method: 'POST', body: formData });
    const result = await response.json();
    if (response.ok) {
      transcriptFileEntry.serverTranscriptUrl = result.serverTranscriptUrl;
      transcriptFileEntry.importSummary = result.importSummary;
      transcriptFileEntry.preview = result.preview || [];
      fileProcessingStatus[transcriptFileEntry.id] = { status: 'success', message: 'Ready!' };
      saveProjectFilesToStorage();
    } else {
      fileProcessingStatus[transcriptFileEntry.id] = { status: 'error', message: result.error || 'Server error' };
    }
  } catch {
    fileProcessingStatus[transcriptFileEntry.id] = { status: 'error', message: 'Network error' };
  }
  renderProjectFileDisplay();
  saveProjectFilesToStorage();
}

async function uploadProjectAudio(audioFileEntry) {
  const formData = new FormData();
  formData.append('audio_file', audioFileEntry.file, audioFileEntry.file.name);
  formData.append('relativePath', audioFileEntry.relativePath);

  fileProcessingStatus[audioFileEntry.id] = { status: 'uploading', message: 'Uploading...' };
  renderProjectFileDisplay();

  try {
    const response = await fetch('/upload_audio_file', { method: 'POST', body: formData });
    const result = await response.json();
    if (response.ok) {
      fileProcessingStatus[audioFileEntry.id] = { status: 'success', message: 'Ready!' };
      saveProjectFilesToStorage();
    } else {
      fileProcessingStatus[audioFileEntry.id] = { status: 'error', message: result.error || 'Server error' };
    }
  } catch {
    fileProcessingStatus[audioFileEntry.id] = { status: 'error', message: 'Network error' };
  }
  renderProjectFileDisplay();
  saveProjectFilesToStorage();
}

function getProjectFileType(filename) {
  if (!filename) return 'other';
  const ext = filename.split('.').pop().toLowerCase();
  if (['mp3', 'wav', 'm4a', 'ogg', 'flac'].includes(ext)) return 'audio';
  if (['txt', 'vtt', 'srt', 'docx'].includes(ext)) return 'transcript';
  return 'other';
}

function renderProjectFileDisplay() {
  const displayArea = d3.select("#folderFileDisplay_ufs");
  displayArea.html("");

  if (allProjectFiles.length === 0) {
    displayArea.html("<p style='text-align:center; color:#777; padding-top: 20%;'><i>Drop transcripts and audio files here.</i><br>(by selecting a folder or files above)</p>");
    return;
  }

  const list = displayArea.append("ul").style("list-style-type", "none").style("padding", "0");

  allProjectFiles.forEach(entry => {
    if (entry.type !== 'audio' && entry.type !== 'transcript') return;

    const statusInfo = fileProcessingStatus[entry.id] || {};
    let statusText = "";
    const icon = entry.type === 'audio' ? '🎵' : '📝';

    if (entry.type === 'transcript') {
      if (statusInfo.status === 'success') { statusText = `<span style="color:green; font-weight:bold;">(Ready)</span>`; }
      else if (statusInfo.status === 'error') { statusText = `<span style="color:red;">(Error: ${escapeHtml(statusInfo.message || 'Failed')})</span>`; }
      else if (statusInfo.status === 'uploading') { statusText = `<span style="color:orange;">(Processing...)</span>`; }
      else if (entry.serverTranscriptUrl) { statusText = `<span style="color:green; font-weight:bold;">(Ready)</span>`; }
      else { statusText = " (Pending)"; }
    } else {
      if (statusInfo.status === 'success') { statusText = `<span style="color:green; font-weight:bold;">(Ready)</span>`; }
      else if (statusInfo.status === 'error') { statusText = `<span style="color:red;">(Error: ${escapeHtml(statusInfo.message || 'Failed')})</span>`; }
      else if (statusInfo.status === 'uploading') { statusText = `<span style="color:orange;">(Uploading...)</span>`; }
    }

    const sizeBytes = entry.file && entry.file.size ? entry.file.size : entry.size;
    const sizeLabel = sizeBytes ? formatBytes(sizeBytes) : "Unknown size";
    const fullFileLabel = entry.relativePath || entry.originalFilename || "";

    const listItem = list.append("li")
      .attr("title", fullFileLabel)
      .style("display", "flex")
      .style("flex-wrap", "wrap")
      .style("justify-content", "space-between")
      .style("align-items", "center")
      .style("padding", "8px 5px")
      .style("border", "1px solid #e0e0e0")
      .style("background-color", "#f9f9f9")
      .style("border-radius", "4px")
      .style("margin-bottom", "5px")
      .style("font-size", "0.9em")
      .style("color", "#333");

    listItem.append("span")
      .attr("title", fullFileLabel)
      .style("flex-grow", "1")
      .style("min-width", "0")
      .style("overflow", "hidden")
      .style("text-overflow", "ellipsis")
      .style("white-space", "nowrap")
      .html(`${icon} ${escapeHtml(formatProjectFileName(fullFileLabel, 35))} <span style="font-size:0.8em; color:#555;">
        (${escapeHtml(sizeLabel)})</span> ${statusText}`);

    listItem.append("button")
      .html("×")
      .attr("title", "Remove this file from the list")
      .style("background-color", "#dc3545")
      .style("color", "white")
      .style("border", "none")
      .style("border-radius", "50%")
      .style("width", "22px")
      .style("height", "22px")
      .style("display", "inline-flex")
      .style("align-items", "center")
      .style("justify-content", "center")
      .style("line-height", "1")
      .style("flex-shrink", "0")
      .style("padding", "0")
      .style("font-size", "14px")
      .style("font-weight", "bold")
      .style("margin-left", "10px")
      .style("cursor", "pointer")
      .on("click", function () {
        d3.event.stopPropagation();
        removeFileFromProjectList(entry.id);
      });

    if (entry.type === "transcript") {
      appendTranscriptImportPreview(listItem, entry, saveProjectFilesToStorage);
    }
  });

  if (list.selectAll("li").empty()) {
    displayArea.html("<p style='text-align:center; color:#777; padding-top: 20%;'><i>No audio or transcript files found in the selected folder/files.</i></p>");
  }
}

async function removeFileFromProjectList(fileIdToRemove) {
  const fileToRemove = allProjectFiles.find(entry => entry.id === fileIdToRemove);
  if (!fileToRemove) { console.warn(`Could not find file with ID ${fileIdToRemove} to remove.`); return; }

  try {
    const response = await fetch('/delete_file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileType: fileToRemove.type, relativePath: fileToRemove.relativePath }),
    });
    const result = await response.json();
    if (!response.ok) {
      console.error(`Server error deleting ${fileToRemove.originalFilename}:`, result.error);
      alert(`Could not delete file from server: ${result.error || 'Unknown error'}`);
    }
  } catch (error) {
    console.error('Network error while trying to delete file:', error);
    alert('Network error. Could not contact server to delete file.');
  }

  allProjectFiles = allProjectFiles.filter(entry => entry.id !== fileIdToRemove);
  if (fileProcessingStatus[fileIdToRemove]) delete fileProcessingStatus[fileIdToRemove];
  renderProjectFileDisplay();
  saveProjectFilesToStorage();
  console.log(`File with ID ${fileIdToRemove} removed from client list.`);
}

export function formatProjectFileName(fullPath, maxLength = 30) {
  if (!fullPath) return "";
  const fileName = fullPath.split(/[\\/]/).pop();
  if (fileName.length <= maxLength) return fileName;
  const charsToShow = Math.max(1, Math.floor(maxLength / 2) - 2);
  const start = fileName.substring(0, charsToShow);
  const end = fileName.substring(fileName.length - charsToShow);
  return `${start}...${end}`;
}

function formatBytes(bytes, dec = 2) {
  if (bytes === undefined || bytes === null || isNaN(bytes) || bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = dec < 0 ? 0 : dec;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.max(0, Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k))));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// ------------------------------
// Question File Upload Handlers
// ------------------------------
function handleQuestionFileSelection() {
  const inputElement = this;
  if (inputElement.files && inputElement.files.length > 0) {
    const file = inputElement.files[0];
    processAndUploadQuestionFile(file);
  }
  inputElement.value = null;
}

async function processAndUploadQuestionFile(fileObject) {
  const displayStatusDiv = d3.select("#question_file_display_status");
  if (!fileObject) { displayStatusDiv.text("No file selected for questions."); return; }

  const extension = fileObject.name.split('.').pop().toLowerCase();
  const validExtensions = ['pdf', 'docx', 'txt'];
  if (!validExtensions.includes(extension)) {
    alert(`Invalid file type for questions: ${fileObject.name}. Please upload a text-based PDF, DOCX, or TXT question guide.`);
    displayStatusDiv.text("Invalid file type. Click to select again.");
    return;
  }

  displayStatusDiv
    .attr("title", fileObject.name)
    .html(`📄 ${escapeHtml(formatProjectFileName(fileObject.name, 30))} (${escapeHtml(formatBytes(fileObject.size))}) - <i>Uploading...</i>`);
  const formData = new FormData();
  formData.append('question_file', fileObject, fileObject.name);

  try {
    const response = await fetch('/upload_question_set', { method: 'POST', body: formData });
    const result = await response.json();
    if (response.ok) {
      await hydrateQuestionsFromServer();
      displayStatusDiv.html(`📄 ${escapeHtml(formatProjectFileName(fileObject.name, 30))} - <span style="color:green;">${result.questions.length} questions imported</span>`);
      for (const warning of result.importSummary?.warnings || []) {
        displayStatusDiv.append("p").style("color", "#854d0e").text(warning);
      }
      displayStatusDiv.append("p").text("Review the question list below before continuing.");
      fileLists.filesList2 = [{ name: fileObject.name, processedName: result.processedFilenameOnServer }];
    } else {
      displayStatusDiv.html(`📄 ${escapeHtml(formatProjectFileName(fileObject.name, 30))} - <span style="color:red;">Error: ${escapeHtml(result.error || 'Upload failed')}</span>`);
    }
  } catch (error) {
    displayStatusDiv.html(`📄 ${escapeHtml(formatProjectFileName(fileObject.name, 30))} - <span style="color:red;">Network error during upload.</span>`);
  }
}
