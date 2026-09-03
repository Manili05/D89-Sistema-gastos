from datetime import date, datetime
from decimal import Decimal
from enum import StrEnum
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator


class Role(StrEnum):
    ADMIN = "admin"
    OPERATIVO = "operativo"


class ExpenseState(StrEnum):
    PENDIENTE = "pendiente"
    VALIDADO = "validado"


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
    supplier_id: UUID | None = None
    supplier_name: str | None = Field(default=None, min_length=2, max_length=250)
    spent_on: date
    concept: str = Field(min_length=3, max_length=500)
    folio: str | None = Field(default=None, max_length=120)
    amount: Decimal = Field(gt=0, decimal_places=4)
    state: ExpenseState = ExpenseState.PENDIENTE

    @model_validator(mode="after")
    def require_one_supplier(self) -> "ExpenseCreate":
        if (self.supplier_id is None) == (self.supplier_name is None):
            raise ValueError("Indica un proveedor existente o el nombre de uno nuevo")
        if self.supplier_name is not None:
            self.supplier_name = self.supplier_name.strip()
            if len(self.supplier_name) < 2:
                raise ValueError("El nombre del proveedor es demasiado corto")
        return self


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
