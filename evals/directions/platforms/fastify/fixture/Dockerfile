FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY bin ./bin
RUN mkdir -p /data && chown -R node:node /app /data
USER node
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
