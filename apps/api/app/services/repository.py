import hashlib
from collections import Counter
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import date
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
    ImportPreviewUpdate,
    IncomeCreate,
    Role,
    SubcontractCreate,
    SubcontractPaymentCreate,
    UserContext,
    WeeklyCloseCreate,
    WorkCreate,
    WorkDelete,
)
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
            select comprobante_path from public.gasto
            where obra_id = %s and comprobante_path is not null
            """,
            (work_id,),
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
            "select id, nombre from public.area where obra_id = %s order by orden, nombre",
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
            "select id, nombre from public.catalogo_proveedor where activo order by nombre"
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
        }


def create_expense(
    settings: Settings, user: UserContext, payload: ExpenseCreate
) -> dict[str, Any]:
    with transaction(settings) as connection:
        require_work_access(connection, user, payload.work_id)
        area = connection.execute(
            "select id from public.area where id = %s and obra_id = %s",
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

        if payload.supplier_id is not None:
            supplier = connection.execute(
                "select id from public.catalogo_proveedor where id = %s and activo",
                (payload.supplier_id,),
            ).fetchone()
            if supplier is None:
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Proveedor inactivo")
            supplier_id = supplier["id"]
        else:
            supplier = connection.execute(
                """
                insert into public.catalogo_proveedor (nombre, creado_por)
                values (%s, %s)
                on conflict (nombre_normalizado)
                do update set nombre = excluded.nombre, activo = true
                returning id
                """,
                (payload.supplier_name, user.id),
            ).fetchone()
            assert supplier is not None
            supplier_id = supplier["id"]

        row = connection.execute(
            """
            insert into public.gasto (
              obra_id, area_id, clase_id, categoria_id, partida_id,
              partida_gasto_id, subpartida_gasto_id, categoria_gasto_id, proveedor_id,
              fecha, concepto, folio, importe, estado, origen, creado_por
            ) values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'web', %s)
            returning id, obra_id, area_id, partida_gasto_id, subpartida_gasto_id,
                      categoria_gasto_id, partida_id, proveedor_id, fecha, concepto, folio,
                      importe, estado::text as estado, creado_en
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
                payload.folio,
                payload.amount,
                payload.state.value,
                user.id,
            ),
        ).fetchone()
        assert row is not None
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
                        "importe": str(payload.amount),
                        "partida_gasto_id": str(payload.expense_item_id),
                        "subpartida_gasto_id": str(payload.expense_subitem_id),
                        "categoria_gasto_id": str(payload.expense_category_id),
                        "proveedor_id": str(supplier_id),
                    }
                ),
            ),
        )
        return row


def list_expenses(
    settings: Settings, user: UserContext, work_id: UUID
) -> list[dict[str, Any]]:
    with transaction(settings) as connection:
        require_work_access(connection, user, work_id)
        return list(
            connection.execute(
                """
                select g.id, g.fecha, g.concepto, g.folio, g.importe,
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
            "select obra_id, creado_por from public.gasto where id = %s and eliminado_en is null",
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
        if user.role is not Role.ADMIN and expense["creado_por"] != user.id:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Solo el autor adjunta el comprobante")
        row = connection.execute(
            """
            update public.gasto set comprobante_path = %s, editado_por = %s, editado_en = now()
            where id = %s returning id, comprobante_path
            """,
            (path, user.id, expense_id),
        ).fetchone()
        assert row is not None
        return row


def list_incomes(
    settings: Settings, user: UserContext, work_id: UUID
) -> list[dict[str, Any]]:
    with transaction(settings) as connection:
        require_work_access(connection, user, work_id)
        return list(
            connection.execute(
                """
                select id, concepto, fecha_estimada, fecha_real, monto,
                       estado::text as estado, creado_en
                from public.ingreso where obra_id = %s order by fecha_estimada, creado_en
                """,
                (work_id,),
            ).fetchall()
        )


def create_income(
    settings: Settings, user: UserContext, payload: IncomeCreate
) -> dict[str, Any]:
    with transaction(settings) as connection:
        require_work_access(connection, user, payload.work_id)
        if user.role is not Role.ADMIN:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Solo administración registra ingresos")
        row = connection.execute(
            """
            insert into public.ingreso
              (obra_id, concepto, fecha_estimada, fecha_real, monto, estado, creado_por)
            values (%s, %s, %s, %s, %s, %s, %s)
            returning id, obra_id, concepto, fecha_estimada, fecha_real, monto,
                      estado::text as estado, creado_en
            """,
            (
                payload.work_id,
                payload.concept,
                payload.estimated_date,
                payload.actual_date,
                payload.amount,
                payload.state,
                user.id,
            ),
        ).fetchone()
        assert row is not None
        return row


def list_subcontracts(
    settings: Settings, user: UserContext, work_id: UUID
) -> list[dict[str, Any]]:
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
                   ,coalesce((select sum(i.monto) from public.ingreso i
                     where i.obra_id = o.id and i.estado = 'cobrado'), 0) as cobrado
                   ,coalesce((select sum(i.monto) from public.ingreso i
                     where i.obra_id = o.id and i.estado = 'por_cobrar'), 0) as por_cobrar
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
                   coalesce(g.folio, '') as "Folio", g.importe as "Importe",
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


def close_week(
    settings: Settings, user: UserContext, payload: WeeklyCloseCreate
) -> dict[str, Any]:
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
        existing = connection.execute(
            """
            select id, estado::text as estado from public.cierre_semanal
            where obra_id = %s and anio_iso = %s and semana_iso = %s for update
            """,
            (payload.work_id, payload.iso_year, payload.iso_week),
        ).fetchone()
        if existing is not None:
            raise HTTPException(status.HTTP_409_CONFLICT, "La semana ya tiene cierre")
        close = connection.execute(
            """
            insert into public.cierre_semanal
              (obra_id, anio_iso, semana_iso, cerrado_por)
            values (%s, %s, %s, %s)
            returning id, obra_id, anio_iso, semana_iso, estado::text as estado, cerrado_en
            """,
            (payload.work_id, payload.iso_year, payload.iso_week, user.id),
        ).fetchone()
        assert close is not None
        connection.execute(
            """
            insert into public.cierre_semanal_gasto
              (cierre_id, gasto_id, importe_al_cierre, estado_al_cierre)
            select %s, g.id, g.importe, g.estado
            from public.gasto g
            where g.obra_id = %s and g.eliminado_en is null
              and extract(isoyear from g.fecha)::integer = %s
              and extract(week from g.fecha)::integer = %s
            """,
            (close["id"], payload.work_id, payload.iso_year, payload.iso_week),
        )
        count = connection.execute(
            "select count(*) as total from public.cierre_semanal_gasto where cierre_id = %s",
            (close["id"],),
        ).fetchone()
        close["expense_count"] = count["total"] if count else 0
        connection.execute(
            """
            insert into public.audit_log_negocio
              (entidad, entidad_id, accion, usuario_id, canal, detalle_json)
            values ('cierre_semanal', %s, 'cerrar_lote', %s, 'web', %s)
            """,
            (close["id"], user.id, Jsonb({"gastos": close["expense_count"]})),
        )
        return close


def reopen_week(
    settings: Settings, user: UserContext, close_id: UUID, reason: str
) -> dict[str, Any]:
    with transaction(settings) as connection:
        require_active_profile(connection, user)
        if user.role is not Role.ADMIN:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Solo administración reabre semanas")
        row = connection.execute(
            """
            update public.cierre_semanal
            set estado = 'reabierto', reabierto_por = %s, reabierto_en = now(),
                motivo_reapertura = %s
            where id = %s and estado = 'cerrado'
            returning id, obra_id, anio_iso, semana_iso, estado::text as estado,
                      reabierto_en, motivo_reapertura
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
            (close_id, user.id, Jsonb({"motivo": reason})),
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
                   estado::text as estado, creado_en, preview_json
            from public.importacion_neodata
            where obra_id = %s and archivo_sha256 = %s and estado <> 'descartado'
            order by creado_en desc limit 1
            """,
            (work_id, digest),
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
              estado, preview_json, catalogo_nuevo_json
            ) values (%s, %s, %s, %s, %s, 'preview', %s, '{}'::jsonb)
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
            for field, value in correction.model_dump().items():
                if field not in {"sheet", "row"}:
                    item[field] = value

        preview["areas"] = dict(Counter(item["area"] for item in items))
        preview["area_count"] = len(preview["areas"])
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
        key = (
            normalized_text(source["area"]),
            normalized_text(source["code"]),
            normalized_text(source["description"]),
            normalized_text(source["unit"]),
            normalized_text(source["work_class"]),
            normalized_text(source.get("category")),
        )
        if key not in consolidated:
            consolidated[key] = dict(source)
            continue
        target = consolidated[key]
        target["quantity"] = str(
            Decimal(str(target["quantity"])) + Decimal(str(source["quantity"]))
        )
        target["amount"] = str(
            Decimal(str(target["amount"])) + Decimal(str(source["amount"]))
        )

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
        area_ids: dict[str, UUID] = {}
        consolidated_items = _consolidate_preview_items(preview["items"])
        for order, item in enumerate(consolidated_items):
            area_name = item["area"]
            if area_name not in area_ids:
                area = connection.execute(
                    """
                    insert into public.area (obra_id, nombre, orden)
                    values (%s, %s, %s)
                    on conflict (obra_id, nombre) do update set orden = excluded.orden
                    returning id
                    """,
                    (imported["obra_id"], area_name, order),
                ).fetchone()
                assert area is not None
                area_ids[area_name] = area["id"]
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
                    area_ids[area_name],
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
