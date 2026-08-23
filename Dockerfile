# --- build stage ---
FROM golang:1.22-alpine AS build

WORKDIR /src

COPY go.mod ./
RUN go mod download 2>/dev/null || true

COPY . .

RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/lokiviews ./cmd/server

# --- runtime stage ---
FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=build /out/lokiviews /lokiviews

EXPOSE 8080
USER nonroot:nonroot

# Exec form (no shell involved) so this works on a distroless image that
# has no curl/wget: the binary checks its own /api/health over loopback.
# See runHealthcheck() in cmd/server/main.go.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["/lokiviews", "-healthcheck"]

ENTRYPOINT ["/lokiviews"]
