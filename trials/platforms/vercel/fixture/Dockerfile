FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# The tables are created at start, once the database is up; on Vercel the
# build script creates them.
RUN npx next build && chown -R node:node /app
USER node
ENV PORT=3000
EXPOSE 3000
CMD ["sh", "-c", "node scripts/migrate.mjs && npm start"]
