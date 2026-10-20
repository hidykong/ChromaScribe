// --- START OF FILE generateVisualization.js (Complete and Corrected) ---
import {
    currentDisplayObject, 
    graphWidthObject, 
    themesObject, 
    transcriptsObject, 
    loadTranscripts,
    FileMap,
    svgObject, // Import svgObject to initialize it
    kObject,
    lastKObject
} from "../../../chromascribe-main.js";

import { drawVisualization } from "../../main-page/drawVisualization.js?v=20260901b";
import { drawVisualization2 } from "../../main-page/drawVisualization2.js?v=20260901b";
import { graphAxes } from "../../main-page/graphAxes.js";
import { searchSpeeches } from "../../main-page/searchTranscript.js?v=20260601b";
import { normalizeParticipantCode, projectHasUploadedAudio, findParticipantAudio, buildServeAudioUrl } from "../../main-page/audioMatching.js?v=20260601b";
import { appendThemeColorDot, initializeThemeSelectionForPayload, selectTheme, syncThemeSelectionStyles } from "../../main-page/selectTheme.js?v=20260929a";
import { semanticZoom } from "../../main-page/semanticZoom.js?v=20260601b";
import { seekAudioBy, hasAudioSource, clearPlaybarAudio, setPlaybarAudioSource } from "../../main-page/audioPlayBar.js";
import { showFilterSettings } from '../menupanel.js?v=20260901a';
import { buildDemoFileMap } from "../../demoFileMap.js";
import {
    clearStoredFileMap,
    getStoredFileMap,
    hydrateFileMapFromServer
} from "../../fileMapSync.js?v=20260601b";
import {
    initializeNonVerbalCueControls,
    setNonVerbalCueControlForView,
    ensureNonVerbalCueData,
    clearNonVerbalCueLayer,
    drawNonVerbalCueLayer,
} from "../../main-page/nonVerbalCues.js?v=20260601b";

const FALLBACK_THEME_COLORS = ["#E7A23B", "#E14947", "#8EC053", "#579AE2", "#8E41D1"];
function getCurrentProjectId() {
    const rawValue = localStorage.getItem("currentProjectId");
    return typeof rawValue === "string" ? rawValue.trim() : "";
}

function withProjectPayload(payload) {
    const projectId = getCurrentProjectId();
    return projectId && payload && typeof payload === "object"
        ? { ...payload, projectId }
        : payload;
}

function markUsageStep(stepName, details = {}) {
    const payload = { stepName, ...details };
    window.__pendingChromaUsageStep = payload;
    if (window.ChromaUsageLogger && typeof window.ChromaUsageLogger.setStep === "function") {
        window.ChromaUsageLogger.setStep(stepName, payload);
    }
}

async function loadCanonicalFileMap(projectId) {
    const fileMap = await hydrateFileMapFromServer(projectId);
    return fileMap || getStoredFileMap(projectId);
}

function resolveLoadedParticipantId(rawParticipant, transcriptMap = transcriptsObject.transcripts) {
    const direct = String(rawParticipant || "").trim();
    if (direct && Array.isArray(transcriptMap[direct])) return direct;

    const normalized = normalizeParticipantCode(direct);
    if (!normalized) return direct;

    const matchedKey = Object.keys(transcriptMap || {}).find(
        key => normalizeParticipantCode(key) === normalized
    );
    return matchedKey || normalized;
}

function getRenderableParticipantIds() {
    const transcriptMap = transcriptsObject.transcripts || {};
    const seen = new Set();
    const ids = [];

    const addParticipant = (rawParticipant) => {
        const participantId = resolveLoadedParticipantId(rawParticipant, transcriptMap);
        if (!participantId || seen.has(participantId)) return;
        const transcript = transcriptMap[participantId];
        if (!Array.isArray(transcript) || transcript.length === 0) return;
        seen.add(participantId);
        ids.push(participantId);
    };

    Object.keys(transcriptMap).forEach(addParticipant);
    currentDisplayObject.currentDisplay
        .map(entry => entry && entry.participant)
        .forEach(addParticipant);
    (FileMap.participants || [])
        .map(entry => entry && entry.participant)
        .forEach(addParticipant);

    return ids.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function getInitialAudioMatch(participantIds = []) {
    for (const participantId of participantIds) {
        const match = findParticipantAudio(participantId, { allowSingleFallback: false });
        if (match?.audio?.relativePath) return match;
    }
    return findParticipantAudio("", { allowSingleFallback: true });
}

function preloadInitialAudioSource(participantIds = []) {
    const match = getInitialAudioMatch(participantIds);
    const audioSrc = buildServeAudioUrl(match?.audio);
    if (!audioSrc) return false;
    return setPlaybarAudioSource(audioSrc);
}

function getLegendContainer() {
    let legend = d3.select("#theme-legend");
    if (legend.empty()) {
        legend = d3.select("#legend");
    }
    return legend;
}

function updateZoomSliderVisual(sliderNode, zoomLevel) {
    if (!sliderNode) return;
    const min = Number(sliderNode.min || 1);
    const max = Number(sliderNode.max || 10);
    const range = max - min;
    const percentage = range > 0 ? ((zoomLevel - min) / range) * 100 : 0;
    sliderNode.style.background = `linear-gradient(to right, #0915ff ${percentage}%, #d3d3d3 ${percentage}%)`;

    const zoomValueDisplay = document.getElementById("zoom-value");
    if (zoomValueDisplay) {
        zoomValueDisplay.textContent = `${Math.round(zoomLevel * 10)}%`;
    }
}

function getColorInputValue(rawColor, index) {
    const fallback = FALLBACK_THEME_COLORS[index % FALLBACK_THEME_COLORS.length];
    const color = String(rawColor || "").trim();
    if (/^#[0-9a-f]{6}$/i.test(color)) {
        return color;
    }
    if (/^#[0-9a-f]{3}$/i.test(color)) {
        const expanded = color.slice(1).split("").map((value) => value + value).join("");
        return `#${expanded}`;
    }
    return fallback;
}

function normalizeThemeList(rawThemes) {
    if (!Array.isArray(rawThemes)) return [];
    const normalized = [];
    const seen = new Set();

    rawThemes.forEach((entry, index) => {
        let themeName = "";
        let color = "";
        let words = [];
        let groups = [];

        if (typeof entry === "string") {
            themeName = entry.trim();
        } else if (entry && typeof entry === "object") {
            themeName = String(entry.themeName || entry.theme || entry.name || "").trim();
            color = String(entry.color || "").trim();
            words = Array.isArray(entry.words) ? entry.words : [];
            groups = Array.isArray(entry.groups) ? entry.groups : [];
        }

        if (!themeName) return;
        const dedupeKey = themeName.toLowerCase();
        if (seen.has(dedupeKey)) return;
        seen.add(dedupeKey);

        normalized.push({
            themeName,
            color: color || FALLBACK_THEME_COLORS[index % FALLBACK_THEME_COLORS.length],
            words,
            groups,
        });
    });

    return normalized;
}

function renderThemeLegend(view) {
    const legend = getLegendContainer();
    if (legend.empty()) {
        console.warn("Theme legend container not found.");
        return;
    }

    legend.html("");
    legend.append("button")
        .attr("id", "neutral")
        .attr("class", "theme-labels")
        .style("margin-left", "20px")
        .style("border", "2px solid #eeedef")
        .style("color", "#000000")
        .style("cursor", "pointer")
        .on("click", function() {
            selectTheme(this, view);
        })
        .text("Neutral");

    themesObject.themes.forEach((theme, index) => {
        const rawThemeName = String(theme.themeName || "").trim();
        if (!rawThemeName) return;
        const safeId = "theme-btn-" + rawThemeName.toLowerCase().replace(/[^a-z0-9_-]/g, "-") + "-" + index;
        const themeColor = getColorInputValue(theme.color, index);
        const themeDisplayName = rawThemeName.substring(0, 1).toUpperCase() + rawThemeName.substring(1);

        const button = legend.append("button")
            .attr("id", safeId)
            .attr("data-theme", rawThemeName)
            .attr("class", "theme-labels")
            .style("border", "2px solid " + themeColor)
            .style("color", themeColor)
            .style("cursor", "pointer")
            .on("click", function() {
                selectTheme(this, view);
            })
            .text(formatThemeButtonLabel(themeDisplayName, 32));
        appendThemeColorDot(button, theme, view);

        tippy('#' + safeId, {
            content: rawThemeName.charAt(0).toUpperCase() + rawThemeName.slice(1).replaceAll("_", " "),
            placement: 'bottom',
            theme: 'blue',
            trigger: 'mouseenter focus',
        });
    });

    syncThemeSelectionStyles();
}


function formatThemeButtonLabel(rawThemeName, maxChars = 32) {
    const normalized = (rawThemeName || "").replaceAll("_", " ").trim();
    if (normalized.length <= maxChars) return normalized;
    const words = normalized.split(/\s+/);
    const keptWords = [];
    let currentLength = 0;
    for (const word of words) {
        const nextLength = currentLength + (keptWords.length ? 1 : 0) + word.length;
        if (nextLength > maxChars) break;
        keptWords.push(word);
        currentLength = nextLength;
    }
    const visible = keptWords.length > 0
        ? keptWords.join(" ")
        : normalized.slice(0, Math.max(1, maxChars - 3)).trim();
    return `${visible}...`;
}

export async function displayViz(themeObject, view) {
    markUsageStep(view === "question" ? "Question-based visualization analysis" : "Timeline visualization analysis", {
        stepKey: view === "question" ? "visualization_question_view" : "visualization_timeline_view",
        workflow: "visual_qda_analysis",
    });
    // This is the main function that orchestrates the entire visualization page setup.
    // STEP 0: Check the server if this is a new project and clear old data if so.
    try {
        const response = await fetch('/api/check_project_state', { cache: 'no-store' });
        const projectState = await response.json();
        const resolvedProjectId = String(projectState?.projectContext?.currentProjectId || localStorage.getItem("currentProjectId") || "").trim();
        if (resolvedProjectId) {
            localStorage.setItem("currentProjectId", resolvedProjectId);
        }
        if (projectState.isNewProject) {
            console.log("New project detected. Clearing localStorage for FileMap.");
            clearStoredFileMap({ projectId: resolvedProjectId });
        }
    } catch (error) {
        console.error("Could not check project state:", error);
    }
    
    //STEP 1: Always load the FileMap first to check for a valid project.
    let fileMapIsEmpty = true;
    if (window.APP_MODE === 'demo') {
        console.log("Running in DEMO mode.");
        try {
            FileMap.participants = await buildDemoFileMap();
            console.log("Created Demo FileMap:", FileMap);
            fileMapIsEmpty = FileMap.participants.length === 0;
        } catch (error) {
            console.warn("Falling back to hardcoded demo FileMap due to error:", error);
            FileMap.participants = [
                { participant: 'P3', audio: { relativePath: 'P3_trimmed.m4a' }, transcript: { relativePath: 'P3_Clean_Transcripts_trimmed.txt' }},
                { participant: 'P6', audio: { relativePath: 'P6_trimmed.m4a' }, transcript: { relativePath: 'P6_Clean_Transcripts_trimmed.txt' }},
                { participant: 'P7', audio: { relativePath: 'P7_trimmed.m4a' }, transcript: { relativePath: 'P7_Clean_Transcripts_trimmed.txt' }}
            ];
            fileMapIsEmpty = FileMap.participants.length === 0;
        }
    } else {
        console.log("Running in USER mode.");
        const projectId = localStorage.getItem("currentProjectId");
        const savedFileMap = await loadCanonicalFileMap(projectId);
        if (savedFileMap) {
            // This populates the global FileMap object for this session
            FileMap.participants = savedFileMap.participants || [];
            console.log("Loaded FileMap for visualization:", FileMap);
            if (FileMap.participants.length > 0) {
                fileMapIsEmpty = false;
            }
        }
    }
    
    // STEP 2: Prerequisite check. In user mode, allow visualization to continue if a
    // processed transcript URL is available even when FileMap is missing from storage.
    const canRenderFromProcessedData =
        window.APP_MODE !== 'demo' &&
        typeof window.PROCESSED_TRANSCRIPTS_URL === "string" &&
        window.PROCESSED_TRANSCRIPTS_URL.trim() !== "";

    if (fileMapIsEmpty && !canRenderFromProcessedData) {
        console.log("No FileMap found. Showing prompt to upload files.");
        d3.select("#settings-page").style("display", "none");
        d3.select("#main-page").style("display", "flex");

        // 1. Create the gray overlay to disable the background
        var overlay = d3.select("#main-page").append("div")
            .attr("id", "popup-overlay")
            .style("position", "absolute")
            .style("top", 0)
            .style("left", 0)
            .style("width", "100%")
            .style("height", "100%")
            .style("background", "rgba(240, 240, 240, 0.85)") // Light gray, semi-transparent
            .style("z-index", 100) // Ensure it's on top of other content
            .style("display", "flex")
            .style("align-items", "center")
            .style("justify-content", "center");
        
        // 2. Append the pop-up holder to the new overlay
        var popUpHolder = overlay.append("div").attr("id", "popUpHolder")
            .style("position", "relative") // No longer needs to be absolute
            .style("background", "#ffffff")
            .style("z-index", 101)
            .style("height", "250px")
            .style("width", "600px")
            .style("display", "flex")
            .style("flex-direction", "column")
            .style("align-items", "center")
            .style("justify-content", "center") // Vertically center content
            .style("border-radius", "15px")
            .style("font-family", "Inter")
            .style("font-weight", 700)
            .style("font-size", "28px")
            .style("text-align", "center")
            .style("box-shadow", "0 4px 15px rgba(0, 0, 0, 0.2)");

        var directions = popUpHolder.append("div")
            .style("width", "500px")
            .text("Please upload at least one transcript to view the visualizations. Audio is optional.");

        // Create the "Upload Files" button, styled to match your image
        popUpHolder.append("button")
            .style("background", "#3A61DD")
            .style("color", "white")
            .style("border", "none")
            .style("padding", "12px 24px")
            .style("border-radius", "8px")
            .style("font-family", "Nunito")
            .style("font-size", "20px")
            .style("cursor", "pointer")
            .style("margin-top", "30px") // Add space between text and button
            .text("Upload Files")
            .on("click", () => { window.location.href = "/fileManager" });
      
        return; // Stop execution
    }
    if (fileMapIsEmpty && canRenderFromProcessedData) {
        console.warn("FileMap missing, but processed transcripts exist. Continuing visualization render.");
    }

    initializeNonVerbalCueControls(() => {
        const activeView = (window.view || view || "timeline");
        if (activeView === "timeline" || activeView === "question") {
            drawNonVerbalCueLayer();
        } else {
            clearNonVerbalCueLayer();
        }
    });
    setNonVerbalCueControlForView(view);
    
    
    console.log("displayViz called with themes from previous step:", themeObject);
    // Step 1: Set up the active themes for this session
    if (themeObject && themeObject.themes) {
        themesObject.themes = normalizeThemeList(themeObject.themes);
        console.log("displayViz called with themes from previous step:", themeObject, themesObject);
        // themesObject.themes = JSON.parse(JSON.stringify(themeObject.themes));
    }
    else {
        themesObject.themes = []; // Ensure it's an empty array if nothing is passed
    }
    initializeThemeSelectionForPayload(themeObject || { themes: [] });
    

    // If we have themes, proceed to load and render the visualization
    d3.select("#settings-page").style("display", "none");
    d3.select("#main-page").style("display", "flex");

    // Show a loading message
    const graphHolder = d3.select("#graph-holder");
    if (!graphHolder.node()) {
        console.error("#graph-holder element not found. Cannot render visualization.");
        return;
    }

    // Instead of clearing graphHolder, find or create the #graph SVG and clear it.
    let graphSvg = graphHolder.select("#graph");
    if (graphSvg.empty()) {
        graphSvg = graphHolder.append("svg").attr("id", "graph");
    }
    graphSvg.html("<text x='50%' y='50%' text-anchor='middle'>Loading and Processing Transcript Data...</text>");

    
    // Step 2: Load and process the master JSON file.
    // This async function populates global state objects: transcriptsObject and currentDisplayObject
    await loadTranscripts();

    // Step 3: Check if data loading was successful before proceeding
    if (!currentDisplayObject.currentDisplay || currentDisplayObject.currentDisplay.length === 0) {
        graphSvg.html("<text x='50%' y='50%' text-anchor='middle' fill='red'>Error: No data to display. Please ensure files were uploaded and processed correctly.</text>");
        return;
    }

    graphSvg.html(""); // Clear loading message from SVG

    //Step 4: Set up the graph dimensions and axes based on the loaded data
     if (graphHolder.node()) {
        graphWidthObject.graphWidth = graphHolder.node().offsetWidth - 99;
    }

    const participantIds = getRenderableParticipantIds();

    kObject.k = 1;
    lastKObject.lastK = 1;
    graphAxes(participantIds,'timeline');
    const projectHasAudio = projectHasUploadedAudio();
    const initialAudioReady = projectHasAudio && preloadInitialAudioSource(participantIds);
    if (!initialAudioReady) {
        clearPlaybarAudio({
            displaySeconds: 0,
            maxDisplaySeconds: 0,
            reason: projectHasAudio
                ? "Select a transcript segment with audio to enable playback."
                : "This project does not have an audio file."
        });
    }

    // Render theme legend before graph drawing, so a graph rendering error cannot hide selected themes.
    renderThemeLegend(view);

    //Step 5: Draw the main visualization using the processed data
    console.log("Drawing visualization with final processed data.");
    try {
        if (view === 'timeline') {
            void ensureNonVerbalCueData();
            drawVisualization(currentDisplayObject.currentDisplay);
        } else { // 'questions' view
            void ensureNonVerbalCueData();
            drawVisualization2(currentDisplayObject.currentDisplay);
        }
    } catch (error) {
        console.error("Failed to draw visualization graph:", error);
    }
    
    // Step 6: Set up the UI controls (search, zoom, player buttons)

    d3.select('#edit-themes-button').on('click', function() {
        // This fetch sends the current state of themes to the server before redirecting
        fetch('/themes/edit', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(withProjectPayload(themesObject)), // Send the global themesObject
        })
        .then(response => {
            if (response.ok) {
                window.location.href = '/themes/edit';
            } else {
                console.error('Failed to send theme data to server', response.statusText);
            }
        })
        .catch(error => console.error('Error in edit themes fetch:', error));
    });

    // Semantic Zoom
    const zoomSlider = d3.select("#zoom-slider");
    if (!zoomSlider.empty()) { 
        zoomSlider.on("input", function() { 
            semanticZoom(this.value, view); }); 
            const initialZoomLevel = 1;
            zoomSlider.property("value", initialZoomLevel);
            updateZoomSliderVisual(zoomSlider.node(), initialZoomLevel);
    } else { console.warn("#zoom-slider not found."); }
        
    // Search
    const searchBtn = document.getElementById('search-btn');
    if (searchBtn) {
        searchBtn.addEventListener('click', () => 
            searchSpeeches(transcriptsObject.transcripts, document.getElementById('searchInput').value, view)); 
    } else {
        console.warn("Element with ID 'search-btn' not found. Search functionality will not be available.");
    }
    
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                searchSpeeches(transcriptsObject.transcripts, searchInput.value, view);
            }
        });
    }


    // Player Controls
    var fullAudio = d3.select("#full-audiofile");
    
    d3.select("#forwardcontrol").on('click', function(event) {   
        if (!hasAudioSource(fullAudio.node())) return;
        seekAudioBy(10);
    });
    
    d3.select("#backwardcontrol").on('click', function(event) {   
        if (!hasAudioSource(fullAudio.node())) return;
        seekAudioBy(-10);
    });

    // View Toggles (Timeline vs. Questions)
    const timelineBtn = d3.select("#timeline-view-btn");
    if (!timelineBtn.empty()) {
        timelineBtn.on("click", function() {
            d3.selectAll(".view-toggle").classed("active", false);
            d3.select(this).classed("active", true);
            // Re-draw the visualization for the timeline view
            drawVisualization(currentDisplayObject.currentDisplay);
        });
    }

    const questionsBtn = d3.select("#questions-view-btn");
    if (!questionsBtn.empty()) {
        questionsBtn.on("click", function() {
            d3.selectAll(".view-toggle").classed("active", false);
            d3.select(this).classed("active", true);
            // Re-draw the visualization for the questions view
            drawVisualization2(currentDisplayObject.currentDisplay);
        });
    }

    // Demographic Filtering
    const filterBtn = d3.select("#menu-button"); // The filter icon in the tool ribbon
    if (!filterBtn.empty()) {
        // Remove any old click listeners and attach the new one that opens the filter panel.
        filterBtn.on("click", null).on("click", showFilterSettings);
    } else {
        console.warn("Could not find #menu-button to attach filter handler.");
    }
}
// --- END OF FILE generateVisualization.js ---
