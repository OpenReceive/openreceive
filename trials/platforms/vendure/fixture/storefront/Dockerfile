# Vendure's Next.js starter. Its pages read the Vendure server while they
# build, so the build runs when the container starts, once the server is up.
# Node 24's npm 11 reads the starter's lock file and .npmrc as it expects.
FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
EXPOSE 3000
CMD ["sh", "-c", "npm run build && npx next start --port 3000"]
