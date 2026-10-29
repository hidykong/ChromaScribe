function getGenerationFailureMessage(message) {
    const details = String(message || "").toLowerCase();

    if (/\bjson_validate_failed\b|groq could not produce valid json/.test(details)) {
        return "Groq could not finish a valid code response. Try again; if it keeps happening, increase LLM_MAX_TOKENS within your model's limit or use a smaller transcript.";
    }
    if (/rate.?limit|quota|\b429\b/.test(details)) {
        return "AI code generation reached your provider's rate or quota limit. Check the provider's limits before trying again.";
    }
    if (/api.?key|unauthorized|authentication|\b401\b|\b403\b/.test(details)) {
        return "AI code generation could not authenticate with your provider. Check your API key and provider settings before trying again.";
    }
    if (/output token limit|response was cut off|truncated response/.test(details)) {
        return "The AI reply was cut off before code generation finished. Increase LLM_MAX_TOKENS within your model's limit or use a smaller transcript, then try again.";
    }
    if (/empty (final )?response|no completion/.test(details)) {
        return "Your AI provider returned no final answer. Check your model settings, then try again.";
    }
    if (/readable codes|usable codes|parse|invalid json|json.*(invalid|error)/.test(details)) {
        return "The AI reply could not be read as codes. Check your model settings before trying again.";
    }
    if (/model.*(not found|not available|does not exist|decommissioned|not supported)|unsupported model/.test(details)) {
        return "AI code generation could not use the configured model. Check the model name and whether your provider offers it.";
    }
    if (/timed?\s?out|timeout|connection|network|unreachable/.test(details)) {
        return "AI code generation could not reach your provider. Check your connection and the provider's availability before trying again.";
    }
    return "AI code generation did not finish. Check your provider and model settings before trying again.";
}

export function updateThemeGenerationStatus(progress, documentRoot = document) {
    // A missing response is not evidence that an earlier failure has been resolved.
    if (!progress || !Number.isFinite(Number(progress.stage))) return;

    const notice = documentRoot.getElementById("theme-generation-status");
    const message = documentRoot.getElementById("theme-generation-status-message");
    if (!notice || !message) return;

    if (Number(progress.stage) >= 0) {
        notice.hidden = true;
        message.textContent = "";
        return;
    }

    // Provider errors can contain private request details. Only show fixed, safe copy.
    const safeMessage = getGenerationFailureMessage(progress.message);
    if (message.textContent !== safeMessage) {
        message.textContent = safeMessage;
    }
    notice.hidden = false;
}


export function isThemeGenerationRunning(progress) {
    if (!progress || progress.stage == null || progress.stage === "") return false;
    const stage = Number(progress.stage);
    const message = String(progress.message || "").trim().toLowerCase();
    return [0, 1, 2, 3].includes(stage)
        && !["idle", "not started", "complete", "demo data ready"].includes(message);
}

export function updateThemeLoadingStatus({ progress = null, loading = false, failed = false, waiting = false } = {}, documentRoot = document) {
    const notice = documentRoot.getElementById("theme-loading-status");
    const title = documentRoot.getElementById("theme-loading-title");
    const message = documentRoot.getElementById("theme-loading-message");
    if (!notice || !title || !message) return;

    const generationRunning = isThemeGenerationRunning(progress);
    const generationFailed = progress && Number(progress.stage) < 0;
    const emptyState = documentRoot.querySelector(".code-manager-empty-state");
    const showWaitingView = waiting || (generationRunning && Boolean(emptyState));
    notice.hidden = Boolean(generationFailed || (!generationRunning && !loading && !failed && !waiting));
    notice.dataset.state = failed ? "error" : "loading";
    notice.dataset.view = showWaitingView ? "page" : "banner";

    let titleText = "Loading codes…";
    let messageText = "Checking your saved work and AI generation progress.";
    if (generationRunning) {
        const stageTitles = [
            "Preparing AI generation…",
            "Tagging questions…",
            "Tagging answers…",
            "Generating AI codes…"
        ];
        titleText = stageTitles[Number(progress.stage)];
        messageText = "This can take a little while. New codes will appear automatically when ready.";
    }
    if (failed) {
        titleText = "Could not refresh codes";
        messageText = "Your saved work is unchanged. We’ll try again automatically.";
    }
    // Do not repeatedly announce the same status on every poll.
    if (title.textContent !== titleText) title.textContent = titleText;
    if (message.textContent !== messageText) message.textContent = messageText;

    const spinner = documentRoot.getElementById("theme-loading-spinner");
    if (spinner) spinner.hidden = failed;
    const mainWindow = documentRoot.getElementById("main-edit-window");
    if (mainWindow) {
        mainWindow.hidden = showWaitingView;
        mainWindow.setAttribute("aria-busy", String(showWaitingView && !failed && !generationFailed));
        mainWindow.dataset.generationRunning = String(generationRunning);
    }
    if (emptyState) {
        const emptyMessage = generationRunning
            ? "AI generation is still running. Your codes will appear here automatically when ready."
            : "No codes yet. You can add codes manually or start AI generation.";
        if (emptyState.textContent !== emptyMessage) emptyState.textContent = emptyMessage;
    }
}
