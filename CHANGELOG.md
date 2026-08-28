# Changelog

Todos los cambios notables de este proyecto se documentan en este archivo.

El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/),
y este proyecto usa [Versionado Semántico](https://semver.org/lang/es/).

## [Unreleased]

### Añadido

- Selector global de zona horaria en la cabecera (estilo Grafana):
  Navegador (local), UTC, o cualquier zona IANA. Afecta a los timestamps
  mostrados en cada línea de log, al rango mostrado en el panel de
  resultados, y a la interpretación de los campos "Desde"/"Hasta" y
  "Comenzar desde" — todo se muestra e introduce en la zona elegida en
  vez de asumir siempre la del navegador. Se recuerda entre sesiones
  (`localStorage`) y, al cambiar de zona, tanto los datos ya mostrados
  como los campos de fecha ya rellenados se recalculan sin perder el
  instante real seleccionado. Implementado sin dependencias nuevas,
  apoyándose solo en `Intl.DateTimeFormat`.

## [1.1.0] - 2026-08-26

### Añadido

- Nuevo modo de búsqueda **Directo**, junto a Rápido/Personalizado: hace
  tail en vivo del selector de labels elegido (nunca de todo el tenant),
  con auto-scroll que se pausa solo al desplazarse hacia atrás a leer
  histórico (con botón flotante "Volver al directo" para retomarlo, y un
  interruptor propio "Auto-scroll activo/pausado" para activarlo o
  desactivarlo a voluntad sin depender de la posición del scroll), scroll
  infinito hacia atrás sin límite de líneas fijo, y una sub-opción
  "Comenzar desde" para arrancar el directo en un instante concreto en
  vez de siempre desde "ahora". Backend nuevo: `GET /api/live`
  (`internal/api/live.go`), que hace polling de baja frecuencia (5s) sobre
  el `query_range` ya existente y retransmite solo las líneas nuevas por
  Server-Sent Events — se descartó el `tail` nativo de Loki por WebSocket
  para no añadir la primera dependencia externa del proyecto (`go.mod`
  sigue sin ninguna). El histórico hacia atrás no usa endpoint nuevo:
  reutiliza `POST /api/query` con `direction=backward`, igual que el modo
  Personalizado. El directo vive enteramente atado a la conexión SSE
  abierta desde el navegador: no hay ningún estado ni búfer en el
  servidor, así que cerrar la pestaña o cambiar de modo lo termina sin
  dejar nada corriendo de fondo.

- Pipeline de CI en GitHub Actions (`.github/workflows/ci.yml`): en cada
  push/PR corre `golangci-lint`, `go vet`, comprueba formateo con
  `gofmt`, `go test -race ./...`, y construye la imagen Docker (sin
  publicarla) para detectar roturas del `Dockerfile` pronto.
- Workflow de release (`.github/workflows/release.yml`): al hacer push de
  un tag semántico (`vX.Y.Z`) construye y publica la imagen en GHCR
  (`ghcr.io/aelogonpin/logwebui`) con tags `X.Y.Z`/`X.Y`/`X`/`latest`.
- `HEALTHCHECK` en el `Dockerfile`. Como la imagen final es `distroless`
  (sin shell ni `curl`/`wget`), no se puede hacer con el patrón habitual
  de `CMD curl -f ...`; en su lugar, el propio binario sabe comprobarse a
  sí mismo (`lokiviews -healthcheck`, forma exec, sin necesitar shell) —
  hace un `GET /api/health` contra `127.0.0.1:$PORT` y termina con
  código `0`/`1`.
- Manifiestos de ejemplo para Kubernetes (`deploy/k8s/`): Deployment,
  Service y una plantilla de Secret, con `readOnlyRootFilesystem: true` +
  un `emptyDir` en `/tmp` (necesario porque la exportación de ciclo de
  vida completo escribe ahí su fichero temporal), y `livenessProbe`/
  `readinessProbe` contra `/api/health`.
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
- Autodescubrimiento opcional de Org IDs: si se configura `MIMIR_URL`
  (además de `MIMIR_USER`/`MIMIR_PASS` y, si aplica, `MIMIR_ORG_ID`),
  aparece un botón "Descubrir tenants" junto al campo Org ID que consulta
  a Mimir el label `tenant` de las métricas propias de Loki
  (`loki_distributor_bytes_received_total`) y ofrece los resultados como
  desplegable — sin dejar de poder escribir un Org ID a mano. Sin
  `MIMIR_URL` la función no existe: el botón ni se muestra y
  `/api/tenants` responde `404`. Loki no tiene una API para listar sus
  propios tenants; esta es la única vía indirecta real (leer sus métricas
  de vuelta desde el sistema de monitorización). Sin `MIMIR_URL`, el
  desplegable de sugerencias del campo Org ID tampoco se conecta en
  absoluto (ni siquiera se crea en el DOM) — antes se enganchaba siempre,
  así que un `MIMIR_URL` sin configurar aún así mostraba un desplegable
  vacío ("Sin coincidencias") al hacer foco en el campo, una pista visual
  innecesaria de que existe esta lógica aunque esté apagada.

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
- El botón "Descubrir tenants" quedaba tapado por el propio desplegable
  de sugerencias del campo Org ID: como el desplegable es `position:
  absolute` (fuera del flujo normal), el botón que iba justo después en
  el HTML terminaba posicionándose en el mismo sitio donde arranca el
  desplegable, así que un clic que visualmente parecía "fuera" de la
  lista en realidad caía sobre un ítem oculto detrás y seleccionaba un
  tenant al azar. Solucionado moviendo el botón (y el texto de error)
  **antes** del campo en el HTML, para que el desplegable —que solo
  crece hacia abajo— nunca pueda solaparlo.
- Ese mismo reordenamiento introdujo otro bug: la `<label>` que envuelve
  el campo Org ID (sin `for` explícito) pasó a asociarse implícitamente
  con el **botón** "Descubrir tenants" en vez de con el input, por ser
  ahora el primer elemento "labelable" dentro de ella — así que un clic
  en el texto de ayuda o en cualquier hueco de la label (no directamente
  sobre el input) disparaba el botón oculto en vez de enfocar el campo.
  Arreglado con `for="orgIdInput"` explícito en la label.
- El Org ID podía quedar con un valor de una sesión anterior tras
  recargar la página, incluso sin `LOKI_ORG_ID` configurado: el
  navegador restaura por su cuenta el último valor escrito en un campo
  de texto al recargar, y el JS solo sobrescribía ese campo cuando el
  servidor sí tenía un valor por defecto que precargar. Ahora se limpia
  siempre, explícitamente, tanto antes de preguntar al servidor como al
  recibir su respuesta.

### Corregido

- Modo Directo: el cursor de sondeo podía adelantarse a "ahora mismo" en
  un ciclo sin líneas nuevas, así que una línea que tardara unos segundos
  en quedar indexada en Loki (lag normal de shippers como
  Promtail/Fluent Bit/Vector, que agrupan líneas antes de enviarlas)
  quedaba con un timestamp anterior al nuevo cursor y se perdía para
  siempre. Ahora el cursor nunca avanza más allá de 10s por detrás del
  tiempo real, dando margen a que la ingesta termine de asentarse antes
  de darla por "ya vista".

## [1.0.0] - 2026-08-21

### Añadido

- Backend en Go que consulta la API de Loki (`query_range`, `labels`,
  `label/{name}/values`) sin depender de librerías externas.
- Estrategia de consulta sin pipelines LogQL (`| line_format`) para evitar
  el bloqueo típico de un WAF ante payloads con `{{` (protección genérica
  contra SSTI); el campo `message` se extrae y limpia en Go a partir del
  JSON crudo de Loki.
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

[1.1.0]: https://github.com/aelogonpin/logwebui/releases/tag/v1.1.0
[1.0.0]: https://github.com/eloygonzalezdeiris/lokiviews/releases/tag/v1.0.0
