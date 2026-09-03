from datetime import UTC, date, datetime
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
    UploadFile,
    status,
)
from fastapi.responses import Response

from app.core.config import Settings, get_settings
from app.core.security import AdminUser, CurrentUser, HermesSignature
from app.models import (
    ExpenseCreate,
    HealthResponse,
    ImportConfirm,
    ImportPreviewUpdate,
    IncomeCreate,
    ReceiptUpdate,
    SubcontractCreate,
    SubcontractPaymentCreate,
    ToolDefinition,
    WeeklyCloseCreate,
    WeeklyReopen,
    WorkCreate,
)
from app.services.neodata import NeodataError, parse_neodata_workbook
from app.services.reports import build_excel_report, build_pdf_report
from app.services.repository import (
    attach_receipt,
    close_week,
    confirm_import,
    create_expense,
    create_income,
    create_subcontract,
    create_subcontract_payment,
    create_work,
    dashboard,
    list_expenses,
    list_incomes,
    list_subcontracts,
    list_works,
    reopen_week,
    report_expenses,
    store_import_preview,
    update_import_preview,
    work_catalog,
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


@router.get("/expenses", tags=["expenses"])
def get_expenses(
    work_id: UUID,
    user: CurrentUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> list[dict[str, Any]]:
    return list_expenses(settings, user, work_id)


@router.post("/expenses", status_code=status.HTTP_201_CREATED, tags=["expenses"])
def post_expense(
    payload: ExpenseCreate,
    user: CurrentUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    return create_expense(settings, user, payload)


@router.patch("/expenses/{expense_id}/receipt", tags=["expenses"])
def patch_expense_receipt(
    expense_id: UUID,
    payload: ReceiptUpdate,
    user: CurrentUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    return attach_receipt(settings, user, expense_id, payload.path)


@router.get("/incomes", tags=["cashflow"])
def get_incomes(
    work_id: UUID,
    user: CurrentUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> list[dict[str, Any]]:
    return list_incomes(settings, user, work_id)


@router.post("/incomes", status_code=status.HTTP_201_CREATED, tags=["cashflow"])
def post_income(
    payload: IncomeCreate,
    user: AdminUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    return create_income(settings, user, payload)


@router.get("/subcontracts", tags=["subcontracts"])
def get_subcontracts(
    work_id: UUID,
    user: CurrentUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> list[dict[str, Any]]:
    return list_subcontracts(settings, user, work_id)


@router.post("/subcontracts", status_code=status.HTTP_201_CREATED, tags=["subcontracts"])
def post_subcontract(
    payload: SubcontractCreate,
    user: AdminUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    return create_subcontract(settings, user, payload)


@router.post(
    "/subcontracts/{subcontract_id}/payments",
    status_code=status.HTTP_201_CREATED,
    tags=["subcontracts"],
)
def post_subcontract_payment(
    subcontract_id: UUID,
    payload: SubcontractPaymentCreate,
    user: AdminUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    return create_subcontract_payment(settings, user, subcontract_id, payload)


REPORT_COLUMNS = ("Fecha", "Área", "Código", "Partida", "Concepto", "Folio", "Importe", "Estado")


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
            "Validación de schema, HMAC y confirmación completada; "
            "sin escritura en sandbox."
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
