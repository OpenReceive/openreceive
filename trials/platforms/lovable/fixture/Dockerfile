FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .
RUN chown -R node:node /app
USER node
EXPOSE 3000
CMD ["npm", "run", "dev"]
