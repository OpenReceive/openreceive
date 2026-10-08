FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
RUN chown -R node:node /app
USER node
ENV PORT=5000
EXPOSE 5000
CMD ["npm", "start"]
