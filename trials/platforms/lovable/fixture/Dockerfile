FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
# npm install, not npm ci: on Lovable the agent adds a package to package.json
# and Lovable installs it. A lockfile the agent could not refresh must not
# fail the rebuild.
RUN npm install --no-audit --no-fund
COPY . .
RUN chown -R node:node /app
USER node
EXPOSE 3000
CMD ["npm", "run", "dev"]
