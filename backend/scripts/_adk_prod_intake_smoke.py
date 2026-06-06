"""One-shot prod smoke test for the Google ADK Health Case full flow.

Usage:
    /opt/homebrew/Cellar/python@3.11/3.11.15/bin/python3.11 \\
        backend/scripts/_adk_prod_intake_smoke.py

Reads TEST_USER_EMAIL / TEST_USER_PASSWORD / FIREBASE_WEB_API_KEY from .env,
authenticates against Firebase, creates a Health Case on prod, runs intake +
profile + brief generation (SSE stream), then deletes the case to leave no
residue.
"""

from __future__ import annotations

import json
import os
import sys
import time

import requests
from dotenv import load_dotenv

CASE_TEXT = (
    "Here's the 67M with Vision Loss, MacTel, Diabetes, and CKD Health Case "
    "as I have it. Reply yes to generate Expert Research, or send any "
    "clarifications, follow-up questions, or extra records to refine it first. "
    "Conditions of interest: Diabetes, Idiopathic juxtafoveal retinal "
    "telangiectasia, Stage 3A Chronic Kidney Disease (CKD) Symptoms: Vision "
    "loss / going blind Goals: Address vision loss, Manage concurrent "
    "conditions"
)


def _step(n: int, total: int, label: str) -> None:
    print(f"\n[{n}/{total}] {label}", flush=True)


def main() -> int:
    load_dotenv()
    email = os.environ["TEST_USER_EMAIL"]
    password = os.environ["TEST_USER_PASSWORD"]
    api_key = os.environ["FIREBASE_WEB_API_KEY"]

    _step(1, 5, f"Auth as {email} via Firebase")
    auth = requests.post(
        "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword",
        params={"key": api_key},
        json={"email": email, "password": password, "returnSecureToken": True},
        timeout=30,
    )
    auth.raise_for_status()
    id_token = auth.json()["idToken"]
    print("    ok", flush=True)

    base = "https://api.synapsesocial.com"
    headers = {"Authorization": f"Bearer {id_token}"}

    _step(2, 5, "POST /health-cases/intake")
    t0 = time.monotonic()
    resp = requests.post(
        f"{base}/health-cases/intake",
        headers=headers,
        data={"story": CASE_TEXT},
        timeout=180,
    )
    print(f"    status={resp.status_code} elapsed={time.monotonic()-t0:.1f}s")
    if resp.status_code != 200:
        print("    body:", resp.text[:1500])
        return 1
    intake = resp.json().get("intake") or {}
    title = intake.get("title", "Health Case smoke test")
    profile = intake.get("profile") or {}
    condition_terms = intake.get("condition_terms") or []
    print(f"    title='{title}'")
    print(f"    conditions={profile.get('conditions')}")

    _step(3, 5, "POST /health-cases (create case)")
    resp = requests.post(
        f"{base}/health-cases",
        headers={**headers, "Content-Type": "application/json"},
        json={"title": title, "condition_terms": condition_terms},
        timeout=30,
    )
    print(f"    status={resp.status_code}")
    if resp.status_code not in (200, 201):
        print("    body:", resp.text[:1500])
        return 1
    case = resp.json().get("case") or {}
    case_id = case.get("id") or case.get("_id")
    print(f"    case_id={case_id}")

    try:
        _step(4, 5, "POST /health-cases/<id>/profile (lock profile)")
        resp = requests.post(
            f"{base}/health-cases/{case_id}/profile",
            headers={**headers, "Content-Type": "application/json"},
            json=profile,
            timeout=30,
        )
        print(f"    status={resp.status_code}")
        if resp.status_code != 200:
            print("    body:", resp.text[:1500])
            return 1

        _step(5, 5, "POST /health-cases/<id>/briefs (SSE stream)")
        t0 = time.monotonic()
        with requests.post(
            f"{base}/health-cases/{case_id}/briefs",
            headers={**headers, "Content-Type": "application/json"},
            json={},
            timeout=600,
            stream=True,
        ) as resp:
            print(f"    status={resp.status_code}")
            if resp.status_code != 200:
                print("    body:", resp.text[:1500])
                return 1
            tool_results: list[dict] = []
            feed_suggestions: list[dict] = []
            content_chars = 0
            content_buf: list[str] = []
            thinking_seen = []
            done_payload = None
            errored = None
            for raw in resp.iter_lines(decode_unicode=True):
                if not raw or not raw.startswith("data: "):
                    continue
                try:
                    evt = json.loads(raw[6:])
                except Exception:
                    continue
                t = evt.get("type")
                if t == "tool_result":
                    tool_results.append(evt)
                    name = evt.get("tool") or evt.get("name")
                    print(f"    + tool_result tool={name}")
                elif t == "feed_suggestion":
                    feed_suggestions.append(evt)
                elif t == "thinking":
                    thinking_seen.append(evt.get("message") or evt.get("text") or "")
                elif t == "content":
                    chunk = evt.get("content") or ""
                    content_chars += len(chunk)
                    content_buf.append(chunk)
                elif t == "done":
                    done_payload = evt
                    break
                elif t == "error":
                    errored = evt.get("error")
                    break
                elif t in {"brief_started"}:
                    pass
            elapsed = time.monotonic() - t0
            print(f"    stream_elapsed={elapsed:.1f}s")
            print(
                f"    tool_results={len(tool_results)} "
                f"feed_suggestions={len(feed_suggestions)} "
                f"content_chars={content_chars}"
            )
            if errored:
                print(f"    ERROR event: {errored}")
                return 2

        full = "".join(content_buf)
        print("\n--- Tool call summary ---")
        for tr in tool_results:
            tool = tr.get("tool") or tr.get("name")
            ok = tr.get("ok", tr.get("status"))
            count = tr.get("count")
            print(f"  - {tool} ok={ok} count={count}")

        out_path = "/tmp/adk_brief_full.md"
        with open(out_path, "w") as fh:
            fh.write(full)
        print(f"\n--- Brief content (full {len(full)} chars, also at {out_path}) ---")
        print(full)

        if done_payload:
            md = done_payload.get("metadata") or {}
            print("\n--- done.metadata ---")
            print(json.dumps(md, indent=2)[:3000])
        return 0
    finally:
        print("\n[cleanup] DELETE /health-cases/<id>")
        try:
            r = requests.delete(
                f"{base}/health-cases/{case_id}", headers=headers, timeout=30
            )
            print(f"    status={r.status_code}")
        except Exception as exc:
            print(f"    cleanup error: {exc}")


if __name__ == "__main__":
    sys.exit(main())
