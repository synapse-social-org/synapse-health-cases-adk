"""Patient-facing Health Case models for medical-record research workflows."""

from datetime import datetime, timezone

from mongoengine import (
    BooleanField,
    DateTimeField,
    DictField,
    Document,
    EmbeddedDocument,
    EmbeddedDocumentField,
    IntField,
    ListField,
    ObjectIdField,
    StringField,
)


def _now_utc():
    return datetime.now(timezone.utc)


class HealthCaseStatus:
    DRAFT = "draft"
    EXTRACTING = "extracting"
    READY_FOR_REVIEW = "ready_for_review"
    PROFILE_CONFIRMED = "profile_confirmed"
    GENERATING_BRIEF = "generating_brief"
    READY = "ready"
    FAILED = "failed"
    DELETED = "deleted"


class HealthCaseDocumentStatus:
    UPLOADED = "uploaded"
    EXTRACTING = "extracting"
    EXTRACTED = "extracted"
    NEEDS_MANUAL_REVIEW = "needs_manual_review"
    FAILED = "failed"
    DELETED = "deleted"


class HealthCaseBriefStatus:
    GENERATING = "generating"
    READY = "ready"
    FAILED = "failed"
    DELETED = "deleted"


class HealthCaseDigestStatus:
    SENT = "sent"
    SKIPPED_NO_UPDATES = "skipped_no_updates"
    FAILED = "failed"


class HealthCaseProfile(EmbeddedDocument):
    """User-reviewed medical context derived from records and manual entry."""

    # Structured demographics ({"sex": "...", "age": ...}). Sex drives selection
    # of the correct sex-specific Quest lab reference range; age refines
    # age-banded references (e.g. DHEA-S, IGF-1).
    demographics = DictField(default=dict)
    conditions = ListField(StringField(), default=list)
    symptoms = ListField(StringField(), default=list)
    medications = ListField(StringField(), default=list)
    procedures = ListField(StringField(), default=list)
    labs = ListField(DictField(), default=list)
    timeline = ListField(DictField(), default=list)
    goals = ListField(StringField(), default=list)
    location_preferences = DictField(default=dict)
    questions = ListField(StringField(), default=list)
    notes = StringField()
    # Research-targeting hypotheses inferred by the intake agent. These are NOT
    # diagnoses: each entry must cite the explicit ``signals`` it was derived
    # from so the user (and the brief) can judge it. ``phenotypes`` are
    # candidate subgroups the patient may belong to; ``organ_age_flags`` are
    # qualitative organ-age-gap hypotheses (we do not compute a numeric
    # biological age).
    phenotypes = ListField(DictField(), default=list)
    organ_age_flags = ListField(DictField(), default=list)
    # Canonical conditions normalized via the structured clinical dictionary
    # (ICD-10, organ axes, optional severity grade when explicitly supported).
    structured_conditions = ListField(DictField(), default=list)
    updated_at = DateTimeField()

    def to_dict(self) -> dict:
        return {
            "demographics": self.demographics or {},
            "conditions": self.conditions or [],
            "symptoms": self.symptoms or [],
            "medications": self.medications or [],
            "procedures": self.procedures or [],
            "labs": self.labs or [],
            "timeline": self.timeline or [],
            "goals": self.goals or [],
            "location_preferences": self.location_preferences or {},
            "questions": self.questions or [],
            "notes": self.notes or "",
            "phenotypes": self.phenotypes or [],
            "organ_age_flags": self.organ_age_flags or [],
            "structured_conditions": self.structured_conditions or [],
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


class HealthCase(Document):
    user_id = ObjectIdField(required=True)
    title = StringField(required=True, max_length=160)
    primary_specialty = StringField(default="")
    condition_terms = ListField(StringField(), default=list)
    status = StringField(default=HealthCaseStatus.DRAFT)
    profile = EmbeddedDocumentField(HealthCaseProfile, default=HealthCaseProfile)
    # Weekly digest subscription. ``digest_email`` lets an anonymous guest
    # subscribe with an email without a full signup; for signed-in users we
    # fall back to their account email at send time. ``last_digest_at`` is the
    # delta watermark for "what's new since your last update".
    digest_enabled = BooleanField(default=False)
    digest_email = StringField(max_length=320)
    last_digest_at = DateTimeField()
    created_at = DateTimeField(default=_now_utc)
    updated_at = DateTimeField(default=_now_utc)
    deleted_at = DateTimeField()

    meta = {
        "collection": "health_cases",
        "ordering": ["-updated_at"],
        "indexes": [
            ("user_id", "-updated_at"),
            ("user_id", "status"),
            # Drives the weekly digest cron sweep over subscribed cases.
            ("digest_enabled", "last_digest_at"),
            "deleted_at",
        ],
    }

    def save(self, *args, **kwargs):
        self.updated_at = _now_utc()
        return super().save(*args, **kwargs)

    def to_dict(self) -> dict:
        return {
            "id": str(self.id),
            "title": self.title,
            "primary_specialty": self.primary_specialty,
            "condition_terms": self.condition_terms or [],
            "status": self.status,
            "profile": self.profile.to_dict() if self.profile else {},
            "digest_enabled": bool(self.digest_enabled),
            # Whether a delivery address is on file (either a guest-supplied
            # digest_email or, resolved at send time, the account email). The
            # raw address is intentionally not serialized to clients.
            "digest_email_set": bool(self.digest_email),
            "last_digest_at": (
                self.last_digest_at.isoformat() if self.last_digest_at else None
            ),
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
            "deleted_at": self.deleted_at.isoformat() if self.deleted_at else None,
        }


class HealthCaseDocument(Document):
    case_id = ObjectIdField(required=True)
    user_id = ObjectIdField(required=True)
    filename = StringField(required=True, max_length=255)
    content_type = StringField(required=True, max_length=120)
    size_bytes = IntField(default=0)
    checksum_sha256 = StringField(max_length=64)
    s3_key = StringField()
    extracted_text_s3_key = StringField()
    extraction_summary = DictField(default=dict)
    status = StringField(default=HealthCaseDocumentStatus.UPLOADED)
    error_message = StringField(max_length=500)
    created_at = DateTimeField(default=_now_utc)
    updated_at = DateTimeField(default=_now_utc)
    deleted_at = DateTimeField()

    meta = {
        "collection": "health_case_documents",
        "ordering": ["-created_at"],
        "indexes": [
            ("user_id", "case_id"),
            ("case_id", "created_at"),
            ("user_id", "status"),
            "deleted_at",
        ],
    }

    def save(self, *args, **kwargs):
        self.updated_at = _now_utc()
        return super().save(*args, **kwargs)

    def to_dict(self) -> dict:
        return {
            "id": str(self.id),
            "case_id": str(self.case_id),
            "filename": self.filename,
            "content_type": self.content_type,
            "size_bytes": self.size_bytes or 0,
            "status": self.status,
            "extraction_summary": self.extraction_summary or {},
            "error_message": self.error_message,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


class HealthCaseBrief(Document):
    case_id = ObjectIdField(required=True)
    user_id = ObjectIdField(required=True)
    profile_snapshot = DictField(default=dict)
    sections = DictField(default=dict)
    sources = ListField(DictField(), default=list)
    researchers = ListField(DictField(), default=list)
    clinical_trials = ListField(DictField(), default=list)
    feed_suggestions = ListField(DictField(), default=list)
    # Post-generation hallucination guard output:
    # {verified_ncts, unverified_ncts, unverified_acronyms}. Persisted so the
    # "references we couldn't verify" warning survives a page reload, not just
    # the live SSE stream.
    citation_grounding = DictField(default=dict)
    status = StringField(default=HealthCaseBriefStatus.GENERATING)
    model = StringField(default="synapse-research-agent")
    error_message = StringField(max_length=500)
    created_at = DateTimeField(default=_now_utc)
    updated_at = DateTimeField(default=_now_utc)
    deleted_at = DateTimeField()

    meta = {
        "collection": "health_case_briefs",
        "ordering": ["-created_at"],
        "indexes": [
            ("user_id", "case_id"),
            ("case_id", "-created_at"),
            ("user_id", "status"),
        ],
    }

    def save(self, *args, **kwargs):
        self.updated_at = _now_utc()
        return super().save(*args, **kwargs)

    def to_dict(self) -> dict:
        return {
            "id": str(self.id),
            "case_id": str(self.case_id),
            "status": self.status,
            "sections": self.sections or {},
            "sources": self.sources or [],
            "researchers": self.researchers or [],
            "clinical_trials": self.clinical_trials or [],
            "feed_suggestions": self.feed_suggestions or [],
            "citation_grounding": self.citation_grounding or {},
            "model": self.model,
            "error_message": self.error_message,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
            "deleted_at": self.deleted_at.isoformat() if self.deleted_at else None,
        }


class HealthCaseDigest(Document):
    """One row per weekly digest send attempt for a Health Case.

    Acts as the idempotency + history log for the digest cron: ``item_ids``
    records which papers/trials/discourse items were included so a re-run in the
    same window does not resurface them, and ``status`` distinguishes a real
    send from a "nothing new this week" skip.
    """

    case_id = ObjectIdField(required=True)
    user_id = ObjectIdField(required=True)
    status = StringField(default=HealthCaseDigestStatus.SENT)
    item_ids = ListField(StringField(), default=list)
    item_count = IntField(default=0)
    window_start = DateTimeField()
    window_end = DateTimeField()
    error_message = StringField(max_length=500)
    sent_at = DateTimeField(default=_now_utc)
    created_at = DateTimeField(default=_now_utc)

    meta = {
        "collection": "health_case_digests",
        "ordering": ["-created_at"],
        "indexes": [
            ("case_id", "-created_at"),
            ("user_id", "-created_at"),
        ],
    }

    def to_dict(self) -> dict:
        return {
            "id": str(self.id),
            "case_id": str(self.case_id),
            "status": self.status,
            "item_count": self.item_count or 0,
            "window_start": (
                self.window_start.isoformat() if self.window_start else None
            ),
            "window_end": self.window_end.isoformat() if self.window_end else None,
            "sent_at": self.sent_at.isoformat() if self.sent_at else None,
        }
