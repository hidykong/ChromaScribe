import ast
import difflib
import json
import math
import os
import random
import re
import time

import openai
from config import load_local_environment, settings
from processing_scripts.transcriptIdentity import participant_id_for_entry
from processing_scripts.llm_config import resolve_llm_config, llm_endpoint_ready

LLM_PIPELINE_BASELINE_COMMIT = "1a0ac588af0341d7260f8d28a35bb0dba3486f4e"
QUESTION_TAGGING_CONFIDENCE_THRESHOLD = float(os.environ.get("CHROMA_QUESTION_TAG_CONFIDENCE_THRESHOLD", "0.20"))
QUESTION_SIMILARITY_FALLBACK_THRESHOLD = float(os.environ.get("CHROMA_QUESTION_SIMILARITY_THRESHOLD", "0.64"))
QUESTION_SIMILARITY_FALLBACK_THRESHOLD_NO_LLM = float(os.environ.get("CHROMA_QUESTION_SIMILARITY_THRESHOLD_NO_LLM", "0.68"))


class QwenQnA():
    def __init__(self, processed_dir=None, uploaded_dir=None, intermediate_dir=None):
        self.APP_ROOT = os.path.dirname(os.path.abspath(__file__))
        self.PROJECT_ROOT = os.path.abspath(os.path.join(self.APP_ROOT, os.pardir))
        self.DOTENV_PATH = os.path.join(self.PROJECT_ROOT, ".env")
        self._load_runtime_env()
        self.STATIC_DIR = str(settings.data_dir / "static")
        self.DEFAULT_PROCESSED_DIR = os.path.join(self.STATIC_DIR, "Processed_files")
        self.DEFAULT_UPLOADED_DIR = os.path.join(self.STATIC_DIR, "Uploaded_files")
        self.DEFAULT_INTERMEDIATE_DIR = str(settings.data_dir / "intermediate_files")
        self._processed_dir_override = processed_dir
        self._uploaded_dir_override = uploaded_dir
        self._intermediate_dir_override = intermediate_dir
        self.PROCESSED_DIR = self.DEFAULT_PROCESSED_DIR
        self.UPLOADED_DIR = self.DEFAULT_UPLOADED_DIR
        self.INTERMEDIATE_DIR = self.DEFAULT_INTERMEDIATE_DIR
        self.DEMO_ASSETS_DIR = os.path.join(self.STATIC_DIR, "Demo_project")
        self.QUESTIONS_JSON_PATH = os.path.join(self.PROCESSED_DIR, "questions.json")
        self.QUESTIONS_TXT_PATH = os.path.join(self.UPLOADED_DIR, "Questions", "questions.txt")
        self.TRANSCRIPTS_JSON_PATH = os.path.join(self.PROCESSED_DIR, "all_transcripts_processed.json")
        self.POSSIBLE_QUESTION_SCRIPT_PATH = os.path.join(self.INTERMEDIATE_DIR, "possible_questions_script.txt")
        self.POSSIBLE_ANSWER_SCRIPT_PATH = os.path.join(self.INTERMEDIATE_DIR, "possible_answers_script.json")
        self.ANSWER_TAGS_PATH = os.path.join(self.INTERMEDIATE_DIR, "answers_tagged.json")
        self.QUESTION_TAGS_PATH = os.path.join(self.INTERMEDIATE_DIR, "questions_tagged.json")
        self.TAG_CONFLICTS_PATH = os.path.join(self.PROCESSED_DIR, "TagConflicts.json")
        self.LEGACY_POSSIBLE_QUESTION_SCRIPT_PATH = os.path.join(self.APP_ROOT, "possibleQuestionScript.txt")
        self.LEGACY_POSSIBLE_ANSWER_SCRIPT_PATH = os.path.join(self.PROJECT_ROOT, "possibleAnswerScript.json")
        self.LEGACY_ANSWER_TAGS_PATH = os.path.join(self.PROJECT_ROOT, "answersTag.json")
        self.LEGACY_QUESTION_TAGS_PATH = os.path.join(self.APP_ROOT, "questionsTag.json")
        self.DRY_RUN = False
        self.LLM_USAGE_TOTAL = {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
        }
        self.LLM_PROVIDER, self.LM_BASE_URL, self.LM_MODEL, self.LM_API_KEY = self._resolve_llm_runtime_config()
        self.client = self._build_openai_client()
        print(
            f"[LLM] QnA provider={self.LLM_PROVIDER} model={self.LM_MODEL} "
            f"base_url={self.LM_BASE_URL} baseline={LLM_PIPELINE_BASELINE_COMMIT}"
        )

    def _load_runtime_env(self):
        load_local_environment()

    def _build_openai_client(self):
        return openai.OpenAI(
            base_url=self.LM_BASE_URL,
            api_key=self.LM_API_KEY or "missing",
        )

    def _refresh_llm_runtime_config(self):
        # Re-read .env before each pipeline run so delayed env injection is picked up.
        self._load_runtime_env()
        self.LLM_PROVIDER, self.LM_BASE_URL, self.LM_MODEL, self.LM_API_KEY = self._resolve_llm_runtime_config()
        self.client = self._build_openai_client()

    def _normalize_base_url_v1(self, raw_url: str | None, default_url: str) -> str:
        url = (raw_url or default_url).strip().rstrip("/")
        if url.endswith("/v1"):
            return url
        return f"{url}/v1"

    def _resolve_llm_runtime_config(self):
        return resolve_llm_config()
    
    def _llm_should_retry(self, err: Exception) -> bool:
        status = getattr(err, "status_code", None)
        if status in (429, 500, 502, 503, 504):
            return True
        if self._llm_is_rate_limit_error(err):
            return True
        return False

    def _llm_is_rate_limit_error(self, err: Exception) -> bool:
        status = getattr(err, "status_code", None)
        if status == 429:
            return True
        msg = str(err).lower()
        return "429" in msg or "too many requests" in msg or "rate limit" in msg

    def _llm_error_summary(self, err: Exception) -> str:
        parts = [f"type={type(err).__name__}"]
        status = getattr(err, "status_code", None)
        if status is not None:
            parts.append(f"status={status}")
        code = getattr(err, "code", None)
        if code:
            parts.append(f"code={code}")

        response = getattr(err, "response", None)
        headers = getattr(response, "headers", None) if response is not None else None
        if headers:
            retry_after = headers.get("retry-after") or headers.get("Retry-After")
            if retry_after:
                parts.append(f"retry_after={retry_after}")
            request_id = headers.get("x-request-id") or headers.get("X-Request-ID")
            if request_id:
                parts.append(f"request_id={request_id}")

        message = re.sub(r"\s+", " ", str(err or "")).strip()
        if self.LM_API_KEY and self.LM_API_KEY != "missing":
            message = message.replace(self.LM_API_KEY, "<redacted>")
        message = re.sub(r"sk-[A-Za-z0-9_-]+", "sk-<redacted>", message)
        if len(message) > 300:
            message = f"{message[:297]}..."
        if message:
            parts.append(f"message={message}")
        return "; ".join(parts)

    def _llm_retry_delay_seconds(self, err: Exception, attempt: int) -> float:
        """
        Exponential backoff with jitter. If the gateway provides Retry-After, honor it.
        attempt is 1-based.
        """
        response = getattr(err, "response", None)
        if response is not None:
            headers = getattr(response, "headers", None)
            if headers:
                retry_after = headers.get("retry-after") or headers.get("Retry-After")
                try:
                    retry_after = float(retry_after)
                    if retry_after > 0:
                        return min(60.0, retry_after)
                except Exception:
                    pass
        base = min(60.0, 1.0 * (2 ** (attempt - 1)))
        return base * (0.6 + random.random() * 0.8)

    def _chat_with_retry(self, *, messages, context: str = "LLM request", max_attempts: int = 6):
        for attempt in range(1, max_attempts + 1):
            try:
                response = self.client.chat.completions.create(
                    model=self.LM_MODEL,
                    messages=messages,
                )
                self._log_llm_usage(response, context)
                return response
            except Exception as e:
                if (attempt >= max_attempts) or (not self._llm_should_retry(e)):
                    raise
                delay = self._llm_retry_delay_seconds(e, attempt)
                error_kind = "rate limit" if self._llm_is_rate_limit_error(e) else "temporary"
                print(f"[WARN] {context} {error_kind} error ({self._llm_error_summary(e)}; attempt {attempt}/{max_attempts}). Retrying in {delay:.1f}s...")
                time.sleep(delay)

    def _usage_tokens(self, usage_obj, field_name: str) -> int:
        if usage_obj is None:
            return 0
        value = getattr(usage_obj, field_name, None)
        if value is None and isinstance(usage_obj, dict):
            value = usage_obj.get(field_name, 0)
        try:
            return int(value or 0)
        except Exception:
            return 0

    def _log_llm_usage(self, response, context: str):
        usage_obj = getattr(response, "usage", None)
        prompt_tokens = self._usage_tokens(usage_obj, "prompt_tokens")
        completion_tokens = self._usage_tokens(usage_obj, "completion_tokens")
        total_tokens = self._usage_tokens(usage_obj, "total_tokens")
        if total_tokens <= 0 and (prompt_tokens > 0 or completion_tokens > 0):
            total_tokens = prompt_tokens + completion_tokens
        self.LLM_USAGE_TOTAL["prompt_tokens"] += prompt_tokens
        self.LLM_USAGE_TOTAL["completion_tokens"] += completion_tokens
        self.LLM_USAGE_TOTAL["total_tokens"] += total_tokens
        print(
            f"[LLM Usage] {context}: "
            f"prompt={prompt_tokens}, completion={completion_tokens}, total={total_tokens} | "
            f"running_total={self.LLM_USAGE_TOTAL['total_tokens']}"
        )

    def _sync_paths(self):
        processed_dir = self._processed_dir_override or os.environ.get("CHROMA_PROCESSED_DIR") or self.DEFAULT_PROCESSED_DIR
        uploaded_dir = self._uploaded_dir_override or os.environ.get("CHROMA_UPLOADED_DIR") or self.DEFAULT_UPLOADED_DIR
        intermediate_dir = self._intermediate_dir_override or os.environ.get("CHROMA_INTERMEDIATE_DIR") or self.DEFAULT_INTERMEDIATE_DIR
        self.PROCESSED_DIR = processed_dir
        self.UPLOADED_DIR = uploaded_dir
        self.INTERMEDIATE_DIR = intermediate_dir
        self.QUESTIONS_JSON_PATH = os.path.join(self.PROCESSED_DIR, "questions.json")
        self.QUESTIONS_TXT_PATH = os.path.join(self.UPLOADED_DIR, "Questions", "questions.txt")
        self.TRANSCRIPTS_JSON_PATH = os.path.join(self.PROCESSED_DIR, "all_transcripts_processed.json")
        self.POSSIBLE_QUESTION_SCRIPT_PATH = os.path.join(self.INTERMEDIATE_DIR, "possible_questions_script.txt")
        self.POSSIBLE_ANSWER_SCRIPT_PATH = os.path.join(self.INTERMEDIATE_DIR, "possible_answers_script.json")
        self.ANSWER_TAGS_PATH = os.path.join(self.INTERMEDIATE_DIR, "answers_tagged.json")
        self.QUESTION_TAGS_PATH = os.path.join(self.INTERMEDIATE_DIR, "questions_tagged.json")
        self.TAG_CONFLICTS_PATH = os.path.join(self.PROCESSED_DIR, "TagConflicts.json")

    def _first_existing_path(self, primary_path: str, legacy_path: str) -> str:
        if os.path.exists(primary_path):
            return primary_path
        return legacy_path if os.path.exists(legacy_path) else primary_path

    def _normalize_qna_tag(self, raw_tag) -> str:
        value = str(raw_tag or "").strip()
        if not value or value.lower() in {"none", "null", "undefined"}:
            return ""
        match = re.match(r"^([QA])\s*0*(\d+)([A-Za-z]?)$", value, flags=re.IGNORECASE)
        if not match:
            return ""
        return f"{match.group(1).upper()}{int(match.group(2))}{match.group(3).lower()}"

    def _manual_tag_state(self, entry: dict | None) -> tuple[bool, str]:
        if not isinstance(entry, dict):
            return False, ""
        source = str(entry.get("tagSource") or "").strip().lower()
        has_manual_tag = source in {"manual", "human"} or "manualTag" in entry
        manual_tag = self._normalize_qna_tag(entry.get("manualTag") if "manualTag" in entry else entry.get("tag"))
        return has_manual_tag, manual_tag

    def _qna_resolution_matches(self, entry: dict | None, manual_tag: str, ai_tag: str) -> bool:
        if not isinstance(entry, dict):
            return False
        resolution = str(entry.get("tagConflictResolution") or "").strip().lower()
        if resolution not in {"keep_manual", "keep_both", "dismiss"}:
            return False
        resolved_manual = self._normalize_qna_tag(entry.get("tagConflictResolvedManualTag"))
        resolved_ai = self._normalize_qna_tag(entry.get("tagConflictResolvedAiTag"))
        explicit_empty_choice = entry.get("tagConflictResolvedManualTag") == "None"
        if not resolved_ai or (not resolved_manual and not explicit_empty_choice):
            return False
        return resolved_manual == manual_tag and resolved_ai == ai_tag

    def _build_tag_conflict_record(self, file_name: str, content: dict | None, entry: dict, transcript_index: int, tag_family: str, manual_tag: str, ai_tag: str) -> dict:
        participant = participant_id_for_entry(file_name, content, entry)
        timestamp = str(entry.get("timestamp") or "").strip()
        conflict_id = "||".join([
            str(file_name or "").strip(),
            participant,
            str(entry.get("segmentId") or timestamp),
            tag_family,
            str(transcript_index),
        ])
        return {
            "id": conflict_id,
            "type": "qa_tag_mismatch",
            "tagFamily": tag_family,
            "fileKey": file_name,
            "participant": participant,
            "timestamp": timestamp,
            "segmentId": entry.get("segmentId"),
            "transcriptIndex": transcript_index,
            "speaker": str(entry.get("speaker") or "").strip(),
            "cueText": str(entry.get("script") or "").strip(),
            "manualTag": manual_tag or "None",
            "aiSuggestedTag": ai_tag,
            "activeTag": manual_tag or "None",
            "status": "open",
        }

    def _apply_ai_qna_tag(self, entry: dict, ai_tag, *, file_name: str, content: dict | None, transcript_index: int, tag_family: str, conflicts: list, detect_conflict: bool = True):
        normalized_ai_tag = self._normalize_qna_tag(ai_tag)
        has_manual_tag, manual_tag = self._manual_tag_state(entry)

        if has_manual_tag:
            entry["tag"] = manual_tag or "None"
            entry["manualTag"] = manual_tag or "None"
            entry["tagSource"] = "manual"
            if normalized_ai_tag:
                entry["aiSuggestedTag"] = normalized_ai_tag
            if (
                detect_conflict
                and normalized_ai_tag
                and normalized_ai_tag != manual_tag
                and not self._qna_resolution_matches(entry, manual_tag, normalized_ai_tag)
            ):
                entry["tagConflict"] = True
                entry["tagConflictType"] = "qa_tag_mismatch"
                conflicts.append(
                    self._build_tag_conflict_record(
                        file_name,
                        content,
                        entry,
                        transcript_index,
                        tag_family,
                        manual_tag,
                        normalized_ai_tag,
                    )
                )
            else:
                entry.pop("tagConflict", None)
                entry.pop("tagConflictType", None)
            return

        entry["tag"] = normalized_ai_tag or "None"
        entry["tagSource"] = "ai"
        if normalized_ai_tag:
            entry["aiSuggestedTag"] = normalized_ai_tag
        else:
            entry.pop("aiSuggestedTag", None)
        entry.pop("tagConflict", None)
        entry.pop("tagConflictType", None)

    def _write_tag_conflicts(self, new_conflicts: list[dict], tag_family: str):
        existing_conflicts = []
        if os.path.exists(self.TAG_CONFLICTS_PATH):
            try:
                with open(self.TAG_CONFLICTS_PATH, "r", encoding="utf-8") as f:
                    payload = json.load(f)
                existing_conflicts = payload.get("conflicts", []) if isinstance(payload, dict) else []
            except Exception as exc:
                print(f"[WARN] Could not read tag conflicts at {self.TAG_CONFLICTS_PATH}: {exc}")

        merged_conflicts = [
            conflict for conflict in existing_conflicts
            if isinstance(conflict, dict) and conflict.get("tagFamily") != tag_family
        ]
        merged_conflicts.extend(new_conflicts)
        payload = {
            "conflicts": merged_conflicts,
            "summary": {
                "openCount": len(merged_conflicts),
                "questionCount": sum(1 for item in merged_conflicts if item.get("tagFamily") == "question"),
                "answerCount": sum(1 for item in merged_conflicts if item.get("tagFamily") == "answer"),
            },
            "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        os.makedirs(os.path.dirname(self.TAG_CONFLICTS_PATH), exist_ok=True)
        with open(self.TAG_CONFLICTS_PATH, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2, ensure_ascii=False)

    def chunk_list(self, lst, chunk_size):
        for i in range(0, len(lst), chunk_size):
            yield lst[i:i + chunk_size], i

    def _normalize_question_text(self, text: str) -> str:
        """Strip numbering/whitespace so comparisons to interviewer lines are consistent."""
        return self._parse_question_line(text, 1)[1]

    def _parse_question_line(self, text: str, fallback_index: int) -> tuple[str, str]:
        raw_text = str(text or "").strip()
        fallback_label = str(max(1, int(fallback_index or 1)))
        if not raw_text:
            return fallback_label, ""

        match = re.match(
            r"^\s*(?:[Qq]\s*)?0*(\d+[A-Za-z]?)\s*[\.\):\-]\s*(.+?)\s*$",
            raw_text,
        )
        if not match:
            return fallback_label, raw_text

        raw_label = match.group(1)
        label_match = re.match(r"^0*(\d+)([A-Za-z]?)$", raw_label)
        if not label_match:
            return fallback_label, match.group(2).strip()
        label = f"{int(label_match.group(1))}{label_match.group(2).lower()}"
        return label, match.group(2).strip()

    def _question_sort_key(self, tag_or_label: str):
        text = str(tag_or_label or "").strip()
        match = re.match(r"^[QAqa]?\s*0*(\d+)([A-Za-z]?)$", text)
        if not match:
            return (math.inf, text.lower())
        suffix = match.group(2).lower()
        suffix_rank = 0 if not suffix else (ord(suffix) - ord("a") + 1)
        return (int(match.group(1)), suffix_rank)

    def _question_tag_for_position(self, position: int) -> str:
        labels = getattr(self, "_last_question_labels", []) or []
        if 1 <= int(position) <= len(labels):
            return f"Q{labels[int(position) - 1]}"
        return f"Q{int(position)}"

    def _question_position_for_model_value(self, raw_value, questions) -> int:
        raw_text = str(raw_value or "").strip()
        label_prefix = bool(re.match(r"^Q(?:uestion)?(?:\s+|(?=\d))", raw_text, flags=re.IGNORECASE))
        match = re.match(r"^\s*(?:Q(?:uestion)?\s*)?0*(\d+)([A-Za-z]?)\s*$", raw_text, flags=re.IGNORECASE)
        if not match:
            return 0

        number = int(match.group(1))
        suffix = match.group(2).lower()
        if number == 0:
            return 0
        if suffix or label_prefix:
            target_label = f"{number}{suffix}"
            labels = getattr(self, "_last_question_labels", []) or []
            for index, label in enumerate(labels):
                if str(label).lower() == target_label:
                    return index + 1
            if suffix:
                return 0
        return number if 1 <= number <= len(questions) else 0

    def _question_prompt_lines(self, questions) -> str:
        lines = []
        for index, question in enumerate(questions):
            lines.append(f"{index + 1} ({self._question_tag_for_position(index + 1)}). {question}")
        return "\n".join(lines)

    def _normalize_interviewer_line(self, line: str) -> str:
        """Remove quotes/commas we stored previously and collapse whitespace."""
        cleaned = line.strip().strip(",")
        if len(cleaned) >= 2 and cleaned[0] == '"' and cleaned[-1] == '"':
            cleaned = cleaned[1:-1]
        return cleaned.strip()

    def _load_questions(self):
        self._sync_paths()
        """
        Load questions from the uploaded questions.txt (primary source) or the
        processed JSON fallback so LM Studio always works from the latest
        user-provided files.
        """
        questions = []

        if os.path.exists(self.QUESTIONS_JSON_PATH):
            try:
                with open(self.QUESTIONS_JSON_PATH, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    questions = data.get("questions", [])
            except Exception as e:
                print(f"[Error] Unable to read questions JSON at {self.QUESTIONS_JSON_PATH}: {e}")
        elif os.path.exists(self.QUESTIONS_TXT_PATH):
            try:
                with open(self.QUESTIONS_TXT_PATH, "r", encoding="utf-8") as f:
                    questions = [line.strip() for line in f if line.strip()]
                print(f"[WARN] Falling back to questions.txt at {self.QUESTIONS_TXT_PATH}")
            except Exception as e:
                print(f"[Error] Unable to read uploaded questions.txt at {self.QUESTIONS_TXT_PATH}: {e}")

        parsed_questions = [
            self._parse_question_line(q, index + 1)
            for index, q in enumerate(questions)
            if str(q).strip()
        ]
        parsed_questions = [
            (label, question_text)
            for label, question_text in parsed_questions
            if question_text.strip()
        ]
        self._last_question_labels = [label for label, _ in parsed_questions]
        questions = [question_text for _, question_text in parsed_questions]

        if not questions:
            raise RuntimeError(
                f"No questions found. Expected {self.QUESTIONS_JSON_PATH} to exist."
            )

        return questions

    def _lm_studio_ready(self) -> bool:
        """Check that the configured LLM endpoint responds before we start tagging."""
        if self.DRY_RUN:
            return True
        self._refresh_llm_runtime_config()
        if self.LM_API_KEY == "missing":
            print(f"[Error] Missing LLM_API_KEY (or RIT_GENAI_API_KEY) in env or {self.DOTENV_PATH}.")
            return False
        ok, err = llm_endpoint_ready(self.client)
        if not ok:
            print(
                f"[Error] LLM endpoint is not reachable (provider={self.LLM_PROVIDER}, "
                f"model={self.LM_MODEL}, base_url={self.LM_BASE_URL}): {err}"
            )
        return ok

    def _question_similarity_score(self, line_text: str, question_text: str) -> float:
        line = re.sub(r"\s+", " ", str(line_text or "").lower()).strip()
        question = re.sub(r"\s+", " ", str(question_text or "").lower()).strip()
        if not line or not question:
            return 0.0

        sequence_score = difflib.SequenceMatcher(None, line, question).ratio()
        line_tokens = set(re.findall(r"[a-z0-9']+", line))
        question_tokens = set(re.findall(r"[a-z0-9']+", question))
        if not line_tokens or not question_tokens:
            return sequence_score

        overlap = len(line_tokens & question_tokens) / math.sqrt(len(line_tokens) * len(question_tokens))
        coverage = len(line_tokens & question_tokens) / max(1, min(len(line_tokens), len(question_tokens)))
        return max(sequence_score, (0.55 * sequence_score) + (0.30 * overlap) + (0.15 * coverage))

    def _coerce_model_confidence(self, raw_value) -> float | None:
        if raw_value is None:
            return None
        try:
            confidence = float(str(raw_value).strip().rstrip("%"))
        except Exception:
            return None
        if confidence > 1 and confidence <= 100:
            confidence /= 100
        return max(0.0, min(1.0, confidence))

    def _question_tag_confidence_for_line(self, line_text: str, questions, tag: int, model_confidence=None) -> float:
        if not (0 < int(tag) <= len(questions)):
            return 0.0
        similarity_confidence = self._question_similarity_score(line_text, questions[int(tag) - 1])
        coerced_model_confidence = self._coerce_model_confidence(model_confidence)
        if coerced_model_confidence is None:
            return similarity_confidence
        return min(coerced_model_confidence, similarity_confidence)

    def _fallback_tag_for_line(self, line_text: str, questions, threshold: float = 0.30):
        """
        When the LLM returns 0 (no match), fall back to similarity only when
        the interviewer line is close enough to an uploaded question.
        """
        best_idx = None
        best_score = 0.0
        for idx, question in enumerate(questions):
            score = self._question_similarity_score(line_text, question)
            if score > best_score:
                best_score = score
                best_idx = idx
        if best_idx is not None and best_score >= threshold:
            return best_idx + 1  # Convert to 1-based Q#
        return None

    def _participant_id_from_record(self, file_name: str, content: dict | None) -> str:
        return participant_id_for_entry(file_name, content)

    def _answer_tag_for_question_tag(self, qtag: str) -> str:
        match = re.match(r"^Q\s*0*(\d+)([A-Za-z]?)$", str(qtag or "").strip(), flags=re.IGNORECASE)
        return f"A{int(match.group(1))}{match.group(2).lower()}" if match else ""

    def _all_possible_answer_lines(self, qinfo: dict | None) -> list[int]:
        if not isinstance(qinfo, dict):
            return []
        line_numbers = set()
        for line_num in (qinfo.get("possibleAnswers") or {}).keys():
            try:
                line_numbers.add(int(line_num))
            except Exception:
                continue
        return sorted(line_numbers)

    def _is_interviewer_speaker(self, speaker: str | None) -> bool:
        normalized = str(speaker or "").strip().lower()
        normalized = re.sub(r"\s*[\(\[].*?[\)\]]\s*", " ", normalized)
        normalized = re.sub(r"\s+", " ", normalized).strip()
        if not normalized:
            return False
        return (
            normalized.startswith("interviewer")
            or "moderator" in normalized
            or "facilitator" in normalized
            or "researcher" in normalized
            or re.fullmatch(r"(q|question)\s*\d*", normalized)
            or normalized == "s1"
            or normalized == "speaker 1"
            or normalized == "spk1"
            or normalized == "ai"
        )

    def _infer_interviewer_speaker_set(self, transcript: list | None) -> set[str]:
        if not isinstance(transcript, list):
            return set()

        strong_known = set()
        weak_known = set()
        stats = {}
        first_speaker = ""
        for index, entry in enumerate(transcript):
            speaker = str((entry or {}).get("speaker", "")).strip()
            role = str((entry or {}).get("speakerRole") or "").lower()
            if role == "interviewer" and speaker:
                strong_known.add(speaker)
            # Unknown means a speaker has not been assigned a role. Inferring a
            # role for that entire group would turn all unlabelled speech into questions.
            if role in {"participant", "unknown"}:
                continue
            if not speaker:
                continue
            if not first_speaker:
                first_speaker = speaker
            normalized_speaker = speaker.lower()
            normalized_speaker = re.sub(r"\s*[\(\[].*?[\)\]]\s*", " ", normalized_speaker)
            normalized_speaker = re.sub(r"\s+", " ", normalized_speaker).strip()
            if (
                normalized_speaker.startswith("interviewer")
                or "moderator" in normalized_speaker
                or "facilitator" in normalized_speaker
                or "researcher" in normalized_speaker
                or re.fullmatch(r"(q|question)\s*\d*", normalized_speaker)
                or normalized_speaker == "ai"
            ):
                strong_known.add(speaker)
            elif normalized_speaker in {"s1", "speaker 1", "spk1"}:
                weak_known.add(speaker)
            speaker_stats = stats.setdefault(speaker, {"total": 0, "questions": 0, "firstIndex": index})
            speaker_stats["total"] += 1
            if "?" in str((entry or {}).get("script", "")):
                speaker_stats["questions"] += 1

        if strong_known:
            return strong_known
        if not stats:
            return set()

        candidates = sorted(
            stats.items(),
            key=lambda item: (
                item[1]["questions"],
                item[1]["questions"] / max(1, item[1]["total"]),
                -item[1]["firstIndex"],
            ),
            reverse=True,
        )
        best_speaker, best_stats = candidates[0]
        best_ratio = best_stats["questions"] / max(1, best_stats["total"])
        if best_stats["questions"] >= 2 or (
            best_speaker == first_speaker
            and best_stats["questions"] >= 1
            and best_ratio >= 0.30
        ):
            return {best_speaker}
        if weak_known:
            return weak_known
        return set()

    def _entry_is_interviewer(self, entry: dict | None, interviewer_speakers: set[str] | None = None) -> bool:
        role = str((entry or {}).get("speakerRole") or "").lower()
        if role in {"interviewer", "participant", "unknown"}:
            return role == "interviewer"
        speaker = str((entry or {}).get("speaker", "")).strip()
        if interviewer_speakers:
            return speaker in interviewer_speakers
        return self._is_interviewer_speaker(speaker)

    def _entry_is_question_candidate(self, entry: dict | None, interviewer_speakers: set[str] | None = None) -> bool:
        # Unknown speakers can still ask a question from the guide. Matching uses
        # the existing confidence checks and does not assign them a speaker role.
        if (entry or {}).get("speakerRole") == "unknown":
            return bool(str((entry or {}).get("script") or "").strip())
        return self._entry_is_interviewer(entry, interviewer_speakers)

    def _entry_is_participant(self, entry: dict | None, interviewer_speakers: set[str] | None = None) -> bool:
        if (entry or {}).get("speakerRole") == "unknown":
            return not str((entry or {}).get("tag") or "").startswith("Q")
        speaker = str((entry or {}).get("speaker", "")).strip()
        if not speaker:
            return False
        return not self._entry_is_interviewer(entry, interviewer_speakers)

    def _is_participant_speaker(self, speaker: str | None) -> bool:
        normalized = str(speaker or "").strip().lower()
        if not normalized:
            return False
        return not self._is_interviewer_speaker(normalized)

    def _map_answer_key_for_batch(self, raw_key: str, batch_qtags: list[str]) -> str | None:
        match = re.match(r"^A\s*0*(\d+)([A-Za-z]?)$", str(raw_key or "").strip(), flags=re.IGNORECASE)
        if not match:
            return None

        normalized_key = f"A{int(match.group(1))}{match.group(2).lower()}"
        expected_keys = {
            self._answer_tag_for_question_tag(qtag)
            for qtag in batch_qtags
            if self._answer_tag_for_question_tag(qtag)
        }
        if normalized_key in expected_keys:
            return normalized_key

        # Some models answer local to the current batch (A1, A2, ...) even when
        # the prompt asks for the absolute A tag. Map those local labels back to
        # the corresponding Q tag in this batch so later batches do not overwrite
        # A1/A2 from earlier questions.
        if not match.group(2):
            local_index = int(match.group(1)) - 1
        else:
            local_index = -1
        if 0 <= local_index < len(batch_qtags):
            return self._answer_tag_for_question_tag(batch_qtags[local_index])
        return None

    def _ensure_all_participant_answers_for_batch(self, final_answer_tags: dict, answers_data: dict, batch_qtags: list[str]):
        """
        The question visualization needs every participant's answer under each Q#.
        LLM filtering can otherwise choose only one participant's line for a Q# in
        multi-file projects. Keep parsed LLM answers, but union them with the
        direct answer candidates gathered after each question occurrence.
        """
        for qtag in batch_qtags:
            answer_key = self._answer_tag_for_question_tag(qtag)
            if not answer_key:
                continue
            existing = final_answer_tags.get(answer_key, [])
            normalized_existing = set()
            for line_num in existing if isinstance(existing, list) else []:
                try:
                    normalized_existing.add(int(line_num))
                except Exception:
                    continue
            normalized_existing.update(self._all_possible_answer_lines(answers_data.get(qtag)))
            final_answer_tags[answer_key] = sorted(normalized_existing)

    def _load_transcript_data(self):
        self._sync_paths()
        transcript_file = self.TRANSCRIPTS_JSON_PATH
        if not os.path.exists(transcript_file):
            print(f"[Error] Transcript file not found at {transcript_file}")
            return None
        with open(transcript_file, "r", encoding="utf-8") as f:
            return json.load(f)

    def _content_skips_ai_tagging(self, content: dict | None) -> bool:
        if not isinstance(content, dict):
            return False
        return bool(
            content.get("skipAiTagging") is True
            or content.get("manualCodingPreserved") is True
            or content.get("manualCodingPreservedReason") == "unmatched_file_after_partial_processing"
        )

    def _build_interviewer_entries_by_file(self, transcript_data: dict | None = None):
        if transcript_data is None:
            transcript_data = self._load_transcript_data()
        if not isinstance(transcript_data, dict):
            return {}

        entries_by_file = {}
        for file_name, content in transcript_data.items():
            if self._content_skips_ai_tagging(content):
                continue
            transcript = (content or {}).get("transcript", [])
            if not isinstance(transcript, list):
                continue

            file_entries = []
            participant_id = self._participant_id_from_record(file_name, content)
            interviewer_speakers = self._infer_interviewer_speaker_set(transcript)
            for transcript_index, entry in enumerate(transcript):
                if not self._entry_is_question_candidate(entry, interviewer_speakers):
                    continue
                line = str((entry or {}).get("script", "")).strip()
                if not line:
                    continue
                file_entries.append({
                    "transcriptIndex": transcript_index,
                    "text": line,
                    "participant": participant_id,
                    "segmentId": entry.get("segmentId"),
                })

            if file_entries:
                entries_by_file[file_name] = file_entries

        return entries_by_file

    def _is_per_file_question_tag_payload(self, payload) -> bool:
        if not isinstance(payload, dict) or not payload:
            return False
        return any(isinstance(value, dict) for value in payload.values())

    def _is_per_file_answer_candidate_payload(self, payload) -> bool:
        if not isinstance(payload, dict) or not payload:
            return False
        return any(
            isinstance(value, dict) and isinstance(value.get("questions"), dict)
            for value in payload.values()
        )

    def _is_per_file_answer_tag_payload(self, payload) -> bool:
        if not isinstance(payload, dict) or not payload:
            return False
        return any(isinstance(value, dict) for value in payload.values())

    def extract_interviewer_script(self):
        self._sync_paths()
        output_file = self.POSSIBLE_QUESTION_SCRIPT_PATH
        transcript_data = self._load_transcript_data()
        if not isinstance(transcript_data, dict):
            return

        script_by_file = {}
        for file_name, entries in self._build_interviewer_entries_by_file(transcript_data).items():
            script_by_file[file_name] = [
                {
                    "transcriptIndex": entry["transcriptIndex"],
                    "script": entry["text"],
                    "participant": entry["participant"],
                    "segmentId": entry.get("segmentId"),
                }
                for entry in entries
            ]

        os.makedirs(os.path.dirname(output_file), exist_ok=True)
        with open(output_file, "w", encoding="utf-8") as f:
            json.dump(script_by_file, f, indent=2, ensure_ascii=False)

        print(f"\n Extracted Interviewer Script for {len(script_by_file)} transcript(s)")

    def extract_tags_batch(self, reply, num_lines, chunk_start=0, chunk_len=None):
        tags = [0] * num_lines
        chunk_len = chunk_len if isinstance(chunk_len, int) and chunk_len > 0 else num_lines
        chunk_start = int(chunk_start) if isinstance(chunk_start, int) else 0
        chunk_end = min(num_lines, chunk_start + chunk_len)
        parsed_pairs = []
        label_count = len(getattr(self, "_last_question_labels", []) or [])
        question_count_hint = label_count if label_count else max(1, num_lines)

        for line in reply.strip().split("\n"):
            line_clean = line.strip()
            if not line_clean:
                continue
            line_clean = line_clean.strip("`")
            line_clean = (
                line_clean
                .replace("：", ":")
                .replace("，", ",")
                .replace("－", "-")
                .replace("–", "-")
                .replace("—", "-")
            )
            line_clean = re.sub(r"^[\-\*\u2022]+\s*", "", line_clean)
            line_clean = re.sub(r"^\s*\d+[\.\)]\s+(?=Line\s*\d+)", "", line_clean, flags=re.IGNORECASE)

            match = None
            patterns = [
                r"(?:Line|Row)\s*#?\s*(\d+)\s*[:=\-]\s*((?:[Qq](?:uestion)?\s*)?\d+[A-Za-z]?)",
                r"(?:Line|Row)\s*#?\s*(\d+)\s*(?:->|=>)\s*((?:[Qq](?:uestion)?\s*)?\d+[A-Za-z]?)",
                r"^(\d+)\s*[:=\-]\s*((?:[Qq](?:uestion)?\s*)?\d+[A-Za-z]?)$",
            ]
            for pat in patterns:
                match = re.search(pat, line_clean, flags=re.IGNORECASE)
                if match:
                    break

            if match:
                raw_idx = int(match.group(1))
                tag = self._question_position_for_model_value(match.group(2), [None] * question_count_hint)
                parsed_pairs.append((raw_idx, tag))

        if not parsed_pairs:
            # Backup parser for replies that return only per-line tag numbers.
            flat_tags = []
            for line in reply.strip().split("\n"):
                line_clean = line.strip().strip("`")
                if not line_clean:
                    continue
                m = re.fullmatch(r"((?:[Qq](?:uestion)?\s*)?\d+[A-Za-z]?)\s*", line_clean)
                if m:
                    flat_tags.append(self._question_position_for_model_value(m.group(1), [None] * question_count_hint))
            if len(flat_tags) == chunk_len:
                parsed_pairs = [(chunk_start + i, tag) for i, tag in enumerate(flat_tags)]

        if not parsed_pairs:
            return tags

        # Auto-detect line-numbering scheme used by the model reply for this chunk.
        def map_abs0(v): return v
        def map_abs1(v): return v - 1
        def map_local0(v): return chunk_start + v
        def map_local1(v): return chunk_start + v - 1

        strategy_order = [
            ("abs0", map_abs0),    # expected prompt format (absolute 0-based)
            ("abs1", map_abs1),    # absolute 1-based
            ("local0", map_local0),# local chunk index, 0-based
            ("local1", map_local1),# local chunk index, 1-based
        ]

        best_name = "abs0"
        best_mapper = map_abs0
        best_score = -1

        for name, mapper in strategy_order:
            score = 0
            for raw_idx, _ in parsed_pairs:
                mapped = mapper(raw_idx)
                if chunk_start <= mapped < chunk_end:
                    score += 1
            if score > best_score:
                best_score = score
                best_name = name
                best_mapper = mapper

        # Apply the best strategy; fall back to broad bounds only when needed.
        for raw_idx, tag in parsed_pairs:
            idx = best_mapper(raw_idx)
            if not (0 <= idx < num_lines):
                if 0 <= raw_idx < num_lines:
                    idx = raw_idx
                elif 1 <= raw_idx <= num_lines:
                    idx = raw_idx - 1
                else:
                    continue
            tags[idx] = tag

        if best_score < len(parsed_pairs):
            print(
                f"[WARN] Parsed {len(parsed_pairs)} tag lines with mixed indexing; "
                f"using '{best_name}' scheme for chunk {chunk_start}-{chunk_end - 1}."
            )
        return tags

    def _extract_tags_for_index_subset(self, reply: str, target_indices, return_confidence: bool = False):
        """
        Parse line->tag pairs where only a subset of absolute line indices are expected.
        Supports:
        - absolute line numbers from transcript
        - local 0-based / 1-based numbering relative to target_indices order
        - flat per-line tag output with one number per line
        """
        ordered_targets = list(target_indices)
        target_set = set(ordered_targets)
        parsed_pairs = []
        label_count = len(getattr(self, "_last_question_labels", []) or [])
        question_count_hint = label_count if label_count else max(1, len(ordered_targets))

        for line in reply.strip().split("\n"):
            line_clean = line.strip()
            if not line_clean:
                continue
            line_clean = line_clean.strip("`")
            line_clean = (
                line_clean
                .replace("：", ":")
                .replace("，", ",")
                .replace("－", "-")
                .replace("–", "-")
                .replace("—", "-")
            )
            line_clean = re.sub(r"^[\-\*\u2022]+\s*", "", line_clean)
            line_clean = re.sub(r"^\s*\d+[\.\)]\s+(?=Line\s*\d+)", "", line_clean, flags=re.IGNORECASE)

            match = None
            patterns = [
                r"(?:Line|Row)\s*#?\s*(\d+)\s*[:=\-]\s*((?:[Qq](?:uestion)?\s*)?\d+[A-Za-z]?)(?:\s*[,;]\s*(?:confidence|conf)\s*[:=]\s*([0-9]*\.?[0-9]+%?))?",
                r"(?:Line|Row)\s*#?\s*(\d+)\s*(?:->|=>)\s*((?:[Qq](?:uestion)?\s*)?\d+[A-Za-z]?)(?:\s*[,;]\s*(?:confidence|conf)\s*[:=]\s*([0-9]*\.?[0-9]+%?))?",
                r"^(\d+)\s*[:=\-]\s*((?:[Qq](?:uestion)?\s*)?\d+[A-Za-z]?)(?:\s*[,;]\s*(?:confidence|conf)\s*[:=]\s*([0-9]*\.?[0-9]+%?))?$",
            ]
            for pat in patterns:
                match = re.search(pat, line_clean, flags=re.IGNORECASE)
                if match:
                    break

            if match:
                parsed_pairs.append((
                    int(match.group(1)),
                    self._question_position_for_model_value(match.group(2), [None] * question_count_hint),
                    self._coerce_model_confidence(match.group(3))
                ))

        tag_by_abs_index = {}
        confidence_by_abs_index = {}
        for raw_idx, tag, confidence in parsed_pairs:
            if raw_idx in target_set:
                tag_by_abs_index[raw_idx] = tag
                if confidence is not None:
                    confidence_by_abs_index[raw_idx] = confidence

        if len(tag_by_abs_index) < len(ordered_targets):
            for raw_idx, tag, confidence in parsed_pairs:
                if 0 <= raw_idx < len(ordered_targets):
                    tag_by_abs_index[ordered_targets[raw_idx]] = tag
                    if confidence is not None:
                        confidence_by_abs_index[ordered_targets[raw_idx]] = confidence
                elif 1 <= raw_idx <= len(ordered_targets):
                    tag_by_abs_index[ordered_targets[raw_idx - 1]] = tag
                    if confidence is not None:
                        confidence_by_abs_index[ordered_targets[raw_idx - 1]] = confidence

        if not tag_by_abs_index:
            flat_tags = []
            for line in reply.strip().split("\n"):
                line_clean = line.strip().strip("`")
                if not line_clean:
                    continue
                m = re.fullmatch(r"((?:[Qq](?:uestion)?\s*)?\d+[A-Za-z]?)\s*", line_clean)
                if m:
                    flat_tags.append(self._question_position_for_model_value(m.group(1), [None] * question_count_hint))
            if len(flat_tags) == len(ordered_targets):
                for abs_idx, tag in zip(ordered_targets, flat_tags):
                    tag_by_abs_index[abs_idx] = tag

        if return_confidence:
            return tag_by_abs_index, confidence_by_abs_index
        return tag_by_abs_index

    def _filter_low_confidence_question_tags(
        self,
        tag_by_index,
        confidence_by_index,
        interviewer_lines,
        questions,
        file_label: str,
        source_label: str,
        tagging_stats: dict | None = None,
    ):
        if self.DRY_RUN:
            return tag_by_index

        filtered_tags = dict(tag_by_index or {})
        for idx, tag in list(filtered_tags.items()):
            if not (0 < int(tag or 0) <= len(questions)):
                continue
            confidence = self._question_tag_confidence_for_line(
                interviewer_lines.get(idx, ""),
                questions,
                int(tag),
                (confidence_by_index or {}).get(idx),
            )
            if confidence < QUESTION_TAGGING_CONFIDENCE_THRESHOLD:
                filtered_tags[idx] = 0
                if isinstance(tagging_stats, dict):
                    tagging_stats["low_confidence_rejected"] = tagging_stats.get("low_confidence_rejected", 0) + 1
                rejected_label = self._question_tag_for_position(tag)
                print(
                    f"[Low Confidence][{file_label}] Line {idx} rejected {rejected_label} "
                    f"from {source_label} (confidence={confidence:.2f}, "
                    f"threshold={QUESTION_TAGGING_CONFIDENCE_THRESHOLD:.2f})"
                )
        return filtered_tags

    def _rescue_zero_lines_with_llm(self, interviewer_lines, unresolved_indices, questions):
        """
        Re-ask the model for lines previously tagged as 0 while still allowing
        true filler/logistics/context lines to remain untagged.
        """
        if not unresolved_indices:
            return {}, {}
        prompt_lines = "\n".join(
            f"Line {idx}: \"{interviewer_lines[idx]}\"" for idx in unresolved_indices
        )
        rescue_prompt = f"""You are a research assistant. Re-evaluate these interviewer lines that were previously tagged as 0.
- Assign the best matching question only when the line is a real interviewer question.
- Output EXACTLY one line per input in this format: Line <index>: <question_id>, confidence=<0.00-1.00>
- Use ONLY numeric question IDs from 1 to {len(questions)}. Labels such as Q1a are shown next to each ID for context.
- Use 0 with confidence=1.00 for filler, logistics, setup, acknowledgements, or transitional/context-setting lines that do not directly ask the participant to answer.
- No explanations.

Interviewer Lines:
{prompt_lines}

Question List:
{self._question_prompt_lines(questions)}
"""
        response = self._chat_with_retry(
            messages=[
                {"role": "system", "content": "Respond ONLY with 'Line <index>: <question_id>, confidence=<0.00-1.00>'. No prose."},
                {"role": "user", "content": rescue_prompt},
            ],
            context=f"Question tagging zero-line rescue {unresolved_indices[0]}-{unresolved_indices[-1]}",
        )
        raw_reply = response.choices[0].message.content.strip()
        reply = re.sub(r"<think>.*?</think>", "", raw_reply, flags=re.DOTALL).strip()
        return self._extract_tags_for_index_subset(reply, unresolved_indices, return_confidence=True)

    def _tag_questions_for_file(self, file_name: str, line_entries, questions, batch_size: int, llm_ready: bool, debug_tagging: bool):
        tag_map = {}
        tagging_stats = {
            "llm_primary": 0,
            "llm_zero_rescue": 0,
            "fallback": 0,
            "forced_fallback": 0,
            "low_confidence_rejected": 0,
            "no_match": 0,
        }
        effective_batch = min(batch_size, 30)
        ordered_entries = sorted(
            [
                {
                    "transcriptIndex": int(entry["transcriptIndex"]),
                    "text": self._normalize_interviewer_line(entry.get("text", "")),
                }
                for entry in line_entries
                if str(entry.get("text", "")).strip() != ""
            ],
            key=lambda entry: entry["transcriptIndex"],
        )
        interviewer_lines = {
            entry["transcriptIndex"]: entry["text"]
            for entry in ordered_entries
        }
        file_label = os.path.basename(file_name)

        def strip_think(text: str) -> str:
            return re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()

        for chunk_entries, chunk_offset in self.chunk_list(ordered_entries, effective_batch):
            chunk_indices = [entry["transcriptIndex"] for entry in chunk_entries]
            prompt_lines = "\n".join(
                f"Line {entry['transcriptIndex']}: \"{entry['text']}\""
                for entry in chunk_entries
            )

            prompt = f"""You are a research assistant. Classify each interviewer line by assigning the most appropriate question ID.
- You MUST output one line per input line in the exact format: Line <index>: <question_id>, confidence=<0.00-1.00>
- Valid IDs: {', '.join(str(i) for i in range(1, len(questions)+1))}; use 0 for true filler/logistics/non-question lines.
- Labels such as Q1a are shown next to each numeric ID for context; output the numeric ID, not the label.
- Use 0 with confidence=1.00 for acknowledgements, setup, transitions, context-setting, or conversational handoffs that do not directly ask the participant to answer.
- Prefer non-zero tags only when the line is a substantive interview question.
- Do not include any other text.

Interviewer Lines:
{prompt_lines}

Question List:
{self._question_prompt_lines(questions)}
"""

            tag_by_index = {}
            confidence_by_index = {}
            if self.DRY_RUN:
                print(f"[DRY_RUN] Simulating tagging batch for {file_label} at offset {chunk_offset}")
                reply = "\n".join(
                    f"Line {entry['transcriptIndex']}: {(local_index % len(questions)) + 1}"
                    for local_index, entry in enumerate(chunk_entries)
                )
                tag_by_index, confidence_by_index = self._extract_tags_for_index_subset(
                    reply,
                    chunk_indices,
                    return_confidence=True,
                )
            elif not llm_ready:
                for entry in chunk_entries:
                    fallback_tag = self._fallback_tag_for_line(
                        entry["text"],
                        questions,
                        threshold=QUESTION_SIMILARITY_FALLBACK_THRESHOLD_NO_LLM,
                    )
                    if fallback_tag:
                        key = self._question_tag_for_position(fallback_tag)
                        tag_map.setdefault(key, []).append(entry["transcriptIndex"])
                        tagging_stats["fallback"] += 1
                    else:
                        print(f"[No Match][{file_label}] Line {entry['transcriptIndex']} could not be tagged in fallback mode")
                        tagging_stats["no_match"] += 1
                continue
            else:
                try:
                    if debug_tagging:
                        print(f"[DEBUG][{file_label}] Questions count: {len(questions)}; sample: {questions[:3]}")
                        print(f"[DEBUG][{file_label}] Prompt lines:\n{prompt_lines}")
                    response = self._chat_with_retry(
                        messages=[
                            {"role": "system", "content": "Respond ONLY with lines in the exact format 'Line <index>: <question_id>, confidence=<0.00-1.00>'. No thoughts, no analysis, no explanations."},
                            {"role": "user", "content": prompt}
                        ],
                        context=f"Question tagging batch {file_label} {chunk_indices[0]}-{chunk_indices[-1]}",
                    )
                    raw_reply = response.choices[0].message.content.strip()
                    if debug_tagging:
                        print(f"[DEBUG][{file_label}] Raw reply:\n{raw_reply}")
                    reply = strip_think(raw_reply)
                    tag_by_index, confidence_by_index = self._extract_tags_for_index_subset(
                        reply,
                        chunk_indices,
                        return_confidence=True,
                    )
                except Exception as e:
                    print(f"[Error][{file_label}] Tagging batch {chunk_indices[0]}-{chunk_indices[-1]} failed: {e}")
                    for entry in chunk_entries:
                        fallback_tag = self._fallback_tag_for_line(
                            entry["text"],
                            questions,
                            threshold=QUESTION_SIMILARITY_FALLBACK_THRESHOLD,
                        )
                        if fallback_tag:
                            key = self._question_tag_for_position(fallback_tag)
                            tag_map.setdefault(key, []).append(entry["transcriptIndex"])
                            print(f"[Fallback][{file_label}] Line {entry['transcriptIndex']} matched to {key} (LLM request failed)")
                            tagging_stats["fallback"] += 1
                        else:
                            print(f"[No Match][{file_label}] Line {entry['transcriptIndex']} could not be tagged (LLM request failed)")
                            tagging_stats["no_match"] += 1
                    continue

            tag_by_index = self._filter_low_confidence_question_tags(
                tag_by_index,
                confidence_by_index,
                interviewer_lines,
                questions,
                file_label,
                "primary model tag",
                tagging_stats,
            )

            llm_non_zero_in_chunk = sum(
                1 for idx in chunk_indices
                if 0 < tag_by_index.get(idx, 0) <= len(questions)
            )
            zero_rescued_indices = set()
            print(
                f"[LLM-FirstPass][{file_label} {chunk_indices[0]}-{chunk_indices[-1]}] "
                f"direct_non_zero={llm_non_zero_in_chunk}/{len(chunk_indices)}"
            )

            if llm_non_zero_in_chunk == 0 and not self.DRY_RUN:
                rescue_prompt = f"""You are a research assistant. Assign each interviewer line to the closest question.
- Output one line per input in exact format: Line <index>: <question_id>, confidence=<0.00-1.00>
- Use ONLY numeric question IDs from 1 to {len(questions)}. Labels such as Q1a are shown next to each ID for context.
- Use 0 with confidence=1.00 for filler, logistics, setup, acknowledgements, or transitional/context-setting lines that do not directly ask the participant to answer.
- No explanations.

Interviewer Lines:
{prompt_lines}

Question List:
{self._question_prompt_lines(questions)}
"""
                try:
                    rescue_response = self._chat_with_retry(
                        messages=[
                            {"role": "system", "content": "Respond ONLY with 'Line <index>: <question_id>, confidence=<0.00-1.00>'. No prose."},
                            {"role": "user", "content": rescue_prompt},
                        ],
                        context=f"Question tagging rescue {file_label} {chunk_indices[0]}-{chunk_indices[-1]}",
                    )
                    rescue_raw_reply = rescue_response.choices[0].message.content.strip()
                    rescue_reply = strip_think(rescue_raw_reply)
                    rescue_tags, rescue_confidence = self._extract_tags_for_index_subset(
                        rescue_reply,
                        chunk_indices,
                        return_confidence=True,
                    )
                    rescue_tags = self._filter_low_confidence_question_tags(
                        rescue_tags,
                        rescue_confidence,
                        interviewer_lines,
                        questions,
                        file_label,
                        "rescue model tag",
                        tagging_stats,
                    )
                    rescue_non_zero = sum(
                        1 for idx in chunk_indices
                        if 0 < rescue_tags.get(idx, 0) <= len(questions)
                    )
                    if rescue_non_zero > 0:
                        tag_by_index = rescue_tags
                        llm_non_zero_in_chunk = rescue_non_zero
                        print(
                            f"[INFO][{file_label}] Rescue pass recovered {rescue_non_zero}/{len(chunk_indices)} "
                            f"non-zero tags for lines {chunk_indices[0]}-{chunk_indices[-1]}."
                        )
                except Exception as e:
                    print(f"[WARN][{file_label}] Rescue pass failed for lines {chunk_indices[0]}-{chunk_indices[-1]}: {e}")

            unresolved_indices = [
                idx for idx in chunk_indices
                if not (0 < tag_by_index.get(idx, 0) <= len(questions))
            ]
            if unresolved_indices and not self.DRY_RUN:
                try:
                    rescued_map, rescued_confidence = self._rescue_zero_lines_with_llm(
                        interviewer_lines,
                        unresolved_indices,
                        questions,
                    )
                    rescued_map = self._filter_low_confidence_question_tags(
                        rescued_map,
                        rescued_confidence,
                        interviewer_lines,
                        questions,
                        file_label,
                        "zero-line rescue tag",
                        tagging_stats,
                    )
                    rescued_count = 0
                    for idx in unresolved_indices:
                        rescued_tag = rescued_map.get(idx, 0)
                        if 0 < rescued_tag <= len(questions):
                            tag_by_index[idx] = rescued_tag
                            zero_rescued_indices.add(idx)
                            rescued_count += 1
                    if rescued_count > 0:
                        llm_non_zero_in_chunk = sum(
                            1 for idx in chunk_indices
                            if 0 < tag_by_index.get(idx, 0) <= len(questions)
                        )
                        print(
                            f"[INFO][{file_label}] Zero-line rescue recovered {rescued_count}/{len(unresolved_indices)} "
                            f"non-zero tags for lines {chunk_indices[0]}-{chunk_indices[-1]}."
                        )
                except Exception as e:
                    print(f"[WARN][{file_label}] Zero-line rescue failed for lines {chunk_indices[0]}-{chunk_indices[-1]}: {e}")

            if llm_non_zero_in_chunk == 0:
                print(
                    f"[WARN][{file_label}] Lines {chunk_indices[0]}-{chunk_indices[-1]} returned no parsable non-zero "
                    f"LLM tags. Falling back to similarity. (baseline={LLM_PIPELINE_BASELINE_COMMIT})"
                )

            for entry in chunk_entries:
                transcript_index = entry["transcriptIndex"]
                tag = tag_by_index.get(transcript_index, 0)
                if 0 < tag <= len(questions):
                    key = self._question_tag_for_position(tag)
                    tag_map.setdefault(key, []).append(transcript_index)
                    if transcript_index in zero_rescued_indices:
                        tagging_stats["llm_zero_rescue"] += 1
                    else:
                        tagging_stats["llm_primary"] += 1
                        print(f"[LLM-FirstPass][{file_label}] Line {transcript_index} matched to {key} (direct model tag)")
                else:
                    fallback_tag = self._fallback_tag_for_line(
                        entry["text"],
                        questions,
                        threshold=QUESTION_SIMILARITY_FALLBACK_THRESHOLD,
                    )
                    if fallback_tag:
                        key = self._question_tag_for_position(fallback_tag)
                        tag_map.setdefault(key, []).append(transcript_index)
                        print(
                            f"[Fallback][{file_label}] Line {transcript_index} matched to {key} by similarity "
                            f"(LLM direct tag=0: no direct question match)"
                        )
                        tagging_stats["fallback"] += 1
                    else:
                        print(f"[No Match][{file_label}] Line {transcript_index} tagged as 0 (not stored)")
                        tagging_stats["no_match"] += 1

        sorted_tag_map = {}
        for qtag, indices in sorted(tag_map.items(), key=lambda item: self._question_sort_key(item[0])):
            sorted_tag_map[qtag] = sorted({int(idx) for idx in indices})
        return sorted_tag_map, tagging_stats, len(ordered_entries)

    def tag_questions_batch(self, batch_size):
        self._sync_paths()
        print("\n Tagging interviewer lines in batches\n")

        try:
            questions = self._load_questions()
        except Exception as e:
            print(f"[Error] {e}")
            return

        transcript_data = self._load_transcript_data()
        if not isinstance(transcript_data, dict):
            return

        interviewer_entries_by_file = self._build_interviewer_entries_by_file(transcript_data)
        if not interviewer_entries_by_file:
            print("[WARN] No interviewer lines found; skipping question tagging.")
            os.makedirs(os.path.dirname(self.QUESTION_TAGS_PATH), exist_ok=True)
            with open(self.QUESTION_TAGS_PATH, "w", encoding="utf-8") as f:
                json.dump({}, f, indent=2)
            return

        tag_map = {}
        total_tagging_stats = {
            "llm_primary": 0,
            "llm_zero_rescue": 0,
            "fallback": 0,
            "forced_fallback": 0,
            "low_confidence_rejected": 0,
            "no_match": 0,
        }
        total_interviewer_lines = 0
        debug_tagging = os.environ.get("CHROMA_DEBUG_TAGGING", "").lower() in ("1", "true", "yes")

        llm_ready = self._lm_studio_ready()
        if not llm_ready:
            print("[WARN] LLM is not ready. Running question tagging in similarity-only fallback mode.")

        for file_name, line_entries in interviewer_entries_by_file.items():
            file_tag_map, file_stats, line_count = self._tag_questions_for_file(
                file_name,
                line_entries,
                questions,
                batch_size,
                llm_ready,
                debug_tagging,
            )
            tag_map[file_name] = file_tag_map
            total_interviewer_lines += line_count
            for stat_name, stat_value in file_stats.items():
                total_tagging_stats[stat_name] += stat_value

        output_path = self.QUESTION_TAGS_PATH
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(tag_map, f, indent=2)

        print(f"\n Question tagging complete. Results saved to: {output_path}")
        llm_total = total_tagging_stats["llm_primary"] + total_tagging_stats["llm_zero_rescue"]
        print(
            "[Question Tagging Summary] "
            f"llm={llm_total} (primary={total_tagging_stats['llm_primary']}, zero_rescue={total_tagging_stats['llm_zero_rescue']}), "
            f"fallback={total_tagging_stats['fallback']}, "
            f"forced_fallback={total_tagging_stats['forced_fallback']}, "
            f"low_confidence_rejected={total_tagging_stats['low_confidence_rejected']}, "
            f"no_match={total_tagging_stats['no_match']}, "
            f"total_tagged={sum(sum(len(indices) for indices in file_map.values()) for file_map in tag_map.values())}, "
            f"interviewer_lines={total_interviewer_lines}, files={len(interviewer_entries_by_file)}, "
            f"confidence_threshold={QUESTION_TAGGING_CONFIDENCE_THRESHOLD:.2f}, "
            f"similarity_threshold={QUESTION_SIMILARITY_FALLBACK_THRESHOLD:.2f}"
        )

    def add_tagged_questions(self):
        self._sync_paths()
        tags_file = self._first_existing_path(self.QUESTION_TAGS_PATH, self.LEGACY_QUESTION_TAGS_PATH)
        transcript_file = self.TRANSCRIPTS_JSON_PATH
        output_file = self.TRANSCRIPTS_JSON_PATH

        if not os.path.exists(tags_file):
            print(f"[Error] Tag file not found at {tags_file}. Run tag_questions_batch first.")
            return
        if not os.path.exists(transcript_file):
            print(f"[Error] Transcript file not found at {transcript_file}")
            return

        with open(tags_file, "r", encoding="utf-8") as f:
            tag_map = json.load(f)
        with open(transcript_file, "r", encoding="utf-8") as f:
            transcript_data = json.load(f)

        conflicts = []
        if self._is_per_file_question_tag_payload(tag_map):
            for file_name, content in transcript_data.items():
                if self._content_skips_ai_tagging(content):
                    continue
                per_file_tag_map = tag_map.get(file_name, {})
                index_to_tag = {}
                for tag, indices in per_file_tag_map.items():
                    for idx in indices if isinstance(indices, list) else []:
                        try:
                            index_to_tag[int(idx)] = tag
                        except Exception:
                            continue

                transcript = content.get("transcript", [])
                interviewer_speakers = self._infer_interviewer_speaker_set(transcript)
                for transcript_index, entry in enumerate(transcript):
                    if self._entry_is_question_candidate(entry, interviewer_speakers):
                        self._apply_ai_qna_tag(
                            entry,
                            index_to_tag.get(transcript_index, "None"),
                            file_name=file_name,
                            content=content,
                            transcript_index=transcript_index,
                            tag_family="question",
                            conflicts=conflicts,
                        )
                    else:
                        self._apply_ai_qna_tag(
                            entry,
                            "None",
                            file_name=file_name,
                            content=content,
                            transcript_index=transcript_index,
                            tag_family="question",
                            conflicts=conflicts,
                            detect_conflict=False,
                        )
        else:
            index_to_tag = {}
            for tag, indices in tag_map.items():
                for idx in indices:
                    try:
                        index_to_tag[int(idx)] = tag
                    except Exception:
                        continue

            global_interviewer_line = 0
            for file_name, content in transcript_data.items():
                if self._content_skips_ai_tagging(content):
                    continue
                transcript = content["transcript"]
                interviewer_speakers = self._infer_interviewer_speaker_set(transcript)
                for transcript_index, entry in enumerate(transcript):
                    if self._entry_is_question_candidate(entry, interviewer_speakers):
                        self._apply_ai_qna_tag(
                            entry,
                            index_to_tag.get(global_interviewer_line, "None"),
                            file_name=file_name,
                            content=content,
                            transcript_index=transcript_index,
                            tag_family="question",
                            conflicts=conflicts,
                        )
                        global_interviewer_line += 1
                    else:
                        self._apply_ai_qna_tag(
                            entry,
                            "None",
                            file_name=file_name,
                            content=content,
                            transcript_index=transcript_index,
                            tag_family="question",
                            conflicts=conflicts,
                            detect_conflict=False,
                        )

        with open(output_file, "w", encoding="utf-8") as f:
            json.dump(transcript_data, f, indent=2, ensure_ascii=False)
        self._write_tag_conflicts(conflicts, "question")

        print("\n Added tagged questions to transcript")

    def extract_questions_possible_answers(self):
        self._sync_paths()
        transcript_file = self.TRANSCRIPTS_JSON_PATH
        output_file = self.POSSIBLE_ANSWER_SCRIPT_PATH

        with open(transcript_file, "r", encoding="utf-8") as f:
            transcript_data = json.load(f)

        try:
            question_list = self._load_questions()
        except Exception as e:
            print(f"[Error] {e}")
            return

        questions_map = {}
        question_labels = getattr(self, "_last_question_labels", []) or []
        for index, question_text in enumerate(question_list):
            if not question_text:
                continue
            label = question_labels[index] if index < len(question_labels) else str(index + 1)
            questions_map[f"Q{label}"] = question_text

        output_data = {}
        for file_name, content in transcript_data.items():
            if self._content_skips_ai_tagging(content):
                continue
            transcript = content["transcript"]
            participant_id = self._participant_id_from_record(file_name, content)
            file_output_data = {}
            interviewer_speakers = self._infer_interviewer_speaker_set(transcript)
            for idx, entry in enumerate(transcript):
                tag = str(entry.get("tag") or "None")
                if tag.startswith("Q") and tag in questions_map:
                    qtext = questions_map[tag]
                    answers = {}
                    answer_line_numbers = []
                    look_ahead_count = 0
                    j = idx + 1
                    while j < len(transcript) and look_ahead_count < 5:
                        next_entry = transcript[j]
                        if self._entry_is_participant(next_entry, interviewer_speakers):
                            line_number = j
                            answers[str(line_number)] = next_entry.get("script", "")
                            answer_line_numbers.append(line_number)
                            look_ahead_count += 1
                        elif str(next_entry.get("tag") or "").startswith("Q"):
                            break
                        j += 1

                    if answers:
                        if tag not in file_output_data:
                            file_output_data[tag] = {
                                "question": qtext,
                                "possibleAnswers": {},
                                "answerGroups": []
                            }
                        file_output_data[tag]["possibleAnswers"].update(answers)
                        file_output_data[tag].setdefault("answerGroups", []).append({
                            "participant": participant_id,
                            "file": file_name,
                            "questionLine": idx,
                            "answerLines": answer_line_numbers,
                        })
            if file_output_data:
                sorted_questions = dict(sorted(file_output_data.items(), key=lambda x: self._question_sort_key(x[0])))
                output_data[file_name] = {
                    "participant": participant_id,
                    "questions": sorted_questions,
                }

        os.makedirs(os.path.dirname(output_file), exist_ok=True)
        with open(output_file, "w", encoding="utf-8") as f:
            json.dump(output_data, f, indent=2, ensure_ascii=False)

        print(f"Saved answers by question to: {output_file}")

    def _use_possible_answers_for_questions(self, answer_tags, answers_data, question_tags):
        for question_tag in question_tags:
            answer_key = self._answer_tag_for_question_tag(question_tag)
            if not answer_key:
                continue
            answer_tags[answer_key] = self._all_possible_answer_lines(answers_data.get(question_tag))

    def _parse_answer_batch_reply(self, raw_reply, question_tags, answer_tags):
        reply = re.sub(r"<think>.*?</think>", "", raw_reply, flags=re.DOTALL).strip()
        pattern = re.compile(r"^(A\s*\d+[A-Za-z]?):\s*(\[.*\])$", flags=re.IGNORECASE)
        parsed_any = False

        for line in reply.split("\n"):
            match = pattern.match(line.strip())
            if not match:
                continue
            answer_key = self._map_answer_key_for_batch(match.group(1), question_tags)
            if not answer_key:
                continue

            try:
                line_values = ast.literal_eval(match.group(2))
                answer_tags[answer_key] = [
                    int(line_number)
                    for line_number in line_values
                    if str(line_number).strip().lstrip("-").isdigit()
                ]
                # A nonempty parsed list counts as a reply, even if none of
                # its values are line numbers.
                if line_values:
                    parsed_any = True
            except Exception:
                answer_tags[answer_key] = []

        for question_tag in question_tags:
            answer_key = self._answer_tag_for_question_tag(question_tag)
            answer_tags.setdefault(answer_key, [])
        return parsed_any

    def _tag_answers_for_file(self, file_name: str, answers_data: dict, batch_size=14, llm_ready: bool = True):
        question_tags = sorted(answers_data.keys(), key=self._question_sort_key)
        if not question_tags:
            return {}

        total_batches = math.ceil(len(question_tags) / batch_size)
        final_answer_tags = {}
        file_label = os.path.basename(file_name)

        if not llm_ready:
            self._use_possible_answers_for_questions(
                final_answer_tags, answers_data, question_tags
            )
            return final_answer_tags

        for b in range(total_batches):
            batch_qtags = question_tags[b * batch_size:(b + 1) * batch_size]

            prompt_lines = []
            for qtag in batch_qtags:
                qinfo = answers_data[qtag]
                prompt_lines.append(f"{qtag}: {qinfo['question']}")
                for line_num, answer_text in sorted(qinfo["possibleAnswers"].items(), key=lambda kv: int(kv[0])):
                    prompt_lines.append(f"Line {line_num}: {answer_text}")
                prompt_lines.append("")

            prompt = f"""You are an expert research assistant. Your task is to identify the correct participant answers for each interview question inside a single participant transcript file.

Instructions:
1. Each question is labeled as Q1, Q1a, Q2, etc. Follow-up labels such as Q1a must stay separate.
2. Candidate answer lines all come from the same participant transcript file.
3. For each question, return every line number in this file that directly answers that question.
4. Return answer labels that correspond to the exact question labels in this batch.
- Example: Q1a must be returned as A1a, Q7 as A7, Q12 as A12.
5. IMPORTANT: You must output in this exact format:
A<label>: [line_numbers]
A<label>: [line_numbers]
...
No other words, no Q1, no asterisks, no explanations.
6. Do not include explanations or extra text and If no correct answers exist, return an empty list: []
7. Required answer labels for this batch: {", ".join(self._answer_tag_for_question_tag(qtag) for qtag in batch_qtags)}

Questions and possible participant answers:
{chr(10).join(prompt_lines)}

Remember: choose only direct answer lines from this participant file.
"""

            if self.DRY_RUN:
                print(f"[DRY_RUN] Simulating answer tagging batch {b+1}/{total_batches} for {file_label}")
                self._use_possible_answers_for_questions(
                    final_answer_tags, answers_data, batch_qtags
                )
                continue

            try:
                response = self._chat_with_retry(
                    messages=[
                        {"role": "system", "content": "Respond ONLY with lines in the exact format 'A<label>: [list_of_line_numbers]'. No analysis, no prose."},
                        {"role": "user", "content": prompt}
                    ],
                    context=f"Answer tagging batch {file_label} {b+1}/{total_batches}",
                )
                raw_reply = response.choices[0].message.content.strip()
                parsed_any = self._parse_answer_batch_reply(
                    raw_reply, batch_qtags, final_answer_tags
                )
                if not parsed_any:
                    print(f"[WARN][{file_label}] No answer tags parsed for batch {b+1}. Falling back to all possible answers for those questions.")
                    self._use_possible_answers_for_questions(
                        final_answer_tags, answers_data, batch_qtags
                    )
                else:
                    self._ensure_all_participant_answers_for_batch(final_answer_tags, answers_data, batch_qtags)

            except Exception as e:
                print(f"[Error][{file_label}] LLM tagging failed in batch {b+1}: {e}")
                print(f"[WARN][{file_label}] Falling back to all possible answers for batch {b+1}/{total_batches}.")
                self._use_possible_answers_for_questions(
                    final_answer_tags, answers_data, batch_qtags
                )

        return final_answer_tags

    def tag_answer_batch(self, batch_size=14):
        self._sync_paths()
        answers_file = self._first_existing_path(self.POSSIBLE_ANSWER_SCRIPT_PATH, self.LEGACY_POSSIBLE_ANSWER_SCRIPT_PATH)
        output_file = self.ANSWER_TAGS_PATH

        if not os.path.exists(answers_file):
            print(f"[Error] Answers file not found at {answers_file}. Run extract_questions_possible_answers first.")
            return

        with open(answers_file, "r", encoding="utf-8") as f:
            answers_data = json.load(f)

        if not answers_data:
            print("[WARN] No possible answers found; skipping answer tagging.")
            os.makedirs(os.path.dirname(output_file), exist_ok=True)
            with open(output_file, "w", encoding="utf-8") as f:
                json.dump({}, f, indent=2)
            return

        llm_ready = self._lm_studio_ready()
        if not llm_ready:
            print("[WARN] LLM is not ready. Running answer tagging with all possible answers fallback.")

        if self._is_per_file_answer_candidate_payload(answers_data):
            final_answer_tags = {}
            for file_name, payload in answers_data.items():
                per_file_answers = payload.get("questions", {})
                final_answer_tags[file_name] = self._tag_answers_for_file(
                    file_name,
                    per_file_answers,
                    batch_size=batch_size,
                    llm_ready=llm_ready,
                )
            os.makedirs(os.path.dirname(output_file), exist_ok=True)
            with open(output_file, "w", encoding="utf-8") as f:
                json.dump(final_answer_tags, f, indent=2)
            print(f"\nAll batches done. Tagged answers saved to: {output_file}")
            return

        question_tags = sorted(answers_data.keys(), key=self._question_sort_key)
        total_batches = math.ceil(len(question_tags) / batch_size)

        final_answer_tags = {}

        if not llm_ready:
            self._use_possible_answers_for_questions(
                final_answer_tags, answers_data, question_tags
            )
            os.makedirs(os.path.dirname(output_file), exist_ok=True)
            with open(output_file, "w", encoding="utf-8") as f:
                json.dump(final_answer_tags, f, indent=2)
            print(f"\nAll batches done. Tagged answers saved to: {output_file}")
            return

        for b in range(total_batches):
            batch_qtags = question_tags[b * batch_size:(b + 1) * batch_size]

            prompt_lines = []
            for qtag in batch_qtags:
                qinfo = answers_data[qtag]
                prompt_lines.append(f"{qtag}: {qinfo['question']}")
                for line_num, answer_text in sorted(qinfo["possibleAnswers"].items(), key=lambda kv: int(kv[0])):
                    prompt_lines.append(f"Line {line_num}: {answer_text}")
                prompt_lines.append("")

            prompt = f"""You are an expert research assistant. Your task is to identify the correct participant answers for each interview question.

    Instructions:
    1. Each question is labeled as Q1, Q1a, Q2, etc. Follow-up labels such as Q1a must stay separate.
    2. Participant answers have line numbers.
    3. For each question, return line numbers that directly answer that question for every participant represented in the candidates.
    - If a question has only one correct answer, return a list with a single line number.
    - If multiple participants answer the same question, include each participant's answer line numbers.
    4. Return answer labels that correspond to the exact question labels in this batch.
    - Example: Q1a must be returned as A1a, Q7 as A7, Q12 as A12.
    5. IMPORTANT: You must output in this exact format:
    A<label>: [line_numbers]
    A<label>: [line_numbers]
    ...
    No other words, no Q1, no asterisks, no explanations.
    6. Do not include explanations or extra text and If no correct answers exist, return an empty list: []
    7. Required answer labels for this batch: {", ".join(self._answer_tag_for_question_tag(qtag) for qtag in batch_qtags)}

    Questions and possible participant answers:
    {chr(10).join(prompt_lines)}

    Remember: include direct answer lines from every participant represented in the candidates.
    """

            if self.DRY_RUN:
                print(f"[DRY_RUN] Simulating batch {b+1}/{total_batches}")
                self._use_possible_answers_for_questions(
                    final_answer_tags, answers_data, batch_qtags
                )
                continue

            try:
                response = self._chat_with_retry(
                    messages=[
                        {"role": "system", "content": "Respond ONLY with lines in the exact format 'A<label>: [list_of_line_numbers]'. No analysis, no prose."},
                        {"role": "user", "content": prompt}
                    ],
                    context=f"Answer tagging batch {b+1}/{total_batches}",
                )
                raw_reply = response.choices[0].message.content.strip()
                parsed_any = self._parse_answer_batch_reply(
                    raw_reply, batch_qtags, final_answer_tags
                )
                if not parsed_any:
                    print(f"[WARN] No answer tags parsed for batch {b+1}. Falling back to all possible answers for those questions.")
                    self._use_possible_answers_for_questions(
                        final_answer_tags, answers_data, batch_qtags
                    )
                else:
                    self._ensure_all_participant_answers_for_batch(final_answer_tags, answers_data, batch_qtags)

            except Exception as e:
                print(f"[Error] LLM tagging failed in batch {b+1}: {e}")
                print(f"[WARN] Falling back to all possible answers for batch {b+1}/{total_batches}.")
                self._use_possible_answers_for_questions(
                    final_answer_tags, answers_data, batch_qtags
                )

        os.makedirs(os.path.dirname(output_file), exist_ok=True)
        with open(output_file, "w", encoding="utf-8") as f:
            json.dump(final_answer_tags, f, indent=2)

        print(f"\nAll batches done. Tagged answers saved to: {output_file}")

    def add_tagged_answers(self):
        self._sync_paths()
        tags_file = self._first_existing_path(self.ANSWER_TAGS_PATH, self.LEGACY_ANSWER_TAGS_PATH)
        transcript_file = self.TRANSCRIPTS_JSON_PATH
        output_file = self.TRANSCRIPTS_JSON_PATH

        if not os.path.exists(tags_file):
            print(f"[Error] Answer tag file not found at {tags_file}. Run tag_answer_batch first.")
            return
        if not os.path.exists(transcript_file):
            print(f"[Error] Transcript file not found at {transcript_file}")
            return

        with open(tags_file, "r", encoding='utf-8') as f:
            tag_map = json.load(f)

        if not tag_map or not any(tag_map.values()):
            print(f"[WARN] No answer tags found in {tags_file}. Skipping transcript update.")
            return

        with open(transcript_file, "r", encoding="utf-8") as f:
            transcript_data = json.load(f)

        conflicts = []
        if self._is_per_file_answer_tag_payload(tag_map):
            for file_name, content in transcript_data.items():
                if self._content_skips_ai_tagging(content):
                    continue
                per_file_tags = tag_map.get(file_name, {})
                line_to_tag = {}
                for atag, line_numbers in per_file_tags.items():
                    for line_num in line_numbers if isinstance(line_numbers, list) else []:
                        try:
                            line_to_tag[int(line_num)] = atag
                        except Exception:
                            continue

                transcript = content.get("transcript", [])
                interviewer_speakers = self._infer_interviewer_speaker_set(transcript)
                for transcript_index, entry in enumerate(transcript):
                    if self._entry_is_participant(entry, interviewer_speakers):
                        self._apply_ai_qna_tag(
                            entry,
                            line_to_tag.get(transcript_index, "None"),
                            file_name=file_name,
                            content=content,
                            transcript_index=transcript_index,
                            tag_family="answer",
                            conflicts=conflicts,
                        )
        else:
            line_to_tag = {}
            for atag, line_numbers in tag_map.items():
                for line_num in line_numbers:
                    try:
                        line_to_tag[int(line_num)] = atag
                    except Exception:
                        continue

            absolute_transcript_index = 0
            for file_name, content in transcript_data.items():
                if self._content_skips_ai_tagging(content):
                    continue
                transcript = content["transcript"]
                interviewer_speakers = self._infer_interviewer_speaker_set(transcript)
                for idx, entry in enumerate(transcript):
                    if self._entry_is_participant(entry, interviewer_speakers):
                        self._apply_ai_qna_tag(
                            entry,
                            line_to_tag.get(absolute_transcript_index, "None"),
                            file_name=file_name,
                            content=content,
                            transcript_index=idx,
                            tag_family="answer",
                            conflicts=conflicts,
                        )
                    absolute_transcript_index += 1

        with open(output_file, "w", encoding='utf-8') as f:
            json.dump(transcript_data, f, indent=2, ensure_ascii=False)
        self._write_tag_conflicts(conflicts, "answer")

        print("\nAdded tagged answers to transcript, keeping interviewer question tags intact")
