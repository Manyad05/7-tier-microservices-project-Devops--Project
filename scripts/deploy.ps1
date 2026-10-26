# Build images inside Minikube and deploy everything (Windows PowerShell).
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

minikube status *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host "Starting Minikube..." -ForegroundColor Cyan
  minikube start --driver=docker --cpus=2 --memory=4096
  if ($LASTEXITCODE -ne 0) { throw "minikube start failed" }
}

# build images with Minikube's Docker daemon
& minikube -p minikube docker-env --shell powershell | Invoke-Expression
foreach ($s in 'user-service','product-service','order-service','gateway','frontend') {
  Write-Host "Building shop/${s}:2.0 ..." -ForegroundColor Cyan
  docker build -t "shop/${s}:2.0" "./$s"
  if ($LASTEXITCODE -ne 0) { throw "docker build failed for $s" }
}

kubectl apply -f k8s/00-config.yaml
kubectl apply -f k8s/10-data.yaml
kubectl -n shop rollout status statefulset/postgres --timeout=240s
kubectl -n shop rollout status statefulset/mongo --timeout=240s
kubectl -n shop rollout status deployment/redis --timeout=120s
kubectl apply -f k8s/20-services.yaml
kubectl apply -f k8s/30-edge.yaml
foreach ($d in 'user-service','product-service','order-service','gateway','frontend') {
  kubectl -n shop rollout status "deployment/$d" --timeout=240s
}
kubectl -n shop get pods
Write-Host "`nDone. Open the app with:" -ForegroundColor Green
Write-Host "  kubectl -n shop port-forward svc/frontend 8080:80"
Write-Host "then browse to http://localhost:8080  (demo admin: admin@shop.local / Admin@123)"
