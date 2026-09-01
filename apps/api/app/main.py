from datetime import UTC, datetime

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import router
from app.models import HealthResponse

app = FastAPI(
    title="D89 Sistema de Gastos API",
    version="0.1.0",
    description="API de presupuesto, gastos, cierres y herramientas firmadas de Hermes.",
    openapi_url="/api/v1/openapi.json",
    docs_url="/api/v1/docs",
    redoc_url=None,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "https://d89.escalaleads.com.mx"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    allow_headers=[
        "Authorization",
        "Content-Type",
        "X-D89-Key-Id",
        "X-D89-Timestamp",
        "X-D89-Nonce",
        "X-D89-Signature",
        "X-D89-Actor-Phone",
    ],
)
app.include_router(router)


@app.get("/health", response_model=HealthResponse, include_in_schema=False)
async def health() -> HealthResponse:
    return HealthResponse(
        status="ok",
        service="d89-api",
        version="0.1.0",
        timestamp=datetime.now(UTC),
    )
