FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN mkdir -p /data && npm run build && chown -R node:node /app /data
USER node
ENV PORT=3000
EXPOSE 3000
CMD ["npm", "start"]
