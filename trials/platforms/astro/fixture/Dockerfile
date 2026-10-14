FROM node:22-bookworm-slim
WORKDIR /app
RUN chown node:node /app
USER node
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci
COPY --chown=node:node . .
RUN npm run build
ENV HOST=0.0.0.0 PORT=3000
EXPOSE 3000
CMD ["node", "./dist/server/entry.mjs"]
