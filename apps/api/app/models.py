from datetime import date, datetime
from decimal import Decimal
from enum import StrEnum
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class Role(StrEnum):
    ADMIN = "admin"
    OPERATIVO = "operativo"


class ExpenseState(StrEnum):
    PENDIENTE = "pendiente"
    VALIDADO = "validado"
    RECHAZADO = "rechazado"


class UserContext(BaseModel):
    id: UUID
    role: Role
    phone: str | None = None


class WorkCreate(BaseModel):
    name: str = Field(min_length=2, max_length=180)
    location: str | None = Field(default=None, max_length=300)
    start_date: date | None = None
    end_date: date | None = None


class WorkDelete(BaseModel):
    confirmation_name: str = Field(min_length=2, max_length=180)


class WorkUpdate(BaseModel):
    name: str = Field(min_length=2, max_length=180)
    location: str | None = Field(default=None, max_length=300)
    start_date: date | None = None
    end_date: date | None = None
    state: str = Field(pattern="^(activa|pausada|cerrada)$")

    @model_validator(mode="after")
    def validate_dates(self) -> "WorkUpdate":
        if self.start_date and self.end_date and self.end_date < self.start_date:
            raise ValueError("La fecha final no puede ser anterior a la fecha inicial")
        return self


def normalize_rfc(value: str) -> str:
    """Uppercase alphanumeric RFC; personas morales use 12 characters, físicas 13."""
    cleaned = "".join(character for character in value.upper() if character.isalnum())
    if len(cleaned) not in {12, 13}:
        raise ValueError("El RFC debe contener 12 o 13 caracteres")
    return cleaned


class SupplierProfile(BaseModel):
    name: str = Field(min_length=2, max_length=250)
    legal_name: str | None = Field(default=None, max_length=250)
    tax_id: str | None = Field(default=None, max_length=20)
    tax_regime: str | None = Field(default=None, max_length=250)
    postal_code: str | None = Field(default=None, max_length=10)
    contact_name: str | None = Field(default=None, max_length=180)
    phone: str | None = Field(default=None, max_length=40)
    whatsapp: str | None = Field(default=None, max_length=40)
    email: str | None = Field(default=None, max_length=254)
    address: str | None = Field(default=None, max_length=500)
    coverage: str | None = Field(default=None, max_length=300)
    notes: str | None = Field(default=None, max_length=3000)
    specialty_ids: list[UUID] = Field(default_factory=list, max_length=30)

    @field_validator(
        "name",
        "legal_name",
        "tax_id",
        "tax_regime",
        "postal_code",
        "contact_name",
        "phone",
        "whatsapp",
        "email",
        "address",
        "coverage",
        "notes",
        mode="before",
    )
    @classmethod
    def strip_supplier_text(cls, value: object) -> object:
        if not isinstance(value, str):
            return value
        stripped = value.strip()
        return stripped or None

    @model_validator(mode="after")
    def validate_supplier_identity(self) -> "SupplierProfile":
        self.name = self.name.strip()
        if self.tax_id:
            self.tax_id = normalize_rfc(self.tax_id)
        if self.postal_code and not (
            len(self.postal_code) == 5 and self.postal_code.isascii() and self.postal_code.isdigit()
        ):
            raise ValueError("El código postal debe tener 5 dígitos")
        if self.email and (
            "@" not in self.email or self.email.startswith("@") or self.email.endswith("@")
        ):
            raise ValueError("Correo electrónico inválido")
        self.specialty_ids = list(dict.fromkeys(self.specialty_ids))
        return self


class SupplierCreate(SupplierProfile):
    pass


class SupplierUpdate(SupplierProfile):
    pass


class SupplierArchive(BaseModel):
    reason: str = Field(min_length=5, max_length=500)


class SupplierSpecialtyCreate(BaseModel):
    name: str = Field(min_length=2, max_length=120)

    @field_validator("name", mode="before")
    @classmethod
    def strip_name(cls, value: str) -> str:
        return value.strip()


class SupplierSpecialtyUpdate(SupplierSpecialtyCreate):
    active: bool = True


class WorkSupplierAssignment(BaseModel):
    notes: str | None = Field(default=None, max_length=1000)


class SupplierEvaluationCreate(BaseModel):
    work_id: UUID
    expense_id: UUID | None = None
    work_description: str = Field(min_length=3, max_length=1000)
    service_date: date
    quality: int = Field(ge=1, le=5)
    timeliness: int = Field(ge=1, le=5)
    value: int = Field(ge=1, le=5)
    communication: int = Field(ge=1, le=5)
    safety: int = Field(ge=1, le=5)
    comment: str | None = Field(default=None, max_length=3000)

    @field_validator("work_description", "comment", mode="before")
    @classmethod
    def strip_evaluation_text(cls, value: object) -> object:
        if not isinstance(value, str):
            return value
        stripped = value.strip()
        return stripped or None


class SupplierEvaluationUpdate(SupplierEvaluationCreate):
    pass


class SupplierEvaluationVoid(BaseModel):
    reason: str = Field(min_length=5, max_length=500)


class WeeklyCloseCreate(BaseModel):
    work_id: UUID
    iso_year: int = Field(ge=2000, le=2200)
    iso_week: int = Field(ge=1, le=53)


class WeeklyReopen(BaseModel):
    reason: str = Field(min_length=10, max_length=500)


class ExpenseCreate(BaseModel):
    work_id: UUID
    area_id: UUID
    expense_item_id: UUID
    expense_subitem_id: UUID
    expense_category_id: UUID
    budget_item_id: UUID | None = None
    supplier_id: UUID
    spent_on: date
    concept: str = Field(min_length=3, max_length=500)
    folio: str | None = Field(default=None, max_length=120)
    amount: Decimal = Field(gt=0, decimal_places=4)
    state: ExpenseState = ExpenseState.PENDIENTE


class ExpenseUpdate(BaseModel):
    area_id: UUID
    expense_item_id: UUID
    expense_subitem_id: UUID
    expense_category_id: UUID
    budget_item_id: UUID | None = None
    supplier_id: UUID
    spent_on: date
    concept: str = Field(min_length=3, max_length=500)
    folio: str | None = Field(default=None, max_length=120)
    amount: Decimal = Field(gt=0, decimal_places=4)


class ExpenseReview(BaseModel):
    action: str = Field(pattern="^(validate|reject|return_to_review|resubmit)$")
    reason: str | None = Field(default=None, max_length=500)

    @model_validator(mode="after")
    def require_reason(self) -> "ExpenseReview":
        if self.action in {"reject", "return_to_review"} and (
            self.reason is None or len(self.reason.strip()) < 5
        ):
            raise ValueError("La acción requiere un motivo de al menos 5 caracteres")
        return self


class ExpenseBatchReview(BaseModel):
    work_id: UUID
    expense_ids: list[UUID] = Field(min_length=1, max_length=100)


class ExpenseCancel(BaseModel):
    reason: str = Field(min_length=5, max_length=500)


class ImportConfirm(BaseModel):
    confirmation: bool


class PreviewItemCorrection(BaseModel):
    sheet: str = Field(min_length=1, max_length=180)
    row: int = Field(gt=0)
    area: str = Field(min_length=1, max_length=180)
    work_class: str = Field(min_length=1, max_length=180)
    category: str | None = Field(default=None, max_length=180)
    code: str = Field(min_length=1, max_length=180)
    description: str = Field(min_length=1, max_length=2000)
    unit: str = Field(min_length=1, max_length=80)


class ImportPreviewUpdate(BaseModel):
    items: list[PreviewItemCorrection] = Field(min_length=1, max_length=2000)


class ReceiptUpdate(BaseModel):
    path: str = Field(min_length=10, max_length=500)


class IncomeCreate(BaseModel):
    work_id: UUID
    concept: str = Field(min_length=3, max_length=500)
    estimated_date: date
    actual_date: date | None = None
    amount: Decimal = Field(gt=0, decimal_places=4)
    state: str = Field(pattern="^(cobrado|por_cobrar)$")


class SubcontractCreate(BaseModel):
    work_id: UUID
    subcontractor: str = Field(min_length=2, max_length=250)
    concept: str = Field(min_length=3, max_length=500)
    scope: str | None = Field(default=None, max_length=3000)
    contracted_amount: Decimal = Field(gt=0, decimal_places=4)


class SubcontractPaymentCreate(BaseModel):
    spent_on: date
    amount: Decimal = Field(gt=0, decimal_places=4)
    linked_expense_id: UUID | None = None


class ApiMessage(BaseModel):
    message: str


class HealthResponse(BaseModel):
    status: str
    service: str
    version: str
    timestamp: datetime


class ToolDefinition(BaseModel):
    model_config = ConfigDict(frozen=True)

    name: str
    roles: tuple[Role, ...]
    mutates: bool
    requires_confirmation: bool = False
    description: str


class CsfModelOutput(BaseModel):
    """Strict schema the model must return for a Constancia de Situación Fiscal."""

    model_config = ConfigDict(extra="forbid")

    rfc: str | None
    razon_social: str | None
    regimen_fiscal: str | None
    codigo_postal: str | None
    requiere_validacion_humana: bool
    motivos_revision: list[str]


class ReceiptConceptOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    cantidad: float | None
    precio_unitario: float | None
    descripcion: str | None


class ReceiptModelOutput(BaseModel):
    """Strict schema the model must return for a ticket or nota de remisión."""

    model_config = ConfigDict(extra="forbid")

    total_detectado: float | None
    conceptos: list[ReceiptConceptOutput]
    requiere_validacion_humana: bool
    motivos_revision: list[str]


class CsfExtraction(BaseModel):
    rfc: str | None
    razon_social: str | None
    regimen_fiscal: str | None
    codigo_postal: str | None
    requiere_validacion_humana: bool
    motivos_revision: list[str]


class ReceiptConcept(BaseModel):
    cantidad: Decimal | None
    precio_unitario: Decimal | None
    descripcion: str | None


class ReceiptExtraction(BaseModel):
    total_detectado: Decimal | None
    conceptos: list[ReceiptConcept]
    suma_conceptos: Decimal | None
    requiere_validacion_humana: bool
    motivos_revision: list[str]


class CsfExtractionResponse(BaseModel):
    extraction: CsfExtraction
    model: str | None
    tool_call_log_id: UUID


class ReceiptExtractionResponse(BaseModel):
    extraction: ReceiptExtraction
    model: str | None
    tool_call_log_id: UUID
