from datetime import date, datetime
from decimal import Decimal
from enum import StrEnum
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


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


class WeeklyCloseCreate(BaseModel):
    work_id: UUID
    iso_year: int = Field(ge=2000, le=2200)
    iso_week: int = Field(ge=1, le=53)


class WeeklyReopen(BaseModel):
    reason: str = Field(min_length=10, max_length=500)


class ExpenseCreate(BaseModel):
    work_id: UUID
    area_id: UUID
    budget_item_id: UUID
    supplier_id: UUID | None = None
    spent_on: date
    concept: str = Field(min_length=3, max_length=500)
    folio: str | None = Field(default=None, max_length=120)
    amount: Decimal = Field(gt=0, decimal_places=4)
    state: ExpenseState = ExpenseState.PENDIENTE


class ImportConfirm(BaseModel):
    confirmation: bool


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
