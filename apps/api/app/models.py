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
    # Quick creation from an expense: also assign the supplier to this work atomically.
    work_id: UUID | None = None


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


class ExpenseLineInput(BaseModel):
    """One concept of an expense. Prices include IVA; the server computes the amount."""

    quantity: Decimal = Field(gt=0, max_digits=14, decimal_places=4)
    unit: str = Field(min_length=1, max_length=40)
    description: str = Field(min_length=1, max_length=500)
    unit_price: Decimal = Field(ge=0, max_digits=14, decimal_places=4)
    discount: Decimal = Field(default=Decimal(0), ge=0, max_digits=14, decimal_places=4)

    @field_validator("unit", "description", mode="before")
    @classmethod
    def strip_text(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @model_validator(mode="after")
    def discount_within_gross(self) -> "ExpenseLineInput":
        if self.discount > self.quantity * self.unit_price:
            raise ValueError("El descuento no puede superar cantidad × precio unitario")
        return self


class ExpenseLinesPayload(BaseModel):
    """Shared by create and update: the edit replaces every line."""

    supplier_folio: str | None = Field(default=None, max_length=120)
    lines: list[ExpenseLineInput] = Field(min_length=1, max_length=200)
    iva: Decimal | None = Field(default=None, ge=0, max_digits=14, decimal_places=4)


class OptionalNeodataLink(BaseModel):
    """The NEODATA area is an optional link; a NEODATA budget item belongs to an area."""

    area_id: UUID | None = None
    budget_item_id: UUID | None = None

    @model_validator(mode="after")
    def budget_item_needs_area(self) -> "OptionalNeodataLink":
        if self.budget_item_id is not None and self.area_id is None:
            raise ValueError("La partida NEODATA requiere un área")
        return self


class ExpenseCreate(OptionalNeodataLink, ExpenseLinesPayload):
    work_id: UUID
    expense_item_id: UUID
    expense_subitem_id: UUID
    expense_category_id: UUID
    supplier_id: UUID
    spent_on: date
    concept: str = Field(min_length=3, max_length=500)
    # Accepted for backwards compatibility and ignored: new expenses are always pending.
    state: ExpenseState = ExpenseState.PENDIENTE


class ExpenseUpdate(OptionalNeodataLink, ExpenseLinesPayload):
    expense_item_id: UUID
    expense_subitem_id: UUID
    expense_category_id: UUID
    supplier_id: UUID
    spent_on: date
    concept: str = Field(min_length=3, max_length=500)


class ExpenseLine(BaseModel):
    position: int
    quantity: Decimal
    unit: str
    description: str
    unit_price: Decimal
    discount: Decimal
    amount: Decimal


class ExpenseReceipt(BaseModel):
    id: UUID
    path: str
    kind: str
    created_at: datetime


class ExpenseResponse(BaseModel):
    id: UUID
    folio: str
    supplier_folio: str | None
    work_id: UUID
    spent_on: date
    concept: str
    subtotal: Decimal
    iva: Decimal
    amount: Decimal
    iva_breakdown: bool
    state: str
    lines: list[ExpenseLine]
    receipts: list[ExpenseReceipt]
    # Read-only display data for the detail view (names, not ids).
    supplier_name: str | None = None
    area_path: list[str] = Field(default_factory=list)
    expense_item: str | None = None
    expense_subitem: str | None = None
    expense_category: str | None = None
    budget_item: str | None = None
    author: str | None = None
    created_at: datetime | None = None
    review_reason: str | None = None


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


class LegacyIncomeCreate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    work_id: UUID
    concept: str = Field(min_length=3, max_length=500)
    estimated_date: date
    actual_date: date | None = None
    amount: Decimal = Field(gt=0, max_digits=18, decimal_places=4)
    state: str = Field(pattern="^(cobrado|por_cobrar)$")


class IncomeState(StrEnum):
    PENDIENTE = "pendiente"
    CONCILIADO = "conciliado"


class IncomeCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    received_on: date
    concept: str = Field(min_length=3, max_length=500)
    amount: Decimal = Field(gt=0, max_digits=18, decimal_places=4)
    state: IncomeState = IncomeState.PENDIENTE


class IncomeUpdate(BaseModel):
    """Partial edit of an income's data; state changes go through /status."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    received_on: date | None = None
    concept: str | None = Field(default=None, min_length=3, max_length=500)
    amount: Decimal | None = Field(default=None, gt=0, max_digits=18, decimal_places=4)

    @model_validator(mode="after")
    def at_least_one_field(self) -> "IncomeUpdate":
        if not self.model_fields_set or all(
            getattr(self, name) is None for name in self.model_fields_set
        ):
            raise ValueError("Indica al menos un campo a modificar")
        return self


class IncomeReceiptCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    path: str = Field(min_length=10, max_length=500)


class IncomeReceipt(BaseModel):
    id: UUID
    path: str
    kind: str
    created_at: datetime


class IncomeResponse(BaseModel):
    id: UUID
    work_id: UUID
    folio: str
    received_on: date
    concept: str
    amount: Decimal
    state: IncomeState
    created_by: UUID
    created_at: datetime
    receipts: list[IncomeReceipt] = Field(default_factory=list)
    reconciled_at: datetime | None = None
    reconciled_by: str | None = None
    reversal_reason: str | None = None


class IncomeStatusUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    state: IncomeState
    reason: str | None = Field(default=None, max_length=500)

    @model_validator(mode="after")
    def reversal_needs_reason(self) -> "IncomeStatusUpdate":
        if self.state is IncomeState.PENDIENTE and (not self.reason or len(self.reason) < 5):
            raise ValueError("Revertir una conciliación requiere un motivo (mínimo 5 caracteres)")
        return self


class IncomeBatchReconcile(BaseModel):
    model_config = ConfigDict(extra="forbid")

    work_id: UUID
    income_ids: list[UUID] = Field(min_length=1, max_length=100)


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
    unidad: str | None
    precio_unitario: float | None
    importe: float | None
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
    unidad: str | None = None
    precio_unitario: Decimal | None
    importe: Decimal | None = None
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


class JevModelOutput(BaseModel):
    """Strict schema for the Árbitro Jev: the corrected receipt plus a short reply."""

    model_config = ConfigDict(extra="forbid")

    total_detectado: float | None
    conceptos: list[ReceiptConceptOutput]
    requiere_validacion_humana: bool
    motivos_revision: list[str]
    respuesta: str


class JevChatRequest(BaseModel):
    extraction: ReceiptExtraction
    instruction: str = Field(min_length=2, max_length=1000)

    @model_validator(mode="after")
    def bound_prompt_size(self) -> "JevChatRequest":
        self.instruction = self.instruction.strip()
        if len(self.instruction) < 2:
            raise ValueError("Escribe la corrección que necesitas")
        if len(self.extraction.conceptos) > 100:
            raise ValueError("El comprobante no puede tener más de 100 conceptos")
        if any(len(item.descripcion or "") > 500 for item in self.extraction.conceptos):
            raise ValueError("Cada descripción debe tener como máximo 500 caracteres")
        if len(self.extraction.motivos_revision) > 50:
            raise ValueError("Demasiados motivos de revisión")
        return self


class JevChatResponse(BaseModel):
    extraction: ReceiptExtraction
    respuesta: str
    model: str | None
    tool_call_log_id: UUID


class CfdiIssuer(BaseModel):
    rfc: str
    name: str | None
    tax_regime: str | None


class CfdiConceptOut(BaseModel):
    product_code: str | None
    quantity: Decimal
    unit_code: str | None
    unit: str | None
    description: str
    unit_value: Decimal  # ValorUnitario: sin impuestos
    discount: Decimal
    amount: Decimal  # Importe: cantidad × valor unitario, sin impuestos
    iva: Decimal


class CfdiSupplierMatch(BaseModel):
    id: UUID
    name: str
    active: bool
    assigned_to_work: bool | None


class CfdiExpenseDraft(BaseModel):
    """Ready-to-submit expense lines (prices WITH taxes) whose sum equals the CFDI."""

    supplier_folio: str | None
    concept: str
    lines: list[ExpenseLineInput]
    iva: Decimal
    amount: Decimal


class CfdiExtractionResponse(BaseModel):
    version: str
    uuid: str | None
    series: str | None
    folio: str | None
    issued_at: str | None
    currency: str | None
    voucher_type: str | None
    issuer: CfdiIssuer
    receiver_rfc: str | None
    concepts: list[CfdiConceptOut]
    subtotal: Decimal
    discount: Decimal
    iva: Decimal
    withholdings: Decimal
    total: Decimal
    supplier: CfdiSupplierMatch | None
    expense: CfdiExpenseDraft
    requires_review: bool
    warnings: list[str]
