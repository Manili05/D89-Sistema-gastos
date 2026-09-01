def _schema(name, description, properties, required=()):
    return {
        "name": name,
        "description": description,
        "parameters": {
            "type": "object",
            "properties": properties,
            "required": list(required),
            "additionalProperties": False,
        },
    }


WORK = {"obra_id": {"type": "string", "format": "uuid", "description": "Obra autorizada"}}

TOOL_SCHEMAS = [
    _schema(
        "registrar_gasto",
        "Registra un gasto solo después de que el usuario confirmó el resumen con un sí explícito.",
        {
            **WORK,
            "area_id": {"type": "string", "format": "uuid"},
            "partida_id": {"type": "string", "format": "uuid"},
            "fecha": {"type": "string", "format": "date"},
            "concepto": {"type": "string", "minLength": 3},
            "importe": {"type": "number", "exclusiveMinimum": 0},
            "confirmacion": {"type": "boolean", "const": True},
        },
        ("obra_id", "area_id", "partida_id", "fecha", "concepto", "importe", "confirmacion"),
    ),
    _schema("consultar_presupuesto_restante", "Consulta presupuesto vigente y restante.", {**WORK, "partida_id": {"type": "string", "format": "uuid"}}, ("obra_id",)),
    _schema("consultar_variacion_obra", "Consulta presupuesto, gasto real y semáforo.", WORK, ("obra_id",)),
    _schema("editar_gasto_propio", "Edita un gasto propio únicamente si sigue pendiente.", {"gasto_id": {"type": "string", "format": "uuid"}, "cambios": {"type": "object"}}, ("gasto_id", "cambios")),
    _schema("registrar_ingreso_cobro", "Registra ingreso o cobro con confirmación.", {**WORK, "concepto": {"type": "string"}, "monto": {"type": "number", "exclusiveMinimum": 0}, "confirmacion": {"type": "boolean", "const": True}}, ("obra_id", "concepto", "monto", "confirmacion")),
    _schema("consultar_flujo_caja", "Consulta flujo de caja de una obra.", WORK, ("obra_id",)),
    _schema("registrar_pago_subcontrato", "Registra pago de subcontrato con confirmación.", {"subcontrato_id": {"type": "string", "format": "uuid"}, "monto": {"type": "number", "exclusiveMinimum": 0}, "confirmacion": {"type": "boolean", "const": True}}, ("subcontrato_id", "monto", "confirmacion")),
    _schema("consultar_dashboard_agencia", "Consulta consolidado; FastAPI exige rol administrador.", {}, ()),
    _schema("listar_mis_obras", "Lista las obras asignadas al número de WhatsApp actual.", {}, ()),
    _schema("exportar_reporte", "Genera Excel o PDF para una obra autorizada.", {**WORK, "formato": {"type": "string", "enum": ["xlsx", "pdf"]}}, ("obra_id", "formato")),
]

assert len(TOOL_SCHEMAS) == 10
assert {schema["name"] for schema in TOOL_SCHEMAS}.isdisjoint(
    {"eliminar_gasto", "importar_presupuesto_neodata"}
)
