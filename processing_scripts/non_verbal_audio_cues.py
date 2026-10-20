import math
from typing import Any

try:
    import numpy as np
except Exception:  # pragma: no cover
    np = None

try:
    from scipy.ndimage import binary_closing, median_filter
except Exception:  # pragma: no cover
    binary_closing = None
    median_filter = None

try:
    from pydub import AudioSegment
except Exception:  # pragma: no cover
    AudioSegment = None


def robust_norm(values, low=10, high=90, eps=1e-9):
    if np is None:
        return []
    arr = np.asarray(values, dtype=np.float32)
    if arr.size == 0:
        return arr
    lo, hi = np.percentile(arr, [low, high])
    if hi - lo < eps:
        return np.zeros_like(arr)
    return np.clip((arr - lo) / (hi - lo), 0.0, 1.0)


def smooth_mask(mask, smooth_size=3, gap_frames=0):
    if np is None:
        return mask
    if mask is None:
        return np.array([], dtype=bool)
    cleaned = np.asarray(mask, dtype=bool)
    if cleaned.size == 0:
        return cleaned

    if smooth_size > 1 and median_filter is not None:
        cleaned = median_filter(cleaned.astype(int), size=smooth_size).astype(bool)
    if gap_frames > 1 and binary_closing is not None:
        cleaned = binary_closing(cleaned, structure=np.ones(gap_frames, dtype=bool))
    return cleaned


def segments_from_mask(mask, times, scores=None, min_duration=0.5):
    segments = []
    if np is None:
        return segments
    m = np.asarray(mask, dtype=bool)
    t = np.asarray(times, dtype=np.float32)
    if m.size == 0 or t.size == 0:
        return segments

    start_idx = None
    for i, active in enumerate(m):
        if active and start_idx is None:
            start_idx = i
            continue
        if (not active) and start_idx is not None:
            end_idx = i
            start_t = float(t[start_idx])
            end_t = float(t[min(end_idx, len(t) - 1)])
            if end_t - start_t >= min_duration:
                conf = None
                if scores is not None:
                    score_slice = np.asarray(scores[start_idx:end_idx], dtype=np.float32)
                    if score_slice.size > 0:
                        conf = float(np.mean(score_slice))
                segments.append((start_t, end_t, conf))
            start_idx = None

    if start_idx is not None:
        end_idx = len(m) - 1
        start_t = float(t[start_idx])
        end_t = float(t[end_idx])
        if end_t - start_t >= min_duration:
            conf = None
            if scores is not None:
                score_slice = np.asarray(scores[start_idx:end_idx + 1], dtype=np.float32)
                if score_slice.size > 0:
                    conf = float(np.mean(score_slice))
            segments.append((start_t, end_t, conf))
    return segments


def summarize_segments(segments, total_duration_sec):
    total = float(sum(max(0.0, end - start) for start, end, _ in segments))
    count = int(len(segments))
    pct = (total / total_duration_sec * 100.0) if total_duration_sec > 0 else 0.0
    per_min = (count / (total_duration_sec / 60.0)) if total_duration_sec > 0 else 0.0
    return {
        "count": count,
        "durationSec": total,
        "percentOfAudio": pct,
        "segmentsPerMinute": per_min,
    }


def segments_to_dict(segments):
    payload = []
    for start, end, confidence in segments:
        item = {"start": float(start), "end": float(end)}
        if confidence is not None:
            item["confidence"] = float(confidence)
        payload.append(item)
    return payload


def _load_audio_mono(audio_path, target_sr=16000):
    if AudioSegment is None:
        raise RuntimeError("Audio processing dependency missing: pydub is not installed.")
    if np is None:
        raise RuntimeError("Audio processing dependency missing: numpy is not installed.")

    segment = AudioSegment.from_file(audio_path)
    if len(segment) == 0:
        raise RuntimeError(f"Audio file is empty: {audio_path}")
    segment = segment.set_channels(1).set_frame_rate(int(target_sr))

    samples = np.array(segment.get_array_of_samples())
    if samples.size == 0:
        raise RuntimeError(f"No samples decoded from: {audio_path}")

    scale = float(1 << max(1, (8 * segment.sample_width) - 1))
    samples = samples.astype(np.float32) / max(scale, 1.0)
    sr = int(segment.frame_rate)
    duration_sec = float(len(segment) / 1000.0)
    return samples, sr, duration_sec


def _frame_signal(samples, frame_length, hop_length):
    if np is None:
        return [], np.array([], dtype=np.float32)
    if len(samples) < frame_length:
        pad = frame_length - len(samples)
        samples = np.pad(samples, (0, pad), mode="constant")

    n_frames = 1 + max(0, (len(samples) - frame_length) // hop_length)
    if n_frames <= 0:
        return np.zeros((0, frame_length), dtype=np.float32), samples

    strides = (samples.strides[0] * hop_length, samples.strides[0])
    frames = np.lib.stride_tricks.as_strided(
        samples,
        shape=(n_frames, frame_length),
        strides=strides,
        writeable=False,
    )
    return frames, samples


def _compute_features(samples, sr, frame_sec=0.05, hop_sec=0.025):
    if np is None:
        raise RuntimeError("Audio processing dependency missing: numpy is not installed.")

    frame_length = max(64, int(sr * frame_sec))
    hop_length = max(32, int(sr * hop_sec))
    frames, samples = _frame_signal(samples, frame_length, hop_length)

    if frames.shape[0] == 0:
        return {
            "times": np.array([], dtype=np.float32),
            "rms": np.array([], dtype=np.float32),
            "rms_db": np.array([], dtype=np.float32),
            "zcr": np.array([], dtype=np.float32),
            "onset_env": np.array([], dtype=np.float32),
            "frame_length": frame_length,
            "hop_length": hop_length,
        }

    rms = np.sqrt(np.mean(np.square(frames), axis=1)).astype(np.float32)
    rms_db = (20.0 * np.log10(np.maximum(rms, 1e-7))).astype(np.float32)

    signs = np.sign(frames)
    zcr = np.mean(np.abs(np.diff(signs, axis=1)) > 0, axis=1).astype(np.float32)

    rms_diff = np.diff(rms, prepend=rms[0])
    onset_env = np.maximum(0.0, rms_diff).astype(np.float32)

    times = (np.arange(frames.shape[0], dtype=np.float32) * float(hop_length) / float(sr)).astype(np.float32)

    return {
        "times": times,
        "rms": rms,
        "rms_db": rms_db,
        "zcr": zcr,
        "onset_env": onset_env,
        "frame_length": frame_length,
        "hop_length": hop_length,
    }


def _detect_laughter(features, sr, hop_length, min_duration=0.35, merge_gap=0.2):
    if np is None:
        return [], np.array([], dtype=np.float32), 0.0

    rms_norm = robust_norm(features["rms_db"])
    zcr_norm = robust_norm(features["zcr"])
    onset_norm = robust_norm(features["onset_env"])

    laugh_score = np.clip((0.45 * rms_norm) + (0.35 * zcr_norm) + (0.20 * onset_norm), 0.0, 1.0)
    if laugh_score.size == 0:
        return [], laugh_score, 0.0

    laugh_thresh = float(np.clip(np.percentile(laugh_score, 90), 0.60, 0.92))
    mask = laugh_score >= laugh_thresh
    gap_frames = max(0, int((merge_gap * sr) / max(1, hop_length)))
    mask = smooth_mask(mask, smooth_size=3, gap_frames=gap_frames)
    segments = segments_from_mask(mask, features["times"], scores=laugh_score, min_duration=min_duration)
    return segments, laugh_score, laugh_thresh


def _detect_long_silence(features, sr, hop_length, min_duration=1.5, merge_gap=0.3):
    if np is None:
        return [], np.array([], dtype=np.float32), 0.0, -100.0

    rms_db = features["rms_db"]
    if rms_db.size == 0:
        return [], np.array([], dtype=np.float32), 0.0, -100.0

    rms_norm = robust_norm(rms_db)
    onset_norm = robust_norm(features["onset_env"])
    silence_score = np.clip((1.0 - rms_norm) * (1.0 - onset_norm), 0.0, 1.0)

    score_thresh = float(np.clip(np.percentile(silence_score, 80), 0.50, 0.92))
    noise_floor = float(np.percentile(rms_db, 12))
    silence_db_thresh = noise_floor + 6.0

    mask = (silence_score >= score_thresh) & (rms_db <= silence_db_thresh)
    gap_frames = max(0, int((merge_gap * sr) / max(1, hop_length)))
    mask = smooth_mask(mask, smooth_size=3, gap_frames=gap_frames)
    segments = segments_from_mask(mask, features["times"], scores=silence_score, min_duration=min_duration)
    return segments, silence_score, score_thresh, silence_db_thresh


def detect_non_verbal_audio_cues(audio_path, config: dict[str, Any] | None = None):
    if np is None:
        raise RuntimeError("Audio processing dependency missing: numpy is not installed.")
    cfg = config or {}
    target_sr = int(cfg.get("target_sr", 16000))
    frame_sec = float(cfg.get("frame_sec", 0.05))
    hop_sec = float(cfg.get("hop_sec", 0.025))
    min_laughter_dur = float(cfg.get("min_laughter_dur", 0.35))
    min_silence_dur = float(cfg.get("min_silence_dur", 1.5))

    samples, sr, duration_sec = _load_audio_mono(audio_path, target_sr=target_sr)
    features = _compute_features(samples, sr, frame_sec=frame_sec, hop_sec=hop_sec)

    laughter_segments, laughter_score, laughter_thresh = _detect_laughter(
        features,
        sr,
        features["hop_length"],
        min_duration=min_laughter_dur,
        merge_gap=0.20,
    )
    silence_segments, silence_score, silence_thresh, silence_db_thresh = _detect_long_silence(
        features,
        sr,
        features["hop_length"],
        min_duration=min_silence_dur,
        merge_gap=0.35,
    )

    laughter_summary = summarize_segments(laughter_segments, duration_sec)
    long_silence_summary = summarize_segments(silence_segments, duration_sec)
    coverage = (
        ((laughter_summary["durationSec"] + long_silence_summary["durationSec"]) / duration_sec) * 100.0
        if duration_sec > 0
        else 0.0
    )

    return {
        "durationSec": float(duration_sec),
        "sampleRate": int(sr),
        "segments": {
            "laughter": segments_to_dict(laughter_segments),
            "long_silence": segments_to_dict(silence_segments),
        },
        "summary": {
            "laughter": laughter_summary,
            "long_silence": long_silence_summary,
            "cueCoveragePercent": float(coverage),
        },
        "thresholds": {
            "laughterScoreThreshold": float(laughter_thresh),
            "silenceScoreThreshold": float(silence_thresh),
            "silenceDbThreshold": float(silence_db_thresh),
        },
    }

