# Setup and troubleshooting

This guide covers the local edition in this repository's `main` branch. The application opens directly to one persistent workspace. Firebase sign-in, account registration, and cloud analytics are absent from this edition. The [Firebase-hosted edition](https://github.com/hidykong/Audio-Vis-Project/tree/ChromaScribe/firebase-hosted) is maintained separately in the original repository. Keep each edition's environment template and runtime data separate.

## Install and run

Follow the [README quick start](README.md) for macOS, Linux, and Windows commands. Use Python 3.11 or 3.12. Node.js 22 is used for JavaScript syntax checks and is not needed to run the app. Install FFmpeg for compressed audio processing; text-only use does not require it.

After the first setup, activate your environment and start the app:

```bash
source .venv/bin/activate
python app.py
```

On Windows PowerShell, activate with `.\.venv\Scripts\Activate.ps1` instead. Open http://127.0.0.1:5001. No account or service-account JSON is needed.

Settings come from environment variables and then from `.env` for values not already provided. Startup creates missing runtime directories and preserves existing uploads and results. Restart the app after editing settings.

## AI configuration

AI-assisted Q&A tagging and code generation need a large language model. You can use one in the cloud with your own API key or run one on your computer.

The same three settings configure both options:

| Setting | What to enter |
| --- | --- |
| `LLM_BASE_URL` | Your provider's OpenAI-compatible API base URL |
| `LLM_MODEL` | The exact text chat model ID available to you |
| `LLM_API_KEY` | Your provider's key, or an empty value for local Ollama |

### Option 1: Hosted AI with your own key

The model runs on your provider's servers. Choose a provider with an OpenAI-compatible chat API, such as Groq or Google AI Studio. Create your own key in its console and choose a text chat model available to your account: [Groq's API keys page](https://console.groq.com/keys) or [Google AI Studio's API keys page](https://aistudio.google.com/apikey).

Replace the three AI settings in your local `.env`:

```dotenv
LLM_BASE_URL=your_provider_base_url
LLM_MODEL=your_model_id
LLM_API_KEY=your_api_key
```

Replace all three placeholders and keep one active value per setting. Use the API base URL without `/models` or `/chat/completions` at the end. Keep your key in `.env`, which Git ignores. Provider compatibility varies, so begin with a small sample project and inspect the output.

For Groq, a complete configuration for `openai/gpt-oss-20b` is:

```dotenv
LLM_BASE_URL=https://api.groq.com/openai/v1
LLM_MODEL=openai/gpt-oss-20b
LLM_API_KEY=your_own_groq_key
```

Replace the key placeholder with your own Groq key. This model supports the structured responses ChromaScribe requests for code generation; check its availability in your account. See [Groq's setup guide](https://console.groq.com/docs/openai) and [structured-output documentation](https://console.groq.com/docs/structured-outputs).

The app detects Groq automatically when the API hostname is `api.groq.com`; an old `LLM_PROVIDER` value does not change that detection. Remove old overrides from `.env` and your terminal to keep the settings clear. For a custom proxy that forwards to Groq, use `LLM_PROVIDER=groq`. Stop the running app, then restart `python app.py` from this repository's folder so the new settings take effect.

For code generation with Groq's GPT-OSS 20B or 120B, ChromaScribe sets a default output allowance of 16,384 tokens. To change it, set `LLM_MAX_TOKENS` to a positive whole number within your model's limit in `.env`, then restart the app.

Hosted AI sends transcript content to the provider. Check its terms against your consent forms or IRB approval before using real participant data.

### Option 2: Local (Ollama)

The model runs on your computer through [Ollama](https://ollama.com/download). The template selects this option. Install and start Ollama, then download the model:

```bash
ollama pull qwen3:latest
```

Keep these settings in `.env`:

```dotenv
LLM_BASE_URL=http://localhost:11434/v1
LLM_MODEL=qwen3:latest
LLM_API_KEY=
```

No API key is needed for a downloaded local model. Leave Ollama running while using AI features. Model requests stay on your computer; speed depends on your hardware. The browser may still load libraries or fonts from external sites; see [storage and network services](README-storage-and-analytics.md#network-services-and-analytics).

**Full walkthrough:** the [key setup guide](README-LLM-key-setup.html) explains where to get a key, how to choose a model, and how to troubleshoot errors. You can also open http://127.0.0.1:5001/llm-setup while the app is running. Restart ChromaScribe after changing `.env`.

## Local settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `CHROMASCRIBE_DATA_DIR` | `.private/runtime` | Persistent project files; keep this outside `static/` |
| `CHROMASCRIBE_PORT` | `5001` | Local application port |
| `CHROMASCRIBE_PUBLIC_BASE_URL` | `http://127.0.0.1:5001` | Base URL used by the application; use the same local port |
| `CHROMASCRIBE_DEBUG` | `false` | Development debugging |
| `CHROMASCRIBE_SECRET_KEY` | Generated for the process | Signs browser session state and Undo data; it is not a login password |

For a stable session secret, run this command and paste the result into `.env`:

```bash
python -c 'import secrets; print(secrets.token_hex(32))'
```

Without a stable secret, restarting the process can invalidate browser session state. Saved project files remain on disk. Undo history is local to the current page and resets when the page reloads.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| Connection refused at port 5001 | Keep the `python app.py` terminal running and check it for startup errors. |
| AI connection refused | Start Ollama, or check the hosted provider's base URL. The app and Ollama are separate processes. |
| AI returns 401 or 403 | Check that the key belongs to the configured provider and has access. An exported shell variable can override `.env`. |
| AI model not found | Copy an exact model ID your account can access; for Ollama, run `ollama list` and download the selected model. |
| AI returns 429 | Check your provider's rate or usage limits and retry after the limit clears. |
| Q&A tags appear, but codes do not | These steps use separate requests. Tagging can fall back to local matching when an AI request fails, so check the code-generation error rather than treating Q&A tags as a successful API test. |
| Groq could not finish a valid code response | Groq rejected the generated JSON. Try again; if it keeps happening, increase `LLM_MAX_TOKENS` within your model's limit or use a smaller transcript. Restart the app after changing `.env`. |
| AI reply could not be read as codes | The response did not contain usable code data. For Groq, check the model settings above, update the app, and restart it. Retry with a short fictional sample and review the error. |
| AI reply was cut off | The response reached its output-token limit. You can override the code-generation output allowance with `LLM_MAX_TOKENS`, using a larger positive integer within your model's limit, or use a smaller transcript. Restart the app after changing the setting; a larger allowance may use more tokens. |
| Changes to `.env` have no effect | Restart ChromaScribe from this checkout and check for conflicting `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`, or `LLM_PROVIDER` terminal variables. |
| Projects seem missing | Check `CHROMASCRIBE_DATA_DIR`. A different data directory creates a different workspace. |
| A sign-in screen appears | Check that you started this edition's checkout and that an older server is not using the same port. |
| Compressed audio fails to load | Install FFmpeg and make sure its executable is on your system path. |

## Running for longer sessions

Keep the app bound to `127.0.0.1`. This edition has no user accounts or access controls and should not be exposed through a network address, public proxy, or tunnel. Everyone who can reach the installation can use the same projects. For a shared service, use the separate server-hosted edition.

Use a persistent writable disk and **one application process**. Background tasks, cancellation events, and locks live in that process; multiple workers and ephemeral serverless runtimes are unsupported. On systems that support Gunicorn, a local alternative to `python app.py` is:

```bash
gunicorn --workers 1 --threads 8 --timeout 240 --bind 127.0.0.1:5001 app:app
```

Do not run this command at the same time as `python app.py`. Restarting either server can stop an active processing task; wait for processing to finish before restarting.

## Moving or updating a local installation

Stop the app and back up `.env` and the whole `CHROMASCRIBE_DATA_DIR` before changing checkouts or moving to another computer. Copy that directory to the new installation and configure the same data path. Keep API keys out of any shared backup.

This edition does not import Firebase accounts or automatically select a workspace from a server-hosted installation. Keep the two editions' runtime directories separate. Review existing data and its workspace mapping before attempting a migration.

## Development and publication checks

```bash
python -m pip check
python scripts/check_public_tree.py
```

GitHub Actions checks Python and JavaScript syntax, dependency consistency, publication files, local startup, and browser module imports. To run the startup check locally, install Node.js 22 alongside the Python dependencies, then run:

```bash
python scripts/check_local_startup.py
```

The check uses a temporary workspace and fictional demo data. It does not read `.env`, change your projects, or contact an AI provider. It verifies that the main pages load and their JavaScript imports are present; it does not replace browser testing or a live AI check. Internal tests and their runner remain ignored by Git. Internal notes and new Markdown files remain ignored; the existing public README files are tracked intentionally.

`requirements.txt` lists application dependencies and minimum patched versions for shared libraries. `requirements.lock` records resolved versions for clean installs and CI. To update them, install `requirements.txt` in a fresh Python environment, check dependency consistency, and try the affected workflows in an ordinary and demo project. Regenerate the lock with `python -m pip freeze > requirements.lock` after verifying the update.

To prepare a review copy without historical commits, stage the intended files and run:

```bash
python scripts/export_public_snapshot.py /tmp/chromascribe-public-review
```

The destination must not exist. The export contains working-tree versions of Git-tracked candidate files and no `.git` directory. Review the exported files and any third-party license or asset restrictions before sharing. The project uses the [Apache License 2.0](LICENSE). The export does not rotate credentials, clean repository history, or publish anything.
