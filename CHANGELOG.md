# Changelog

Todos los cambios notables de este proyecto se documentan en este archivo.

El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/),
y este proyecto usa [Versionado Semántico](https://semver.org/lang/es/).

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
