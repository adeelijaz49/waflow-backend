# Voice input for Arabic AI Mode: options (proposal only, NOT built)

The spec (§6, Phase 4) asks to *propose* voice input (speech-to-text for Arabic ar-SA and English) and report the options and expected accuracy. Nothing here is built. This page is a summary of the build's audit notes (F5 follow-up, 2026-10-12); the accuracy figures are taken from third-party papers and vendor pages as recorded there and were **not re-measured by us**. Treat them as orders of magnitude.

## What exists today
Nothing: no audio code and no speech-to-text dependency in either repo. The only audio trace is the "Voice message" placeholder shown for inbound WhatsApp voice notes in the inbox.

## Options
| Option | Notes |
|---|---|
| Browser built-in speech (Web Speech API) | Free, client-side. Not dependable for Saudi merchants: Chrome and Safari only (Edge unreliable, Firefox none, Safari needs Siri and is absent from Home-Screen apps), the audio goes to Google/Apple, and `ar-SA` support is undocumented. |
| Server-side STT API (Azure `ar-SA`, Google Chirp 3 [Preview for Arabic], OpenAI `gpt-4o-transcribe`, ElevenLabs Scribe v2, Mistral Voxtral) | Audio recorded in the browser, sent to the WaFlow backend, text returned into the input box. Cost about USD 0.0003 to 0.0028 per 10-second prompt (roughly 1 to 11% on top of the LLM cost of a prompt). |
| Self-hosted open-weights STT | The only way to keep audio inside Saudi Arabia (for example in the planned Dammam project). GPU availability there was not verified. |

## Expected accuracy (word error rate, lower is better; long spontaneous speech, not short commands)
* Gulf/Saudi dialect: the best systems tested still get roughly 25 to 47% of words wrong (`gpt-4o-transcribe` about 36% Gulf, Voxtral-Mini-4B about 25% on Saudi, Whisper-large-v3 36 to 47%).
* Arabic mixed with English: ElevenLabs Scribe v2 about 13% against 39 to 44% for `gpt-4o-transcribe`, Google Chirp 3 and Azure in one independent paper.
* English: about 5%.
* No benchmark covers short imperative commands (5 to 15 words). Numbers, brand names and customer names inside Arabic sentences are the weak spots. Measure end to end (spoken prompt to correct tool and arguments), not word error rate.

## Data residency / legal
Azure (nearest UAE North), Google (no Middle East STT location found) and OpenAI (US/EU, UAE by approval) have **no Saudi processing**. Any third-party STT is a new sub-processor for WaFlow's legal documents (notice + objection window) and a second cross-border flow of staff voice data, next to the existing LLM path. It belongs in the same counsel question about PDPL cross-border transfers. No legal conclusion is drawn here.

## How it would plug in without editing existing files
1. Frontend: a microphone control on the new `/arabic/ai-mode` page (`MediaRecorder`, with the browser Speech API as an optional free fallback).
2. Backend: a new `POST /api/localization/ai-mode/transcribe` behind the existing flag-gated router, memory-only upload (about 2 MB), one provider adapter `transcribe(buffer, mime, {lang}) -> {text, durationMs, provider}`.
3. Safety (spec §6: a misunderstood Arabic request must never result in a send): the transcript is only written into the text box, never auto-sent; the existing confirmation gate is unchanged; the recognised text and language are shown.
4. Gated by the same per-merchant flag; plan limits stay per prompt; STT cost would be separate and unmetered unless wired in.

## Recommendation
Do not rely on the browser API for Saudi merchants. Pick a server-side provider with a pilot rather than from benchmarks: record the same 40+ prompts as the Phase 4 evaluation set (MSA, Gulf, mixed, Western and Arabic-Indic digits) with 3 speakers, run them through two or three providers plus the browser baseline (and one self-hosted model if residency is decisive), and score by correct intent and arguments.
