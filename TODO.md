# TODO

Ideas, mejoras futuras y tareas pendientes. No implica compromiso de fecha
ni prioridad estricta salvo que se indique.

## Autenticación y seguridad

- [ ] Autenticación de usuarios de la propia app (hoy cualquiera con acceso
      a la red puede usarla; las credenciales de Loki son compartidas).
- [ ] Guardar `LOKI_PASS` en un secret manager en vez de variable de
      entorno plana para despliegues productivos.
- [ ] Rate limiting en `/api/query` para evitar abuso/DoS accidental contra Loki.
- [ ] CSP headers y hardening general de las respuestas HTTP del frontend.

## Backend / API

- [ ] Streaming de resultados grandes (NDJSON o SSE) en vez de cargar todo
      el JSON en memoria antes de responder — útil para límites altos (5000+ líneas).
- [ ] Endpoint para exportar a `.json` o `.csv` además de `.txt`.
- [ ] Cache corta (TTL unos segundos) de `/api/labels` y `/api/label-values`
      para reducir carga sobre Loki en búsquedas repetidas.
- [ ] Soporte de paginación / "cargar más" en vez de un único `limit` fijo.
- [ ] Reintentos con backoff ante errores transitorios de Loki (5xx, timeouts).
- [ ] Métricas propias (Prometheus `/metrics`) de latencia y tasa de error
      hacia Loki.

## Frontend / UX

- [ ] Toggle de tema claro/oscuro (hoy solo hay dark mode).
- [ ] Guardar búsquedas frecuentes / favoritos en `localStorage`.
- [ ] Historial de las últimas N búsquedas realizadas.
- [ ] Resaltado (highlight) del término del filtro de texto libre dentro
      de cada línea, no solo el filtrado.
- [ ] Auto-refresh opcional ("tail" en vivo) con polling configurable.
- [ ] Copiar una línea de log al portapapeles con un click.
- [ ] Mostrar los labels del stream (namespace, pod, etc.) como badges
      junto a cada línea cuando la búsqueda mezcla varios streams.
- [ ] Virtualización de la lista de logs para rangos muy grandes (varios
      miles de líneas) y así mantener el scroll fluido.

## Despliegue / operaciones

- [ ] Pipeline de CI (lint + `go vet` + `go test` + build de imagen Docker).
- [ ] Publicación de la imagen Docker en un registry (GHCR/Harbor) con tags
      semánticos.
- [ ] Healthcheck de Docker (`HEALTHCHECK` en el Dockerfile) apuntando a `/api/health`.
- [ ] Manifiestos de ejemplo para Kubernetes (Deployment + Service + Secret).

## Calidad

- [ ] Tests de los handlers HTTP (`internal/api`) además de los del cliente Loki.
- [ ] Tests end-to-end del frontend (Playwright) cubriendo búsqueda,
      filtros y descarga.
