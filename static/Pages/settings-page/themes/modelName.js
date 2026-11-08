let currentModelName = "AI";
let modelNamePromise = null;

export function getCurrentModelName() {
    return currentModelName;
}

export function loadCurrentModelName() {
    if (!modelNamePromise) {
        modelNamePromise = fetch("/api/llm-config", { cache: "no-store" })
            .then(res => (res.ok ? res.json() : null))
            .then(config => {
                const name = String(config?.model || "").trim();
                if (name) currentModelName = name;
                return currentModelName;
            })
            .catch(error => {
                console.warn("Could not load model name:", error);
                return currentModelName;
            });
    }
    return modelNamePromise;
}