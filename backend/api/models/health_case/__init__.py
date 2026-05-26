"""Patient-facing Health Case models for medical-record research workflows."""

from datetime import datetime, timezone

from mongoengine import (
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


class HealthCaseProfile(EmbeddedDocument):
    """User-reviewed medical context derived from records and manual entry."""

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
    updated_at = DateTimeField()

    def to_dict(self) -> dict:
        return {
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
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


class HealthCase(Document):
    user_id = ObjectIdField(required=True)
    title = StringField(required=True, max_length=160)
    primary_specialty = StringField(default="cardiology")
    condition_terms = ListField(StringField(), default=list)
    status = StringField(default=HealthCaseStatus.DRAFT)
    profile = EmbeddedDocumentField(HealthCaseProfile, default=HealthCaseProfile)
    created_at = DateTimeField(default=_now_utc)
    updated_at = DateTimeField(default=_now_utc)
    deleted_at = DateTimeField()

    meta = {
        "collection": "health_cases",
        "ordering": ["-updated_at"],
        "indexes": [
            ("user_id", "-updated_at"),
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
            "title": self.title,
            "primary_specialty": self.primary_specialty,
            "condition_terms": self.condition_terms or [],
            "status": self.status,
            "profile": self.profile.to_dict() if self.profile else {},
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
            "model": self.model,
            "error_message": self.error_message,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
            "deleted_at": self.deleted_at.isoformat() if self.deleted_at else None,
        }
