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
| `LOKI_ORG_ID` | No          | Valor por defecto para precargar el campo "Org ID" de la UI | `Clarel-pro`                                  |
| `PORT`        | No          | Puerto HTTP del servidor. Por defecto `8080`                | `8080`                                        |

**`X-Scope-OrgID` se indica desde la propia interfaz web**, no al arrancar
el servidor: el panel de búsqueda tiene un campo "Org ID" que se envía con
cada consulta (`/api/query`, `/api/labels`, `/api/label-values`). Esto
permite consultar distintos tenants de Loki desde la misma instancia de la
app sin reiniciarla. `LOKI_ORG_ID` es opcional y solo sirve para
precargar ese campo con un valor por defecto al abrir la app
(`GET /api/config`); si no se define, el campo empieza vacío.

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

1. **Org ID**: indica el `X-Scope-OrgID` del tenant de Loki que quieres
   consultar (ej. `Clarel-pro`). Se envía con cada petición; si
   `LOKI_ORG_ID` está definido en el servidor, este campo se precarga con
   ese valor, pero siempre es editable.
2. **Buscador**: añade uno o varios labels (`namespace`, `pod`,
   `service_name`, cualquier label que exponga tu Loki) con su operador
   (`=`, `!=`, `=~`, `!~`) y valor. Los campos ofrecen autocompletado
   consultando `/api/labels` y `/api/label-values` (usando el Org ID
   actual), y las sugerencias están **contextualizadas** de dos formas,
   igual que hace el Explore de Grafana:
   - Por otros labels ya rellenados: en cuanto pones `namespace="monitoring"`,
     el resto de campos solo sugieren labels/valores que realmente
     coexisten con ese selector — no toda la lista del tenant (por
     ejemplo, `pod` no te ofrecerá pods de otro namespace como `logging`).
   - Por el rango de tiempo seleccionado: si un pod murió a las 17:00 y
     buscas a partir de las 18:00, ese pod no aparece en las sugerencias
     (no tiene logs en esa ventana), aunque sí aparecería si el rango
     incluye un momento anterior a su muerte.
3. **Rango de tiempo**: chips rápidos (15m/1h/6h/24h/3d) o fechas
   personalizadas.
4. **Límite y orden**: selecciona cuántas líneas traer y si quieres las
   más recientes o las más antiguas primero.
5. **Visor de logs**: panel tipo terminal con cada línea coloreada según
   la severidad detectada (`ERROR`, `WARN`, `INFO`, `DEBUG`/`TRACE`).
   Usa los chips (`Solo Errores`, `Solo Warnings`…) o el campo de texto
   libre para filtrar sin volver a consultar Loki.
6. **Descarga**: el botón "Descargar .txt" genera un archivo de texto
   plano con las líneas actualmente visibles (respeta los filtros
   aplicados).

## API interna

| Endpoint                          | Método | Descripción                                                |
|------------------------------------|:------:|-------------------------------------------------------------|
| `/api/health`                      | GET    | Liveness check                                               |
| `/api/config`                      | GET    | Config no sensible expuesta al frontend (`defaultOrgId`)      |
| `/api/labels?orgId=<org>&query=<selector>`   | GET | Label names conocidos por Loki para ese tenant, opcionalmente acotados a un selector LogQL |
| `/api/label-values?name=<label>&orgId=<org>&query=<selector>` | GET | Valores conocidos para un label, opcionalmente acotados a un selector LogQL |
| `/api/query`                       | POST   | Consulta logs (ver payload abajo)                             |

Payload de `/api/query`:

```json
{
  "orgId": "Clarel-pro",
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

Si `orgId` se omite o va vacío, el backend usa `LOKI_ORG_ID` (si está
definido) como fallback; si tampoco existe, no se envía cabecera
`X-Scope-OrgID`.

## Documentación relacionada

- [CHANGELOG.md](CHANGELOG.md) — histórico de versiones
- [TODO.md](TODO.md) — mejoras futuras e ideas pendientes
