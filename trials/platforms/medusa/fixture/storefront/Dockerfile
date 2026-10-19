FROM node:22-bookworm-slim
RUN mkdir /storefront && chown node:node /storefront
USER node
WORKDIR /storefront
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci
COPY --chown=node:node . .
# Next.js builds NEXT_PUBLIC_ variables into the pages.
ARG NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_DEFAULT_REGION=us
ENV NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY=$NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY \
    NEXT_PUBLIC_DEFAULT_REGION=$NEXT_PUBLIC_DEFAULT_REGION \
    NEXT_TELEMETRY_DISABLED=1
EXPOSE 8000
# The starter's build reads the store's products and collections from the
# Medusa server, so it builds once the server is up.
CMD ["sh", "-c", "npm run build && exec npm start"]
