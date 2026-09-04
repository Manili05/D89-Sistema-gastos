from decimal import Decimal
from typing import Any
from uuid import UUID

import psycopg
from fastapi import HTTPException, status
from psycopg.types.json import Jsonb

from app.core.config import Settings
from app.models import (
    Role,
    SupplierArchive,
    SupplierCreate,
    SupplierEvaluationCreate,
    SupplierEvaluationUpdate,
    SupplierSpecialtyCreate,
    SupplierSpecialtyUpdate,
    SupplierUpdate,
    UserContext,
    WorkSupplierAssignment,
)
from app.services.repository import require_active_profile, require_work_access, transaction


def _audit(
    connection: psycopg.Connection[dict[str, Any]],
    user: UserContext,
    entity: str,
    entity_id: UUID,
    action: str,
    detail: dict[str, Any],
) -> None:
    connection.execute(
        """
        insert into public.audit_log_negocio
          (entidad, entidad_id, accion, usuario_id, canal, detalle_json)
        values (%s, %s, %s, %s, 'web', %s)
        """,
        (entity, entity_id, action, user.id, Jsonb(detail)),
    )


def _require_admin(connection: psycopg.Connection[dict[str, Any]], user: UserContext) -> None:
    require_active_profile(connection, user)
    if user.role is not Role.ADMIN:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Solo administración gestiona proveedores")


def _set_specialties(
    connection: psycopg.Connection[dict[str, Any]],
    supplier_id: UUID,
    specialty_ids: list[UUID],
    user: UserContext,
) -> None:
    if specialty_ids:
        count = connection.execute(
            """select count(*) as total
               from public.catalogo_especialidad_proveedor
               where id = any(%s) and activo""",
            (specialty_ids,),
        ).fetchone()
        if count is None or count["total"] != len(specialty_ids):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, "Especialidad inválida o inactiva"
            )
    connection.execute(
        "delete from public.proveedor_especialidad where proveedor_id = %s", (supplier_id,)
    )
    for specialty_id in specialty_ids:
        connection.execute(
            """insert into public.proveedor_especialidad
                 (proveedor_id, especialidad_id, creado_por) values (%s, %s, %s)""",
            (supplier_id, specialty_id, user.id),
        )


def _supplier_select() -> str:
    return """
        select p.id, p.nombre, p.razon_social, p.rfc, p.contacto,
               p.telefono, p.whatsapp, p.email, p.direccion, p.cobertura,
               p.notas, p.activo, p.creado_en, p.actualizado_en, p.archivado_en,
               coalesce(sp.specialties, '[]'::jsonb) as specialties,
               coalesce(ev.evaluation_count, 0) as evaluation_count,
               ev.rating, ev.quality, ev.timeliness, ev.value,
               ev.communication, ev.safety, ev.last_service_date,
               coalesce(wo.work_count, 0) as work_count,
               coalesce(gs.expense_count, 0) as expense_count,
               coalesce(gs.validated_spend, 0) as validated_spend
        from public.catalogo_proveedor p
        left join lateral (
          select jsonb_agg(jsonb_build_object('id', ce.id, 'nombre', ce.nombre)
                   order by ce.nombre) as specialties
          from public.proveedor_especialidad pe
          join public.catalogo_especialidad_proveedor ce
            on ce.id = pe.especialidad_id and ce.activo
          where pe.proveedor_id = p.id
        ) sp on true
        left join lateral (
          select count(*) as evaluation_count,
                 round(avg(e.calificacion), 2) as rating,
                 round(avg(e.calidad), 2) as quality,
                 round(avg(e.cumplimiento), 2) as timeliness,
                 round(avg(e.costo_valor), 2) as value,
                 round(avg(e.comunicacion), 2) as communication,
                 round(avg(e.seguridad_orden), 2) as safety,
                 max(e.fecha_servicio) as last_service_date
          from public.evaluacion_proveedor e
          where e.proveedor_id = p.id and e.vigente
        ) ev on true
        left join lateral (
          select count(*) filter (where op.activo) as work_count
          from public.obra_proveedor op where op.proveedor_id = p.id
        ) wo on true
        left join lateral (
          select count(*) filter (where g.eliminado_en is null) as expense_count,
                 coalesce(sum(g.importe) filter (
                   where g.eliminado_en is null and g.estado = 'validado'), 0) as validated_spend
          from public.gasto g where g.proveedor_id = p.id
        ) gs on true
    """


def list_supplier_specialties(
    settings: Settings, user: UserContext, include_inactive: bool = False
) -> list[dict[str, Any]]:
    with transaction(settings) as connection:
        require_active_profile(connection, user)
        rows = connection.execute(
            """
            select ce.id, ce.nombre, ce.activo,
                   count(pe.proveedor_id) filter (where p.activo) as supplier_count
            from public.catalogo_especialidad_proveedor ce
            left join public.proveedor_especialidad pe on pe.especialidad_id = ce.id
            left join public.catalogo_proveedor p on p.id = pe.proveedor_id
            where ce.activo or %s
            group by ce.id order by ce.nombre
            """,
            (include_inactive and user.role is Role.ADMIN,),
        ).fetchall()
        return list(rows)


def create_supplier_specialty(
    settings: Settings, user: UserContext, payload: SupplierSpecialtyCreate
) -> dict[str, Any]:
    with transaction(settings) as connection:
        _require_admin(connection, user)
        existing = connection.execute(
            """select id from public.catalogo_especialidad_proveedor
               where nombre_normalizado = public.normalizar_texto(%s)""",
            (payload.name,),
        ).fetchone()
        if existing:
            raise HTTPException(status.HTTP_409_CONFLICT, "La especialidad ya existe")
        row = connection.execute(
            """insert into public.catalogo_especialidad_proveedor (nombre, creado_por)
               values (%s, %s) returning id, nombre, activo""",
            (payload.name, user.id),
        ).fetchone()
        assert row is not None
        _audit(
            connection, user, "especialidad_proveedor", row["id"], "crear", {"nombre": payload.name}
        )
        return row


def update_supplier_specialty(
    settings: Settings, user: UserContext, specialty_id: UUID, payload: SupplierSpecialtyUpdate
) -> dict[str, Any]:
    with transaction(settings) as connection:
        _require_admin(connection, user)
        duplicate = connection.execute(
            """select id from public.catalogo_especialidad_proveedor
               where nombre_normalizado = public.normalizar_texto(%s) and id <> %s""",
            (payload.name, specialty_id),
        ).fetchone()
        if duplicate:
            raise HTTPException(status.HTTP_409_CONFLICT, "La especialidad ya existe")
        row = connection.execute(
            """update public.catalogo_especialidad_proveedor
               set nombre = %s, activo = %s, actualizado_por = %s, actualizado_en = now()
               where id = %s returning id, nombre, activo""",
            (payload.name, payload.active, user.id, specialty_id),
        ).fetchone()
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Especialidad inexistente")
        _audit(
            connection, user, "especialidad_proveedor", specialty_id, "editar", payload.model_dump()
        )
        return row


def list_suppliers(
    settings: Settings,
    user: UserContext,
    *,
    query: str | None = None,
    specialty_id: UUID | None = None,
    min_rating: Decimal | None = None,
    active: bool | None = True,
    work_id: UUID | None = None,
    sort: str = "name",
    page: int = 1,
    page_size: int = 25,
) -> dict[str, Any]:
    with transaction(settings) as connection:
        require_active_profile(connection, user)
        order = {
            "name": "p.nombre asc",
            "rating": "ev.rating desc nulls last, p.nombre asc",
            "jobs": "ev.evaluation_count desc, p.nombre asc",
            "spend": "gs.validated_spend desc, p.nombre asc",
        }.get(sort, "p.nombre asc")
        if user.role is not Role.ADMIN and sort == "spend":
            order = "p.nombre asc"
        sql = (
            _supplier_select()
            + f"""
          where (%s::boolean is null or p.activo = %s::boolean)
            and (%s::text is null or public.normalizar_texto(
              concat_ws(' ', p.nombre, p.razon_social, p.rfc, p.contacto, p.email)
            ) like '%%' || public.normalizar_texto(%s::text) || '%%')
            and (%s::uuid is null or exists (
              select 1 from public.proveedor_especialidad pef
              where pef.proveedor_id = p.id and pef.especialidad_id = %s::uuid
            ))
            and (%s::numeric is null or coalesce(ev.rating, 0) >= %s::numeric)
            and (%s::uuid is null or exists (
              select 1 from public.obra_proveedor opf
              where opf.proveedor_id = p.id and opf.obra_id = %s::uuid and opf.activo
            ))
          order by {order}
          limit %s offset %s
        """
        )
        values = (
            active,
            active,
            query,
            query,
            specialty_id,
            specialty_id,
            min_rating,
            min_rating,
            work_id,
            work_id,
            page_size,
            (page - 1) * page_size,
        )
        rows = list(connection.execute(sql, values).fetchall())
        total = connection.execute(
            """
            select count(*) as total from public.catalogo_proveedor p
            where (%s::boolean is null or p.activo = %s::boolean)
              and (%s::text is null or public.normalizar_texto(
                concat_ws(' ', p.nombre, p.razon_social, p.rfc, p.contacto, p.email)
              ) like '%%' || public.normalizar_texto(%s::text) || '%%')
              and (%s::uuid is null or exists (
                select 1 from public.proveedor_especialidad pef
                where pef.proveedor_id = p.id and pef.especialidad_id = %s::uuid
              ))
              and (%s::numeric is null or coalesce((
                select avg(e.calificacion) from public.evaluacion_proveedor e
                where e.proveedor_id = p.id and e.vigente
              ), 0) >= %s::numeric)
              and (%s::uuid is null or exists (
                select 1 from public.obra_proveedor opf
                where opf.proveedor_id = p.id and opf.obra_id = %s::uuid and opf.activo
              ))
            """,
            values[:10],
        ).fetchone()
        if user.role is not Role.ADMIN:
            for row in rows:
                row["validated_spend"] = None
                row["expense_count"] = None
        return {
            "items": rows,
            "total": total["total"] if total else 0,
            "page": page,
            "page_size": page_size,
            "permissions": {"can_manage": user.role is Role.ADMIN},
        }


def get_supplier(settings: Settings, user: UserContext, supplier_id: UUID) -> dict[str, Any]:
    with transaction(settings) as connection:
        require_active_profile(connection, user)
        supplier = connection.execute(
            _supplier_select() + " where p.id = %s", (supplier_id,)
        ).fetchone()
        if supplier is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Proveedor inexistente")
        assignments = connection.execute(
            """
            select op.id, op.obra_id, o.nombre as obra, op.notas, op.activo,
                   op.asignado_en, op.desasignado_en
            from public.obra_proveedor op join public.obra o on o.id = op.obra_id
            where op.proveedor_id = %s and (
              %s = 'admin' or exists (
                select 1 from public.usuario_obra uo
                where uo.obra_id = op.obra_id and uo.usuario_id = %s
              )
            ) order by op.activo desc, o.nombre
            """,
            (supplier_id, user.role.value, user.id),
        ).fetchall()
        evaluations = connection.execute(
            """
            select e.id, e.obra_id, e.obra_nombre, e.gasto_id, e.trabajo,
                   e.fecha_servicio, e.calidad, e.cumplimiento, e.costo_valor,
                   e.comunicacion, e.seguridad_orden, e.calificacion, e.comentario,
                   e.vigente, e.creado_en, e.actualizado_en, e.motivo_anulacion,
                   coalesce(pu.nombre, 'Administrador') as autor,
                   g.concepto as gasto_concepto
            from public.evaluacion_proveedor e
            left join public.perfil_usuario pu on pu.id = e.creado_por
            left join public.gasto g on g.id = e.gasto_id
            where e.proveedor_id = %s and (e.vigente or %s = 'admin')
            order by e.fecha_servicio desc, e.creado_en desc
            """,
            (supplier_id, user.role.value),
        ).fetchall()
        expenses = []
        if user.role is Role.ADMIN:
            expenses = list(
                connection.execute(
                    """
                select g.id, g.obra_id, o.nombre as obra, g.fecha, g.concepto,
                       g.folio, g.importe, g.estado::text as estado
                from public.gasto g join public.obra o on o.id = g.obra_id
                where g.proveedor_id = %s and g.eliminado_en is null
                order by g.fecha desc limit 100
                """,
                    (supplier_id,),
                ).fetchall()
            )
        if user.role is not Role.ADMIN:
            supplier["validated_spend"] = None
            supplier["expense_count"] = None
        supplier["assignments"] = list(assignments)
        supplier["evaluations"] = list(evaluations)
        supplier["expenses"] = expenses
        supplier["permissions"] = {"can_manage": user.role is Role.ADMIN}
        return supplier


def _check_supplier_duplicate(
    connection: psycopg.Connection[dict[str, Any]],
    name: str,
    tax_id: str | None,
    exclude_id: UUID | None = None,
) -> None:
    row = connection.execute(
        """
        select id from public.catalogo_proveedor
        where (%s::uuid is null or id <> %s::uuid) and (
          nombre_normalizado = public.normalizar_texto(%s::text)
          or (%s::text is not null and rfc is not null and
              upper(regexp_replace(rfc, '[^A-Za-z0-9]', '', 'g')) = %s::text)
        ) limit 1
        """,
        (exclude_id, exclude_id, name, tax_id, tax_id),
    ).fetchone()
    if row:
        raise HTTPException(status.HTTP_409_CONFLICT, "Ya existe un proveedor con ese nombre o RFC")


def create_supplier(
    settings: Settings, user: UserContext, payload: SupplierCreate
) -> dict[str, Any]:
    with transaction(settings) as connection:
        _require_admin(connection, user)
        _check_supplier_duplicate(connection, payload.name, payload.tax_id)
        row = connection.execute(
            """
            insert into public.catalogo_proveedor
              (nombre, razon_social, rfc, contacto, telefono, whatsapp, email,
               direccion, cobertura, notas, creado_por, actualizado_por)
            values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            returning id, nombre, activo
            """,
            (
                payload.name,
                payload.legal_name,
                payload.tax_id,
                payload.contact_name,
                payload.phone,
                payload.whatsapp,
                payload.email,
                payload.address,
                payload.coverage,
                payload.notes,
                user.id,
                user.id,
            ),
        ).fetchone()
        assert row is not None
        _set_specialties(connection, row["id"], payload.specialty_ids, user)
        _audit(
            connection,
            user,
            "proveedor",
            row["id"],
            "crear",
            {
                "nombre": payload.name,
                "especialidades": [str(value) for value in payload.specialty_ids],
            },
        )
        return row


def update_supplier(
    settings: Settings, user: UserContext, supplier_id: UUID, payload: SupplierUpdate
) -> dict[str, Any]:
    with transaction(settings) as connection:
        _require_admin(connection, user)
        _check_supplier_duplicate(connection, payload.name, payload.tax_id, supplier_id)
        row = connection.execute(
            """
            update public.catalogo_proveedor set
              nombre = %s, razon_social = %s, rfc = %s, contacto = %s,
              telefono = %s, whatsapp = %s, email = %s, direccion = %s,
              cobertura = %s, notas = %s, actualizado_por = %s, actualizado_en = now()
            where id = %s returning id, nombre, activo
            """,
            (
                payload.name,
                payload.legal_name,
                payload.tax_id,
                payload.contact_name,
                payload.phone,
                payload.whatsapp,
                payload.email,
                payload.address,
                payload.coverage,
                payload.notes,
                user.id,
                supplier_id,
            ),
        ).fetchone()
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Proveedor inexistente")
        _set_specialties(connection, supplier_id, payload.specialty_ids, user)
        _audit(
            connection,
            user,
            "proveedor",
            supplier_id,
            "editar",
            {
                "nombre": payload.name,
                "especialidades": [str(value) for value in payload.specialty_ids],
            },
        )
        return row


def archive_supplier(
    settings: Settings, user: UserContext, supplier_id: UUID, payload: SupplierArchive
) -> dict[str, Any]:
    with transaction(settings) as connection:
        _require_admin(connection, user)
        row = connection.execute(
            """update public.catalogo_proveedor set activo = false,
                 archivado_por = %s, archivado_en = now(), actualizado_por = %s,
                 actualizado_en = now() where id = %s and activo
                 returning id, nombre, activo, archivado_en""",
            (user.id, user.id, supplier_id),
        ).fetchone()
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Proveedor activo inexistente")
        connection.execute(
            """update public.obra_proveedor set activo = false, desasignado_por = %s,
                 desasignado_en = now() where proveedor_id = %s and activo""",
            (user.id, supplier_id),
        )
        _audit(connection, user, "proveedor", supplier_id, "archivar", {"motivo": payload.reason})
        return row


def restore_supplier(settings: Settings, user: UserContext, supplier_id: UUID) -> dict[str, Any]:
    with transaction(settings) as connection:
        _require_admin(connection, user)
        row = connection.execute(
            """update public.catalogo_proveedor set activo = true, archivado_por = null,
                 archivado_en = null, actualizado_por = %s, actualizado_en = now()
                 where id = %s and not activo returning id, nombre, activo""",
            (user.id, supplier_id),
        ).fetchone()
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Proveedor archivado inexistente")
        _audit(connection, user, "proveedor", supplier_id, "reactivar", {})
        return row


def assign_supplier_to_work(
    settings: Settings,
    user: UserContext,
    supplier_id: UUID,
    work_id: UUID,
    payload: WorkSupplierAssignment,
) -> dict[str, Any]:
    with transaction(settings) as connection:
        _require_admin(connection, user)
        require_work_access(connection, user, work_id)
        supplier = connection.execute(
            "select id from public.catalogo_proveedor where id = %s and activo", (supplier_id,)
        ).fetchone()
        if supplier is None:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, "Proveedor inactivo o inexistente"
            )
        row = connection.execute(
            """
            insert into public.obra_proveedor
              (obra_id, proveedor_id, notas, asignado_por)
            values (%s, %s, %s, %s)
            on conflict (obra_id, proveedor_id) do update set
              notas = excluded.notas, activo = true, asignado_por = excluded.asignado_por,
              asignado_en = now(), desasignado_por = null, desasignado_en = null
            returning id, obra_id, proveedor_id, notas, activo, asignado_en
            """,
            (work_id, supplier_id, payload.notes, user.id),
        ).fetchone()
        assert row is not None
        _audit(
            connection, user, "proveedor", supplier_id, "asignar_obra", {"obra_id": str(work_id)}
        )
        return row


def unassign_supplier_from_work(
    settings: Settings, user: UserContext, supplier_id: UUID, work_id: UUID
) -> dict[str, Any]:
    with transaction(settings) as connection:
        _require_admin(connection, user)
        require_work_access(connection, user, work_id)
        row = connection.execute(
            """update public.obra_proveedor set activo = false, desasignado_por = %s,
                 desasignado_en = now() where obra_id = %s and proveedor_id = %s and activo
                 returning id, obra_id, proveedor_id, activo, desasignado_en""",
            (user.id, work_id, supplier_id),
        ).fetchone()
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Asignación activa inexistente")
        _audit(
            connection, user, "proveedor", supplier_id, "desasignar_obra", {"obra_id": str(work_id)}
        )
        return row


def _validate_evaluation_links(
    connection: psycopg.Connection[dict[str, Any]],
    supplier_id: UUID,
    payload: SupplierEvaluationCreate | SupplierEvaluationUpdate,
) -> str:
    work = connection.execute(
        "select nombre from public.obra where id = %s", (payload.work_id,)
    ).fetchone()
    if work is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Obra inexistente")
    assignment = connection.execute(
        """select 1 from public.obra_proveedor where obra_id = %s
           and proveedor_id = %s and activo""",
        (payload.work_id, supplier_id),
    ).fetchone()
    if assignment is None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "El proveedor no está asignado a la obra"
        )
    if payload.expense_id:
        expense = connection.execute(
            """select 1 from public.gasto where id = %s and obra_id = %s
               and proveedor_id = %s and eliminado_en is null""",
            (payload.expense_id, payload.work_id, supplier_id),
        ).fetchone()
        if expense is None:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, "El gasto no corresponde al proveedor y obra"
            )
    return str(work["nombre"])


def create_supplier_evaluation(
    settings: Settings,
    user: UserContext,
    supplier_id: UUID,
    payload: SupplierEvaluationCreate,
) -> dict[str, Any]:
    with transaction(settings) as connection:
        _require_admin(connection, user)
        work_name = _validate_evaluation_links(connection, supplier_id, payload)
        row = connection.execute(
            """
            insert into public.evaluacion_proveedor
              (proveedor_id, obra_id, obra_nombre, gasto_id, trabajo, fecha_servicio,
               calidad, cumplimiento, costo_valor, comunicacion, seguridad_orden,
               comentario, creado_por, actualizado_por)
            values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            returning id, proveedor_id, obra_id, obra_nombre, gasto_id, trabajo,
                      fecha_servicio, calidad, cumplimiento, costo_valor, comunicacion,
                      seguridad_orden, calificacion, comentario, vigente, creado_en
            """,
            (
                supplier_id,
                payload.work_id,
                work_name,
                payload.expense_id,
                payload.work_description,
                payload.service_date,
                payload.quality,
                payload.timeliness,
                payload.value,
                payload.communication,
                payload.safety,
                payload.comment,
                user.id,
                user.id,
            ),
        ).fetchone()
        assert row is not None
        _audit(
            connection,
            user,
            "evaluacion_proveedor",
            row["id"],
            "crear",
            {
                "proveedor_id": str(supplier_id),
                "calificacion": str(row["calificacion"]),
            },
        )
        return row


def update_supplier_evaluation(
    settings: Settings,
    user: UserContext,
    supplier_id: UUID,
    evaluation_id: UUID,
    payload: SupplierEvaluationUpdate,
) -> dict[str, Any]:
    with transaction(settings) as connection:
        _require_admin(connection, user)
        work_name = _validate_evaluation_links(connection, supplier_id, payload)
        row = connection.execute(
            """
            update public.evaluacion_proveedor set obra_id = %s, obra_nombre = %s,
              gasto_id = %s, trabajo = %s, fecha_servicio = %s, calidad = %s,
              cumplimiento = %s, costo_valor = %s, comunicacion = %s,
              seguridad_orden = %s, comentario = %s, actualizado_por = %s,
              actualizado_en = now()
            where id = %s and proveedor_id = %s and vigente
            returning id, proveedor_id, obra_id, obra_nombre, gasto_id, trabajo,
                      fecha_servicio, calidad, cumplimiento, costo_valor, comunicacion,
                      seguridad_orden, calificacion, comentario, vigente, actualizado_en
            """,
            (
                payload.work_id,
                work_name,
                payload.expense_id,
                payload.work_description,
                payload.service_date,
                payload.quality,
                payload.timeliness,
                payload.value,
                payload.communication,
                payload.safety,
                payload.comment,
                user.id,
                evaluation_id,
                supplier_id,
            ),
        ).fetchone()
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Evaluación vigente inexistente")
        _audit(
            connection,
            user,
            "evaluacion_proveedor",
            evaluation_id,
            "editar",
            {
                "calificacion": str(row["calificacion"]),
            },
        )
        return row


def void_supplier_evaluation(
    settings: Settings,
    user: UserContext,
    supplier_id: UUID,
    evaluation_id: UUID,
    reason: str,
) -> dict[str, Any]:
    with transaction(settings) as connection:
        _require_admin(connection, user)
        row = connection.execute(
            """update public.evaluacion_proveedor set vigente = false, anulado_por = %s,
                 anulado_en = now(), motivo_anulacion = %s, actualizado_por = %s,
                 actualizado_en = now() where id = %s and proveedor_id = %s and vigente
                 returning id, vigente, anulado_en""",
            (user.id, reason, user.id, evaluation_id, supplier_id),
        ).fetchone()
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Evaluación vigente inexistente")
        _audit(
            connection, user, "evaluacion_proveedor", evaluation_id, "anular", {"motivo": reason}
        )
        return row


def supplier_analytics(settings: Settings, user: UserContext) -> dict[str, Any]:
    with transaction(settings) as connection:
        require_active_profile(connection, user)
        summary = connection.execute(
            """
            select count(*) filter (where activo) as active_suppliers,
                   count(*) filter (where not activo) as archived_suppliers,
                   (select count(*) from public.evaluacion_proveedor where vigente) as evaluations,
                   (select round(avg(calificacion), 2)
                      from public.evaluacion_proveedor where vigente) as average_rating
            from public.catalogo_proveedor
            """
        ).fetchone()
        specialties = connection.execute(
            """
            select ce.id, ce.nombre, count(distinct p.id) as supplier_count
            from public.catalogo_especialidad_proveedor ce
            left join public.proveedor_especialidad pe on pe.especialidad_id = ce.id
            left join public.catalogo_proveedor p on p.id = pe.proveedor_id and p.activo
            where ce.activo group by ce.id order by supplier_count desc, ce.nombre
            """
        ).fetchall()
        return {
            "summary": summary,
            "specialties": list(specialties),
            "permissions": {"can_view_financials": user.role is Role.ADMIN},
        }
