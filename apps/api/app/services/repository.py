import hashlib
from collections import Counter
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import date, timedelta
from decimal import Decimal
from typing import Any
from uuid import UUID

import psycopg
from fastapi import HTTPException, status
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from app.core.config import Settings
from app.models import (
    ExpenseCreate,
    ExpenseUpdate,
    ImportPreviewUpdate,
    IncomeBatchReconcile,
    IncomeCreate,
    IncomeState,
    IncomeStatusUpdate,
    LegacyIncomeCreate,
    Role,
    SubcontractCreate,
    SubcontractPaymentCreate,
    UserContext,
    WeeklyCloseCreate,
    WorkCreate,
    WorkDelete,
    WorkUpdate,
)
from app.services.expense_totals import ExpenseTotals, ExpenseTotalsError, compute_totals
from app.services.neodata import normalized_text


@contextmanager
def transaction(settings: Settings) -> Iterator[psycopg.Connection[dict[str, Any]]]:
    with (
        psycopg.connect(settings.database_url, row_factory=dict_row) as connection,
        connection.transaction(),
    ):
        yield connection


def require_active_profile(
    connection: psycopg.Connection[dict[str, Any]], user: UserContext
) -> Role:
    row = connection.execute(
        "select rol::text as rol from public.perfil_usuario where id = %s and activo",
        (user.id,),
    ).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Perfil inactivo o no provisionado")
    database_role = Role(row["rol"])
    if database_role != user.role:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "El rol de la sesión está desactualizado")
    return database_role


def require_work_access(
    connection: psycopg.Connection[dict[str, Any]], user: UserContext, work_id: UUID
) -> None:
    require_active_profile(connection, user)
    row = connection.execute(
        """
        select exists (
          select 1 from public.obra o
          where o.id = %s and (
            %s = 'admin' or exists (
              select 1 from public.usuario_obra uo
              where uo.obra_id = o.id and uo.usuario_id = %s
            )
          )
        ) as allowed
        """,
        (work_id, user.role.value, user.id),
    ).fetchone()
    if row is None or not row["allowed"]:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Sin acceso a la obra")


def list_works(settings: Settings, user: UserContext) -> list[dict[str, Any]]:
    with transaction(settings) as connection:
        require_active_profile(connection, user)
        rows = connection.execute(
            """
            select o.id, o.nombre, o.ubicacion, o.fecha_inicio, o.fecha_fin,
                   o.estado::text as estado,
                   coalesce(p.presupuesto, 0) as presupuesto,
                   coalesce(g.gasto, 0) as gasto
            from public.obra o
            left join lateral (
              select sum(pp.importe) as presupuesto
              from public.presupuesto_partida pp
              where pp.obra_id = o.id and pp.vigente
            ) p on true
            left join lateral (
              select sum(ga.importe) as gasto
              from public.gasto ga
              where ga.obra_id = o.id and ga.eliminado_en is null
            ) g on true
            where %s = 'admin' or exists (
              select 1 from public.usuario_obra uo
              where uo.obra_id = o.id and uo.usuario_id = %s
            )
            order by o.creado_en desc
            """,
            (user.role.value, user.id),
        ).fetchall()
        return list(rows)


def create_work(settings: Settings, user: UserContext, payload: WorkCreate) -> dict[str, Any]:
    with transaction(settings) as connection:
        require_active_profile(connection, user)
        if user.role is not Role.ADMIN:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Solo administración crea obras")
        return _insert_work(connection, user, payload)


def get_work(settings: Settings, user: UserContext, work_id: UUID) -> dict[str, Any]:
    with transaction(settings) as connection:
        require_work_access(connection, user, work_id)
        row = connection.execute(
            """
            select o.id, o.nombre, o.ubicacion, o.fecha_inicio, o.fecha_fin,
                   o.estado::text as estado,
                   (select count(*) from public.area a
                    where a.obra_id = o.id and a.vigente and a.seleccionable) as areas,
                   (select count(*) from public.presupuesto_partida pp
                    where pp.obra_id = o.id and pp.vigente) as partidas
            from public.obra o where o.id = %s
            """,
            (work_id,),
        ).fetchone()
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Obra inexistente")
        row["permissions"] = {
            "can_manage": user.role is Role.ADMIN,
            "can_validate": user.role is Role.ADMIN,
        }
        return row


def update_work(
    settings: Settings, user: UserContext, work_id: UUID, payload: WorkUpdate
) -> dict[str, Any]:
    with transaction(settings) as connection:
        require_work_access(connection, user, work_id)
        if user.role is not Role.ADMIN:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Solo administración edita obras")
        row = connection.execute(
            """
            update public.obra set nombre = %s, ubicacion = %s, fecha_inicio = %s,
              fecha_fin = %s, estado = %s
            where id = %s
            returning id, nombre, ubicacion, fecha_inicio, fecha_fin, estado::text as estado
            """,
            (
                payload.name.strip(),
                payload.location,
                payload.start_date,
                payload.end_date,
                payload.state,
                work_id,
            ),
        ).fetchone()
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Obra inexistente")
        connection.execute(
            """insert into public.audit_log_negocio
               (entidad, entidad_id, accion, usuario_id, canal, detalle_json)
               values ('obra', %s, 'editar', %s, 'web', %s)""",
            (work_id, user.id, Jsonb(payload.model_dump(mode="json"))),
        )
        return row


def _insert_work(
    connection: psycopg.Connection[dict[str, Any]], user: UserContext, payload: WorkCreate
) -> dict[str, Any]:
    row = connection.execute(
        """
        insert into public.obra
          (nombre, ubicacion, fecha_inicio, fecha_fin, responsable_id)
        values (%s, %s, %s, %s, %s)
        returning id, nombre, ubicacion, fecha_inicio, fecha_fin, estado::text as estado
        """,
        (payload.name, payload.location, payload.start_date, payload.end_date, user.id),
    ).fetchone()
    assert row is not None
    connection.execute(
        "insert into public.usuario_obra (usuario_id, obra_id) values (%s, %s)",
        (user.id, row["id"]),
    )
    connection.execute(
        """
        insert into public.audit_log_negocio
          (entidad, entidad_id, accion, usuario_id, canal, detalle_json)
        values ('obra', %s, 'crear', %s, 'web', %s)
        """,
        (row["id"], user.id, Jsonb({"nombre": payload.name})),
    )
    return row


def delete_work(
    settings: Settings, user: UserContext, work_id: UUID, payload: WorkDelete
) -> dict[str, Any]:
    """Permanently delete one work and all of its operational data."""
    with transaction(settings) as connection:
        require_active_profile(connection, user)
        if user.role is not Role.ADMIN:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Solo administración elimina obras")

        work = connection.execute(
            "select id, nombre from public.obra where id = %s for update", (work_id,)
        ).fetchone()
        if work is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Obra inexistente")
        if payload.confirmation_name.strip() != work["nombre"].strip():
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "El nombre de confirmación no coincide con la obra",
            )

        counts = connection.execute(
            """
            select
              (select count(*) from public.importacion_neodata where obra_id = %(work_id)s)
                as importaciones,
              (select count(*) from public.presupuesto_partida where obra_id = %(work_id)s)
                as partidas_presupuesto,
              (select count(*) from public.gasto where obra_id = %(work_id)s) as gastos,
              (select count(*) from public.cierre_semanal where obra_id = %(work_id)s) as cierres,
              (select count(*) from public.ingreso where obra_id = %(work_id)s) as ingresos,
              (select count(*) from public.subcontrato where obra_id = %(work_id)s)
                as subcontratos
            """,
            {"work_id": work_id},
        ).fetchone()
        assert counts is not None
        receipt_rows = connection.execute(
            """
            select k.ruta as comprobante_path
            from public.gasto_comprobante k join public.gasto g on g.id = k.gasto_id
            where g.obra_id = %s
            union all
            select k.ruta as comprobante_path
            from public.ingreso_comprobante k join public.ingreso i on i.id = k.ingreso_id
            where i.obra_id = %s
            """,
            (work_id, work_id),
        ).fetchall()

        # These relationships intentionally do not cascade in the original schema,
        # so delete their leaves first and keep the whole operation atomic.
        connection.execute(
            """
            delete from public.cierre_semanal_gasto csg
            where exists (
              select 1 from public.cierre_semanal cs
              where cs.id = csg.cierre_id and cs.obra_id = %(work_id)s
            ) or exists (
              select 1 from public.gasto g
              where g.id = csg.gasto_id and g.obra_id = %(work_id)s
            )
            """,
            {"work_id": work_id},
        )
        connection.execute(
            """
            delete from public.subcontrato_pago sp
            where exists (
              select 1 from public.subcontrato s
              where s.id = sp.subcontrato_id and s.obra_id = %(work_id)s
            ) or exists (
              select 1 from public.gasto g
              where g.id = sp.gasto_id_vinculado and g.obra_id = %(work_id)s
            )
            """,
            {"work_id": work_id},
        )
        connection.execute("delete from public.subcontrato where obra_id = %s", (work_id,))
        connection.execute("delete from public.cierre_semanal where obra_id = %s", (work_id,))
        connection.execute("delete from public.ingreso where obra_id = %s", (work_id,))
        connection.execute("delete from public.gasto where obra_id = %s", (work_id,))
        deleted = connection.execute(
            "delete from public.obra where id = %s returning id", (work_id,)
        ).fetchone()
        assert deleted is not None

        connection.execute(
            """
            insert into public.audit_log_negocio
              (entidad, entidad_id, accion, usuario_id, canal, detalle_json)
            values ('obra', %s, 'eliminar', %s, 'web', %s)
            """,
            (
                work_id,
                user.id,
                Jsonb({"nombre": work["nombre"], "conteos_eliminados": dict(counts)}),
            ),
        )
        return {
            "id": work_id,
            "nombre": work["nombre"],
            "deleted": True,
            "counts": counts,
            "receipt_paths": [row["comprobante_path"] for row in receipt_rows],
        }


def work_catalog(settings: Settings, user: UserContext, work_id: UUID) -> dict[str, Any]:
    with transaction(settings) as connection:
        require_work_access(connection, user, work_id)
        areas = connection.execute(
            """
            select id, nombre, parent_id, ruta_normalizada as ruta, nivel, seleccionable
            from public.area where obra_id = %s and vigente
            order by ruta_normalizada, orden, nombre
            """,
            (work_id,),
        ).fetchall()
        items = connection.execute(
            """
            select pp.id as budget_item_id, pp.area_id, pp.partida_id,
                   cp.codigo, cp.descripcion, cp.unidad, cc.nombre as clase,
                   cat.nombre as categoria, pp.importe as presupuesto
            from public.presupuesto_partida pp
            join public.catalogo_partida cp on cp.id = pp.partida_id
            join public.catalogo_clase cc on cc.id = cp.clase_id
            left join public.catalogo_categoria cat on cat.id = cp.categoria_id
            where pp.obra_id = %s and pp.vigente
            order by pp.area_id, cp.codigo, cp.descripcion
            """,
            (work_id,),
        ).fetchall()
        suppliers = connection.execute(
            """
            select p.id, p.nombre
            from public.catalogo_proveedor p
            join public.obra_proveedor op on op.proveedor_id = p.id
            where op.obra_id = %s and op.activo and p.activo
            order by p.nombre
            """,
            (work_id,),
        ).fetchall()
        expense_partidas = connection.execute(
            """
            select id, nombre from public.catalogo_partida_gasto
            where activo order by orden, nombre
            """
        ).fetchall()
        expense_subitems = connection.execute(
            """
            select cs.id, cs.partida_gasto_id as partida_id, cs.nombre
            from public.catalogo_subpartida_gasto cs
            join public.catalogo_partida_gasto cp
              on cp.id = cs.partida_gasto_id and cp.activo
            where cs.activo order by cp.orden, cs.orden, cs.nombre
            """
        ).fetchall()
        expense_categories = connection.execute(
            """
            select id, nombre from public.catalogo_categoria_gasto
            where activo order by orden, nombre
            """
        ).fetchall()
        return {
            "areas": list(areas),
            "items": list(items),
            "expense_partidas": list(expense_partidas),
            "expense_subitems": list(expense_subitems),
            "expense_categories": list(expense_categories),
            "suppliers": list(suppliers),
            # Quick supplier creation from the expense form is an admin action.
            "permissions": {"can_manage_suppliers": user.role is Role.ADMIN},
        }


def _totals_or_422(payload: ExpenseCreate | ExpenseUpdate) -> ExpenseTotals:
    try:
        return compute_totals(list(payload.lines), payload.iva)
    except ExpenseTotalsError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc


def _insert_lines(
    connection: psycopg.Connection[dict[str, Any]],
    expense_id: UUID,
    payload: ExpenseCreate | ExpenseUpdate,
    totals: ExpenseTotals,
) -> None:
    with connection.cursor() as cursor:
        cursor.executemany(
            """
            insert into public.gasto_concepto
              (gasto_id, posicion, cantidad, unidad, descripcion,
               precio_unitario, descuento, importe_concepto)
            values (%s, %s, %s, %s, %s, %s, %s, %s)
            """,
            [
                (
                    expense_id,
                    position,
                    line.quantity,
                    line.unit,
                    line.description,
                    line.unit_price,
                    line.discount,
                    amount,
                )
                for position, (line, amount) in enumerate(
                    zip(payload.lines, totals.line_amounts, strict=True), start=1
                )
            ],
        )


def _expense_detail(
    connection: psycopg.Connection[dict[str, Any]], expense_id: UUID
) -> dict[str, Any]:
    """Header + lines + receipts, shaped as models.ExpenseResponse."""
    row = connection.execute(
        """
        select g.id, g.folio, g.folio_proveedor as supplier_folio, g.obra_id as work_id,
               g.fecha as spent_on, g.concepto as concept, g.subtotal, g.iva,
               g.importe as amount, g.iva_desglosado as iva_breakdown,
               g.estado::text as state,
               prov.nombre as supplier_name,
               coalesce(a.ruta_normalizada, array[a.nombre]) as area_path,
               coalesce(cpg.nombre, cc.nombre) as expense_item,
               csg.nombre as expense_subitem,
               coalesce(cag.nombre, cat.nombre) as expense_category,
               case when cp.id is not null then cp.codigo || ' · ' || cp.descripcion end
                 as budget_item,
               pu.nombre as author, g.creado_en as created_at,
               g.motivo_revision as review_reason,
               coalesce((
                 select jsonb_agg(jsonb_build_object(
                   -- numeric as text: JSON numbers would come back as float.
                   'position', c.posicion, 'quantity', c.cantidad::text, 'unit', c.unidad,
                   'description', c.descripcion, 'unit_price', c.precio_unitario::text,
                   'discount', c.descuento::text, 'amount', c.importe_concepto::text)
                   order by c.posicion)
                 from public.gasto_concepto c where c.gasto_id = g.id), '[]'::jsonb) as lines,
               coalesce((
                 select jsonb_agg(jsonb_build_object(
                   'id', k.id, 'path', k.ruta, 'kind', k.tipo, 'created_at', k.creado_en)
                   order by k.creado_en, k.id)
                 from public.gasto_comprobante k where k.gasto_id = g.id), '[]'::jsonb)
                 as receipts
        from public.gasto g
        join public.area a on a.id = g.area_id
        left join public.catalogo_partida_gasto cpg on cpg.id = g.partida_gasto_id
        left join public.catalogo_subpartida_gasto csg on csg.id = g.subpartida_gasto_id
        left join public.catalogo_categoria_gasto cag on cag.id = g.categoria_gasto_id
        left join public.catalogo_clase cc on cc.id = g.clase_id
        left join public.catalogo_categoria cat on cat.id = g.categoria_id
        left join public.catalogo_proveedor prov on prov.id = g.proveedor_id
        left join public.catalogo_partida cp on cp.id = g.partida_id
        left join public.perfil_usuario pu on pu.id = g.creado_por
        where g.id = %s
        """,
        (expense_id,),
    ).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Gasto inexistente")
    return row


RECEIPT_KINDS = {"pdf": "pdf", "xml": "xml", "jpg": "imagen", "jpeg": "imagen",
                 "png": "imagen", "webp": "imagen"}


def _receipt_kind(path: str) -> str:
    extension = path.rsplit(".", 1)[-1].lower() if "." in path else ""
    kind = RECEIPT_KINDS.get(extension)
    if kind is None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "El comprobante debe ser PDF, XML (CFDI) o imagen JPEG, PNG o WebP",
        )
    return kind


def get_expense(settings: Settings, user: UserContext, expense_id: UUID) -> dict[str, Any]:
    with transaction(settings) as connection:
        target = connection.execute(
            "select obra_id from public.gasto where id = %s and eliminado_en is null",
            (expense_id,),
        ).fetchone()
        if target is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Gasto inexistente")
        require_work_access(connection, user, target["obra_id"])
        return _expense_detail(connection, expense_id)


def create_expense(settings: Settings, user: UserContext, payload: ExpenseCreate) -> dict[str, Any]:
    totals = _totals_or_422(payload)
    with transaction(settings) as connection:
        require_work_access(connection, user, payload.work_id)
        if _expense_locked(connection, payload.work_id, payload.spent_on):
            raise HTTPException(status.HTTP_409_CONFLICT, "La semana del gasto está cerrada")
        area = connection.execute(
            """select id from public.area
               where id = %s and obra_id = %s and vigente and seleccionable""",
            (payload.area_id, payload.work_id),
        ).fetchone()
        if area is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Área ajena a la obra")

        hierarchy = connection.execute(
            """
            select cs.id
            from public.catalogo_subpartida_gasto cs
            join public.catalogo_partida_gasto cp
              on cp.id = cs.partida_gasto_id and cp.activo
            cross join public.catalogo_categoria_gasto cat
            where cs.id = %s and cs.partida_gasto_id = %s and cs.activo
              and cat.id = %s and cat.activo
            """,
            (
                payload.expense_subitem_id,
                payload.expense_item_id,
                payload.expense_category_id,
            ),
        ).fetchone()
        if hierarchy is None:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Partida, subpartida y categoría no forman una clasificación válida",
            )

        budget_partida_id: UUID | None = None
        budget_class_id: UUID | None = None
        budget_category_id: UUID | None = None
        if payload.budget_item_id is not None:
            budget = connection.execute(
                """
                select pp.partida_id, cp.clase_id, cp.categoria_id
                from public.presupuesto_partida pp
                join public.catalogo_partida cp on cp.id = pp.partida_id
                where pp.id = %s and pp.obra_id = %s and pp.area_id = %s and pp.vigente
                """,
                (payload.budget_item_id, payload.work_id, payload.area_id),
            ).fetchone()
            if budget is None:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY, "Partida NEODATA no vigente"
                )
            budget_partida_id = budget["partida_id"]
            budget_class_id = budget["clase_id"]
            budget_category_id = budget["categoria_id"]

        supplier = connection.execute(
            """
            select p.id
            from public.catalogo_proveedor p
            join public.obra_proveedor op on op.proveedor_id = p.id
            where p.id = %s and p.activo and op.obra_id = %s and op.activo
            """,
            (payload.supplier_id, payload.work_id),
        ).fetchone()
        if supplier is None:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "El proveedor no está activo o asignado a la obra",
            )
        supplier_id = supplier["id"]

        row = connection.execute(
            """
            insert into public.gasto (
              obra_id, area_id, clase_id, categoria_id, partida_id,
              partida_gasto_id, subpartida_gasto_id, categoria_gasto_id, proveedor_id,
              fecha, concepto, folio_proveedor, importe, subtotal, iva, iva_desglosado,
              estado, origen, creado_por
            ) values (
              %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, true, %s, 'web', %s
            )
            returning id, folio
            """,
            (
                payload.work_id,
                payload.area_id,
                budget_class_id,
                budget_category_id,
                budget_partida_id,
                payload.expense_item_id,
                payload.expense_subitem_id,
                payload.expense_category_id,
                supplier_id,
                payload.spent_on,
                payload.concept,
                payload.supplier_folio,
                totals.amount,
                totals.subtotal,
                totals.iva,
                "pendiente",  # Never trust the client to perform administrative validation.
                user.id,
            ),
        ).fetchone()
        assert row is not None
        _insert_lines(connection, row["id"], payload, totals)
        connection.execute(
            """
            insert into public.audit_log_negocio
              (entidad, entidad_id, accion, usuario_id, canal, detalle_json)
            values ('gasto', %s, 'crear', %s, 'web', %s)
            """,
            (
                row["id"],
                user.id,
                Jsonb(
                    {
                        "folio": row["folio"],
                        "importe": str(totals.amount),
                        "subtotal": str(totals.subtotal),
                        "iva": str(totals.iva),
                        "conceptos": len(payload.lines),
                        "partida_gasto_id": str(payload.expense_item_id),
                        "subpartida_gasto_id": str(payload.expense_subitem_id),
                        "categoria_gasto_id": str(payload.expense_category_id),
                        "proveedor_id": str(supplier_id),
                    }
                ),
            ),
        )
        return _expense_detail(connection, row["id"])


def list_expenses(settings: Settings, user: UserContext, work_id: UUID) -> list[dict[str, Any]]:
    with transaction(settings) as connection:
        require_work_access(connection, user, work_id)
        return list(
            connection.execute(
                """
                select g.id, g.fecha, g.concepto, g.folio, g.folio_proveedor,
                       g.subtotal, g.iva, g.importe, g.iva_desglosado,
                       g.estado::text as estado, a.nombre as area,
                       coalesce(cpg.nombre, cc.nombre, '') as partida,
                       coalesce(csg.nombre, '') as subpartida,
                       coalesce(cag.nombre, cat.nombre, '') as categoria,
                       coalesce(prov.nombre, '') as proveedor,
                       cp.codigo as partida_presupuesto_codigo,
                       cp.descripcion as partida_presupuesto
                from public.gasto g
                join public.area a on a.id = g.area_id
                left join public.catalogo_partida_gasto cpg on cpg.id = g.partida_gasto_id
                left join public.catalogo_subpartida_gasto csg on csg.id = g.subpartida_gasto_id
                left join public.catalogo_categoria_gasto cag on cag.id = g.categoria_gasto_id
                left join public.catalogo_clase cc on cc.id = g.clase_id
                left join public.catalogo_categoria cat on cat.id = g.categoria_id
                left join public.catalogo_proveedor prov on prov.id = g.proveedor_id
                left join public.catalogo_partida cp on cp.id = g.partida_id
                where g.obra_id = %s and g.eliminado_en is null
                order by g.fecha desc, g.creado_en desc
                """,
                (work_id,),
            ).fetchall()
        )


def attach_receipt(
    settings: Settings, user: UserContext, expense_id: UUID, path: str
) -> dict[str, Any]:
    with transaction(settings) as connection:
        expense = connection.execute(
            """select obra_id, creado_por, fecha, estado::text as estado
               from public.gasto where id = %s and eliminado_en is null for update""",
            (expense_id,),
        ).fetchone()
        if expense is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Gasto inexistente")
        require_work_access(connection, user, expense["obra_id"])
        expected = f"{expense['obra_id']}/{expense_id}/"
        if not path.startswith(expected) or ".." in path:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, "Ruta de comprobante inválida"
            )
        kind = _receipt_kind(path)
        if user.role is not Role.ADMIN and expense["creado_por"] != user.id:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Solo el autor adjunta el comprobante")
        if expense["estado"] == "validado":
            raise HTTPException(status.HTTP_409_CONFLICT, "El gasto validado está bloqueado")
        if _expense_locked(connection, expense["obra_id"], expense["fecha"]):
            raise HTTPException(status.HTTP_409_CONFLICT, "La semana del gasto está cerrada")
        stored = connection.execute(
            """select exists(select 1 from storage.objects
                 where bucket_id = 'comprobantes' and name = %s) as receipt_exists""",
            (path,),
        ).fetchone()
        if not stored or not stored["receipt_exists"]:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, "El comprobante no existe en Storage"
            )
        # Appends one more file (PDF, XML CFDI or image); the same path is idempotent.
        added = connection.execute(
            """
            insert into public.gasto_comprobante (gasto_id, ruta, tipo, creado_por)
            values (%s, %s, %s, %s)
            on conflict (ruta) do nothing
            returning id
            """,
            (expense_id, path, kind, user.id),
        ).fetchone()
        if added is not None:
            connection.execute(
                "update public.gasto set editado_por = %s, editado_en = now() where id = %s",
                (user.id, expense_id),
            )
            _audit_expense(
                connection, expense_id, user, "adjuntar_comprobante", {"tipo": kind, "ruta": path}
            )
        return _expense_detail(connection, expense_id)


def _lock_work_expenses(connection: psycopg.Connection, work_id: UUID) -> None:
    # Shared by expense mutations and closes, including weeks without a close row.
    connection.execute("select pg_advisory_xact_lock(hashtextextended(%s, 0))", (str(work_id),))


def _expense_locked(
    connection: psycopg.Connection[dict[str, Any]], work_id: UUID, spent_on: date
) -> bool:
    _lock_work_expenses(connection, work_id)
    row = connection.execute(
        """
        select exists (
          select 1 from public.cierre_semanal c
          where c.obra_id = %s and c.estado = 'cerrado'
            and c.anio_iso = extract(isoyear from %s::date)::integer
            and c.semana_iso = extract(week from %s::date)::integer
        ) as locked
        """,
        (work_id, spent_on, spent_on),
    ).fetchone()
    return bool(row and row["locked"])


def _audit_expense(
    connection: psycopg.Connection[dict[str, Any]],
    expense_id: UUID,
    user: UserContext,
    action: str,
    detail: dict[str, Any],
) -> None:
    connection.execute(
        """
        insert into public.audit_log_negocio
          (entidad, entidad_id, accion, usuario_id, canal, detalle_json)
        values ('gasto', %s, %s, %s, 'web', %s)
        """,
        (expense_id, action, user.id, Jsonb(detail)),
    )


def list_work_expenses(
    settings: Settings,
    user: UserContext,
    work_id: UUID,
    *,
    date_from: date | None = None,
    date_to: date | None = None,
    expense_state: str | None = None,
    area_id: UUID | None = None,
    query: str | None = None,
    page: int = 1,
    page_size: int = 25,
) -> dict[str, Any]:
    with transaction(settings) as connection:
        require_work_access(connection, user, work_id)
        clauses = ["g.obra_id = %s", "g.eliminado_en is null"]
        params: list[Any] = [work_id]
        if date_from:
            clauses.append("g.fecha >= %s")
            params.append(date_from)
        if date_to:
            clauses.append("g.fecha <= %s")
            params.append(date_to)
        if expense_state:
            if expense_state not in {"pendiente", "validado", "rechazado"}:
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Estado inválido")
            clauses.append("g.estado = %s")
            params.append(expense_state)
        if area_id:
            clauses.append("g.area_id = %s")
            params.append(area_id)
        if query:
            clauses.append(
                "(g.concepto ilike %s or g.folio ilike %s "
                "or coalesce(g.folio_proveedor, '') ilike %s "
                "or coalesce(prov.nombre, '') ilike %s)"
            )
            wildcard = f"%{query.strip()}%"
            params.extend([wildcard, wildcard, wildcard, wildcard])
        where = " and ".join(clauses)
        total = connection.execute(
            f"""select count(*) as total from public.gasto g
                 left join public.catalogo_proveedor prov on prov.id = g.proveedor_id
                 where {where}""",
            params,
        ).fetchone()
        rows = connection.execute(
            f"""
            select g.id, g.fecha, g.concepto, g.folio, g.folio_proveedor,
                   g.subtotal, g.iva, g.importe, g.iva_desglosado,
                   g.estado::text as estado,
                   (select count(*) from public.gasto_concepto c where c.gasto_id = g.id)
                     as line_count,
                   coalesce((
                     select jsonb_agg(jsonb_build_object('id', k.id, 'path', k.ruta, 'kind', k.tipo)
                       order by k.creado_en, k.id)
                     from public.gasto_comprobante k where k.gasto_id = g.id), '[]'::jsonb)
                     as comprobantes,
                   -- Compatibility for the current UI: first receipt of the expense.
                   (select k.ruta from public.gasto_comprobante k where k.gasto_id = g.id
                    order by k.creado_en, k.id limit 1) as comprobante_path,
                   g.motivo_revision, g.creado_por, g.creado_en,
                   exists (
                     select 1 from public.cierre_semanal c
                     where c.obra_id = g.obra_id and c.estado = 'cerrado'
                       and c.anio_iso = extract(isoyear from g.fecha)::integer
                       and c.semana_iso = extract(week from g.fecha)::integer
                   ) as expense_locked,
                   a.id as area_id, a.nombre as area, a.ruta_normalizada as area_ruta,
                   g.partida_gasto_id as expense_item_id,
                   g.subpartida_gasto_id as expense_subitem_id,
                   g.categoria_gasto_id as expense_category_id,
                   g.proveedor_id as supplier_id,
                   coalesce(cpg.nombre, cc.nombre, '') as partida,
                   coalesce(csg.nombre, '') as subpartida,
                   coalesce(cag.nombre, cat.nombre, '') as categoria,
                   coalesce(prov.nombre, '') as proveedor,
                   pp.id as budget_item_id, cp.codigo as partida_presupuesto_codigo,
                   cp.descripcion as partida_presupuesto,
                   coalesce(pu.nombre, 'Usuario') as autor
            from public.gasto g
            join public.area a on a.id = g.area_id
            left join public.catalogo_partida_gasto cpg on cpg.id = g.partida_gasto_id
            left join public.catalogo_subpartida_gasto csg on csg.id = g.subpartida_gasto_id
            left join public.catalogo_categoria_gasto cag on cag.id = g.categoria_gasto_id
            left join public.catalogo_clase cc on cc.id = g.clase_id
            left join public.catalogo_categoria cat on cat.id = g.categoria_id
            left join public.catalogo_proveedor prov on prov.id = g.proveedor_id
            left join public.catalogo_partida cp on cp.id = g.partida_id
            left join public.presupuesto_partida pp on pp.obra_id = g.obra_id
              and pp.area_id = g.area_id and pp.partida_id = g.partida_id and pp.vigente
            left join public.perfil_usuario pu on pu.id = g.creado_por
            where {where}
            order by g.fecha desc, g.creado_en desc
            limit %s offset %s
            """,
            [*params, page_size, (page - 1) * page_size],
        ).fetchall()
        items = []
        for source in rows:
            item = dict(source)
            is_author = item["creado_por"] == user.id
            can_change = (
                (user.role is Role.ADMIN or is_author)
                and item["estado"] in {"pendiente", "rechazado"}
                and not item["expense_locked"]
            )
            item["can_edit"] = can_change
            item["can_cancel"] = can_change
            item["can_resubmit"] = can_change and item["estado"] == "rechazado"
            items.append(item)
        return {
            "items": items,
            "total": total["total"] if total else 0,
            "page": page,
            "page_size": page_size,
        }


def update_expense(
    settings: Settings,
    user: UserContext,
    expense_id: UUID,
    payload: ExpenseUpdate,
) -> dict[str, Any]:
    totals = _totals_or_422(payload)
    with transaction(settings) as connection:
        expense = connection.execute(
            "select * from public.gasto where id = %s and eliminado_en is null for update",
            (expense_id,),
        ).fetchone()
        if expense is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Gasto inexistente")
        require_work_access(connection, user, expense["obra_id"])
        if expense["estado"] not in {"pendiente", "rechazado"}:
            raise HTTPException(status.HTTP_409_CONFLICT, "El gasto validado está bloqueado")
        if user.role is not Role.ADMIN and expense["creado_por"] != user.id:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Solo el autor corrige este gasto")
        if _expense_locked(connection, expense["obra_id"], expense["fecha"]):
            raise HTTPException(status.HTTP_409_CONFLICT, "La semana del gasto está cerrada")

        if _expense_locked(connection, expense["obra_id"], payload.spent_on):
            raise HTTPException(status.HTTP_409_CONFLICT, "La semana de destino está cerrada")

        area = connection.execute(
            """select id from public.area
               where id = %s and obra_id = %s and vigente and seleccionable""",
            (payload.area_id, expense["obra_id"]),
        ).fetchone()
        hierarchy = connection.execute(
            """
            select cs.id from public.catalogo_subpartida_gasto cs
            join public.catalogo_partida_gasto cp on cp.id = cs.partida_gasto_id and cp.activo
            cross join public.catalogo_categoria_gasto cat
            where cs.id = %s and cs.partida_gasto_id = %s and cs.activo
              and cat.id = %s and cat.activo
            """,
            (payload.expense_subitem_id, payload.expense_item_id, payload.expense_category_id),
        ).fetchone()
        if area is None or hierarchy is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Clasificación inválida")

        budget_partida_id = budget_class_id = budget_category_id = None
        if payload.budget_item_id:
            budget = connection.execute(
                """select pp.partida_id, cp.clase_id, cp.categoria_id
                   from public.presupuesto_partida pp
                   join public.catalogo_partida cp on cp.id = pp.partida_id
                   where pp.id = %s and pp.obra_id = %s and pp.area_id = %s and pp.vigente""",
                (payload.budget_item_id, expense["obra_id"], payload.area_id),
            ).fetchone()
            if budget is None:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY, "Partida NEODATA no vigente"
                )
            budget_partida_id = budget["partida_id"]
            budget_class_id = budget["clase_id"]
            budget_category_id = budget["categoria_id"]

        supplier = connection.execute(
            """
            select p.id
            from public.catalogo_proveedor p
            left join public.obra_proveedor op
              on op.proveedor_id = p.id and op.obra_id = %s and op.activo
            where p.id = %s and p.activo
              and (op.id is not null or p.id = %s)
            """,
            (expense["obra_id"], payload.supplier_id, expense["proveedor_id"]),
        ).fetchone()
        if supplier is None:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "El proveedor no está activo o asignado a la obra",
            )

        row = connection.execute(
            """
            update public.gasto set area_id = %s, clase_id = %s, categoria_id = %s,
              partida_id = %s, partida_gasto_id = %s, subpartida_gasto_id = %s,
              categoria_gasto_id = %s, proveedor_id = %s, fecha = %s, concepto = %s,
              folio_proveedor = %s, importe = %s, subtotal = %s, iva = %s,
              iva_desglosado = true, editado_por = %s, editado_en = now()
            where id = %s
            returning id
            """,
            (
                payload.area_id,
                budget_class_id,
                budget_category_id,
                budget_partida_id,
                payload.expense_item_id,
                payload.expense_subitem_id,
                payload.expense_category_id,
                supplier["id"],
                payload.spent_on,
                payload.concept,
                payload.supplier_folio,
                totals.amount,
                totals.subtotal,
                totals.iva,
                user.id,
                expense_id,
            ),
        ).fetchone()
        assert row is not None
        connection.execute("delete from public.gasto_concepto where gasto_id = %s", (expense_id,))
        _insert_lines(connection, expense_id, payload, totals)
        _audit_expense(
            connection,
            expense_id,
            user,
            "editar",
            {
                "importe_anterior": str(expense["importe"]),
                "importe": str(totals.amount),
                "subtotal": str(totals.subtotal),
                "iva": str(totals.iva),
                "conceptos": len(payload.lines),
            },
        )
        return _expense_detail(connection, expense_id)


def review_expense(
    settings: Settings,
    user: UserContext,
    expense_id: UUID,
    action: str,
    reason: str | None,
) -> dict[str, Any]:
    with transaction(settings) as connection:
        expense = connection.execute(
            """select g.*, exists(select 1 from public.gasto_comprobante k
                 join storage.objects so on so.bucket_id = 'comprobantes' and so.name = k.ruta
                 where k.gasto_id = g.id) as receipt_exists
                 from public.gasto g where g.id = %s and g.eliminado_en is null
                 for update of g""",
            (expense_id,),
        ).fetchone()
        if expense is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Gasto inexistente")
        require_work_access(connection, user, expense["obra_id"])
        if _expense_locked(connection, expense["obra_id"], expense["fecha"]):
            raise HTTPException(status.HTTP_409_CONFLICT, "La semana del gasto está cerrada")

        current = str(expense["estado"])
        if action in {"validate", "reject", "return_to_review"} and user.role is not Role.ADMIN:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Solo administración valida gastos")
        if action == "validate":
            if current != "pendiente":
                raise HTTPException(status.HTTP_409_CONFLICT, "Sólo se validan gastos pendientes")
            if not expense["receipt_exists"]:
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Falta comprobante")
            next_state, audit_action = "validado", "validar"
        elif action == "reject":
            if current != "pendiente":
                raise HTTPException(status.HTTP_409_CONFLICT, "Sólo se rechazan gastos pendientes")
            next_state, audit_action = "rechazado", "rechazar"
        elif action == "return_to_review":
            if current != "validado":
                raise HTTPException(status.HTTP_409_CONFLICT, "El gasto no está validado")
            next_state, audit_action = "pendiente", "devolver_revision"
        elif action == "resubmit":
            if current != "rechazado":
                raise HTTPException(status.HTTP_409_CONFLICT, "El gasto no está rechazado")
            if user.role is not Role.ADMIN and expense["creado_por"] != user.id:
                raise HTTPException(status.HTTP_403_FORBIDDEN, "Solo el autor reenvía este gasto")
            next_state, audit_action = "pendiente", "reenviar"
        else:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Acción inválida")

        row = connection.execute(
            """
            update public.gasto set estado = %s,
              validado_por = case when %s = 'validado' then %s else null end,
              validado_en = case when %s = 'validado' then now() else null end,
              motivo_revision = %s, editado_por = %s, editado_en = now()
            where id = %s returning id, estado::text as estado, motivo_revision, validado_en
            """,
            (next_state, next_state, user.id, next_state, reason, user.id, expense_id),
        ).fetchone()
        assert row is not None
        _audit_expense(connection, expense_id, user, audit_action, {"motivo": reason})
        return row


def validate_expenses_batch(
    settings: Settings, user: UserContext, work_id: UUID, expense_ids: list[UUID]
) -> dict[str, Any]:
    with transaction(settings) as connection:
        require_work_access(connection, user, work_id)
        if user.role is not Role.ADMIN:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Solo administración valida gastos")
        unique_ids = list(dict.fromkeys(expense_ids))
        rows = connection.execute(
            """select g.*, exists(select 1 from public.gasto_comprobante k
                 join storage.objects so on so.bucket_id = 'comprobantes' and so.name = k.ruta
                 where k.gasto_id = g.id) as receipt_exists
                 from public.gasto g where g.obra_id = %s and g.id = any(%s)
                   and g.eliminado_en is null for update of g""",
            (work_id, unique_ids),
        ).fetchall()
        if len(rows) != len(unique_ids):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, "El lote contiene gastos inválidos"
            )
        for row in rows:
            if str(row["estado"]) != "pendiente" or not row["receipt_exists"]:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "Todos los gastos deben estar pendientes y tener comprobante",
                )
            if _expense_locked(connection, work_id, row["fecha"]):
                raise HTTPException(status.HTTP_409_CONFLICT, "El lote contiene semanas cerradas")
        connection.execute(
            """update public.gasto set estado = 'validado', validado_por = %s,
                 validado_en = now(), motivo_revision = null, editado_por = %s, editado_en = now()
                 where id = any(%s)""",
            (user.id, user.id, unique_ids),
        )
        for expense_id in unique_ids:
            _audit_expense(connection, expense_id, user, "validar_lote", {"lote": len(unique_ids)})
        return {"validated": len(unique_ids), "expense_ids": unique_ids}


def cancel_expense(
    settings: Settings, user: UserContext, expense_id: UUID, reason: str
) -> dict[str, Any]:
    with transaction(settings) as connection:
        expense = connection.execute(
            "select * from public.gasto where id = %s and eliminado_en is null for update",
            (expense_id,),
        ).fetchone()
        if expense is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Gasto inexistente")
        require_work_access(connection, user, expense["obra_id"])
        if str(expense["estado"]) == "validado":
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Devuelve el gasto a revisión antes de cancelarlo",
            )
        if user.role is not Role.ADMIN and expense["creado_por"] != user.id:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Solo el autor cancela este gasto")
        if _expense_locked(connection, expense["obra_id"], expense["fecha"]):
            raise HTTPException(status.HTTP_409_CONFLICT, "La semana del gasto está cerrada")
        row = connection.execute(
            """update public.gasto set eliminado_por = %s, eliminado_en = now(),
                 editado_por = %s, editado_en = now() where id = %s
                 returning id, eliminado_en""",
            (user.id, user.id, expense_id),
        ).fetchone()
        assert row is not None
        _audit_expense(connection, expense_id, user, "cancelar", {"motivo": reason})
        return row


INCOME_SELECT = """
    select i.id, i.obra_id as work_id, i.folio, i.fecha as received_on,
           i.concepto as concept, i.importe as amount, i.estado::text as state,
           i.creado_por as created_by, i.creado_en as created_at,
           i.conciliado_en as reconciled_at, i.motivo_reversion as reversal_reason,
           (select p.nombre from public.perfil_usuario p where p.id = i.conciliado_por)
             as reconciled_by,
           coalesce((select jsonb_agg(jsonb_build_object(
               'id', k.id, 'path', k.ruta, 'kind', k.tipo, 'created_at', k.creado_en)
               order by k.creado_en, k.id)
               from public.ingreso_comprobante k where k.ingreso_id = i.id), '[]'::jsonb)
               as receipts
    from public.ingreso i
"""


def _income_detail(connection: psycopg.Connection, income_id: UUID) -> dict[str, Any]:
    row = connection.execute(INCOME_SELECT + " where i.id = %s", (income_id,)).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Ingreso inexistente")
    return row


def _audit_income(connection, income_id: UUID, user: UserContext, action: str, detail: dict):
    connection.execute(
        """insert into public.audit_log_negocio
           (entidad, entidad_id, accion, usuario_id, canal, detalle_json)
           values ('ingreso', %s, %s, %s, 'web', %s)""",
        (income_id, action, user.id, Jsonb(detail)),
    )


def list_incomes(settings: Settings, user: UserContext, work_id: UUID) -> list[dict[str, Any]]:
    with transaction(settings) as connection:
        require_work_access(connection, user, work_id)
        return list(connection.execute(
            INCOME_SELECT + " where i.obra_id = %s order by i.fecha desc, i.creado_en desc, i.id",
            (work_id,),
        ).fetchall())


def get_income(settings: Settings, user: UserContext, income_id: UUID) -> dict[str, Any]:
    with transaction(settings) as connection:
        row = _income_detail(connection, income_id)
        require_work_access(connection, user, row["work_id"])
        return row


def create_income(
    settings: Settings, user: UserContext, work_id: UUID, payload: IncomeCreate,
    *, actual_date: date | None = None,
) -> dict[str, Any]:
    with transaction(settings) as connection:
        require_work_access(connection, user, work_id)
        if user.role is not Role.ADMIN:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Solo administración registra ingresos")
        # No float conversion or implicit rounding: Pydantic bounds NUMERIC(18,4).
        amount = payload.amount.quantize(Decimal("0.0001"))
        row = connection.execute(
            """insert into public.ingreso
               (obra_id, concepto, fecha, fecha_real, importe, estado, creado_por,
                conciliado_por, conciliado_en)
               values (%s, %s, %s, %s, %s, %s, %s,
                       case when %s = 'conciliado' then %s::uuid end,
                       case when %s = 'conciliado' then now() end)
               returning id""",
            (work_id, payload.concept, payload.received_on, actual_date,
             amount, payload.state.value, user.id,
             payload.state.value, user.id, payload.state.value),
        ).fetchone()
        assert row is not None
        _audit_income(connection, row["id"], user, "crear", {
            "importe": str(amount), "estado": payload.state.value,
        })
        return _income_detail(connection, row["id"])


def attach_income_receipt(
    settings: Settings, user: UserContext, income_id: UUID, path: str,
) -> dict[str, Any]:
    with transaction(settings) as connection:
        income = connection.execute(
            "select obra_id from public.ingreso where id = %s for update", (income_id,),
        ).fetchone()
        if income is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Ingreso inexistente")
        require_work_access(connection, user, income["obra_id"])
        if user.role is not Role.ADMIN:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN, "Solo administración adjunta comprobantes",
            )
        expected = f"{income['obra_id']}/{income_id}/"
        if not path.startswith(expected) or ".." in path or "\\" in path:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, "Ruta de comprobante inválida",
            )
        kind = _receipt_kind(path)
        stored = connection.execute(
            """select exists(select 1 from storage.objects
               where bucket_id = 'comprobantes' and name = %s) as receipt_exists""", (path,),
        ).fetchone()
        if not stored or not stored["receipt_exists"]:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, "El comprobante no existe en Storage",
            )
        added = connection.execute(
            """insert into public.ingreso_comprobante (ingreso_id, ruta, tipo, creado_por)
               values (%s, %s, %s, %s) on conflict (ruta) do nothing returning id""",
            (income_id, path, kind, user.id),
        ).fetchone()
        if added is not None:
            _audit_income(connection, income_id, user, "adjuntar_comprobante", {
                "tipo": kind, "ruta": path,
            })
        return _income_detail(connection, income_id)


INCOME_HAS_RECEIPT = """exists(select 1 from public.ingreso_comprobante k
    join storage.objects so on so.bucket_id = 'comprobantes' and so.name = k.ruta
    where k.ingreso_id = i.id)"""


def update_income_status(
    settings: Settings, user: UserContext, income_id: UUID, payload: IncomeStatusUpdate,
) -> dict[str, Any]:
    """pendiente → conciliado needs a stored receipt; conciliado → pendiente needs a reason."""
    with transaction(settings) as connection:
        income = connection.execute(
            f"""select i.obra_id, i.estado::text as estado, {INCOME_HAS_RECEIPT} as receipt_exists
                from public.ingreso i where i.id = %s for update of i""",
            (income_id,),
        ).fetchone()
        if income is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Ingreso inexistente")
        require_work_access(connection, user, income["obra_id"])
        if user.role is not Role.ADMIN:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Solo administración concilia ingresos")
        target = payload.state.value
        if income["estado"] == target:
            raise HTTPException(status.HTTP_409_CONFLICT, f"El ingreso ya está {target}")
        if target == "conciliado":
            if not income["receipt_exists"]:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "Adjunta al menos un comprobante antes de conciliar",
                )
            connection.execute(
                """update public.ingreso set estado = 'conciliado', conciliado_por = %s,
                     conciliado_en = now(), motivo_reversion = null where id = %s""",
                (user.id, income_id),
            )
            _audit_income(connection, income_id, user, "conciliar", {})
        else:
            connection.execute(
                """update public.ingreso set estado = 'pendiente', conciliado_por = null,
                     conciliado_en = null, motivo_reversion = %s where id = %s""",
                (payload.reason, income_id),
            )
            _audit_income(
                connection, income_id, user, "revertir_conciliacion", {"motivo": payload.reason}
            )
        return _income_detail(connection, income_id)


def reconcile_incomes_batch(
    settings: Settings, user: UserContext, payload: IncomeBatchReconcile,
) -> dict[str, Any]:
    """All-or-nothing: every income must belong to the work, be pending and have a receipt."""
    with transaction(settings) as connection:
        require_work_access(connection, user, payload.work_id)
        if user.role is not Role.ADMIN:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Solo administración concilia ingresos")
        ids = list(dict.fromkeys(payload.income_ids))
        rows = connection.execute(
            f"""select i.id, i.estado::text as estado, {INCOME_HAS_RECEIPT} as receipt_exists
                from public.ingreso i where i.obra_id = %s and i.id = any(%s) for update of i""",
            (payload.work_id, ids),
        ).fetchall()
        if len(rows) != len(ids):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, "El lote contiene ingresos inválidos"
            )
        if any(row["estado"] != "pendiente" or not row["receipt_exists"] for row in rows):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Todos los ingresos deben estar pendientes y tener comprobante",
            )
        connection.execute(
            """update public.ingreso set estado = 'conciliado', conciliado_por = %s,
                 conciliado_en = now(), motivo_reversion = null where id = any(%s)""",
            (user.id, ids),
        )
        for income_id in ids:
            _audit_income(connection, income_id, user, "conciliar_lote", {"lote": len(ids)})
        return {"reconciled": len(ids), "income_ids": ids}


def list_legacy_incomes(
    settings: Settings, user: UserContext, work_id: UUID,
) -> list[dict[str, Any]]:
    with transaction(settings) as connection:
        require_work_access(connection, user, work_id)
        return list(connection.execute(
            """select id, concepto, fecha as fecha_estimada, fecha_real, importe as monto,
               case when estado = 'conciliado' then 'cobrado' else 'por_cobrar' end as estado,
               creado_en from public.ingreso where obra_id = %s order by fecha, creado_en""",
            (work_id,),
        ).fetchall())


def create_legacy_income(
    settings: Settings, user: UserContext, payload: LegacyIncomeCreate,
) -> dict[str, Any]:
    result = create_income(settings, user, payload.work_id, IncomeCreate(
        received_on=payload.estimated_date, concept=payload.concept, amount=payload.amount,
        state=IncomeState.CONCILIADO if payload.state == "cobrado" else IncomeState.PENDIENTE,
    ), actual_date=payload.actual_date)
    return {
        "id": result["id"], "obra_id": result["work_id"], "concepto": result["concept"],
        "fecha_estimada": result["received_on"], "fecha_real": payload.actual_date,
        "monto": result["amount"], "estado": payload.state, "creado_en": result["created_at"],
    }


def list_subcontracts(settings: Settings, user: UserContext, work_id: UUID) -> list[dict[str, Any]]:
    with transaction(settings) as connection:
        require_work_access(connection, user, work_id)
        return list(
            connection.execute(
                """
                select s.id, s.subcontratista, s.concepto, s.alcance, s.monto_contratado,
                       coalesce(sum(p.monto), 0) as pagado
                from public.subcontrato s
                left join public.subcontrato_pago p on p.subcontrato_id = s.id
                where s.obra_id = %s
                group by s.id order by s.creado_en
                """,
                (work_id,),
            ).fetchall()
        )


def create_subcontract(
    settings: Settings, user: UserContext, payload: SubcontractCreate
) -> dict[str, Any]:
    with transaction(settings) as connection:
        require_work_access(connection, user, payload.work_id)
        if user.role is not Role.ADMIN:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Solo administración crea subcontratos")
        row = connection.execute(
            """
            insert into public.subcontrato
              (obra_id, subcontratista, concepto, alcance, monto_contratado)
            values (%s, %s, %s, %s, %s)
            returning id, obra_id, subcontratista, concepto, alcance, monto_contratado
            """,
            (
                payload.work_id,
                payload.subcontractor,
                payload.concept,
                payload.scope,
                payload.contracted_amount,
            ),
        ).fetchone()
        assert row is not None
        return row


def create_subcontract_payment(
    settings: Settings,
    user: UserContext,
    subcontract_id: UUID,
    payload: SubcontractPaymentCreate,
) -> dict[str, Any]:
    with transaction(settings) as connection:
        subcontract = connection.execute(
            "select obra_id from public.subcontrato where id = %s", (subcontract_id,)
        ).fetchone()
        if subcontract is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Subcontrato inexistente")
        require_work_access(connection, user, subcontract["obra_id"])
        if user.role is not Role.ADMIN:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Solo administración registra pagos")
        row = connection.execute(
            """
            insert into public.subcontrato_pago
              (subcontrato_id, fecha, monto, gasto_id_vinculado, creado_por)
            values (%s, %s, %s, %s, %s)
            returning id, subcontrato_id, fecha, monto, gasto_id_vinculado
            """,
            (
                subcontract_id,
                payload.spent_on,
                payload.amount,
                payload.linked_expense_id,
                user.id,
            ),
        ).fetchone()
        assert row is not None
        return row


def dashboard(settings: Settings, user: UserContext) -> dict[str, Any]:
    with transaction(settings) as connection:
        require_active_profile(connection, user)
        access_clause = (
            "true"
            if user.role is Role.ADMIN
            else (
                "exists (select 1 from public.usuario_obra uo "
                "where uo.obra_id = o.id and uo.usuario_id = %s)"
            )
        )
        params: tuple[Any, ...] = () if user.role is Role.ADMIN else (user.id,)
        works = connection.execute(
            f"""
            select o.id, o.nombre, o.ubicacion,
                   coalesce((select sum(pp.importe) from public.presupuesto_partida pp
                     where pp.obra_id = o.id and pp.vigente), 0) as presupuesto,
                   coalesce((select sum(g.importe) from public.gasto g
                     where g.obra_id = o.id and g.eliminado_en is null), 0) as gasto,
                   coalesce((select sum(g.importe) from public.gasto g
                     where g.obra_id = o.id and g.eliminado_en is null
                       and g.estado = 'pendiente'), 0) as pendiente
                   ,coalesce((select sum(i.importe) from public.ingreso i
                     where i.obra_id = o.id and i.estado = 'conciliado'), 0) as cobrado
                   ,coalesce((select sum(i.importe) from public.ingreso i
                     where i.obra_id = o.id and i.estado = 'pendiente'), 0) as por_cobrar
                   ,coalesce((select sum(s.monto_contratado) from public.subcontrato s
                     where s.obra_id = o.id), 0) as subcontratado
                   ,coalesce((select sum(sp.monto) from public.subcontrato_pago sp
                     join public.subcontrato s on s.id = sp.subcontrato_id
                     where s.obra_id = o.id), 0) as pagado_subcontratos
            from public.obra o where {access_clause}
            order by o.nombre
            """,
            params,
        ).fetchall()
        budget = sum((row["presupuesto"] for row in works), 0)
        spent = sum((row["gasto"] for row in works), 0)
        pending = sum((row["pendiente"] for row in works), 0)
        collected = sum((row["cobrado"] for row in works), 0)
        receivable = sum((row["por_cobrar"] for row in works), 0)
        subcontracted = sum((row["subcontratado"] for row in works), 0)
        subcontract_paid = sum((row["pagado_subcontratos"] for row in works), 0)
        return {
            "works": list(works),
            "permissions": {"can_delete_works": user.role is Role.ADMIN},
            "totals": {
                "budget": budget,
                "spent": spent,
                "available": budget - spent,
                "pending": pending,
                "collected": collected,
                "receivable": receivable,
                "subcontracted": subcontracted,
                "subcontract_paid": subcontract_paid,
                "cash_balance": collected - spent,
            },
        }


def work_overview(
    settings: Settings,
    user: UserContext,
    work_id: UUID,
    date_from: date | None = None,
    date_to: date | None = None,
) -> dict[str, Any]:
    with transaction(settings) as connection:
        require_work_access(connection, user, work_id)
        work = connection.execute(
            "select id, nombre, ubicacion, estado::text as estado from public.obra where id = %s",
            (work_id,),
        ).fetchone()
        if work is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Obra inexistente")
        end_date = date_to or date.today()
        totals = connection.execute(
            """
            select
              coalesce((select sum(pp.importe) from public.presupuesto_partida pp
                where pp.obra_id = %(work)s and pp.vigente), 0) as budget,
              coalesce(sum(g.importe) filter (
                where g.estado = 'validado' and g.fecha <= %(to)s), 0) as validated,
              coalesce(sum(g.importe) filter (
                where g.estado in ('validado','pendiente') and g.fecha <= %(to)s), 0) as committed,
              coalesce(sum(g.importe) filter (where g.estado = 'pendiente'), 0) as pending,
              count(*) filter (where g.estado = 'pendiente') as pending_count,
              coalesce(sum(g.importe) filter (where g.estado = 'rechazado'), 0) as rejected,
              count(*) filter (where g.estado = 'rechazado') as rejected_count,
              count(*) filter (
                where g.estado = 'pendiente' and not exists (
                  select 1 from public.gasto_comprobante k where k.gasto_id = g.id))
                as missing_receipts
            from public.gasto g
            where g.obra_id = %(work)s and g.eliminado_en is null
            """,
            {"work": work_id, "to": end_date},
        ).fetchone()
        assert totals is not None
        budget = totals["budget"]
        totals["available"] = budget - totals["validated"]
        totals["projected_available"] = budget - totals["committed"]
        totals["execution_percent"] = (
            Decimal("0") if not budget else totals["validated"] / budget * Decimal("100")
        )

        # Cumulative to the period end, like `validated`, so both compare on the same basis.
        incomes = connection.execute(
            """select coalesce(sum(i.importe), 0) as total,
                 coalesce(sum(i.importe) filter (where i.estado = 'conciliado'), 0) as reconciled,
                 coalesce(sum(i.importe) filter (where i.estado = 'pendiente'), 0) as pending,
                 count(*) as count
               from public.ingreso i where i.obra_id = %s and i.fecha <= %s""",
            (work_id, end_date),
        ).fetchone()

        period_clauses = ["g.obra_id = %s", "g.eliminado_en is null"]
        period_params: list[Any] = [work_id]
        if date_from:
            period_clauses.append("g.fecha >= %s")
            period_params.append(date_from)
        if date_to:
            period_clauses.append("g.fecha <= %s")
            period_params.append(date_to)
        period_where = " and ".join(period_clauses)

        area_rows = connection.execute(
            """
            select a.id, a.parent_id, a.nombre, a.ruta_normalizada as ruta,
                   a.nivel, a.seleccionable,
                   coalesce((select sum(pp.importe) from public.presupuesto_partida pp
                     where pp.area_id = a.id and pp.vigente), 0) as budget,
                   coalesce((select sum(g.importe) from public.gasto g
                     where g.area_id = a.id and g.eliminado_en is null
                       and g.estado = 'validado' and g.fecha <= %s), 0) as validated,
                   coalesce((select sum(g.importe) from public.gasto g
                     where g.area_id = a.id and g.eliminado_en is null
                       and g.estado in ('validado','pendiente') and g.fecha <= %s), 0) as committed
            from public.area a where a.obra_id = %s and a.vigente
            order by a.ruta_normalizada
            """,
            (end_date, end_date, work_id),
        ).fetchall()
        by_id = {row["id"]: row for row in area_rows}
        for row in sorted(area_rows, key=lambda value: value["nivel"], reverse=True):
            parent = by_id.get(row["parent_id"])
            if parent:
                parent["budget"] += row["budget"]
                parent["validated"] += row["validated"]
                parent["committed"] += row["committed"]
        for row in area_rows:
            row["available"] = row["budget"] - row["validated"]
            row["execution_percent"] = (
                Decimal("0")
                if not row["budget"]
                else row["validated"] / row["budget"] * Decimal("100")
            )

        weekly = connection.execute(
            f"""select date_trunc('week', g.fecha)::date as week,
                 coalesce(sum(g.importe) filter (where g.estado = 'validado'), 0) as validated,
                 coalesce(sum(g.importe) filter (where g.estado = 'pendiente'), 0) as pending
                 from public.gasto g where {period_where}
                 group by 1 order by 1""",
            period_params,
        ).fetchall()
        suppliers = connection.execute(
            f"""select coalesce(p.nombre, 'Sin proveedor') as name, sum(g.importe) as amount
                 from public.gasto g left join public.catalogo_proveedor p on p.id = g.proveedor_id
                 where {period_where} and g.estado = 'validado'
                 group by 1 order by amount desc limit 8""",
            period_params,
        ).fetchall()
        categories = connection.execute(
            f"""select coalesce(c.nombre, 'Sin categoría') as name, sum(g.importe) as amount
                 from public.gasto g left join public.catalogo_categoria_gasto c
                   on c.id = g.categoria_gasto_id
                 where {period_where} and g.estado = 'validado'
                 group by 1 order by amount desc""",
            period_params,
        ).fetchall()
        period = connection.execute(
            f"""select coalesce(sum(g.importe) filter (where g.estado = 'validado'), 0)
                   as validated,
                 coalesce(sum(g.importe) filter (where g.estado = 'pendiente'), 0) as pending
                 from public.gasto g where {period_where}""",
            period_params,
        ).fetchone()
        return {
            "work": work,
            "totals": totals,
            "period": period,
            "areas": list(area_rows),
            "weekly": list(weekly),
            "suppliers": list(suppliers),
            "categories": list(categories),
            "incomes": incomes,
            "permissions": {"can_validate": user.role is Role.ADMIN},
        }


def list_weekly_closes(
    settings: Settings, user: UserContext, work_id: UUID
) -> list[dict[str, Any]]:
    with transaction(settings) as connection:
        require_work_access(connection, user, work_id)
        return list(
            connection.execute(
                """
                select c.id, c.anio_iso, c.semana_iso, c.estado::text as estado,
                       c.cerrado_en, c.reabierto_en, c.motivo_reapertura, c.revision,
                       count(cg.gasto_id) as expense_count,
                       coalesce(sum(cg.importe_al_cierre), 0) as amount
                from public.cierre_semanal c
                left join public.cierre_semanal_gasto cg
                  on cg.cierre_id = c.id and cg.revision = c.revision
                where c.obra_id = %s group by c.id
                order by c.anio_iso desc, c.semana_iso desc
                """,
                (work_id,),
            ).fetchall()
        )


def weekly_close_preview(
    settings: Settings, user: UserContext, work_id: UUID, iso_year: int, iso_week: int
) -> dict[str, Any]:
    try:
        start = date.fromisocalendar(iso_year, iso_week, 1)
    except ValueError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Semana ISO inválida") from exc
    end = start + timedelta(days=6)
    with transaction(settings) as connection:
        require_work_access(connection, user, work_id)
        _lock_work_expenses(connection, work_id)
        expenses = connection.execute(
            """select id, fecha, concepto, importe, estado::text as estado,
                      origen::text as origen
               from public.gasto where obra_id = %s and eliminado_en is null
                 and fecha between %s and %s order by fecha, creado_en, id""",
            (work_id, start, end),
        ).fetchall()
        close = connection.execute(
            """select id, estado::text as estado, revision, cerrado_en, reabierto_en,
                      motivo_reapertura from public.cierre_semanal
               where obra_id = %s and anio_iso = %s and semana_iso = %s""",
            (work_id, iso_year, iso_week),
        ).fetchone()
        history = []
        revisions = []
        if close:
            history = connection.execute(
                """select a.accion, a.creado_en, a.detalle_json, p.nombre as autor
                   from public.audit_log_negocio a
                   join public.perfil_usuario p on p.id = a.usuario_id
                   where a.entidad = 'cierre_semanal' and a.entidad_id = %s
                   order by a.creado_en, a.id""",
                (close["id"],),
            ).fetchall()
            revisions = connection.execute(
                """select revision, count(*) as expense_count,
                          sum(importe_al_cierre) as amount
                   from public.cierre_semanal_gasto where cierre_id = %s
                   group by revision order by revision""",
                (close["id"],),
            ).fetchall()
        summary: dict[str, Any] = {"count": len(expenses)}
        for state in ("pendiente", "validado", "rechazado"):
            selected = [expense for expense in expenses if expense["estado"] == state]
            summary[state] = {
                "count": len(selected),
                "amount": sum((row["importe"] for row in selected), Decimal(0)),
            }
        summary["amount"] = summary["pendiente"]["amount"] + summary["validado"]["amount"]
        return {
            "work_id": work_id,
            "iso_year": iso_year,
            "iso_week": iso_week,
            "date_from": start,
            "date_to": end,
            "summary": summary,
            "expenses": list(expenses),
            "close": close,
            "history": list(history),
            "revisions": list(revisions),
            "permissions": {"can_manage": user.role is Role.ADMIN},
        }


def report_expenses(
    settings: Settings, user: UserContext, work_id: UUID
) -> tuple[str, list[dict[str, Any]]]:
    with transaction(settings) as connection:
        require_work_access(connection, user, work_id)
        work = connection.execute(
            "select nombre from public.obra where id = %s", (work_id,)
        ).fetchone()
        if work is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Obra inexistente")
        rows = connection.execute(
            """
            select g.fecha::text as "Fecha", a.nombre as "Área",
                   coalesce(cpg.nombre, cc.nombre, '') as "Partida",
                   coalesce(csg.nombre, '') as "Subpartida",
                   coalesce(cag.nombre, cat.nombre, '') as "Categoría",
                   coalesce(prov.nombre, '') as "Proveedor", g.concepto as "Concepto",
                   g.folio as "Folio", coalesce(g.folio_proveedor, '') as "Folio proveedor",
                   g.subtotal as "Subtotal", g.iva as "IVA", g.importe as "Importe",
                   g.estado::text as "Estado"
            from public.gasto g
            join public.area a on a.id = g.area_id
            left join public.catalogo_partida_gasto cpg on cpg.id = g.partida_gasto_id
            left join public.catalogo_subpartida_gasto csg on csg.id = g.subpartida_gasto_id
            left join public.catalogo_categoria_gasto cag on cag.id = g.categoria_gasto_id
            left join public.catalogo_clase cc on cc.id = g.clase_id
            left join public.catalogo_categoria cat on cat.id = g.categoria_id
            left join public.catalogo_proveedor prov on prov.id = g.proveedor_id
            where g.obra_id = %s and g.eliminado_en is null
            order by g.fecha, g.creado_en
            """,
            (work_id,),
        ).fetchall()
        return work["nombre"], list(rows)


def close_week(settings: Settings, user: UserContext, payload: WeeklyCloseCreate) -> dict[str, Any]:
    with transaction(settings) as connection:
        require_work_access(connection, user, payload.work_id)
        if user.role is not Role.ADMIN:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Solo administración cierra semanas")
        try:
            date.fromisocalendar(payload.iso_year, payload.iso_week, 1)
        except ValueError as exc:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, "Semana ISO inválida"
            ) from exc
        _lock_work_expenses(connection, payload.work_id)
        existing = connection.execute(
            """
            select id, estado::text as estado from public.cierre_semanal
            where obra_id = %s and anio_iso = %s and semana_iso = %s for update
            """,
            (payload.work_id, payload.iso_year, payload.iso_week),
        ).fetchone()
        if existing is not None and existing["estado"] == "cerrado":
            raise HTTPException(status.HTTP_409_CONFLICT, "La semana ya está cerrada")
        pending = connection.execute(
            """
            select count(*) as total from public.gasto g
            where g.obra_id = %s and g.eliminado_en is null and g.estado = 'pendiente'
              and extract(isoyear from g.fecha)::integer = %s
              and extract(week from g.fecha)::integer = %s
            """,
            (payload.work_id, payload.iso_year, payload.iso_week),
        ).fetchone()
        if pending and pending["total"]:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"Hay {pending['total']} gastos pendientes en la semana",
            )
        close = connection.execute(
            """
            insert into public.cierre_semanal
              (obra_id, anio_iso, semana_iso, cerrado_por)
            values (%s, %s, %s, %s)
            on conflict (obra_id, anio_iso, semana_iso) do update
              set estado = 'cerrado', cerrado_por = excluded.cerrado_por, cerrado_en = now(),
                  revision = cierre_semanal.revision + 1,
                  reabierto_por = null, reabierto_en = null, motivo_reapertura = null
            returning id, obra_id, anio_iso, semana_iso, estado::text as estado,
                      cerrado_en, revision
            """,
            (payload.work_id, payload.iso_year, payload.iso_week, user.id),
        ).fetchone()
        assert close is not None
        connection.execute(
            """
            insert into public.cierre_semanal_gasto
              (cierre_id, revision, gasto_id, importe_al_cierre, estado_al_cierre)
            select %s, %s, g.id, g.importe, g.estado
            from public.gasto g
            where g.obra_id = %s and g.eliminado_en is null
              and g.estado = 'validado'
              and extract(isoyear from g.fecha)::integer = %s
              and extract(week from g.fecha)::integer = %s
            """,
            (close["id"], close["revision"], payload.work_id, payload.iso_year, payload.iso_week),
        )
        count = connection.execute(
            "select count(*) as total from public.cierre_semanal_gasto "
            "where cierre_id = %s and revision = %s",
            (close["id"], close["revision"]),
        ).fetchone()
        close["expense_count"] = count["total"] if count else 0
        connection.execute(
            """
            insert into public.audit_log_negocio
              (entidad, entidad_id, accion, usuario_id, canal, detalle_json)
            values ('cierre_semanal', %s, 'cerrar_lote', %s, 'web', %s)
            """,
            (
                close["id"],
                user.id,
                Jsonb(
                    {
                        "gastos": close["expense_count"],
                        "revision": close["revision"],
                        "transicion": "reabierto_cerrado" if existing else "inicial_cerrado",
                    }
                ),
            ),
        )
        return close


def reopen_week(
    settings: Settings, user: UserContext, close_id: UUID, reason: str
) -> dict[str, Any]:
    with transaction(settings) as connection:
        require_active_profile(connection, user)
        if user.role is not Role.ADMIN:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Solo administración reabre semanas")
        reason = reason.strip()
        if len(reason) < 10:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Motivo insuficiente")
        target = connection.execute(
            "select obra_id from public.cierre_semanal where id = %s", (close_id,)
        ).fetchone()
        if target is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Cierre inexistente")
        require_work_access(connection, user, target["obra_id"])
        _lock_work_expenses(connection, target["obra_id"])
        row = connection.execute(
            """
            update public.cierre_semanal
            set estado = 'reabierto', reabierto_por = %s, reabierto_en = now(),
                motivo_reapertura = %s
            where id = %s and estado = 'cerrado'
            returning id, obra_id, anio_iso, semana_iso, estado::text as estado,
                      reabierto_en, motivo_reapertura, revision
            """,
            (user.id, reason, close_id),
        ).fetchone()
        if row is None:
            raise HTTPException(status.HTTP_409_CONFLICT, "Cierre inexistente o ya reabierto")
        connection.execute(
            """
            insert into public.audit_log_negocio
              (entidad, entidad_id, accion, usuario_id, canal, detalle_json)
            values ('cierre_semanal', %s, 'reabrir', %s, 'web', %s)
            """,
            (close_id, user.id, Jsonb({"motivo": reason, "revision": row["revision"]})),
        )
        return row


def store_import_preview(
    settings: Settings,
    user: UserContext,
    work_id: UUID | None,
    new_work: WorkCreate | None,
    import_type: str,
    filename: str,
    content: bytes,
    preview: dict[str, Any],
) -> dict[str, Any]:
    if import_type not in {"inicial", "nueva_version", "extra"}:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Tipo de importación inválido")
    digest = hashlib.sha256(content).hexdigest()
    parser_version = int(preview.get("parser_version", 1))
    with transaction(settings) as connection:
        require_active_profile(connection, user)
        if user.role is not Role.ADMIN:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Solo administración importa")
        created_work: dict[str, Any] | None = None
        if new_work is not None:
            if import_type != "inicial":
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "Una obra nueva debe iniciar con un presupuesto inicial",
                )
            created_work = _insert_work(connection, user, new_work)
            work_id = created_work["id"]
        if work_id is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Falta la obra destino")
        require_work_access(connection, user, work_id)
        duplicate = connection.execute(
            """
            select id, obra_id, archivo_nombre, tipo::text as tipo,
                   estado::text as estado, creado_en, preview_json, parser_version
            from public.importacion_neodata
            where obra_id = %s and archivo_sha256 = %s and parser_version = %s
              and estado <> 'descartado'
            order by creado_en desc limit 1
            """,
            (work_id, digest, parser_version),
        ).fetchone()
        if duplicate is not None:
            duplicate["preview"] = duplicate.pop("preview_json")
            duplicate["preview"].setdefault(
                "consolidated_item_count",
                preview.get("consolidated_item_count", len(duplicate["preview"].get("items", []))),
            )
            duplicate["preview"].setdefault("rollup_total_count", 0)
            duplicate["preview"].setdefault("section_totals", [])
            duplicate["duplicate"] = True
            duplicate["read_only"] = duplicate["estado"] != "preview"
            return duplicate
        row = connection.execute(
            """
            insert into public.importacion_neodata (
              obra_id, archivo_nombre, archivo_sha256, hojas, tipo,
              estado, preview_json, catalogo_nuevo_json, parser_version
            ) values (%s, %s, %s, %s, %s, 'preview', %s, '{}'::jsonb, %s)
            returning id, obra_id, archivo_nombre, tipo::text as tipo,
                      estado::text as estado, creado_en
            """,
            (
                work_id,
                filename,
                digest,
                Jsonb(preview["sheets"]),
                import_type,
                Jsonb(preview),
                parser_version,
            ),
        ).fetchone()
        assert row is not None
        row["preview"] = preview
        row["duplicate"] = False
        row["read_only"] = False
        if created_work is not None:
            row["work"] = created_work
        return row


def update_import_preview(
    settings: Settings,
    user: UserContext,
    import_id: UUID,
    payload: ImportPreviewUpdate,
) -> dict[str, Any]:
    with transaction(settings) as connection:
        imported = connection.execute(
            """
            select id, obra_id, estado::text as estado, preview_json
            from public.importacion_neodata where id = %s for update
            """,
            (import_id,),
        ).fetchone()
        if imported is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Preview inexistente")
        require_work_access(connection, user, imported["obra_id"])
        if user.role is not Role.ADMIN:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Solo administración corrige previews")
        if imported["estado"] != "preview":
            raise HTTPException(status.HTTP_409_CONFLICT, "La importación ya no es editable")

        preview = imported["preview_json"]
        items = preview.get("items", [])
        indexed = {(item["sheet"], item["row"]): item for item in items}
        seen: set[tuple[str, int]] = set()
        for correction in payload.items:
            key = (correction.sheet, correction.row)
            if key in seen:
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Corrección duplicada")
            seen.add(key)
            item = indexed.get(key)
            if item is None:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    f"La fila {correction.sheet}!{correction.row} no pertenece al preview",
                )
            previous_path = list(item.get("area_path") or [item["area"]])
            previous_area = item["area"]
            for field, value in correction.model_dump().items():
                if field not in {"sheet", "row"}:
                    item[field] = value
            item["area_path"] = (
                [*previous_path[:-1], item["area"]]
                if item["area"] != previous_area
                else previous_path
            )

        preview["areas"] = dict(Counter(item["area"] for item in items))
        preview["area_label_count"] = len(preview["areas"])
        preview["area_count"] = len(
            {
                tuple(normalized_text(part) for part in (item.get("area_path") or [item["area"]]))
                for item in items
            }
        )
        preview["consolidated_item_count"] = len(_consolidate_preview_items(items))
        connection.execute(
            "update public.importacion_neodata set preview_json = %s where id = %s",
            (Jsonb(preview), import_id),
        )
        connection.execute(
            """
            insert into public.audit_log_negocio
              (entidad, entidad_id, accion, usuario_id, canal, detalle_json)
            values ('importacion_neodata', %s, 'corregir_preview', %s, 'web', %s)
            """,
            (import_id, user.id, Jsonb({"filas": len(payload.items)})),
        )
        return {"id": import_id, "estado": imported["estado"], "preview": preview}


def _catalog_item(
    connection: psycopg.Connection[dict[str, Any]], user: UserContext, item: dict[str, Any]
) -> tuple[UUID, UUID, UUID | None]:
    work_class = connection.execute(
        """
        insert into public.catalogo_clase (nombre, creado_por)
        values (%s, %s)
        on conflict (nombre_normalizado) do update set nombre = excluded.nombre
        returning id
        """,
        (item["work_class"], user.id),
    ).fetchone()
    assert work_class is not None
    category_id: UUID | None = None
    if item.get("category"):
        category = connection.execute(
            """
            insert into public.catalogo_categoria (clase_id, nombre, creado_por)
            values (%s, %s, %s)
            on conflict (clase_id, nombre_normalizado) do update set nombre = excluded.nombre
            returning id
            """,
            (work_class["id"], item["category"], user.id),
        ).fetchone()
        assert category is not None
        category_id = category["id"]
    existing = connection.execute(
        """
        select id from public.catalogo_partida
        where codigo_normalizado = public.normalizar_texto(%s)
          and descripcion_normalizada = public.normalizar_texto(%s)
          and unidad_normalizada = public.normalizar_texto(%s)
          and clase_id = %s
          and coalesce(categoria_id, '00000000-0000-0000-0000-000000000000'::uuid)
              = coalesce(%s, '00000000-0000-0000-0000-000000000000'::uuid)
        """,
        (
            item["code"],
            item["description"],
            item["unit"],
            work_class["id"],
            category_id,
        ),
    ).fetchone()
    if existing is None:
        existing = connection.execute(
            """
            insert into public.catalogo_partida
              (clase_id, categoria_id, codigo, descripcion, unidad, creado_por)
            values (%s, %s, %s, %s, %s, %s) returning id
            """,
            (
                work_class["id"],
                category_id,
                item["code"],
                item["description"],
                item["unit"],
                user.id,
            ),
        ).fetchone()
    assert existing is not None
    return existing["id"], work_class["id"], category_id


def _consolidate_preview_items(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    consolidated: dict[tuple[str, ...], dict[str, Any]] = {}
    for source in items:
        area_path = source.get("area_path") or [source["area"]]
        key = (
            *(normalized_text(part) for part in area_path),
            "::BUDGET-ITEM::",
            normalized_text(source["code"]),
            normalized_text(source["description"]),
            normalized_text(source["unit"]),
            normalized_text(source["work_class"]),
            normalized_text(source.get("category")),
        )
        if key not in consolidated:
            consolidated[key] = dict(source)
            consolidated[key]["area_path"] = list(area_path)
            continue
        target = consolidated[key]
        target["quantity"] = str(
            Decimal(str(target["quantity"])) + Decimal(str(source["quantity"]))
        )
        target["amount"] = str(Decimal(str(target["amount"])) + Decimal(str(source["amount"])))

    for item in consolidated.values():
        quantity = Decimal(str(item["quantity"]))
        if quantity:
            item["unit_price"] = str(
                (Decimal(str(item["amount"])) / quantity).quantize(Decimal("0.000001"))
            )
    return list(consolidated.values())


def confirm_import(
    settings: Settings, user: UserContext, import_id: UUID, confirmation: bool
) -> dict[str, Any]:
    if not confirmation:
        raise HTTPException(status.HTTP_409_CONFLICT, "Se requiere confirmación explícita")
    with transaction(settings) as connection:
        require_active_profile(connection, user)
        if user.role is not Role.ADMIN:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Solo administración confirma")
        imported = connection.execute(
            """
            select id, obra_id, tipo::text as tipo, estado::text as estado, preview_json
            from public.importacion_neodata where id = %s for update
            """,
            (import_id,),
        ).fetchone()
        if imported is None or imported["estado"] != "preview":
            raise HTTPException(status.HTTP_409_CONFLICT, "Preview inexistente o ya resuelto")
        require_work_access(connection, user, imported["obra_id"])
        preview = imported["preview_json"]
        if preview.get("unclassified") or preview.get("section_mismatches"):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "El preview contiene filas o totales pendientes de resolver",
            )
        version_row = connection.execute(
            "select coalesce(max(version), 0) + 1 as version from public.presupuesto_partida "
            "where obra_id = %s",
            (imported["obra_id"],),
        ).fetchone()
        version = version_row["version"] if version_row else 1
        if imported["tipo"] in {"inicial", "nueva_version"}:
            connection.execute(
                "update public.presupuesto_partida set vigente = false where obra_id = %s",
                (imported["obra_id"],),
            )
        if imported["tipo"] in {"inicial", "nueva_version"}:
            connection.execute(
                "update public.area set vigente = false where obra_id = %s",
                (imported["obra_id"],),
            )
        area_ids: dict[tuple[str, ...], UUID] = {}
        consolidated_items = _consolidate_preview_items(preview["items"])
        for order, item in enumerate(consolidated_items):
            raw_path = tuple(item.get("area_path") or [item["area"]])
            parent_id: UUID | None = None
            for level in range(1, len(raw_path) + 1):
                path = raw_path[:level]
                normalized_path = [normalized_text(part) for part in path]
                if path in area_ids:
                    parent_id = area_ids[path]
                    continue
                area = connection.execute(
                    """
                    insert into public.area
                      (obra_id, parent_id, nombre, ruta_normalizada, nivel,
                       seleccionable, vigente, orden)
                    values (%s, %s, %s, %s, %s, %s, true, %s)
                    on conflict (obra_id, ruta_normalizada) do update
                    set parent_id = excluded.parent_id, nombre = excluded.nombre,
                        nivel = excluded.nivel,
                        seleccionable = public.area.seleccionable or excluded.seleccionable,
                        vigente = true, orden = excluded.orden
                    returning id
                    """,
                    (
                        imported["obra_id"],
                        parent_id,
                        path[-1],
                        normalized_path,
                        level - 1,
                        level == len(raw_path),
                        order,
                    ),
                ).fetchone()
                assert area is not None
                area_ids[path] = area["id"]
                parent_id = area["id"]
            part_id, _class_id, _category_id = _catalog_item(connection, user, item)
            connection.execute(
                """
                insert into public.presupuesto_partida (
                  obra_id, area_id, partida_id, cantidad, precio_unitario,
                  importe, version, vigente, origen, importacion_id
                ) values (%s, %s, %s, %s, %s, %s, %s, true, 'neodata', %s)
                """,
                (
                    imported["obra_id"],
                    area_ids[raw_path],
                    part_id,
                    item["quantity"],
                    item["unit_price"],
                    item["amount"],
                    version,
                    import_id,
                ),
            )
        row = connection.execute(
            """
            update public.importacion_neodata
            set estado = 'confirmado', version_resultante = %s,
                confirmado_por = %s, confirmado_en = now()
            where id = %s
            returning id, obra_id, estado::text as estado, version_resultante, confirmado_en
            """,
            (version, user.id, import_id),
        ).fetchone()
        assert row is not None
        connection.execute(
            """
            insert into public.audit_log_negocio
              (entidad, entidad_id, accion, usuario_id, canal, detalle_json)
            values ('importacion_neodata', %s, 'confirmar', %s, 'web', %s)
            """,
            (
                import_id,
                user.id,
                Jsonb(
                    {
                        "version": version,
                        "partidas_fuente": len(preview["items"]),
                        "partidas_consolidadas": len(consolidated_items),
                    }
                ),
            ),
        )
        row["source_item_count"] = len(preview["items"])
        row["item_count"] = len(consolidated_items)
        return row
