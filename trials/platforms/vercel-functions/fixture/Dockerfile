# Vercel's Node runtime for this project is Node 24.
FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN chown -R node:node /app
USER node
ENV PORT=3000
EXPOSE 3000
# Every Vercel deploy runs "build" (here: the tables) before it serves; this
# runs it once the database is up, then serves the site as Vercel would.
CMD ["sh", "-c", "npm run build && npm run dev"]
