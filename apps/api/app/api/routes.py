from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Annotated, Any
from uuid import UUID

from fastapi import (
    APIRouter,
    Body,
    Depends,
    File,
    Form,
    Header,
    HTTPException,
    Query,
    UploadFile,
    status,
)
from fastapi.responses import Response

from app.core.config import Settings, get_settings
from app.core.security import AdminUser, CurrentUser, HermesSignature
from app.models import (
    CfdiExtractionResponse,
    CsfExtractionResponse,
    EstimationCreate,
    EstimationResponse,
    EstimationStatusUpdate,
    EstimationUpdate,
    ExpenseBatchReview,
    ExpenseCancel,
    ExpenseCreate,
    ExpenseResponse,
    ExpenseReview,
    ExpenseUpdate,
    HealthResponse,
    ImportConfirm,
    ImportPreviewUpdate,
    IncomeBatchReconcile,
    IncomeCreate,
    IncomeReceiptCreate,
    IncomeResponse,
    IncomeStatusUpdate,
    IncomeUpdate,
    JevChatRequest,
    JevChatResponse,
    LegacyIncomeCreate,
    ReceiptExtractionResponse,
    ReceiptUpdate,
    SubcontractCreate,
    SubcontractResponse,
    SubcontractUpdate,
    SupplierArchive,
    SupplierCreate,
    SupplierEvaluationCreate,
    SupplierEvaluationUpdate,
    SupplierEvaluationVoid,
    SupplierSpecialtyCreate,
    SupplierSpecialtyUpdate,
    SupplierUpdate,
    ToolDefinition,
    WeeklyCloseCreate,
    WeeklyReopen,
    WorkCreate,
    WorkDelete,
    WorkSupplierAssignment,
    WorkUpdate,
)
from app.services.ai_extraction import extract_csf, extract_receipt, jev_chat
from app.services.cfdi import extract_cfdi
from app.services.neodata import NeodataError, parse_neodata_workbook
from app.services.reports import build_excel_report, build_pdf_report
from app.services.repository import (
    attach_income_receipt,
    attach_receipt,
    cancel_expense,
    close_week,
    confirm_import,
    create_estimation,
    create_expense,
    create_income,
    create_legacy_income,
    create_subcontract,
    create_work,
    dashboard,
    delete_estimation,
    delete_work,
    get_expense,
    get_income,
    get_subcontract,
    get_work,
    list_expenses,
    list_incomes,
    list_legacy_incomes,
    list_subcontracts,
    list_weekly_closes,
    list_work_expenses,
    list_works,
    pay_estimation,
    reconcile_incomes_batch,
    reopen_week,
    report_expenses,
    review_expense,
    store_import_preview,
    update_estimation,
    update_expense,
    update_import_preview,
    update_income,
    update_income_status,
    update_subcontract,
    update_work,
    validate_expenses_batch,
    weekly_close_preview,
    work_catalog,
    work_overview,
)
from app.services.suppliers import (
    archive_supplier,
    assign_supplier_to_work,
    create_supplier,
    create_supplier_evaluation,
    create_supplier_specialty,
    get_supplier,
    list_supplier_specialties,
    list_suppliers,
    restore_supplier,
    supplier_analytics,
    unassign_supplier_from_work,
    update_supplier,
    update_supplier_evaluation,
    update_supplier_specialty,
    void_supplier_evaluation,
)
from app.services.tools import WHATSAPP_TOOLS

router = APIRouter(prefix="/api/v1")


@router.get("/health", response_model=HealthResponse, tags=["platform"])
async def api_health() -> HealthResponse:
    return HealthResponse(
        status="ok",
        service="d89-api",
        version="0.1.0",
        timestamp=datetime.now(UTC),
    )


@router.get("/works", tags=["works"])
def get_works(
    user: CurrentUser, settings: Annotated[Settings, Depends(get_settings)]
) -> list[dict[str, Any]]:
    return list_works(settings, user)


@router.post("/works", status_code=status.HTTP_201_CREATED, tags=["works"])
def post_work(
    payload: WorkCreate,
    user: AdminUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    return create_work(settings, user, payload)


@router.delete("/works/{work_id}", tags=["works"])
def remove_work(
    work_id: UUID,
    payload: WorkDelete,
    user: AdminUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    return delete_work(settings, user, work_id, payload)


@router.get("/works/{work_id}", tags=["works"])
def get_work_detail(
    work_id: UUID,
    user: CurrentUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    return get_work(settings, user, work_id)


@router.patch("/works/{work_id}", tags=["works"])
def patch_work(
    work_id: UUID,
    payload: WorkUpdate,
    user: AdminUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    return update_work(settings, user, work_id, payload)


@router.get("/works/{work_id}/catalog", tags=["works"])
def get_work_catalog(
    work_id: UUID,
    user: CurrentUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    return work_catalog(settings, user, work_id)


@router.get("/dashboard", tags=["dashboard"])
def get_dashboard(
    user: CurrentUser, settings: Annotated[Settings, Depends(get_settings)]
) -> dict[str, Any]:
    return dashboard(settings, user)


@router.get("/supplier-specialties", tags=["suppliers"])
def get_supplier_specialties(
    user: CurrentUser,
    settings: Annotated[Settings, Depends(get_settings)],
    include_inactive: bool = False,
) -> list[dict[str, Any]]:
    return list_supplier_specialties(settings, user, include_inactive)


@router.post("/supplier-specialties", status_code=status.HTTP_201_CREATED, tags=["suppliers"])
def post_supplier_specialty(
    payload: SupplierSpecialtyCreate,
    user: AdminUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    return create_supplier_specialty(settings, user, payload)


@router.patch("/supplier-specialties/{specialty_id}", tags=["suppliers"])
def patch_supplier_specialty(
    specialty_id: UUID,
    payload: SupplierSpecialtyUpdate,
    user: AdminUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    return update_supplier_specialty(settings, user, specialty_id, payload)


@router.get("/suppliers/analytics", tags=["suppliers"])
def get_supplier_analytics(
    user: CurrentUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    return supplier_analytics(settings, user)


@router.get("/suppliers", tags=["suppliers"])
def get_suppliers(
    user: CurrentUser,
    settings: Annotated[Settings, Depends(get_settings)],
    q: str | None = None,
    specialty_id: UUID | None = None,
    min_rating: Annotated[Decimal | None, Query(ge=1, le=5)] = None,
    active: bool | None = True,
    include_archived: bool = False,
    work_id: UUID | None = None,
    sort: Annotated[str, Query(pattern="^(name|rating|jobs|spend)$")] = "name",
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 25,
) -> dict[str, Any]:
    return list_suppliers(
        settings,
        user,
        query=q,
        specialty_id=specialty_id,
        min_rating=min_rating,
        active=None if include_archived else active,
        work_id=work_id,
        sort=sort,
        page=page,
        page_size=page_size,
    )


@router.post("/suppliers", status_code=status.HTTP_201_CREATED, tags=["suppliers"])
def post_supplier(
    payload: SupplierCreate,
    user: AdminUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    return create_supplier(settings, user, payload)


@router.get("/suppliers/{supplier_id}", tags=["suppliers"])
def get_supplier_detail(
    supplier_id: UUID,
    user: CurrentUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    return get_supplier(settings, user, supplier_id)


@router.patch("/suppliers/{supplier_id}", tags=["suppliers"])
def patch_supplier(
    supplier_id: UUID,
    payload: SupplierUpdate,
    user: AdminUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    return update_supplier(settings, user, supplier_id, payload)


@router.delete("/suppliers/{supplier_id}", tags=["suppliers"])
def delete_supplier(
    supplier_id: UUID,
    payload: SupplierArchive,
    user: AdminUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    return archive_supplier(settings, user, supplier_id, payload)


@router.post("/suppliers/extract-csf", response_model=CsfExtractionResponse, tags=["suppliers"])
async def post_extract_csf(
    admin: AdminUser,
    file: Annotated[UploadFile, File(description="Constancia de Situación Fiscal del SAT (PDF)")],
    settings: Annotated[Settings, Depends(get_settings)],
) -> CsfExtractionResponse:
    """Propose supplier fiscal data from a CSF; nothing is persisted besides tool_call_log."""
    content = await file.read(settings.ai_max_upload_bytes + 1)
    return await extract_csf(settings, admin, content, file.content_type)


@router.post("/suppliers/{supplier_id}/restore", tags=["suppliers"])
def post_supplier_restore(
    supplier_id: UUID,
    user: AdminUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    return restore_supplier(settings, user, supplier_id)


@router.put("/suppliers/{supplier_id}/works/{work_id}", tags=["suppliers"])
def put_supplier_work(
    supplier_id: UUID,
    work_id: UUID,
    payload: WorkSupplierAssignment,
    user: AdminUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    return assign_supplier_to_work(settings, user, supplier_id, work_id, payload)


@router.delete("/suppliers/{supplier_id}/works/{work_id}", tags=["suppliers"])
def delete_supplier_work(
    supplier_id: UUID,
    work_id: UUID,
    user: AdminUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    return unassign_supplier_from_work(settings, user, supplier_id, work_id)


@router.post(
    "/suppliers/{supplier_id}/evaluations",
    status_code=status.HTTP_201_CREATED,
    tags=["suppliers"],
)
def post_supplier_evaluation(
    supplier_id: UUID,
    payload: SupplierEvaluationCreate,
    user: AdminUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    return create_supplier_evaluation(settings, user, supplier_id, payload)


@router.patch("/suppliers/{supplier_id}/evaluations/{evaluation_id}", tags=["suppliers"])
def patch_supplier_evaluation(
    supplier_id: UUID,
    evaluation_id: UUID,
    payload: SupplierEvaluationUpdate,
    user: AdminUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    return update_supplier_evaluation(settings, user, supplier_id, evaluation_id, payload)


@router.delete("/suppliers/{supplier_id}/evaluations/{evaluation_id}", tags=["suppliers"])
def delete_supplier_evaluation(
    supplier_id: UUID,
    evaluation_id: UUID,
    payload: SupplierEvaluationVoid,
    user: AdminUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    return void_supplier_evaluation(settings, user, supplier_id, evaluation_id, payload.reason)


@router.get("/works/{work_id}/overview", tags=["dashboard"])
def get_work_overview(
    work_id: UUID,
    user: CurrentUser,
    settings: Annotated[Settings, Depends(get_settings)],
    date_from: Annotated[date | None, Query(alias="from")] = None,
    date_to: Annotated[date | None, Query(alias="to")] = None,
) -> dict[str, Any]:
    if date_from and date_to and date_to < date_from:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Rango de fechas inválido")
    return work_overview(settings, user, work_id, date_from, date_to)


@router.get("/works/{work_id}/expenses", tags=["expenses"])
def get_work_expenses(
    work_id: UUID,
    user: CurrentUser,
    settings: Annotated[Settings, Depends(get_settings)],
    date_from: Annotated[date | None, Query(alias="from")] = None,
    date_to: Annotated[date | None, Query(alias="to")] = None,
    expense_state: Annotated[str | None, Query(alias="state")] = None,
    area_id: UUID | None = None,
    q: str | None = None,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 25,
) -> dict[str, Any]:
    return list_work_expenses(
        settings,
        user,
        work_id,
        date_from=date_from,
        date_to=date_to,
        expense_state=expense_state,
        area_id=area_id,
        query=q,
        page=page,
        page_size=page_size,
    )


@router.get("/expenses", tags=["expenses"])
def get_expenses(
    work_id: UUID,
    user: CurrentUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> list[dict[str, Any]]:
    return list_expenses(settings, user, work_id)


@router.post(
    "/expenses",
    status_code=status.HTTP_201_CREATED,
    response_model=ExpenseResponse,
    tags=["expenses"],
)
def post_expense(
    payload: ExpenseCreate,
    user: CurrentUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    return create_expense(settings, user, payload)


@router.patch(
    "/expenses/{expense_id}/receipt", response_model=ExpenseResponse, tags=["expenses"]
)
def patch_expense_receipt(
    expense_id: UUID,
    payload: ReceiptUpdate,
    user: CurrentUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    return attach_receipt(settings, user, expense_id, payload.path)


@router.get("/expenses/{expense_id}", response_model=ExpenseResponse, tags=["expenses"])
def get_expense_detail(
    expense_id: UUID,
    user: CurrentUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    """Header, lines and receipts of one expense (edit form)."""
    return get_expense(settings, user, expense_id)


@router.patch("/expenses/{expense_id}", response_model=ExpenseResponse, tags=["expenses"])
def patch_expense(
    expense_id: UUID,
    payload: ExpenseUpdate,
    user: CurrentUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    return update_expense(settings, user, expense_id, payload)


@router.post(
    "/expenses/extract-receipt", response_model=ReceiptExtractionResponse, tags=["expenses"]
)
async def post_extract_receipt(
    user: CurrentUser,
    file: Annotated[UploadFile, File(description="Foto del ticket o nota de remisión")],
    settings: Annotated[Settings, Depends(get_settings)],
) -> ReceiptExtractionResponse:
    """Propose receipt lines from an image; the server recomputes totals before answering."""
    content = await file.read(settings.ai_max_upload_bytes + 1)
    return await extract_receipt(settings, user, content, file.content_type)


@router.post(
    "/expenses/extract-xml", response_model=CfdiExtractionResponse, tags=["expenses"]
)
async def post_extract_cfdi(
    user: CurrentUser,
    file: Annotated[UploadFile, File(description="XML del CFDI (factura electrónica)")],
    settings: Annotated[Settings, Depends(get_settings)],
    work_id: Annotated[UUID | None, Form()] = None,
) -> dict[str, Any]:
    """Read a CFDI 3.3/4.0 without AI: issuer, concepts, taxes and a ready expense draft."""
    content = await file.read(settings.cfdi_max_bytes + 1)
    return extract_cfdi(settings, user, content, file.content_type, file.filename, work_id)


@router.post("/expenses/jev-chat", response_model=JevChatResponse, tags=["expenses"])
async def post_jev_chat(
    payload: JevChatRequest,
    user: CurrentUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> JevChatResponse:
    """Árbitro Jev: correct a receipt extraction in natural language; nothing is persisted."""
    return await jev_chat(settings, user, payload)


@router.post("/expenses/{expense_id}/review", tags=["expenses"])
def post_expense_review(
    expense_id: UUID,
    payload: ExpenseReview,
    user: CurrentUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    return review_expense(settings, user, expense_id, payload.action, payload.reason)


@router.post("/expenses/review-batch", tags=["expenses"])
def post_expense_batch_review(
    payload: ExpenseBatchReview,
    user: AdminUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    return validate_expenses_batch(settings, user, payload.work_id, payload.expense_ids)


@router.post("/expenses/{expense_id}/cancel", tags=["expenses"])
def post_expense_cancel(
    expense_id: UUID,
    payload: ExpenseCancel,
    user: CurrentUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    return cancel_expense(settings, user, expense_id, payload.reason)


@router.get("/incomes", tags=["cashflow"])
def get_incomes(
    work_id: UUID,
    user: CurrentUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> list[dict[str, Any]]:
    return list_legacy_incomes(settings, user, work_id)


@router.post("/incomes", status_code=status.HTTP_201_CREATED, tags=["cashflow"])
def post_income(
    payload: LegacyIncomeCreate,
    user: AdminUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    return create_legacy_income(settings, user, payload)


@router.get("/works/{work_id}/incomes", response_model=list[IncomeResponse], tags=["cashflow"])
def get_work_incomes(
    work_id: UUID,
    user: CurrentUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> list[dict[str, Any]]:
    return list_incomes(settings, user, work_id)


@router.post(
    "/works/{work_id}/incomes", response_model=IncomeResponse,
    status_code=status.HTTP_201_CREATED, tags=["cashflow"],
)
def post_work_income(
    work_id: UUID,
    payload: IncomeCreate,
    user: AdminUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    return create_income(settings, user, work_id, payload)


@router.get("/incomes/{income_id}", response_model=IncomeResponse, tags=["cashflow"])
def get_income_detail(
    income_id: UUID,
    user: CurrentUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    return get_income(settings, user, income_id)


@router.patch("/incomes/{income_id}", response_model=IncomeResponse, tags=["cashflow"])
def patch_income(
    income_id: UUID,
    payload: IncomeUpdate,
    user: AdminUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    """Edit date, concept or amount (admin). The state is changed only via /status."""
    return update_income(settings, user, income_id, payload)


@router.patch("/incomes/{income_id}/status", response_model=IncomeResponse, tags=["cashflow"])
def patch_income_status(
    income_id: UUID,
    payload: IncomeStatusUpdate,
    user: AdminUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    """Reconcile (needs a stored receipt) or revert to pending (needs a reason)."""
    return update_income_status(settings, user, income_id, payload)


@router.post("/incomes/reconcile-batch", tags=["cashflow"])
def post_incomes_reconcile_batch(
    payload: IncomeBatchReconcile,
    user: AdminUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    return reconcile_incomes_batch(settings, user, payload)


@router.post("/incomes/{income_id}/receipts", response_model=IncomeResponse, tags=["cashflow"])
def post_income_receipt(
    income_id: UUID,
    payload: IncomeReceiptCreate,
    user: AdminUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    return attach_income_receipt(settings, user, income_id, payload.path)


@router.get(
    "/works/{work_id}/subcontracts",
    response_model=list[SubcontractResponse],
    tags=["subcontracts"],
)
def get_work_subcontracts(
    work_id: UUID,
    user: CurrentUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> list[dict[str, Any]]:
    return list_subcontracts(settings, user, work_id)


@router.post(
    "/works/{work_id}/subcontracts",
    status_code=status.HTTP_201_CREATED,
    response_model=SubcontractResponse,
    tags=["subcontracts"],
)
def post_work_subcontract(
    work_id: UUID,
    payload: SubcontractCreate,
    user: AdminUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    """Piecework contract (labor/services; the category is always MANO DE OBRA)."""
    return create_subcontract(settings, user, work_id, payload)


@router.get(
    "/subcontracts/{subcontract_id}", response_model=SubcontractResponse, tags=["subcontracts"]
)
def get_subcontract_detail(
    subcontract_id: UUID,
    user: CurrentUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    return get_subcontract(settings, user, subcontract_id)


@router.patch(
    "/subcontracts/{subcontract_id}", response_model=SubcontractResponse, tags=["subcontracts"]
)
def patch_subcontract(
    subcontract_id: UUID,
    payload: SubcontractUpdate,
    user: AdminUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    """Edit an active contract or cancel it; a paid finiquito settles it."""
    return update_subcontract(settings, user, subcontract_id, payload)


@router.get(
    "/subcontracts/{subcontract_id}/estimations",
    response_model=list[EstimationResponse],
    tags=["subcontracts"],
)
def get_subcontract_estimations(
    subcontract_id: UUID,
    user: CurrentUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> list[dict[str, Any]]:
    return get_subcontract(settings, user, subcontract_id)["estimations"]


@router.post(
    "/subcontracts/{subcontract_id}/estimations",
    status_code=status.HTTP_201_CREATED,
    response_model=EstimationResponse,
    tags=["subcontracts"],
)
def post_subcontract_estimation(
    subcontract_id: UUID,
    payload: EstimationCreate,
    user: AdminUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    """Draft estimation; the server computes retention and net."""
    return create_estimation(settings, user, subcontract_id, payload)


@router.put(
    "/subcontracts/{subcontract_id}/estimations/{estimation_id}",
    response_model=EstimationResponse,
    tags=["subcontracts"],
)
def put_subcontract_estimation(
    subcontract_id: UUID,
    estimation_id: UUID,
    payload: EstimationUpdate,
    user: AdminUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    """Replace a draft estimation; paid ones are immutable."""
    return update_estimation(settings, user, subcontract_id, estimation_id, payload)


@router.delete(
    "/subcontracts/{subcontract_id}/estimations/{estimation_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    tags=["subcontracts"],
)
def delete_subcontract_estimation(
    subcontract_id: UUID,
    estimation_id: UUID,
    user: AdminUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> None:
    delete_estimation(settings, user, subcontract_id, estimation_id)


@router.patch(
    "/subcontracts/{subcontract_id}/estimations/{estimation_id}/status",
    response_model=EstimationResponse,
    tags=["subcontracts"],
)
def patch_subcontract_estimation_status(
    subcontract_id: UUID,
    estimation_id: UUID,
    payload: EstimationStatusUpdate,
    user: AdminUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    """borrador → pagado (irreversible); paying the finiquito settles the contract."""
    return pay_estimation(settings, user, subcontract_id, estimation_id)


REPORT_COLUMNS = (
    "Fecha",
    "Área",
    "Partida",
    "Subpartida",
    "Categoría",
    "Proveedor",
    "Concepto",
    "Folio",
    "Importe",
    "Estado",
)


@router.get("/reports/works/{work_id}.xlsx", tags=["reports"])
def export_work_excel(
    work_id: UUID,
    user: CurrentUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> Response:
    name, rows = report_expenses(settings, user, work_id)
    content = build_excel_report(f"Gastos · {name}", REPORT_COLUMNS, rows)
    return Response(
        content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="gastos-{work_id}.xlsx"'},
    )


@router.get("/reports/works/{work_id}.pdf", tags=["reports"])
def export_work_pdf(
    work_id: UUID,
    user: CurrentUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> Response:
    name, rows = report_expenses(settings, user, work_id)
    content = build_pdf_report(f"Gastos · {name}", REPORT_COLUMNS, rows)
    return Response(
        content,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="gastos-{work_id}.pdf"'},
    )


@router.post("/weekly-closes", status_code=status.HTTP_201_CREATED, tags=["closes"])
def post_weekly_close(
    payload: WeeklyCloseCreate,
    user: AdminUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    return close_week(settings, user, payload)


@router.get("/works/{work_id}/weekly-closes", tags=["closes"])
def get_weekly_closes(
    work_id: UUID,
    user: CurrentUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> list[dict[str, Any]]:
    return list_weekly_closes(settings, user, work_id)


@router.get("/works/{work_id}/weekly-closes/preview", tags=["closes"])
def get_weekly_close_preview(
    work_id: UUID,
    user: CurrentUser,
    settings: Annotated[Settings, Depends(get_settings)],
    iso_year: Annotated[int, Query(ge=2000, le=2200)],
    iso_week: Annotated[int, Query(ge=1, le=53)],
) -> dict[str, Any]:
    return weekly_close_preview(settings, user, work_id, iso_year, iso_week)


@router.post("/weekly-closes/{close_id}/reopen", tags=["closes"])
def post_weekly_reopen(
    close_id: UUID,
    payload: WeeklyReopen,
    user: AdminUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    return reopen_week(settings, user, close_id, payload.reason)


@router.get("/hermes/tools", response_model=list[ToolDefinition], tags=["hermes"])
async def hermes_tools(_signature: HermesSignature) -> tuple[ToolDefinition, ...]:
    return WHATSAPP_TOOLS


@router.post("/hermes/hmac-probe", tags=["hermes"])
async def hmac_probe(_signature: HermesSignature) -> dict[str, str]:
    return {"status": "verified"}


@router.post("/hermes/tools/{tool_name}", tags=["hermes"])
async def invoke_hermes_tool(
    tool_name: str,
    _signature: HermesSignature,
    settings: Annotated[Settings, Depends(get_settings)],
    payload: Annotated[dict[str, Any], Body()],
    x_d89_actor_phone: Annotated[str | None, Header()] = None,
) -> dict[str, object]:
    tool = next((item for item in WHATSAPP_TOOLS if item.name == tool_name), None)
    if tool is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tool no expuesta")
    if not x_d89_actor_phone:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Falta identidad del canal")
    if tool.requires_confirmation and payload.get("confirmacion") is not True:
        raise HTTPException(status.HTTP_409_CONFLICT, "Se requiere confirmación explícita")
    if not settings.hermes_sandbox_mode:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Canal Meta pendiente de habilitación operativa",
        )
    return {
        "success": True,
        "mode": "sandbox",
        "tool": tool_name,
        "persisted": False,
        "message": (
            "Validación de schema, HMAC y confirmación completada; sin escritura en sandbox."
        ),
    }


@router.post("/neodata/preview", tags=["neodata"])
async def preview_neodata(
    admin: AdminUser,
    import_type: Annotated[str, Form()],
    file: Annotated[UploadFile, File(description="Libro .xlsx exportado por NEODATA")],
    settings: Annotated[Settings, Depends(get_settings)],
    work_id: Annotated[UUID | None, Form()] = None,
    work_name: Annotated[str | None, Form()] = None,
    work_location: Annotated[str | None, Form()] = None,
    work_start_date: Annotated[date | None, Form()] = None,
    work_end_date: Annotated[date | None, Form()] = None,
) -> dict[str, object]:
    if (work_id is None) == (work_name is None or not work_name.strip()):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Selecciona una obra existente o captura el nombre de una obra nueva",
        )
    content = await file.read(settings.neodata_max_bytes + 1)
    try:
        preview = parse_neodata_workbook(
            content,
            file.filename or "presupuesto.xlsx",
            max_bytes=settings.neodata_max_bytes,
        )
    except NeodataError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
    result = preview.to_dict(include_items=True)
    if not result["item_count"]:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "El archivo no contiene partidas reconocibles en formato NEODATA",
        )
    new_work = None
    if work_id is None:
        new_work = WorkCreate(
            name=(work_name or "").strip(),
            location=work_location or None,
            start_date=work_start_date,
            end_date=work_end_date,
        )
    return store_import_preview(
        settings,
        admin,
        work_id,
        new_work,
        import_type,
        file.filename or "presupuesto.xlsx",
        content,
        result,
    )


@router.patch("/neodata/imports/{import_id}/preview", tags=["neodata"])
def patch_neodata_preview(
    import_id: UUID,
    payload: ImportPreviewUpdate,
    admin: AdminUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    return update_import_preview(settings, admin, import_id, payload)


@router.post("/neodata/imports/{import_id}/confirm", tags=["neodata"])
def confirm_neodata_import(
    import_id: UUID,
    payload: ImportConfirm,
    admin: AdminUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    return confirm_import(settings, admin, import_id, payload.confirmation)
