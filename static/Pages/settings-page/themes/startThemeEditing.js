import {generateThemes} from "./generateThemes.js?v=20260901a";
import { themesObject, firstEditObject, demoingObject } from "../../../chromascribe-main.js";
import { getCurrentData } from "../import/syncAudiosToTranscripts.js?v=20260601c";
import { getThemesStorageKey } from "../../themePersistence.js?v=20260901b";

function extractThemeNames(themePayload) {
	if (!themePayload || !Array.isArray(themePayload.themes)) return [];
	const seen = new Set();
	const names = [];
	themePayload.themes.forEach(theme => {
		const name = (theme && typeof theme === "object" ? theme.themeName : "")
			? String(theme.themeName).trim()
			: "";
		if (!name || seen.has(name)) return;
		seen.add(name);
		names.push(name);
	});
	return names;
}

function themePayloadSignature(themePayload) {
	const themes = Array.isArray(themePayload?.themes) ? themePayload.themes : [];
	const normalizedThemes = themes
		.map(theme => {
			const themeName = String(theme?.themeName || theme?.theme || theme?.name || "").trim();
			if (!themeName) return null;
			const words = Array.isArray(theme?.words) ? theme.words : [];
			return {
				themeName: themeName.toLowerCase(),
				summary: String(theme?.summary || "").trim(),
				words: words
					.map(word => {
						const entry = word && typeof word === "object" ? word : { word };
						return {
							word: String(entry.word || entry.text || entry.quote || entry.excerpt || "").trim(),
							participant: String(entry.participant || "").trim(),
							tag: String(entry.tag || "").trim(),
							timestamp: String(entry.timestamp || "").trim(),
							cueText: String(entry.cueText || "").trim(),
							codeSource: String(entry.codeSource || entry.source || entry.tagSource || "").trim(),
							aiGenerated: entry.ai_generated === false ? false : true
						};
					})
					.filter(word => word.word)
					.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
			};
		})
		.filter(Boolean)
		.sort((a, b) => a.themeName.localeCompare(b.themeName));
	return JSON.stringify(normalizedThemes);
}

function getCurrentProjectId() {
	return (window.CURRENT_PROJECT_ID || localStorage.getItem("currentProjectId") || "").trim();
}

function getProjectStorageScope(projectId = getCurrentProjectId()) {
	const resolvedProjectId = String(projectId || "").trim();
	if (!resolvedProjectId) return "";
	const workspaceKey = (window.USER_WORKSPACE_KEY || localStorage.getItem("currentWorkspaceKey") || "").trim();
	return workspaceKey ? `${workspaceKey}__${resolvedProjectId}` : resolvedProjectId;
}

function getSelectionCompleteKey(projectId = getCurrentProjectId()) {
	const storageScope = getProjectStorageScope(projectId);
	return storageScope ? `themeSelectionComplete_${storageScope}` : "themeSelectionComplete";
}

function getSelectionPendingKey(projectId = getCurrentProjectId()) {
	const storageScope = getProjectStorageScope(projectId);
	return storageScope ? `themeSelectionPending_${storageScope}` : "themeSelectionPending";
}

function isManualThemeWord(word) {
	if (!word || typeof word !== "object") return false;
	const source = String(word.codeSource || word.source || word.tagSource || "").trim().toLowerCase();
	return source === "manual" || source === "human" || word.ai_generated === false;
}

function manualOnlyThemePayload(themes = []) {
	return {
		themes: (Array.isArray(themes) ? themes : [])
			.map(theme => {
				if (!theme || typeof theme !== "object") return null;
				const manualWords = (Array.isArray(theme.words) ? theme.words : []).filter(isManualThemeWord);
				if (manualWords.length === 0) return null;
				return {
					...theme,
					words: manualWords
				};
			})
			.filter(Boolean)
	};
}

async function fetchServerThemeObject() {
	try {
		const projectId = getCurrentProjectId();
		const projectParam = projectId ? `&projectId=${encodeURIComponent(projectId)}` : "";
		const response = await fetch(`/api/themes?t=${Date.now()}${projectParam}`, { cache: "no-store", signal: AbortSignal.timeout(15000) });
		if (!response.ok) return null;
		const payload = await response.json();
		if (!payload || typeof payload !== "object") return null;
		if (!Array.isArray(payload.themes) || payload.themes.length === 0) return null;
		return payload;
	} catch (error) {
		console.warn("Failed to fetch server themes:", error);
		return null;
	}
}

async function fetchSavedThemeObject() {
	try {
		const projectId = getCurrentProjectId();
		const projectParam = projectId ? `&projectId=${encodeURIComponent(projectId)}` : "";
		const response = await fetch(`/api/load_selected_themes?displayOnly=1&t=${Date.now()}${projectParam}`, { cache: "no-store", signal: AbortSignal.timeout(15000) });
		if (!response.ok) return null;
		const payload = await response.json();
		return payload && Array.isArray(payload.themes) ? payload : null;
	} catch (error) {
		console.warn("Failed to load saved code selection:", error);
		return null;
	}
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

async function hasRunningGenerationProgress() {
	if ((window.APP_MODE || "user") === "demo") return false;
	try {
		const projectId = getCurrentProjectId();
		const projectParam = projectId ? `&projectId=${encodeURIComponent(projectId)}` : "";
		const response = await fetch(`/progress?t=${Date.now()}${projectParam}`, { cache: "no-store", signal: AbortSignal.timeout(15000) });
		if (!response.ok) return false;
		return isGenerationProgressRunning(await response.json());
	} catch (error) {
		console.warn("Could not check generation progress:", error);
		return false;
	}
}

async function showCodeManager(themes = { themes: [] }) {
	const { startDemoThemeEditing } = await import("./demoGenerateThemes.js?v=20261024a");
	await startDemoThemeEditing(themes && Array.isArray(themes.themes) ? themes : { themes: [] });
}

export async function startThemeEditing({ waitForGeneration = false } = {}) {
	if (window.location.pathname.includes('/themes/archive')) {
        console.log("[archive] pathname matched, loading archive page");
        const { showArchivePage } = await import('./archivePage.js?v=20260901a');
        const projectId = getCurrentProjectId();
        const themesKey = getThemesStorageKey(projectId);
        console.log("[archive] projectId:", projectId, "themesKey:", themesKey);
        let themeObject = { themes: [] };
        try {
            const storedRaw = localStorage.getItem(themesKey);
            console.log("[archive] storedRaw:", storedRaw ? "found" : "null");
            if (storedRaw) {
                const stored = JSON.parse(storedRaw);
                if (stored && Array.isArray(stored.themes)) {
                    themeObject = {
                        themes: stored.themes.map(t => ({
                            themeName: t.themeName,
                            color: t.color
                        }))
                    };
                }
            }
        } catch(e) { console.error("[archive] localStorage error:", e); }
        console.log("[archive] calling showArchivePage with", themeObject.themes.length, "themes");
        showArchivePage(themeObject);
        return;
    }
	const projectId = getCurrentProjectId();
	const selectionPending = localStorage.getItem(getSelectionPendingKey(projectId)) === "1";
	const selectionComplete = localStorage.getItem(getSelectionCompleteKey(projectId)) === "1" && !selectionPending;
	const themesKey = getThemesStorageKey(projectId);
	const storageScope = getProjectStorageScope(projectId);
	const generatedThemesKey = storageScope ? `generatedPossibleThemes_${storageScope}` : "generatedPossibleThemes";
	let preGeneratedThemes = [];
	let storedSelectedThemes = [];
	let hasFreshGeneratedThemes = false;
	try {
		const storedRaw = localStorage.getItem(themesKey);
		if (storedRaw) {
			const storedThemes = JSON.parse(storedRaw);
			if (storedThemes && Array.isArray(storedThemes.themes) && storedThemes.themes.length > 0) {
				storedSelectedThemes = structuredClone(storedThemes.themes);
				themesObject.themes = structuredClone(storedThemes.themes);
				firstEditObject.firstEdit = false;
			}
		}
	} catch (e) {
		console.warn("Failed to load stored themes:", e);
	}
	try {
		const candidateKeys = projectId ? [generatedThemesKey] : [generatedThemesKey, "generatedPossibleThemes"];
		for (const key of candidateKeys) {
			const generatedRaw = localStorage.getItem(key);
			if (!generatedRaw) continue;
			const parsedThemes = JSON.parse(generatedRaw);
			if (Array.isArray(parsedThemes) && parsedThemes.length > 0) {
				preGeneratedThemes = parsedThemes;
				hasFreshGeneratedThemes = true;
				break;
			}
		}
		localStorage.removeItem(generatedThemesKey);
		if (!projectId) {
			localStorage.removeItem("generatedPossibleThemes");
		}
	} catch (e) {
		console.warn("Failed to read generated themes:", e);
		localStorage.removeItem(generatedThemesKey);
		if (!projectId) {
			localStorage.removeItem("generatedPossibleThemes");
		}
	}

	const mainEditWindow = d3.select("#main-edit-window");
	getCurrentData();
	const [serverThemeObject, savedThemeObject] = await Promise.all([
		fetchServerThemeObject(),
		fetchSavedThemeObject()
	]);
	if (!savedThemeObject) {
		mainEditWindow.append("div").attr("role", "alert")
			.text("Could not load your saved code selection. Reload this page to try again.");
		return false;
	}
	const selectedThemesExistOnServer = savedThemeObject.selectedThemesExists === true;
	// Keep saved choices, including an intentionally empty selection, during regeneration.
	storedSelectedThemes = selectedThemesExistOnServer ? structuredClone(savedThemeObject.themes) : [];
	themesObject.themes = structuredClone(storedSelectedThemes);
	if (!hasFreshGeneratedThemes && serverThemeObject) {
		const serverThemeNames = extractThemeNames(serverThemeObject);
		const serverSignature = themePayloadSignature(serverThemeObject);
		const storedSignature = themePayloadSignature({ themes: storedSelectedThemes || [] });
		if (serverThemeNames.length > 0 && serverSignature !== storedSignature) {
			preGeneratedThemes = serverThemeNames;
			if (selectionComplete && selectedThemesExistOnServer) {
				storedSelectedThemes = structuredClone(serverThemeObject.themes);
				themesObject.themes = structuredClone(serverThemeObject.themes);
				try {
					localStorage.setItem(themesKey, JSON.stringify(serverThemeObject));
				} catch (error) {
					console.warn("Failed to sync server themes locally:", error);
				}
			} else if (!selectedThemesExistOnServer) {
				storedSelectedThemes = [];
				themesObject.themes = [];
				try {
					localStorage.removeItem(themesKey);
				} catch (error) {
					console.warn("Failed to clear stale local theme selection:", error);
				}
			}
		}
	}
	const selectedThemeNames = (storedSelectedThemes || [])
		.map(theme => theme && theme.themeName)
		.filter(name => typeof name === "string" && name.trim() !== "");
	if (preGeneratedThemes.length === 0 && selectedThemeNames.length > 0) {
		preGeneratedThemes = [...new Set(selectedThemeNames)];
	}
	if (await hasRunningGenerationProgress()) {
		if (!waitForGeneration || storedSelectedThemes.length > 0) {
			await showCodeManager({ themes: storedSelectedThemes || [] });
		}
		// The Codes page keeps its loading view and polls again until selection is ready.
		return waitForGeneration ? "waiting" : undefined;
	}
	if (preGeneratedThemes.length === 0) {
		if (serverThemeObject) {
			const serverThemeNames = extractThemeNames(serverThemeObject);
			if (serverThemeNames.length > 0) {
				preGeneratedThemes = serverThemeNames;
			}
		}
	}

	mainEditWindow.style("flex-direction", "column")
		.style("align-items", "center")
		.style("justify-content", "flex-start");

	demoingObject.demoing = (window.APP_MODE === "demo");
	firstEditObject.firstEdit = false;

	if (preGeneratedThemes.length > 0) {
		await generateThemes(preGeneratedThemes, storedSelectedThemes);
		return;
	}

	// No cached candidates yet: keep Code Manager editable while AI generation runs separately.
	await showCodeManager({ themes: storedSelectedThemes || [] });
}
