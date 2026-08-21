# Changelog

Todos los cambios notables de este proyecto se documentan en este archivo.

El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/),
y este proyecto usa [Versionado Semántico](https://semver.org/lang/es/).

## [Unreleased]

### Añadido

- Autocompletado de labels/valores contextual: `/api/labels` y
  `/api/label-values` aceptan un `query=<selector LogQL>` opcional que Loki
  usa para acotar el resultado a lo que realmente coexiste con los
  matchers ya rellenados en otras filas del buscador (ej. si filtras por
  `namespace="monitoring"`, el campo `pod` no sugiere pods de `logging`).
- Ese mismo autocompletado ahora también se acota al rango de tiempo
  seleccionado (como en el Explore de Grafana): si un pod murió a las
  17:00 y buscas a partir de las 18:00, no aparece en las sugerencias.
- Panel de búsqueda redimensionable arrastrando un separador entre el
  buscador y el visor (ancho persistido en `localStorage`).
- Desplegable propio para el autocompletado de labels/valores en vez del
  `<datalist>` nativo (poco fiable en Safari), y un botón para cancelar
  una búsqueda en curso.
- Límite de líneas personalizado: además de los presets (100/500/1000/2000/5000),
  una opción "Personalizado…" acepta cualquier número; ya no hay un tope
  de 5000 inventado por la app — el límite real lo impone la propia
  configuración de tu Loki.
- Exportación del ciclo de vida completo de un objeto (`⬇ Ciclo de vida
  completo`): descarga *todos* los logs del selector actual desde su
  primera hasta su última aparición conocida, con progreso real vía
  Server-Sent Events (`/api/export` + `/api/export/download`) — pensado
  solo para descargar, no para previsualizar. El progreso mostrado es la
  fracción real del rango de tiempo del objeto ya recorrida, no una
  animación simulada. Incluye además un tiempo estimado restante, también
  real (extrapolado del ritmo medido de esa descarga concreta, no una
  cuenta atrás animada).
- Mientras el panel de ciclo de vida está abierto, el autocompletado de
  labels/valores usa su propia ventana de búsqueda (7/30/90/180 días) en
  vez de las 24h del buscador principal, para que salgan pods/objetos
  antiguos que ya no están activos — antes solo aparecía el más reciente.
- Chips rápidos de rango de tiempo: añadidos 7d/15d/30d junto a los ya
  existentes 15m/1h/6h/24h/3d.
- Tooltip con el nombre completo al pasar el ratón sobre una sugerencia
  del autocompletado que aparece cortada con "…".
- Al abrir el panel de "Ciclo de vida completo", el resto de opciones de
  búsqueda (rango de tiempo, límite, orden, botón de buscar) se atenúan y
  quedan bloqueadas — esa exportación las ignora por completo, así que
  deja claro que no aplican mientras tanto.
- Panel de búsqueda reordenado (Org ID → Rango de tiempo → Labels →
  Límite y orden), ya que el autocompletado depende del rango elegido, y
  con iconos discretos por sección para un aspecto más cuidado.

### Cambiado

- El `X-Scope-OrgID` (Org ID) ya no se fija al arrancar el servidor: ahora
  se indica desde un campo en la propia interfaz web y se envía con cada
  consulta (`/api/query`, `/api/labels`, `/api/label-values`), permitiendo
  consultar distintos tenants de Loki sin reiniciar la app.
- `LOKI_ORG_ID` pasa de obligatoria a **opcional**: si se define, solo
  precarga el campo Org ID de la UI (vía el nuevo endpoint `GET /api/config`).

### Corregido

- Varios elementos (`empty-state`, `loading-state`, la fila de fechas
  personalizadas, el separador de redimensionado) no se ocultaban nunca
  realmente por un conflicto de CSS entre el atributo `hidden` y reglas
  `display` propias de cada componente.
- Paginación de `/api/export`: avanzar el cursor por nanosegundo entre
  páginas podía quedarse atascado repitiendo la última página para
  siempre contra una fuente de logs con precisión de timestamp más
  gruesa que el nanosegundo (segundo, milisegundo…). Ahora se detecta la
  página repetida y se corta la exportación de forma limpia. Cubierto
  con tests de regresión (`internal/api/export_test.go`).
- El separador de redimensionado del panel quedaba invisible e imposible
  de arrastrar con precisión: estaba posicionado fuera de la caja del
  panel de búsqueda, que lo recortaba por su `overflow-y: auto`. Ahora es
  una columna real del grid, no un elemento superpuesto.
- Hueco vertical vacío entre "Org ID" y "Rango de tiempo": el campo Org ID
  heredaba `flex: 1` de una clase pensada para compartir una fila con
  otro campo, así que absorbía todo el espacio vertical sobrante del
  panel en vez de ocupar solo su altura natural.

## [1.0.0] - 2026-08-21

### Añadido

- Backend en Go que consulta la API de Loki (`query_range`, `labels`,
  `label/{name}/values`) sin depender de librerías externas.
- Estrategia de consulta sin pipelines LogQL (`| line_format`) para evitar
  el bloqueo `403` del WAF ante payloads con `{{`; el campo `message` se
  extrae y limpia en Go a partir del JSON crudo de Loki.
- Carga de configuración vía variables de entorno (`LOKI_URL`,
  `LOKI_USER`, `LOKI_PASS`, `LOKI_ORG_ID`, `PORT`) con validación fail-fast
  al arrancar.
- Frontend en HTML/CSS/JS vanilla con modo oscuro, panel de búsqueda con
  labels dinámicos y autocompletado, selector de rango de tiempo (chips
  rápidos + fechas personalizadas), y selector de límite de líneas.
- Visor de logs tipo terminal con detección de severidad
  (`ERROR`/`WARN`/`INFO`/`DEBUG`) por color y badge, chips de filtrado
  rápido y filtro de texto libre client-side.
- Botón de descarga a `.txt` de los logs visibles (respeta filtros
  aplicados).
- Frontend embebido en el binario Go vía `go:embed` para un despliegue de
  artefacto único.
- Dockerfile multi-stage con imagen final `distroless` y `docker-compose.yml`.
- Suite de tests unitarios para el cliente de Loki (construcción de
  selector, extracción de mensajes, cabeceras, orden cronológico).

[1.0.0]: https://github.com/eloygonzalezdeiris/lokiviews/releases/tag/v1.0.0
