FROM node:24-alpine
RUN apk add --no-cache openssl
WORKDIR /app
COPY interceptor.mjs sni.mjs entrypoint.sh ./
ENTRYPOINT ["sh", "/app/entrypoint.sh"]
