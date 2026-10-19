FROM node:22-bookworm-slim
RUN mkdir /app && chown node:node /app
USER node
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci
COPY --chown=node:node . .
EXPOSE 9000
CMD ["sh", "start.sh"]
