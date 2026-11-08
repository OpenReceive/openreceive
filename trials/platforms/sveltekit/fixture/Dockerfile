FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .
# The shop's public address, built in as SvelteKit's paths.origin.
ARG ORIGIN
RUN npm run build && chown -R node:node /app
USER node
ENV HOST=0.0.0.0 PORT=3000
EXPOSE 3000
CMD ["node", "build"]
