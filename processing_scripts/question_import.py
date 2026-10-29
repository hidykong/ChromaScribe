"""Read interview guides without changing the wording of their questions."""

import io
import re
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from xml.etree import ElementTree

import pdfplumber


WORD_NAMESPACE = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
QUESTION_LABEL = re.compile(
    r"^(?:Q(?:uestion)?\s*)?(\d+[a-z]?)\s*[.):：-]\s*(.*)$",
    re.IGNORECASE,
)
QUESTION_START = re.compile(
    r"^(what|why|how|when|where|who|which|can|could|do|does|did|is|are|"
    r"would|will|tell|describe|explain|share)\b",
    re.IGNORECASE,
)
GUIDE_HEADING = re.compile(
    r"^(?:(?:interview\s+)?(?:question(?:s|naire)?|guide|protocol)"
    r"(?:\s+(?:set|subset|guide|for)\b.*)?|"
    r"(?:section|part)\s+[\w\d]+\s*[:.\-].*)$",
    re.IGNORECASE,
)
GUIDE_INSTRUCTION = re.compile(
    r"^\[?(?:interviewer\s+(?:instructions?|notes?)|instructions?|"
    r"note\s+to\s+(?:the\s+)?interviewer)\s*:",
    re.IGNORECASE,
)


@dataclass
class QuestionImportResult:
    questions: list[str]
    warnings: list[str] = field(default_factory=list)
    format: str = "txt"

    def summary(self) -> dict:
        return {
            "format": self.format,
            "questionCount": len(self.questions),
            "warnings": self.warnings,
        }


def _is_guide_metadata(line: str) -> bool:
    # Only omit explicit headings/instructions. A prompt such as "Tell me
    # about your work" is still a question even without a question mark.
    return bool(GUIDE_HEADING.fullmatch(line) or GUIDE_INSTRUCTION.match(line))


def _is_wrapped_continuation(previous: str, line: str) -> bool:
    if previous.endswith(("?", "？", ".", "!", "！")) or QUESTION_START.match(line):
        return False
    if previous.endswith((",", ":", "，", "：")):
        return True
    if re.search(r"\b(?:a|an|the|about|and|or|of|to|with|for|in|on|your|their)$", previous, re.I):
        return True
    return len(previous) >= 60 and line[0].islower()


def parse_question_text(text: str) -> QuestionImportResult:
    """Keep explicit question labels and join recognizable wrapped lines.

    An unnumbered guide remains one question per line unless there is a clear
    continuation. Blank lines separate unnumbered questions. Numbered blocks
    continue until the next label, heading, or completed question.
    """
    questions = []
    current = ""
    current_is_numbered = False
    omitted_metadata = False
    unnumbered_questions = False
    joined_lines = False

    def finish_question():
        nonlocal current, current_is_numbered
        if current:
            questions.append(current)
        current = ""
        current_is_numbered = False

    for raw_line in text.lstrip("\ufeff").splitlines():
        line = " ".join(raw_line.split())
        if not line:
            if not current_is_numbered:
                finish_question()
            continue
        if _is_guide_metadata(line):
            finish_question()
            omitted_metadata = True
            continue

        label_match = QUESTION_LABEL.match(line)
        if label_match:
            finish_question()
            label, question = label_match.groups()
            current = f"{label}. {question}".strip()
            current_is_numbered = True
            continue

        # Bullet characters mark separate prompts, including prompts that do
        # not end in a question mark.
        bullet_match = re.match(r"^[•*\-]\s+(.+)$", line)
        if bullet_match:
            finish_question()
            line = bullet_match.group(1)

        numbered_continuation = current_is_numbered and not current.endswith(("?", "？"))
        if current and (numbered_continuation or _is_wrapped_continuation(current, line)):
            current = f"{current} {line}"
            joined_lines = True
        else:
            finish_question()
            current = line
            unnumbered_questions = True

    finish_question()
    warnings = []
    if omitted_metadata:
        warnings.append("Guide headings and labelled interviewer instructions were left out of the question list.")
    if unnumbered_questions or joined_lines:
        warnings.append("Review the imported questions below, especially where line breaks or question numbering were unclear.")
    return QuestionImportResult(questions=questions, warnings=warnings)


def _decode_question_text(content: bytes) -> str:
    try:
        if content.startswith((b"\xff\xfe", b"\xfe\xff")):
            return content.decode("utf-16")
        return content.decode("utf-8-sig")
    except UnicodeError as error:
        raise ValueError("The question file could not be read. Save the TXT file as UTF-8 or UTF-16 and upload it again.") from error


def _word_paragraph_text(paragraph) -> str:
    parts = []
    for element in paragraph.iter():
        if element.tag == f"{WORD_NAMESPACE}t":
            parts.append(element.text or "")
        elif element.tag == f"{WORD_NAMESPACE}tab":
            parts.append(" ")
        elif element.tag in {f"{WORD_NAMESPACE}br", f"{WORD_NAMESPACE}cr"}:
            parts.append("\n")
    return "".join(parts).strip()


def _read_docx_questions(content: bytes) -> tuple[str, list[str]]:
    with zipfile.ZipFile(io.BytesIO(content)) as document:
        document_info = document.getinfo("word/document.xml")
        if document_info.file_size > 20 * 1024 * 1024:
            raise ValueError("The Word question guide is too large to import. Split it into smaller files.")
        root = ElementTree.fromstring(document.read(document_info))

    paragraphs = []
    warnings = []
    body = root.find(f"{WORD_NAMESPACE}body")
    if body is None:
        return "", warnings
    for block in body:
        if block.tag == f"{WORD_NAMESPACE}p":
            text = _word_paragraph_text(block)
            style = block.find(f"{WORD_NAMESPACE}pPr/{WORD_NAMESPACE}pStyle")
            style_name = style.get(f"{WORD_NAMESPACE}val", "") if style is not None else ""
            is_heading = style_name.lower().startswith(("heading", "title", "subtitle"))
            if is_heading and not QUESTION_LABEL.match(text) and not text.endswith(("?", "？")):
                continue
            paragraphs.append(text)
        elif block.tag == f"{WORD_NAMESPACE}tbl":
            for row in block.findall(f"{WORD_NAMESPACE}tr"):
                cells = []
                for cell in row.findall(f"{WORD_NAMESPACE}tc"):
                    cell_paragraphs = cell.findall(f"{WORD_NAMESPACE}p")
                    cells.append(" ".join(_word_paragraph_text(item) for item in cell_paragraphs).strip())
                if len(cells) >= 2 and re.fullmatch(r"(?:Q\s*)?\d+[a-z]?[.):]?", cells[0], re.I):
                    label = cells[0].rstrip(".):")
                    paragraphs.append(f"{label}. {' '.join(cells[1:])}")
                elif [cell.lower() for cell in cells] not in (["number", "question"], ["no.", "question"]):
                    paragraphs.extend(cell for cell in cells if cell)
            warnings.append("Questions were read from a Word table. Check that each row became the intended question.")

    if root.find(f".//{WORD_NAMESPACE}numPr") is not None:
        warnings.append("Word's automatic list numbers may not appear in the imported text. Check question and follow-up labels before tagging.")
    return "\n\n".join(paragraphs), list(dict.fromkeys(warnings))


def import_question_file(content: bytes, filename: str) -> QuestionImportResult:
    """Parse supported guides before the route replaces any saved questions."""
    extension = Path(filename).suffix.lower()
    format_warnings = []
    try:
        if extension == ".txt":
            text = _decode_question_text(content)
        elif extension == ".docx":
            text, format_warnings = _read_docx_questions(content)
        elif extension == ".pdf":
            try:
                with pdfplumber.open(io.BytesIO(content)) as document:
                    text = "\n\n".join(page.extract_text() or "" for page in document.pages)
            except Exception as error:
                raise ValueError("The PDF could not be read. Upload an unlocked PDF with selectable text, or use TXT or DOCX.") from error
            format_warnings.append("Check the order and line breaks of questions extracted from the PDF. Scanned pages require selectable text before upload.")
        else:
            raise ValueError("Upload a question guide as TXT, DOCX, or a PDF with selectable text.")
    except (zipfile.BadZipFile, KeyError, ElementTree.ParseError) as error:
        raise ValueError("The Word file could not be read. Save it as a DOCX file and upload it again.") from error

    result = parse_question_text(text)
    if not result.questions:
        raise ValueError("No questions were found. Upload a guide with readable question text; scanned PDFs are not supported.")
    result.format = extension.lstrip(".")
    result.warnings = list(dict.fromkeys(format_warnings + result.warnings))
    return result
