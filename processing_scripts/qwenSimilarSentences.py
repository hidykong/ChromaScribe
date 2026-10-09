# Support both module execution and the existing direct-script entry point.
if __package__ in (None, ""):
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import json
import math
import re
import time
import os
import openai
from config import load_local_environment, settings
from processing_scripts.llm_config import resolve_llm_config
from processing_scripts.transcriptIdentity import (
    excerpt_source_metadata,
    normalize_participant_id,
    participant_id_for_entry,
)
try:
    from titlecase import titlecase
except Exception:
    def titlecase(value):
        return str(value or "").title()


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, os.pardir))
STATIC_DIR = str(settings.data_dir / "static")
DEFAULT_PROCESSED_DIR = os.path.join(STATIC_DIR, "Processed_files")


def _resolve_processed_dir():
    return os.environ.get("CHROMA_PROCESSED_DIR") or DEFAULT_PROCESSED_DIR


def _normalize_source_file_key(value):
    return str(value or "").replace("\\", "/").strip().lstrip("/")


def _content_skips_ai_tagging(content):
    if not isinstance(content, dict):
        return False
    return bool(
        content.get("skipAiTagging") is True
        or content.get("manualCodingPreserved") is True
        or content.get("manualCodingPreservedReason") == "unmatched_file_after_partial_processing"
    )


class QwenSimilarSentence:
    def __init__(
        self,
        ollama_url=None,
        api_key=None,
        model=None,
        confidence_threshold=0.50,
        similarity_threshold=0.50,
        num_ctx=8192,
        processed_dir=None,
        allowed_source_files=None
    ):
        load_local_environment()
        _provider, env_base_url, env_model, env_api_key = resolve_llm_config()
        resolved_base_url = ollama_url or env_base_url
        resolved_api_key = api_key or env_api_key
        resolved_model = model or env_model
        
        self.NUM_CTX = num_ctx
        self.MODEL = resolved_model
        self.CONFIDENCE_THRESHOLD = confidence_threshold
        self.SIMILARITY_THRESHOLD = similarity_threshold
        self._processed_dir_override = processed_dir
        self.processed_dir = self._resolved_processed_dir()
        self.transcript_lines_source_path = None
        self.allowed_source_files = self._normalize_allowed_source_files(allowed_source_files)
        self.scanned_source_files = []
        self.participant_source_files = {}

        self.transcript_lines = []
        self.client = openai.OpenAI(
            base_url=resolved_base_url,
            api_key=resolved_api_key or "missing"
        )

    def _cancel_requested(self, cancel_event=None):
        return bool(cancel_event is not None and getattr(cancel_event, "is_set", lambda: False)())

    def _raise_if_cancelled(self, cancel_event=None):
        if self._cancel_requested(cancel_event):
            raise RuntimeError("similar_excerpt_cancelled")

    def _sleep_with_cancel(self, seconds, cancel_event=None):
        deadline = time.time() + max(0, float(seconds or 0))
        while time.time() < deadline:
            self._raise_if_cancelled(cancel_event)
            time.sleep(min(0.1, max(0, deadline - time.time())))

    def _resolved_processed_dir(self):
        return self._processed_dir_override or _resolve_processed_dir()

    def _normalize_allowed_source_files(self, allowed_source_files):
        if not allowed_source_files:
            return set()
        return {
            _normalize_source_file_key(source_file)
            for source_file in allowed_source_files
            if _normalize_source_file_key(source_file)
        }

    def set_allowed_source_files(self, allowed_source_files):
        normalized = self._normalize_allowed_source_files(allowed_source_files)
        if normalized != self.allowed_source_files:
            self.allowed_source_files = normalized
            self.transcript_lines = []
            self.transcript_lines_source_path = None
            self.scanned_source_files = []
            self.participant_source_files = {}

    def _normalize_participant_code(self, value):
        text = str(value or "").strip()
        if not text:
            return ""
        match = re.search(r"(?:^|[^A-Za-z0-9])(?:participant\s*|p[\s_-]*)0*(\d+)(?=$|[^A-Za-z0-9])", text, flags=re.IGNORECASE)
        return f"P{int(match.group(1))}" if match else ""

    def _source_file_matches_allowed_scope(self, file_key):
        if not self.allowed_source_files:
            return True
        return _normalize_source_file_key(file_key) in self.allowed_source_files

    def _reported_source_files(self):
        return list(self.scanned_source_files) or sorted(self.allowed_source_files, key=lambda value: value.lower())

    def _index_transcript_source_metadata(self, transcript_data):
        participant_source_files = {}
        if not isinstance(transcript_data, dict):
            self.participant_source_files = {}
            return

        for file_key, content in transcript_data.items():
            source_file = _normalize_source_file_key(
                content.get("sourceFile") if isinstance(content, dict) else ""
            ) or _normalize_source_file_key(file_key)
            if not source_file:
                continue
            participants = {participant_id_for_entry(file_key, content)}
            transcript = content.get("transcript") if isinstance(content, dict) else None
            if isinstance(transcript, list):
                for cue in transcript:
                    if not isinstance(cue, dict):
                        continue
                    participants.add(participant_id_for_entry(file_key, content, cue))

            for participant in participants:
                if participant:
                    participant_source_files.setdefault(participant, set()).add(source_file)

        self.participant_source_files = participant_source_files

    # Transcript Loader
    def extract_transcript_sentences(
        self):
        self.processed_dir = self._resolved_processed_dir()
        path = os.path.join(self.processed_dir, "all_transcripts_processed.json")
        path = os.path.abspath(path)
        self.transcript_lines = []
        self.transcript_lines_source_path = path

        with open(path, "r", encoding="utf-8") as f:
            transcript_data = json.load(f)
        self._index_transcript_source_metadata(transcript_data)

        for file_key, content in transcript_data.items():
            normalized_file_key = _normalize_source_file_key(file_key)
            if not self._source_file_matches_allowed_scope(normalized_file_key):
                continue
            if _content_skips_ai_tagging(content):
                continue
            transcript = content.get("transcript") if isinstance(content, dict) else None
            if not isinstance(transcript, list):
                continue
            for data in transcript:
                if not isinstance(data, dict):
                    continue
                is_question = str(data.get("tag") or "").startswith("Q")
                is_interviewer = data.get("speakerRole") == "interviewer" or data.get("speaker") == "Interviewer"
                if not is_interviewer and not is_question:
                    line = str(data.get("script") or "").strip()
                    if line:
                        self.transcript_lines.append({
                            **excerpt_source_metadata(file_key, content, data),
                            "text": line,
                            "speaker": data.get("speaker") or "Unknown",
                            "tag": data.get("tag", ""),
                        })
        self.scanned_source_files = sorted(
            {
                _normalize_source_file_key(line.get("source_file"))
                for line in self.transcript_lines
                if _normalize_source_file_key(line.get("source_file"))
            },
            key=lambda value: value.lower(),
        )
        print(f"Transcript: {self.transcript_lines}")
    # Chunk Generator
    def chunk_list(self, items, size):
        for i in range(0, len(items), size):
            yield items[i:i + size]

    # Ollama Batch Similarity
    def batch_similarity_ollama(
        self,
        query,
        summary,
        excerpts,
        sentences,
        max_retries=3,
        cancel_event=None
    ):
        sentences_block = ""
        for i, s in enumerate(sentences):
            s = s.replace('"', '\\"')
            sentences_block += f'  {{ "id": {i}, "text": "{s}" }},\n'

        prompt = f"""
                You are a semantic similarity evaluator.

                You will receive:
                - Theme: a query sentence
                - Theme_summary: a summary of the theme
                - Theme_excerpts: a list of current excerpts that were tagged as the theme
                - A list of Sentence_B items

                For EACH Sentence_B, return JSON in the format:

                {{
                "results": [
                    {{
                    "id": <int>,
                    "Theme": "which theme it belongs to",
                    "sentence": "<text>",
                    "similarity": <float>,
                    "confidence": <float>
                    }}
                ]
                }}

                Rules:
                - Output ONLY valid JSON
                - Similarity and confidence must be decimals from 0 to 1

                Theme: "{query}"
                Theme_summary: "{summary}"
                Theme_excerpts: "{excerpts}"

                Sentence_B_List:
                [
                {sentences_block}
                ]
"""

        for attempt in range(max_retries):
            try:
                self._raise_if_cancelled(cancel_event)
                response = self.client.chat.completions.create(
                    model=self.MODEL,
                    messages=[
                        {"role": "system", "content": "Respond ONLY with valid JSON. No explanations."},
                        {"role": "user", "content": prompt}
                    ],
                )
                self._raise_if_cancelled(cancel_event)

                raw = response.choices[0].message.content.strip()

                match = re.search(r"\{.*\}", raw, re.DOTALL)
                if not match:
                    print(f"[Retry] JSON not detected ({attempt+1})")
                    continue

                return json.loads(match.group(0))["results"]

            except Exception as e:
                msg = str(e)
                if "429" in msg:
                    wait = 2 + attempt * 2
                    print(f"[Rate Limited] Sleeping {wait}s...")
                    self._sleep_with_cancel(wait, cancel_event)
                else:
                    print(f"[Batch Error] {e}")
                    self._sleep_with_cancel(0.5, cancel_event)

        return []
    
    def save_to_output(self, theme, matches, themes_json_path, themes_data):
        def normalize(text):
            return re.sub(r'\s+', ' ', str(text or "")).strip().lower()

        existing_texts = {
            normalize(q.get("text") or q.get("word") or q.get("quote") or q.get("excerpt"))
            for q in themes_data[theme].get("quotes", [])
            if isinstance(q, dict)
        }

        new_quotes_added = 0
        for match in matches:
            text = match.get("sentence", "").strip()
            if not text:
                continue
            if normalize(text) in existing_texts:
                print(f"[Skip duplicate] {text[:60]}...")
                continue
            speaker_raw = match.get("speaker", "Unknown")
            participant = normalize_participant_id(match.get("participantId") or match.get("participant"))
            if not participant:
                participant = self._normalize_participant_code(match.get("source_file"))
            tag = match.get("tag", "")
            speaker_label = f"{speaker_raw} {tag}".strip() if tag else speaker_raw

            new_quote = {
                "speaker": speaker_label,
                "participant": participant,
                "participantId": participant,
                "text": text,
                "tag": tag,
                "timestamp": match.get("timestamp", ""),
                "source_file": match.get("source_file", ""),
                "sourceFile": match.get("sourceFile") or match.get("source_file", ""),
                "similarity": round(match.get("similarity", 0), 4),
                "confidence": round(match.get("confidence", 0), 4),
                "auto_generated": True,
                "ai_generated": True,
                "aiTagged": True,
                "codeSource": "ai",
                "source": "ai"
            }
            for field in ("segmentId", "startSeconds", "endSeconds", "speakerLabel", "speakerRole", "cueText"):
                if field in match:
                    new_quote[field] = match[field]

            themes_data[theme]["quotes"].append(new_quote)
            existing_texts.add(normalize(text))
            new_quotes_added += 1

        with open(themes_json_path, "w", encoding="utf-8") as f:
            json.dump(themes_data, f, indent=2, ensure_ascii=False)

        print(f"Saved {new_quotes_added} new quotes under '{theme}'")
        return new_quotes_added

    def _theme_source_files(self, theme_payload):
        source_files = set()
        participant_to_source_files = {
            participant: set(files)
            for participant, files in self.participant_source_files.items()
        }
        for line in self.transcript_lines:
            participant = normalize_participant_id(line.get("participantId") or line.get("participant"))
            if not participant:
                participant = self._normalize_participant_code(line.get("speaker"))
            source_file = _normalize_source_file_key(line.get("source_file"))
            if participant and source_file:
                participant_to_source_files.setdefault(participant, set()).add(source_file)

        for quote in theme_payload.get("quotes", []) if isinstance(theme_payload, dict) else []:
            if not isinstance(quote, dict):
                continue
            source_file = _normalize_source_file_key(
                quote.get("source_file")
                or quote.get("sourceFile")
                or quote.get("file_key")
                or quote.get("fileKey")
                or quote.get("filename")
                or quote.get("fileName")
                or quote.get("relativePath")
                or quote.get("transcriptFile")
            )
            if source_file:
                source_files.add(source_file)
                continue
            participant = (
                normalize_participant_id(quote.get("participantId") or quote.get("participant"))
                or self._normalize_participant_code(quote.get("speaker"))
            )
            if participant:
                source_files.update(participant_to_source_files.get(participant, set()))

        return sorted(source_files, key=lambda value: value.lower())

    def _normalize_theme_key(self, value):
        return re.sub(r"[^a-z0-9]+", " ", str(value or "").replace("_", " ").lower()).strip()

    def _resolve_theme_key(self, themes_data, requested_theme):
        if requested_theme in themes_data:
            return requested_theme

        requested_key = self._normalize_theme_key(requested_theme)
        for theme_key in themes_data.keys():
            if self._normalize_theme_key(theme_key) == requested_key:
                return theme_key

        titlecase_key = titlecase(requested_theme)
        if titlecase_key in themes_data:
            return titlecase_key

        titlecase_normalized = self._normalize_theme_key(titlecase_key)
        for theme_key in themes_data.keys():
            if self._normalize_theme_key(theme_key) == titlecase_normalized:
                return theme_key
        return None

   
    # Chunk Processing
    def process_theme_in_chunks(
        self,
        theme_name,
        summary,
        excerpts,
        transcript_lines,
        chunk_size = 8,
        progress_callback=None,
        cancel_event=None
    ):
        print("process_themes_in_chunks")
        all_results = []
        total_chunks = max(1, math.ceil(len(transcript_lines) / chunk_size))
        print(total_chunks)

        api_calls = 0
        if callable(progress_callback):
            progress_callback({
                "phase": "scanning",
                "message": "Scanning transcripts for semantically similar excerpts.",
                "processedChunks": 0,
                "totalChunks": total_chunks,
                "progressPercent": 0,
                "matchesFound": 0,
                "transcriptCount": len(transcript_lines),
                "sourceFiles": list(self.scanned_source_files),
            })
        for chunk_id, batch in enumerate(
            self.chunk_list(transcript_lines, chunk_size)
        ):
            self._raise_if_cancelled(cancel_event)
            print(f" → Chunk {chunk_id + 1}/{total_chunks}")
            batch_texts = [item["text"] for item in batch] 
            results = self.batch_similarity_ollama(
                theme_name,
                summary,
                excerpts,
                batch_texts,
                cancel_event=cancel_event
            )
            self._raise_if_cancelled(cancel_event)
            for r in results:
                idx = r.get("id", -1)
                if 0 <= idx < len(batch):
                    r["speaker"] = batch[idx]["speaker"] 
                    r["participant"] = batch[idx].get("participant", "")
                    r["tag"] = batch[idx]["tag"]
                    r["timestamp"] = batch[idx]["timestamp"]
                    r["source_file"] = batch[idx]["source_file"]
                    for field in ("segmentId", "participantId", "sourceFile", "startSeconds", "endSeconds", "speakerLabel", "speakerRole", "cueText"):
                        if field in batch[idx]:
                            r[field] = batch[idx][field]
                else:
                    print(f"[Warning] Result id {idx} out of batch range {len(batch)}, skipping metadata")

            all_results.extend(results)
            if callable(progress_callback):
                progress_callback({
                    "phase": "scanning",
                    "message": "Scanning transcripts for semantically similar excerpts.",
                    "processedChunks": chunk_id + 1,
                    "totalChunks": total_chunks,
                    "progressPercent": round(((chunk_id + 1) / total_chunks) * 95),
                    "matchesFound": len(all_results),
                    "transcriptCount": len(transcript_lines),
                    "sourceFiles": list(self.scanned_source_files),
                })
            self._sleep_with_cancel(0.5, cancel_event)

        filtered = [
            r for r in all_results
            if r.get("confidence", 0) >= self.CONFIDENCE_THRESHOLD
            and r.get("similarity", 0) >= self.SIMILARITY_THRESHOLD
        ]

        filtered.sort(
            key=lambda x: (x["confidence"], x["similarity"]),
            reverse=True
        )

        return filtered

 
    # Public API
    def find_similar_sentences(
        self,
        theme,
        chunk_size=2,
        progress_callback=None,
        cancel_event=None
    ):
        try:
            self._raise_if_cancelled(cancel_event)
        except RuntimeError:
            return {
                "theme": theme,
                "resolvedTheme": "",
                "matches": [],
                "matchCount": 0,
                "addedQuoteCount": 0,
                "reason": "cancelled",
                "cancelled": True,
                "sourceFiles": self._reported_source_files(),
                "codeSourceFiles": [],
            }
        self.processed_dir = self._resolved_processed_dir()
        transcripts_path = os.path.abspath(os.path.join(self.processed_dir, "all_transcripts_processed.json"))
        if (not self.transcript_lines) or (self.transcript_lines_source_path != transcripts_path):
            self.extract_transcript_sentences()
        try:
            self._raise_if_cancelled(cancel_event)
        except RuntimeError:
            return {
                "theme": theme,
                "resolvedTheme": "",
                "matches": [],
                "matchCount": 0,
                "addedQuoteCount": 0,
                "reason": "cancelled",
                "cancelled": True,
                "sourceFiles": self._reported_source_files(),
                "codeSourceFiles": [],
            }

        themes_json_path = os.path.abspath(os.path.join(self.processed_dir, "ai_generated.json"))

        with open(themes_json_path, "r", encoding="utf-8") as f:
            themes_data = json.load(f)
        
        requested_theme = theme
        theme = self._resolve_theme_key(themes_data, requested_theme)
        if not theme:
            print(f"Theme '{requested_theme}' is missing. Available keys: {list(themes_data.keys())}")
            return {
                "theme": requested_theme,
                "resolvedTheme": "",
                "matches": [],
                "matchCount": 0,
                "addedQuoteCount": 0,
                "reason": "theme_not_found",
                "sourceFiles": self._reported_source_files(),
                "codeSourceFiles": [],
            }

        theme_payload = themes_data.get(theme) if isinstance(themes_data.get(theme), dict) else {}
        code_source_files = self._theme_source_files(theme_payload)
        if not self.transcript_lines:
            return {
                "theme": requested_theme,
                "resolvedTheme": theme,
                "matches": [],
                "matchCount": 0,
                "addedQuoteCount": 0,
                "reason": "no_current_uploaded_transcripts",
                "sourceFiles": self._reported_source_files(),
                "codeSourceFiles": code_source_files,
            }
        summary = str(theme_payload.get("summary") or "")
        excerpts = [
            str(q.get("text") or q.get("word") or q.get("quote") or q.get("excerpt") or "").strip()
            for q in theme_payload.get("quotes", [])
            if isinstance(q, dict)
        ]

        try:
            matches = self.process_theme_in_chunks(
                theme,
                summary,
                excerpts,
                self.transcript_lines,
                chunk_size=chunk_size,
                progress_callback=progress_callback,
                cancel_event=cancel_event
            )
        except RuntimeError as exc:
            if str(exc) == "similar_excerpt_cancelled":
                return {
                    "theme": requested_theme,
                    "resolvedTheme": theme,
                    "matches": [],
                    "matchCount": 0,
                    "addedQuoteCount": 0,
                    "reason": "cancelled",
                    "cancelled": True,
                    "sourceFiles": self._reported_source_files(),
                    "codeSourceFiles": code_source_files,
                }
            raise
        print(f"Matches:{matches}")
        added_count = 0
        try:
            self._raise_if_cancelled(cancel_event)
        except RuntimeError:
            return {
                "theme": requested_theme,
                "resolvedTheme": theme,
                "matches": matches,
                "matchCount": len(matches),
                "addedQuoteCount": 0,
                "reason": "cancelled",
                "cancelled": True,
                "sourceFiles": self._reported_source_files(),
                "codeSourceFiles": code_source_files,
            }
        if matches:
            added_count = self.save_to_output(theme, matches, themes_json_path, themes_data)
        return {
            "theme": requested_theme,
            "resolvedTheme": theme,
            "matches": matches,
            "matchCount": len(matches),
            "addedQuoteCount": added_count,
            "sourceFiles": self._reported_source_files(),
            "codeSourceFiles": code_source_files,
        }

"""
if __name__ == "__main__":
    theme = "Research Background and Experience"
    qwenObj = QwenSimilarSentence()
    qwenObj.find_similar_sentences(theme)
"""
