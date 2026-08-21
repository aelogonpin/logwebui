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

ENTRYPOINT ["/lokiviews"]
