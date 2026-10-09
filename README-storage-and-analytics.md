# Local storage and background jobs

## One workspace on your computer

This edition uses one persistent local workspace. Opening another browser or restarting the app returns to the same saved projects. There are no accounts and no separate private workspace for each browser. Files do not sync to another computer automatically.

`CHROMASCRIBE_DATA_DIR` defaults to `.private/runtime/`. It must be outside the public `static/` directory. Back up the whole directory independently of source code.

The application retains the existing project layout so transcript processing and saved project formats stay compatible:

```text
.private/runtime/
  static/
    User_projects/users/<workspace_key>/
      projects_index.json
      projects/<project_id>/
        inputs/
        outputs/
        session_data/
        current_status/
    Demo_project/
    Uploaded_files/
    Processed_files/
  intermediate_files/
```

The workspace key is stable for this installation. The `users` folder name is part of the storage layout; it does not represent an account system in this edition. The `static` name inside private storage does not expose the directory as public web assets.

`services/storage.py` handles atomic JSON reads and writes. `services/project_storage.py` handles workspace paths and file access. Route and session orchestration remains in `app.py` and the route modules.

Project files are served by Flask from the local workspace. Path traversal and symlinks outside the allowed workspace are rejected. Private responses disable shared caching. The legacy shared upload, processing, and demo file URLs are blocked; the application reads demo data through project APIs.

## What is saved

Each ordinary or demo project keeps its own questions, demographics, selected codes, archived codes, notes, and results. Q&A edits and code changes use the same persistence workflows. Clean installations generate demo text and silent placeholder audio locally. Original study recordings are not bundled.

Your files stay under the configured data directory when you restart the app. Page-local Undo history resets on reload; already saved edits remain on disk. Back up project files before deleting projects, moving data, or updating an existing installation.

## Network services and analytics

This edition has no Firebase or Firestore connection and does not send cloud analytics. There is no analytics opt-in setting.

AI requests use the endpoint you configure in `LLM_BASE_URL`. With a downloaded model served by local Ollama, model inference runs on your computer. With a hosted provider, transcript content is sent to that provider. Application logs and intermediate processing files can contain transcript text; treat them as private data too.

The browser may load third-party frontend libraries or fonts. Choosing local AI does not make the entire application a fully offline package.

## Background jobs

`services/background_jobs.py` holds process-local state, locks, cancellation events, and progress-file helpers. Tasks belong to the same local workspace as the project that started them.

Use one application process. A restart can stop active threads and discard in-memory task status. It does not delete uploaded files or saved analysis results. A durable external job queue is a separate future change.

## Separate the two editions

Keep this edition's data directory separate from the server-hosted edition. The hosted version uses Firebase identities to map accounts to workspaces; this version uses one local workspace. Copying a hosted server's data directory does not automatically migrate its accounts or choose which account's projects to open.

For a local backup or move, stop the app and copy the entire data directory. Set `CHROMASCRIBE_DATA_DIR` in the destination installation and keep its files outside `static/`. See the [setup guide](README-team-setup.md).
