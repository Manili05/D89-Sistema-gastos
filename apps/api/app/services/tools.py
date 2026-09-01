from app.models import Role, ToolDefinition

WHATSAPP_TOOLS: tuple[ToolDefinition, ...] = (
    ToolDefinition(
        name="registrar_gasto",
        roles=(Role.ADMIN, Role.OPERATIVO),
        mutates=True,
        requires_confirmation=True,
        description="Registra un gasto completo después de confirmación explícita.",
    ),
    ToolDefinition(
        name="consultar_presupuesto_restante",
        roles=(Role.ADMIN, Role.OPERATIVO),
        mutates=False,
        description="Consulta presupuesto vigente y remanente de una partida.",
    ),
    ToolDefinition(
        name="consultar_variacion_obra",
        roles=(Role.ADMIN, Role.OPERATIVO),
        mutates=False,
        description="Calcula presupuesto versus gasto real y semáforo de una obra.",
    ),
    ToolDefinition(
        name="editar_gasto_propio",
        roles=(Role.ADMIN, Role.OPERATIVO),
        mutates=True,
        description="Edita un gasto propio únicamente mientras siga pendiente.",
    ),
    ToolDefinition(
        name="registrar_ingreso_cobro",
        roles=(Role.ADMIN,),
        mutates=True,
        requires_confirmation=True,
        description="Registra un ingreso o cobro de obra.",
    ),
    ToolDefinition(
        name="consultar_flujo_caja",
        roles=(Role.ADMIN,),
        mutates=False,
        description="Consulta la proyección de flujo de caja de una obra.",
    ),
    ToolDefinition(
        name="registrar_pago_subcontrato",
        roles=(Role.ADMIN,),
        mutates=True,
        requires_confirmation=True,
        description="Registra un pago de subcontrato vinculado a gasto.",
    ),
    ToolDefinition(
        name="consultar_dashboard_agencia",
        roles=(Role.ADMIN,),
        mutates=False,
        description="Consulta el consolidado de todas las obras.",
    ),
    ToolDefinition(
        name="listar_mis_obras",
        roles=(Role.ADMIN, Role.OPERATIVO),
        mutates=False,
        description="Lista únicamente las obras autorizadas para el usuario.",
    ),
    ToolDefinition(
        name="exportar_reporte",
        roles=(Role.ADMIN, Role.OPERATIVO),
        mutates=False,
        description="Genera un reporte Excel o PDF de una obra autorizada.",
    ),
)

assert len(WHATSAPP_TOOLS) == 10
assert "eliminar_gasto" not in {tool.name for tool in WHATSAPP_TOOLS}
assert "importar_presupuesto_neodata" not in {tool.name for tool in WHATSAPP_TOOLS}
