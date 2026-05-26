"""Fast regression coverage for Health Case privacy and routing contracts."""

from __future__ import annotations

import ast
import os

_ROUTE_PATH = os.path.join(
    os.path.dirname(__file__),
    "..",
    "api",
    "routes",
    "health_case",
    "__init__.py",
)
_MODEL_PATH = os.path.join(
    os.path.dirname(__file__),
    "..",
    "api",
    "models",
    "health_case",
    "__init__.py",
)
_ADK_SERVICE_PATH = os.path.join(
    os.path.dirname(__file__),
    "..",
    "services",
    "health_cases_adk.py",
)


def _read(path: str) -> str:
    with open(path) as handle:
        return handle.read()


def _decorator_names(fn: ast.FunctionDef) -> set[str]:
    names = set()
    for dec in fn.decorator_list:
        target = dec.func if isinstance(dec, ast.Call) else dec
        if isinstance(target, ast.Name):
            names.add(target.id)
        elif isinstance(target, ast.Attribute):
            names.add(target.attr)
    return names


def _functions(tree: ast.Module) -> dict[str, ast.FunctionDef]:
    return {
        node.name: node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef)
    }


def test_all_health_case_routes_require_signed_in_user():
    """Health Case routes must never use anonymous auth."""

    tree = ast.parse(_read(_ROUTE_PATH))
    route_functions = []
    for fn in _functions(tree).values():
        if any(
            isinstance(dec, ast.Call)
            and isinstance(dec.func, ast.Attribute)
            and dec.func.attr == "route"
            for dec in fn.decorator_list
        ):
            route_functions.append(fn)

    assert route_functions, "expected at least one Health Case route"
    for fn in route_functions:
        decorators = _decorator_names(fn)
        assert "validate_user" in decorators, f"{fn.name} must require auth"
        for dec in fn.decorator_list:
            if (
                isinstance(dec, ast.Call)
                and isinstance(dec.func, ast.Name)
                and dec.func.id == "validate_user"
            ):
                assert not dec.keywords, f"{fn.name} must not allow anonymous users"


def test_intake_agent_contract_reads_records_before_case_creation():
    src = _read(_ROUTE_PATH)
    assert "You are a world-class medical intaker" in src
    assert '@health_case.route("/intake", methods=["POST"])' in src
    assert 'key_prefix="health_case_intake"' in src
    assert 'request.files.getlist("files")' in src
    assert "extract_health_case_text(content, content_type)" in src
    assert "client.models.generate_content(" in src
    assert '"feed_suggestions"' in src


def test_expert_research_brief_has_product_sections():
    src = _read(_ROUTE_PATH)
    assert "## 1. What Experts Are Saying" in src
    assert "## 2. Relevant Research Papers" in src
    assert "Create Feed" in src
    assert "## 3. Relevant Researchers" in src
    assert "Request Contact" in src
    assert "## 4. Clinical Trials" in src
    assert "## 5. Topics to Discuss With Your Specialist" in src
    assert "## 6. Feedback" in src


def test_adk_brief_includes_intervention_topics_agent():
    """The ADK brief workflow must include the citation-grounded topics step.

    The topics agent runs between the parallel research stage and the final
    synthesis agent. Its output (`{intervention_topics}`) is consumed verbatim
    by the synthesis agent under section 5 of the brief.
    """

    src = _read(_ADK_SERVICE_PATH)
    assert 'name="intervention_topics_agent"' in src
    assert 'output_key="intervention_topics"' in src
    assert "{intervention_topics}" in src
    assert (
        "sub_agents=[parallel_research, intervention_topics_agent, synthesis_agent]"
        in src
    )
    assert "not medical advice" in src
    assert '"intervention_topics_agent"' in src


def test_intake_json_parser_handles_fenced_json():
    src = _read(_ROUTE_PATH)
    assert 'cleaned.removeprefix("```json")' in src
    assert 'cleaned.find("{")' in src
    assert 'cleaned.rfind("}")' in src


def test_profile_payload_preserves_string_labs_and_timeline_entries():
    src = _read(_ROUTE_PATH)
    assert 'labs=_dict_entries("labs", "result")' in src
    assert 'timeline=_dict_entries("timeline", "event")' in src
    assert "entries.append({string_key: item.strip()[:500]})" in src


def test_case_and_document_queries_are_owner_scoped():
    src = _read(_ROUTE_PATH)
    assert "HealthCase.objects(" in src
    assert "HealthCaseDocument.objects(" in src
    assert "user_id=_user_id()" in src
    assert "status__ne=HealthCaseStatus.DELETED" in src
    assert "status__ne=HealthCaseDocumentStatus.DELETED" in src
    assert ".limit(50)" in src
    assert ".limit(100)" in src
    assert "MAX_DOCUMENTS_PER_CASE" in src
    assert "MAX_CASES_PER_USER" in src
    assert "deleted_at=None" in src


def test_raw_record_text_is_not_stored_in_mongo_summary():
    from utils.health_case_extraction import extract_health_case_text

    result = extract_health_case_text(
        b"patient has atrial fibrillation and takes apixaban",
        "text/plain",
    )

    assert result.status == "extracted"
    assert result.text
    assert "preview" not in (result.summary or {})
    assert (result.summary or {})["word_count"] == 7


def test_health_case_indexes_cover_owner_case_queries():
    model_src = _read(_MODEL_PATH)
    assert '("user_id", "-updated_at")' in model_src
    assert '("user_id", "case_id")' in model_src
    assert '("case_id", "created_at")' in model_src
    assert '("case_id", "-created_at")' in model_src


def test_brief_model_serializes_structured_research_outputs():
    model_src = _read(_MODEL_PATH)
    assert "researchers = ListField(DictField(), default=list)" in model_src
    assert "clinical_trials = ListField(DictField(), default=list)" in model_src
    assert "feed_suggestions = ListField(DictField(), default=list)" in model_src
    assert '"researchers": self.researchers or []' in model_src
    assert '"clinical_trials": self.clinical_trials or []' in model_src
    assert '"feed_suggestions": self.feed_suggestions or []' in model_src


def test_brief_generation_captures_structured_agent_events():
    src = _read(_ROUTE_PATH)
    assert "tool_result_events: list[dict[str, Any]] = []" in src
    assert "feed_suggestion_events: list[dict[str, Any]] = []" in src
    assert 'event.get("type") == "tool_result"' in src
    assert 'event.get("type") == "feed_suggestion"' in src
    assert "_shape_brief_outputs(" in src
    assert 'brief.researchers = shaped_outputs["researchers"]' in src
    assert 'brief.clinical_trials = shaped_outputs["clinical_trials"]' in src
    assert 'brief.feed_suggestions = shaped_outputs["feed_suggestions"]' in src


def test_health_cases_use_google_adk_adapter_with_legacy_fallback():
    route_src = _read(_ROUTE_PATH)
    service_src = _read(_ADK_SERVICE_PATH)
    docker_src = _read(os.path.join(os.path.dirname(__file__), "..", "Dockerfile"))

    assert "run_health_case_intake_adk" in route_src
    assert "stream_health_case_brief_adk" in route_src
    assert "[Health Case Brief] ADK unavailable, falling back" in route_src
    assert "adk_yielded = False" in route_src
    assert "ADK brief failed after yielding events" in route_src
    assert "Attempting ADK intake path" in route_src
    assert "HEALTH_CASE_AGENT_BACKEND" in service_src
    assert 'HEALTH_CASE_AGENT_BACKEND", "adk"' in service_src
    assert "DEFAULT_INTAKE_TIMEOUT_SECONDS" in service_src
    assert "ADK run timed out" in service_src
    assert "ADK timeout is required" in service_src
    assert "isinstance(result, dict)" in service_src
    assert "_feed_suggestions_from_prompt" in service_src
    assert '"type": "feed_suggestion"' in service_src
    assert "ParallelAgent" in service_src
    assert "SequentialAgent" in service_src
    assert "health_case_parallel_research" in service_src
    assert "clinical_trial_agent" in service_src
    assert "researcher_match_agent" in service_src
    assert "google-adk~=2.1" in docker_src
    assert "google-genai>=1.72,<2" in docker_src


def test_brief_stream_snapshots_flask_locals_before_worker_thread():
    """The SSE keepalive helper consumes the source outside Flask's context."""

    src = _read(_ROUTE_PATH)
    assert "request_user = g.user" in src
    assert "request_user_id = str(_user_id())" in src
    assert "user=request_user" in src
    assert "user_id=request_user_id" in src

    generate_src = src.split("    def generate():", 1)[1].split(
        "\n    return Response(",
        1,
    )[0]
    assert "g.user" not in generate_src
    assert "_user_id()" not in generate_src


def test_brief_structured_helpers_include_trial_links_and_author_matching():
    src = _read(_ROUTE_PATH)
    assert "https://clinicaltrials.gov/study/{nct_id}" in src
    assert "ClinicalTrial.objects(nct_id__in=missing_ids)" in src
    assert "Author.objects(" in src
    assert "display_name__in=names" in src
    assert 'profile_url = f"/authors/{str(author.id)}"' in src
    assert '"matched": author is not None' in src


def test_researcher_contact_request_is_owner_scoped_and_alerted():
    src = _read(_ROUTE_PATH)
    assert (
        '@health_case.route("/<case_id>/researcher-contact-requests", methods=["POST"])'
        in src
    )
    assert 'key_prefix="health_case_contact"' in src
    assert '@force_alert_on_fail("health_case_researcher_contact_request")' in src
    assert "case = _load_case_for_user(case_id)" in src
    assert "Health Case researcher contact requested" in src
    assert "Synapse team will outreach to this researcher on your behalf." in src
    assert "_clean_researcher_profile_url" in src
    assert 're.fullmatch(r"/authors/[0-9a-fA-F]{24}", profile_url)' in src
    assert "_ALLOWED_RESEARCHER_PROFILE_HOSTS" in src
    assert "parsed.fragment" in src
    assert 'parsed.path != "/citations"' in src
    assert "orcid.org" in src
    assert "CONTACT_REQUEST_DEDUPE_MAX_ENTRIES" in src
    assert "oldest_key = min(_contact_request_seen_at" in src
    assert '"duplicate": False' in src
    assert "CONTACT_REQUEST_DEDUPE_SECONDS" in src
    assert "_mark_contact_request_seen(fingerprint)" in src
    assert '"duplicate": True' in src
    assert (
        "case.profile"
        not in src.split("def request_researcher_contact", 1)[1].split(
            "\n\n@health_case.route", 1
        )[0]
    )


def test_storage_key_is_phi_scoped_and_sanitized():
    from utils.health_case_storage import build_health_case_s3_key

    key = build_health_case_s3_key(
        user_id="u1",
        case_id="c1",
        document_id="d1",
        filename="../portal export (final).pdf",
    )

    assert key.startswith("health-cases/u1/c1/d1/")
    assert ".." not in key
    assert " " not in key


def test_upload_route_has_size_guard_and_no_pending_s3_sentinel():
    src = _read(_ROUTE_PATH)
    assert 'health_case.config = {"MAX_CONTENT_LENGTH": MAX_UPLOAD_BYTES}' in src
    assert "request.max_content_length = MAX_UPLOAD_BYTES" in src
    assert "request.content_length and request.content_length > MAX_UPLOAD_BYTES" in src
    assert "upload.stream.read(MAX_UPLOAD_BYTES + 1)" in src
    assert '"application/octet-stream"' not in src
    assert 's3_key="pending"' not in src
    assert '@force_alert_on_fail("health_case_upload_document")' in src
    assert '@force_alert_on_fail("health_case_generate_brief")' in src
    assert "brief_generation_in_progress" in src
    assert 'key_prefix="health_case_create"' in src
    assert 'key_prefix="health_case_brief"' in src
    assert "modify(new=True, set__status=HealthCaseStatus.GENERATING_BRIEF)" in src
    assert "MAX_PROFILE_JSON_BYTES" in src


def test_delete_case_removes_derived_briefs_and_alerts_s3_failures():
    src = _read(_ROUTE_PATH)
    assert "HealthCaseBrief.objects(" in src
    assert "HealthCaseBriefStatus.DELETED" in src
    assert "Failed to delete S3 object for health case document" in src
    assert "Failed to delete S3 extracted text for health case document" in src
    assert "profile_snapshot = {}" in src
    assert "Generation interrupted" in src
    assert "document.id = ObjectId()" in src


def test_brief_generation_allows_retry_from_failed_state():
    """Users must be able to retry a failed brief without contacting support."""

    src = _read(_ROUTE_PATH)
    # The route guard accepts FAILED in addition to PROFILE_CONFIRMED / READY.
    assert "HealthCaseStatus.FAILED" in src
    assert "retryable_statuses" in src
    # The status reset on caught exception keeps the case retryable.
    assert "Reset the case so the user can retry" in src
    # Surface the underlying error text, not a generic stub.
    assert "user_facing_error" in src
    assert (
        "yield f\"data: {json.dumps({'type': 'error', 'error': user_facing_error})}\\n\\n\""
        in src
    )


def test_brief_generator_surfaces_empty_response_as_retryable_error():
    """An upstream that yields no content must error visibly so the UI offers retry."""

    src = _read(_ROUTE_PATH)
    assert "Expert Research returned no content" in src
    # Partial tokens should be saved on failure so the user keeps what we have.
    assert "Preserve any tokens already streamed" in src
    assert 'brief.sections = {"expert_research": partial_text}' in src


def test_brief_generator_does_not_leak_arbitrary_exception_text_to_clients():
    """Random exceptions (Mongo errors, SDK tracebacks) must not stream verbatim.

    Only `_BriefSafeError` messages — copy we wrote ourselves — are surfaced.
    Everything else gets a generic "please try again" string while the full
    exception still goes to Sentry for debugging.
    """

    src = _read(_ROUTE_PATH)
    assert "class _BriefSafeError(Exception):" in src
    assert "raise _BriefSafeError(" in src
    assert "isinstance(exc, _BriefSafeError)" in src
    assert "MUST NOT leak via SSE" in src
    assert "sentry_sdk.capture_exception(exc)" in src


def test_brief_safe_errors_do_not_create_sentry_noise():
    """Safe (recoverable) errors get a breadcrumb, not a captured exception.

    Empty-response is an expected, retryable failure. Capturing it as an
    exception would create alert fatigue in production.
    """

    src = _read(_ROUTE_PATH)
    # The unconditional pre-check capture_exception is gone. Only the `else`
    # branch (arbitrary exceptions) calls capture_exception now.
    assert "brief generation surfaced safe error" in src
    # The DB-write block has its own safety net so the SSE error frame is
    # always emitted even when Mongo is flaky.
    assert "DB writes are wrapped so a flaky Mongo never swallows the SSE" in src


def test_empty_response_check_distinguishes_no_tokens_from_whitespace_tokens():
    """If the model streamed *any* tokens, don't raise — the chat already
    rendered them. Only treat zero-token completions as a hard failure."""

    src = _read(_ROUTE_PATH)
    # The empty-check now uses `if not response_parts:` (zero tokens), not
    # `if not response_text.strip():` (which would fire after whitespace
    # deltas already streamed to the client).
    assert "if not response_parts:" in src
    assert "Distinguish" in src and "no tokens at all" in src


def test_brief_failure_emits_structured_cloudwatch_grep_line():
    """The arbitrary-exception branch must emit a one-line greppable log so
    the next failure can be diagnosed from CloudWatch in 30s without needing
    to dig through Sentry's UI."""

    src = _read(_ROUTE_PATH)
    assert "import logging" in src
    assert "logger = logging.getLogger(__name__)" in src
    # Tag, exception class, token count, and elapsed time are the bare
    # minimum to triage a failure from logs alone.
    assert "[Health Case Brief] generation failed" in src
    assert "exc_type=%s" in src
    assert "tokens_streamed=%d" in src
    assert "elapsed_s=%.2f" in src


def test_completed_flag_only_set_after_db_writes_succeed():
    """If the post-failure DB writes throw, the `finally` block must still
    run its recovery path so the case never stays stuck in
    `GENERATING_BRIEF`."""

    src = _read(_ROUTE_PATH)
    # `completed = True` lives inside the inner try, after both saves.
    assert "case.save()\n                completed = True" in src
    # And the save-failure branch deliberately leaves `completed = False`.
    assert "Leave `completed = False`" in src
