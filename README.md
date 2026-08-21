# LokiViews — Log Downloader & Viewer

Interfaz web moderna para consultar, visualizar y descargar logs de un
servidor [Loki](https://grafana.com/oss/loki/) en texto plano (`.txt`).

Backend en Go (sin dependencias externas, binario único gracias a
`go:embed`), frontend en HTML/CSS/JS vanilla con modo oscuro pensado para
leer logs cómodamente.

## Por qué el backend nunca usa `line_format`

El Loki de este proyecto está detrás de un Nginx (WAF) que bloquea con
`403` cualquier petición que contenga `{{` — protección genérica contra
Server-Side Template Injection. La sintaxis de `| line_format` en LogQL usa
exactamente ese token, así que cualquier pipeline de formateo dispara el
bloqueo.

Para evitarlo, el backend **nunca** construye pipelines LogQL: solo envía
un *stream selector* plano (`{namespace="clarel-pro", pod=~"api-.*"}`) a
`query_range`. Loki devuelve el JSON "sucio" tal cual, y es Go quien
extrae el campo `message` (o `msg`/`log`, si el log es JSON estructurado) y
lo entrega ya limpio al frontend. Ver `internal/loki/client.go`.

## Arquitectura

```
lokiviews/
├── cmd/server/main.go       # entrypoint: carga config, arranca el servidor HTTP
├── assets.go                 # embed del frontend (web/) en el binario
├── internal/
│   ├── config/                # lectura y validación de variables de entorno
│   ├── loki/                  # cliente HTTP de Loki (selector, parseo, limpieza)
│   └── api/                   # handlers y router HTTP
├── web/
│   ├── index.html
│   └── static/
│       ├── css/style.css      # UI en dark mode, sin frameworks externos
│       └── js/app.js          # buscador, severidad, filtros, descarga .txt
├── Dockerfile                 # build multi-stage → imagen distroless
├── docker-compose.yml
└── .env.example
```

El frontend se sirve embebido en el propio binario Go (`go:embed`), así
que el despliegue final es **un único ejecutable** (o una única imagen
Docker) sin assets sueltos que gestionar.

## Requisitos

- Go 1.22+ (solo para desarrollo local; el build de Docker no requiere Go instalado)
- Un servidor Loki accesible, con Basic Auth y `X-Scope-OrgID` si aplica

## Configuración (12-Factor App)

Toda la configuración se lee de variables de entorno al arrancar. Si falta
alguna obligatoria, el servidor **no arranca** (fail fast) e imprime cuáles
faltan.

| Variable      | Obligatoria | Descripción                                              | Ejemplo                                      |
|---------------|:-----------:|-----------------------------------------------------------|-----------------------------------------------|
| `LOKI_URL`    | Sí          | URL base del servidor Loki                                 | `https://loki.monitoring.seidor-retail.com`  |
| `LOKI_USER`   | Sí          | Usuario para Basic Auth                                    | `admin`                                       |
| `LOKI_PASS`   | Sí          | Contraseña para Basic Auth                                 | `********`                                    |
| `LOKI_ORG_ID` | Sí          | Valor inyectado en la cabecera `X-Scope-OrgID`             | `Clarel-pro`                                  |
| `PORT`        | No          | Puerto HTTP del servidor. Por defecto `8080`                | `8080`                                        |

Copia `.env.example` a `.env` y rellena tus valores:

```bash
cp .env.example .env
```

## Arrancar en local (sin Docker)

```bash
export $(grep -v '^#' .env | xargs)   # o exporta las variables manualmente
go run ./cmd/server
```

La app queda disponible en `http://localhost:8080`.

Tests:

```bash
go test ./...
```

## Arrancar con Docker

### Opción 1: `docker compose`

```bash
cp .env.example .env   # y rellena tus valores
docker compose up --build
```

### Opción 2: `docker build` / `docker run`

```bash
docker build -t lokiviews:local .
docker run --rm -p 8080:8080 \
  -e LOKI_URL="https://loki.monitoring.seidor-retail.com" \
  -e LOKI_USER="admin" \
  -e LOKI_PASS="secret" \
  -e LOKI_ORG_ID="Clarel-pro" \
  lokiviews:local
```

## Uso de la interfaz

1. **Buscador**: añade uno o varios labels (`namespace`, `pod`,
   `service_name`, cualquier label que exponga tu Loki) con su operador
   (`=`, `!=`, `=~`, `!~`) y valor. Los campos ofrecen autocompletado
   consultando `/api/labels` y `/api/label-values`.
2. **Rango de tiempo**: chips rápidos (15m/1h/6h/24h/3d) o fechas
   personalizadas.
3. **Límite y orden**: selecciona cuántas líneas traer y si quieres las
   más recientes o las más antiguas primero.
4. **Visor de logs**: panel tipo terminal con cada línea coloreada según
   la severidad detectada (`ERROR`, `WARN`, `INFO`, `DEBUG`/`TRACE`).
   Usa los chips (`Solo Errores`, `Solo Warnings`…) o el campo de texto
   libre para filtrar sin volver a consultar Loki.
5. **Descarga**: el botón "Descargar .txt" genera un archivo de texto
   plano con las líneas actualmente visibles (respeta los filtros
   aplicados).

## API interna

| Endpoint                         | Método | Descripción                                              |
|-----------------------------------|:------:|-----------------------------------------------------------|
| `/api/health`                     | GET    | Liveness check                                             |
| `/api/labels`                     | GET    | Lista de label names conocidos por Loki                    |
| `/api/label-values?name=<label>`  | GET    | Valores conocidos para un label                            |
| `/api/query`                      | POST   | Consulta logs (ver payload abajo)                           |

Payload de `/api/query`:

```json
{
  "matchers": [
    { "key": "namespace", "value": "clarel-pro", "op": "=" },
    { "key": "pod", "value": "api-.*", "op": "=~" }
  ],
  "start": "2026-08-21T00:00:00Z",
  "end": "2026-08-21T10:00:00Z",
  "limit": 1000,
  "direction": "backward"
}
```

## Documentación relacionada

- [CHANGELOG.md](CHANGELOG.md) — histórico de versiones
- [TODO.md](TODO.md) — mejoras futuras e ideas pendientes
