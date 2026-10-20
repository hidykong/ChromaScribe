# ChromaScribe: local edition

ChromaScribe helps researchers work with interview transcripts and audio. You can tag questions and answers, create and review codes, use AI suggestions, filter by demographics, and explore a timeline visualization. Demo projects use the same editing workflows as your own projects.

This edition opens straight to your projects. It has **no login, accounts, Firebase setup, or cloud analytics**. It keeps one workspace on your computer, including your uploads, edits, and results. The [Firebase-hosted edition](https://github.com/hidykong/Audio-Vis-Project/tree/ChromaScribe/firebase-hosted) is maintained separately in the original repository.

## 1. Install the application

Clone the repository:

```bash
git clone https://github.com/hidykong/ChromaScribe.git
cd ChromaScribe
```

Run the following commands from the project folder. Python 3.11 or 3.12 is supported; the browser interface needs no build step.

**macOS / Linux**

```bash
python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.lock
cp .env.template .env
```

**Windows PowerShell**

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.lock
Copy-Item .env.template .env
```

Copy the template only on the first run; keep your existing `.env` when updating. Install [FFmpeg](https://ffmpeg.org/download.html) if you will process compressed audio. Text-only use does not require FFmpeg.

## 2. Configure your own AI provider

### Bring your own API key

This repository does not include an AI service key. For hosted AI, create a key with your chosen provider and store it locally. The [AI key walkthrough](README-LLM-key-setup.html) covers key creation, model selection, and connection checks.

1. Choose a provider with an OpenAI-compatible chat API, such as Google AI Studio or Groq.
2. Open that provider's API key page and create your own key: [Google AI Studio](https://aistudio.google.com/apikey) or [Groq](https://console.groq.com/keys).
3. Choose a text chat model available to your account. Copy its exact model ID from the provider's model list.
4. The template starts with local Ollama settings. Replace all three active `LLM_*` values in `.env` with your hosted provider settings. For example, for Google AI Studio:

```dotenv
LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
LLM_MODEL=your_available_gemini_model_id
LLM_API_KEY=your_own_api_key
```

Replace both placeholders. Use one active value for each setting. The URL must be the provider's API base URL, without `/models` or `/chat/completions` at the end. See [Google's compatibility documentation](https://ai.google.dev/gemini-api/docs/openai) or the [step-by-step key guide](README-LLM-key-setup.html).

Hosted AI requests send transcript content to your chosen provider. Check its data policy and any requirements for your research data before using it. Keep your key in `.env`, which Git ignores.

### Optional: run a model on your computer

The template uses [Ollama](https://ollama.com/download). Install and start Ollama, then download the model:

```bash
ollama pull qwen3:latest
```

Keep these settings in `.env`:

```dotenv
LLM_BASE_URL=http://localhost:11434/v1
LLM_MODEL=qwen3:latest
LLM_API_KEY=
```

No API key is needed for this local model. Leave Ollama running while you use AI features. Inference speed and the size of model you can run depend on your hardware. See [Ollama's compatibility documentation](https://docs.ollama.com/api/openai-compatibility).

## 3. Start ChromaScribe

With your Python environment active:

```bash
python app.py
```

Open **http://127.0.0.1:5001**. You can create a project or open a demo immediately. Upload your interview files and question set, review the Q&A tags and codes, choose excerpts, and open the visualization. Manual editing and saved projects remain available without a working AI service; generating new AI suggestions requires the model you configured.

Stop the application with `Ctrl+C`. To run it again, activate `.venv` and run `python app.py`. Restart it after changing `.env`.

## Where your work is saved

Projects are saved under `.private/runtime/` by default and survive application restarts. Every browser using this installation opens the same workspace. It does not sync to other computers. Back up the whole data directory; see [storage details](README-storage-and-analytics.md).

Run this edition on your own computer at its loopback address. It has no access controls for separating users, so do not expose it through a public URL, network bind, or tunnel. Use the separate server-hosted edition for a shared service.

## Installation checks

With your Python environment active, check installed dependencies and the files tracked for publication:

```bash
python -m pip check
python scripts/check_public_tree.py
```

These checks do not contact your AI provider. Try a small project to confirm that your chosen model works with the application.

## More documentation

- [Setup, settings, and troubleshooting](README-team-setup.md)
- [Storage and background jobs](README-storage-and-analytics.md)
- [Frontend development](README-frontend.md)
- [AI key walkthrough](README-LLM-key-setup.html), also available at `/llm-setup` while the app is running

## Data and publication

Credentials, uploads, generated results, and internal notes belong outside Git. Runtime files default to `.private/runtime/`, outside the web asset directory. The built-in demo text and examples are fictional. Demo files are generated locally; original study recordings are not distributed.

The file check inspects the candidate source tree, not historical commits. Removing a credential from the current tree does not revoke it or remove it from old commits. This `main` branch starts from a source snapshot and does not include the original repository's commit history. See the [publication steps](README-team-setup.md#development-and-publication-checks).

## License

The source code is licensed under the [Apache License 2.0](LICENSE) (`Apache-2.0`). Third-party components and assets may have separate license terms; retain their existing copyright and attribution notices.
