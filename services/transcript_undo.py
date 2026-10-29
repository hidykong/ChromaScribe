"""Signed, page-local undo records. Only the browser keeps the history."""

import copy

from flask import current_app, session
from itsdangerous import BadSignature, URLSafeSerializer


QNA_STATE_FIELDS = (
    "tag", "manualTag", "tagSource", "tagUpdatedAt", "additionalTags",
    "aiSuggestedTag", "aiSuggestedTags", "originalTag", "originalAiTag",
    "tagConflictResolution", "tagConflictResolvedAt",
    "tagConflictResolvedManualTag", "tagConflictResolvedAiTag",
)


def qna_state(cue):
    return {key: copy.deepcopy(cue[key]) for key in QNA_STATE_FIELDS if key in cue}


def restore_qna_state(cue, previous):
    for key in (*QNA_STATE_FIELDS, "tagConflict", "tagConflictType"):
        cue.pop(key, None)
    cue.update(copy.deepcopy(previous))


def _serializer():
    return URLSafeSerializer(current_app.secret_key, salt="transcript-undo-v1")


def sign_history_record(kind, target, before, after, mode, project_id):
    return _serializer().dumps({
        "owner": session["user_id"],
        "mode": mode,
        "projectId": project_id,
        "kind": kind,
        "target": target,
        "before": before,
        "after": after,
    })


def read_history_record(token, mode, project_id):
    try:
        record = _serializer().loads(token)
    except (BadSignature, TypeError):
        raise ValueError("This undo record is no longer available.") from None
    if (
        record.get("owner") != session["user_id"]
        or record.get("mode") != mode
        or record.get("projectId") != project_id
    ):
        raise ValueError("This undo belongs to a different project or account.")
    return record


def qna_undo_token(target, before, cue, mode, project_id):
    after = qna_state(cue)
    if before == after:
        return None
    return sign_history_record("qna", target, before, after, mode, project_id)
