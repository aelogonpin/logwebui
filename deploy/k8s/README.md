# Manifiestos de ejemplo para Kubernetes

Plantillas mínimas, pensadas como punto de partida — ajusta réplicas,
recursos, ingress, etc. a tu propio cluster.

```bash
# 1. Secret con la configuración real (no se commitea)
cp secret.example.yaml secret.yaml
# edita secret.yaml con tus valores reales de LOKI_URL/LOKI_USER/LOKI_PASS
# (y, si usas autodescubrimiento de tenants, MIMIR_URL/MIMIR_USER/MIMIR_PASS/MIMIR_ORG_ID)

kubectl apply -f secret.yaml -n <namespace>
kubectl apply -f deployment.yaml -n <namespace>
kubectl apply -f service.yaml -n <namespace>
```

Notas:

- `deployment.yaml` referencia `ghcr.io/aelogonpin/logwebui:latest` — en
  un despliegue real, fija una versión concreta (`:v1.2.3`) en vez de
  `latest`. Las imágenes se publican ahí automáticamente al taggear un
  release (ver `.github/workflows/release.yml`).
- `readOnlyRootFilesystem: true` está activado; la exportación de ciclo
  de vida completo escribe un fichero temporal (`os.CreateTemp`), por eso
  hay un `emptyDir` montado en `/tmp` — no lo quites si mantienes el
  filesystem de solo lectura.
- No se incluye Ingress ni TLS: depende demasiado de cada cluster
  (nginx-ingress, cert-manager, un `Gateway` de Gateway API...) como para
  dar un ejemplo único que sirva de verdad. El `Service` es `ClusterIP`;
  expón lo que necesites por encima según tu propia configuración.
- Sin `HorizontalPodAutoscaler`: la app es prácticamente stateless salvo
  por el archivo temporal de la exportación de ciclo de vida (efímero,
  vive en el `emptyDir` de cada pod), así que escalar horizontalmente es
  seguro si lo necesitas — simplemente no se ha incluido un ejemplo aquí.
