# Synapse Health Cases — Google ADK Multi-Agent Research

> **A curated public slice of the production codebase powering
> [`https://synapsesocial.com/health-cases`](https://synapsesocial.com/health-cases).**
>
> Submitted to the
> [Google for Startups AI Agents Challenge](https://googleforstartups-aiagents.devpost.com/) —
> Track: **Build / Net-New Agent**.

![Architecture diagram of the Health Cases ADK multi-agent workflow](docs/architecture.png)

## What this agent does

A user pastes a free-text medical case — for example, *"67-year-old with vision
loss, MacTel, type-2 diabetes, and stage-3A CKD"* — and the agent returns a
structured **Expert Research brief** containing:

- Relevant published papers (with citations)
- Named researchers worth consulting, with affiliations
- Ongoing and recruiting clinical trials
- A personalized literature feed

…all grounded in real sources, streamed token-by-token to the browser, and
downloadable as a PDF.

See [`examples/67M-mactel-diabetes-ckd-brief.md`](examples/67M-mactel-diabetes-ckd-brief.md)
and the matching [PDF](examples/67M-mactel-diabetes-ckd-brief.pdf) for a real
production output captured on 2026-05-26.

## Why Google ADK

We needed three things that map cleanly onto ADK primitives:

1. **Parallel fan-out** to multiple specialist research tools — ADK's
   `ParallelAgent` runs `paper_search`, `researcher_match`,
   `clinical_trials_lookup`, and `feed_suggestions` concurrently. p50 brief
   generation latency dropped roughly **2×** compared with our prior sequential
   single-model path.
2. **Sequential orchestration** of intake → research → synthesis, with a final
   Gemini synthesis agent composing the brief from all tool outputs. ADK's
   `SequentialAgent` handles this with one declarative composition.
3. **Custom Python tools** wrapped around our existing Synapse research
   stack — every tool is a thin adapter over an executor we already ship in
   production, so the ADK rewrite was a one-day integration rather than a
   re-implementation.

A legacy single-model research agent stays wired up as an **automatic fallback**
inside the Flask route (`backend/api/routes/health_case/__init__.py`). If ADK
times out or errors *before* yielding any events, we transparently fall back.
If ADK errors *mid-stream* after partial events, we surface a clean error
without garbling the client (the `adk_yielded` flag pattern — see the route).

## Live demo and artifacts

- **Live app**: <https://synapsesocial.com/health-cases>
- **Architecture deep-dive**: [`docs/google-adk-health-cases-architecture.md`](docs/google-adk-health-cases-architecture.md)
- **Example brief** (markdown): [`examples/67M-mactel-diabetes-ckd-brief.md`](examples/67M-mactel-diabetes-ckd-brief.md)
- **Example brief** (PDF, rendered Node-side from the same React components the web app uses): [`examples/67M-mactel-diabetes-ckd-brief.pdf`](examples/67M-mactel-diabetes-ckd-brief.pdf)

## Repo layout

```
backend/
  services/health_cases_adk.py       # ADK Runner, tool wrappers, intake & brief streaming
  api/routes/health_case/__init__.py # Flask SSE routes + ADK/legacy fallback wiring
  api/models/health_case/__init__.py # MongoEngine model for Health Cases
  tests/test_health_cases_adk.py     # Unit tests for the ADK path
frontend/
  components/HealthCasesClient.tsx   # React UI consuming the SSE stream
  components/BriefPdfDocument.tsx    # @react-pdf/renderer document
  components/briefPdf.ts             # Brief markdown → PDF section parser
  scripts/render-brief-pdf.tsx       # Node-side PDF renderer (re-uses the web component)
docs/
  google-adk-health-cases-architecture.md
  architecture.png                   # Source: docs/architecture.mmd (Mermaid)
examples/
  67M-mactel-diabetes-ckd-brief.md   # Real captured ADK output
  67M-mactel-diabetes-ckd-brief.pdf  # Same brief, rendered to PDF
```

## Technology stack

- **Agent framework**: [Google ADK 2.1](https://adk.dev) — `SequentialAgent`, `ParallelAgent`, custom `Tool`s
- **LLM**: Google Gemini (via `google-genai >= 1.72`)
- **Prompt iteration**: Google AI Studio
- **API**: Python 3.11, Flask, Server-Sent Events (SSE)
- **Web**: Next.js 14, React, @react-pdf/renderer
- **Hosting**: AWS ECS Fargate (API), Vercel (web)
- **Data sources**: OpenAlex, PubMed E-utilities, ClinicalTrials.gov v2, NPI Registry, Synapse-owned Mongo corpus
- **Observability**: Sentry

## Reading order for judges

If you're reviewing this in 10 minutes, read these four files in this order:

1. [`docs/google-adk-health-cases-architecture.md`](docs/google-adk-health-cases-architecture.md) — the design doc
2. [`backend/services/health_cases_adk.py`](backend/services/health_cases_adk.py) — the agent + tool wiring (this is the core file)
3. [`backend/api/routes/health_case/__init__.py`](backend/api/routes/health_case/__init__.py) — the Flask route, SSE event contract, and ADK→legacy fallback
4. [`examples/67M-mactel-diabetes-ckd-brief.md`](examples/67M-mactel-diabetes-ckd-brief.md) — a real captured output

## Note on this repo's scope

This is a **read-only mirror** of the ADK Health Cases feature — the files
above are extracted verbatim from our production monorepo. It is *not*
runnable standalone; some imports reference broader Synapse infrastructure
(MongoEngine models, our research executor, Firebase auth) that lives in the
private monorepo.

The intent is to make the ADK integration auditable for the Devpost judges
without exposing unrelated product surfaces. If you'd like deeper access,
contact `jesse@synapsesocial.com`.

## License

MIT — see [LICENSE](LICENSE).
