import json
import re
import os
import random
import time
from difflib import SequenceMatcher
from openai import OpenAI
from collections import defaultdict
from processing_scripts.llm_config import resolve_llm_config, llm_endpoint_ready
from config import load_local_environment, settings
from services.storage import _atomic_write_json, _atomic_write_text
from processing_scripts.excerpt_confidence import read_model_confidence
from processing_scripts.theme_generation_schema import theme_generation_response_format
from processing_scripts.transcriptIdentity import (
    excerpt_source_metadata,
    legacy_participant_id,
    normalize_participant_id,
    participant_display_label,
    participant_id_for_entry,
)
try:
    from titlecase import titlecase
except Exception:
    def titlecase(value):
        return str(value or "").title()

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, os.pardir))
INTERMEDIATE_DIR = str(settings.data_dir / "intermediate_files")
STATIC_DIR = str(settings.data_dir / "static")
PROCESSED_DIR = os.path.join(STATIC_DIR, "Processed_files")
# Leave room for GPT-OSS reasoning and the complete structured code response.
GROQ_CODE_GENERATION_MAX_TOKENS = 16384

load_local_environment()


def _resolve_processed_dir():
    return os.environ.get("CHROMA_PROCESSED_DIR") or PROCESSED_DIR


def _resolve_intermediate_dir():
    return os.environ.get("CHROMA_INTERMEDIATE_DIR") or INTERMEDIATE_DIR


def _normalize_quote_tag(raw_value):
    text = str(raw_value or "").strip()
    if not text:
        return ""
    match = re.search(r"\b([QA])\s*0*(\d+)([A-Za-z]?)\b", text, flags=re.IGNORECASE)
    if not match:
        return ""
    return f"{match.group(1).upper()}{int(match.group(2))}{match.group(3).lower()}"


def _normalize_participant_code(raw_value):
    return legacy_participant_id(raw_value)


def _content_skips_ai_tagging(content):
    if not isinstance(content, dict):
        return False
    return bool(
        content.get("skipAiTagging") is True
        or content.get("manualCodingPreserved") is True
        or content.get("manualCodingPreservedReason") == "unmatched_file_after_partial_processing"
    )


class Qwen:
    def __init__(self, processed_dir=None, intermediate_dir=None):
        self.themes_dict = {}
        self.themes = []
        self._themes_cache_signature = None
        self._processed_dir_override = processed_dir
        self._intermediate_dir_override = intermediate_dir
        self.LLM_PROVIDER, self.LM_BASE_URL, self.LM_MODEL, self.LM_API_KEY = self._resolve_llm_runtime_config()
        self.client = OpenAI(
            base_url=self.LM_BASE_URL,
            api_key=self.LM_API_KEY or "missing",
        )
        print(f"[LLM] provider={self.LLM_PROVIDER} model={self.LM_MODEL} base_url={self.LM_BASE_URL}")
    """
    Fictional transcript-format example:
    {
        "demo_participant.txt": {
            "date": "unknown",
            "audiofile": "demo_audio.m4a",
            "transcript": [
                {
                    "speaker": "Interviewer",
                    "timestamp": "00:00",
                    "script": "This fictional sentence demonstrates the transcript format.",
                    "tag": null
                }
            ]
        }
    }
    """

    def _normalize_base_url_v1(self, raw_url: str | None, default_url: str) -> str:
        url = (raw_url or default_url).strip().rstrip("/")
        if url.endswith("/v1"):
            return url
        return f"{url}/v1"

    def _resolve_llm_runtime_config(self):
        return resolve_llm_config()

    def _is_groq_json_validation_error(self, error: Exception) -> bool:
        if self.LLM_PROVIDER != "groq" or getattr(error, "status_code", None) != 400:
            return False
        if getattr(error, "code", None) == "json_validate_failed":
            return True

        body = getattr(error, "body", None)
        if not isinstance(body, dict):
            return False
        if body.get("code") == "json_validate_failed":
            return True
        nested_error = body.get("error")
        return isinstance(nested_error, dict) and nested_error.get("code") == "json_validate_failed"

    def _llm_should_retry(self, err: Exception) -> bool:
        status = getattr(err, "status_code", None)
        if status in (429, 500, 502, 503, 504):
            return True
        msg = str(err).lower()
        return "429" in msg or "too many requests" in msg or "rate limit" in msg

    def _llm_retry_delay_seconds(self, err: Exception, attempt: int) -> float:
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
        empty_retries = 0
        max_empty_retries = 2
        attempt = 0
        current_messages = list(messages)
        response = None

        while attempt < max_attempts:
            attempt += 1
            kwargs = {"model": self.LM_MODEL, "messages": current_messages}
            response_format = theme_generation_response_format(self.LLM_PROVIDER, self.LM_MODEL)
            if response_format is not None:
                kwargs["response_format"] = response_format
            max_tokens = (os.environ.get("LLM_MAX_TOKENS") or "").strip()
            if max_tokens.isdigit():
                kwargs["max_tokens"] = int(max_tokens)
            elif response_format is not None:
                kwargs["max_tokens"] = GROQ_CODE_GENERATION_MAX_TOKENS

            try:
                response = self.client.chat.completions.create(**kwargs)
            except Exception as e:
                if self._is_groq_json_validation_error(e):
                    raise RuntimeError(
                        "Groq could not produce valid JSON for code generation. "
                        "Increase LLM_MAX_TOKENS within your model's limit or use a smaller transcript, then retry. "
                        "Your previous analysis has been kept."
                    ) from None
                if (attempt >= max_attempts) or (not self._llm_should_retry(e)):
                    raise
                delay = self._llm_retry_delay_seconds(e, attempt)
                print(f"[WARN] {context} temporary error (attempt {attempt}/{max_attempts}). Retrying in {delay:.1f}s...")
                time.sleep(delay)
                continue

            choice = response.choices[0] if response.choices else None
            content = (getattr(getattr(choice, "message", None), "content", None) or "").strip()
            finish_reason = getattr(choice, "finish_reason", None)
            if content or finish_reason == "length":
                return response
            print(f"[WARN] {context}: model returned empty content "
                  f"(finish_reason={finish_reason}, retry {empty_retries + 1}/{max_empty_retries}).")
            if empty_retries >= max_empty_retries:
                print(f"[Error] {context}: model kept returning empty content. "
                      f"Try a larger LLM_MAX_TOKENS or a different LLM_MODEL.")
                return response
            empty_retries += 1
            current_messages = [
                {"role": "system", "content": "Give the final answer directly in the requested format. Keep any internal reasoning very brief."}
            ] + list(messages)

        return response

    def _generated_response_text(self, response):
        choices = getattr(response, "choices", None) or []
        if not choices:
            raise RuntimeError(
                "The AI provider returned no completion for code generation. "
                "Your previous analysis has been kept. Please retry."
            )

        choice = choices[0]
        if getattr(choice, "finish_reason", None) == "length":
            raise RuntimeError(
                "The AI response was cut off at the output token limit. "
                "Increase LLM_MAX_TOKENS within your model's limit or use a smaller transcript, then retry. "
                "Your previous analysis has been kept."
            )

        content = getattr(getattr(choice, "message", None), "content", None)
        if not isinstance(content, str) or not content.strip():
            raise RuntimeError(
                "The AI provider returned an empty final response for code generation. "
                "Check the selected model and output token limit, then retry. "
                "Your previous analysis has been kept."
            )
        return content

    def _llm_ready(self) -> bool:
        if self.LM_API_KEY == "missing":
            print("[Error] Missing LLM_API_KEY (or RIT_GENAI_API_KEY) in your .env.")
            return False
        ok, err = llm_endpoint_ready(self.client)
        if not ok:
            print(
                f"[Error] LLM endpoint is not reachable (provider={self.LLM_PROVIDER}, "
                f"model={self.LM_MODEL}, base_url={self.LM_BASE_URL}): {err}"
            )
        return ok

    def _resolved_processed_dir(self):
        return self._processed_dir_override or _resolve_processed_dir()

    def _resolved_intermediate_dir(self):
        return self._intermediate_dir_override or _resolve_intermediate_dir()

    def _themes_generation_input_path(self):
        return os.path.join(self._resolved_intermediate_dir(), "themes_generation_input.txt")

    def _themes_generation_output_path(self):
        return os.path.join(self._resolved_intermediate_dir(), "themes_generation_output.txt")

    def _themes_generation_more_output_path(self):
        return os.path.join(self._resolved_intermediate_dir(), "themes_generation_more_output.txt")

        # ---------- Model-agnostic theme output parsing ----------

    _THEME_HEADER_RE = re.compile(
        r"^(?:theme|code|category)\s*(?:#\s*)?(?:\d+|[ivxlc]+)?\s*(?:[:.)\-]\s*(.+))?$",
        re.IGNORECASE,
    )
    _TITLE_RE = re.compile(r"^(?:title|name)\s*[:\-]\s*(.+)$", re.IGNORECASE)
    _SUMMARY_RE = re.compile(r"^(?:summary|description|explanation|definition)\s*[:\-]\s*(.*)$", re.IGNORECASE)
    _QUOTES_HEADER_RE = re.compile(r"^(?:quotes?|excerpts?|supporting\s+quotes?|evidence)\s*:?\s*$", re.IGNORECASE)
    _QUOTE_COLON_RE = re.compile(
        r"^((?:participant|respondent|interviewee)\s*[^:]{1,40}?|P\s*\d+[A-Za-z]?(?:\s+A\d+[A-Za-z]?)?)\s*:\s*(.+)$",
        re.IGNORECASE,
    )
    _QUOTE_DASH_RE = re.compile(
        r"^((?:participant\s*|P\s*)\d+[A-Za-z]?(?:\s+A\d+[A-Za-z]?)?)\s+-\s+(.+)$",
        re.IGNORECASE,
    )
    _QUOTE_TRAILING_RE = re.compile(
        r'^"(.+?)"\s*(?:-|\()\s*((?:participant\s*|P\s*)\w+(?:\s+A\d+[A-Za-z]?)?)\)?\s*$',
        re.IGNORECASE,
    )

    def _strip_reasoning(self, output_text):
        text = str(output_text or "")
        text = re.sub(r"<(think|thinking|reasoning|analysis)>.*?</\1>", "", text, flags=re.DOTALL | re.IGNORECASE)
        text = re.sub(r"<\|[^|>]*\|>", "", text)  # leaked special tokens
        return text.strip()

    def _normalize_output_line(self, raw_line):
        line = str(raw_line or "").strip()
        line = (line.replace("\u2013", "-").replace("\u2014", "-").replace("\uff1a", ":")
                    .replace("\u201c", '"').replace("\u201d", '"').replace("\u2019", "'"))
        line = re.sub(r"^(?:[#>]+\s*)+", "", line)                 # headings / blockquotes
        line = re.sub(r"\*\*|__|`", "", line)                        # bold / code
        line = re.sub(r"^\s*(?:[-+*\u2022\u00b7]|\d+[.)])\s+", "", line)  # bullets / numbered lists
        line = re.sub(r"(?<!\w)\*(?!\s)|(?<!\s)\*(?!\w)", "", line)  # leftover italics
        return line.strip()

    def _canonical_speaker(self, speaker):
        speaker = re.sub(r"\s+", " ", str(speaker or "")).strip()
        match = re.match(r"^P\s*(\d+[A-Za-z]?)(.*)$", speaker, flags=re.IGNORECASE)
        if match:
            return f"Participant {match.group(1)}{match.group(2)}".strip()
        return speaker

    def _split_quote_line(self, line):
        for pattern, speaker_group, text_group in (
            (self._QUOTE_COLON_RE, 1, 2),
            (self._QUOTE_DASH_RE, 1, 2),
            (self._QUOTE_TRAILING_RE, 2, 1),
        ):
            match = pattern.match(line)
            if match:
                text = match.group(text_group).strip().strip('"').strip()
                return self._canonical_speaker(match.group(speaker_group)), text
        return "", ""

    def _theme_items_from_json(self, data):
        if not isinstance(data, dict):
            return data
        if any(key in data for key in ("title", "theme", "name")):
            return [data]

        items = data.get("themes") or data.get("codes") or data.get("results")
        if items is not None:
            return items

        # Some providers return an object keyed by code name instead of a list.
        return [
            {"title": title, **content}
            for title, content in data.items()
            if isinstance(content, dict)
            and any(key in content for key in ("summary", "description", "quotes", "excerpts"))
        ]

    def _parse_generated_quote(self, raw_quote):
        if isinstance(raw_quote, dict):
            speaker = self._canonical_speaker(raw_quote.get("speaker") or raw_quote.get("participant") or "")
            quote_text = str(raw_quote.get("text") or raw_quote.get("quote") or "").strip().strip('"')
        else:
            speaker, quote_text = self._split_quote_line(self._normalize_output_line(raw_quote))
            if not quote_text:
                quote_text = str(raw_quote).strip().strip('"')
        if not quote_text:
            return None

        quote = {"speaker": speaker, "text": quote_text, "ai_generated": True}
        confidence = raw_quote.get("confidence") if isinstance(raw_quote, dict) else None
        has_model_confidence = (
            isinstance(confidence, (int, float))
            and not isinstance(confidence, bool)
            and 0 <= confidence <= 1
        )
        if has_model_confidence:
            quote["confidence"] = float(confidence)
            quote["confidenceSource"] = "model_self_reported"
        return quote

    def _parse_theme_json_items(self, items):
        if not isinstance(items, list):
            return None

        themes_dict, themes = {}, []
        for item in items:
            if not isinstance(item, dict):
                continue
            title = str(
                item.get("title") or item.get("theme") or item.get("name") or item.get("code") or ""
            ).strip()
            if not title:
                continue

            quotes = []
            for raw_quote in item.get("quotes") or item.get("excerpts") or []:
                quote = self._parse_generated_quote(raw_quote)
                if quote is not None:
                    quotes.append(quote)
            summary = str(item.get("summary") or item.get("description") or "").strip()
            themes_dict[title] = {"summary": summary, "quotes": quotes}
            if title not in themes:
                themes.append(title)
        return (themes_dict, themes) if themes else None

    def _parse_theme_json(self, text):
        candidates = re.findall(r"```(?:json)?\s*(.*?)```", text, flags=re.DOTALL | re.IGNORECASE)
        candidates.append(text)
        for candidate in candidates:
            for opener, closer in (("{", "}"), ("[", "]")):
                start, end = candidate.find(opener), candidate.rfind(closer)
                if start == -1 or end <= start:
                    continue
                try:
                    data = json.loads(candidate[start:end + 1])
                except Exception:
                    continue

                items = self._theme_items_from_json(data)
                parsed_themes = self._parse_theme_json_items(items)
                if parsed_themes:
                    return parsed_themes
        return None

    def _parse_theme_text(self, text):
        themes_dict, themes = {}, []
        state = {"title": None, "summary": "", "quotes": []}
        pending_title = False
        pending_summary = False

        def flush():
            title = (state["title"] or "").strip()
            if title:
                themes_dict[title] = {"summary": state["summary"].strip(), "quotes": state["quotes"]}
                if title not in themes:
                    themes.append(title)

        for raw_line in text.splitlines():
            line = self._normalize_output_line(raw_line)
            if not line:
                continue

            if pending_title:
                title_match = self._TITLE_RE.match(line)
                state["title"] = (title_match.group(1) if title_match else line).strip()
                pending_title = False
                continue

            header = self._THEME_HEADER_RE.match(line)
            if header:
                flush()
                state = {"title": None, "summary": "", "quotes": []}
                pending_summary = False
                if header.group(1):
                    state["title"] = header.group(1).strip()
                else:
                    pending_title = True
                continue

            if not state["title"]:
                continue

            summary_match = self._SUMMARY_RE.match(line)
            if summary_match:
                state["summary"] = summary_match.group(1).strip()
                pending_summary = not state["summary"]
                continue

            if self._QUOTES_HEADER_RE.match(line):
                pending_summary = False
                continue

            speaker, quote_text = self._split_quote_line(line)
            if quote_text:
                state["quotes"].append({"speaker": speaker, "text": quote_text, "ai_generated": True})
                pending_summary = False
                continue

            if pending_summary:
                state["summary"] = line
                pending_summary = False

        flush()
        return themes_dict, themes

    def _parse_theme_generation_output(self, output_text):
        text = self._strip_reasoning(output_text)
        parsed = self._parse_theme_json(text)
        if parsed:
            return parsed
        return self._parse_theme_text(text)

    def _require_generated_themes(self, output_text):
        themes_dict, themes = self._parse_theme_generation_output(output_text)
        valid_themes = bool(themes) and all(
            content.get("summary") or content.get("quotes")
            for content in themes_dict.values()
        )
        if not valid_themes:
            raise RuntimeError(
                "The AI response did not contain readable codes. "
                "Your previous analysis has been kept. Please retry."
            )
        return themes_dict, themes

    def _normalize_theme_key(self, raw_value):
        return re.sub(r"\s+", " ", str(raw_value or "").replace("_", " ").replace("&", "and").strip()).lower()

    def _is_manual_quote_entry(self, quote):
        if not isinstance(quote, dict):
            return False
        source = str(quote.get("codeSource") or quote.get("source") or quote.get("tagSource") or "").strip().lower()
        return source in {"manual", "human"} or quote.get("ai_generated") is False

    def _quote_identity_key(self, quote):
        if not isinstance(quote, dict):
            return ""
        text = str(quote.get("text") or quote.get("word") or quote.get("quote") or quote.get("excerpt") or "").strip().lower()
        speaker = str(quote.get("speaker") or "").strip().lower()
        participant = str(quote.get("participant") or "").strip().lower()
        tag = str(quote.get("tag") or "").strip().lower()
        timestamp = str(quote.get("timestamp") or "").replace(" ", "").strip().lower()
        cue_text = str(quote.get("cueText") or "").strip().lower()
        segment_id = str(quote.get("segmentId") or "")
        return "||".join([text, speaker, participant, tag, timestamp, cue_text, segment_id])

    def _merge_existing_manual_code_entries(self, output_json_path):
        if not os.path.exists(output_json_path):
            return
        try:
            with open(output_json_path, "r", encoding="utf-8") as f:
                existing_payload = json.load(f)
        except (OSError, ValueError) as error:
            raise RuntimeError("Existing codes could not be read. They have not been replaced.") from error
        if not isinstance(existing_payload, dict):
            raise RuntimeError("Existing codes have an invalid format. They have not been replaced.")

        normalized_theme_lookup = {
            self._normalize_theme_key(theme_name): theme_name
            for theme_name in self.themes_dict.keys()
        }
        preserved_quote_count = 0
        preserved_theme_count = 0
        for existing_theme_name, existing_theme_payload in existing_payload.items():
            if not isinstance(existing_theme_payload, dict):
                continue
            manual_quotes = [
                quote for quote in existing_theme_payload.get("quotes", []) or []
                if self._is_manual_quote_entry(quote)
            ]
            manual_code = self._is_manual_quote_entry(existing_theme_payload)
            if not manual_quotes and not manual_code:
                continue

            normalized_key = self._normalize_theme_key(existing_theme_name)
            target_theme_name = normalized_theme_lookup.get(normalized_key)
            if not target_theme_name:
                self.themes_dict[existing_theme_name] = {
                    **existing_theme_payload,
                    "quotes": manual_quotes,
                }
                if existing_theme_name not in self.themes:
                    self.themes.append(existing_theme_name)
                normalized_theme_lookup[normalized_key] = existing_theme_name
                preserved_theme_count += 1
                preserved_quote_count += len(manual_quotes)
                continue

            target_theme = self.themes_dict.setdefault(target_theme_name, {"summary": "", "quotes": []})
            if manual_code:
                for key in ("summary", "color", "comment", "groups", "ai_generated", "codeSource"):
                    if key in existing_theme_payload:
                        target_theme[key] = existing_theme_payload[key]
            target_quotes = target_theme.setdefault("quotes", [])
            seen_quote_keys = {self._quote_identity_key(quote) for quote in target_quotes}
            for quote in manual_quotes:
                quote_key = self._quote_identity_key(quote)
                if quote_key and quote_key in seen_quote_keys:
                    continue
                target_quotes.append(quote)
                if quote_key:
                    seen_quote_keys.add(quote_key)
                preserved_quote_count += 1

        if preserved_quote_count or preserved_theme_count:
            print(
                "[DEBUG] Preserved manual code entries during theme generation: "
                f"quotes={preserved_quote_count}, themes={preserved_theme_count}"
            )
    
    def extract_answers_by_tag(self):
        # Use the participant chosen during import, including nonnumeric IDs.
        processed_dir = self._resolved_processed_dir()
        input_path = self._themes_generation_input_path()
        transcripts_json_path = os.path.join(processed_dir, "all_transcripts_processed.json")
        print(f"[DEBUG] Loading transcripts from: {transcripts_json_path} (exists={os.path.exists(transcripts_json_path)})")
        with open(transcripts_json_path, "r", encoding="utf-8") as f: 
            transcript_data = json.load(f)
        print(f"[DEBUG] Loaded {len(transcript_data)} transcript key(s) from processed JSON")

        answers_by_participant = defaultdict(list)
        for filename, content in transcript_data.items():
            if _content_skips_ai_tagging(content):
                continue
            for entry in content.get("transcript", []):
                tag = str(entry.get("tag") or "")
                script = str(entry.get("script") or "").strip()
                if tag.startswith("A") and script:
                    participant_id = participant_id_for_entry(filename, content, entry)
                    key = f"{participant_display_label(participant_id)} {tag}"
                    answers_by_participant[key].append(script)

        input_data = {
            label: "\n".join(answers)
            for label, answers in answers_by_participant.items()
        }

        # Write to file as JSON
        os.makedirs(os.path.dirname(input_path), exist_ok=True)
        print(f"[DEBUG] Writing extracted answers to: {input_path} (keys={len(input_data)})")
        with open(input_path, "w", encoding="utf-8") as f:
            json.dump(input_data, f, indent=2, ensure_ascii=False)


    def qwenModel(self):
        self.themes_dict = {}
        self.themes = []
        transcript_path = self._themes_generation_input_path()
        output_text_path = self._themes_generation_output_path()
        print(f"[DEBUG] Reading transcript from: {transcript_path}")
        if not os.path.isfile(transcript_path):
            raise RuntimeError("No transcript input is available for code generation. Your previous analysis has been kept.")

        size_bytes = os.path.getsize(transcript_path)
        print(f"[DEBUG] newInput.txt size: {size_bytes} bytes")
        print(f"[DEBUG] Output text path: {output_text_path}")
        processed_dir = self._resolved_processed_dir()
        output_json_path = os.path.join(processed_dir, "ai_generated.json")
        os.makedirs(processed_dir, exist_ok=True) 
        print(f"[DEBUG] Output JSON path: {output_json_path}")
        print(f"[DEBUG] processed_dir exists: {os.path.exists(processed_dir)}")

        # Step 1: Read the transcript
        with open(transcript_path, "r", encoding="utf-8") as f:
            transcript = f.read()

        if not transcript.strip() or transcript.strip() in {"{}", "[]"}:
            raise RuntimeError("No tagged answers are available for code generation. Your previous analysis has been kept.")

        # Step 2: Prompt
        prompt = f"""
        Please analyze the following interview transcript using qualitative thematic analysis. Identify 5–6 distinct themes. For each theme:

        1. Provide a clear, concise theme title.
        2. Write a two to three sentences summary explaining the theme.
        3. List **all exact quotes** from the transcript that relate to the theme. Quotes must remain 100% unchanged from the transcript.
        4. Start each quote with the speaker ID (e.g., Participant <id>: <quote>). Do not truncate quote

        Return only JSON with this structure:
        {{"themes": [{{"title": "Code title", "summary": "Code description", "quotes": [
            {{"speaker": "Participant <id>", "text": "Exact transcript quote", "confidence": 0.7}}
        ]}}]}}

        For each quote, provide confidence as a number from 0 to 1 expressing your
        self-rating of how well that quote supports the code. This is a model rating,
        not a calibrated probability of correctness. Use only unchanged transcript
        quotes; do not invent or paraphrase them. Do not include commentary or <think> tags.

        Transcript:
        {transcript}
        """

        # Step 3: Verify configured LLM endpoint is available.
        if not self._llm_ready():
            raise RuntimeError(
                f"LLM provider '{self.LLM_PROVIDER}' is not reachable "
                f"(model={self.LM_MODEL}, base_url={self.LM_BASE_URL})."
            )

        # Step 4: Generate completion
        response = self._chat_with_retry(
            messages=[{"role": "user", "content": prompt}],
            context="Theme generation",
        )

        output_text = self._generated_response_text(response)

        # Validate before replacing any saved analysis.
        self.themes_dict, self.themes = self._require_generated_themes(output_text)
        self._hydrate_quotes_from_transcripts()
        self._merge_existing_manual_code_entries(output_json_path)

        # Step 6: Write output
        print(f"[DEBUG] Writing ai_generated.json to: {output_json_path}")
        print(f"[DEBUG] themes_dict size: {len(self.themes_dict)} themes")
        _atomic_write_text(output_text_path, output_text)
        _atomic_write_json(output_json_path, self.themes_dict)

        print(f"[DEBUG] ai_generated.json written successfully: {output_json_path}")
        print(f"[DEBUG] file exists after write: {os.path.exists(output_json_path)}")
        print("Parsed output saved to 'ai_generated.json'")
        return self.themes

    def generate_more_themes(self, existing_theme_names=None, count=5):
        transcript_path = self._themes_generation_input_path()
        output_text_path = self._themes_generation_more_output_path()
        processed_dir = self._resolved_processed_dir()
        output_json_path = os.path.join(processed_dir, "ai_generated.json")
        os.makedirs(processed_dir, exist_ok=True)

        if not os.path.isfile(transcript_path):
            print("[DEBUG] themes_generation_input.txt not found. Run extract_answers_by_tag() first.")
            return []

        with open(transcript_path, "r", encoding="utf-8") as f:
            transcript = f.read()

        if not transcript.strip():
            print("[DEBUG] Theme generation input is empty. No additional codes can be generated.")
            return []

        existing_payload = {}
        if os.path.exists(output_json_path):
            try:
                with open(output_json_path, "r", encoding="utf-8") as f:
                    loaded_payload = json.load(f)
                if isinstance(loaded_payload, dict):
                    existing_payload = loaded_payload
            except (OSError, ValueError) as error:
                raise RuntimeError("Existing codes could not be read. They have not been replaced.") from error
            if not isinstance(loaded_payload, dict):
                raise RuntimeError("Existing codes have an invalid format. They have not been replaced.")

        try:
            requested_count = int(count)
        except (TypeError, ValueError):
            requested_count = 5
        requested_count = max(1, min(10, requested_count))

        existing_names = [
            str(name or "").strip()
            for name in [*(existing_theme_names or []), *existing_payload.keys()]
            if str(name or "").strip()
        ]
        existing_names = list(dict.fromkeys(existing_names))
        existing_code_list = "\n".join(f"- {name}" for name in existing_names) or "- None yet"

        prompt = f"""
        Please analyze the following interview transcript using qualitative thematic analysis.
        Generate {requested_count} additional distinct code suggestions that are not already covered by the existing codes.

        Existing codes to avoid:
        {existing_code_list}

        Requirements:
        1. Do not repeat, rename, or lightly reword an existing code.
        2. Prefer important ideas that are underrepresented by the existing codes.
        3. For each new code, provide a clear, concise code title.
        4. Write a two to three sentences summary explaining the code.
        5. List exact quotes from the transcript that support the code. Quotes must remain 100% unchanged from the transcript.
        6. Start each quote with the speaker ID (e.g., Participant <id>: <quote>). Do not truncate quotes.

        Return only JSON with this structure:
        {{"themes": [{{"title": "New code title", "summary": "Code description", "quotes": [
            {{"speaker": "Participant <id>", "text": "Exact transcript quote", "confidence": 0.7}}
        ]}}]}}

        For each quote, provide confidence as a number from 0 to 1 expressing your
        self-rating of how well that quote supports the code. This is a model rating,
        not a calibrated probability of correctness. Do not include commentary or <think> tags.

        Transcript:
        {transcript}
        """

        if not self._llm_ready():
            raise RuntimeError(
                f"LLM provider '{self.LLM_PROVIDER}' is not reachable "
                f"(model={self.LM_MODEL}, base_url={self.LM_BASE_URL})."
            )

        response = self._chat_with_retry(
            messages=[{"role": "user", "content": prompt}],
            context="Additional code generation",
        )
        output_text = self._generated_response_text(response)

        new_themes_dict, new_themes = self._require_generated_themes(output_text)

        self.themes_dict = new_themes_dict
        self.themes = new_themes
        self._hydrate_quotes_from_transcripts()
        hydrated_new_payload = dict(self.themes_dict)

        existing_normalized = {
            self._normalize_theme_key(theme_name)
            for theme_name in existing_names
        }
        added_theme_names = []
        for theme_name, theme_payload in hydrated_new_payload.items():
            normalized_name = self._normalize_theme_key(theme_name)
            if not normalized_name or normalized_name in existing_normalized:
                continue
            payload = theme_payload if isinstance(theme_payload, dict) else {}
            payload.setdefault("summary", "")
            payload["quotes"] = payload.get("quotes", []) if isinstance(payload.get("quotes"), list) else []
            payload["ai_generated"] = True
            existing_payload[theme_name] = payload
            existing_normalized.add(normalized_name)
            added_theme_names.append(theme_name)

        if not added_theme_names:
            print("[DEBUG] Additional generation returned only duplicate code names.")
            return []

        _atomic_write_text(output_text_path, output_text)
        _atomic_write_json(output_json_path, existing_payload)

        self.themes_dict = existing_payload
        self.themes = list(existing_payload.keys())
        self._themes_cache_signature = None
        print(f"[DEBUG] Added {len(added_theme_names)} additional codes to {output_json_path}")
        return added_theme_names
    
    def update_themes_dict_with_new_quotes_given_theme(self, theme, quotes):
        processed_dir = self._resolved_processed_dir()
        output_json_path = os.path.join(processed_dir, "ai_generated.json")
        self._refresh_themes_cache_from_output(force_reload=True, output_json_path=output_json_path)
        theme = titlecase(theme)
        if theme not in self.themes_dict:
            self.themes_dict[theme] = {"summary": "AI generated", "quotes": []}
            if theme not in self.themes:
                self.themes.append(theme)

        for quote in quotes:
            #self.themes_dict[theme]["summary"] = "AI generated"
            self.themes_dict[theme]["quotes"].append({"speaker": "AI", "text": quote})
       
        try:
            with open(output_json_path, "w", encoding="utf-8") as f:
                json.dump(self.themes_dict, f, indent=2, ensure_ascii=False)
        except Exception as e:
            print(f"[WARN] Could not persist updated quotes to ai_generated.json: {e}")
    
    def _hydrate_quotes_from_transcripts(self):
        try:
            processed_dir = self._resolved_processed_dir()
            transcripts_json_path = os.path.join(processed_dir, "all_transcripts_processed.json")
            with open(transcripts_json_path, "r", encoding="utf-8") as f:
                transcript_data = json.load(f)
        except Exception as e:
            print(f"[WARN] Could not load transcripts for quote hydration: {e}")
            return

        by_tag = {}
        by_speaker = {}
        for filename, content in transcript_data.items():
            if _content_skips_ai_tagging(content):
                continue
            for entry in content.get("transcript", []):
                participant_id = participant_id_for_entry(filename, content, entry)
                tag = str(entry.get("tag") or "").strip()
                script = str(entry.get("script") or "").strip()
                if not script:
                    continue
                source_entry = {
                    **excerpt_source_metadata(filename, content, entry),
                    "tag": tag,
                    "text": script,
                }
                if tag:
                    by_tag.setdefault((participant_id, tag), []).append(source_entry)
                if entry.get("speakerRole") != "interviewer" and entry.get("speaker") != "Interviewer":
                    by_speaker.setdefault(participant_id, []).append(source_entry)

        for theme_name, theme_data in self.themes_dict.items():
            expanded_quotes = []
            seen = set()
            original_quotes = theme_data.get("quotes", [])

            for quote in original_quotes:
                quote_payload = quote if isinstance(quote, dict) else {"text": quote}
                speaker_raw = str(quote_payload.get("speaker", "")).strip()
                text_raw = str(quote_payload.get("text", "")).strip().strip('"')
                speaker_id, answer_tag = self._parse_speaker_token(speaker_raw)
                explicit_participant = normalize_participant_id(
                    quote_payload.get("participantId") or quote_payload.get("participant")
                )
                speaker_id = explicit_participant or speaker_id
                answer_tag = _normalize_quote_tag(quote_payload.get("tag")) or answer_tag
                model_confidence = read_model_confidence(quote_payload)
                confidence_fields = {
                    "confidence": model_confidence,
                    "value": model_confidence,
                    "confidenceSource": "model_self_reported" if model_confidence is not None else "unrated",
                }

                if speaker_id and answer_tag:
                    source_entries = by_tag.get((speaker_id, answer_tag), [])
                    for source_entry in source_entries:
                        script = source_entry["text"]
                        label = f"{participant_display_label(speaker_id)} {answer_tag}"
                        key = (label, script, source_entry.get("segmentId"), source_entry["source_file"])
                        if key not in seen:
                            expanded_quotes.append({
                                **source_entry,
                                "speaker": label,
                                "text": script,
                                "ai_generated": True,
                                **confidence_fields,
                                "sourceMatch": "exact_answer_tag_match"
                            })
                            seen.add(key)
                    if source_entries:
                        continue

                if speaker_id and text_raw:
                    matched_text = False
                    for source_entry in by_speaker.get(speaker_id, []):
                        tag = source_entry["tag"]
                        script = source_entry["text"]
                        if text_raw.lower() in script.lower():
                            matched_text = True
                            label = f"{participant_display_label(speaker_id)} {tag}".strip()
                            key = (label, script, source_entry.get("segmentId"), source_entry["source_file"])
                            if key not in seen:
                                expanded_quotes.append({
                                    **source_entry,
                                    "speaker": label,
                                    "text": script,
                                    "ai_generated": True,
                                    **confidence_fields,
                                    "sourceMatch": "quote_text_match"
                                })
                                seen.add(key)
                    if matched_text:
                        continue

                if speaker_raw and text_raw:
                    key = (speaker_raw, text_raw)
                    if key not in seen:
                        expanded_quotes.append({
                            **quote_payload,
                            "speaker": speaker_raw,
                            "text": text_raw,
                            "ai_generated": True,
                            **confidence_fields,
                            "sourceMatch": "model_quote_only"
                        })
                        seen.add(key)

            if expanded_quotes:
                self.themes_dict[theme_name]["quotes"] = expanded_quotes
                print(f"[DEBUG] Hydrated {len(expanded_quotes)} quotes for theme: {theme_name}")

    def _parse_speaker_token(self, speaker_raw):
        answer_tag = _normalize_quote_tag(speaker_raw) or None
        participant_label = re.sub(r"\s+A\d+[A-Za-z]?\s*$", "", speaker_raw, flags=re.IGNORECASE)
        participant_label = re.sub(r"^participant\s+", "", participant_label, flags=re.IGNORECASE)
        speaker_id = normalize_participant_id(participant_label) or None
        return speaker_id, answer_tag

    def _refresh_themes_cache_from_output(self, force_reload: bool = False,output_json_path: str = None):
        processed_dir = self._resolved_processed_dir()
        if not output_json_path:
            output_json_path = os.path.join(processed_dir, "ai_generated.json")
        exists = os.path.exists(output_json_path)
        signature = (output_json_path, os.path.getmtime(output_json_path), os.path.getsize(output_json_path)) if exists else (output_json_path, None, None)
        print(
            f"[DEBUG] Theme cache path check: processed_dir={processed_dir} "
            f"output_json={output_json_path} exists={exists}"
        )
        if exists:
            print(
                f"[DEBUG] ai_generated.json file stats: size_bytes={signature[2]} "
                f"mtime={signature[1]}"
            )

        if (not force_reload) and self._themes_cache_signature == signature and self.themes_dict:
            return

        self._themes_cache_signature = signature
        if not exists:
            return

        try:
            with open(output_json_path, "r", encoding="utf-8") as f:
                loaded = json.load(f)
            if isinstance(loaded, dict) and loaded:
                self.themes_dict = loaded
                self.themes = list(loaded.keys())
                print(f"[DEBUG] Loaded themes cache from {output_json_path} ({len(self.themes)} themes)")
        except Exception as e:
            print(f"[WARN] Could not load ai_generated.json theme cache from {output_json_path}: {e}")
    
    def get_topic_for_themes_qwen(self, chosen_themes,  processed_dir=None):
        resolved_dir = processed_dir or self._resolved_processed_dir()
        output_json_path = os.path.join(resolved_dir, "ai_generated.json")

        # Now pass the path explicitly — no race condition
        self._refresh_themes_cache_from_output(force_reload=True, output_json_path=output_json_path)
        
        if not self.themes_dict:
            self.qwenModel()
            self._refresh_themes_cache_from_output(force_reload=True, output_json_path=output_json_path)

        requested_themes = [str(t or "").strip() for t in (chosen_themes or []) if str(t or "").strip()]
        print(
            f"[DEBUG] get_topic_for_themes: output_json={output_json_path} "
            f"requested_themes_count={len(requested_themes)}"
        )
        if requested_themes:
            print(f"[DEBUG] Requested themes sample: {requested_themes[:5]}")

        chosen_themes_topics = defaultdict(list)
        #used_quotes_global = set()

        def _normalize_theme_key(text):
            normalized = str(text or "").strip().lower()
            normalized = normalized.replace("_", " ")
            normalized = normalized.replace("&", " and ")
            normalized = re.sub(r"\s+", " ", normalized).strip()
            return normalized

        def _normalize_quote(text):
            cleaned = str(text or "").strip().strip('"').strip("'")
            cleaned = re.sub(r"\s+", " ", cleaned).strip().lower()
            return cleaned

        normalized_theme_index = {
            _normalize_theme_key(existing_key): existing_key
            for existing_key in self.themes_dict.keys()
        }
        available_theme_keys = list(self.themes_dict.keys())
        print(
            f"[DEBUG] Available themes in ai_generated.json: count={len(available_theme_keys)} "
            f"sample={available_theme_keys[:5]}"
        )

        def _best_theme_key_match(raw_theme):
            raw_norm = _normalize_theme_key(raw_theme)
            if not raw_norm or not available_theme_keys:
                return None
            raw_tokens = set(raw_norm.split())
            best_key = None
            best_score = 0.0
            for candidate in available_theme_keys:
                cand_norm = _normalize_theme_key(candidate)
                if not cand_norm:
                    continue
                cand_tokens = set(cand_norm.split())
                union = raw_tokens | cand_tokens
                overlap = (len(raw_tokens & cand_tokens) / len(union)) if union else 0.0
                ratio = SequenceMatcher(None, raw_norm, cand_norm).ratio()
                score = (0.65 * ratio) + (0.35 * overlap)
                if score > best_score:
                    best_score = score
                    best_key = candidate
            if best_score >= 0.45:
                return best_key
            return None

        for raw_theme in (chosen_themes or []):
            raw_theme = str(raw_theme or "").strip()
            if not raw_theme:
                continue
            chosen_themes_topics[raw_theme]

            if raw_theme in self.themes_dict:
                resolved_theme_key = raw_theme
            elif titlecase(raw_theme) in self.themes_dict:
                resolved_theme_key = titlecase(raw_theme)
            else:
                resolved_theme_key = normalized_theme_index.get(_normalize_theme_key(raw_theme))
            if not resolved_theme_key:
                resolved_theme_key = _best_theme_key_match(raw_theme)
                if resolved_theme_key:
                    print(f"[WARN] Theme '{raw_theme}' not found directly; matched to '{resolved_theme_key}' by fuzzy name.")

            if not resolved_theme_key:
                print(
                    f"[WARN] Theme '{raw_theme}' has no match in ai_generated.json "
                    f"({output_json_path}); returning no excerpts."
                )
                continue

            theme_content = self.themes_dict.get(resolved_theme_key, {})
            summary = str(theme_content.get("summary", "")).strip()
            quotes = theme_content.get("quotes", [])
            unique_theme_quotes = []
            seen_theme = set()
            normalized_summary = _normalize_quote(summary)

            for quote_content in quotes:
                explicit_participant = ""
                explicit_tag = ""
                explicit_timestamp = ""
                explicit_cue_text = ""
                source_metadata = {}
                confidence = read_model_confidence(quote_content)
                confidence_source = "model_self_reported" if confidence is not None else "unrated"
                if isinstance(quote_content, dict):
                    quote_text = str(quote_content.get("text", "")).strip()
                    speaker = str(quote_content.get("speaker", "")).strip()
                    explicit_participant = normalize_participant_id(
                        quote_content.get("participantId") or quote_content.get("participant")
                    )
                    explicit_tag = _normalize_quote_tag(quote_content.get("tag"))
                    explicit_timestamp = str(quote_content.get("timestamp") or "").strip()
                    explicit_cue_text = str(quote_content.get("cueText", "")).strip()
                    source_fields = (
                        "segmentId", "participantId", "source_file", "sourceFile",
                        "startSeconds", "endSeconds", "speakerLabel", "speakerRole",
                    )
                    for field in source_fields:
                        if field in quote_content:
                            source_metadata[field] = quote_content[field]
                    source_match = quote_content.get("sourceMatch")
                    if not source_match and quote_content.get("confidenceSource") in {
                        "exact_answer_tag_match", "quote_text_match", "model_quote_only"
                    }:
                        source_match = quote_content["confidenceSource"]
                    if source_match:
                        source_metadata["sourceMatch"] = source_match
                else:
                    quote_text = str(quote_content).strip()
                    speaker = ""

                if not quote_text:
                    continue

                normalized_quote = _normalize_quote(quote_text)
                if not normalized_quote:
                    continue
                if normalized_summary and normalized_quote == normalized_summary:
                    continue
                participant_code = explicit_participant or _normalize_participant_code(speaker)
                tag = explicit_tag or _normalize_quote_tag(speaker)
                dedupe_key = (
                    normalized_quote,
                    participant_code,
                    tag,
                    explicit_timestamp,
                    source_metadata.get("segmentId"),
                    source_metadata.get("source_file") or source_metadata.get("sourceFile"),
                )
                if dedupe_key in seen_theme:
                    continue
                #if normalized_quote in used_quotes_global:
                #    continue

                seen_theme.add(dedupe_key)
                #used_quotes_global.add(normalized_quote)
                unique_theme_quotes.append({
                    **source_metadata,
                    "text": quote_text,
                    "speaker": speaker,
                    "participant": participant_code,
                    "tag": tag,
                    "timestamp": explicit_timestamp,
                    "cueText": explicit_cue_text,
                    "confidence": confidence,
                    "value": confidence,
                    "confidenceSource": confidence_source,
                    "ai_generated": bool(quote_content.get("ai_generated", True)) if isinstance(quote_content, dict) else True,
                })

            # Keep response keys aligned with request keys for stable frontend mapping.
            chosen_themes_topics[raw_theme].extend(unique_theme_quotes)

        return chosen_themes_topics
