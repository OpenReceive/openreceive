FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json .npmrc ./
COPY package-lock.json* ./
# npm install, not npm ci: on Bolt the agent adds a package to package.json
# and Bolt installs it. A lockfile the agent could not refresh must not fail
# the rebuild.
RUN npm install --no-audit --no-fund
COPY . .
# Bolt keeps the project's Supabase URL and anon key in .env, and builds the
# site with it. The repository tracks no .env file, so the shop starts from
# .env.example; an .env already there wins.
RUN cp -n .env.example .env && npm run build
USER node
EXPOSE 3000
CMD ["node", "infra/web/serve.mjs"]
