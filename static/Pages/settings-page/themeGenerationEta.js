const STAGE_TIME_RANGES_SECONDS = {
  0: { min: 15, max: 30 },
  1: { min: 75, max: 150 },
  2: { min: 55, max: 110 },
  3: { min: 35, max: 80 },
};

const PROJECT_WORKLOAD_STAGE_SCALE = {
  0: 0,
  1: 0.85,
  2: 0.85,
  3: 0.35,
};

function normalizeWorkloadUnits(rawUnits) {
  const numericUnits = Number(rawUnits);
  if (!Number.isFinite(numericUnits)) {
    return 1;
  }
  return Math.max(1, Math.round(numericUnits));
}

function getStageRange(stage, options = {}) {
  const range = STAGE_TIME_RANGES_SECONDS[stage];
  if (!range) {
    return { min: 0, max: 0 };
  }

  const workloadUnits = normalizeWorkloadUnits(options.workloadUnits);
  if (workloadUnits <= 1) {
    return range;
  }

  const stageScale = Number.isFinite(Number(options.stageScaleByStage?.[stage]))
    ? Number(options.stageScaleByStage[stage])
    : PROJECT_WORKLOAD_STAGE_SCALE[stage] || 0;
  const scaleFactor = 1 + ((workloadUnits - 1) * stageScale);

  return {
    min: Math.max(0, Math.round(range.min * scaleFactor)),
    max: Math.max(0, Math.round(range.max * scaleFactor)),
  };
}

function getRemainingStageRange(stage, elapsedSeconds, options = {}) {
  const range = getStageRange(stage, options);
  if (!range) {
    return { min: 0, max: 0 };
  }

  const minRemaining = Math.max(0, range.min - elapsedSeconds);
  let maxRemaining = Math.max(0, range.max - (elapsedSeconds * 0.75));

  if (stage > 0 && elapsedSeconds > range.max) {
    maxRemaining = 45;
  }

  return {
    min: Math.max(0, Math.round(minRemaining)),
    max: Math.max(Math.round(minRemaining), Math.round(maxRemaining)),
  };
}

function getFutureStagesRange(stage, options = {}) {
  let min = 0;
  let max = 0;
  for (let nextStage = Math.max(1, stage + 1); nextStage <= 3; nextStage += 1) {
    const range = getStageRange(nextStage, options);
    if (!range) continue;
    min += range.min;
    max += range.max;
  }
  return { min, max };
}

function formatSeconds(seconds) {
  const safeSeconds = Math.max(0, Math.round(Number(seconds) || 0));
  if (safeSeconds <= 30) {
    return "under 30 sec";
  }
  if (safeSeconds < 90) {
    return "about 1 min";
  }

  const minutes = Math.ceil(safeSeconds / 60);
  return `${minutes} min`;
}

function formatEtaRange(minSeconds, maxSeconds) {
  if (maxSeconds <= 0) {
    return "finishing up";
  }
  if (maxSeconds <= 30) {
    return "under 30 sec";
  }

  const minMinutes = Math.ceil(Math.max(0, minSeconds) / 60);
  const maxMinutes = Math.ceil(Math.max(0, maxSeconds) / 60);
  if (minMinutes >= 2 && maxMinutes >= 2 && minMinutes !== maxMinutes) {
    return `${minMinutes}-${maxMinutes} min`;
  }

  const minLabel = formatSeconds(minSeconds);
  const maxLabel = formatSeconds(maxSeconds);
  if (minLabel === maxLabel) {
    return minLabel;
  }

  return `${minLabel} - ${maxLabel}`;
}

export function createThemeGenerationEtaController(labelId = "generation-stage-eta", options = {}) {
  let timerId = null;
  let startedAtMs = null;
  let currentStage = 0;
  let currentStageStartedAtMs = null;
  let runtimeOptions = {
    labelPrefix: String(options.labelPrefix || "Estimated remaining time").trim() || "Estimated remaining time",
    workloadUnits: normalizeWorkloadUnits(options.workloadUnits),
    stageScaleByStage: options.stageScaleByStage || PROJECT_WORKLOAD_STAGE_SCALE,
  };

  function getLabelNode() {
    return document.getElementById(labelId);
  }

  function setLabel(text, color = "#6b7280") {
    const node = getLabelNode();
    if (!node) return;
    node.textContent = text;
    node.style.color = color;
  }

  function computeRange(nowMs = Date.now()) {
    if (startedAtMs === null) {
      return null;
    }

    if (currentStage <= 0) {
      const totalRange = getFutureStagesRange(0, runtimeOptions);
      return totalRange;
    }

    const elapsedSeconds = Math.max(0, (nowMs - (currentStageStartedAtMs || startedAtMs)) / 1000);
    const currentRange = getRemainingStageRange(currentStage, elapsedSeconds, runtimeOptions);
    const futureRange = getFutureStagesRange(currentStage, runtimeOptions);

    return {
      min: currentRange.min + futureRange.min,
      max: currentRange.max + futureRange.max,
    };
  }

  function render() {
    const range = computeRange();
    if (!range) {
      setLabel(`${runtimeOptions.labelPrefix}: calculating...`);
      return;
    }
    setLabel(`${runtimeOptions.labelPrefix}: ${formatEtaRange(range.min, range.max)}`);
  }

  function ensureTicker() {
    if (timerId) return;
    timerId = window.setInterval(render, 1000);
  }

  function stop() {
    if (timerId) {
      window.clearInterval(timerId);
      timerId = null;
    }
  }

  function reset(initialText = `${runtimeOptions.labelPrefix}: calculating...`, nextOptions = {}) {
    stop();
    startedAtMs = null;
    currentStage = 0;
    currentStageStartedAtMs = null;
    runtimeOptions = {
      ...runtimeOptions,
      ...nextOptions,
      labelPrefix: String(nextOptions.labelPrefix || runtimeOptions.labelPrefix || "Estimated remaining time").trim() || "Estimated remaining time",
      workloadUnits: normalizeWorkloadUnits(nextOptions.workloadUnits ?? runtimeOptions.workloadUnits),
      stageScaleByStage: nextOptions.stageScaleByStage || runtimeOptions.stageScaleByStage || PROJECT_WORKLOAD_STAGE_SCALE,
    };
    setLabel(initialText);
  }

  function markStarted() {
    const nowMs = Date.now();
    startedAtMs = nowMs;
    currentStage = 0;
    currentStageStartedAtMs = nowMs;
    render();
    ensureTicker();
  }

  function update(progress) {
    const stage = Number(progress && progress.stage);
    if (!Number.isFinite(stage)) {
      render();
      return;
    }

    if (stage === -1) {
      setLabel(`${runtimeOptions.labelPrefix}: unavailable`, "#b91c1c");
      stop();
      return;
    }

    if (stage >= 4) {
      setLabel(`${runtimeOptions.labelPrefix}: complete`, "#166534");
      stop();
      return;
    }

    const nowMs = Date.now();
    if (startedAtMs === null) {
      startedAtMs = nowMs;
    }

    if (stage !== currentStage) {
      currentStage = stage;
      currentStageStartedAtMs = nowMs;
    } else if (currentStageStartedAtMs === null) {
      currentStageStartedAtMs = nowMs;
    }

    render();
    ensureTicker();
  }

  return {
    markStarted,
    reset,
    stop,
    setLabel,
    update,
  };
}
