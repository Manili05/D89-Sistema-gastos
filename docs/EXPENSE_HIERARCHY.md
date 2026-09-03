# Jerarquía semanal de gastos

Fuente analizada: `FORMATO BASE ESTIMACIONES (2).xlsx`, conservado fuera de Git.
La lectura se realizó sobre una copia y no modificó el archivo original.

La pestaña `MENU DESPLEGABLE` contiene:

- 23 partidas generales, en las columnas C:Y.
- 120 relaciones únicas partida–subpartida, en las filas 4:17.
- Tres categorías por partida: `MATERIAL`, `MANO DE OBRA` y `EQUIPO/HERR`.
- Cuatro renglones con el marcador `NOMBRE` para proveedores; no son proveedores reales.

El registro web aplica el orden dependiente:

`Obra → Área → Partida → Subpartida → Categoría → Proveedor`

Las partidas y subpartidas son el catálogo operativo para clasificar el gasto. La partida
presupuestal detallada importada desde NEODATA se conserva como referencia opcional y no se
mezcla con este catálogo. Los proveedores reales se crean de forma normalizada al registrar
el primer gasto y quedan disponibles como sugerencias posteriores.
