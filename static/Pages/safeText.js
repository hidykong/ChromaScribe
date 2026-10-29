const HTML_ENTITIES = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
};

export function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, character => HTML_ENTITIES[character]);
}

export function findTextHighlights(text, phrase, attributes = {}) {
    if (!phrase) return [];
    const escapedPhrase = String(phrase).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(escapedPhrase, "gi");
    return Array.from(String(text).matchAll(pattern), match => ({
        ...attributes,
        start: match.index,
        end: match.index + match[0].length
    }));
}

function wrapHighlight(content, highlight) {
    const attributes = [
        `class="${escapeHtml(highlight.className || "highlight")}"`,
        `title="${escapeHtml(highlight.title || "")}"`
    ];
    if (highlight.backgroundColor) {
        attributes.push(`style="background-color:${escapeHtml(highlight.backgroundColor)}"`);
    }
    if (highlight.className === "note-highlight") {
        attributes.push(`data-start-index="${highlight.start}"`);
    }
    return `<span ${attributes.join(" ")}>${content}</span>`;
}

function isValidHighlightRange(highlight, textLength) {
    if (!Number.isInteger(highlight.start) || !Number.isInteger(highlight.end)) return false;
    if (highlight.start < 0 || highlight.end > textLength) return false;
    return highlight.end > highlight.start;
}

export function renderHighlightedText(value, highlights = []) {
    const text = String(value ?? "");
    const validHighlights = highlights.filter(highlight => isValidHighlightRange(highlight, text.length));
    const boundaries = new Set([0, text.length]);
    for (const highlight of validHighlights) {
        boundaries.add(highlight.start);
        boundaries.add(highlight.end);
    }
    const positions = Array.from(boundaries).sort((left, right) => left - right);
    const fragments = [];
    for (let index = 0; index < positions.length - 1; index += 1) {
        const start = positions[index];
        const end = positions[index + 1];
        let fragment = escapeHtml(text.slice(start, end));
        for (const highlight of validHighlights) {
            if (highlight.start <= start && highlight.end >= end) {
                fragment = wrapHighlight(fragment, highlight);
            }
        }
        fragments.push(fragment);
    }
    return fragments.join("");
}
