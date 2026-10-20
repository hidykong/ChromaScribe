import { themesObject } from "../../../chromascribe-main.js";
import {
    buildThemeExcerptEntry,
    buildThemeWordIdentityKey,
    normalizeThemeWordText,
    persistThemePayload,
    restoreArchivedCodeInPayload,
    selectManualCodeForNewExcerpt
} from "../../themePersistence.js?v=20260901b";

function getCurrentProjectId() {
    const serverProjectId = String(window.CURRENT_PROJECT_ID || "").trim();
    if (serverProjectId) return serverProjectId;
    const rawValue = localStorage.getItem("currentProjectId");
    return typeof rawValue === "string" ? rawValue.trim() : "";
}

function projectQueryParam() {
    const projectId = getCurrentProjectId();
    return projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
}

function withProjectPayload(payload) {
    const projectId = getCurrentProjectId();
    return projectId ? { ...payload, projectId } : payload;
}

function scopedRoute(path) {
    const normalized = path.startsWith("/") ? path : `/${path}`;
    return window.location.pathname.startsWith("/demo/") || window.location.pathname === "/demo"
        ? `/demo${normalized}`
        : normalized;
}

function replacePayloadState(target, payload) {
    if (!target || !payload) return;
    target.themes = structuredClone(Array.isArray(payload.themes) ? payload.themes : []);
    target.archivedCodes = structuredClone(Array.isArray(payload.archivedCodes) ? payload.archivedCodes : []);
    [
        "manualSelectionOptOuts",
        "selectionSource",
        "selectionStage",
        "appliedToVisualization",
        "appliedAt",
        "updatedAt",
        "visualizationPreviewState",
        "selectedByUser",
        "selectedThemesExists",
        "projectRevision"
    ].forEach(key => {
        if (Object.prototype.hasOwnProperty.call(payload, key)) {
            target[key] = structuredClone(payload[key]);
        }
    });
}

async function fetchSelectedArchivePayload(fallbackPayload) {
    try {
        const query = projectQueryParam();
        const separator = query ? "&" : "?";
        const response = await fetch(
            `/api/load_selected_themes${query}${separator}includeUnselectedManual=1&t=${Date.now()}`,
            { cache: "no-store" }
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        return payload && Array.isArray(payload.themes) ? payload : fallbackPayload;
    } catch (error) {
        console.warn("Could not load archived codes:", error);
        return fallbackPayload;
    }
}

async function fetchDeletedQuotes() {
    try {
        const response = await fetch(`/api/load_deleted_quotes${projectQueryParam()}`, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        return Array.isArray(payload.deletedQuotes) ? payload.deletedQuotes : [];
    } catch (error) {
        console.warn("Could not load archived quotes:", error);
        return [];
    }
}

function appendSectionHeading(container, title, count, description) {
    const header = container.append("div")
        .style("display", "flex")
        .style("align-items", "baseline")
        .style("gap", "10px")
        .style("margin", "4px 0 12px");
    header.append("h2")
        .style("margin", "0")
        .style("font-family", "Inter")
        .style("font-size", "18px")
        .style("font-weight", "800")
        .style("color", "#111827")
        .text(title);
    header.append("span")
        .style("font-family", "Inter")
        .style("font-size", "12px")
        .style("font-weight", "700")
        .style("color", "#64748b")
        .text(count);
    container.append("div")
        .style("font-family", "Inter")
        .style("font-size", "13px")
        .style("color", "#6b7280")
        .style("margin-bottom", "14px")
        .text(description);
}

function appendEmptySection(container, message) {
    container.append("div")
        .style("padding", "22px")
        .style("border", "1px dashed #cbd5e1")
        .style("border-radius", "10px")
        .style("background", "#f8fafc")
        .style("font-family", "Inter")
        .style("font-size", "14px")
        .style("color", "#64748b")
        .style("text-align", "center")
        .text(message);
}

function formatArchiveDate(rawValue) {
    const parsed = new Date(rawValue || "");
    if (Number.isNaN(parsed.getTime())) return "Archived recently";
    return `Archived ${parsed.toLocaleString()}`;
}

function renderArchivedCodes(container, archivedCodes, themeObject, rerender) {
    const section = container.append("section")
        .attr("aria-labelledby", "archived-codes-heading")
        .style("margin-bottom", "34px");
    appendSectionHeading(
        section,
        "Archived Codes",
        `${archivedCodes.length} code${archivedCodes.length === 1 ? "" : "s"}`,
        "Archived codes retain their colors, groups, comments, and quotation assignments."
    );
    section.select("h2").attr("id", "archived-codes-heading");

    if (archivedCodes.length === 0) {
        appendEmptySection(section, "No archived codes.");
        return;
    }

    archivedCodes.forEach(code => {
        const words = Array.isArray(code.words) ? code.words : [];
        const groups = Array.isArray(code.groups) ? code.groups : [];
        const card = section.append("div")
            .style("display", "flex")
            .style("align-items", "center")
            .style("gap", "14px")
            .style("padding", "16px")
            .style("margin-bottom", "10px")
            .style("background", "#ffffff")
            .style("border", "1px solid #e5e7eb")
            .style("border-left", `5px solid ${code.color || "#64748b"}`)
            .style("border-radius", "10px");

        const details = card.append("div")
            .style("display", "flex")
            .style("flex-direction", "column")
            .style("gap", "5px")
            .style("flex", "1")
            .style("min-width", "0");
        details.append("div")
            .style("font-family", "Inter")
            .style("font-size", "16px")
            .style("font-weight", "800")
            .style("color", "#111827")
            .text(String(code.themeName || "Archived code"));
        details.append("div")
            .style("font-family", "Inter")
            .style("font-size", "13px")
            .style("color", "#64748b")
            .text(`${words.length} quotation${words.length === 1 ? "" : "s"} · ${groups.length} group${groups.length === 1 ? "" : "s"} · ${formatArchiveDate(code.archivedAt)}`);
        if (String(code.comment || "").trim()) {
            details.append("div")
                .style("font-family", "Inter")
                .style("font-size", "13px")
                .style("color", "#374151")
                .style("overflow-wrap", "anywhere")
                .text(String(code.comment));
        }

        const restoreButton = card.append("button")
            .attr("type", "button")
            .attr("aria-label", `Restore ${String(code.themeName || "code")}`)
            .style("flex-shrink", "0")
            .style("padding", "8px 15px")
            .style("border-radius", "8px")
            .style("background", "#f0fdf4")
            .style("border", "1px solid #86efac")
            .style("color", "#166534")
            .style("font-family", "Inter")
            .style("font-size", "13px")
            .style("font-weight", "700")
            .style("cursor", "pointer")
            .text("Restore")
            .on("click", async function() {
                restoreButton.property("disabled", true).style("opacity", "0.55").text("Restoring...");
                try {
                    const nextPayload = restoreArchivedCodeInPayload(themeObject, code.themeName);
                    const persisted = await persistThemePayload(nextPayload, {
                        rollbackOnError: true,
                        throwOnError: true,
                    });
                    replacePayloadState(themeObject, persisted);
                    replacePayloadState(themesObject, persisted);
                    await rerender();
                } catch (error) {
                    console.error("Could not restore archived code:", error);
                    restoreButton.property("disabled", false).style("opacity", "1").text("Try again");
                    details.append("div")
                        .attr("role", "alert")
                        .style("font-family", "Inter")
                        .style("font-size", "12px")
                        .style("color", "#b91c1c")
                        .text(error.message || "Could not restore this code.");
                }
            });
    });
}

function renderDeletedQuotes(container, deletedQuotes, themeObject, rerender) {
    const section = container.append("section")
        .attr("aria-labelledby", "archived-quotes-heading");
    appendSectionHeading(
        section,
        "Archived Quotes",
        `${deletedQuotes.length} quote${deletedQuotes.length === 1 ? "" : "s"}`,
        "Quotes removed from active codes remain available here."
    );
    section.select("h2").attr("id", "archived-quotes-heading");

    if (deletedQuotes.length === 0) {
        appendEmptySection(section, "No archived quotes.");
        return;
    }

    const grouped = {};
    deletedQuotes.forEach(item => {
        const themeName = String(item.themeName || "Unknown code");
        if (!grouped[themeName]) grouped[themeName] = [];
        grouped[themeName].push(item);
    });
    const colorMap = {};
    [...(themeObject.themes || []), ...(themeObject.archivedCodes || [])].forEach(theme => {
        colorMap[String(theme.themeName || "")] = theme.color;
    });

    Object.entries(grouped).forEach(([themeName, quotes]) => {
        const themeGroup = section.append("div").style("margin-bottom", "24px");
        const groupHeader = themeGroup.append("div")
            .style("display", "flex")
            .style("align-items", "center")
            .style("gap", "8px")
            .style("margin-bottom", "10px");
        groupHeader.append("span")
            .style("width", "10px")
            .style("height", "10px")
            .style("border-radius", "50%")
            .style("background", colorMap[themeName] || "#64748b");
        groupHeader.append("strong")
            .style("font-family", "Inter")
            .style("font-size", "14px")
            .style("color", "#374151")
            .text(themeName);

        quotes.forEach(item => {
            const card = themeGroup.append("div")
                .style("display", "flex")
                .style("align-items", "flex-start")
                .style("gap", "12px")
                .style("padding", "14px 16px")
                .style("background", "#ffffff")
                .style("border", "1px solid #e5e7eb")
                .style("border-left", `4px solid ${colorMap[themeName] || "#64748b"}`)
                .style("border-radius", "10px")
                .style("margin-bottom", "8px");
            const quoteText = card.append("div")
                .style("flex", "1")
                .style("font-family", "Inter")
                .style("font-size", "14px")
                .style("color", "#374151")
                .style("line-height", "1.6")
                .text(item.word);
            const restoreButton = card.append("button")
                .attr("type", "button")
                .style("flex-shrink", "0")
                .style("padding", "6px 14px")
                .style("border-radius", "8px")
                .style("background", "#f0fdf4")
                .style("border", "1px solid #86efac")
                .style("color", "#166534")
                .style("font-family", "Inter")
                .style("font-size", "13px")
                .style("font-weight", "700")
                .style("cursor", "pointer")
                .text("Restore")
                .on("click", async function() {
                    restoreButton.property("disabled", true).style("opacity", "0.55");
                    try {
                        await restoreQuote(item, themeObject, deletedQuotes);
                        await rerender();
                    } catch (error) {
                        console.error("Could not restore archived quote:", error);
                        restoreButton.property("disabled", false).style("opacity", "1").text("Try again");
                        quoteText.append("div")
                            .attr("role", "alert")
                            .style("font-size", "12px")
                            .style("color", "#b91c1c")
                            .text(error.message || "Could not restore this quote.");
                    }
                });
        });
    });
}

async function loadAndRenderArchive(listContainer, themeObject) {
    listContainer.selectAll("*").remove();
    const [selectedPayload, deletedQuotes] = await Promise.all([
        fetchSelectedArchivePayload(themeObject),
        fetchDeletedQuotes(),
    ]);
    replacePayloadState(themeObject, selectedPayload);
    replacePayloadState(themesObject, selectedPayload);

    const archivedCodes = Array.isArray(themeObject.archivedCodes) ? themeObject.archivedCodes : [];
    const totalCount = archivedCodes.length + deletedQuotes.length;
    d3.select("#archiveCount").text(
        totalCount === 0
            ? "Empty"
            : `${archivedCodes.length} code${archivedCodes.length === 1 ? "" : "s"}, ${deletedQuotes.length} quote${deletedQuotes.length === 1 ? "" : "s"}`
    );

    const rerender = () => loadAndRenderArchive(listContainer, themeObject);
    renderArchivedCodes(listContainer, archivedCodes, themeObject, rerender);
    renderDeletedQuotes(listContainer, deletedQuotes, themeObject, rerender);
}

async function restoreQuote(item, themeObject, deletedQuotes) {
    const targetTheme = (themeObject.themes || []).find(
        theme => String(theme.themeName || "").trim().toLowerCase() === String(item.themeName || "").trim().toLowerCase()
    );
    if (!targetTheme) {
        throw new Error("Restore the archived code before restoring one of its quotes.");
    }
    const alreadyExists = (targetTheme.words || []).some(
        word => buildThemeWordIdentityKey(word) === buildThemeWordIdentityKey(item)
    );
    if (!alreadyExists) {
        const restoredEntry = buildThemeExcerptEntry({
            ...item,
            value: 1,
            stemmedWords: [],
            codeSource: "manual",
            source: "manual",
            ai_generated: false,
            humanTagged: true,
            selectedByUser: true,
        });
        targetTheme.words = Array.isArray(targetTheme.words) ? targetTheme.words : [];
        targetTheme.words.push(restoredEntry);
        selectManualCodeForNewExcerpt(themeObject, item.themeName, restoredEntry);
    }

    const persisted = await persistThemePayload(themeObject, {
        rollbackOnError: true,
        throwOnError: true,
    });
    replacePayloadState(themeObject, persisted);
    replacePayloadState(themesObject, persisted);

    const updatedQuotes = deletedQuotes.filter(quote => {
        if (String(quote.themeName || "").trim().toLowerCase() !== String(item.themeName || "").trim().toLowerCase()) {
            return true;
        }
        if (quote.participant || quote.tag || quote.timestamp || quote.cueText) {
            return buildThemeWordIdentityKey(quote) !== buildThemeWordIdentityKey(item);
        }
        return normalizeThemeWordText(quote.word).toLowerCase() !== normalizeThemeWordText(item.word).toLowerCase();
    });
    const response = await fetch("/api/save_deleted_quotes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withProjectPayload({ deletedQuotes: updatedQuotes })),
    });
    if (!response.ok) {
        throw new Error("The quote was restored, but its archive entry could not be removed. Refresh and try again.");
    }
}

export async function showArchivePage(themeObject = { themes: [], archivedCodes: [] }) {
    const mainEditWindow = d3.select("#main-edit-window");
    mainEditWindow.selectAll("*").remove();
    mainEditWindow
        .style("flex-direction", "column")
        .style("overflow", "hidden")
        .style("position", "relative");

    const header = mainEditWindow.append("div")
        .style("padding", "20px 30px 16px")
        .style("border-bottom", "1px solid #e5e7eb")
        .style("flex-shrink", "0")
        .style("display", "flex")
        .style("align-items", "center")
        .style("gap", "12px");
    header.append("div")
        .style("font-family", "Inter")
        .style("font-size", "22px")
        .style("font-weight", "800")
        .style("color", "#111827")
        .text("Archive");
    header.append("div")
        .attr("id", "archiveCount")
        .style("font-family", "Inter")
        .style("font-size", "13px")
        .style("color", "#6b7280")
        .style("background", "#f3f4f6")
        .style("border-radius", "20px")
        .style("padding", "3px 10px")
        .text("Loading...");

    const listContainer = mainEditWindow.append("div")
        .attr("id", "archiveList")
        .style("flex", "1")
        .style("overflow-y", "auto")
        .style("padding", "20px 30px 32px");

    const footer = mainEditWindow.append("div")
        .style("padding", "14px 30px")
        .style("border-top", "1px solid #e5e7eb")
        .style("flex-shrink", "0");
    footer.append("button")
        .attr("type", "button")
        .style("border-radius", "10px")
        .style("background", "#ececf0")
        .style("padding", "11px 20px")
        .style("font-family", "Inter")
        .style("font-size", "15px")
        .style("font-weight", "700")
        .style("cursor", "pointer")
        .style("border", "none")
        .text("Back to Codes")
        .on("click", () => {
            window.location.href = scopedRoute("/themes");
        });

    await loadAndRenderArchive(listContainer, themeObject);
}
