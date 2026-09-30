# Open Questions — pendientes que NO deben resolverse por supuesto silencioso

Estos puntos no bloquean el inicio del desarrollo (ver fases en `tasks.md`), pero **ningún
agente debe inventar una respuesta** — deben quedar marcados como pendientes hasta que el
usuario los resuelva explícitamente, y escalarse cuando bloqueen una tarea concreta.

## Producto
- [x] **Proceso de validación de gasto:** existe `CierreSemanal` por lote. La reapertura requiere
  motivo y genera auditoría; nunca se altera silenciosamente un cierre previo.
- [ ] **Zona horaria:** se asumió `America/Mexico_City` para los cortes de semana ISO — no
  confirmado explícitamente.
- [ ] **Moneda:** se asumió MXN único — no confirmado explícitamente si alguna obra podría
  manejar otra moneda.

## Infraestructura / DevOps
- [x] **Modelo LLM default:** Kimi K3 mediante alias LiteLLM `kimi-k3`.
- [x] **Tope de presupuesto mensual:** $1,000 MXN.
- [x] **Destino de backup externo:** Backblaze B2, cifrado, 14 días de retención y prueba mensual.
- [ ] **Estatus de la cuenta de WhatsApp Business/Meta** — quién la está tramitando y en qué fase
  de aprobación va (bloquea pruebas reales de `whatsapp-agent`, no el desarrollo en sandbox).
- [x] **Repositorio Git:** `Manili05/D89-Sistema-gastos` en GitHub.
- [x] **Entorno de staging:** este VPS queda dedicado a desarrollo/staging de D89.
- [ ] **Migración de infraestructura EscalaLeads → D89** — plan y fecha para mover dominio/VPS a
  nombre del cliente antes de la entrega final (ver `docs/CHANGE_LOG.md` Cambio 4).

## Agente de WhatsApp (Hermes Agent)
- [x] **Capacidades actuales:** exactamente diez tools de negocio descritas en `plan.md`.
  La ampliación futura se gobierna por `docs/HERMES_CAPABILITY_ROADMAP.md`; no se habilitan tools
  generales por defecto.
- [x] **Autenticación servicio-a-servicio:** HMAC-SHA256 sobre método, ruta, timestamp, nonce y
  hash del cuerpo, con ventana temporal y prevención de replay.

---
*Cuando se resuelva un punto, muévelo (con la respuesta) a `docs/CHANGE_LOG.md` si implica una
desviación de alcance, o simplemente táchalo aquí si era solo una confirmación operativa.*
