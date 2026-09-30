# Evidencia de validación NEODATA

Fecha de validación: 2026-08-28.

El libro real se conserva fuera de Git y se prueba mediante la ruta externa
esperada por `apps/api/tests/test_neodata.py`. La prueba de regresión usa el
parser de producción y valida los siguientes invariantes:

| Métrica | Resultado |
| --- | ---: |
| Hojas | 1 |
| Filas | 1,154 |
| Áreas | 3 |
| Partidas Oficina | 81 |
| Partidas Comedor | 65 |
| Partidas Baños | 86 |
| Partidas totales | 232 |
| Totales de sección | 40 |
| Total sin IVA | 2,624,832.8848544 |
| Descuadres | 0 |

Se detectan 25 códigos repetidos que no son colisiones: la identidad se
resuelve mediante código, descripción normalizada, unidad, clase y categoría.
La suite también cubre libro corrupto, extensión incorrecta, macros, enlaces
externos, límite de tamaño, continuidad de descripción y preservación de
totales. El flujo permanece en preview hasta una confirmación explícita.

