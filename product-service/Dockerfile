FROM golang:1.22-alpine AS build
# several proxies = the build survives a flaky network
ENV GOPROXY=https://proxy.golang.org|https://goproxy.io|direct
WORKDIR /src
COPY go.mod main.go ./
RUN go mod tidy && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/product .

FROM alpine:3.20
RUN adduser -D -u 10001 app
COPY --from=build /out/product /product
USER 10001
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD wget -qO- http://127.0.0.1:8080/health >/dev/null || exit 1
CMD ["/product"]
