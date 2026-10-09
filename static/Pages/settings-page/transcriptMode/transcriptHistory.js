// History lasts for this page visit. A failed undo stays available for retry.
class TranscriptHistory {
    constructor(onChange) {
        this.entries = [];
        this.pending = 0;
        this.undoing = false;
        this.onChange = onChange;
    }

    state() {
        return {
            pending: this.pending,
            undoing: this.undoing,
            canUndo: this.entries.length > 0 && this.pending === 0,
            label: this.entries.at(-1)?.label || ""
        };
    }

    changed() {
        this.onChange(this.state());
    }

    begin() {
        this.pending += 1;
        this.changed();
    }

    end() {
        this.pending = Math.max(0, this.pending - 1);
        this.changed();
    }

    push(entry) {
        this.entries.push(entry);
        this.changed();
    }

    async undo() {
        if (!this.state().canUndo) return false;
        const entry = this.entries.at(-1);
        this.pending += 1;
        this.undoing = true;
        this.changed();
        try {
            await entry.restore();
            this.entries.pop();
            return true;
        } finally {
            this.pending -= 1;
            this.undoing = false;
            this.changed();
        }
    }
}

export function createTranscriptHistory(onChange = () => {}) {
    return new TranscriptHistory(onChange);
}
