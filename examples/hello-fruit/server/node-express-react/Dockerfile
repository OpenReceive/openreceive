# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages ./packages
COPY examples/hello-fruit ./examples/hello-fruit

RUN npm ci
RUN npm run build -w @openreceive/example-node-express-react

WORKDIR /app/examples/hello-fruit/server/node-express-react
ENV OPENRECEIVE_DEMO_MODE=test_nwc
ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]
