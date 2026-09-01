---
description: Ejecuta una fase de tasks.md delegando a los sub-agentes correspondientes
argument-hint: [número de fase: 0, 1, 2, 3, 4 o 5]
---

Lee `specs/001-control-gastos-obra/tasks.md` y localiza la Fase $ARGUMENTS.

1. Confirma que las dependencias de esa fase (fases anteriores) están completas.
2. Revisa `docs/OPEN_QUESTIONS.md` — si algún pendiente bloquea una tarea de esta fase, detente y
   pregunta al usuario antes de continuar con esa tarea específica (el resto de la fase puede
   avanzar si no depende de ese pendiente).
3. Delega cada tarea al sub-agente indicado, en el orden de dependencias señalado.
4. Al recibir cada entrega, delega la revisión a `qa-agent` antes de continuar con la siguiente
   tarea que dependa de ella.
5. Al cerrar la fase, resume en texto plano: qué se construyó, qué quedó pendiente/bloqueado, y
   qué necesita el usuario o el cliente para la siguiente fase.
