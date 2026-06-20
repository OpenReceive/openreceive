# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages ./packages
COPY examples/hello-fruit ./examples/hello-fruit

RUN npm ci
RUN npm run build -w @openreceive/example-nextjs-fullstack

WORKDIR /app/examples/hello-fruit/server/nextjs-fullstack
ENV NODE_ENV=production
ENV OPENRECEIVE_DEMO_MODE=test_nwc
ENV PORT=3002
EXPOSE 3002

CMD ["npm", "start"]
