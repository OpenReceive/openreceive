FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build && chown -R node:node /app
USER node
ENV PORT=3000
EXPOSE 3000
CMD ["node", "dist/main.js"]
