import { addTail } from "../../../errorBoxTails.js";
import { getDemoPossibleThemes } from "../../demo-data/demoPossibleThemes.js?v=20260530c";
import { demoingObject, firstGenerateObject, possibleThemesObject, themesObject, 
	themeColors } from "../../../chromascribe-main.js";
import { createThemeGenerationEtaController } from "../themeGenerationEta.js";
import {
	getThemesStorageKey as getScopedThemesStorageKey,
	isManualCodeEffectivelySelected,
	isManualThemeEntry,
	normalizeManualSelectionOptOuts,
	setManualCodeSelection
} from "../../themePersistence.js?v=20260901b";
import { navigateWithWaitingScreen, scopeAppPath } from "../../pageTransitionOverlay.js?v=20260901a";

var creatingNewTheme = false;
let generationEtaController = null;
let lastRemoteThemeSelectionSignature = "";
let remoteThemeSelectionTimer = null;
let remoteThemeSelectionSave = Promise.resolve();
let pendingRemoteThemeSelection = null;
let activeRemoteThemeSelectionSignature = "";
const THEME_SELECTION_SAVE_TIMEOUT_MS = 15000;
let isThemeSelectionContinuing = false;
let hydratedThemeRecordsByKey = new Map();

function normalizedThemeRecordKey(themeName) {
	return String(themeName || "").trim().toLowerCase();
}

function rememberThemeRecords(themes) {
	hydratedThemeRecordsByKey = new Map((Array.isArray(themes) ? themes : [])
		.filter(theme => theme && typeof theme === "object" && theme.themeName)
		.map(theme => [normalizedThemeRecordKey(theme.themeName), structuredClone(theme)]));
}

function getHydratedThemeRecord(themeName) {
	return hydratedThemeRecordsByKey.get(normalizedThemeRecordKey(themeName)) || null;
}

function markUsageStep(stepName, details = {}) {
	const payload = { stepName, ...details };
	window.__pendingChromaUsageStep = payload;
	if (window.ChromaUsageLogger && typeof window.ChromaUsageLogger.setStep === "function") {
		window.ChromaUsageLogger.setStep(stepName, payload);
	}
}

function getSelectionCompleteKey() {
	const storageScope = getProjectStorageScope();
	return storageScope ? `themeSelectionComplete_${storageScope}` : "themeSelectionComplete";
}

function getSelectionPendingKey() {
	const storageScope = getProjectStorageScope();
	return storageScope ? `themeSelectionPending_${storageScope}` : "themeSelectionPending";
}

function markSelectionComplete() {
	if ((window.APP_MODE || "user") === "demo") return;
	try {
		localStorage.setItem(getSelectionCompleteKey(), "1");
		localStorage.removeItem(getSelectionPendingKey());
	} catch (error) {
		console.warn("Failed to persist theme-selection step:", error);
	}
}

function getThemesStorageKey() {
	return getScopedThemesStorageKey(getCurrentProjectId());
}

function getCurrentProjectId() {
	const rawValue = window.CURRENT_PROJECT_ID || localStorage.getItem("currentProjectId");
	return typeof rawValue === "string" ? rawValue.trim() : "";
}

function getProjectStorageScope(projectId = getCurrentProjectId()) {
	const resolvedProjectId = String(projectId || "").trim();
	if (!resolvedProjectId) return "";
	const workspaceKey = (window.USER_WORKSPACE_KEY || localStorage.getItem("currentWorkspaceKey") || "").trim();
	return workspaceKey ? `${workspaceKey}__${resolvedProjectId}` : resolvedProjectId;
}

function buildThemeSelectionPayload() {
	const projectId = getCurrentProjectId();
	const selectedThemes = Array.isArray(themesObject.themes) ? themesObject.themes : [];
	const themes = selectedThemes.map(theme => ({
		...theme,
		selectedByUser: true,
		selectionSource: "theme_selection",
	}));
	return {
		selectionSource: "theme_selection",
		selectionStage: "theme_selection",
		appliedToVisualization: false,
		themes,
		manualSelectionOptOuts: normalizeManualSelectionOptOuts(themesObject),
		...(projectId ? { projectId } : {}),
	};
}

async function saveThemeSelection(payload) {
	const response = await fetch("/api/save_selected_themes", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
		signal: AbortSignal.timeout(THEME_SELECTION_SAVE_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`Could not save code selection (HTTP ${response.status}).`);
	}
	return response.json();
}

function scheduleRemoteThemeSelectionSync(payload) {
	if (isThemeSelectionContinuing) return;
	if (!payload || !Array.isArray(payload.themes)) return;

	const signature = JSON.stringify(payload);
	if (signature === pendingRemoteThemeSelection?.signature) return;

	clearTimeout(remoteThemeSelectionTimer);
	remoteThemeSelectionTimer = null;
	pendingRemoteThemeSelection = null;
	if (signature === activeRemoteThemeSelectionSignature) return;
	if (!activeRemoteThemeSelectionSignature && signature === lastRemoteThemeSelectionSignature) return;

	// Keep the latest snapshot while one save is running, without queuing duplicates.
	pendingRemoteThemeSelection = { payload: JSON.parse(signature), signature };
	if (!activeRemoteThemeSelectionSignature) {
		remoteThemeSelectionTimer = setTimeout(savePendingThemeSelection, 500);
	}
}

async function savePendingThemeSelection() {
	remoteThemeSelectionTimer = null;
	if (isThemeSelectionContinuing || !pendingRemoteThemeSelection) return;

	const { payload, signature } = pendingRemoteThemeSelection;
	pendingRemoteThemeSelection = null;
	activeRemoteThemeSelectionSignature = signature;
	try {
		const progressSync = window.ChromaProjectProgress;
		remoteThemeSelectionSave = progressSync?.runProjectChange
			? progressSync.runProjectChange(payload.projectId, () => saveThemeSelection(payload))
			: saveThemeSelection(payload);
		await remoteThemeSelectionSave;
		lastRemoteThemeSelectionSignature = signature;
	} catch (error) {
		console.warn("Failed to sync theme selection:", error);
	} finally {
		activeRemoteThemeSelectionSignature = "";
		if (pendingRemoteThemeSelection && !isThemeSelectionContinuing) {
			remoteThemeSelectionTimer = setTimeout(savePendingThemeSelection, 500);
		}
	}
}

function persistThemeSelectionSnapshot({ syncRemote = true } = {}) {
	const payload = buildThemeSelectionPayload();
	try {
		localStorage.setItem(getThemesStorageKey(), JSON.stringify(payload));
	} catch (error) {
		console.warn("Failed to persist selected themes snapshot:", error);
	}
	if (syncRemote) {
		scheduleRemoteThemeSelectionSync(payload);
	}
}

function showThemeSelectionError(message) {
	d3.select("#min_theme_error_message").remove();
	d3.select("#main-edit-window").append("div")
		.attr("id", "min_theme_error_message")
		.attr("role", "alert")
		.style("position", "absolute")
		.style("right", "20px")
		.style("bottom", "76px")
		.style("max-width", "calc(100% - 40px)")
		.style("color", "#b42318")
		.text(message);
}

async function continueToCodeEditor(button) {
	if (isThemeSelectionContinuing) return;
	if (themesObject.themes.length < 1) {
		showThemeSelectionError("Select at least one code to continue.");
		return;
	}

	isThemeSelectionContinuing = true;
	button.disabled = true;
	button.textContent = "Saving...";
	d3.select("#min_theme_error_message").remove();
	clearInterval(window.__themeSelectionAutosaveInterval);
	clearTimeout(remoteThemeSelectionTimer);
	remoteThemeSelectionTimer = null;
	pendingRemoteThemeSelection = null;

	try {
		// Finish earlier saves before handing this selection to the matching page.
		await remoteThemeSelectionSave.catch(() => {});
		persistThemeSelectionSnapshot({ syncRemote: false });
		const response = await fetch(scopeAppPath("/themes/edit"), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(buildThemeSelectionPayload()),
			signal: AbortSignal.timeout(THEME_SELECTION_SAVE_TIMEOUT_MS),
		});
		if (!response.ok) {
			throw new Error(`Could not save selected codes (HTTP ${response.status}).`);
		}
		markSelectionComplete();
		// Save the completed step so page initialization cannot restore a pending selection.
		await window.ChromaProjectProgress?.save();
		await navigateWithWaitingScreen("/themes/edit", {
			title: "Loading Code Editor",
			message: "Preparing selected codes and quotations...",
		});
	} catch (error) {
		console.warn("Could not continue to excerpt matching:", error);
		showThemeSelectionError("Could not save your selection. Please try Next again.");
		isThemeSelectionContinuing = false;
		button.disabled = false;
		button.textContent = "Next";
		startThemeSelectionAutosave();
	}
}

function getNextThemeColor() {
	const selectedThemes = Array.isArray(themesObject.themes) ? themesObject.themes : [];
	const usedColors = new Set(selectedThemes.map(theme => theme && theme.color).filter(Boolean));
	for (var i = 0; i < themeColors.length; i++) {
		if (!usedColors.has(themeColors[i])) return themeColors[i];
	}
	return themeColors[selectedThemes.length % themeColors.length] || "#579AE2";
}

function addSelectedTheme(themeName, source = "theme_selection") {
	const hydratedTheme = getHydratedThemeRecord(themeName);
	if (hydratedTheme) {
		const restoredTheme = structuredClone(hydratedTheme);
		themesObject.themes.push(restoredTheme);
		if (isManualThemeEntry(restoredTheme)) {
			setManualCodeSelection(themesObject, restoredTheme.themeName, true);
		}
		return restoredTheme.color || getNextThemeColor();
	}
	const colorCode = getNextThemeColor();
	const manualCode = source === "manual_codes";
	themesObject.themes.push({
		themeName,
		color: colorCode,
		words: [],
		...(manualCode ? {
			codeSource: "manual",
			source: "manual",
			ai_generated: false,
			humanTagged: true,
			selectionSource: "manual_codes"
		} : {})
	});
	if (manualCode) setManualCodeSelection(themesObject, themeName, true);
	return colorCode;
}

function normalizeNewThemeNameInput(value) {
	return String(value || "").replace(/\s+/g, "_").trim();
}

function hasPossibleThemeName(possibleThemes, themeName) {
	const normalizedThemeName = String(themeName || "").trim().toLowerCase();
	return (Array.isArray(possibleThemes) ? possibleThemes : []).some(
		possibleTheme => String(possibleTheme || "").trim().toLowerCase() === normalizedThemeName
	);
}

function normalizeProgressMessage(message) {
	return String(message || "").trim().toLowerCase();
}

function isGenerationProgressRunning(progress) {
	const stage = Number(progress && progress.stage);
	const message = normalizeProgressMessage(progress && progress.message);
	return (
		[0, 1, 2, 3].includes(stage) &&
		!["idle", "not started", "complete", "demo data ready"].includes(message)
	);
}

async function fetchGenerationProgress() {
	const projectId = getCurrentProjectId();
	const projectParam = projectId ? `&projectId=${encodeURIComponent(projectId)}` : "";
	const response = await fetch(`/progress?t=${Date.now()}${projectParam}`, { cache: "no-store" });
	if (!response.ok) {
		throw new Error(`Progress request failed (${response.status})`);
	}
	return response.json();
}

function progressThemes(progress) {
	return Array.isArray(progress?.themes) ? progress.themes : [];
}

function startThemeSelectionAutosave() {
	if (window.__themeSelectionAutosaveInterval) {
		clearInterval(window.__themeSelectionAutosaveInterval);
	}
	window.__themeSelectionAutosaveInterval = setInterval(() => {
		persistThemeSelectionSnapshot();
	}, 1000);
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

export function updateProgress(stage) {
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




// Helper function to create and show the loading popup
function showLoadingPopup(useLegacyWindow = false) {
	ensureProgressAnimations();
	if (!generationEtaController) {
		generationEtaController = createThemeGenerationEtaController("generation-stage-eta");
	}
	generationEtaController.reset();
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
		.text("Estimated remaining time: calculating...");

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

	if (useLegacyWindow) {
		return overlay;
	}

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
	d3.select("#popUpHolder").remove();
}

export async function generateThemes(preGeneratedThemes = null, preSelectedThemes = null){
	markUsageStep("AI theme generation and selection", {
		stepKey: "ai_theme_generation_selection",
		workflow: "ai_assisted_qda",
	});
	console.log("firstGenerateObject.firstGenerate:", firstGenerateObject.firstGenerate);
	console.log("demoingObject.demoing:", demoingObject.demoing);	
	
	var mainEditWindow = d3.select("#main-edit-window");
    mainEditWindow.selectAll("*").remove();
	const appMode = window.APP_MODE || "user";
	const useLegacyLoadingWindow = !firstGenerateObject.firstGenerate;
	const hasPreGeneratedThemes = Array.isArray(preGeneratedThemes) && preGeneratedThemes.length > 0;
	const hasPreSelectedThemes = Array.isArray(preSelectedThemes) && preSelectedThemes.length > 0;

	async function resumeExistingGeneration(progress) {
		showLoadingPopup(false);
		if (Number(progress?.stage) >= 1) updateProgress(progress.stage);
		generationEtaController?.update(progress);
		const title = d3.select("#generation-stage-title");
		if (!title.empty() && progress?.message) title.text(progress.message);

		let poller = null;
		const pollProgress = async () => {
			const data = await fetchGenerationProgress();
			if (data.stage >= 1) updateProgress(data.stage);
			generationEtaController?.update(data);
			if (!title.empty() && data?.message) title.text(data.message);

			if (data.stage === 4) {
				clearInterval(poller);
				possibleThemesObject.possibleThemes = progressThemes(data);
				themesObject.themes = [];
				hideLoadingPopup();
				renderThemesUI();
			}

			if (data.stage === -1) {
				console.error("Backend error:", data.message);
				clearInterval(poller);
				hideLoadingPopup();
			}
		};

		poller = setInterval(() => {
			pollProgress().catch(error => {
				console.warn("Could not refresh running generation progress:", error);
			});
		}, 1500);
		await pollProgress();
	}

	if (hasPreGeneratedThemes) {
		possibleThemesObject.possibleThemes = [...new Set(preGeneratedThemes
			.map(theme => (theme || "").toString().trim())
			.filter(Boolean))];
		themesObject.themes = hasPreSelectedThemes ? structuredClone(preSelectedThemes) : [];
		firstGenerateObject.firstGenerate = false;
		hideLoadingPopup();
		renderThemesUI();
		return;
	}
	if (!firstGenerateObject.firstGenerate) {
    try {
        const projectId = getCurrentProjectId();
        const projectParam = projectId ? `&projectId=${encodeURIComponent(projectId)}` : "";
        const checkRes = await fetch(`/api/has_selected_themes?t=${Date.now()}${projectParam}`);
        const checkData = await checkRes.json();

        if (checkData.exists) {
            const selectedRes = await fetch(`/api/load_selected_themes?displayOnly=1&includeUnselectedManual=1&includeGeneratedQuotes=1&includeGeneratedThemes=1&t=${Date.now()}${projectParam}`, { cache: "no-store" });
            if (selectedRes.ok) {
                const selectedData = await selectedRes.json();
                if (selectedData && Array.isArray(selectedData.themes) && selectedData.themes.length > 0) {
					rememberThemeRecords(selectedData.themes);
					themesObject.manualSelectionOptOuts = normalizeManualSelectionOptOuts(selectedData);
					themesObject.themes = structuredClone(selectedData.themes).filter(theme => (
						!isManualThemeEntry(theme) || isManualCodeEffectivelySelected(selectedData, theme)
					));
                    possibleThemesObject.possibleThemes = selectedData.themes.map(t => t.themeName);
                    firstGenerateObject.firstGenerate = false;
                    renderThemesUI({ existingProject: true });
                    return;
                }
            }
        }
		} catch (err) {
			console.warn("Could not check for existing selected themes:", err);
		}
	}

	if (firstGenerateObject.firstGenerate && !demoingObject.demoing) {
		try {
			const currentProgress = await fetchGenerationProgress();
			const currentThemes = progressThemes(currentProgress);
			if (Number(currentProgress?.stage) >= 4 && currentThemes.length > 0) {
				possibleThemesObject.possibleThemes = currentThemes;
				themesObject.themes = [];
				firstGenerateObject.firstGenerate = false;
				hideLoadingPopup();
				renderThemesUI();
				return;
			}
			if (isGenerationProgressRunning(currentProgress)) {
				firstGenerateObject.firstGenerate = false;
				window.dispatchEvent(new CustomEvent("themes:generation-started"));
				window.location.href = "/themes";
				return;
			}
		} catch (error) {
			console.warn("Could not check current generation progress:", error);
		}
	}

	const shouldShowGenerationOverlay = !(firstGenerateObject.firstGenerate && !demoingObject.demoing);
	if (shouldShowGenerationOverlay) {
		showLoadingPopup(useLegacyLoadingWindow);
	}
	if (shouldShowGenerationOverlay && !useLegacyLoadingWindow) {
		updateProgress(0);
	}

		if (firstGenerateObject.firstGenerate && !demoingObject.demoing){
			console.log("Calling /create_themes...");
			try {
				const projectId = getCurrentProjectId();
				const response = await fetch("/create_themes", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(projectId ? { projectId } : {})
				});
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}
			generationEtaController?.markStarted();
			window.dispatchEvent(new CustomEvent("themes:generation-started"));
			firstGenerateObject.firstGenerate = false;
			hideLoadingPopup();
			window.location.href = "/themes";
			return;
		} catch (error) {
			console.error("Backend error:", error);
			hideLoadingPopup();
			alert("Theme generation failed. You can retry from the Themes tab.");
			firstGenerateObject.firstGenerate = false;
			return;
		}
	}
	else if (firstGenerateObject.firstGenerate){
		console.log("Using demo themes...");
		possibleThemesObject.possibleThemes = getDemoPossibleThemes();
		themesObject.themes = [];
		hideLoadingPopup();
		renderThemesUI();
	}
	else {
		hideLoadingPopup();
		renderThemesUI();
	}
	firstGenerateObject.firstGenerate = false;

	function renderThemesUI({ existingProject = false } = {}){
		mainEditWindow = d3.select("#main-edit-window");
		mainEditWindow.style("flex-direction", "column")
			.style("align-items", "center");
		startThemeSelectionAutosave();
		persistThemeSelectionSnapshot();

		var title = mainEditWindow.append("div")
			.attr("class", "theme-selection-header")
			.style("position", "absolute")
			.style("top", "10%")
			.style("text-align", "center")
			.style("font-family", "Inter")
			.style("font-weight", 700)
			.style("font-size", "34px")
			.text(existingProject ? "Your Selected Codes" : "Create your Codes");

		var description = title.append("div")
			.attr("class", "theme-selection-description")
			.style("margin-top", "15px")
			.style("font-size", "16px");

		if (existingProject) {
			description.text("These are the codes you previously selected for this project.");
		}
		else {
			var suggestedLine = description.append("div")
				.attr("class", "theme-selection-description-line");

			suggestedLine.append("span")
				.text("ChromaScribe has detected some phrases it believes to be relevant codes ");

			var codeHelp = suggestedLine.append("span")
				.attr("class", "code-help-wrapper")
				.attr("tabindex", "0")
				.attr("aria-label", "How suggested codes are derived")
				.attr("aria-describedby", "code-derivation-tooltip");

			codeHelp.append("span")
				.attr("class", "code-help-trigger")
				.text("(?)");

				var codeTooltip = codeHelp.append("span")
					.attr("id", "code-derivation-tooltip")
					.attr("class", "code-help-tooltip")
					.attr("role", "tooltip")
					.html(`
						<span class="code-help-kicker">AI suggestions</span>
						<strong>How ChromaScribe suggests codes</strong>
						<span class="code-help-step">
							<span class="code-help-step-label">1. Find the questions and answers</span>
							<span>ChromaScribe looks at your question list and transcript, then connects each interview question with the participant's answer.</span>
						</span>
						<span class="code-help-step">
							<span class="code-help-step-label">2. Skip text that is not an answer</span>
							<span>It tries to ignore greetings, setup comments, and side conversations. If the match is unclear, it leaves the text for you to review instead of treating it as certain.</span>
						</span>
						<span class="code-help-step">
							<span class="code-help-step-label">3. Look for repeated ideas</span>
							<span>Across the answers, it looks for ideas that come up more than once or seem important to the conversation.</span>
						</span>
						<span class="code-help-step">
							<span class="code-help-step-label">4. Turn ideas into starting codes</span>
							<span>It gives those ideas short labels and keeps the matching transcript quotes with them, so you can check the evidence yourself.</span>
						</span>
						<span class="code-help-note">These are only suggestions. You can keep, rename, delete, regroup, or ignore them. Your manual codes stay visible and remain under your control.</span>
					`);

				function positionCodeDerivationTooltip() {
					var wrapperNode = codeHelp.node();
					var tooltipNode = codeTooltip.node();
					if (!wrapperNode || !tooltipNode) return;
					var margin = 12;
					var wrapperRect = wrapperNode.getBoundingClientRect();
					var viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
						var viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;

						var availableHeight = Math.max(180, viewportHeight - (margin * 2));
						codeTooltip
							.style("max-height", `${availableHeight}px`)
							.style("bottom", "auto")
							.style("left", "0px")
							.style("top", "0px");

					window.requestAnimationFrame(function() {
						var tooltipRect = tooltipNode.getBoundingClientRect();
						var left = wrapperRect.left + (wrapperRect.width / 2) - (tooltipRect.width / 2);
						var top = wrapperRect.top - tooltipRect.height - 10;

						if (top < margin) {
							top = wrapperRect.bottom + 10;
						}
						left = Math.max(margin, Math.min(left, viewportWidth - tooltipRect.width - margin));
						top = Math.max(margin, Math.min(top, viewportHeight - tooltipRect.height - margin));

						codeTooltip
							.style("left", `${left}px`)
							.style("top", `${top}px`);
					});
				}

				codeHelp
					.on("mouseenter", positionCodeDerivationTooltip)
					.on("focus", positionCodeDerivationTooltip)
					.on("focusin", positionCodeDerivationTooltip);
				d3.select(window).on("resize.code-derivation-tooltip", function() {
					if (codeTooltip.style("visibility") === "visible") {
						positionCodeDerivationTooltip();
					}
				});

			suggestedLine.append("span")
				.text(". Select or create one or more codes to continue.");

			description.append("div")
				.attr("class", "theme-selection-description-or")
				.text("OR");

			description.append("div")
				.attr("class", "theme-selection-description-line")
				.text("You can go to the Transcript page and manually create and apply codes to the transcripts.");
		}

		var themeCloud = mainEditWindow.append("div")
			.style("position", "absolute")
			.style("display", "grid")
			.style("grid-template-columns", "0.5fr 0.5fr")
			.style("flex-direction", "row")
			.style("flex-wrap", "wrap")
			.style("justify-content", "center")
			.style("gap", "0px")
			.style("align-content", "flex-start")
			.style("top", "300px")
			.style("width", "80%")
			.style("bottom", "200px")
			.style("overflow", "scroll")
			.style("padding-right","1px");

		const themesToShow = possibleThemesObject.possibleThemes.length > 0
			? possibleThemesObject.possibleThemes
			: themesObject.themes.map(t => t.themeName);

		for (var i = 0; i < themesToShow.length; i++){
			var themeButton = themeCloud.append("button")
		.attr("id", themesToShow[i])
		.style("margin", "10px")
		.style("padding", "12px 10px 12px 10px")
		.style("height", "auto")
		.style("text-align", "left")
		.style("min-width", "100px")
		.style("border-radius", "5px")
		.style("background", function() {
			for (var j=0; j<themesObject.themes.length; j++){
				if (themesObject.themes[j].themeName === themesToShow[i])
					return themesObject.themes[j].color;
			}
				return "#ffffff";
			})
			.style("border", function() {
				for (var j=0; j<themesObject.themes.length; j++){
					if (themesObject.themes[j].themeName === themesToShow[i])
						return "2px solid "+themesObject.themes[j].color;
				}
				return "2px solid #000000";
			})
			.style("color", function() {
				for (var j=0; j<themesObject.themes.length; j++){
					if (themesObject.themes[j].themeName === themesToShow[i])
						return "#ffffff";
				}
				return "#000000";
			})
			.style("font-family", "Inter")
			.style("font-size", "16px")
			.style("font-weight", 700)
			.text(themesToShow[i].replace(/_/g, " "))
			.on("click", function() {
				var themeFound = false, colorCode;
				d3.select("#theme_error_message").remove();
				d3.select("#min_theme_error_message").remove();
				for (var i=0; i< themesObject.themes.length; i++){
					if (themesObject.themes[i].themeName === this.id)
						themeFound = true;
				}
				if (!themeFound) {
					colorCode = addSelectedTheme(this.id);
					d3.select(this).style("background", colorCode)
						.style("border", "2px solid "+colorCode)
						.style("color", "#ffffff");
				}
				else {
					d3.select(this).style("background", "#ffffff")
						.style("border", "2px solid #000000")
						.style("color", "#000000");
					for (var i=0; i<themesObject.themes.length; i++){
						if (themesObject.themes[i].themeName === this.id){
							if (isManualThemeEntry(themesObject.themes[i])) {
								setManualCodeSelection(themesObject, this.id, false);
							}
							themesObject.themes.splice(i, 1);
						}
					}
				}
				persistThemeSelectionSnapshot();
			});
	}
	var themeProcessed = false;  // Flag to track if theme is already processed

	var addThemeButton = mainEditWindow.append("button")
		.style("position", "absolute")
		.style("bottom", "120px")
		.style("padding", "12px 20px 12px 20px")
		.style("border-radius", "10px")
		.style("background", "#ffffff")
		.style("border", "2px solid #000000")
		.style("font-family", "Inter")
		.style("font-size", "16px")
		.style("font-weight", 700)
		.text("Add a Code  +")
		.on("click", function() {
			d3.select(this).style("opacity", 0.2)
				.on("click", function(){});
			var newThemeInput = themeCloud.append("input")
				.style("width", "0.5fr")
				.style("padding", "12px 20px 12px 20px")
				.style("border-radius", "10px")
				.style("background", "#ffffff")
				.style("border", "2px solid #000000")
				.style("font-family", "Inter")
				.style("font-size", "16px")
				.style("font-weight", 700)
				.style("margin", "15px")
				.style("text-align", "left")
				.on("input", function() {
					themeProcessed = false;  // Reset flag when typing starts again
					creatingNewTheme = true;
					var newTheme = normalizeNewThemeNameInput(this.value);
					d3.select(this).property("value", newTheme);
					var fake = themeCloud.append("text")
							.attr("id", "fake")
							.style("position", "absolute")
							.style("display", "block")
							.style("opacity", 0)
							.style("padding", "12px 20px 12px 20px")
							.style("font-family", "Inter")
							.style("font-size", "16px")
							.style("font-weight", 700)
							.text(newTheme)
					d3.select(this).style("width", function() {
						if (fake.node().offsetWidth > 100)
							return fake.node().offsetWidth+4;
						return "0.5fr";
					});
					d3.select("#fake").remove();
				})
				.on("keydown", function(event) {
					if (event.key === "Enter" && !themeProcessed) {
						event.preventDefault();
						console.log("Enter key pressed");
						themeProcessed = true;
						processTheme(this);
					}
				})
				.on("blur", function() {
					if (!themeProcessed) {
						event.preventDefault();
						console.log("Focus lost");
						processTheme(this);
					}
					else{
						themeProcessed = false;
						return;
					}
				});
				function processTheme(inputElement) {
					creatingNewTheme = true;
					var newTheme = normalizeNewThemeNameInput(inputElement.value);

					if (hasPossibleThemeName(possibleThemesObject.possibleThemes, newTheme)) {
						console.log("already");
						var errorMessage = d3.select(inputElement.parentNode.parentNode.parentNode).append("div")
							.attr("id", "theme_error_message")
							.attr("class", "error")
							.style("margin-left", "80%")
							.text("Theme '" + newTheme + "' already exists in the list");

						addTail(errorMessage, 34);
						setTimeout(function() { d3.select("#theme_error_message").remove(); }, 3000);
					}
					else if( newTheme === ""){
						var errorMessage = d3.select(inputElement.parentNode.parentNode.parentNode).append("div")
							.attr("id", "theme_error_message")
							.attr("class", "error")
							.style("margin-left", "80%")
							.text("Theme cannot be blank");

						addTail(errorMessage, 34);
						setTimeout(function() { d3.select("#theme_error_message").remove(); }, 3000);
					}
					 else {
						submitTheme(newTheme);
						//possibleThemesObject.possibleThemes.push(newTheme);  // Add new theme to the list
					}
					//themeProcessed = true;  // Set flag to prevent duplicate submission
				}

				function submitTheme(inputElement) {
					possibleThemesObject.possibleThemes.unshift(inputElement);
					addSelectedTheme(inputElement, "manual_codes");
					persistThemeSelectionSnapshot();
					generateThemes();

				}

			d3.select("#settings-page").on("click", function() {
				if (creatingNewTheme 
				&& (d3.event.x < newThemeInput.node().offsetLeft ||
				d3.event.x > newThemeInput.node().offsetLeft + newThemeInput.node().offsetWidth ||
				d3.event.y < newThemeInput.node().offsetTop ||
				d3.event.y > newThemeInput.node().offsetTop + newThemeInput.node().offsetHeight) &&
				newThemeInput.node().value != ""){
					var found = false;
					for (var i=0; i<possibleThemesObject.possibleThemes.length; i++){
						if (possibleThemesObject.possibleThemes[i].toLowerCase() === newThemeInput.node().value.toLowerCase()){
							found = true;
								var errorMessage = d3.select('#main-edit-window').append("div")
								.attr("id", "theme_error_message")
								.attr("class", "error")
								.style("margin-left", "80%")
								.text("Theme already exist in the list")
							addTail(errorMessage, 34);
							setTimeout(function(){d3.select("#theme_error_message").remove()}, 5000);
						}
					}
					if (!found){
						const newThemeName = normalizeNewThemeNameInput(newThemeInput.node().value);
						if (newThemeName) {
							possibleThemesObject.possibleThemes.push(newThemeName);
							addSelectedTheme(newThemeName, "manual_codes");
						}
					}
					persistThemeSelectionSnapshot();
					generateThemes();
				}
				else if (creatingNewTheme) {
					persistThemeSelectionSnapshot();
					generateThemes();
				}
				creatingNewTheme = false;
			});
			var selection = window.getSelection();  
			var range = document.createRange();  
			selection.removeAllRanges();  
			range.selectNodeContents(newThemeInput.node());  
			range.collapse(false);  
			selection.addRange(range);  
			newThemeInput.node().focus();
		});

	var nextButton = mainEditWindow.append("button")
		.style("position", "absolute")
		.style("right", "20px")
		.style("bottom", "20px")
		.style("border-radius", "10px")
		.style("background", "#000000")
		.style("padding", "12px 20px 12px 20px")
		.style("font-family", "Inter")
		.style("font-size", "16px")
		.style("font-weight", 700)
		.style("color", "#ffffff")
		.text("Next")
		.on("click", function() {
			void continueToCodeEditor(this);
		});
	}
}
