#!/usr/bin/env bash
# Build images inside Minikube and deploy everything (Linux / macOS / Git Bash).
set -euo pipefail
cd "$(dirname "$0")/.."
minikube status >/dev/null 2>&1 || minikube start --driver=docker --cpus=2 --memory=4096
eval "$(minikube -p minikube docker-env)"
for s in user-service product-service order-service gateway frontend; do
  echo ">> building shop/$s:2.0"; docker build -t "shop/$s:2.0" "./$s"
done
kubectl apply -f k8s/00-config.yaml
kubectl apply -f k8s/10-data.yaml
kubectl -n shop rollout status statefulset/postgres --timeout=240s
kubectl -n shop rollout status statefulset/mongo --timeout=240s
kubectl -n shop rollout status deployment/redis --timeout=120s
kubectl apply -f k8s/20-services.yaml
kubectl apply -f k8s/30-edge.yaml
for d in user-service product-service order-service gateway frontend; do
  kubectl -n shop rollout status "deployment/$d" --timeout=240s
done
kubectl -n shop get pods
echo; echo "Done. Run: kubectl -n shop port-forward svc/frontend 8080:80  ->  http://localhost:8080"
