# Frontend development

The frontend uses server-rendered templates and native browser JavaScript modules. There is no bundling step. This edition opens directly to the local project workspace and has no login, signup, or Firebase browser SDK.

- `templates/`: page markup and server-provided project context.
- `static/Pages/main-page/`: audio, transcript, timeline, and demographic visualization.
- `static/Pages/settings-page/`: uploads, demographics, questions, and code editing.
- `static/Pages/demo-data/`: demo theme names used by the UI.
- `static/Pages/themePersistence.js`: shared code/excerpt persistence and archive/restore behavior.
- `static/images/` and `static/styles.css`: public interface assets.

AI credentials stay in the server's environment or ignored `.env` file. Do not put them in browser JavaScript or templates. Uploads and generated results belong in the private runtime directory, outside public assets.

## Local workspace

Use the workspace and project context supplied by the server. All browser sessions for this installation share one local workspace. A new browser session must not create a new identity or hide previously saved projects.

Keep local file validation, safe path handling, and project selection checks even though this edition has no authentication. The application must only serve files through the intended project routes.

## Demo parity

For each user-facing change, check the ordinary route and its `/demo` counterpart. Page links, form actions, redirects, API requests, and project data must stay in the correct scope. Use the project URLs supplied by the server rather than constructing paths to shared data files.

The demo transcript fallback uses `/demo/api/processed_transcripts`; demo theme modules remain ordinary public JavaScript assets. The built-in demo text is fictional. Original interview recordings are not bundled in the source tree.

## Code style

Use these project conventions when changing Python or JavaScript:

- Choose descriptive names and give each function one clear responsibility.
- Use early returns to reduce nesting. Aim for two or three levels of branches where practical.
- Follow the surrounding module's formatting and preserve existing behavior.
- Keep edits focused. Avoid whole-file rewrites, compressed expressions, and minified source.

## Checking a frontend change

Use Node.js 22 to check a JavaScript file's syntax. For example:

```bash
node --check static/Pages/themePersistence.js
```

The CI workflow checks syntax across the source tree. For behavior changes, run the app and try the affected workflow in both an ordinary project and a demo project. Check that edits remain after reloading, page links keep the selected project, and the browser console has no new errors.

Live AI generation requires the provider or local model configured in `.env`. Start with a small sample project when checking a new provider or model.
